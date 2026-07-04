# WiFi management, offline UTC time & lockout prevention

Branch: `claude/pi-wifi-offline-time-3l1xtc`
Planned: 2026-07-04. Status: **PLAN — key decisions locked; ready to build.**

## Decisions locked with user (2026-07-04)
- **b1** → **Banner**: don't lock the UI. Show a persistent red "clock unverified"
  banner + the entry modal; the rest of the UI stays usable.
- **c1** → **Setting**: the boot AP window is a normal, Settings-editable option
  (`wifi.bootLocalWindowS`, default 90 s; `0` = off).
- **c3** → **No**: no USB second-radio / permanent-AP hardware note.
- **d** (new) → diagnose + fix the intermittent "SERVER OFFLINE" flash on the
  e-paper (see section d below).

## User ask (verbatim)

> a. Hinzufügen von weiteren WIFI Verbindungen (zb Gäste Wifi an anderen
> Standorten) für den PI via Browsersettings in den Einstellungen der UI
> Oberfläche. Aber auch das Entfernen von falschen wifis zb wegen falschem
> Kennwort oder ungewünschtem Connect.
>
> b. Dort gehört auch die Möglichkeit hinein, falls man tatsächlich offline
> ist, dass Datum Uhrzeit UTC via Browser eingestellt werden können. und
> insbesondere MUSS d.h. wenn ein NTP Server nicht erreichbar ist muss zwingend
> im UI eine Abfrage der korrekten UTC Zeit an den User erfolgen.
>
> c. wenn man ein gäste Wifi hinzugefügt hat aber dieses leider eine network
> client separation durchführt so dass der pi zwar verbunden und online ist
> aber von einem anderen client zb Mac per Browser oder SSH nicht erreichbar
> ist … kein lockout … Idee: 90s nach Neustart wird stets ein lokales wifi
> gestartet, und wenn man in dieser Zeit eine spezial URL aufruft oder in den
> Settings ein "stay local wifi" klickt dann soll er nicht mit einem anderen
> wifi verbinden.

## Why these three belong together

All three are field-reachability problems for a headless Pi (no keyboard,
screen or mouse) and all three ride the **same proven trust boundary** already
in the repo: the unauthenticated LAN HTTP layer only ever **drops a trigger
file**; a tiny root-owned `systemd .path → oneshot` unit performs the one
privileged action (`nmcli` / `timedatectl`). This is the exact model used by
click-to-update (`stp-update.path`) and the current WiFi join
(`stp-wifi.path` → `wifi-apply.sh`). Nothing here grants the web layer nmcli
or sudo.

Existing pieces this builds on:
- `src/wifi.js` — pure nmcli parsers + `requestConnect()` trigger writer.
- `scripts/wifi-apply.sh` + `systemd/stp-wifi.{service,path}` — privileged join.
- `scripts/wifi-failover.sh` + `stp-wifi-failover.service` — boot-grace AP.
- `src/server.js` `/api/wifi/{scan,status,connect}`; `web/app.js` Network pane;
  `web/index.html` `<fieldset data-tab="network">`.
- `state.wifiAp` published in `/api/state` (service.js ~2541).

---

## a. Manage multiple WiFi networks (add + forget) from the browser

**Gap.** `connect` already saves an autoconnect profile, so *adding* a second
site's WiFi (guest WiFi elsewhere) works today — but there is **no way to see
the list of saved profiles** and **no way to delete one** entered with a wrong
password or joined by mistake. A wrong saved profile is worse than none: NM
keeps trying to autoconnect it.

### Design

1. **List saved profiles (read-only).** New pure parser in `wifi.js`:
   `parseSavedConnections(stdout)` over
   `nmcli -t -f NAME,TYPE,AUTOCONNECT connection show` → wifi profiles only,
   flag the currently-active one, flag the AP profile (never offer to delete
   the AP). Wrapper `listSavedNetworks()`. New route `GET /api/wifi/saved`.

2. **Forget a profile (privileged).** Generalise the trigger instead of adding
   a second path unit. `requestConnect()` already writes
   `{ ssid, psk, requestedAtMs }`; extend to
   `{ action: 'connect' | 'forget', ssid, psk?, requestedAtMs }` (default
   `action:'connect'` for back-compat). New `requestForget({ ssid, triggerPath })`.
   `wifi-apply.sh` branches on `action`: `forget` → `nmcli connection delete
   "$SSID"` (refuse if `$SSID` == AP profile — hard guard). New route
   `POST /api/wifi/forget { ssid }`.

3. **UI.** In the Network pane, add a **"Saved networks"** list above the scan
   list: each row shows SSID · autoconnect · (active ✓) with a **Forget**
   button (confirm-required, like the update button). Scan list unchanged.
   Refresh both on pane open and after any action.

