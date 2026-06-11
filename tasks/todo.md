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

---

# E-paper display client (v0.31.0)

Branch: feature/epaper-display

User ask: Waveshare 4.2" e-paper on the Pi 5, ~2 s updates of the key data so
no browser is needed — clock, date, local coordinates, total live trackings,
real candidates, sky now, FOV preview. Follow-ups: at least the next 3 real
candidates as a list with altitude/speed/distance/angle/ETA each; all metric
(km); allow a remote Pi by IP as data source; configure via the browser
Settings panel (host URL, quick/long refresh, enabled, compact, count);
extend the README with an install section.

## Decisions (locked with user)
- Panel: 4.2" B/W SPI (partial-refresh capable) — corrected from "i2c"; SPI.
- Refresh: partial every 2 s + full every 60 s (both Settings-editable).
- Language: Python (mature Waveshare driver) — decoupled HTTP client.
- Units: all metric (m / km/h / km), no toggle.
- Data source: localhost OR remote LAN IP, set in the browser.
- All knobs in the web Settings panel (incl. compactList + candidateCount).

## Tasks
- [x] Node: new `display` config block (DEFAULT_CONFIG, mergeConfig,
      publicConfig, transactional applyConfigUpdate validation, persist).
- [x] Web: "E-paper display" fieldset in the Settings modal (app.js generic
      load/save already covers `display.*` — no app.js change needed).
- [x] Python client `display/`: config.py (bootstrap + live config fetch),
      fov.py (sketch.js math port), render.py (Pillow, two-line + compact +
      offline + disabled screens), epaper_client.py (loop, driver wrapper,
      --dry-run, signal-safe sleep).
- [x] systemd/stp-display.service; display/requirements.txt; display/README.md.
- [x] config/service.example.json + README (display section, BOM row, config
      doc, project layout, file table) + MILESTONES M79; version 0.31.0.
- [x] install-pi5.sh: --with-display / STP_WITH_DISPLAY=1 → enable SPI, install
      Python panel libs (apt Pillow/lgpio/gpiozero/spidev + pip waveshare-epd),
      add spi/gpio groups, install+enable stp-display.service. Off by default
      (optional hardware; panel stays off until enabled in Settings so no
      fail-loop on a panel-less box). bootstrap-pi5.sh forwards the flag/env.

## Results
- Verified end-to-end on the Mac: server starts, GET/POST /api/config carry the
  `display` block, validation rejects bad URL / out-of-range count / long<quick
  with the correct per-cause error, and (after the transactional fix) a failed
  save no longer wedges later saves. Client renders real /api/state to PNG
  (two-line + compact layouts both legible) and shows SERVER OFFLINE / disabled
  screens correctly. `npm test` 205 pass.
- Pi 5 hardware verification (SPI, real panel, live refresh cadences) is the one
  step left to the user — code is Pi 5-correct (gpiozero/lgpio, SPI device
  allow-list in the unit).
- Lesson logged: validate config patches with cross-field invariants
  transactionally (tasks/lessons.md 2026-06-08).

Status: complete, awaiting commit/push/merge confirmation; Pi hardware test by user.

---

# Backlog (planned / hardware pending)

## Piezo buzzer audio alert (Pi 5)
Status: **planned** — piezo summer ordered (user, 2026-06-09), arrives later.

Context: Pi 5 has no 3.5 mm jack and no onboard sound. A passive piezo
buzzer on a GPIO pin (PWM via `gpiozero` / `lgpio`) is the minimal way to
get an audible transit alert without a DAC/USB sound card.

- [ ] Wire a passive piezo to a free GPIO pin (+ GND); confirm pin choice
      doesn't clash with the ADS-B HAT / PoE HAT GPIO usage.
- [ ] Small Python (or Node→gpio) beep helper: short/long patterns for
      `candidate` vs `imminent` stages; respect a quiet-hours / mute config.
