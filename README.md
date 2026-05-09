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
   `config/observer.json` + `config/service.json`,
4. installs and starts a `stp.service` systemd unit (with light
   sandboxing — `ProtectSystem=strict`, `ReadWritePaths=…/data`).

After it finishes, browse to `http://<pi-ip>:8081/`. Logs:
`journalctl -u stp.service -f`.

Re-running the script keeps existing config files. Use
`bash scripts/install-pi5.sh --overwrite` to force re-prompting.

## Manual run (development / non-Pi)

```bash
npm install
cp config/service.example.json config/service.json   # then edit
node --experimental-sqlite bin/stp.js
```

`--experimental-sqlite` is needed on Node 22; on Node 24+ the flag becomes a
no-op since `node:sqlite` is stable.

## Tests

```bash
npm test
```

53 vitest cases cover geometry, ADS-B parsing, tracker, Pushover client,
notifier, route lookup with TTL cache, history store, and the HTTP server.

## Configuration

### `config/observer.json`

```json
{
  "name": "Rheine",
  "latitudeDeg": 52.2833,
  "longitudeDeg": 7.4406,
  "elevationM": 50.0,
  "temperatureC": 10.0,
  "pressureMbar": 1010.0
}
```

`elevationM` is mean sea level (MSL); see *Assumptions* below for how it is
treated.

### `config/service.json` (see `service.example.json`)

```json
{
  "adsb":     { "url": "http://localhost:8080/data/aircraft.json", "pollIntervalMs": 2000 },
  "tracker":  { "horizonS": 60, "stepS": 1, "thresholdDeg": 0.3, "bodies": ["Sun", "Moon"] },
  "pushover": { "token": "...", "user": "...", "enabled": true },
  "server":   { "port": 8081, "host": "0.0.0.0", "publicUrl": "" },
  "store":    { "path": "./data/history.db" },
  "routes":   { "enabled": true, "ttlMs": 3600000, "negativeTtlMs": 300000 }
}
```

`thresholdDeg` (default 0.3°) is the maximum line-of-sight separation that
triggers a candidate. The Sun's angular radius is ~0.27°, so 0.3° catches
near-misses too — tighten if you only want centred transits.

## HTTP API

| Path | Description |
|---|---|
| `GET /api/state`    | Current observer, sky (Sun/Moon Az/El + observability), aircraft count, candidates within the horizon. Refreshes every poll. |
| `GET /api/history?limit=…` | Past notifications (early + precise stages) from the SQLite store, newest first. Default limit 100, max 500. |
| `GET /api/health`   | Liveness probe. |
| `GET /` etc.        | Static web app from `web/`. |

## Two-stage notifications

For each `(icao, body)` pair the notifier emits:

1. **Early** — first time we see the candidate. Priority 0.
2. **Precise** — once `closestApproachAtMs` lands within ±30 s of `now`.
   Priority 1.

Each notification carries: callsign, IATA flight number (if adsbdb resolves
it), airline, origin/destination, altitude (ft), ground speed (kt), minimum
separation, transit duration, ETA. Same payload is recorded in the SQLite
history table.

## Assumptions and limitations

- **Geometry**: 0° = N, 90° = E. WGS84 → ECEF → ENU for aircraft Az/El.
- **Refraction**: on by default (`'normal'` model from astronomy-engine).
  Above the 20° observability threshold the residual is well below 0.05°.
- **Observability**: `isObservable` returns `true` only for `el > 20°`.
  Tracker skips bodies that never rise above 20° within the horizon.
- **Aircraft altitude**: prefers `alt_geom`, falls back to `alt_baro`.
  Treated as MSL → fed straight in as WGS84 ellipsoidal h. Geoid undulation
  in Rheine ~46 m is documented and accepted; can be corrected later if it
  ever matters at the budget.
- **Extrapolation**: linear, locally-flat tangent plane, 60 s horizon. Error
  versus geodesic is well under 1 m at our typical speeds.
- **ADS-B latency**: `seen_pos` is back-stamped onto `receivedAtMs` so the
  tracker projects from the actual sample time, not from "now".
- **No camera trigger**: explicitly out of scope. We push, you arm the camera.

## Project layout

```
.
├── package.json                src deps + npm scripts
├── vitest.config.js            test runner config
├── bin/stp.js                  service entry point
├── config/
│   ├── observer.json           location (placeholder values)
│   └── service.example.json    URLs, intervals, Pushover, …
├── src/
│   ├── geometry.js             topocentric Az/El + great-circle separation
│   ├── adsb.js                 fetch + normalise dump1090 aircraft.json
│   ├── tracker.js              extrapolation + transit detection
│   ├── pushover.js             Pushover REST client
│   ├── notifier.js             two-stage dispatch + dedup
│   ├── adsbdb.js               callsign → route, in-memory TTL cache
│   ├── store.js                SQLite history (node:sqlite)
│   ├── server.js               HTTP server (built-in, no framework)
│   ├── service.js              orchestrator (the polling loop)
│   ├── config.js               loadObserver()
│   └── index.js                public re-exports
├── web/
│   ├── index.html              live + history UI
│   ├── app.js                  vanilla-JS poller
│   └── style.css               dark theme
├── scripts/install-pi5.sh      idempotent installer
├── systemd/stp.service         unit template
└── test/                       8 vitest files, 53 cases
```

## License

TBD.
