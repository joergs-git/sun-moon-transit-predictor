# Tracking UX overhaul — v0.8.0

Branch: `feature/tracking-ux-v0.8.0`

Decisions (from user, 2026-05-17):
- E: offline aircraft type specs, no photo
- F: stats/counter only, panel stays filtered at 2°
- H: decouple history recording from the Pushover phone filter
- A+B: coasting on brief ADS-B gaps + maxEntries=10 + staleGraceMs=30 min

## Plan

- [x] A+B — lifecycle coasting: keep prior active status for `coastMs` (25 s)
      on a missed tracker tick before downgrading to `stale`. Config:
      `maxEntries=10`, `staleGraceMs=1_800_000`, new `coastMs=25_000`.
- [x] H — notifier: record every stage to history at the full panel band,
      independent of `radioThresholdDeg` / `minStage` (phone send unchanged).
- [x] E — adsb.js: capture `t` (type), `r` (registration), `desc`, `category`.
- [x] E — new `web/aircraft-types.js`: static ICAO-type → specs table +
      resolver (manufacturer, model, length, wingspan, MTOW, seats, era).
- [x] E — app.js/index.html/style.css: aircraft spec block beside FOV pane;
      real wingspan/length fed into the sketch silhouette + type in header.
- [x] F — service.js: session detection funnel (total / in-band / <0.5°)
      in `/api/state`; 3-bar CSS chart under Alert learning.
- [x] C — rename the "Tracking" heading to "LIVE-TRACKING-SIGNALS".
- [x] D — History near-hit rows highlighted green (was magenta); Tracking unchanged.
- [x] I — clarifying sub-labels under Tracking + History column headers.
- [x] Tests: lifecycle/notifier/adsb updated; aircraft-types test added; 116 pass.
- [x] Version bump 0.8.0; README pipeline + milestone refresh.

## Results

All 116 tests pass (13 files; +16 new: 4 coasting, 2 H-record, 2 adsb
enrichment, 8 aircraft-types).

Key behaviour changes:
- **H**: `transit_history` is now written when a stage is *first entered*
  inside the panel band, decoupled from the Pushover phone gate. The early
  `radio` row survives, so `Lead` (Transit − Recorded) shows the real
  advance warning (minutes / up to the 15-min horizon) instead of ~30 s.
  Side effect: more history rows (radio+candidate+imminent per in-band
  pass); episode consolidation already collapses these into one UI row.
- **A+B**: a brief ADS-B dropout no longer flips a contact to `stale` — it
  coasts on its last live status for 25 s, then goes stale; stale rows
  auto-vanish 30 min after the last real contact; panel cap 20 → 10.
- **E**: offline only — no network, no photos. Unknown ICAO type codes or
  feeds without aircraft-DB enrichment degrade to the generic silhouette
  and the panel hides itself.

Open follow-ups: none required. Detection-funnel counts are
session-cumulative (reset on restart) by design — labelled "since start".

---

# v0.8.1 — History paging + funnel + banner + disc-xing + version badge

Branch: `feature/history-paging-funnel-v0.8.1`

- [x] #1 History pager: page 1 = today + yesterday, older in 50-row pages
      (client-side over a 500-row fetch; pin indices stay absolute).
- [x] #3 Detection-funnel `< 0.2°` bar (service.js veryNear + UI bar).
- [x] A  "Sun/Moon below observable limit" banner in the tracking panel
      when no body is observable (vs. plain "empty" when bodies are up).
- [x] Disc-crossing column in History — approx ω = ground speed / slant
      range → full-disc time; sensor mm/s @ focal length in the tooltip.
- [x] Running-version badge next to the title (server-supplied from
      package.json via /api/state).
- [x] Click-to-update: POST /api/update drops a trigger file only; new
      systemd `stp-update.path` runs the privileged updater; auto-update.sh
      consumes the trigger; install-pi5.sh installs+enables the unit;
      confirm-required + debounced. Security model documented in README.
- [x] Version 0.8.1; README milestone M19 + Updating section. Tests: 120 pass.

Status: complete, awaiting commit/push/merge confirmation.

---

# NEXT — ISS transit prediction (decided: embedded SGP4 + TLE, offline)

Own branch/effort. Scope:
- New `src/iss.js`: dependency-free SGP4 propagator + topocentric Az/El
  reduction for the observer; forward scan over the next N hours with
  fine stepping near Sun/Moon conjunction (transit lasts ~0.5–1.3 s).
- TLE refresh: opt-in script (Celestrak), file on disk — mirrors the
  existing optional OpenSky pattern; runtime stays offline.
- Feed the lifecycle as a distinct source (own status/colour), in front
  of BOTH Sun and Moon; surface in LIVE-TRACKING-SIGNALS + History + FOV.
- Reuse the disc-crossing column (already generic on ω).

# DONE — click-to-update (folded into v0.8.1)

Implemented with the user-chosen safe approach: trigger file + systemd
`stp-update.path`. HTTP layer never runs git/systemctl.
