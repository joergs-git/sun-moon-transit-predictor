# sun-moon-transit-predictor

Predicts and detects aircraft transits across the **sun and moon disc** from a
fixed observer location (Rheine, Germany), so the camera at the telescope can
be armed in time. End-to-end runs on a single **Raspberry Pi 5** (Raspberry
Pi OS Lite, 64-bit) alongside `dump1090-fa`, with a small browser UI and
Pushover notifications in two stages: an early candidate alert and a precise
T-minus alert once live ADS-B has nailed down the transit time.

## Overview

```
[ADS-B antenna] → [dump1090-fa]   ─┐
                  aircraft.json    │ poll 2 s
                                   ▼
                            [stp service]
                              tracker   → 60 s linear extrapolation
                              geometry  → topocentric Az/El (Sun/Moon)
                              notifier  → two-stage Pushover
                              store     → SQLite history
                              server    → /api/* + web UI on :8081
```

## How the prediction works

Every poll cycle (default every 2 s) the service answers one question:

> *Which aircraft, currently visible to the local ADS-B receiver, will line
> up between my observer location and the Sun or Moon disc within the next
> 60 seconds — while that body sits more than 20° above the horizon?*

1. **Sky position.** Topocentric Az/El of the Sun and Moon are computed for
   the configured observer (WGS84, refraction-corrected). Bodies below the
   20° elevation floor are flagged `observable: false` and skipped — the
   floor keeps obstructions, haze, and refraction residuals out of the
   budget.
2. **Aircraft position.** Each aircraft from `dump1090-fa`'s `aircraft.json`
   is converted WGS84 → ECEF → ENU into Az/El relative to the same observer,
   using `alt_geom` (fallback `alt_baro`) as MSL. ADS-B `seen_pos` latency is
   back-stamped onto the actual fix time, so the projection starts from when
   the position was sampled, not from "now".
3. **Forward projection.** Position and velocity are linearly extrapolated
   on the local tangent plane in 1 s steps across the next 60 s.
