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

# DONE — v0.9.0 ISS transit prediction (branch feature/iss-sgp4)

- [x] `src/sgp4.js`: dependency-free near-Earth SGP4 + TLE parse + GMST +
      TEME→ECEF. Validated to <100 m against the official 88888 vectors
      (test/sgp4.test.js). Fixed two transcription bugs found via the
      verification vector (Kozai-recovery factor-2, aycof coefficient).
- [x] `src/geometry.js`: `targetEcefAzEl()` — topocentric Az/El from a
      known ECEF (satellite), reusing the existing ENU reduction.
- [x] `src/iss.js`: load TLE (2-/3-line), coarse scan + golden-section
      refine vs Sun/Moon, tracker-shaped candidates (+isISS), synthetic
      groundSpeed so the Disc-xing column reproduces the true ω.
- [x] `service.js`: config.iss, slow recompute + TLE reload, merged into
      the lifecycle (NOT the notifier), one History row per real transit.
- [x] UI: cyan row highlight + 🛰 in LIVE-TRACKING-SIGNALS & History;
      station glyph in the FOV sketch. lifecycle carries `isISS`.
- [x] `scripts/refresh-tle.js` opt-in Celestrak fetcher; config example;
      README M20 + ISS section. Version 0.9.0. Tests: 131 pass (+11).

Status: merged to main (v0.9.0, cbb5a6c).

---

# v0.9.1 — History column reorder (branch feature/history-column-order)

- [x] Body text column → leading Sun/Moon icon column (☀/🌙).
- [x] Order: icon, Transit, Recorded, Lead, Sep, Dist, Disc xing, Speed,
      Alt, Stage, Outcome, Flight, ICAO, Route (Flight/ICAO/Route far right).
