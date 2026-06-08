#!/usr/bin/env bash
# Install / update the Sun-Moon Transit Predictor on a Raspberry Pi 5
# (Raspberry Pi OS, ARM64). Idempotent: safe to re-run.
#
#   bash scripts/install-pi5.sh
#   bash scripts/install-pi5.sh --overwrite       # re-prompt for everything
#   bash scripts/install-pi5.sh --non-interactive # zero prompts; reads env vars
#   bash scripts/install-pi5.sh --no-auto-update  # skip the nightly timer
#   bash scripts/install-pi5.sh --with-display     # also set up the e-paper panel
#
# Env vars honoured in --non-interactive mode (or as defaults otherwise):
#   STP_OBSERVER_NAME    e.g. "City"
#   STP_LAT              latitude  °N  e.g. "52.1"
#   STP_LON              longitude °E  e.g. "7.1"
#   STP_ELEV             observer elevation (m HAE), e.g. "50"
#   STP_GEOID_M          EGM2008 N at the site (m), e.g. "46"  (default 0)
#   STP_ADSB_URL         e.g. "http://localhost:8080/data/aircraft.json"
#   STP_PORT             web UI port, default 8081
#   STP_PUBLIC_URL       public URL for Pushover links, default ""
#   STP_PUSHOVER_TOKEN   Pushover application token (blank = disable)
#   STP_PUSHOVER_USER    Pushover user / group key  (blank = disable)
#   STP_WITH_DISPLAY     set to 1 to do the --with-display setup non-interactively
#
# What it does:
#   1. Ensures Node.js >= 22 (installed from NodeSource if missing).
#   2. Runs `npm install --omit=dev` in the repo.
#   3. Writes config/observer.json + config/service.json (existing files are
#      kept unless --overwrite is passed). Both files are gitignored.
#   4. Installs / updates the systemd unit `stp.service`, enables and starts it.
#   5. Unless --no-auto-update: installs `stp-update.timer` for nightly
#      `git pull && (npm install) && systemctl restart` and grants the user a
#      narrowly scoped sudoers rule so the timer can restart the service.
#   6. With --with-display (or STP_WITH_DISPLAY=1): enables SPI, installs the
#      Python e-paper libraries (Pillow + Waveshare driver + lgpio/gpiozero/
#      spidev), adds the user to the spi/gpio groups, and installs+enables the
#      `stp-display.service` unit. Skipped by default (optional hardware).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_FILE="/etc/systemd/system/stp.service"
UPDATE_SERVICE_FILE="/etc/systemd/system/stp-update.service"
UPDATE_TIMER_FILE="/etc/systemd/system/stp-update.timer"
UPDATE_PATH_FILE="/etc/systemd/system/stp-update.path"
TLE_SERVICE_FILE="/etc/systemd/system/stp-tle.service"
TLE_TIMER_FILE="/etc/systemd/system/stp-tle.timer"
DISPLAY_SERVICE_FILE="/etc/systemd/system/stp-display.service"
SUDOERS_FILE="/etc/sudoers.d/stp-update"
TARGET_USER="${SUDO_USER:-$USER}"

OVERWRITE_CONFIG=0
NONINTERACTIVE=0
ENABLE_AUTO_UPDATE=1
# Optional e-paper panel: off by default (minority hardware). Opt in with
# --with-display, or STP_WITH_DISPLAY=1 for non-interactive/bootstrap runs.
WITH_DISPLAY="${STP_WITH_DISPLAY:-0}"

for arg in "$@"; do
  case "$arg" in
    --overwrite)         OVERWRITE_CONFIG=1 ;;
    --non-interactive)   NONINTERACTIVE=1 ;;
    --no-auto-update)    ENABLE_AUTO_UPDATE=0 ;;
    --with-display)      WITH_DISPLAY=1 ;;
    -h|--help)           sed -n '2,36p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n[stp-install] %s\n' "$*"; }
