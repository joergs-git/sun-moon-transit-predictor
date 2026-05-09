#!/usr/bin/env bash
# Install / update the Sun-Moon Transit Predictor on a Raspberry Pi 5
# (Raspberry Pi OS, ARM64). Idempotent: safe to re-run.
#
#   bash scripts/install-pi5.sh
#
# What it does:
#   1. Ensures Node.js >= 22 (installed from NodeSource if missing).
#   2. Runs `npm install --omit=dev` in the repo.
#   3. Prompts for observer location and Pushover credentials, writes
#      config/observer.json + config/service.json (existing files are kept
#      unless --overwrite is passed).
#   4. Installs / updates the systemd unit `stp.service`, enables and starts it.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_FILE="/etc/systemd/system/stp.service"
TARGET_USER="${SUDO_USER:-$USER}"
OVERWRITE_CONFIG=0

for arg in "$@"; do
  case "$arg" in
    --overwrite) OVERWRITE_CONFIG=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n[stp-install] %s\n' "$*"; }
sudo_run() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

log "Repo directory: $REPO_DIR"
log "Target user:    $TARGET_USER"

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
# 3. Configuration
# ---------------------------------------------------------------------------
mkdir -p "$REPO_DIR/data"

prompt() {
  local label="$1" default="$2" var
  read -rp "$label [$default]: " var || true
  echo "${var:-$default}"
}

OBSERVER_FILE="$REPO_DIR/config/observer.json"
SERVICE_FILE_LOCAL="$REPO_DIR/config/service.json"

if [ ! -f "$OBSERVER_FILE" ] || [ "$OVERWRITE_CONFIG" -eq 1 ]; then
  log "Configuring observer (config/observer.json) ..."
  OBS_NAME=$(prompt "Observer name" "Rheine")
  OBS_LAT=$(prompt  "Latitude °N"   "52.2833")
  OBS_LON=$(prompt  "Longitude °E"  "7.4406")
  OBS_ELEV=$(prompt "Elevation m MSL" "50")
  cat > "$OBSERVER_FILE" <<EOF
{
  "name": "$OBS_NAME",
  "latitudeDeg": $OBS_LAT,
  "longitudeDeg": $OBS_LON,
  "elevationM": $OBS_ELEV,
  "temperatureC": 10.0,
  "pressureMbar": 1010.0
}
EOF
else
  log "Keeping existing $OBSERVER_FILE (re-run with --overwrite to replace)."
fi

if [ ! -f "$SERVICE_FILE_LOCAL" ] || [ "$OVERWRITE_CONFIG" -eq 1 ]; then
  log "Configuring service (config/service.json) ..."
  ADSB_URL=$(prompt   "dump1090 aircraft.json URL" "http://localhost:8080/data/aircraft.json")
  PORT=$(prompt       "Web UI port"                "8081")
  PUB_URL=$(prompt    "Public URL for Pushover links (blank for none)" "")
  PUSH_TOKEN=$(prompt "Pushover application token (blank to disable)" "")
  PUSH_USER=$(prompt  "Pushover user/group key   (blank to disable)" "")
  if [ -n "$PUSH_TOKEN" ] && [ -n "$PUSH_USER" ]; then PUSH_ENABLED=true; else PUSH_ENABLED=false; fi

  cat > "$SERVICE_FILE_LOCAL" <<EOF
{
  "adsb":     { "url": "$ADSB_URL", "pollIntervalMs": 2000 },
  "tracker":  { "horizonS": 60, "stepS": 1, "thresholdDeg": 0.3, "bodies": ["Sun", "Moon"] },
  "pushover": { "token": "$PUSH_TOKEN", "user": "$PUSH_USER", "device": "", "enabled": $PUSH_ENABLED },
  "server":   { "port": $PORT, "host": "0.0.0.0", "publicUrl": "$PUB_URL" },
  "store":    { "path": "$REPO_DIR/data/history.db" },
  "routes":   { "enabled": true, "ttlMs": 3600000, "negativeTtlMs": 300000 }
}
EOF
else
  log "Keeping existing $SERVICE_FILE_LOCAL (re-run with --overwrite to replace)."
fi

# ---------------------------------------------------------------------------
# 4. systemd unit
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

log "Service status:"
systemctl --no-pager --lines=5 status stp.service || true

PI_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT_NOW="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$SERVICE_FILE_LOCAL" | head -n1 | grep -oE '[0-9]+$')"
echo
log "Done."
log "Web UI: http://${PI_IP:-localhost}:${PORT_NOW:-8081}/"
log "Logs:   journalctl -u stp.service -f"