- [x] ISS Flight-cell highlight selector moved to col 12 (#history) while
      Tracking keeps col 5; added .th-icon/.td-icon styling. Version 0.9.1.
      Frontend-only; 131 tests still pass.

Status: merged to main (v0.9.1, 818bf18).

---

# v0.10.0 — ISS Pushover + visible pass + learning audit + Tracking reorder + funnel

Branch: feature/iss-pushover-visible-pass

- [x] (c) AUDIT Alert-learning: logic is consistent and actually improved by
      the H change (radio now recorded at the 2° panel band → graduated/
      faded/hit-rate meaningful). BUG found & fixed: ISS history rows
      contaminated the aircraft aggregates → `episodes()` now excludes
      `icao='ISS'`; `consolidatedHistory()` (History table) still keeps it.
- [x] (a) ISS Pushover: ISS fed to the notifier (same path as aircraft),
      manual ISS recordEvent removed (notifier.onEvent records → one path,
      auto episode consolidation), ISS-flavoured Pushover title.
- [x] (b) `nextIssVisiblePass()` (el>20°, Sun<−6°, station sunlit via
      cylindrical Earth-shadow test) → state.iss.visiblePass → Sky-now line.
- [x] (d) Tracking reordered like History: leading Sun/Moon icon (Body
      column dropped), Sep·Dist·Speed·Alt block, Flight/ICAO/Route at right.
- [x] (e) Detection funnel: new "Live planes" bar (state.detectStats
      .liveCount = aircraft this tick); "detected" → "Total detected".
- [x] Version 0.10.0; README M22 + ISS section. Tests: 134 pass (+3).

Status: merged to main (v0.10.0, ab525d2).

---

# v0.10.1 — click-to-update no longer fails silently (branch bugfix/click-update-feedback)

ROOT CAUSE: the endpoint only writes data/update.request; the executor is
the systemd stp-update.path unit (Linux/Pi only, added in v0.8.1).
auto-update.sh does NOT install systemd units, so a Pi upgraded from
< v0.8.1 by code-pull never got the watcher → trigger written, nothing
consumes it. (macOS dev box: no systemd at all → also a no-op, expected.)
Plus a UI bug: the frontend swallowed the result (ok:false @ HTTP 200, and
no success message) so it looked dead either way.

- [x] service.js: tick() self-diagnostic → state.update {status:
      idle|pending|consumed|stuck, ageMs, triggerPath}; richer requestUpdate
      message.
- [x] app.js: honest #update-msg line; surface ok:false; renderUpdateStatus
      reflects pending/consumed/stuck; badge restore on failure/stuck.
- [x] auto-update.sh: journal WARNING when stp-update.path inactive + fix.
- [x] README troubleshooting + M23; version 0.10.1. Tests: 134 pass.

Status: merged to main (v0.10.1, f4cf8bc).

---

# v0.10.2 — fix stuck "updating…" + Sky-now next visible pass & transit (branch bugfix/update-badge-stuck-iss-skynow)

(a) ROOT CAUSE of "endlessly updating, even after refresh": the v0.10.1
'consumed' state had NO timeout. If the updater consumed the trigger but
no restart happened (already up to date / no-op), or on a stale running
server, state.update stayed 'consumed' → badge "updating…" forever, and a
refresh re-read the same hung server state. Fix:
- service.js: 'consumed' auto-clears to idle after 20 s (no restart ⇒
  no-op); 'stuck' auto-clears to idle after 10 min and removes the stale
  trigger file; lastUpdateRequestMs reset on idle.
- app.js: renderUpdateStatus is now an authoritative state machine that
  ALWAYS restores the version badge on idle/stuck and only holds
  "updating…" for pending/consumed; client-error message kept ~10 s.
- NOTE: the running service must be updated ONCE manually to get this
  (chicken-and-egg — the broken button can't deliver its own fix).

(b) Sky-now shows TWO ISS lines, both even if weeks away (with date):
next visible pass (visibleHorizonMs default 30 d, early-return → cheap)
and next Sun/Moon transit (horizonMs default 48 h → 14 d; state.iss
.nextTransit {body,sep,at}, horizonDays for the "none in N days" copy).

- [x] Version 0.10.2; README M24; config example. Tests: 134 pass.

Status: merged to main (v0.10.2, bef6b6b).

---

# v0.10.3 — "no ISS info" out of the box (branch fix/iss-tle-auto-fetch)

CAUSE: ISS is offline-by-default — the service never fetches the TLE; it
only reads data/iss.tle, written by the opt-in scripts/refresh-tle.js. If
that was never run, state.iss.active=false and renderIssPass hides the
whole Sky-now block → "no ISS info". Working as designed, but the user
expects ISS info to appear.

- [x] systemd/stp-tle.service + stp-tle.timer (daily 05:40 ±20m,
      Persistent) — mirrors the auto-update timer pattern.
- [x] install-pi5.sh: install+enable the TLE timer (independent of
      --no-auto-update) AND a best-effort initial `node refresh-tle.js`
      so ISS info appears right after install. Runtime stays offline.
- [x] README: ISS TLE section rewritten + M25; version 0.10.3.
      Diagnosis given to user: run scripts/refresh-tle.js now / re-run
      install-pi5.sh (≥0.10.3). Tests: 134 pass (no logic change).

Status: complete.

# DONE — click-to-update (folded into v0.8.1)

Implemented with the user-chosen safe approach: trigger file + systemd
`stp-update.path`. HTTP layer never runs git/systemctl.

# Visibility ampel + notify gate + color semantics (v0.15.0)

Branch: feature/visibility-ampel-notify-gate

## Decisions (locked with user)
- Notify gate: configurable `notifier.minElevationDeg = 30` (Settings-editable,
  0 = off). Pushover only; History/stats stay complete (decoupled). ISS exempt
  (keeps its own 15 deg gate).
- Ampel (3 states): red < 30 deg / amber 30-45 deg / green >= 45 deg. Source =
  candidate.aircraftAtClosest.elevationDeg at closest approach.
- Aircraft-stats: NEW 2nd list "usable candidates" from transit_history
  (elevation >= gate). Sightings tally has no elevation -> untouched.
- Row colors (History & Live), unified:
  - GREEN only: History outcome==='confirmed' && sepConfirmed && sep < 0.27;
    Live status==='imminent' && sep < 0.27 (real disc overlap).
  - YELLOW: sep < 0.5 but not green ("almost"). else neutral.
  - Removes old magenta(Tracking)/green(History) near-hit split.

## Tasks
- [x] Backend gate (service.js + notifier.js + example json + install script)
- [x] store.usableCandidates() + /api/usable
- [x] Frontend: vis column + rowQuality colors + 2nd stats list + Settings field
- [x] README Good-to-know + table; milestone M44; package.json -> 0.15.0
- [x] Tests (store/notifier/server) + node --check + npm test
- [x] Phase B: side view (buildSideViewSvg) + FOV layout rework
      (transit+AirNav top row, plan|side lower box) + M45; v0.15.1
- [x] merge to main + push

## Results
- v0.15.0 (commit ec72bb6): pushover.minElevationDeg gate (default 30, 0=off,
  ISS exempt, hot-reload+persist), visibility traffic-light column in
  History+Live, store.usableCandidates()/GET /api/usable + 2nd Aircraft-stats
  list, unified q-green/q-amber row colours (green = confirmed real disc
  overlap sep<0.27°, amber = near-miss <0.5°). README good-to-know + table.
- v0.15.1: buildSideViewSvg (isotropic elevation profile, wedge in band
  colour, 20/30/45° rays) beside the plan view; FOV layout = top row
  transit-sketch + compact AirNav, lower box plan|side.
- Tests 154 → 161 (notifier gate ×4, usableCandidates ×1, side view ×2).
  Full suite green, node --check clean. README key corrected to
  pushover.minElevationDeg.

Status: complete.

# Dynamic/time-lapse FOV + header tidy-up (v0.16.0)

Branch: feature/dynamic-fov-animation

## Decisions (locked with user)
- Phase 1 + 2. Adaptive /api/state cadence: idle 10s, fast 2s when
  |ETA| < 180s, held through ±30s + 30s tail. Auto-pick = "best"
  (imminent > visibility band > tightest sep > nearest ETA); click still
  pins. Time-lapse "now" marker travels the predicted path on the
  Sun/Moon sketch.
- Status legend → collapsible <details>, default collapsed.
- Header: ext links (GitHub/AstroBin/dump1090/AirNav) to the right edge;
  "buy me a coffee" (https://buymeacoffee.com/joergsflow, user-confirmed)
  next to the identity.

## Results
- app.js: POLL_IDLE/FAST consts, wantFastPoll()+scheduleNextPoll()
  (replaced fixed setInterval), pickAutoEntry() rewritten to a
  lexicographic score (visScore/cmpScore), renderFovSketch stamps nowMs.
- sketch.js: buildSketchSvg draws an interpolated, pulsing "now" marker
  along visiblePathPts (no nowMs → nothing; back-compat kept).
- index.html/style.css: collapsible legend; header split into
  .ext-links (right edge) + .header-controls; BMC link in .identity.
- Tests +1 (now-marker), 165 green. README M47, version 0.16.0.

Status: complete.

---

# Best-hours stat: when do the most usable hits occur (v0.18.0)

Branch: feature/hourstats-best-times

User ask: "mach eine weitere statistik zu welchen uhrzeiten die meisten
nutzbaren treffer auftreten" — sep < 0.5°, split by Sun/Moon, elevation
≥ 30°.

## Design
- Definition of "usable hit" = same as the Range-stats / Usable-candidates
  cards: stage='imminent' (time-confirmed real transit), closest_sep_deg
  < sepDeg (0.5°), elevation at closest ≥ minElevationDeg (30°, parsed from
  payload_json.candidate.aircraftAtClosest.elevationDeg). ISS included
  (consistent with rangeStats/usableCandidates — only episodes() drops ISS).
- Hour bucket = hour-of-day of closest_at_ms in **server-local time** (the
  Pi runs at the observatory → its wall clock IS the "time of day to
  observe"). 24 bins, split per body.

## Tasks
- [x] store.hourStats() — 24-bin per-body histogram + peak hour
- [x] GET /api/hourstats (sepDeg / minElevationDeg / windowDays)
- [x] Frontend: new "Best hours" section (☀/🌙 columns reuse acstats bars)
      + pollHourstats wired into the slow stats cadence
- [x] Tests: store.hourStats ×3 + server route ×1
- [x] README milestone M52 + /api/hourstats row; package.json 0.17.0 → 0.18.0
- [x] node --check + npm test green

## Results
- store.hourStats(): imminent + sep<0.5° + elevation≥30° (parsed from
  payload_json, ISS kept like rangeStats/usableCandidates) → 24-bin
  per-body histogram + total + peak{Sun,Moon,all}. Hour of closest_at_ms
  in server-local time (Pi = observatory clock); injectable `hourOf`
  seam for deterministic tests.
- GET /api/hourstats (sepDeg 0.05–5 / minElevationDeg 0–90 /
  windowDays 1–3650), mirrors /api/rangestats + /api/usable.
- Frontend: "Best hours" section after Range stats — peak figures
  (Sun/Moon/both) + two acstats-bar columns (☀ 00h–23h / 🌙 00h–23h),
  fullest bin emphasised (.acstats-row-peak). pollHourstats on the
  60 s stats cadence.
- Milestone numbered M52 (M48–M51 already used by v0.16.x–0.17.0).
- Tests 165 → 171. Full suite green; node --check clean.

Status: complete, awaiting commit/push/merge confirmation.