sudo_run() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# Read a value, prefer env, then prompt (skipped in --non-interactive).
prompt() {
  local label="$1" default="$2" var
  if [ "$NONINTERACTIVE" -eq 1 ]; then
    echo "$default"
    return
  fi
  read -rp "$label [$default]: " var </dev/tty || true
  echo "${var:-$default}"
}

log "Repo directory: $REPO_DIR"
log "Target user:    $TARGET_USER"
log "Mode:           $( [ "$NONINTERACTIVE" -eq 1 ] && echo non-interactive || echo interactive )"
log "Auto-update:    $( [ "$ENABLE_AUTO_UPDATE" -eq 1 ] && echo enabled || echo disabled )"
log "E-paper panel:  $( [ "$WITH_DISPLAY" -eq 1 ] && echo "setup (--with-display)" || echo "skipped (use --with-display)" )"

# ---------------------------------------------------------------------------
# 1. Node.js >= 22
# ---------------------------------------------------------------------------
need_node_install=0
if ! command -v node >/dev/null 2>&1; then
  need_node_install=1
else
  major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if [ "${major:-0}" -lt 22 ]; then need_node_install=1; fi
fi

if [ "$need_node_install" -eq 1 ]; then
  log "Installing Node.js 22 from NodeSource (apt) ..."
  sudo_run apt-get update
  sudo_run apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo_run -E bash -
  sudo_run apt-get install -y nodejs
else
  log "Node.js $(node -v) already meets >= 22, skipping install."
fi

# ---------------------------------------------------------------------------
# 2. npm install --omit=dev
# ---------------------------------------------------------------------------
log "Installing production dependencies ..."
( cd "$REPO_DIR" && npm install --omit=dev )

# ---------------------------------------------------------------------------
# 3. Configuration  (gitignored — created here, never overwritten by `git pull`)
# ---------------------------------------------------------------------------
mkdir -p "$REPO_DIR/data"

OBSERVER_FILE="$REPO_DIR/config/observer.json"
SERVICE_FILE_LOCAL="$REPO_DIR/config/service.json"

if [ ! -f "$OBSERVER_FILE" ] || [ "$OVERWRITE_CONFIG" -eq 1 ]; then
  log "Writing observer config ($OBSERVER_FILE) ..."
  OBS_NAME=$(prompt   "Observer name"          "${STP_OBSERVER_NAME:-City}")
  OBS_LAT=$(prompt    "Latitude °N"            "${STP_LAT:-52.2}")
  OBS_LON=$(prompt    "Longitude °E"           "${STP_LON:-7.5}")
  OBS_ELEV=$(prompt   "Elevation m (≈MSL)"     "${STP_ELEV:-50}")
  OBS_GEOID=$(prompt  "EGM2008 N (m, 0 to skip)" "${STP_GEOID_M:-0}")
  cat > "$OBSERVER_FILE" <<EOF
{
  "name": "$OBS_NAME",
  "latitudeDeg": $OBS_LAT,
  "longitudeDeg": $OBS_LON,
  "elevationM": $OBS_ELEV,
  "geoidUndulationM": $OBS_GEOID
}
EOF
else
  log "Keeping existing $OBSERVER_FILE (re-run with --overwrite to replace)."
fi

