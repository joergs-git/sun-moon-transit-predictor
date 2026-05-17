# sun-moon-transit-predictor
Predicts and detects aircraft transits across the **sun and moon disc** from a
fixed observer location (Rheine, Germany), so the camera at the telescope can
be armed in time. End-to-end runs on a single **Raspberry Pi 5** (Raspberry
Pi OS Lite, 64-bit) alongside `dump1090-fa`, with a small browser UI and
Pushover notifications in two stages: an early candidate alert and a precise
T-minus alert once live ADS-B has nailed down the transit time.

![Plane direction and FOV](/sunmoonplane2.png)
![Plane in front of sun](/sun-n-plane.png) 
![Fov projection](/sunplane.png)


## Overview

```
[ADS-B antenna] → [dump1090-fa]   ─┐
                  aircraft.json    │ poll 2 s
                                   ▼
                            [stp service]
                              tracker   → 900 s (15 min) linear extrapolation
                              geometry  → topocentric Az/El (Sun/Moon)
                              notifier  → 3-stage Pushover (radio→candidate→imminent)
                              store     → SQLite history
                              server    → /api/* + web UI on :8081
```

## How the prediction works

Every poll cycle (default every 2 s) the service answers one question:

> *Which aircraft, currently visible to the local ADS-B receiver, will line
> up between my observer location and the Sun or Moon disc within the next
> 900 seconds (15 min) — while that body sits more than 20° above the horizon?*

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
   on the local tangent plane in 0.5 s steps across the next 900 s (15 min).
4. **Separation test.** Great-circle angular separation between the
   predicted aircraft Az/El and the body's Az/El is computed at each step.
   When the *minimum* separation across the trajectory drops below
   `thresholdDeg` (default 0.3°; the Sun's disc is ~0.27° wide), the
   aircraft becomes a **transit candidate** with closest-approach time,
   minimum separation, and transit duration.
5. **Three-stage pipeline.** Each match is classified by its projected
   minimum separation and time-to-closest: **radio** (inside the wide
   panel band, `looseThresholdDeg`, default 2° — early warning),
   **candidate** (inside the tight band, `thresholdDeg`, default 0.3°)
   and **imminent** (closest approach within ±30 s). A Pushover fires once
   per stage, deduplicated per `(icao, body)`; the phone has its own
   tighter filter (`pushover.radioThresholdDeg`, default 1°) so it stays
   quiet on the widest band.

The browser UI and the SQLite history give you the same view after the
fact. Since v0.8.0 the History is logged at the full panel band
**independent of the Pushover phone filter** — the early `radio` row is
recorded even when the phone deliberately stays silent, so the `Lead`
column (Transit − Recorded) reflects the true advance warning. Each row
carries callsign, IATA flight, origin / destination, minimum separation,
ETA, altitude and ground speed.

**Headless on the Pi.** The detection loop runs inside `stp.service` on
the Pi 24/7 — the polling interval, geometry, transit search, Pushover
dispatch and SQLite write are all server-side. The browser UI is **just a
viewer** for state the service has already computed; closing the tab does
not pause anything and never causes a missed transit. The Pi can run
without a monitor, keyboard, or any client connected.

## End-to-end pipeline reference

This section unpacks the per-tick logic so the "what is computed when"
question has a single answer to point at. The five-step summary above is
the user-facing version; the layout below is the engineering view.

### 1. Data sources

| Source | What | Refresh | Module |
|---|---|---|---|
| `dump1090-fa` (local) | `aircraft.json` (live ADS-B) | **every 2 s** | `adsb.js` |
| `astronomy-engine` | Sun/Moon ephemerides | **recomputed every tick** (no cache) | `geometry.js` |
| `data/history.db` | dispatched Pushovers | **rebuilt hourly** into the watchlist | `predictor.js` + `store.js` |
| `adsbdb.com` | IATA flight, route, airline | per candidate, **1 h positive cache, 5 min negative** | `adsbdb.js` |

### 2. The 2-second tick (`service.js → tick()`)

The main heartbeat. Each pass executes the following in order:

**a) Coarse Sun/Moon trajectory** — `tracker.js → sampleBodyTrajectory`. Az/El
for each tracked body is computed across the next `horizonS` seconds
(default 900 s = 15 min look-ahead) at `stepS` resolution (default 0.5 s),
yielding **1801 Az/El samples per body** per tick. Geometric (no refraction)
to match the aircraft side, which is also un-refracted.

**b) Coarse aircraft route vector** — `tracker.js → extrapolate`. Each
ADS-B contact is linearly extrapolated from `lat/lon/altMmsl` using
`groundSpeedMs` + `trackDeg`, anchored at `receivedAtMs` (the actual sample
time of the position, **not** "now" — this back-stamps ADS-B latency).
WGS84 → ECEF → ENU → Az/El, same 0.5 s grid over 900 s, **1801 Az/El points
per aircraft**.

**c) Pairwise separation scan**. For every (aircraft × body) pair the
angular separation is computed at every one of the 1801 sample indices and
the minimum is remembered. A candidate is emitted when:

* `min sep ≤ tracker.thresholdDeg` (default 0.3°) → `level = candidate`
* `min sep ≤ tracker.looseThresholdDeg` (default 2°) → `level = radio`
* otherwise the pair is dropped entirely (never reaches the panel).

**d) Sub-step refinement — the fine route vector** — `tracker.js →
parabolicVertex`. The grid step is 0.5 s, but a transit can land between
two samples. A parabola is fitted through the three separation values
`(i-1, i, i+1)` around the minimum; the analytic vertex gives a
fractional-step refinement of both the closest-approach **time** and the
**minimum separation**. Net effect: timing is accurate to a few tens of
milliseconds despite the coarser sampling grid — far cheaper than running
the grid at 0.05 s.

**e) FOV path sampling** — `tracker.js → sampleTransitPath`. For the
FOV-preview sketch the tracker emits 21 dense samples at
`[-5, -4.5, …, +5] s` around closest approach. Pre-v0.7.6 used 5 samples at
`±60 s` which, at typical airliner angular speeds, produced a misleading
V-line through the disc — see v0.7.6 release notes.

**f) Route lookup** — `adsbdb.js`. Each candidate's callsign is enriched
with `flight / origin / destination / airline` via adsbdb.com. Hits are
cached for 1 h, misses for 5 min, so a flight is queried at most once per
hour across the entire service lifetime.

**g) Lifecycle merge** — `lifecycle.js → updateLifecycle`. Three inputs are
folded into a single `Map<key, LifecycleEntry>`:

1. **Live tracker candidates** (highest signal — actual ADS-B geometry)
2. **Watchlist** (predictor.js, the *flight-schedule* source — see below)
3. **Previous tick's map** (so `stale` entries linger — coasting through
   brief ADS-B gaps — and the FIFO 10-cap / 30-min stale grace age out
   displaced rows in order of `lastUpdateMs`)

Per-row status is derived from `(level, time-to-closest, presence)`:

* `imminent` — `level=candidate` AND closest-approach within
  `±lifecycle.imminentWindowMs` (default 30 s)
* `candidate` — `level=candidate` outside the imminent window
* `radio` — `level=radio` (in the loose band, outside the tight band)
* `planned` — comes from the watchlist; no live ADS-B match yet
* `stale` — was active on a previous tick, no longer in tracker output;
  coasts on its last status for ~25 s, then held until the 30-min stale
  grace expires or the 10-row cap displaces it (oldest stale first)

