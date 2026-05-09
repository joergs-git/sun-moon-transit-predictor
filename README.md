# sun-moon-transit-predictor

Predicts and detects aircraft transits across the **sun and moon disc** from a
fixed observer location (Rheine, Germany), so the camera at the telescope can
be armed in time. The GitHub repo will be renamed from `sun-transit-predictor`
to `sun-moon-transit-predictor`; until then the directory and remote URL still
carry the old name.

This commit delivers **Milestone 2 (M2): the geometry core**. Live ADS-B
tracking, Pushover notifications, and the web UI come in later milestones.

## Status

| Milestone | Scope | Status |
|---|---|---|
| M1 | Pi receiver setup (dump1090-fa) | hardware task, out of repo |
| **M2** | **Geometry core (this commit)** | **done** |
| M3 | Live tracker (`aircraft.json` polling, extrapolation, transit candidates) | planned |
| M4 | Pushover notifier, two-stage messages with flight details | planned |
| M5 | Flight-plan layer (adsbdb / AeroAPI), wind | planned |
| M6 | Web UI on the Pi (live list, history) | planned |
| M7 | Bash install script for Pi5 (Raspberry Pi OS, ARM64) | planned |

## What M2 provides

A pure-JavaScript ESM library that runs unchanged on Node ≥ 20 (tested on
linux/x64; **Raspberry Pi 5** ARM64 is the deployment target — Pi5 ships Node
22 via NodeSource without trouble) and in modern browsers:

- `aircraftAzEl(observer, lat, lon, altMmsl)` — WGS84 → ECEF → ENU → Az/El of
  an aircraft as seen from the observer.
- `sunAzEl(observer, whenUtc, opts?)` and `moonAzEl(observer, whenUtc, opts?)`
  — topocentric position of Sun/Moon via
  [astronomy-engine](https://github.com/cosinekitty/astronomy).
- `bodyAzEl(observer, body, whenUtc, opts?)` — the same with `body` parameter
  (`'Sun'` or `'Moon'`), useful for callers that handle both uniformly.
- `angularSeparationDeg(a, b)` — great-circle distance between two Az/El
  positions, the basis for transit detection.
- `isObservable(azEl)` and `OBSERVABILITY_MIN_ELEVATION_DEG` (= 20) — Sun/Moon
  data is only relevant when elevation > 20°. Below that the tracker can skip
  transit checks.

## Setup

```bash
npm install
npm test
```

Tests are pure-local (astronomy-engine is self-contained, no ephemeris
download).

## Configure the observer

Edit `config/observer.json` and replace the placeholder coordinates with your
real location:

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

`elevationM` is mean sea level (MSL); see the assumptions block below.
`temperatureC` and `pressureMbar` are reserved for a future custom-refraction
hook and not currently consumed.

## Quick start

```js
import { loadObserver } from './src/config.js';
import {
  aircraftAzEl,
  angularSeparationDeg,
  isObservable,
  moonAzEl,
  sunAzEl,
} from './src/geometry.js';

const observer = loadObserver();
const now = new Date();

const sun = sunAzEl(observer, now);
const moon = moonAzEl(observer, now);

if (isObservable(sun)) {
  const aircraft = aircraftAzEl(observer, 52.5, 7.5, 11000);
  const sep = angularSeparationDeg(sun, aircraft);
  console.log(`Aircraft is ${sep.toFixed(2)}° from the sun centre.`);
}
```

## Assumptions and limitations

- **Refraction**: on by default, using astronomy-engine's `'normal'` model
  (Saemundsson-style). Above the 20° observability threshold the refraction
  shift is well under 0.05° and immaterial to the 0.3° transit tolerance.
  Pass `{ applyRefraction: false }` for the geometric (true) direction.
- **Ephemerides**: astronomy-engine ships the polynomial expansions in code,
  so no `.bsp` / DE440 file is needed. Sun/Moon accuracy is well below 1
  arc-minute, far better than required for this use case.
- **Topocentric corrections**: parallax (especially the ~1° lunar parallax)
  and aberration are handled by `Astronomy.Equator(..., true, true)` plus
  `Astronomy.Horizon(...)`. Inputs are the topocentric observer.
- **Observer height**: the YAML/JSON value is MSL but is fed straight in as
  WGS84 ellipsoidal height. Geoid undulation in Rheine is roughly 46 m; that
  systematic offset is documented and accepted for M2. Correction (e.g. via
  EGM2008) can be added later if it ever matters for the budget.
- **Aircraft height**: `aircraftAzEl` accepts MSL metres. Choosing between
  ADS-B `alt_geom` and `alt_baro` in the live tracker is M3's concern; M2
  is altitude-source agnostic.
- **Azimuth convention**: 0° = North, 90° = East, range [0, 360). Matches
  astronomy-engine's `Horizon` and the usual ADS-B / aviation convention.
- **ADS-B latency**: not modelled here — the live tracker (M3) will
  compensate for the typical 1–3 s age of `aircraft.json` data.
- **Observability threshold**: `isObservable` returns `true` only for
  `elevation > 20°` (strictly greater). Tracker should pre-filter on this
  before doing per-second transit checks, both to save CPU and because
  observations through < 20° of atmosphere aren't useful for our setup.

## Project layout

```
.
├── package.json
├── vitest.config.js
├── config/
│   └── observer.json     # observer coords (placeholder values)
├── src/
│   ├── geometry.js       # core: aircraft/sun/moon az-el, separation
│   ├── config.js         # loadObserver()
│   └── index.js          # public re-exports
└── test/
    └── geometry.test.js  # 12 unit tests
```

## License

TBD.