if [ ! -f "$SERVICE_FILE_LOCAL" ] || [ "$OVERWRITE_CONFIG" -eq 1 ]; then
  log "Writing service config ($SERVICE_FILE_LOCAL) ..."
  ADSB_URL=$(prompt   "dump1090 aircraft.json URL" "${STP_ADSB_URL:-http://localhost:8080/data/aircraft.json}")
  PORT=$(prompt       "Web UI port"                "${STP_PORT:-8081}")
  PUB_URL=$(prompt    "Public URL for Pushover links (blank for none)" "${STP_PUBLIC_URL:-}")
  PUSH_TOKEN=$(prompt "Pushover application token (blank to disable)" "${STP_PUSHOVER_TOKEN:-}")
  PUSH_USER=$(prompt  "Pushover user/group key   (blank to disable)" "${STP_PUSHOVER_USER:-}")
  if [ -n "$PUSH_TOKEN" ] && [ -n "$PUSH_USER" ]; then PUSH_ENABLED=true; else PUSH_ENABLED=false; fi

  # Optional opensky airports list (comma-separated ICAOs); empty = disabled
  OPENSKY_AIRPORTS_RAW="${STP_OPENSKY_AIRPORTS:-}"
  if [ -n "$OPENSKY_AIRPORTS_RAW" ]; then
    OPENSKY_ENABLED=true
    OPENSKY_AIRPORTS_JSON=$(printf '%s' "$OPENSKY_AIRPORTS_RAW" | awk -F, '{
      printf "["; for (i=1;i<=NF;i++) { gsub(/^ +| +$/, "", $i); printf (i>1?", ":"") "\"" $i "\"" } printf "]"
    }')
  else
    OPENSKY_ENABLED=false
    OPENSKY_AIRPORTS_JSON='[]'
  fi

  cat > "$SERVICE_FILE_LOCAL" <<EOF
{
  "adsb":      { "url": "$ADSB_URL", "pollIntervalMs": 2000 },
  "tracker":   { "horizonS": 900, "stepS": 0.5, "thresholdDeg": 0.3, "looseThresholdDeg": 2.0, "bodies": ["Sun", "Moon"] },
  "pushover":  { "token": "$PUSH_TOKEN", "user": "$PUSH_USER", "device": "", "enabled": $PUSH_ENABLED, "minStage": "radio", "radioThresholdDeg": 1.0, "minElevationDeg": 30, "url": "" },
  "server":    { "port": $PORT, "host": "0.0.0.0", "publicUrl": "$PUB_URL" },
  "store":     { "path": "$REPO_DIR/data/history.db" },
  "routes":    { "enabled": true, "ttlMs": 3600000, "negativeTtlMs": 300000 },
  "sightings": { "enabled": true, "gapMs": 1800000, "flushMs": 300000 },
  "predictor": { "enabled": true, "daysBack": 14, "minRepeats": 2, "bucketMinutes": 60, "rebuildIntervalMs": 3600000, "lookAheadMs": 86400000 },
  "lifecycle": { "plannedWindowMs": 3600000, "imminentWindowMs": 30000, "staleGraceMs": 1800000, "maxEntries": 10, "coastMs": 25000 },
  "iss":       { "enabled": true, "tlePath": "$REPO_DIR/data/iss.tle", "horizonMs": 1209600000, "visibleHorizonMs": 2592000000, "notifyWithinMs": 259200000, "recomputeMs": 600000, "thresholdDeg": 0.3, "looseThresholdDeg": 1.0 },
  "airnav":    { "enabled": false, "token": "", "baseUrl": "https://api.airnavradar.com/v2", "ttlMs": 21600000, "liveTtlMs": 60000, "negativeTtlMs": 300000 },
  "update":    { "enabled": true, "triggerPath": "$REPO_DIR/data/update.request", "debounceMs": 30000 },
  "opensky":   { "enabled": $OPENSKY_ENABLED, "airports": $OPENSKY_AIRPORTS_JSON, "lookbackDays": 7 }
}
EOF
else
  log "Keeping existing $SERVICE_FILE_LOCAL (re-run with --overwrite to replace)."
fi

# ---------------------------------------------------------------------------
# 4. systemd unit for the service itself
# ---------------------------------------------------------------------------
log "Installing systemd unit at $SERVICE_FILE ..."
TMPUNIT="$(mktemp)"
sed -e "s|__USER__|$TARGET_USER|g" \
    -e "s|__INSTALL_DIR__|$REPO_DIR|g" \
    "$REPO_DIR/systemd/stp.service" > "$TMPUNIT"
sudo_run install -m 0644 "$TMPUNIT" "$SERVICE_FILE"
rm -f "$TMPUNIT"

