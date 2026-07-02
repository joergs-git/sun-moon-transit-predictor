#!/usr/bin/env bash
# WiFi failover for off-road use (v0.52.0). Keeps the box reachable with zero
# terminal config:
#   - On boot, give NetworkManager a grace period to autoconnect a saved home
#     WiFi.
#   - If the WiFi radio has no active CLIENT connection, bring up the pre-created
#     access-point profile ($AP) so the web UI is reachable from a phone/iPad.
#   - While hosting the AP, periodically drop it briefly to probe for a known
#     network (so driving back into home-WiFi range auto-rejoins) and re-raise
#     the AP if none appears.
#   - If a wired Ethernet link is up (the box is already reachable over the
#     cable), never host the AP — and tear it down if it was up (v0.52.0). Set
#     STP_WIFI_IGNORE_ETH=1 to restore the old WiFi-only behaviour.
#
# Single radio = either client OR AP at a time, which is exactly the failover
# model. Runs as root from stp-wifi-failover.service.
set -uo pipefail

AP="${1:-sunmoontransits}"
GRACE="${STP_WIFI_GRACE_S:-45}"     # boot grace for NM autoconnect
POLL="${STP_WIFI_POLL_S:-10}"       # offline re-check cadence
RECHECK="${STP_WIFI_RECHECK_S:-180}" # how often to probe for a known net while hosting AP
IGNORE_ETH="${STP_WIFI_IGNORE_ETH:-0}" # 1 = ignore Ethernet, host AP on WiFi loss anyway

iface() { nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}'; }
IFACE="$(iface)"; IFACE="${IFACE:-wlan0}"

# Is a wired Ethernet link up with an active NM connection? When the box is
# reachable over the cable there is no point hosting the WiFi AP. NM reports
# STATE 'connected' only once the device has carrier + an IP, so this is a
# reliable "reachable over eth" signal. Honoured unless STP_WIFI_IGNORE_ETH=1.
eth_online() {
  [ "$IGNORE_ETH" = "1" ] && return 1
  nmcli -t -f DEVICE,TYPE,STATE device 2>/dev/null \
    | awk -F: '$2=="ethernet" && $3=="connected"{found=1} END{exit !found}'
}

# Active connection name on the WiFi device ('' when offline).
active_conn() {
  nmcli -t -f GENERAL.CONNECTION device show "$IFACE" 2>/dev/null \
    | cut -d: -f2- | sed 's/^--$//'
}

ap_up()   { echo "[stp-wifi-failover] activating AP '$AP'"; nmcli connection up "$AP" >/dev/null 2>&1 \
              || echo "[stp-wifi-failover] AP up failed — is the '$AP' profile installed?"; }
ap_down() { nmcli connection down "$AP" >/dev/null 2>&1 || true; }

echo "[stp-wifi-failover] iface=$IFACE ap='$AP' eth-aware=$([ "$IGNORE_ETH" = 1 ] && echo no || echo yes) — ${GRACE}s boot grace"
sleep "$GRACE"

while true; do
  if eth_online; then
    # Reachable over the cable — never host the WiFi AP. Drop it if it was up
    # (e.g. Ethernet was just plugged in while hosting), then just poll.
    [ "$(active_conn)" = "$AP" ] && ap_down
    sleep "$POLL"
    continue
  fi
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
