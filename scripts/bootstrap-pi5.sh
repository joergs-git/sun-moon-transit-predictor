#!/usr/bin/env bash
# Bare-image bootstrap for a fresh Raspberry Pi OS Lite (64-bit).
#
# Solves the chicken-and-egg the normal install has: you need git + the repo
# before scripts/install-pi5.sh can run. This installs the apt prerequisites,
# clones (or updates) the repo, then chains straight into install-pi5.sh,
# forwarding every argument and STP_* env var.
#
# One-liner on a blank Pi (review the script first — piping to a shell runs
# remote code as you):
#
#   curl -fsSL https://raw.githubusercontent.com/joergs-git/sun-moon-transit-predictor/main/scripts/bootstrap-pi5.sh | bash
#
# Zero-touch (flags + env pass through to install-pi5.sh):
#
#   curl -fsSL .../bootstrap-pi5.sh | STP_LAT=52.28 STP_LON=7.44 STP_ELEV=50 \
#     bash -s -- --non-interactive
#
# Already have the repo? Just run scripts/install-pi5.sh directly — this
# script is only needed to get there from a clean OS image.
#
# What it does NOT do: install/configure dump1090-fa + the RTL-SDR. That is
# hardware-specific (SDR drivers, antenna, the FlightAware apt repo) and is
# the ADS-B *data source* this tool consumes — see the note printed at the
# end and the README. Pass --with-dump1090 for a best-effort apt attempt.

set -euo pipefail

REPO_URL="${STP_REPO_URL:-https://github.com/joergs-git/sun-moon-transit-predictor.git}"
INSTALL_DIR="${STP_INSTALL_DIR:-$HOME/sun-moon-transit-predictor}"
WITH_DUMP1090=0

PASS_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --with-dump1090) WITH_DUMP1090=1 ;;
    *) PASS_ARGS+=("$arg") ;;
  esac
done

log() { printf '\n[stp-bootstrap] %s\n' "$*"; }
sudo_run() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

log "Repo URL:     $REPO_URL"
log "Install dir:  $INSTALL_DIR"

# ---------------------------------------------------------------------------
# 1. apt prerequisites: git + curl + ca-certificates (NodeSource needs curl;
#    install-pi5.sh installs Node itself).
# ---------------------------------------------------------------------------
log "Installing apt prerequisites (git, curl, ca-certificates) ..."
sudo_run apt-get update
sudo_run apt-get install -y git curl ca-certificates

# ---------------------------------------------------------------------------
# 2. Optional dump1090-fa (AirNav FlightStick / any RTL-SDR). Same reliable
#    path as the README "ADS-B receiver setup": FlightAware apt repo +
#    dump1090-fa + DVB-T blacklist. Antenna/sky view stay the user's job.
#    A reboot is recommended afterwards (the blacklist needs it) but is NOT
#    forced here so the app install can continue in the same run.
# ---------------------------------------------------------------------------
if [ "$WITH_DUMP1090" -eq 1 ]; then
  log "Installing dump1090-fa via the FlightAware apt repository ..."
  if curl -fsSL https://www.flightaware.com/adsb/piaware/files/packages/pool/piaware/f/flightaware-apt-repository/flightaware-apt-repository_1.3_all.deb -o /tmp/fa-repo.deb; then
    sudo_run dpkg -i /tmp/fa-repo.deb || true
    sudo_run apt-get update || true
    if sudo_run apt-get install -y dump1090-fa; then
      echo 'blacklist dvb_usb_rtl28xxu' | sudo_run tee /etc/modprobe.d/blacklist-rtl.conf >/dev/null
      sudo_run modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true
      log "dump1090-fa installed. REBOOT recommended so the DVB-T blacklist"
      log "takes effect; verify with: curl -s localhost:8080/data/aircraft.json"
    else
      log "dump1090-fa install failed — set it up manually (see README §ADS-B receiver setup)."
    fi
    rm -f /tmp/fa-repo.deb
  else
    log "Could not fetch the FlightAware repo package — install dump1090-fa manually."
  fi
fi

# ---------------------------------------------------------------------------
# 3. Clone (or fast-forward) the repo.
# ---------------------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Repo already present — git pull --ff-only ..."
  git -C "$INSTALL_DIR" pull --ff-only || \
    log "git pull failed (local changes?) — continuing with the existing checkout."
else
  log "Cloning into $INSTALL_DIR ..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ---------------------------------------------------------------------------
# 4. Hand off to the real installer (forward all non-bootstrap args + env).
# ---------------------------------------------------------------------------
log "Handing off to scripts/install-pi5.sh ${PASS_ARGS[*]:-(no args)} ..."
cd "$INSTALL_DIR"
# Expand to nothing (not an empty string arg) when no flags were passed —
# install-pi5.sh rejects unknown/empty args.
exec bash scripts/install-pi5.sh ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