**h) Notifier dispatch** — `notifier.js → tick`. For each candidate, the
next un-sent stage is evaluated. Stages escalate monotonically
`radio → candidate → imminent`. Pushover dispatch on `radio` carries an
**extra filter**: only fires when projected sep ≤ `pushover.radioThresholdDeg`
(default 1°). The panel-band knob (`tracker.looseThresholdDeg`, default 2°)
and the Pushover knob are independent — you can show 2° in the UI but only
buzz the phone at 1°. Per-`(icao, body, stage)` dedup; state is forgotten
5 min after closest approach. Every dispatched event writes one row to
`transit_history`.

### 3. Slower periodic processes

| Job | Cadence | Code |
|---|---|---|
| **Watchlist rebuild** (the "flight schedule" source) | **hourly** | `predictor.js → buildWatchlist` reading `transit_history` |
| **Lifecycle snapshot** → `data/lifecycle.json` | every **30 s** + on `SIGTERM` | `service.js → snapshotLifecycle` |
| **ISS transit + visible-pass recompute** | every **10 min** (`iss.recomputeMs`) | `iss.js` (SGP4 over `data/iss.tle`) |
| **Nightly auto-update** (`git pull` + restart) | once per night (03:30 ±15 min) | `stp-update.timer` → `scripts/auto-update.sh` |
| **Click-to-update** (version badge) | on demand | `stp-update.path` watches `data/update.request` → `stp-update.service` |
| **Daily ISS TLE refresh** | once per day (05:40 ±20 min) | `stp-tle.timer` → `scripts/refresh-tle.js` |
| **OpenSky schedule augmentation** (optional) | at watchlist-rebuild time | `opensky.js` + `scripts/refresh-schedule.js` |

### 4. The watchlist (flight-schedule source) in detail

There is no external schedule API. Instead `transit_history` itself is the
input:

1. The last `predictor.daysBack` days (default 14) of dispatched events are
   reduced to `{flight, body, timestampMs}` tuples.
2. Tuples are bucketed by `(flight, body, time-of-day)` at
   `predictor.bucketMinutes` granularity (default 60 min).
3. A bucket graduates to a watchlist entry once it has hit at least
   `predictor.minRepeats` distinct UTC days (default 2) — i.e. the pattern
   has repeated.
4. The median time-of-day inside each bucket becomes the predicted
   `expectedTimeOfDayMs`; the standard deviation across observations is
   surfaced as `stdevMs` (confidence marker — small spread = tight
   schedule, wide spread = ad-hoc).
5. `upcomingExpected()` filters the watchlist to "next occurrence inside
   `predictor.lookAheadMs`" (default 24 h). The lifecycle merge then
   promotes anything inside `±lifecycle.plannedWindowMs` (default 1 h) to a
   `planned` row in the tracking panel.

### 5. Persistence + outcome classification

| Artefact | Written when | Used for |
|---|---|---|
| `transit_history` (SQLite) | when a stage is first entered inside the panel band (v0.8.0: independent of the Pushover phone filter, so the `radio`-stage row is logged and `Lead` reflects the true advance warning) | History panel, watchlist source, episode classification |
| `lifecycle.json` (JSON) | every 30 s + on `SIGTERM` | Tracking panel survives restarts (entries coast through brief ADS-B gaps, v0.8.0) |
| `config/observer.json` + `service.json` | on Settings save | Hot-reload + survive restart |

**Episode classification** runs lazily on `/api/learning` and `/api/history`
reads — see `store.js → episodes()`. History rows that share
`(icao, body)` and whose `closest_at_ms` values fall within ±5 min are
grouped into one *episode*. The set of stages it contains determines the
outcome label:

* `radio` AND (`candidate` OR `imminent`) → **graduated** (early warning paid off)
* `radio` only → **faded** (false positive of the early stage)
* `candidate` OR `imminent` with no prior `radio` → **surprise** (we missed the build-up)

### 6. Frontend poll cadences

The HTTP API is stateless (the service is the source of truth), so the
browser is pure pull:

| Endpoint / job | Interval | Why |
|---|---|---|
| Wall-clock readout in the header | 1 s | self-corrects from `Date.now()` each tick |
| `GET /api/state` (Sky now, Tracking, FOV pane) | 2 s | matches the tick |
| `GET /api/history` (history rows + outcomes) | 15 s | history only grows on Pushover dispatch |
| `GET /api/learning` (stats cards) | 60 s | aggregates change at the rate of new episodes |

Closing the tab pauses nothing — the service keeps running and the next
load picks up wherever it left off, including the restored tracking list.

### 7. Design principles

* **Linear aircraft extrapolation** stays meter-accurate to ~60 s and is
  reasonable through ~10 min in stable cruise; well past 15 min the
  assumption breaks (turns, ATC vectoring, wind). `horizonS=900` (15 min)
  is the default — a compromise between catching a flight as it enters
  ADS-B range and the false-positive ("faded") rate; the upper clamp at
  1800 s exists so a typo in `service.json` can't blow up the per-tick
  CPU budget.
* **Un-refracted geometry on both sides**. The tracker compares Az/El of
  the aircraft (raw ECEF→ENU) against Az/El of the body (geometric, no
  refraction). Refraction is only applied at the "Sky now" display step so
  the user sees what they would actually observe through the eyepiece.
* **Parabolic-vertex refinement instead of a finer grid**. Halving `stepS`
  from 0.5 s to 0.05 s would cost ~5× more samples per tick; the vertex
  fit gets the same sub-tenth-of-a-second timing precision for a handful
  of multiplications.
* **Geoid offset for barometric altitudes only**. ADS-B `alt_geom` (GNSS)
  is already WGS84 ellipsoidal height; `alt_baro` (pressure altitude) is
  closer to MSL. The geoid undulation (≈46 m around Rheine) is only added
  to barometric sources, preventing a systematic 46 m / ~0.05° offset.