### New/changed files
- `src/wifi.js`: `parseSavedConnections`, `savedArgs`, `listSavedNetworks`,
  `requestForget`; `requestConnect` gains `action`.
- `scripts/wifi-apply.sh`: read `action`, add the guarded `forget` branch.
- `src/service.js`: wire `requestWifiSaved` / `requestWifiForget` (gated on
  `config.wifi.enabled`).
- `src/server.js`: `GET /api/wifi/saved`, `POST /api/wifi/forget`.
- `web/index.html` + `web/app.js`: saved-list + Forget button.
- `test/wifi.test.js`: parser + trigger-writer + AP-guard tests (off-Pi).

### Open decision
- **a1.** Should Forget require the network to be *not currently in use*, or
  allow forgetting the active one (which drops the link → failover AP comes
  up)? Recommend: allow, with an explicit "this will disconnect" confirm.

---

## b. Offline / no-NTP → mandatory UTC entry from the browser

**Why this is high-stakes, not cosmetic.** Every prediction in this app is
time-critical (Sun/Moon ephemeris, SGP4/ISS, transit ETAs). Pi has **no RTC by
default** — offline at boot, the clock is wrong and *all* predictions are
silently garbage. So when NTP has not synced, the UI **must** force a correct
UTC before trusting anything. This is the "MUSS" in the ask.

### Design

1. **Detect sync state.** `timedatectl show -p NTPSynchronized -p Timezone`
   (read-only, works as service user). Publish in `/api/state`:
   `state.clock = { ntpSynced:boolean, systemUtcMs, source:'ntp'|'manual'|'unknown', manualSetAtMs }`.
   Pure parser + wrapper in a new `src/clock.js` (mirrors `wifi.js` split).

2. **Set time (privileged, trigger-file).** `POST /api/time/set { iso }`
   validates an ISO-8601 UTC string (sane bounds, e.g. 2025–2035) → drops
   `data/time-set.request`. New `stp-time.path` → `stp-time.service` →
   `scripts/time-apply.sh`:
   `timedatectl set-ntp false` (stop NTP fighting the manual value) then
   `timedatectl set-time "<UTC>"`; record `source:'manual'`. When NTP later
   syncs on reconnect, it wins again automatically.

3. **Mandatory UI prompt.** When `ntpSynced === false` **and** no manual set
   this boot: show a **prominent, non-trivially-dismissable modal** —
   "⏱ Clock unverified — predictions may be wrong. Enter the correct UTC."
   - **Prefill with the browser's own clock** (`new Date()` → the phone/laptop
     is almost always right) and a one-tap **"Use my device time"**; user still
     confirms (satisfies "MUSS … Abfrage").
   - While unverified, stamp a persistent **red banner** on the main UI and mark
     the running-version/clock badge as untrusted so predictions are never
     mistaken for reliable.
   - Also expose a manual override entry in the Network/System settings tab even
     when synced (rare correction).

4. **Survive reboots.** No RTC ⇒ manual time is lost on power-cycle. Mitigations
   (pick in b2): rely on Pi OS `fake-hwclock` (monotonic, not accurate); and/or
   document an **optional coin-cell RTC** (Pi 5 has an RTC header) as the real
   fix — a hardware note in the README, not code.

### New/changed files
- `src/clock.js` (new): `parseTimedatectl`, `getClockStatus`, `requestSetTime`.
- `scripts/time-apply.sh` (new) + `systemd/stp-time.{service,path}` (new).
- `src/service.js`: publish `state.clock`; wire `requestSetTime`.
- `src/server.js`: `GET`(in state) + `POST /api/time/set`.
- `web/index.html` + `web/app.js`: mandatory clock modal + red banner + settings
  field.
- `scripts/install-pi5.sh`: install/enable `stp-time.path`.
- `test/clock.test.js` (new): parser + ISO validation + trigger writer.

### Open decisions
- **b1.** How hard is "mandatory"? Recommend: modal blocks the Settings + hides
  nothing else, but a **red unverified banner stays** until set/synced (don't
  fully lock the UI — the user may just want to read the AP password). Confirm.
- **b2.** Reboot persistence: `fake-hwclock` only, or also push the coin-cell
  RTC as the documented recommendation? Recommend: both (doc + fake-hwclock).

---

## c. Guest-WiFi client-isolation → lockout prevention

**The trap.** User adds a guest WiFi that does **client isolation**: Pi is
online (has internet) but **unreachable** from the Mac by browser *or* SSH.
With no keyboard/screen the user is fully locked out — today's failover AP only
comes up when the Pi is *offline*, so an *isolated-but-online* Pi never falls
back. This is the dangerous case.

Two complementary safety nets — recommend **building both**:

### c1. Guaranteed boot AP window (the user's idea, refined)