4. **Separation test.** Great-circle angular separation between the
   predicted aircraft Az/El and the body's Az/El is computed at each step.
   When the *minimum* separation across the trajectory drops below
   `thresholdDeg` (default 0.3°; the Sun's disc is ~0.27° wide), the
   aircraft becomes a **transit candidate** with closest-approach time,
   minimum separation, and transit duration.
5. **Two-stage notification.** An *early* Pushover fires the first time a
   candidate is seen. A *precise* Pushover fires when the predicted closest
   approach lands within ±30 s of `now` and live ADS-B has firmed up the
   timing. Each pair is deduplicated per `(icao, body)`.

The browser UI and the SQLite history give you the same view after the
fact: every dispatched notification is logged with callsign, IATA flight,
origin / destination, minimum separation, ETA, altitude, and ground speed.

**Headless on the Pi.** The detection loop runs inside `stp.service` on
the Pi 24/7 — the polling interval, geometry, transit search, Pushover
dispatch and SQLite write are all server-side. The browser UI is **just a
viewer** for state the service has already computed; closing the tab does
not pause anything and never causes a missed transit. The Pi can run
without a monitor, keyboard, or any client connected.

## Status

| Milestone | Scope | Status |
|---|---|---|
| M1 | Pi receiver setup (dump1090-fa) | hardware task, out of repo |
| M2 | Geometry core (Az/El, Sun/Moon, separation) | done |
| M3 | Live tracker (`aircraft.json` polling, extrapolation, candidates) | done |
| M4 | Pushover notifier, two-stage messages with flight details | done |
| M5 | adsbdb.com route lookup (origin / destination / IATA flight number) | done |
| M6 | Web UI on the Pi (live list + persistent history) | done |
| M7 | Bash install script for Pi 5 (Raspberry Pi OS, ARM64) | done |
| M8 | Accuracy pass: latency back-stamp, sub-step vertex refinement, geoid offset, refraction-frame alignment | done |
| M9 | Zero-touch operations: gitignored personal config, `--non-interactive` install, nightly auto-update timer | done |
| M10 | History-based predictor (24 h "Expected today" panel) + optional OpenSky schedule augmentation | done |
| M11 | Lifecycle pipeline: planned → radio → candidate → imminent → stale, with `horizonS=300` default, unified UI panel | done |

## Quick install on the Pi 5

Recommended OS image: **Raspberry Pi OS Lite (64-bit)** via the Pi Imager
(set hostname, SSH key, and Wi-Fi in the Imager's "Edit Settings" before
flashing). Then on the Pi:

```bash
git clone https://github.com/joergs-git/sun-moon-transit-predictor.git
cd sun-moon-transit-predictor
bash scripts/install-pi5.sh
```

The script:

1. installs Node.js 22 from NodeSource if it isn't already present,
2. runs `npm install --omit=dev`,
3. prompts for observer coordinates and Pushover credentials and writes
   `config/observer.json` + `config/service.json` (both **gitignored** so
   `git pull` and the auto-updater can never overwrite them),
4. installs and starts a `stp.service` systemd unit (with light
   sandboxing — `ProtectSystem=strict`, `ReadWritePaths=…/data`),
5. installs `stp-update.timer` for nightly auto-update (opt out with
   `--no-auto-update`).

After it finishes, browse to `http://<pi-ip>:8081/`. Logs:
`journalctl -u stp.service -f`.

Re-running the script keeps existing config files. Useful flags:

| Flag | Effect |
|---|---|
| `--overwrite`        | Re-prompt for everything; rewrite both config files. |
| `--non-interactive`  | Zero prompts; reads defaults from env vars (see below). Pairs well with cloud-init / Ansible / first-boot scripts. |
| `--no-auto-update`   | Skip the nightly `stp-update.timer` install. |

### Zero-touch first-boot install

For a true zero-interaction setup, drop credentials in env vars and let the
installer write everything in one shot:

```bash
STP_LAT=52.2833 \
STP_LON=7.4406 \
STP_ELEV=50 \
STP_GEOID_M=46 \
STP_PUSHOVER_TOKEN=azGD…  \
STP_PUSHOVER_USER=uQiR… \
bash scripts/install-pi5.sh --non-interactive
```

The full env-var list is in the script's header (`bash scripts/install-pi5.sh --help`).

## Service control (systemd)

The installer registers `stp.service` as a systemd unit and starts it. From
then on it auto-restarts on failure and comes back after a reboot. The
day-to-day commands:

```bash
# status / start / stop / restart
sudo systemctl status   stp.service
sudo systemctl start    stp.service
sudo systemctl stop     stp.service
sudo systemctl restart  stp.service

# enable / disable autostart on boot
sudo systemctl enable   stp.service
sudo systemctl disable  stp.service

# logs (live tail and last hour)
journalctl -u stp.service -f
journalctl -u stp.service --since "1 hour ago" --no-pager
```

After editing `config/observer.json` or `config/service.json`, restart the
service so the changes are picked up:

```bash
sudo systemctl restart stp.service
```

To remove the unit (without uninstalling Node or the repo):

```bash
sudo systemctl disable --now stp.service
sudo rm /etc/systemd/system/stp.service
sudo systemctl daemon-reload
```

## Updating the service

### Auto-update is on by default

**What triggers an update?** Every commit pushed (or merged) to the
`main` branch on `github.com/joergs-git/sun-moon-transit-predictor`. The
Pi tracks `origin/main` directly — GitHub *Releases* / tags are *not*
required and are ignored. Latency: up to 24 hours (the next 03:30 timer
firing). To pull immediately, see *Manual update* below.

The installer drops `scripts/auto-update.sh` plus a systemd timer
(`stp-update.timer`) that fires nightly at **03:30 ± 15 min**. Each run:

1. **Backs up** `config/observer.json` and `config/service.json` to a temp
   dir (defensive — even if upstream renames or .gitignores them, your
   per-site setup survives).
2. `git pull --ff-only` (no merges, no force).
3. **Restores** the configs if anything changed underneath them.
4. Runs `npm install --omit=dev` only if `package.json` / lockfile moved.
5. Restarts `stp.service` only if backend code (`src/`, `bin/`,
   `package*.json`, `systemd/stp.service`, `config/service.example.json`)
   changed. Frontend-only commits don't restart — the browser picks them
   up on the next refresh.

The restart is graceful (~5 s downtime; SIGTERM → flush SQLite → exit →
systemd respawn). No interactive prompt, no SSH session needed, no manual
intervention on the Pi.

Inspect / probe / disable:

```bash
# what's scheduled and when next?
systemctl list-timers | grep stp-update

# run an update right now (same code path the timer uses)
sudo systemctl start stp-update.service
journalctl -u stp-update.service -n 50 --no-pager

# turn the auto-updater off without touching the main service
sudo systemctl disable --now stp-update.timer
```

### Manual update

The same script is safe to run on demand:

```bash
cd ~/sun-moon-transit-predictor
bash scripts/auto-update.sh
```

Or the long form, which is what `auto-update.sh` automates:

```bash
git pull --ff-only
npm install --omit=dev          # only if package.json changed
sudo systemctl restart stp.service
journalctl -u stp.service -n 30 --no-pager
```

### Frontend-only updates

Files in `web/` are served live from disk by the Node process — no build
step, no bundling. After a pull, a hard browser refresh (`Ctrl+Shift+R`) is
enough; `systemctl restart` is not needed for HTML / JS / CSS-only changes.
The auto-updater detects this and skips the restart.

### What is preserved across updates

`config/observer.json` and `config/service.json` are **gitignored**. They
are written once by the installer and never overwritten by `git pull`,
`auto-update.sh`, or a re-run of the installer (use `--overwrite` to force).
The schema reference lives at `config/observer.example.json` and
`config/service.example.json` — diff your real files against those when a
release notes a new field.

### One-time migration from v0.1.x → v0.2.0

Earlier versions tracked `config/observer.json` in git. Pulling v0.2.0+ on
top of an older checkout will refuse with
`error: Your local changes ... would be overwritten by merge` (which is
git protecting your real coordinates). Run this exact sequence once, on
each existing Pi, the first time you update:

```bash
cd ~/sun-moon-transit-predictor

# 1. Back up the real coords (still intact on disk)
cp config/observer.json /tmp/observer.json.bak

# 2. Reset the working-tree file to HEAD so the pull's deletion can apply
git checkout -- config/observer.json

# 3. Pull — succeeds now and removes the old tracked file
git pull --ff-only

# 4. Restore the real config; observer.json is now gitignored, so git
#    will never touch it again
cp /tmp/observer.json.bak config/observer.json
rm /tmp/observer.json.bak

# 5. Verify
cat config/observer.json

# 6. Re-run the installer. Your config is kept (no prompts) — the only
#    new artefact is the nightly auto-update timer + sudoers fragment.
bash scripts/install-pi5.sh

# 7. Sanity check
systemctl status stp.service
systemctl list-timers | grep stp-update
curl -s http://localhost:8081/api/health
node scripts/test-push.js          # optional: confirm Pushover end-to-end
```

After this one-time step, **every subsequent push to `main` rolls onto the
Pi automatically** the next night via `auto-update.sh`, with the same
backup/restore guard built in. You will never need to repeat steps 1–4.

### Push-driven updates (GitHub webhook)

Webhooks require an inbound HTTPS endpoint, which a typical home Pi behind
NAT does not expose. Workable patterns if you need near-real-time updates:

- a public reverse tunnel (Cloudflare Tunnel, Tailscale Funnel, ngrok)
  pointing at a tiny webhook receiver on the Pi that runs `auto-update.sh`,
  or
- a GitHub Actions job that opens an SSH tunnel via Tailscale and runs
  `bash scripts/auto-update.sh` on the Pi after each merge to `main`.

For a hobby setup the bundled nightly timer is almost always enough.

## Where files live

| Path | Purpose | Tracked in git? |
|---|---|---|
| `<repo>/config/observer.json`         | Observer location (lat / lon / elevation, geoid undulation). **Personal.** | no — gitignored |
| `<repo>/config/observer.example.json` | Schema reference / template for `observer.json`.            | yes |
| `<repo>/config/service.json`          | Runtime config (ADS-B URL, intervals, Pushover keys, server, DB, routes). **Personal.** | no — gitignored |
| `<repo>/config/service.example.json`  | Schema reference / template for `service.json`.             | yes |
| `<repo>/data/history.db`              | SQLite history of all dispatched notifications (created on first run). | no — gitignored |
| `<repo>/web/`                         | Static frontend served at `http://<host>:<port>/`.          | yes |
| `<repo>/bin/stp.js`                   | Service entry point.                                        | yes |
| `<repo>/scripts/install-pi5.sh`       | Idempotent Pi installer (interactive or `--non-interactive`). | yes |
| `<repo>/scripts/auto-update.sh`       | Pull + install-deps + restart-on-change. Backs up local config first. | yes |
| `<repo>/scripts/test-push.js`         | One-shot Pushover sanity check.                             | yes |
| `<repo>/systemd/stp.service`          | Template for the main systemd unit.                         | yes |
| `<repo>/systemd/stp-update.{service,timer}` | Templates for the nightly auto-updater.               | yes |
| `/etc/systemd/system/stp.service`     | Generated unit (paths and user templated by the installer). | n/a (system) |
| `/etc/systemd/system/stp-update.{service,timer}` | Generated auto-update unit + timer.              | n/a (system) |
| `/etc/sudoers.d/stp-update`           | Narrow rule: `<user> NOPASSWD: /bin/systemctl restart stp.service`. | n/a (system) |

The main service runs sandboxed: `ProtectSystem=strict`,
`ProtectHome=read-only`, and the only writable path is `<repo>/data/`. The
SQLite history file therefore *must* live inside `data/` (the default) —
pointing `store.path` outside that directory will fail at write time when
running under systemd.

**Config preservation contract.** `observer.json` and `service.json` are
gitignored from the first commit that contains this README. Neither
`git pull` nor `auto-update.sh` will ever touch them. The installer only
rewrites them when run with `--overwrite`. If you ever need to roll back,
copy from the matching `*.example.json` and re-edit.

## Manual run (development / non-Pi)

Useful for hacking on the code, testing config changes, or running on a
non-Pi machine that already has `dump1090-fa` (or an equivalent feed)
reachable on the network.

```bash
npm install
cp config/service.example.json config/service.json   # then edit
node --experimental-sqlite bin/stp.js
```

The process logs the listening URL, the resolved ADS-B URL, and whether
Pushover is enabled. Stop it with `Ctrl+C` — it traps `SIGINT` / `SIGTERM`,
closes the HTTP server, flushes SQLite, and exits cleanly.

`--experimental-sqlite` is needed on Node 22; on Node 24+ the flag becomes a
no-op since `node:sqlite` is stable.

### Environment variables

| Variable        | Default                          | Purpose |
|---|---|---|
| `STP_OBSERVER`  | `<repo>/config/observer.json`    | Override the observer-config path. |
| `STP_CONFIG`    | `<repo>/config/service.json`     | Override the service-config path. |

Useful for running multiple observer locations from a single checkout, or
for keeping production credentials out of the repo:

```bash
STP_OBSERVER=/etc/stp/observer-rheine.json \
STP_CONFIG=/etc/stp/service.prod.json     \
  node --experimental-sqlite bin/stp.js
```

## Tests

```bash
npm test
```

84 vitest cases cover geometry, ADS-B parsing, tracker (including the
ADS-B latency back-stamp, sub-step vertex refinement, barometric geoid
offset from M8, and the level=candidate/radio split from M11), Pushover
client, notifier (3-stage pipeline with minStage filter), route lookup
with TTL cache, history store (with the M11 stage-rename migration), the
HTTP server, the history-based predictor, the OpenSky REST client (M10),
and the lifecycle state machine (M11).

## Configuration

### `config/observer.json` (see `observer.example.json`)

```json
{
  "name": "Rheine",
  "latitudeDeg": 52.2833,
  "longitudeDeg": 7.4406,
  "elevationM": 50.0,
  "geoidUndulationM": 46.0
}
```

`elevationM` is the observer's WGS84 ellipsoidal height (a local MSL value
within ~50 m is fine). `geoidUndulationM` is the EGM2008 N at the observer
location — used only when an aircraft reports `alt_baro` (pressure
altitude, ≈MSL); the offset is added so the geometric comparison happens in
the right reference frame. Look up your local N at e.g.
[unavco.org/software/geodetic-utilities](https://www.unavco.org/software/geodetic-utilities/geoid-height-calculator/).
Default 0 is fine if you only see GPS-equipped aircraft (`alt_geom`).

### `config/service.json` (see `service.example.json`)

```json
{
  "adsb":     { "url": "http://localhost:8080/data/aircraft.json", "pollIntervalMs": 2000 },
  "tracker":  { "horizonS": 60, "stepS": 0.5, "thresholdDeg": 0.3, "bodies": ["Sun", "Moon"] },
  "pushover": { "token": "...", "user": "...", "enabled": true },
  "server":   { "port": 8081, "host": "0.0.0.0", "publicUrl": "" },
  "store":    { "path": "./data/history.db" },
  "routes":   { "enabled": true, "ttlMs": 3600000, "negativeTtlMs": 300000 }
}
```

`thresholdDeg` (default 0.3°) is the maximum line-of-sight separation that
triggers a candidate — the Sun's angular radius is ~0.27°, so 0.3° catches
near-misses too. `stepS` (default 0.5 s) is the sample step the tracker
walks across the look-ahead horizon; the closest-approach time is then
sub-step refined with a parabolic vertex fit, so this only sets the lower
bound on detection coverage, not the time precision of the alert.

## HTTP API

The service exposes a small JSON API and serves the web UI on the same
port (default `8081`, bind host `0.0.0.0`). Replace `<host>` below with the
Pi's hostname or IP address — for example `http://raspberrypi.local:8081/`
or `http://192.168.1.42:8081/`.

| Method & path              | Description |
|---|---|
| `GET /`                    | Web UI (live state + history table). |
| `GET /api/state`           | Current observer, Sun/Moon Az/El + observability, aircraft count, `lifecycle[]` (unified per-`(icao, body)` tracking list with status enum, M11 — primary feed for the new UI), plus `candidates[]` (live tracker output, backward compat) and `expected[]` (history-based 24 h watchlist, backward compat). Refreshed every poll. |
| `GET /api/history?limit=…` | Past notifications (early + precise stages) from SQLite, newest first. Default 100, max 500. |
| `GET /api/health`          | Liveness probe — always returns `{ ok: true, time: <ISO> }`. |

Responses are `Cache-Control: no-store`; no authentication, so keep the
service on a trusted LAN or front it with a reverse proxy if you need to
expose it publicly.

### Example calls

```bash
# liveness
curl -s http://<host>:8081/api/health
# → {"ok":true,"time":"2026-05-11T12:00:00.000Z"}

# current sky + active candidates
curl -s http://<host>:8081/api/state | jq

# last 20 dispatched notifications
curl -s 'http://<host>:8081/api/history?limit=20' | jq '.events[]'

# open the live UI in a browser
xdg-open http://<host>:8081/        # Linux
open     http://<host>:8081/        # macOS
```

### Sample `/api/state` response (abbreviated)

```jsonc
{
  "observer":     { "name": "Rheine", "latitudeDeg": 52.2833, "longitudeDeg": 7.4406, "elevationM": 50 },
  "nowMs":        1762870000000,
  "lastUpdateMs": 1762869998000,
  "aircraftCount": 17,
  "bodies": {
    "Sun":  { "azimuthDeg": 178.4, "elevationDeg": 42.1, "rangeM": 1.5e11, "observable": true  },
    "Moon": { "azimuthDeg":  65.2, "elevationDeg": -8.7, "rangeM": 3.8e8,  "observable": false }
  },
  "candidates": [
    {
      "icao":                "3c6589",
      "callsign":            "DLH4PV",
      "body":                "Sun",
      "minSeparationDeg":    0.18,
      "closestApproachAtMs": 1762870042000,
      "transitDurationS":    1.4,
      "altitudeFt":          37000,
      "groundSpeedKt":       454,
      "route":               { "iataFlight": "LH123", "origin": "FRA", "destination": "JFK", "airline": "Lufthansa" }
    }
  ]
}
```

`observable: false` on a body means it is below the 20° horizon floor — any
aircraft passing in front of it is *not* reported, by design.

## Candidate lifecycle (planned → radio → candidate → imminent → stale)

Every `(icao, body)` entry the service tracks goes through up to four
**status** transitions during its lifetime. They show up in the UI as a
single dynamic list — the user requested an "approach radar"-style flow
rather than two disjoint tables — and the notifier turns three of them
into Pushover messages:

| Status | Trigger | Push priority | Typical lead time |
|---|---|---|---|
| **planned** 📅 | predictor watchlist (recurring history) says a flight is expected within `lifecycle.plannedWindowMs` (default 1 h) | none (UI only) | minutes to hours |
| **radio** 📡 | tracker projects `[thresholdDeg, looseThresholdDeg]` separation (default 0.3°–5°) within `horizonS` (default 5 min) | 0 | up to 5 min |
| **candidate** ✈️ | tracker projects `≤ thresholdDeg` separation (default 0.3°) within `horizonS`, more than `imminentWindowMs` away | 0 | 30 s – 5 min |
| **imminent** 🎯 | closest approach within ±`imminentWindowMs` (default ±30 s) | 1 | ≤ 30 s |
| **stale** ❌ | was tracked last tick, gone from the tracker output now — held visible for `lifecycle.staleGraceMs` (default 60 s) or until pushed off the panel by newer entries | none (UI only) | — |

Stage rules:

- **Subsumption.** Higher stages "consume" the lower ones — an aircraft
  that appears directly on the line of sight fires `candidate` (or
  `imminent`) on the first sighting and does *not* retroactively emit
  `radio`. Each stage fires at most once per `(icao, body)` per detection
  cycle, then dedupes for 5 min before forgetting state.
- **Subscription control.** `pushover.minStage` (default `radio`) is the
  earliest stage that may push. Set to `candidate` to silence the wide-net
  early-warning stage if it gets too chatty; `imminent` for "alert me only
  at the last 30 s".
- **What goes into SQLite.** Only `radio`, `candidate` and `imminent` are
  persisted to `transit_history`. `planned` is regenerated from the
  watchlist each tick; `stale` is a UI-only display state.
- **Panel cap.** The tracking list is capped at `lifecycle.maxEntries`
  (default 20). When the cap is hit, the **oldest stale entries are
  dropped first** (FIFO by `lastUpdateMs`) — active rows are always kept.
  Combined with `staleGraceMs=60 s` this gives a "feed" effect: dropped
  contacts linger for ~1 min so you see them disappear, then naturally
  fall off as newer activity displaces them.

Each notification carries: callsign, IATA flight number (if adsbdb resolves
it), airline, origin/destination, altitude (ft), ground speed (kt), minimum
separation, transit duration, ETA. Same payload is recorded in the SQLite
history table.

### Tuning the live look-ahead

`tracker.horizonS` (default 300 s) is the window the live tracker linearly
extrapolates each aircraft over. Bigger window = earlier warning, but
linear extrapolation degrades past ~2 min (turns, ATC vectoring, wind).
Clamped to `[10, 600]` in code. Typical settings:

| Use case | `horizonS` | What you get |
|---|---|---|
| Maximum precision | 60 | First-detection at ~T-60 s; lowest false-positive rate. |
| **Default** | **300** | First-detection at ~T-5 min; a few false-positives from in-cruise turns. |
| Wide net | 600 | First-detection at ~T-10 min; many false-positives, but no transit ever sneaks up on you. |

`tracker.looseThresholdDeg` (default 5°) is the **radio band** width — set
to the same value as `thresholdDeg` to disable the radio stage entirely
and fall back to the old two-stage flow.

## Pushover setup & test push

A fresh checkout has **no `config/service.json`** — only
`config/service.example.json`. Without a service config the Pushover client
runs in disabled mode (`enabled: false`) and silently no-ops every send.
That's safe for first-boot but means *nothing will alert* until you
provide credentials.

### 1. Provide credentials

`scripts/install-pi5.sh` prompts for your Pushover **application token** and
**user key** the first time it runs and writes them into
`config/service.json`. To re-do it later:

```bash
bash scripts/install-pi5.sh --overwrite
```

Or edit `config/service.json` directly:

```json
"pushover": {
  "token":   "azGD…<your app token>",
  "user":    "uQiR…<your user/group key>",
  "device":  "",
  "enabled": true
}
```

`device` is optional — leave empty to fan out to every device on the
account. Restart the service (`sudo systemctl restart stp.service`) after
editing.

### 2. Send a test push

A small helper ships in `scripts/test-push.js`. It loads the live
`config/service.json` and sends a single low-priority message via the same
`PushoverClient` the notifier uses, so it verifies token, user key,
network, and TLS in one shot.

```bash
node scripts/test-push.js
node scripts/test-push.js "custom message"      # optional payload
```

Expected output: `pushover: sent (status=1, request=…)`. The push should
land on every Pushover-equipped device within a couple of seconds. If the
config is disabled or missing keys, the script prints `pushover: disabled`
and exits 1 without contacting the API.

### 3. Verify in production

To confirm the live service can actually reach Pushover (not just the
helper), tail the journal while temporarily lowering `thresholdDeg` in
`config/service.json` to a wide value (e.g. `30`) and restarting — the next
overhead aircraft will then trip both an early and a precise notification.
Restore the threshold afterwards:

```bash
sudo systemctl restart stp.service
journalctl -u stp.service -f | grep -iE 'push|notif'
```

## Predictive watchlist (24 h preview)

The live tracker only sees ~60 seconds into the future (linear ADS-B
extrapolation). The **predictor** complements it with a 24 h preview built
from past transits: any `(flight, body)` pair that hit ≥ 2 distinct days in
the last 14 produces a watchlist entry, and the next expected occurrence is
surfaced in `state.expected`. The "Expected today" panel in the web UI
renders this list as `ETA · Time · Body · Flight · Seen · Days · Spread`.
"Spread" is the standard deviation of the observed time-of-day across days
— think of it as a confidence proxy: `±5m` means the flight is reliably on
schedule, `±45m` means highly variable.

Defaults (override under `predictor` in `config/service.json`):

| Key                  | Default          | Meaning |
|---|---|---|
| `enabled`            | `true`           | Master switch. |
| `daysBack`           | `14`             | History window scanned for repeats. |
| `minRepeats`         | `2`              | Min number of distinct UTC days an entry must hit. |
| `bucketMinutes`      | `60`             | Time-of-day binning width — coarse enough to absorb day-to-day jitter, fine enough that the median predicted time is meaningful to ~1 h. |
| `rebuildIntervalMs`  | `3600000` (1 h)  | Cadence for re-scanning the history table. |
| `lookAheadMs`        | `86400000` (24 h)| Window into the future the predictor surfaces. |

The predictor is **fully local** — it reads only `data/history.db` and
needs no external API. The watchlist warms up over the first 1–2 weeks of
operation as the same scheduled flights repeat. Entries decay automatically
as observations age out of `daysBack`.

## Schedule augmentation (OpenSky, optional)

For faster watchlist warm-up, or coverage of flights your local ADS-B
receiver missed (offline, low signal, terrain-shadowed), you can pull
historical arrivals + departures from
[OpenSky Network](https://opensky-network.org/) at airports near you and
feed them into the predictor as additional observations.

Off by default. Enable with two changes in `config/service.json`:

```json
"opensky": {
  "enabled": true,
  "airports": ["EDDF", "EDDL", "EHAM"],
  "lookbackDays": 7
}
```

(Or set `STP_OPENSKY_AIRPORTS=EDDF,EDDL,EHAM` before running the
installer in `--non-interactive` mode — the script writes the section for
you and flips `enabled`.)

Then run the fetcher manually to populate `data/history.db`:

```bash
node --experimental-sqlite scripts/refresh-schedule.js
```

Output:

```
[EDDF] arrival   day -0: 142 flights
[EDDF] departure day -0: 138 flights
…
refresh-schedule done: inserted=1840 skipped(no body)=120 pruned=0
```

`pruned` removes rows older than `lookbackDays` so the table stays bounded.
The job is **idempotent** — re-running over the same window inserts zero
new rows (`UNIQUE(source, flight, timestamp_ms)` constraint).

For nightly automation, drop a unit + timer pair next to the existing
auto-update timer (the runner is `node scripts/refresh-schedule.js`).
Anonymous OpenSky has a generous 4000 req/day quota; one nightly run for
3–5 nearby airports is well under that limit.

**Caveat.** OpenSky tells us *that* a flight existed at a given airport,
not *whether it overflew our observer*. The predictor groups observations
by `(flight, body, time-of-day)`, so an arriving flight at FRA at 11:00 UTC
becomes a "11:00 ± 1 h Sun watchlist entry" — useful as a heads-up, but
your local ADS-B history remains the ground truth for transit timing.
Don't enable OpenSky if you only fly low priority on accuracy and want
fewer false-positive watchlist entries.

## Web UI

`http://<host>:8081/` ships a single-page UI with two panels:

- **Sky now** — current Sun/Moon Az/El with the observability flag.
- **Tracking** — the unified lifecycle list (see *Candidate lifecycle*
  above). One row per `(icao, body)` or `(flight, body)`, sorted by status
  urgency then ETA. Status pill on the left with the icon (📅 📡 ✈️ 🎯 ❌);
  whole-row tint for `imminent` / `candidate` so urgent rows draw the eye.
  Polls `/api/state` every 2 s — rows transition status in real time as
  the tracker sees them appear, converge, and (sometimes) drop.
- **History** — paginated list backed by `/api/history`, showing every
  persisted notification (radio + candidate + imminent stages) with
  Transit time, callsign, IATA flight, origin / destination, body, minimum
  separation, altitude and speed.

The page is plain vanilla JS — no build step. The files in `web/` are
served directly; `style.css` is dark-themed.

**What is persisted, what is not.** The History panel reads from
`<repo>/data/history.db` (SQLite, see `src/store.js`), which is written
**server-side every time the notifier dispatches a stage** — both `early`
and `precise` rows. Closing the browser does not lose anything; the next
load (even days later) re-reads the same DB file. What is **not** written
is the live "candidate" stream (`/api/state.candidates`) — those rows are
recomputed in memory each tick and only graduate to the DB if they trip a
notification. If you want every detected near-miss persisted, you would
need to call `store.recordEvent` from the tracker tick rather than only
from the notifier — happy to add that as a config switch if useful.

## Assumptions and limitations

- **Geometry**: 0° = N, 90° = E. WGS84 → ECEF → ENU for aircraft Az/El.
  Observer ECEF is computed once per tick and reused for every aircraft × body.
- **Reference frame for the comparison**: both aircraft and body are
  compared in *geometric* (un-refracted) coordinates. `/api/state` still
  exposes the refracted body position via the regular `bodyAzEl` for
  display. Differential refraction along two near-coincident lines of sight
  is well below the search noise.
- **Observability**: `isObservable` returns `true` only for `el > 20°`.
  Tracker skips bodies that never rise above 20° within the horizon.
- **Aircraft altitude**: prefers `alt_geom`, falls back to `alt_baro`.
  `alt_geom` is GPS height above WGS84 ellipsoid (DO-260) and is fed
  straight in. `alt_baro` is pressure altitude (≈MSL on standard atm.) and
  is converted to HAE by adding `observer.geoidUndulationM` (default 0;
  ≈+46 m at Rheine).
- **Extrapolation**: linear, locally-flat tangent plane, 60 s horizon. Error
  versus geodesic is well under 1 m at our typical speeds. Aircraft are
  projected from their **fix time** (`receivedAtMs`), not from `now`, so a
  `seen_pos` lag of several seconds does not bias the predicted position.
- **Sub-step time precision**: after the discrete minimum is located, a
  parabolic vertex is fitted through the three samples around it. With the
  default `stepS = 0.5 s` this gives sub-100-ms closest-approach time.
- **ADS-B liveness**: aircraft with `seen_pos > 30 s` are dropped during
  parsing — stale fixes are not extrapolated.
- **No camera trigger**: explicitly out of scope. We push, you arm the camera.

## Project layout

```
.
├── package.json                  src deps + npm scripts
├── vitest.config.js              test runner config
├── bin/stp.js                    service entry point
├── config/
│   ├── observer.example.json     schema reference (real observer.json is gitignored)
│   └── service.example.json      schema reference (real service.json is gitignored)
├── src/
│   ├── geometry.js               topocentric Az/El + great-circle separation
│   ├── adsb.js                   fetch + normalise dump1090 aircraft.json
│   ├── tracker.js                extrapolation + transit detection (sub-step refined)
│   ├── pushover.js               Pushover REST client
│   ├── notifier.js               two-stage dispatch + dedup
│   ├── adsbdb.js                 callsign → route, in-memory TTL cache
│   ├── store.js                  SQLite history (node:sqlite)
│   ├── server.js                 HTTP server (built-in, no framework)
│   ├── service.js                orchestrator (the polling loop)
│   ├── predictor.js              history-based 24 h watchlist (M10)
│   ├── opensky.js                OpenSky Network REST client (M10, opt-in)
│   ├── lifecycle.js              candidate state machine: planned→radio→candidate→imminent→stale (M11)
│   ├── config.js                 loadObserver()
│   └── index.js                  public re-exports
├── web/
│   ├── index.html                live + expected + history UI
│   ├── app.js                    vanilla-JS poller
│   └── style.css                 dark theme
├── scripts/
│   ├── install-pi5.sh            idempotent installer (interactive or --non-interactive)
│   ├── auto-update.sh            git pull → npm install → restart, with config backup
│   ├── refresh-schedule.js       OpenSky daily fetcher (M10, opt-in)
│   └── test-push.js              one-shot Pushover sanity check
├── systemd/
│   ├── stp.service               main service unit template
│   ├── stp-update.service        auto-update oneshot template
│   └── stp-update.timer          nightly schedule (03:30 ±15 min)
└── test/                         11 vitest files, 84 cases
```

## License

TBD.