* **Service is single source of truth**. The browser UI is a viewer. Tab
  close, browser crash, or laptop sleep never miss a transit — the
  pipeline keeps running on the Pi and the next page load reflects the
  full server state.

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
| M11 | Lifecycle pipeline: planned → radio → candidate → imminent → stale, unified UI panel (look-ahead later raised to `horizonS=900` in M17) | done |
| M12 | FOV sketch popup: per-row preview of disc + aircraft + apparent transit line in the 500 mm / ASI174MM frame | done |
| M13 | In-browser Settings panel (Pushover, observer, optics) + cross-restart tracking-list persistence | done |
| M14 | Inline FOV preview pane (auto-tracks newest sep&lt;1° candidate, click-to-pin) + live header clock | done |
| M15 | Tighter 1°-only radio Pushovers + alert-learning stats (hit / surprise rate, per-row outcome tags) | done |
| M16 | Editable tracker panel band (default 2°), near-hit row highlight (sep&lt;0.5°), weekday+date in History, learning block moved under Sky now | done |
| M17 | 15-min look-ahead default + episode-consolidated History (one row per transit with Lead-time column) + planned suppression for live ADS-B callsigns | done |
| M18 (v0.8.0) | History logged at the panel band independent of the phone filter (true Lead time); lifecycle coasting through brief ADS-B gaps + 10-row panel / 30-min stale eviction; offline airframe spec block (ICAO type → real span/length, no network/photos) beside the FOV; session detection-funnel bar chart; "LIVE-TRACKING-SIGNALS" rename; green near-hit rows in History; column sub-labels | done |
| M19 (v0.8.1) | History pager (page 1 = today + yesterday, older in 50-row pages); detection-funnel `< 0.2°` bar; "Sun/Moon below observable limit" banner; History "Disc xing" column (approx full-disc crossing time from ω ≈ ground speed / slant range); running-version badge with safe click-to-update (trigger file + systemd `stp-update.path`) | done |
| M20 (v0.9.0) | ISS transit prediction — dependency-free embedded SGP4 (validated against the official 88888 verification vectors), offline TLE file with opt-in `refresh-tle.js` fetcher; ISS surfaced in LIVE-TRACKING-SIGNALS + History + FOV in front of Sun **and** Moon with a distinct cyan highlight + 🛰 / station glyph, reusing the Disc-xing column | done |
| M21 (v0.9.1) | History column reorder: Sun/Moon shown as a leading icon (Body text column dropped); geometry block `Sep · Dist · Disc xing · Speed · Alt` moved between Lead and Stage; Flight / ICAO / Route moved to the far right | done |
| M22 (v0.10.0) | ISS Pushover (heads-up the moment a Sun/Moon transit is predicted) + History rows via the shared notifier path; "next visible ISS pass" line in Sky-now (el > 20°, after dusk, station sunlit — offline cylindrical-shadow test); Alert-learning aggregates exclude ISS (kept in the History table); Tracking table reordered like History (leading Sun/Moon icon, Flight/ICAO/Route to the right); detection funnel gains a live "Live planes" bar and "detected" → "Total detected" | done |
| M23 (v0.10.1) | Click-to-update no longer fails silently: server self-diagnostic (`state.update`: pending → consumed → stuck), honest UI status line, `ok:false` surfaced; `auto-update.sh` warns when `stp-update.path` is missing; troubleshooting docs (the missing-watcher root cause on Pis upgraded from < v0.8.1) | done |
| M24 (v0.10.2) | Fixed badge stuck on "updating…" forever (a consumed-but-no-restart / no-op update never cleared, survived refresh): server auto-clears `consumed`→idle after 20 s and `stuck`→idle after 10 min (cleaning the stale trigger); frontend state machine always restores the version badge. Sky-now now shows the next visible ISS pass **and** the next Sun/Moon transit even weeks out (with date), via a 30-day visible-pass horizon (early-return, cheap) and a 14-day transit horizon | done |
| M25 (v0.10.3) | "No ISS info" out of the box fixed: `install-pi5.sh` now does an initial TLE fetch and installs a daily `stp-tle.timer` + `stp-tle.service` (the running service still never fetches — offline by default) so `data/iss.tle` exists and stays fresh automatically | done |
| M26 (v0.10.4) | ISS rows in Live-Tracking + History recoloured **blue** (was cyan) for an unambiguous identity, matched by the Sky-now ISS line; ISS rows show the 🛰 satellite symbol in the status cell instead of the ✈️ aircraft glyph so they can't be mistaken for traffic | done |
| M27 (v0.10.5) | `bootstrap-pi5.sh` bare-image one-liner (apt deps → clone → install-pi5.sh, args/env forwarded); fixed `install-pi5.sh` writing a stale `service.json` (it pinned old `horizonS:300` / `looseThresholdDeg:5` / `staleGraceMs:0` / `maxEntries:20` and omitted `iss`/`update`) — fresh installs now get the current defaults + explicit ISS config | done |
| M28 (v0.10.6) | Docs: validated **Raspberry Pi OS Lite (Legacy, 64-bit)** as the known-good image (exact Imager path; current/Bookworm caused dependency trouble) + a copy-paste, no-experiments **ADS-B receiver setup** for dump1090-fa with the AirNav FlightStick (FlightAware apt repo + DVB-T blacklist + verify); `--with-dump1090` aligned to the same reliable steps | done |
| M29 (v0.10.7) | Install fixes from on-Pi testing: manual path now installs `git` first (absent on Pi OS Lite); FlightAware repo package bumped `1.2 → 1.3` (the 1.2 URL 404s) in the README + `bootstrap-pi5.sh`, with a version-drift note | done |
| M30 (v0.10.8) | Docs: `rbfeeder`/AirNav-RadarBox sharing-key sidenote + MLAT explainer in the ADS-B section (independent of the predictor; same WGS84 location) | done |
| M31 (v0.10.9) | ISS transits only push/log within `iss.notifyWithinMs` (default 72 h) — far-future SGP4 is noise that flips with each daily TLE, so this kills phantom-transit Pushover spam + "surprise" stat pollution; Sky-now still previews the soonest, flagged "tentative". README "Good to know" facts: ISS prediction reliability + observer coordinate/elevation pitfalls | done |
| M43 (v0.14.4) | **Unified type size across the whole right-hand column** — every label in the FOV sketch and the plan-view mini-map now renders at one shared `LABEL_SIZE` (11 px; the FOV sketch title is the single deliberate `TITLE_SIZE` exception), and the AirNav box / hover-popover CSS is aligned to the same 11 px. Plan-view fix: the route/flight caption and the distance/bearing caption no longer share one baseline (they overlapped on longer strings) — the route line is now stacked one `LINE_H` above the distance line, separate baselines | done |
| M42 (v0.14.3) | **Range-stats card** at the very bottom (`GET /api/rangestats`, new `store.rangeStats()`): retrospective over *all* stored history — of the aircraft that **actually** passed within 0.5° (imminent-confirmed, not just predicted) it shows confirmed-pass count, median / closest / farthest / 90th-pct line-of-sight distance, an on-disc (&lt;0.27°) tally and a distance histogram (reuses the acstats bar markup). Plan-view mini-map gains a bottom-left **route + flight caption** (`<FLIGHT> ORIG→DEST`, charset-clamped since it comes from the free adsbdb/AirNav lookup); `acMeta*` carry `flight`/`origin`/`destination` through `renderFovMap` → `buildMiniMapSvg` | done |
| M41 (v0.14.2) | Free `GET /api/route` (adsbdb, no token/credits, cached) → flight-number / callsign **hover popover now works without AirNav** (airline + origin→destination). Aircraft-stats: ICAO labels → AirNav popover, callsign labels → route popover (both interactive). History/Tracking flight cells gain a `data-cs` free-route fallback. Fixed the header **dump1090 link** never pointing at the app's own port (coerced to :8080) | done |
| M40 (v0.14.1) | **History outcome sharpened** (display only — learning aggregates untouched): `confirmed` = reached the imminent ±30 s window (really happened); `predicted` = a tight candidate that never confirmed (flight diverged before the ETA — the "stale in Live yet graduated in History" case); `faded` = radio only. Headline sep now comes from the imminent row when present; a predicted-only sep is **struck through** + `sepConfirmed` flag. Stage + Outcome columns moved between Sep and Dist. Aircraft-stats → **TOP-20**; ICAO labels hover → AirNav popover | done |
| M39 (v0.14.0) | **Persistent aircraft-sightings stats** over *all* detected ADS-B traffic (new `aircraft_sightings` SQLite table; survives restarts). A "visit" = a fresh sighting after a ≥ 30-min gap (`sightings.gapMs`); per-tick DB writes throttled via a session map (visit hits SQLite immediately, continuous presence flushes `last_seen` every `flushMs`). `GET /api/acstats`; new "Aircraft stats" section with TOP-10 horizontal bars by airframe (ICAO hex) and by ADS-B callsign + unique/visit totals | done |
| M38 (v0.13.3) | Mini-map heading vector doubled in length + recoloured amber so it reads distinctly from the blue observer→aircraft sight line | done |
| M37 (v0.13.2) | Mini-map + AirNav merged into **one compact box** — LEFT = plan-view radii map (now titled "PLAN VIEW · rings = km from you" so its purpose is clear), RIGHT = photo over aircraft data; equal-height columns (right ends flush with the map), empty halves collapse. Roughly half the prior footprint so the FOV transit sketch stays the dominant element | done |
| M36 (v0.13.1) | AirNav FOV box laid out as **photo \| data side by side** (each ~half width, wraps to stacked only on a very narrow pane) — roughly half the previous height so the FOV sketch stays the dominant element | done |
| M35 (v0.13.0) | **AirNav On-Demand API v2 integration** (optional, opt-in token in Settings — masked, server-side only). New `src/airnav.js` client + `GET /api/acinfo` proxy (token never reaches the browser; aggressive per-hex session cache since calls are billed). On a row **click** the FOV box shows airframe (reg/type/operator/MSN/first-flight) + live route + a photo; **hovering a flight number** pops an ad-hoc photo+route card (450 ms dwell, shares the cache). Header gains an "AirNav ↗" stations link | done |
| M34 (v0.12.0) | Offline plan-view **mini-map** under the FOV (observer + aircraft real lat/lon + sight line + heading + range rings + bearing/distance) — pure SVG from our own ADS-B / recorded payload, no tiles/API/key; shown for the pinned/auto FOV entry, hidden for the ISS or when lat/lon is missing | done |
| M33 (v0.11.1) | FOV sketch **auto zoom-out**: when the closest approach falls outside the optical FOV (e.g. a pinned wide-sep row), the whole sketch — FOV box, disc, path — is shrunk to scale so the aircraft still fits, with a "⤢ zoomed out · aircraft X′ from disc" note, giving a true sense of how far off-frame it was | done |
| M32 (v0.11.0) | **Settings save bug fixed** — the look-ahead input's `step=30/min=10` made every round value (incl. the 900 default) a native `stepMismatch`, so browser form-validation silently blocked *all* saves (only 10 s was accepted). Form now `novalidate` (server validates with clear messages) + sane steps. Per-field subtitle hints under every Settings field (esp. Tracker). Pushover message reworded to lead with "&lt;Sun/Moon&gt; crosser — sep X° in Y, at &lt;target time&gt;" + flight | done |