On **every** boot, before honouring autoconnect, host the local AP for
`bootLocalWindowS` (default **90 s**). During the window:
- the web UI is reachable at the AP IP;
- a **special URL** `GET /api/wifi/stay-local` (and a **"Stay on local WiFi"**
  toggle in Settings → Network) **latches** a flag file `data/wifi-stay-local`.
- If latched → failover **never autoconnects a client**, always hosts the AP,
  until the user clears it ("Rejoin networks" button removes the flag).
- If not latched → after the window, proceed to normal autoconnect.

Single radio = AP **or** client, so this trades ~90 s of offline time per boot
for a guaranteed reachability window. `bootLocalWindowS` and the latch live in
`config.wifi` + are Settings-editable; `0` disables the window.

Implementation: extend `scripts/wifi-failover.sh`:
- at start, `nmcli connection down` any autoconnect wifi, host AP for
  `bootLocalWindowS`, watch for the flag file;
- after the window, if flag present → stay AP; else resume the existing
  offline/known-net loop.
`server.js`: `GET /api/wifi/stay-local` (set) + a clear route; both just
touch/remove the flag file (no privilege needed — it's read by root failover).

### c2. Isolation watchdog (stronger — auto-recovers without perfect timing)

The boot window only helps if the user is watching at boot. Add an automatic
detector so an isolating network **self-heals**:
- The server already sees every HTTP request. Record
  `lastLanClientSeenMs` whenever a request arrives from a **private-range**
  peer IP (a real LAN client reached us). Publish it.
- `wifi-failover.sh`, after joining a **client** network, reads this timestamp
  (via a tiny status file the server writes, or `GET /api/wifi/status`): if
  **no LAN client has reached the box within `isolationGraceS` (default
  ~600 s)** while on a client link, assume isolation → drop the client and host
  the AP (and optionally auto-forget that SSID after N strikes so it doesn't
  re-trap on the next boot).
- Reset the timer on every observed LAN client, so a normally-reachable network
  never trips it.

This directly answers "network client separation" without relying on the user
catching the 90 s window.

### New/changed files
- `scripts/wifi-failover.sh`: boot AP window + stay-local flag + isolation
  watchdog.
- `src/service.js`: track `lastLanClientSeenMs` (private-IP requests), write a
  small `data/wifi-reachability.json` for the root script; publish in state.
- `src/server.js`: `GET /api/wifi/stay-local`, `GET /api/wifi/rejoin` (clear
  flag), private-IP tagging on requests.
- `src/config.js` / example: `wifi.bootLocalWindowS`, `wifi.isolationGraceS`,
  `wifi.isolationStrikes`.
- `web/index.html` + `web/app.js`: "Stay on local WiFi" toggle + status.
- `test/`: private-IP classifier + flag/latch logic (pure parts off-Pi).

### Open decisions
- **c1.** Boot AP window default 90 s (user's number) — keep, or make it only
  trigger when the *last* boot's network was a newly-added/guest one? Recommend:
  always 90 s, simplest and matches the ask; `0` to disable.
- **c2.** On repeated isolation, auto-forget the offending SSID after N strikes,
  or only fall back to AP and leave the profile? Recommend: fall back to AP,
  **flag** the SSID in the UI as "unreachable — Forget?", don't auto-delete.
- **c3.** Second radio: a cheap USB WiFi dongle could host a *permanent* AP
  while the onboard radio stays on the guest net (no offline window, no lockout
  ever). Worth a README hardware note as the bulletproof option?

---

## d. Intermittent "SERVER OFFLINE" flash on the e-paper (a few seconds, not the 60 s refresh)

**Symptom (user).** Every so often the panel briefly shows "display inactive /
not reachable / SERVER OFFLINE" for a few seconds, then recovers. NOT the normal
ghosting flash of the periodic full refresh.

### Root cause

The display client (`display/epaper_client.py`) polls with a **hard, short HTTP
timeout** — `config.HTTP_TIMEOUT_S = 1.5 s` (`display/config.py:82`) — on
**every quick tick** (`quickRefreshS`, default 2 s). If **one single poll** of
`/api/state` fails or exceeds 1.5 s, `conn_ok` flips to `False` and that tick
renders `render_offline()` → **"SERVER OFFLINE"** (or the AP onboarding screen).
The very next tick succeeds and it recovers. So one slow/dropped poll = a
few-seconds flash. This is *by design* (fail-fast + auto-recover, documented in
`display/README.md:157`) — but a single blip is enough to trigger it, and there
is **no tolerance for a lone transient failure**.

What makes an occasional single poll exceed 1.5 s / fail:
1. **Node event loop blocked > 1.5 s by periodic heavy work** → `/api/state`
   can't answer in time. Suspects: a long `tick()` (SGP4 over the catalogue +
   findTransits + snapshots under heavy traffic), an ISS TLE reload, or an
   on-demand op sharing the loop (Sat finder propagating ~15 k TLEs, the long
   "next opportunity" DSO scan, the Stats report). Occasional → matches "von
   Zeit zu Zeit".
2. **Extra per-tick request load.** Every tick ALSO fires a second `/api/state`
   GET for `fetch_local_wifi_ap()` (localhost), plus two `/api/config` fetches
   every 5 s — more requests = more chance one lands during a busy moment.
3. **Two-Pi (remote source) setups:** NetworkManager's periodic background WiFi
   **scan** (~every 2 min) briefly adds latency/packet loss on the associated
   link → a poll to the remote predictor tips over 1.5 s. Classic "every couple
   of minutes, brief blip". (Also `wifi-failover.sh` drops the AP ~25 s every
   180 s to probe — but only while hosting the AP.)
