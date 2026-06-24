#!/usr/bin/env bash
# WiFi failover for off-road use (v0.51.0). Keeps the box reachable with zero
# terminal config:
#   - On boot, give NetworkManager a grace period to autoconnect a saved home
#     WiFi.
#   - If the WiFi radio has no active CLIENT connection, bring up the pre-created
#     access-point profile ($AP) so the web UI is reachable from a phone/iPad.
#   - While hosting the AP, periodically drop it briefly to probe for a known
#     network (so driving back into home-WiFi range auto-rejoins) and re-raise
#     the AP if none appears.
#
# Single radio = either client OR AP at a time, which is exactly the failover
# model. Runs as root from stp-wifi-failover.service.
set -uo pipefail

AP="${1:-sunmoontransits}"
GRACE="${STP_WIFI_GRACE_S:-45}"     # boot grace for NM autoconnect
POLL="${STP_WIFI_POLL_S:-10}"       # offline re-check cadence
RECHECK="${STP_WIFI_RECHECK_S:-180}" # how often to probe for a known net while hosting AP

iface() { nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}'; }
IFACE="$(iface)"; IFACE="${IFACE:-wlan0}"

# Active connection name on the WiFi device ('' when offline).
active_conn() {
  nmcli -t -f GENERAL.CONNECTION device show "$IFACE" 2>/dev/null \
    | cut -d: -f2- | sed 's/^--$//'
}

ap_up()   { echo "[stp-wifi-failover] activating AP '$AP'"; nmcli connection up "$AP" >/dev/null 2>&1 \
              || echo "[stp-wifi-failover] AP up failed — is the '$AP' profile installed?"; }
ap_down() { nmcli connection down "$AP" >/dev/null 2>&1 || true; }

echo "[stp-wifi-failover] iface=$IFACE ap='$AP' — ${GRACE}s boot grace"
sleep "$GRACE"

while true; do
  ACTIVE="$(active_conn)"
  if [ -z "$ACTIVE" ]; then
    # Offline → host the AP.
    ap_up
    sleep "$POLL"
  elif [ "$ACTIVE" = "$AP" ]; then
    # Hosting the AP. After RECHECK, drop it briefly and let NM try to autoconnect
    # a known network; if none comes up, raise the AP again.
    sleep "$RECHECK"
    echo "[stp-wifi-failover] probing for a known network…"
    ap_down
    nmcli device wifi rescan >/dev/null 2>&1 || true
    sleep 25
    PROBE="$(active_conn)"
    if [ -z "$PROBE" ] || [ "$PROBE" = "$AP" ]; then
      ap_up
    else
      echo "[stp-wifi-failover] joined '$PROBE' — AP stays down"
    fi
  else
    # Connected to a real network — nothing to do.
    sleep "$POLL"
  fi
done