## Hardware + software bill of materials

End-to-end the project needs the items below. The cheap-but-complete
ADS-B receiver is the RTL-SDR + 1090 MHz antenna pair; everything else
is the host computer it runs on.

### Required hardware

| Item | Notes |
|---|---|
| **Raspberry Pi 5** (4 GB or 8 GB) | The host. Earlier Pi models work too but the v0.7+ tracker tick + browser UI was profiled on the Pi 5. |
| **microSD card** (≥ 16 GB, A1/A2 endurance) | Boot media. SanDisk High Endurance / Samsung PRO Endurance recommended — the SQLite history and lifecycle snapshot write small batches continuously. |
| **USB-C power supply** (5 V / 5 A) | Official Raspberry Pi 5 PSU or equivalent. Skip if you go the PoE route below. |
| **RTL-SDR USB stick** (RTL2832U + R820T2 tuner) | The 1090 MHz ADS-B receiver. The **RTL-SDR Blog v3** is the de-facto standard — clean clock, metal case, bias-T for active antennas. Any clone works as long as it decodes 1090 MHz Mode S. |
| **1090 MHz ADS-B antenna** | A FlightAware 1090 MHz outdoor antenna or any λ/4 mag-mount tuned for 1090 MHz. Sky view = range. |
| **Coax + adapters** | SMA male ↔ whatever your antenna terminates in. Short and shielded — every dB lost on the cable is range lost. |
| **Network** | Ethernet *or* Wi-Fi to a router that can reach the Pi from your browser. The HTTP API is unauthenticated; keep the Pi on a trusted LAN or front it with a reverse proxy. |

### Optional / situational