4. A lone GC pause / TCP hiccup > 1.5 s.

**First, confirm which:** the client logs `offline: <url> (<reason>)` on change
(`epaper_client.py:269`) → `journalctl -u stp-display` shows the reason
(`timed out` vs `Connection refused`) and the cadence. `timed out` on a
localhost source ⇒ cause 1 (event-loop block); `timed out` on a remote source
every ~2 min ⇒ cause 3 (WiFi scan); `Connection refused` ⇒ the Node service
actually restarted.

### Fix (proposed)

1. **Debounce (primary).** Require **N consecutive failed polls** (default 2–3)
   before rendering the offline screen — a single transient blip keeps the last
   good frame on screen. Kills the visible flash for causes 1–4 while a real
   outage still appears within a few seconds. Small state var + threshold in the
   client loop.
2. **Configurable, slightly longer timeout.** Make `HTTP_TIMEOUT_S` a Setting
   (default raise 1.5 → ~3 s) so a busy-but-alive server isn't read as offline.
3. **Throttle the local-AP probe.** Only call `fetch_local_wifi_ap()` every few
   seconds (not every 2 s tick), or reuse the source `/api/state` when the source
   IS localhost — halves the request load in the common single-Pi case.
4. **Node side (optional, if cause 1 confirmed).** Keep `/api/state` served from
   the cached `state` snapshot only (never blocking on in-flight heavy work) so
   an in-progress tick/TLE-reload can't stall the HTTP response.

### New/changed files
- `display/epaper_client.py`: consecutive-failure debounce.
- `display/config.py`: `HTTP_TIMEOUT_S` from config; throttle `fetch_local_wifi_ap`.
- `src/service.js` / `web`: expose the timeout as a `display.*` Setting; verify
  `/api/state` never blocks on heavy work.
- `display/README.md`: note the debounce + how to read the journal reason.

### Open decision
- **d1.** Debounce threshold + default timeout — recommend 2 consecutive
  failures and 3 s. Confirm, or prefer a faster true-outage signal (keep 1.5 s,
  debounce 3)?

---

## Cross-cutting / sequencing

- **Trust boundary unchanged.** Every privileged action stays a trigger-file →
  root `.path` unit. HTTP layer never runs nmcli/timedatectl. Guard the
  `forget` action against deleting the AP profile.
- **Off-Pi testable.** Keep pure parsers/validators in `wifi.js` / `clock.js`
  so `npm test` covers them without a Pi (the repo's established pattern).
- **All Pi-only features 404 gracefully** off-Pi (as `/api/wifi/*` already do),
  so the Mac dev box and non-`--with-wifi-ap` installs are unaffected.
- **Suggested order:** (b) clock first — it's a correctness bug that silently
  ruins predictions; then (a) forget/manage — small and self-contained; then
  (c) lockout nets — largest, touches the root failover loop.
- **Docs + version:** README "Off-road WiFi" + a new "Clock / offline time"
  section; wiki Setup/Advanced pages; MILESTONES entry; version bump from
  0.56.6. Update `install-pi5.sh` for the new units.

## Task checklist (once decisions are locked)

- [ ] b — `src/clock.js` + tests; `state.clock`; `time-apply.sh` +
      `stp-time.{service,path}`; mandatory modal + red banner; install script.
- [ ] a — saved-profile list + `forget` trigger action + AP guard; UI list +
      Forget button; tests.
- [ ] c1 — boot AP window + stay-local latch + special URL/toggle; config knobs.
- [ ] c2 — LAN-client reachability tracking + isolation watchdog in failover.
- [ ] d — display client: consecutive-failure debounce + configurable timeout +
      throttled local-AP probe; confirm `/api/state` never blocks.
- [ ] Docs (README/wiki/MILESTONES) + version bump + `npm test` green +
      `node --check`.
- [ ] Pi 5 hardware verification (real nmcli/timedatectl, isolation scenario) —
      user step, as with prior WiFi/e-paper work.