sudo_run systemctl daemon-reload
sudo_run systemctl enable stp.service
sudo_run systemctl restart stp.service

# ---------------------------------------------------------------------------
# 5. Auto-update timer (default ON; opt out with --no-auto-update)
# ---------------------------------------------------------------------------
if [ "$ENABLE_AUTO_UPDATE" -eq 1 ]; then
  log "Installing nightly auto-update timer ..."

  TMP_UPDATE_SVC="$(mktemp)"
  sed -e "s|__USER__|$TARGET_USER|g" \
      -e "s|__INSTALL_DIR__|$REPO_DIR|g" \
      "$REPO_DIR/systemd/stp-update.service" > "$TMP_UPDATE_SVC"
  sudo_run install -m 0644 "$TMP_UPDATE_SVC"               "$UPDATE_SERVICE_FILE"
  sudo_run install -m 0644 "$REPO_DIR/systemd/stp-update.timer" "$UPDATE_TIMER_FILE"
  rm -f "$TMP_UPDATE_SVC"

  # Click-to-update: the .path unit watches the trigger file the web UI
  # drops (POST /api/update) and fires the same privileged updater the
  # timer uses. __INSTALL_DIR__ is substituted so the watched path is
  # absolute and matches the service's WorkingDirectory.
  TMP_UPDATE_PATH="$(mktemp)"
  sed -e "s|__USER__|$TARGET_USER|g" \
      -e "s|__INSTALL_DIR__|$REPO_DIR|g" \
      "$REPO_DIR/systemd/stp-update.path" > "$TMP_UPDATE_PATH"
  sudo_run install -m 0644 "$TMP_UPDATE_PATH" "$UPDATE_PATH_FILE"
  rm -f "$TMP_UPDATE_PATH"

  # Sudoers fragment: only allow the exact restart command, nothing else.
  TMP_SUDOERS="$(mktemp)"
  printf '%s ALL=(root) NOPASSWD: /bin/systemctl restart stp.service\n' "$TARGET_USER" > "$TMP_SUDOERS"
  sudo_run install -m 0440 -o root -g root "$TMP_SUDOERS" "$SUDOERS_FILE"
  rm -f "$TMP_SUDOERS"

  sudo_run systemctl daemon-reload
  sudo_run systemctl enable --now stp-update.timer
  sudo_run systemctl enable --now stp-update.path
  log "Auto-update timer enabled. Check schedule: systemctl list-timers | grep stp-update"
  log "Click-to-update watcher enabled (stp-update.path → stp-update.service)."
else
  log "Skipping auto-update timer (--no-auto-update). Existing timer (if any) is left untouched."
fi

# ---------------------------------------------------------------------------
# 5b. ISS TLE refresh (daily timer + one initial fetch). Independent of
#     --no-auto-update: the ISS feature is on by default and stays inactive
#     ("no ISS info") until data/iss.tle exists. The running service never
#     fetches; this timer is the only network touch for it.
# ---------------------------------------------------------------------------
log "Installing ISS TLE refresh timer ..."
TMP_TLE_SVC="$(mktemp)"
sed -e "s|__USER__|$TARGET_USER|g" \
    -e "s|__INSTALL_DIR__|$REPO_DIR|g" \
    "$REPO_DIR/systemd/stp-tle.service" > "$TMP_TLE_SVC"
sudo_run install -m 0644 "$TMP_TLE_SVC"                   "$TLE_SERVICE_FILE"
sudo_run install -m 0644 "$REPO_DIR/systemd/stp-tle.timer" "$TLE_TIMER_FILE"
rm -f "$TMP_TLE_SVC"
sudo_run systemctl daemon-reload
sudo_run systemctl enable --now stp-tle.timer

# One initial fetch so ISS info appears right after install. Best-effort —
# a box with no network at install time just waits for the daily timer.
if node "$REPO_DIR/scripts/refresh-tle.js" >/dev/null 2>&1; then
  log "Initial ISS TLE fetched → data/iss.tle (ISS info will appear shortly)."
