#!/usr/bin/env bash
# Apply a web-requested WiFi join (v0.51.0). Reads the trigger JSON { ssid, psk }
# that POST /api/wifi/connect dropped, joins the network with nmcli (which saves
# an autoconnect profile, so it is "known" on the next boot), then deletes the
# trigger so the stp-wifi.path unit does not re-fire. Runs as root from
# stp-wifi.service — the single privileged step in the onboarding path.
#
# NOTE: the PSK is passed to nmcli on the command line, so it is briefly visible
# in `ps` to a local user. On a single-user field Pi this is acceptable; harden
# later with a temp keyfile profile if the device is ever multi-user.
set -uo pipefail

REQ="${1:-}"
if [ -z "$REQ" ] || [ ! -f "$REQ" ]; then
  echo "[stp-wifi] no request file ($REQ) — nothing to do"
  exit 0
fi

# Parse without a jq dependency — python3 is always on the Pi OS image.
SSID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("ssid",""))' "$REQ" 2>/dev/null || true)"
PSK="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("psk",""))' "$REQ" 2>/dev/null || true)"

# Delete the trigger FIRST so a failed join can never wedge the .path unit in a
# re-fire loop.
rm -f "$REQ"

if [ -z "$SSID" ]; then
  echo "[stp-wifi] empty ssid — ignoring request"
  exit 0
fi

echo "[stp-wifi] joining \"$SSID\"…"
if [ -n "$PSK" ]; then
  nmcli --wait 25 device wifi connect "$SSID" password "$PSK"
else
  nmcli --wait 25 device wifi connect "$SSID"
fi
rc=$?
echo "[stp-wifi] join attempt for \"$SSID\" finished (rc=$rc)"
exit 0