- [ ] Hook the beep into the existing notifier stage transitions (reuse the
      same stage gating as Pushover — do NOT duplicate the funnel logic).
- [ ] Config knob: enable/disable + which stages beep (default: imminent
      only, so it isn't noisy). One legitimate default — keep it minimal.
- [ ] Test on real Pi 5 hardware once the buzzer arrives.

---

# E-paper layout redesign — three-paragraph grid (v0.31.2)

User ask (2026-06-09): restructure the 4.2" panel into three paragraphs.

- [x] Para 1: one line — bold clock · date · place · GPS (left), LIVE · CAND
      (right) + rule. Adaptive trail font (12→10 px) keeps the place name on
      the Pi's narrow DejaVu mono before dropping it as a last resort.
- [x] Para 2: nearest candidate (#1) detail on the left + FOV frame on the right.
- [x] Para 3: SKY NOW (left) + next candidates (#2–#4) on the right; when there
      are NO candidates, fall back to tracked aircraft from `lifecycle`
      (the only aircraft-keyed list in /api/state), numbered from 1.
- [x] Bold-font support in render._font(); compact GPS formatters (no ° glyph).
- [x] Removed now-dead Settings knobs `candidateCount` + `compactList` from
      service.js (defaults + validation), web/index.html, display/config.py,
      service.example.json, README + display/README (layout is fixed now).
- [x] Verified: 205 node tests pass, python syntax OK, both layouts (with +
      without candidates) rendered via a dry-run fixture harness.

## Results
Layout is a fixed 3×(left/right) grid; no list-length/compact toggles. Pi
hardware refresh (real panel cadences) still to be eyeballed by the user.

---

# E-paper readability + plane list fixes (v0.31.3)

User feedback (2026-06-09): fonts too small except the clock; no planes shown
when there are no Real candidates; ETA/SEP/FOV should be big+bold, route/
bearing/dist/alt/speed small; frontend still showed 0.31.1.

- [x] Big/bold body text: clock 20-bold header; primary block — callsign 19-bold,
      ETA + SEP 24-bold headline figures with small labels; route/bearing on one
      small line + dist/alt/speed on another; large FOV frame; SKY NOW + list at
      15–16 px.
- [x] Header size gradient (date 14 · place 13 · GPS 12) right of the big clock;
      static place/GPS smallest, GPS dropped first if the line is full.
- [x] PLANES now come from the unified `lifecycle` list (candidates ⊂ lifecycle),
      sorted real-first then by separation → the panel always shows tracked
      traffic, even with zero Real candidates. #1 → detail block, #2–4 → list.
- [x] Data-source fix: altitude/speed read from `candidate.aircraft`
      (aircraftAtClosest only carries az/el/range → was always "--"); added
      route (`route.origin/destination.iata`) and bearing (`aircraft.trackDeg`).
- [x] Verified both states (with/without Real candidates) via the dry-run
      fixture harness (now using the real /api/state shape); 205 node tests pass.

NOTE — the "frontend shows 0.31.1" is NOT a code bug: PKG_VERSION is read from
package.json at server start, so the running Node service (stp.service) must be
restarted after a pull — restarting only stp-display is not enough.

## Results
Readable from across the room; planes always visible. Open: header can't fit
big clock + date + place + GPS + counts on one line — GPS is dropped on the
narrow Pi font. If the user wants GPS guaranteed, a two-line header is the fix.

---

# E-paper two-line header (v0.31.4)

User chose a two-line header (2026-06-09) so the full GPS stays legible:
- [x] Line 1: big bold clock + date (left), LIVE / CAND (right).
- [x] Line 2: place + full GPS (with ° — room now).
- [x] Shifted the primary/bottom bands down (_HDR_RULE 46, _BLK2_RULE 178);
      re-tuned ETA/SEP/detail y-positions; NEXT PLANES font 14 + tightened row
      so sep never clips on wider fonts.
- [x] Verified both states via the fixture harness.

---

# E-paper readability pass 2 (v0.31.5)

User feedback (2026-06-09):
- [x] SKY NOW: drop azimuth, show elevation only, larger, "el <space> NN°".
- [x] Aircraft block widened (SKY NOW is narrow now) + larger font; cryptic
      "S T-7:50" replaced with labelled "SEP <val>  ETA <val>" (tiny caption,
      double-size payload — new `_lv()` helper applies this everywhere).
- [x] ETA loses the "T" prefix (now always carries an ETA label) → "-7:50".
- [x] Header: removed LIVE/CAND. The count moved down next to the AIRCRAFT
      heading as "(cand/total)" e.g. (3/88) = 3 candidates of 88 live planes.
- [x] Verified both states via the fixture harness; 205 node tests pass.

Further ideas offered to the user (pending pick): SEP trend arrow
(approaching/leaving), transit-imminent emphasis (SEP < disc → banner/invert),
disc-crossing time for #1, Sun/Moon glyphs instead of S/M, stale-data warning.

---

# E-paper at-a-glance cues (v0.31.6)

User picked ideas 1, 2, 4, 5 (2026-06-09):
- [x] (1) SEP trend arrow: ▼ closing in (closest approach ahead) / ▲ receding
      (past) — derived from the ETA sign; in the detail block + each list row.
- [x] (2) Transit banner: inverted ">> TRANSIT NOW <<" over the detail heading
      when sep ≤ the body's angular radius (fov.body_disc_deg/2).
- [x] (4) Sun/Moon glyphs (rayed disc / crescent) instead of S/M, in the detail
      callsign, SKY NOW, and the aircraft rows (new _draw_body/_tri helpers).
- [x] (5) Stale marker: "! STALE Ns" in the detail heading + a leading "!" on
      stale list rows (status=='stale', age from lastUpdateMs); "~ coasting" too.
- [x] Verified normal / transit / empty states via the fixture harness; 205
      node tests pass.

Not taken this round (offered): #3 disc-crossing time, #6 rise/set countdown.
Piezo buzzer (backlog) pairs naturally with the transit banner.

---

# Piezo buzzer audio alerts — settings-driven (v0.31.7)

Buzzer arrived, wired GPIO13 ↔ GND (user, 2026-06-10). Built end-to-end:
- [x] Always PWM-drive the pin → works for passive AND active buzzers (no need
      to know which). `--test-buzzer` does DC + tone + frequency sweep so the
      user confirms type + loudest freq.
- [x] display/buzzer.py: Buzzer (PWM on a background thread, lazy — claims GPIO
      only while enabled, releases on disable) + BeepScheduler (pure logic).
- [x] Signals (all configurable, these are defaults): new real candidate =
      3×0.5 s; lost/past = 1×1.5 s; countdown for sep<0.3°: every 10 s from 40 s,
      5 s from 15 s, 2 s from 8 s. Scheduler verified with a fake-buzzer harness.
- [x] Settings-driven: new server `buzzer` config block (DEFAULT_CONFIG, merge,
      publicConfig, transactional validation incl. descending-phase check,
      persistence) + web "Audio / buzzer" fieldset (generic dotted-name form) +
      config.py fetch_buzzer_config (polled live like the display block).
- [x] epaper_client.py: shared poll loop drives panel + buzzer; runs the buzzer
      even with the panel off; --test-buzzer mode.
- [x] Docs: display/README "Audio buzzer" section + README note +
      service.example.json. 205 node tests pass; python syntax + scheduler OK.

Note: countdown can't beep faster than the panel Quick refresh (shared tick) —
keep it ~2 s for the near phase. Server config-update path has no unit test
(neither does `display`); pattern mirrors the proven display block.

---

# Buzzer entry-blast + revert-to-default (v0.31.8)

User feedback (2026-06-10): 2000 Hz loudest; add an entry blast; #3/#6 dropped;
revert the real-candidate view to default 1 min after end of transit.

- [x] Default drive frequency 2700 → 2000 Hz (loudest on the user's element).
- [x] Entry blast: one long beep (default 1 × 5 s) starting `entryBeforeS` (2 s)
      before the plane enters the disc — uses `entersAtMs` (≈ closest for fast
      aircraft, falls back to closest). Fires once per contact and supersedes
      the countdown for it. New config: entryBeforeS/entryBeeps/entryOnMs
      (server defaults + validation, web fields, config.py, example.json).
- [x] E-paper revert: _pool drops contacts whose closest approach is > 60 s
      past, so a long-gone candidate stops dominating the detail block / list.
- [x] Web revert: LIVE_GRACE_AFTER_ETA_MS 5 min → 1 min, so the "Real
      candidates" panel reverts ~1 min after the pass (History hand-off shares
      the same cutoff → no gap).
- [x] #3 (disc-crossing time) and #6 (rise/set countdown) dropped per user.
- [x] Verified: scheduler harness (incl. entry one-shot + countdown takeover),
      e-paper revert preview, 205 node tests, python syntax.

---

# Buzzer: test button, new-candidate ETA gate, lost frequency, tuned defaults (v0.31.9)

User asks (2026-06-10):
- [x] Settings "Test signals" button → plays every configured signal once on the
      Pi. Channel: POST /api/buzzer-test bumps a transient `buzzer.testId` in
      publicConfig; the client sees the changed id on its config poll and plays
      buzzer.test_sequence() (segments, so the lost signal keeps its own freq).
- [x] New-candidate signal only fires once a candidate is within `newEtaMaxS`
      (default 120 s) of closest approach — `announced` set, decoupled from the
      raw appearance; lost beep only for previously-announced candidates.
- [x] Lost signal at its own frequency (`lostFreqHz`, default 1000 Hz) —
      Buzzer.play() gained a per-pattern freq override.
- [x] Default tweaks: freq 2000 (done earlier); new 3×100 ms gap 50; phase3
      2×50 ms; entry 5 s (earlier). All in server defaults + validation,
      config.py, example.json, web fields.
- [x] Verified: scheduler harness (ETA gate, lost@1000Hz, entry, countdown),
      test_sequence segments, client dry-run, 205 node tests, node --check.

Open question from user: an "echo"/fade-out tail proportional to beep length —
feasible via a PWM duty ramp (volume envelope). Offered; not yet built.

---

# Imminence ordering + fade/echo + settings move (v0.31.10)

User feedback (2026-06-10), incl. a display photo showing ETA -11:55 featured
over an imminent ETA -22s:
- [x] FIX display logic: order by IMMINENCE (soonest upcoming closest-approach
      first), not by smallest predicted separation. Fixed at the source —
      lifecycle.js lifecycleArray() now sorts by ETA (so the WEB "Real
      candidates" table is fixed too) — and render.py _pool mirrors it. Verified
      against the photo scenario (EXS2WA -22s now featured, AAB11J -11:55 last).
- [x] Fade-out + echo per signal type: buzzer.py `_signal()` builds a (on,off,
      duty) envelope — fadePct ramps the volume down over the beep tail (softer,
      less penetrant), echoTaps add quieter sparser repeats. Per-signal config
      (FadePct/Echo ×6) in server defaults+validation, config.py, example, web.
      Default gentle fade on lost (30%) + entry (40%).
- [x] Moved the Audio/buzzer settings fieldset to the LEFT column, under
      Pushover.
- [x] Verified: scheduler harness (envelope + echo), e-paper render, 205 node
      tests (lifecycle ordering tests updated to imminence).

Open: user asked about echo — implemented. (#3/#6 still dropped.)

---

# Buzzer: remove echo, adopt user's tuned defaults, allow short beeps (v0.31.11)

User (2026-06-10):
- [x] Remove the echo-taps feature entirely (kept fade-out): _signal() drops the
      echo param + tail; removed the 6 *Echo config keys (server defaults +
      validation, config.py, example.json) and the 6 web "Echo taps" fields.
- [x] Adopt the user's screenshot values as defaults: lost 4×100 ms @500 Hz/30%
      fade; entry 10×100 ms from 3 s; phase1 from 60 s, all phases 2×50 ms.
- [x] Allow beep length < 100 ms (UI/validation rejected it): lowered every
      *OnMs minimum to 20 ms (was 50, entry was 100) — both the server validation
      and the web inputs.
- [x] Verified: scheduler harness (pinned cfg), test_sequence reflects defaults,
      205 node tests, JSON valid, fieldsets balanced.

---

# E-paper: Sky-now to header corner + RECENT learned-transits strip (v0.31.12)

User (2026-06-10):
- [x] Moved Sky-now (Sun/Moon elevation) to a compact top-right corner of the
      two-line header (small glyph + elevation per body).
- [x] Bottom-left (freed by Sky-now) now shows a RECENT strip: the last 3–4 real
      (candidate/imminent) transits that were recorded — flight, how-long-ago,
      achieved SEP, with a Sun/Moon glyph.
- [x] Server: /api/state.recentTransits — last 4 confirmed/predicted episodes
      (ISS excluded) from store.consolidatedHistory(), computed on a 20 s cache.
- [x] render.py: _fmt_ago() helper; header + bottom rewritten. Verified both
      states via the fixture harness; 205 node tests pass.

---

# Buzzer: rising/falling frequency chords for new/lost/entry (v0.31.13)

User (2026-06-11): replace single tones with 3-tone sweeps — rising for new
candidate (+200 Hz/step), falling for lost (−200), and a rising entry chord.
- [x] _signal() gained base_freq + freq_step → each beep steps in frequency
      (clamped 80–20000); embedded as a 4th per-step element so the player sweeps
      within one pattern. Fade/duty untouched.
- [x] New `<sig>FreqStepHz` config for new/lost/entry (server defaults +
      validation [-5000..5000], config.py, example, web fields).
- [x] Defaults: new 3×100 ms +200 (2000→2400); lost 3×100 ms −200 from 500
      (500→100), 30% fade; entry now a 3-tone rising chord (+200) instead of the
      10-beep burst. Countdown phases unchanged (no sweep).
- [x] Verified: scheduler harness (asc 2000/2200/2400, desc 500/300/100),
      test_sequence, 205 node tests, JSON valid, fieldsets balanced.

---

# Buzzer: harden worker thread + diagnostic logging (v0.31.14)

User: test beeps play, but no LIVE beeps came afterwards.
- [x] Wrap the buzzer worker thread's per-pattern playback in try/except so a
      single bad step can never kill the thread (which would silently stop ALL
      future beeps — the likely "test works, live doesn't" failure mode). Logs
      "buzzer playback error: …" if it ever catches one.
- [x] BeepScheduler gained a `log` callback (wired to the client's _log):
      logs the in-band candidate count on change, plus every fired NEW / LOST /
      COUNTDOWN / ENTRY event — so `journalctl -u stp-display` shows whether
      live events exist at all (likely cause: state.candidates is empty because
      real sub-threshold candidates are rare).
- [x] Verified: scheduler harness + a logging smoke test; 205 node tests pass.

Next: have the user read journalctl to see if state.candidates is ever non-empty;
if the panel shows REAL CANDIDATEs while the log says 0, the trigger source needs
to move from state.candidates to the lifecycle real-candidates.

---

# E-paper/buzzer: real-candidate alignment, FOV path, ETA/counter fixes (v0.31.15)

User feedback (photo IMG_0862): counter (0/61) despite a real candidate; no
beep; FOV cross at the frame edge; huge ISS ETAs; wants current+closest+path.
- [x] Buzzer keyed off the LIFECYCLE tracked planes (non-stale, predicted closest
      sep < sepThresholdDeg) instead of the tight, often-empty state.candidates —
      so it fires for what the panel shows. Entry blast keeps a tight disc gate
      (sep < 0.35°). sepThresholdDeg default 0.3 → 1.0.
- [x] AIRCRAFT counter now = the displayed pool count (near-body tracked), not
      len(state.candidates) → matches what's on screen.
- [x] FOV fix + upgrade: marker referenced to bodyAtClosest (was current body →
      edge); plus the full crossing PATH line + small "closest" cross + big
      "current-position" cross from `transitPath` samples (mirrors the web FOV).
- [x] _fmt_eta: coarse forms far out — '-4h3m', '-1d21h', '-7d4h' — so ISS reads
      sensibly instead of '-2721:03'.
- [x] Verified: scheduler harness (sep-gated), fixture render (path + 2 crosses,
      counter 4/14, near-miss below disc), 205 node tests.

Note: existing saved configs keep sepThresholdDeg=0.3 — tell the user to set the
Alert SEP threshold to ~1.0 in Settings so their 0.2–0.9° candidates beep.

---

# Buzzer: alert for coasting/stale-lost candidates too (v0.31.16)

User (photo IMG_0864): no live beep. Featured nearest plane RYR917L was
"! STALE 170s" (ADS-B signal lost, predicted closest still 2 min ahead); the
only non-stale entries were ISS passes 1d19h out. v0.31.15's _candidate_set
excluded ALL stale → the panel's featured candidate never beeped.
- [x] _candidate_set now keeps coasting / stale-lost entries whose closest is
      still upcoming or only just past (drop only well-past >60 s and off-band
      sep≥sep_th). Verified: RYR-style stale-lost kept, well-past + far dropped;
      scheduler harness + 205 node tests still pass.
- NOT an audio bug — the test sequence is the same play() path that works; the
  scheduler simply had nothing (non-stale) to fire on.
Reminder for the user: on a two-Pi setup, the display Pi reads BUZZER config from
its OWN localhost (STP_CONFIG_URL), STATE from sourceUrl — so configure/test the
buzzer on the display Pi's web UI, not the remote predictor's.

---

# E-paper/web candidate sync: real-first sort + IATA flight ids (v0.31.17)

User (photos): the e-paper candidate display deviated from the web. Two causes:
- [x] Identifier mismatch: panel showed the raw ICAO callsign (SAS65D, TRA93Y),
      web shows the IATA flight (SK65D, HV93Y). _make_view + recentTransits now
      prefer `flight` (IATA) — same identifier as the web FLIGHT column.
- [x] Priority mismatch: panel featured a STALE near-miss (sooner ETA) while the
      web FOV showed the live transit candidate. Sort is now REAL candidates
      (candidate/imminent) first, then imminence — both render._pool AND server
      lifecycleArray (so web table + panel agree). Verified.

Note (two-Pi setup): the web table fix lives in lifecycleArray on the PREDICTOR
host (192.168.1.15) — update + restart stp.service THERE too, not just the
display Pi, for the web list to match. (Predictor was on v0.31.12.)

---

# Docs: move the long README into a structured GitHub Wiki (v0.31.17 docs)

User: the 2000-line README is impractical → structured WIKI + small README entry
linking in; the table of contents matters most; not a dozen subpages.
- [x] GitHub Wiki (.wiki.git) restructured: Home = master table of contents
      (deep links per topic) + 4 consolidated pages — Setup, Usage, Advanced,
      Reference — each with its own in-page TOC. + _Sidebar nav.
- [x] Content moved verbatim from the README, split by ## sections; image/repo
      links rewritten to absolute raw/blob GitHub URLs; GitHub-style anchors.
- [x] README slimmed 2015 → ~75 lines: title, hero, ASCII pipeline, quick-start
      one-liner, and a Documentation TOC linking into the wiki + in-repo docs.
Wiki lives in the separate sun-moon-transit-predictor.wiki repo (pushed).