else
  log "Initial ISS TLE fetch skipped/failed (offline?) — the daily timer will retry."
fi

# ---------------------------------------------------------------------------
# 5c. Optional e-paper display client (only with --with-display /
#     STP_WITH_DISPLAY=1). Enables SPI, installs the Python panel libraries,
#     grants the user spi/gpio access, and installs + enables the unit. The
#     panel itself stays OFF until you toggle it on in the web Settings panel
#     (display.enabled), so the service won't fail-loop on a box with no panel.
# ---------------------------------------------------------------------------
if [ "$WITH_DISPLAY" -eq 1 ]; then
  log "Setting up the e-paper display client (--with-display) ..."

  # Enable SPI (idempotent). nonint do_spi 0 = enable. Takes effect on reboot.
  if command -v raspi-config >/dev/null 2>&1; then
    sudo_run raspi-config nonint do_spi 0 || log "WARN: could not enable SPI via raspi-config — enable it manually."
  else
    log "WARN: raspi-config not found — enable SPI manually (Interface Options > SPI)."
  fi

  # Panel libraries. Prefer apt packages (no compiler needed, bookworm-clean)
  # for Pillow + the GPIO/SPI backends; pip only for the Waveshare driver,
  # which is not packaged. --break-system-packages is required on bookworm's
  # externally-managed Python; fall back without it on older pip.
  sudo_run apt-get update
  sudo_run apt-get install -y python3-pip python3-pil python3-spidev python3-lgpio python3-gpiozero \
    || log "WARN: some apt python packages were unavailable — pip will be tried next."
  if ! sudo_run pip3 install --break-system-packages waveshare-epd 2>/dev/null; then
    sudo_run pip3 install waveshare-epd \
      || log "WARN: 'waveshare-epd' pip install failed — vendor the driver per display/README.md."
  fi

  # Service user needs spi + gpio group membership to reach the panel. Takes
  # effect after the next login / reboot.
  sudo_run usermod -aG spi,gpio "$TARGET_USER" || log "WARN: could not add $TARGET_USER to spi/gpio groups."

  # Install + enable the unit (placeholders substituted like the other units).
  TMP_DISPLAY_SVC="$(mktemp)"
  sed -e "s|__USER__|$TARGET_USER|g" \
      -e "s|__INSTALL_DIR__|$REPO_DIR|g" \
      "$REPO_DIR/systemd/stp-display.service" > "$TMP_DISPLAY_SVC"
  sudo_run install -m 0644 "$TMP_DISPLAY_SVC" "$DISPLAY_SERVICE_FILE"
  rm -f "$TMP_DISPLAY_SVC"
  sudo_run systemctl daemon-reload
  sudo_run systemctl enable --now stp-display.service || true

  log "E-paper client installed. Reboot once so SPI + group membership take effect,"
  log "then enable the panel in the web UI: Settings > E-paper display > Enabled."
else
  log "Skipping e-paper display setup (pass --with-display to set it up)."
fi

# ---------------------------------------------------------------------------
# 6. Status summary
# ---------------------------------------------------------------------------
log "Service status:"
systemctl --no-pager --lines=5 status stp.service || true

PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT_NOW="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$SERVICE_FILE_LOCAL" | head -n1 | grep -oE '[0-9]+$')"
echo
log "Done."
log "Web UI:       http://${PI_IP:-localhost}:${PORT_NOW:-8081}/"
log "Logs:         journalctl -u stp.service -f"
if [ "$ENABLE_AUTO_UPDATE" -eq 1 ]; then
  log "Update logs:  journalctl -u stp-update.service -f"
  log "Test update:  sudo systemctl start stp-update.service"
fi
if [ "$WITH_DISPLAY" -eq 1 ]; then
  log "Display logs: journalctl -u stp-display.service -f"
  log "Display:      enable it in the web UI (Settings > E-paper display); reboot once for SPI."
fi