| Item | When you want it |
|---|---|
| **Waveshare PoE HAT** (or equivalent IEEE 802.3af/at HAT) | If you want **PoE-only operation** — single Ethernet cable provides power *and* network, no USB-C PSU needed. Mounts on the Pi 5's 40-pin GPIO header. Verify the HAT's spec matches the Pi 5 power budget (≥ 5 V/5 A continuous including ADS-B-stick draw). |
| **Active LNA** (Uputronics / RTL-SDR Blog) at the antenna feedpoint | Pulls weaker / further aircraft out of the noise; powered via the RTL-SDR's bias-T. Only worth it if you're seeing < 200 km range. |
| **1090 MHz bandpass / SAW filter** | Cuts strong out-of-band signals (FM broadcast, cellular) that can desensitise the RTL. Often built into the LNAs above. |
| **Active cooling case** (Argon ONE V3, Pi 5 official cooler, etc.) | The Pi 5 throttles under sustained load; the tracker tick is light but if you co-host other services you'll want active cooling. |
| **External USB-C SSD** | Move `data/history.db` and `data/lifecycle.json` off the SD card by symlinking the `data/` directory. Massively extends SD-card life for multi-year deployments. |
| **Pushover account** ([pushover.net](https://pushover.net)) | Phone notifications for the three transit stages. The pipeline runs fine without it (`pushover.enabled=false`), but you'll only see transits in the web UI. |

### Required software (installed by `scripts/install-pi5.sh`)

| Item | What it does |
|---|---|
| **Raspberry Pi OS Lite, 64-bit — *Legacy* (Bullseye)** | **Use the Legacy image.** In Raspberry Pi Imager: *Choose OS → Raspberry Pi OS (other) → "Raspberry Pi OS Lite (Legacy, 64-bit)"*. This is the **known-good** image — the current (Bookworm) Lite image caused dependency/version trouble with the ADS-B + Node stack during bring-up. Set hostname, SSH key and Wi-Fi in the Imager's "Edit Settings" before flashing for a zero-touch first boot. |
| **`dump1090-fa`** (FlightAware) | The ADS-B decoder for the RTL-SDR / AirNav FlightStick — exposes `aircraft.json` on `http://localhost:8080/data/aircraft.json` (polled every 2 s). **Not** in the default repos; install per the copy-paste **[ADS-B receiver setup](#ads-b-receiver-setup-dump1090-fa--airnav-flightstick)** below (or `bootstrap-pi5.sh --with-dump1090`). |
| **Node.js 22+** | Runtime. Pulled from NodeSource by the installer if absent. Needs `--experimental-sqlite` on Node 22; stable on Node 24+. |
| **`git`** | Not on a fresh Pi OS Lite image — `sudo apt-get install -y git` first (the `bootstrap-pi5.sh` one-liner does this for you). |
| **This repo** (`sun-moon-transit-predictor`) | `git clone https://github.com/joergs-git/sun-moon-transit-predictor.git` — contains `bin/stp.js`, the systemd units in `systemd/`, the install + auto-update scripts in `scripts/`, the web UI in `web/`. |

### Optional external services

| Item | What you get |
|---|---|
| **adsbdb.com** (no account needed) | IATA flight numbers, origin / destination airports, airline names attached to every candidate. Used live for the tracking panel and Pushover payload, cached for 1 h per callsign. Skip with `routes.enabled=false`. |
| **OpenSky Network** account (free) | Optional schedule augmentation: backfills the predictor's watchlist with flights you may not have seen yourself yet. Configured via `scripts/refresh-schedule.js`. Off by default. |
| **AirNav On-Demand API v2** (paid, token) | Optional rich airframe + live route + **photo** for an aircraft. Paste the bearer token from `airnavradar.com/api/dashboard` into **⚙ Settings → AirNav Radar API** (stored masked in `service.json`, **server-side only** — the browser uses our `/api/acinfo` proxy). **Each upstream call is billed in credits**, so it is fetched **only** on an explicit row click (FOV box) or a flight-number hover, and cached per airframe for the session (static data 6 h, live 60 s). Off until a token is set. |

## ADS-B receiver setup (dump1090-fa + AirNav FlightStick)

The **AirNav RadarBox / AirNav ADS-B FlightStick** is a standard RTL-SDR
(RTL2832U + R820T2, built-in 1090 MHz SAW filter) — it needs **no special
driver**, just `dump1090-fa` from FlightAware's apt repo. Do this once,
before (or instead of via `--with-dump1090`) the app install. Plug the
FlightStick into a **USB-2** port (USB-3 ports are RF-noisy at 1090 MHz),
antenna attached, then:

```bash
# 1. FlightAware apt repo + the decoder (pulls in rtl-sdr automatically).
#    NOTE: the repo-package version (here 1.3) bumps occasionally — if this
#    404s, check the directory listing at
#    https://www.flightaware.com/adsb/piaware/files/packages/pool/piaware/f/flightaware-apt-repository/
#    or use the official installer: flightaware.com/adsb/piaware/install
sudo apt-get update
wget -O /tmp/fa-repo.deb \
  https://www.flightaware.com/adsb/piaware/files/packages/pool/piaware/f/flightaware-apt-repository/flightaware-apt-repository_1.3_all.deb
sudo dpkg -i /tmp/fa-repo.deb && rm /tmp/fa-repo.deb
sudo apt-get update
sudo apt-get install -y dump1090-fa

# 2. Stop the DVB-T kernel driver grabbing the stick (idempotent; harmless
#    if dump1090-fa already did it). Then reboot so it takes effect.
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf
sudo reboot
```

After the reboot it runs as a systemd service (`dump1090-fa`) on port
**8080**. Verify — **do not start the app until this returns aircraft**
(needs sky view + planes overhead):

```bash
systemctl status dump1090-fa --no-pager
curl -s localhost:8080/data/aircraft.json | head -c 300   # JSON with "aircraft":[…]
# or open  http://<pi-ip>:8080/  (SkyAware map) in a browser
```

**Gain:** leave the dump1090-fa default — the FlightStick's built-in
filter makes AGC work well out of the box. Only if range is poor, tune
`--gain` in `/etc/default/dump1090-fa` then
`sudo systemctl restart dump1090-fa` (no other experiments needed). The
app's `adsb.url` default (`http://localhost:8080/data/aircraft.json`)
already matches this — nothing to configure on the app side.

> **Sidenote — sharing to AirNav RadarBox (`rbfeeder`).** Optional and
> fully independent of this predictor. `rbfeeder` + your AirNav sharing
> key runs alongside `dump1090-fa` (reads the same decoder) and uploads to
> airnavradar.com; this app only ever needs the local `aircraft.json` on
> :8080, so the two don't interfere. **MLAT active** = the feeder's
> *multilateration* client is up: for Mode-S aircraft that do **not**
> broadcast their own GPS position, several internet-connected stations
> jointly compute the position from the signal's time-difference-of-arrival.
> It needs a **precise station location** — use the **same WGS84 decimal
> degrees** you put in `config/observer.json` so the feed and the
> predictor agree.

## Quick install on the Pi 5

Recommended OS image: **Raspberry Pi OS Lite (Legacy, 64-bit)** — see the
[Required software](#required-software-installed-by-scriptsinstall-pi5sh)
note above; the Legacy image is the validated one. Set hostname, SSH key
and Wi-Fi in the Imager's "Edit Settings" before flashing.

### From a blank image (one-liner bootstrap)

On a fresh OS with nothing installed yet, `scripts/bootstrap-pi5.sh`
installs the apt prerequisites (`git`, `curl`, `ca-certificates`), clones
the repo, and hands off to `install-pi5.sh` (forwarding all flags + `STP_*`
env vars). Review it first — piping a remote script to a shell runs code
as you:

```bash
curl -fsSL https://raw.githubusercontent.com/joergs-git/sun-moon-transit-predictor/main/scripts/bootstrap-pi5.sh | bash
# zero-touch:
curl -fsSL .../scripts/bootstrap-pi5.sh | STP_LAT=52.28 STP_LON=7.44 STP_ELEV=50 bash -s -- --non-interactive
```

It does **not** set up `dump1090-fa` + the RTL-SDR — that is the ADS-B
**data source** (hardware: SDR dongle, antenna; software from the
FlightAware apt repo). Pass `--with-dump1090` for a best-effort apt
attempt, otherwise install it per `flightaware.com/adsb/piaware/install`.
Without an ADS-B feed the predictor has no aircraft to track.

### Manual install (no bootstrap)

Raspberry Pi OS Lite has **no `git`** out of the box — install it first
(the bootstrap one-liner above does this for you):

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/joergs-git/sun-moon-transit-predictor.git
cd sun-moon-transit-predictor
bash scripts/install-pi5.sh
```

`install-pi5.sh` (idempotent — safe to re-run after every `git pull`):

1. installs Node.js 22 from NodeSource if it isn't already present,
2. runs `npm install --omit=dev`,
3. prompts for observer coordinates + Pushover credentials and writes
   `config/observer.json` + `config/service.json` with the **current
   defaults** (both **gitignored** so `git pull` / the auto-updater can
   never overwrite them),
4. installs and starts the `stp.service` systemd unit (light sandboxing —
   `ProtectSystem=strict`, `ReadWritePaths=…/data`),
5. unless `--no-auto-update`: installs `stp-update.timer` (nightly) +
   `stp-update.path` (version-badge click-to-update) + the narrow sudoers
   rule,
6. **always** installs `stp-tle.timer` (daily ISS TLE refresh) and does one
   initial TLE fetch, so the ISS feature is active out of the box.

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

### Click-to-update from the web UI (v0.8.1)

The small version badge next to the page title is clickable. Clicking it
(after a confirm dialog) makes the service **pull `origin/main` and restart**
— no SSH needed.

Security model — the unauthenticated LAN UI never gets a shell:

* `POST /api/update` only **drops a trigger file** (`data/update.request`);
  it runs no `git`/`systemctl`. A confirmed JSON body is required, which
  also blocks naive cross-site drive-by triggering (the request needs a
  CORS preflight this server does not answer).
* A privileged **`stp-update.path`** systemd unit watches that file and
  fires the same `stp-update.service` the nightly timer uses. The updater
  deletes the trigger on start, so a single click can't loop it.
* `update.debounceMs` (default 30 s) swallows double-clicks / two clients.
* Take it out entirely with `"update": { "enabled": false }` in
  `config/service.json`, or `sudo systemctl disable --now stp-update.path`.

```bash
# is the click-to-update watcher active?
systemctl status stp-update.path --no-pager
```

#### Troubleshooting: "I click the version, confirm, but nothing updates"

The endpoint only **drops a trigger file** — the actual `git pull` +
restart is done by the privileged `stp-update.path` → `stp-update.service`
units. Nothing happens if that watcher isn't running:

* **It's a no-op on non-systemd hosts** (e.g. a macOS dev box). Click-to-
  update is a Pi/Linux feature; test it on the Pi, not the laptop.
* **`stp-update.path` not installed/enabled on the Pi.** The unit was added
  in v0.8.1. `auto-update.sh` (nightly / code update) does **not** install
  systemd units, so a Pi set up before v0.8.1 and only code-updated never
  got it. One-time fix on the Pi:

  ```bash
  cd ~/sun-moon-transit-predictor
  bash scripts/install-pi5.sh           # idempotent; installs + enables stp-update.path
  systemctl is-active stp-update.path   # → active
  ```

Since v0.10.1 the UI no longer fails silently: after you confirm, the line
under the title reports **requested → consumed (restarting…)**, or, if no
watcher consumes the trigger within ~12 s, **"stuck — stp-update.path not
installed/enabled (run scripts/install-pi5.sh)"**. The nightly updater also
logs this warning to `journalctl -u stp-update.service`.

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

## ISS transits (v0.9.0)

The International Space Station is predicted alongside aircraft and shown in
**LIVE-TRACKING-SIGNALS**, **History** and the **FOV preview**, in front of
both the Sun and the Moon, with its own cyan highlight + 🛰 badge (and a
small station glyph instead of an aircraft silhouette in the sketch).

* **Offline, dependency-free.** Position comes from an embedded **SGP4**
  propagator (`src/sgp4.js`, validated against the official Spacetrack
  #3 / Vallado *88888* verification vectors) applied to a local TLE file —
  the running service never touches the network for this.
* **The TLE.** The feature stays inactive ("no ISS info" in Sky-now) until
  `data/iss.tle` exists. Since v0.10.3 `scripts/install-pi5.sh` does an
  initial fetch **and** installs a daily **`stp-tle.timer`** (05:40 ± 20 min,
  Persistent) — so on a normal Pi install ISS info just appears and stays
  fresh. Re-run `install-pi5.sh` once if you upgraded from < v0.10.3.

  ```bash
  # see / force a refresh:
  systemctl list-timers | grep stp-tle
  node scripts/refresh-tle.js          # → data/iss.tle (Celestrak, CATNR 25544)
  systemctl start stp-tle.service      # same, via the timer's unit
  ```
  An ISS TLE older than ~3 days noticeably degrades transit timing; the
  daily timer keeps it current. No network at install time? The timer
  retries — or run the command above once you're online.

* **Tuning** (`config/service.json → iss`): `horizonMs` (how far ahead to
  scan for the next Sun/Moon transit, default **14 days** — these are weeks
  apart at a fixed site; raising it costs more CPU per recompute since the
  scan is O(horizon)), `visibleHorizonMs` (next-visible-pass cap, default
  **30 days**; cheap — the scan returns at the first pass found),
  `recomputeMs` (scan cadence, default 10 min), `thresholdDeg` /
  `looseThresholdDeg`. Set `"enabled": false` to switch it off entirely.
* An ISS transit is written to History like any transit and feeds the
  **Disc xing** column (its angular rate is huge, so the full-disc crossing
  time is well under a second).
* **Pushover (v0.10.0).** ISS transits ride the same notifier path as
  aircraft, so you get a heads-up the moment a Sun/Moon transit is
  predicted (and again ±30 s before). Titles read `🛰 ISS Sun transit
  predicted …`. Disable per the usual `pushover` settings if unwanted.
* **Next visible pass (v0.10.0).** The Sky-now panel shows the next
  naked-eye ISS pass for the site — station above 20°, sky dark (Sun below
  −6°, "after dusk") and the ISS sunlit (offline cylindrical Earth-shadow
  test). It is a *visibility* line, independent of any disc transit.
* **Alert-learning** hit/surprise/graze rates are an ADS-B-traffic quality
  signal and therefore *exclude* ISS rows (a deliberately-hunted orbital
  event would otherwise skew them); the ISS still appears in the History
  table itself.

### Good to know — ISS transit prediction is only reliable a few days out

SGP4 propagated from a TLE drifts roughly **1–3 km/day cross-track** (more
after a reboost). The ISS transit *centre line* is only a few km wide and
the Sun/Moon disc is 0.5°, so a transit predicted **> ~3 days** ahead is
essentially noise: it appears, then **vanishes after the next daily TLE
refresh** (and a different phantom may appear). This is physics, not a bug.

Consequences in this tool (v0.10.9+):

* A transit only fires **Pushover** and gets a **History** row once it is
  within `iss.notifyWithinMs` (default **3 days / 72 h**) — close enough
  that SGP4+TLE is trustworthy. This stops phantom-transit alert spam and
  the "⚡ surprise" pollution it caused in the learning stats.
* The Sky-now **"Next ISS Sun/Moon transit"** line still *previews* the
  soonest predicted transit even weeks out, but anything beyond the notify
  window is shown **flagged "tentative — refines with each daily TLE"**.
  So Sky-now saying "none in the next N days" while an old, now-stale row
  sits in History is expected — they reflect *different TLEs* at different
  times, each correct for its own.
* **Visible passes** (the other Sky-now line) are unaffected — they recur
  ~daily and the *next* one is near, so it stays accurate.
* Want it sooner/later anyway? Tune `iss.notifyWithinMs` in
  `config/service.json`. Reliable horizon for sub-disc accuracy is roughly
  **≤ 48–72 h**; keep the TLE fresh (the daily `stp-tle.timer`).

### Good to know — observer coordinates & elevation

* `latitudeDeg` / `longitudeDeg` are **decimal degrees, WGS84** (e.g.
  `52.2870`, `7.4223`). There is **no aviation-vs-astronomy datum
  difference** — ADS-B, AirNav and this tool all use WGS84. The same point
  just has several notations; mixing them up is the usual confusion:
  * `52°17'13.7"N` = degrees-minutes-**seconds** → `52 + 17/60 + 13.7/3600`
    = **52.2871°** decimal.
  * `52.1714` is **not** decimal degrees — it is the packed
    aviation/NMEA "degrees + decimal-minutes" form (`52°17.14'`) ≈
    **52.2857°**. Putting that into `latitudeDeg` lands you ~13 km off.
  Use the **decimal** form (your phone GPS / Google-Maps right-click at the
  antenna gives it directly), and use the **same** value for the rbfeeder
  /AirNav station so the feed and the predictor agree.
* `elevationM` is the **WGS84 ellipsoidal height of your site** — in
  practice your local **height above sea level is fine** (the geometry is
  robust to a few tens of metres of observer height). It is **not** "height
  above ground" and **not** the antenna's height over the roof — just the
  site elevation (Rheine ≈ 40–50 m), never `0`.
* `geoidUndulationM` is a *separate* field: EGM2008 N at the site (Rheine
  ≈ **+46 m**). It only corrects aircraft *barometric* altitude (≈ MSL) to
  ellipsoidal before the geometric comparison — it is **not** applied to
  your own elevation. Set it (~46 for Rheine) for the best aircraft-
  altitude accuracy; `0` is tolerable.

## Where files live

| Path | Purpose | Tracked in git? |
|---|---|---|
| `<repo>/config/observer.json`         | Observer location (lat / lon / elevation, geoid undulation). **Personal.** | no — gitignored |
| `<repo>/config/observer.example.json` | Schema reference / template for `observer.json`.            | yes |
| `<repo>/config/service.json`          | Runtime config (ADS-B URL, intervals, Pushover keys, server, DB, routes). **Personal.** | no — gitignored |
| `<repo>/config/service.example.json`  | Schema reference / template for `service.json`.             | yes |
| `<repo>/data/history.db`              | SQLite history of all recorded transit-stage events (created on first run). | no — gitignored |
| `<repo>/data/lifecycle.json`          | Tracking-panel snapshot so a restart doesn't empty the list. | no — gitignored |
| `<repo>/data/iss.tle`                 | ISS two-line elements for the offline SGP4 (written by `refresh-tle.js`). Feature inactive until present. | no — gitignored |
| `<repo>/data/update.request`          | Transient click-to-update trigger; consumed by `stp-update.path`. | no — gitignored |
| `<repo>/web/`                         | Static frontend served at `http://<host>:<port>/`.          | yes |
| `<repo>/bin/stp.js`                   | Service entry point.                                        | yes |
| `<repo>/scripts/install-pi5.sh`       | Idempotent Pi installer (interactive or `--non-interactive`). | yes |
| `<repo>/scripts/auto-update.sh`       | Pull + install-deps + restart-on-change. Backs up local config first. | yes |
| `<repo>/scripts/refresh-tle.js`       | Opt-in ISS TLE fetcher (Celestrak); run by `stp-tle.timer`. | yes |
| `<repo>/scripts/test-push.js`         | One-shot Pushover sanity check.                             | yes |
| `<repo>/systemd/stp.service`          | Template for the main systemd unit.                         | yes |
| `<repo>/systemd/stp-update.{service,timer,path}` | Auto-update + click-to-update watcher templates.  | yes |
| `<repo>/systemd/stp-tle.{service,timer}` | Daily ISS TLE refresh templates.                         | yes |
| `/etc/systemd/system/stp.service`     | Generated unit (paths and user templated by the installer). | n/a (system) |
| `/etc/systemd/system/stp-update.{service,timer,path}` | Generated auto-update + click-watcher units.  | n/a (system) |
| `/etc/systemd/system/stp-tle.{service,timer}` | Generated ISS-TLE refresh unit + timer.              | n/a (system) |
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
| `GET /api/state`           | Current observer, Sun/Moon Az/El + observability, aircraft count, `lifecycle[]` (unified per-`(icao, body)` tracking list with status enum, M11 — primary feed for the new UI), plus `candidates[]` (live tracker output, backward compat), `expected[]` (history-based 24 h watchlist, backward compat), `optics` (current FOV setup) and `externalLinks`. Refreshed every poll. |
| `GET /api/history?limit=…` | Past notifications (radio / candidate / imminent stages) from SQLite, newest first. Default 100, max 500. Each row now also carries `outcome` (`graduated` / `faded` / `surprise` / `null`) computed across the episode it belongs to — see *Alert learning* below. |
| `GET /api/config`          | Sanitised view of the runtime config used by the Settings panel: observer, masked Pushover credentials, optics, external links. Pushover token + user key come back as `••••<last4>` so the page never echoes the secret in plaintext. |
| `POST /api/config`         | Apply a partial config update (`{ observer, pushover, optics, externalLinks }`). Hot-reloads the running service in place and persists changes back to `config/observer.json` + `config/service.json`. Masked secret placeholders (`••••…`) are ignored so a no-op resave never overwrites the real token. |
| `GET /api/learning?windowDays=…` | Rolling alert-effectiveness stats over the requested window (default 14 days, capped at 90). Returns aggregates (`radioFired`, `radioGraduated`, `surprises`, `hitRatePct`, `surpriseRatePct`, …) plus the last 20 classified episodes. |
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
| **radio** 📡 | tracker projects `[thresholdDeg, looseThresholdDeg]` separation (default 0.3°–2°) within `horizonS` (default 15 min) | 0 | up to ~15 min |
| **candidate** ✈️ | tracker projects `≤ thresholdDeg` separation (default 0.3°) within `horizonS`, more than `imminentWindowMs` away | 0 | 30 s – ~15 min |
| **imminent** 🎯 | closest approach within ±`imminentWindowMs` (default ±30 s) | 1 | ≤ 30 s |
| **stale** ❌ | was tracked last tick, gone from the tracker output now — first **coasts** on its last status for ~25 s (brief ADS-B gap), then held as `stale` until the **30-min** grace (`lifecycle.staleGraceMs = 1800000`) expires or the panel cap displaces it | none (UI only) | — |

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
- **Coasting.** A single missed ADS-B squitter no longer flips a contact
  to `stale`: it holds its last live status for `lifecycle.coastMs`
  (default 25 s) before decaying, so a flight doesn't visibly drop and
  reappear near the horizon.
- **Panel cap & stale grace.** The tracking list is capped at
  `lifecycle.maxEntries` (default **10**). A `stale` entry is dropped once
  it is older than `lifecycle.staleGraceMs` (default **1 800 000 ms =
  30 min**) or, on a busy minute, when the cap displaces it (oldest stale
  first, FIFO by `lastUpdateMs`; active rows are always kept). Set
  `staleGraceMs: 0` to revert to the old cap-only eviction (stale entries
  persist until pushed off the bottom).

Each notification carries: callsign, IATA flight number (if adsbdb resolves
it), airline, origin/destination, altitude (ft), ground speed (kt), minimum
separation, transit duration, ETA. Same payload is recorded in the SQLite
history table.

### Tuning the live look-ahead

`tracker.horizonS` (default 900 s = 15 min) is the window the live tracker
linearly extrapolates each aircraft over. Bigger window = earlier warning,
but linear extrapolation degrades past ~10 min (turns, ATC vectoring,
wind), so the longer horizon trades more "faded" false-positives for
catching a flight as it enters ADS-B range. Clamped to `[10, 1800]` in
code. Typical settings:

| Use case | `horizonS` | What you get |
|---|---|---|
| Maximum precision | 60 | First-detection at ~T-60 s; lowest false-positive rate. |
| Conservative | 300 | First-detection at ~T-5 min; few false-positives. |
| **Default** | **900** | First-detection at ~T-15 min; catches flights as they enter reception range, at the cost of more "faded" episodes. |
| Wide net | 1800 | First-detection at ~T-30 min (upper clamp); maximum lead, most noise. |

`tracker.looseThresholdDeg` (default **2°** since v0.7.4; was 5° in
v0.1–v0.7.3) is the **radio band** width — anything wider is dropped from
the tracking panel entirely. Editable in the Settings UI under the
**Tracker** fieldset. Set to the same value as `thresholdDeg` to disable
the radio stage and fall back to the old two-stage flow. The Pushover
phone-buzz threshold (`pushover.radioThresholdDeg`, default 1°) is a
separate, tighter filter on top of this.

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
  "enabled": true,
  "minStage": "radio",
  "radioThresholdDeg": 1.0
}
```

`device` is optional — leave empty to fan out to every device on the
account. `minStage` controls which stages dispatch at all
(`radio` = all, `imminent` = only the ±30 s alert). `radioThresholdDeg`
adds a tighter Pushover-only filter on top: the tracker still surfaces
matches inside `tracker.looseThresholdDeg` (2° by default) to the
tracking panel, but the phone only buzzes when the projected minimum
separation is at or below this value (default **1°** — i.e. only
flights likely to actually graze the body). Restart the service
(`sudo systemctl restart stp.service`) after editing, or use the
**Settings** panel in the web UI for hot-reload.

### Alert learning

The UI surfaces a rolling 14-day stats panel showing how well the
early-warning radio stage predicts the tight transits that actually
matter. Each history row gets one of three outcome tags:

- **graduated** — radio alert paid off: the flight later reached
  candidate or imminent.
- **faded** — radio alert never tightened up: false positive of the
  early stage.
- **surprise** — candidate or imminent fired with *no* prior radio
  warning. Useful to spot under-detected geometries.

Headline numbers in the panel:

- **hit rate** = `radioGraduated / radioFired` — how often a radio
  alert was worth paying attention to.
- **surprise rate** = `surprises / (graduated + surprises)` — how
  often we missed an early heads-up for a transit that actually
  fired.

Same data is available raw via `GET /api/learning?windowDays=…`.

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

### FOV preview pane (v0.7.1+)

Top right of the page, beside **Sky now**, sits a permanent FOV
preview pane (originally a click-to-open modal, v0.6.0). It auto-shows
the most recently spotted live candidate whose minimum angular
separation is under **1°** — i.e. visually close enough to actually
intersect or graze the body — and refreshes on every 2 s state poll.
Clicking a row in **Tracking** or **History** pins that entry into the
pane (an orange bar marks the pinned row); the pin is released as soon
as a newer qualifying live candidate (sep < 1°) arrives. Press
**Escape** at any time to drop the pin and resume auto-tracking.

The sketch itself shows:

- **FOV rectangle** sized to the optical setup configured in
  **Settings** (default 500 mm + ZWO ASI174MM → FOV ≈ 1.30° × 0.82°);
  changes take effect on the next poll, no reload needed.
- **Sun / Moon disc** centred at the body's apparent diameter
  (Sun 0.53°, Moon 0.52°).
- **Aircraft silhouette** scaled by line-of-sight distance using a
  generic ~36 m airliner footprint — at 10 km this works out to
  ~0.2°, roughly a third of the Sun's diameter.
- **Apparent transit line** (dashed) connecting five samples of the
  aircraft–body relative position at ±60, ±30 and 0 s around closest
  approach, with an arrowhead in the direction of motion. Body drift
  is subtracted per sample, so the line shows the path as seen through
  a tracking mount keeping the disc centred.

The sketch is built client-side from a small `transitPath` array that
the tracker attaches to every `TransitCandidate`. History rows written
before v0.6.0 can still be pinned, but without the motion line (the
disc + aircraft anchor point are derived from the existing
`payload_json`).

### Settings panel (v0.7.0+)

The header now exposes a `⚙ Settings` button that opens an in-browser
form for the three configuration areas you actually touch in the field:

- **Observer** — name, latitude, longitude, elevation, plus optional
  temperature and pressure for the refraction model.
- **Pushover** — app token, user key, device, master enable + minimum
  stage. Token and user key are stored on the Pi but **never echoed
  back in plaintext** — `GET /api/config` returns them as
  `••••<last4>` so a page reload (or a forgotten browser tab) cannot
  leak the secret. Leaving the masked value untouched on save keeps
  the existing credentials.
- **Telescope & sensor** — focal length, sensor width/height in mm,
  pixel count, and a free-text sensor name. The FOV preview pane picks
  the new optics up on the next state poll, no reload needed.
- **External links** — optional override for the dump1090 status-page
  URL surfaced in the header (defaults to
  `http://<this-host>:8080/`).

Saved changes hot-reload the running service in place and are written
back to `config/observer.json` + `config/service.json` so the next
restart (including the nightly auto-update timer) keeps the new
values.

> **Upgrading from a pre-v0.7.0 install:** older `stp.service` units
> only listed `data/` under `ReadWritePaths`, so saving from the
> Settings panel fails with `EROFS: read-only file system`. Refresh
> the systemd unit on the Pi with one of:
>
> ```bash
> # Option A — re-run the installer (preserves existing configs):
> bash scripts/install-pi5.sh --non-interactive
>
> # Option B — drop-in override, no reinstall needed:
> sudo systemctl edit stp.service        # opens an empty override
> # Paste these three lines, save and exit:
> #   [Service]
> #   ReadWritePaths=
> #   ReadWritePaths=/home/<user>/sun-moon-transit-predictor/data \
> #                  /home/<user>/sun-moon-transit-predictor/config
> sudo systemctl daemon-reload
> sudo systemctl restart stp.service
> ```
>
> Hot-reload of the in-memory state still works even when the disk
> write fails — the Settings panel just shows the actionable hint as a
> warning so you see exactly what to fix.

### Tracking-list persistence across restarts (v0.7.0+)

The unified tracking panel is snapshotted to `data/lifecycle.json`
every 30 s and on `SIGTERM`. On startup the file is read back so the
panel does not appear empty after the auto-update timer restarts the
service overnight. Entries whose predicted closest-approach time is
already more than 10 minutes in the past are dropped on load to keep
the panel meaningful; restored live entries are marked `stale` until
the next tick reaffirms them.

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
│   ├── notifier.js               3-stage dispatch (radio/candidate/imminent) + dedup
│   ├── adsbdb.js                 callsign → route, in-memory TTL cache
│   ├── airnav.js                 AirNav On-Demand API v2 client (server-side, cached)
│   ├── sgp4.js                   dependency-free SGP4 (ISS), TLE parse, TEME→ECEF
│   ├── iss.js                    offline ISS transit + visible-pass prediction
│   ├── store.js                  SQLite history (node:sqlite) + episode stats
│   ├── server.js                 HTTP server (built-in, no framework)
│   ├── service.js                orchestrator (the polling loop)
│   ├── predictor.js              history-based 24 h watchlist (M10)
│   ├── opensky.js                OpenSky Network REST client (M10, opt-in)
│   ├── lifecycle.js              candidate state machine: planned→radio→candidate→imminent→stale (+coasting)
│   ├── config.js                 loadObserver()
│   └── index.js                  public re-exports
├── web/
│   ├── index.html                Sky-now + LIVE-TRACKING-SIGNALS + History + FOV UI
│   ├── app.js                    vanilla-JS poller
│   ├── sketch.js                 FOV transit sketch (SVG, incl. ISS glyph)
│   ├── aircraft-types.js         offline ICAO-type → specs table
│   └── style.css                 dark theme
├── scripts/
│   ├── bootstrap-pi5.sh          bare-image one-liner: apt deps + clone + install-pi5.sh
│   ├── install-pi5.sh            idempotent installer (interactive or --non-interactive)
│   ├── auto-update.sh            git pull → npm install → restart, with config backup
│   ├── refresh-schedule.js       OpenSky daily fetcher (M10, opt-in)
│   ├── refresh-tle.js            ISS TLE fetcher (Celestrak, opt-in / stp-tle.timer)
│   └── test-push.js              one-shot Pushover sanity check
├── systemd/
│   ├── stp.service               main service unit template
│   ├── stp-update.service        auto-update oneshot template
│   ├── stp-update.timer          nightly schedule (03:30 ±15 min)
│   ├── stp-update.path           click-to-update trigger watcher
│   ├── stp-tle.service           ISS TLE refresh oneshot template
│   └── stp-tle.timer             daily ISS TLE schedule (05:40 ±20 min)
└── test/                         16 vitest files, 154 cases
```

## License

TBD.
