// Founded, all-time statistical report over the SQLite history DB (v0.41.0).
//
// This is the SHARED analysis core: the CLI (scripts/analyze-history.js) and
// the browser API (/api/stats/report*) both call buildReport() so there is one
// source of truth. buildReport() returns a plain structured object; the
// formatters (formatText / formatCsv) render it. A data-driven recommendations
// engine (recommendations[]) turns the measured drift / elevation / separation
// distributions into concrete suggested defaults (pre/post-roll, drift margin,
// elevation floor) — see deriveRecommendations().

const DAY_MS = 24 * 3600 * 1000;
const ALL_WINDOW_MS = 3650 * DAY_MS;            // ~10 years = "all time"

// ---- tiny stats helpers (pure) -------------------------------------------
const finite = (a) => a.filter((x) => Number.isFinite(x));
const asc = (a) => finite(a).slice().sort((x, y) => x - y);
export function pctile(arr, p) {
  const s = asc(arr);
  if (!s.length) return null;
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
export const median = (a) => pctile(a, 50);
export const mean = (a) => { const s = finite(a); return s.length ? s.reduce((p, c) => p + c, 0) / s.length : null; };
export const maxOf = (a) => { const s = finite(a); return s.length ? Math.max(...s) : null; };
export const minOf = (a) => { const s = finite(a); return s.length ? Math.min(...s) : null; };
export const pct = (part, whole) => (whole > 0 ? (100 * part / whole) : 0);
const round = (x, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

/**
 * Build the full report object from a HistoryStore.
 * @param {object} store  an open HistoryStore
 * @param {{ nowMs?: number, windowMs?: number, dbPath?: string, sharpcap?: object }} [opts]
 *   sharpcap: the LIVE sharpcap config, so recommendations show real current
 *   values (a saved service.json keeps old values after a default bump).
 */
export function buildReport(store, { nowMs = Date.now(), windowMs = ALL_WINDOW_MS, dbPath = null, sharpcap = null } = {}) {
  const db = store.db;
  const W = { windowMs, nowMs };

  // ---- coverage / denominators -------------------------------------------
  const totalRows = store.count();
  const sight = store.sightingTotals();
  const totalIcao = sight.icao.distinctKeys;
  const highElev = store.highElevTotals();
  const span = db.prepare('SELECT MIN(recorded_at_ms) AS a, MAX(recorded_at_ms) AS b FROM transit_history').get();
  const firstMs = minOf([span?.a, highElev.sinceMs]);
  const lastMs = span?.b ?? nowMs;
  const spanDays = Number.isFinite(firstMs) ? Math.max(1, (lastMs - firstMs) / DAY_MS) : null;

  const ep = store.episodes(W);
  const episodes = ep.episodes;
  const agg = ep.aggregates;
  const nEpisodes = episodes.length;
  const imminent = episodes.filter((e) => e.stages.includes('imminent'));
  const candPlus = episodes.filter((e) => e.stages.includes('candidate') || e.stages.includes('imminent'));

  // ---- a) regulars --------------------------------------------------------
  const sights = db.prepare("SELECT visits, first_seen_ms AS f, last_seen_ms AS l FROM aircraft_sightings WHERE kind='icao'").all();
  const ge = (n) => sights.filter((s) => s.visits >= n).length;
  const regulars = {
    totalIcao,
    seenAgain: ge(2),
    frequent: ge(5),
    regular: ge(10),
    multiDay: sights.filter((s) => s.visits > 1 && (s.l - s.f) >= DAY_MS).length,
    medianVisits: median(sights.map((s) => s.visits)),
    maxVisits: maxOf(sights.map((s) => s.visits)),
  };

  // ---- b) serious candidates (projected vs confirmed) --------------------
  // Projected = tightest sep across any stage; confirmed = tightest imminent
  // (time-confirmed) sep. The gap between them IS the separation drift (d).
  const seps = finite(episodes.map((e) => e.minSepDeg));
  const confSeps = finite(episodes.map((e) => e.confirmedMinSepDeg));
  const THRESH = [0.1, 0.2, 0.3, 0.5, 1.0, 2.0];
  const distinctBelow = (t) => new Set(episodes.filter((e) => Number.isFinite(e.minSepDeg) && e.minSepDeg < t).map((e) => e.icao)).size;
  const candidates = {
    nProjected: seps.length,
    nConfirmed: confSeps.length,
    buckets: THRESH.map((t) => ({
      thresholdDeg: t,
      projected: seps.filter((s) => s < t).length,
      confirmed: confSeps.filter((s) => s < t).length,
    })),
    medianProjectedDeg: round(median(seps), 3),
    tightestDeg: round(minOf(seps), 3),
    tightestConfirmedDeg: round(minOf(confSeps), 3),
    distinctBelow05: distinctBelow(0.5),
    funnelHighElevPct: round(pct(distinctBelow(0.5), highElev.count), 1),
    funnelAllPct: round(pct(distinctBelow(0.5), totalIcao), 1),
  };

  // ---- f) real-candidate profile (needed early for recommendations) ------
  const im = db.prepare("SELECT altitude_m AS alt, range_m AS rng, track_deg AS trk, payload_json AS pj FROM transit_history WHERE stage='imminent'").all();
  const alts = [], rngs = [], elevs = [], tracks = [];
  for (const r of im) {
    if (Number.isFinite(r.alt)) alts.push(r.alt);
    if (Number.isFinite(r.rng)) rngs.push(r.rng);
    if (Number.isFinite(r.trk)) tracks.push(r.trk);
    try {
      const el = JSON.parse(r.pj)?.candidate?.aircraftAtClosest?.elevationDeg;
      if (Number.isFinite(el)) elevs.push(el);
    } catch { /* old payload */ }
  }
  const rs = store.rangeStats({ sepBelowDeg: 0.5, ...W });
  const profile = {
    nImminent: im.length,
    altitude: { medianM: round(median(alts), 0), p10M: round(pctile(alts, 10), 0), p90M: round(pctile(alts, 90), 0) },
    distance: { medianM: round(median(rngs), 0), p10M: round(pctile(rngs, 10), 0), p90M: round(pctile(rngs, 90), 0), maxM: round(maxOf(rngs), 0) },
    elevation: { medianDeg: round(median(elevs), 1), p10Deg: round(pctile(elevs, 10), 1), p90Deg: round(pctile(elevs, 90), 1) },
    rangeStats: rs,
    _elevs: elevs,            // retained for the recommendation engine (stripped in output)
  };

  // ---- d) drift -----------------------------------------------------------
  const acc = store.predictionAccuracy(W);
  const pm = db.prepare('SELECT predicted_at_ms AS p, actual_at_ms AS a FROM transit_postmortem').all();
  const tErrS = pm.filter((r) => Number.isFinite(r.p) && Number.isFinite(r.a)).map((r) => Math.abs(r.a - r.p) / 1000);
  const drift = {
    nPostmortem: pm.length,
    sep: { medianDeg: round(acc.drift?.p50, 3), meanDeg: round(acc.drift?.mean, 3), p95Deg: round(acc.drift?.p95, 3) },
    time: { medianS: round(median(tErrS), 1), meanS: round(mean(tErrS), 1), p95S: round(pctile(tErrS, 95), 1), n: tErrS.length },
  };

  // ---- c) triggers + actual arm history (optional table) -----------------
  const perDay = db.prepare(`SELECT date(closest_at_ms/1000,'unixepoch') AS d, COUNT(DISTINCT icao) AS n
                             FROM transit_history GROUP BY d`).all();
  const dayCounts = perDay.map((r) => r.n);
  const arms = readArmStats(db, spanDays);
  const triggers = {
    imminentEpisodes: imminent.length,
    candidatePlusEpisodes: candPlus.length,
    imminentPct: round(pct(imminent.length, nEpisodes), 1),
    candidatePlusPct: round(pct(candPlus.length, nEpisodes), 1),
    imminentPerDay: spanDays ? round(imminent.length / spanDays, 2) : null,
    candidatePlusPerDay: spanDays ? round(candPlus.length / spanDays, 2) : null,
    arms,                          // null if the capture_arms table doesn't exist yet
  };

  // ---- e) per day ---------------------------------------------------------
  const perDayStats = {
    activeDays: perDay.length,
    medianPerDay: median(dayCounts),
    meanPerDay: round(mean(dayCounts), 1),
    maxPerDay: maxOf(dayCounts),
    newIcaoPerDay: spanDays ? round(totalIcao / spanDays, 1) : null,
    newHighElevPerDay: spanDays ? round(highElev.count / spanDays, 1) : null,
  };

  // ---- g) accuracy by lead ------------------------------------------------
  const leadBuckets = [
    { key: '≥90 s', b: acc.buckets?.['>90s'] },
    { key: '30–60 s', b: acc.buckets?.['30-60s'] },
    { key: '<15 s', b: acc.buckets?.['<10s'] },
  ].filter((x) => x.b && x.b.n).map((x) => ({ lead: x.key, n: x.b.n, medianDeg: round(x.b.p50, 3), meanDeg: round(x.b.mean, 3), p95Deg: round(x.b.p95, 3) }));
  const mostExact = leadBuckets.slice().sort((a, b) => (a.medianDeg ?? 9) - (b.medianDeg ?? 9))[0] ?? null;
  const accuracy = {
    byLead: leadBuckets,
    mostExactLead: mostExact?.lead ?? null,
    mostExactMedianDeg: mostExact?.medianDeg ?? null,
    highElevMedianDeg: round(acc.stratified?.high?.['>90s']?.p50, 3),
    lowElevMedianDeg: round(acc.stratified?.low?.['>90s']?.p50, 3),
  };

  // ---- h) extras ----------------------------------------------------------
  const hs = store.hourStats({ sepBelowDeg: 0.5, minElevationDeg: 30, ...W });
  const ch = store.consolidatedHistory({ limit: 1_000_000, ...W });
  const leads = finite(ch.map((r) => r.leadTimeMs)).map((m) => m / 1000);
  const topFlights = store.topSightings({ kind: 'flight', limit: 8 }).filter((x) => x.visits > 1);
  const extras = {
    sunEpisodes: episodes.filter((e) => e.body === 'Sun').length,
    moonEpisodes: episodes.filter((e) => e.body === 'Moon').length,
    sunGrazes: agg.sunGrazes ?? 0,
    moonGrazes: agg.moonGrazes ?? 0,
    hitRatePct: round(agg.hitRatePct, 1),
    surpriseRatePct: round(agg.surpriseRatePct, 1),
    bestHour: hs?.peak?.all ?? null,
    sunPeakHour: hs?.peak?.Sun?.hour ?? null,
    moonPeakHour: hs?.peak?.Moon?.hour ?? null,
    leadTimeMedianMin: round(median(leads) / 60, 1),
    leadTimeP90Min: round(pctile(leads, 90) / 60, 1),
    hourHistogram: hs?.total ?? null,
    topFlights: topFlights.map((f) => ({ key: f.key, visits: f.visits })),
    weekday: readWeekdayStats(db),
    topRoutes: readTopRoutes(db),
  };

  // ---- directional corridor (idea 5) -------------------------------------
  // Fold each confirmed candidate's heading to an undirected axis (a route
  // produces both ~90° and ~270° tracks → one E–W axis) and bin into the four
  // compass axes. Tells the user which corridors actually produce transits at
  // their site — antenna-aiming + site-geometry insight.
  const corridor = computeCorridor(tracks);

  // ---- capture yield / precision (idea 2) --------------------------------
  // Join the persisted arms to genuine on-disc transits: of the captures we
  // actually fired, how many landed on a real <0.27° pass? The honest precision
  // signal for tuning maxSepDeg. Null until arms accumulate (v0.41.0+).
  const yieldStats = readYield(db);

  const report = {
    meta: {
      dbPath, generatedAtMs: nowMs,
      coverageDays: round(spanDays, 1), firstMs: Number.isFinite(firstMs) ? firstMs : null, lastMs,
      totalRows, totalEpisodes: nEpisodes, totalIcao, highElevCount: highElev.count,
    },
    regulars, candidates, triggers, drift, perDay: perDayStats, profile, accuracy, extras,
    corridor, yield: yieldStats,
  };
  report.recommendations = deriveRecommendations(report, sharpcap ?? {});
  delete report.profile._elevs;                 // strip the working array from output
  return report;
}

// ---- actual arm history (graceful: table may not exist yet) --------------
function readArmStats(db, spanDays) {
  try {
    // total = fired arms (re_arm=0); re-arms are time-refreshes of a pending
    // capture, reported separately so "how often a capture fired" is honest.
    const r = db.prepare(`SELECT
        SUM(CASE WHEN re_arm=0 THEN 1 ELSE 0 END) AS fired,
        SUM(CASE WHEN re_arm=1 THEN 1 ELSE 0 END) AS rearms,
        MIN(armed_at_ms) AS a, MAX(armed_at_ms) AS b FROM capture_arms`).get();
    const fired = r?.fired ?? 0;
    if (!fired && !(r?.rearms)) return { total: 0, reArms: 0, perDay: 0 };
    const byBody = db.prepare('SELECT body, COUNT(*) AS n FROM capture_arms WHERE re_arm=0 GROUP BY body').all();
    const days = Number.isFinite(r.a) && Number.isFinite(r.b) ? Math.max(1, (r.b - r.a) / DAY_MS) : (spanDays || 1);
    return {
      total: fired, reArms: r.rearms ?? 0,
      perDay: round(fired / days, 2),
      perBody: Object.fromEntries(byBody.map((x) => [x.body, x.n])),
    };
  } catch { return null; }       // table absent on an older DB — feature degrades cleanly
}

// ---- directional corridor (undirected heading axes) ----------------------
const CORRIDOR_AXES = ['N–S', 'NE–SW', 'E–W', 'NW–SE'];
function axisOf(trackDeg) {
  const a = ((trackDeg % 180) + 180) % 180;     // fold to [0,180): heading↔reciprocal
  if (a < 22.5 || a >= 157.5) return 'N–S';
  if (a < 67.5) return 'NE–SW';
  if (a < 112.5) return 'E–W';
  return 'NW–SE';
}
function computeCorridor(tracks) {
  if (!tracks.length) return { nTracks: 0, axes: [], dominant: null, dominantPct: null };
  const counts = Object.fromEntries(CORRIDOR_AXES.map((k) => [k, 0]));
  for (const t of tracks) counts[axisOf(t)] += 1;
  const axes = CORRIDOR_AXES.map((axis) => ({ axis, count: counts[axis], pct: round(pct(counts[axis], tracks.length), 1) }));
  const top = axes.slice().sort((a, b) => b.count - a.count)[0];
  return { nTracks: tracks.length, axes, dominant: top.axis, dominantPct: top.pct };
}

// ---- capture yield / precision (arms × on-disc transits) -----------------
function readYield(db) {
  try {
    // Of fired arms, how many coincided with a genuine on-disc (<0.27°)
    // confirmed transit of the same airframe within ±10 min of the arm.
    const r = db.prepare(`
      SELECT COUNT(*) AS fired,
        SUM(CASE WHEN EXISTS(
          SELECT 1 FROM transit_history h
          WHERE h.stage='imminent' AND h.closest_sep_deg IS NOT NULL AND h.closest_sep_deg < 0.27
            AND lower(h.icao) = lower(a.icao) AND h.body = a.body
            AND ABS(h.closest_at_ms - a.armed_at_ms) < 600000
        ) THEN 1 ELSE 0 END) AS hits
      FROM capture_arms a WHERE a.re_arm = 0`).get();
    const fired = r?.fired ?? 0;
    if (!fired) return null;
    const hits = r?.hits ?? 0;
    return { fired, hits, precisionPct: round(pct(hits, fired), 1) };
  } catch { return null; }
}

// ---- weekday distribution (local-time buckets) ---------------------------
function readWeekdayStats(db) {
  // SQLite %w: 0=Sunday … 6=Saturday (UTC). Good enough for a weekday shape.
  const rows = db.prepare(`SELECT CAST(strftime('%w', closest_at_ms/1000, 'unixepoch') AS INTEGER) AS w, COUNT(*) AS n
                           FROM transit_history WHERE stage='imminent' GROUP BY w`).all();
  const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const counts = new Array(7).fill(0);
  for (const r of rows) counts[r.w] = r.n;
  return NAMES.map((name, i) => ({ day: name, count: counts[i] }));
}

// ---- top routes (origin→destination) -------------------------------------
function readTopRoutes(db) {
  return db.prepare(`SELECT origin || '→' || destination AS route, COUNT(*) AS n
                     FROM transit_history
                     WHERE stage='imminent' AND origin IS NOT NULL AND destination IS NOT NULL
                     GROUP BY route ORDER BY n DESC LIMIT 8`).all().map((r) => ({ route: r.route, count: r.n }));
}

/**
 * Turn the measured distributions into concrete suggested config defaults.
 * Each item: { id, label, path, current, suggested, unit, rationale }.
 * `current` is filled in by the caller against live config where possible;
 * here we encode the SHIPPED defaults so the CLI/UI can show a delta.
 */
function deriveRecommendations(report, cfg) {
  const recs = [];
  const d = report.drift;
  const elevs = report.profile._elevs ?? [];

  // `current` reflects the LIVE config where available (a user's saved
  // service.json keeps its old values even after a default bump), with the
  // shipped default as the fallback. A rec is only emitted when current ≠
  // suggested, so the Apply list shows real, actionable deltas.
  const cur = (id, shipped) => (Number.isFinite(cfg?.[id]) ? cfg[id] : shipped);
  const push = (rec) => { if (rec.current !== rec.suggested) recs.push(rec); };

  // 1+2. Pre/post-roll. The transit framing only needs to straddle closest
  // approach; the TIME drift (median ~1.5 s, p95 ~27 s) is what must be
  // covered, asymmetrically (a late aircraft is the bigger risk than an early
  // one). 5 s before / 15 s after frames it tightly and keeps clips short.
  push({
    id: 'preBufferS', label: 'Pre-roll (record before closest approach)', path: 'sharpcap.preBufferS',
    current: cur('preBufferS', 5), suggested: 5, unit: 's',
    rationale: `Median closest-approach time error is only ${d.time.medianS ?? '?'} s, so a long lead wastes frames before the transit. 5 s is ample.`,
  });
  push({
    id: 'postBufferS', label: 'Post-roll (record after closest approach)', path: 'sharpcap.postBufferS',
    current: cur('postBufferS', 15), suggested: 15, unit: 's',
    rationale: `Bias the window AFTER the event: a late aircraft is the common miss (time p95 ≈ ${d.time.p95S ?? '?'} s). 15 s tail catches it without a long clip.`,
  });

  // 3. Drift fraction. leadDriftFrac:0.5 adds ±50% of the lead time on EACH
  // side — at a 60 s lead that is a 60 s longer clip. The re-arm mechanism
  // (reArmShiftS) already corrects a moved prediction, so the residual drift
  // to absorb is small. p95 time drift bounds it.
  const p95 = d.time.p95S ?? 30;
  const suggestedMaxDrift = Math.min(45, Math.max(15, Math.ceil(p95 / 5) * 5));   // round p95 up to 5 s
  push({
    id: 'leadDriftFrac', label: 'Lead-drift fraction (window widening per second of lead)', path: 'sharpcap.leadDriftFrac',
    current: cur('leadDriftFrac', 0.25), suggested: 0.25, unit: '',
    rationale: `A high fraction over-records — it widens the clip for early arms. Re-arming already corrects moved predictions; 0.25 keeps a safety margin without minute-long clips.`,
  });
  push({
    id: 'maxDriftS', label: 'Max drift margin (cap on the widening)', path: 'sharpcap.maxDriftS',
    current: cur('maxDriftS', 30), suggested: suggestedMaxDrift, unit: 's',
    rationale: `Set just above the measured p95 time error (${d.time.p95S ?? '?'} s) so 95% of arms are covered, the rest by re-arm.`,
  });

  // 4. Elevation floor — DATA-DRIVEN, site-specific (item 5). Many confirmed
  // candidates here sit below the current gate; lowering it to retain ~90%
  // of them captures more opportunities (the user is happy with 10–20° shots).
  if (elevs.length >= 20) {
    const floorNow = cur('minElevationDeg', 20);
    const p10 = pctile(elevs, 10);
    // Suggest a floor that keeps ~90% of confirmed candidates, clamped to a
    // sane visual range; round to 5°.
    const raw = Math.max(10, Math.min(20, Math.round((p10 ?? 15) / 5) * 5));
    const belowNow = elevs.filter((e) => e < floorNow).length;
    const gained = elevs.filter((e) => e >= raw && e < floorNow).length;
    if (raw < floorNow) {
      push({
        id: 'minElevationDeg', label: 'Capture elevation floor', path: 'sharpcap.minElevationDeg',
        current: floorNow, suggested: raw, unit: '°',
        rationale: `${round(pct(belowNow, elevs.length), 0)}% of your confirmed candidates were below ${floorNow}°. Lowering the floor to ${raw}° would re-include ${gained} of them (${round(pct(gained, elevs.length), 0)}% more) — you reported being happy with 10–20° passes; best on clear days.`,
      });
    }
  }

  return recs;
}

// ============================ formatters ===================================

const KM = (m) => (Number.isFinite(m) ? `${(m / 1000).toFixed(1)} km` : 'n/a');
const FT = (m) => (Number.isFinite(m) ? `${Math.round(m / 0.3048).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ft` : 'n/a');
const DEG = (x) => (Number.isFinite(x) ? `${x.toFixed(3)}°` : 'n/a');
const PP = (part, whole) => `${pct(part, whole).toFixed(1).padStart(5)}%  (${part} / ${whole})`;

/** Render the report as the human-readable text report (CLI + /api .txt). */
export function formatText(r) {
  const L = [];
  const p = (s = '') => L.push(s);
  const m = r.meta;
  p('═══ Sun/Moon transit history — all-time analysis ═══');
  if (m.dbPath) p(`DB:            ${m.dbPath}`);
  p(`Coverage:      ${m.coverageDays ?? '?'} days` + (m.firstMs ? `  (${iso(m.firstMs)} → ${iso(m.lastMs)})` : ''));
  p(`transit_history rows: ${m.totalRows}   ·   transit episodes: ${m.totalEpisodes}`);
  p(`Distinct aircraft ever seen (ADS-B): ${m.totalIcao}   ·   ever overhead ≥30°: ${m.highElevCount}`);

  const a = r.regulars;
  p('\na) How many of all aircraft ever seen come by REGULARLY');
  p(`Total distinct aircraft (ICAO):     ${a.totalIcao}`);
  p(`Seen again (≥2 visits):             ${PP(a.seenAgain, a.totalIcao)}`);
  p(`Frequent (≥5 visits):               ${PP(a.frequent, a.totalIcao)}`);
  p(`Regular (≥10 visits):               ${PP(a.regular, a.totalIcao)}`);
  p(`Returned on a different day:        ${PP(a.multiDay, a.totalIcao)}`);
  p(`Median / max visits per aircraft:   ${a.medianVisits ?? 'n/a'} / ${a.maxVisits ?? 'n/a'}`);

  const c = r.candidates;
  p('\nb) What % of transits were SERIOUS candidates (projected vs confirmed sep)');
  p(`Episodes with a separation value:   projected ${c.nProjected}  ·  time-confirmed ${c.nConfirmed}`);
  for (const b of c.buckets) {
    const tag = b.thresholdDeg === 0.3 ? ' (≈ disc radius)' : '';
    p(`  < ${b.thresholdDeg.toFixed(1)}°:  projected ${PP(b.projected, c.nProjected)}   ·   confirmed ${PP(b.confirmed, c.nConfirmed)}${tag}`);
  }
  p(`Median projected / tightest / tightest-confirmed: ${DEG(c.medianProjectedDeg)} / ${DEG(c.tightestDeg)} / ${DEG(c.tightestConfirmedDeg)}`);
  p(`Distinct aircraft <0.5°: of ≥30°-overhead ${c.funnelHighElevPct}%   ·   of ALL seen ${c.funnelAllPct}%  (the honest "serious candidate" rate)`);

  const t = r.triggers;
  p('\nc) How often a capture would (theoretically) have been TRIGGERED');
  p(`Reached 'imminent' (capture armed):  ${PP(t.imminentEpisodes, r.meta.totalEpisodes)} of episodes  ·  ${t.imminentPerDay}/day`);
  p(`Reached 'candidate' or better:       ${PP(t.candidatePlusEpisodes, r.meta.totalEpisodes)} of episodes  ·  ${t.candidatePlusPerDay}/day`);
  if (t.arms) p(`ACTUAL SharpCap arms recorded:       ${t.arms.total}  (${t.arms.perDay}/day, ${t.arms.reArms} re-arms${t.arms.perBody ? ', ' + Object.entries(t.arms.perBody).map(([k, v]) => `${k} ${v}`).join(' / ') : ''})`);
  else p('ACTUAL SharpCap arms recorded:       (not tracked on this DB yet — capture every arm from v0.41.0 on)');

  const d = r.drift;
  p('\nd) Typical computational DRIFT of a candidate (time & separation)');
  p(`Post-mortem episodes analysed:       ${d.nPostmortem}`);
  p(`Separation drift |final − best|:     median ${DEG(d.sep.medianDeg)}  ·  mean ${DEG(d.sep.meanDeg)}  ·  p95 ${DEG(d.sep.p95Deg)}`);
  p(`Closest-approach TIME shift:         median ${d.time.medianS ?? 'n/a'} s  ·  mean ${d.time.meanS ?? 'n/a'} s  ·  p95 ${d.time.p95S ?? 'n/a'} s  (n=${d.time.n})`);

  const e = r.perDay;
  p('\ne) Aircraft per DAY');
  p(`Active days with logged contacts:    ${e.activeDays}`);
  p(`Aircraft near Sun/Moon corridor/day: median ${e.medianPerDay ?? 'n/a'}  ·  mean ${e.meanPerDay ?? 'n/a'}  ·  max ${e.maxPerDay ?? 'n/a'}`);
  p(`New distinct aircraft ever-seen/day: ${e.newIcaoPerDay ?? 'n/a'}   ·   new overhead-≥30°/day: ${e.newHighElevPerDay ?? 'n/a'}`);

  const f = r.profile;
  p('\nf) Typical ALTITUDE / DISTANCE / ELEVATION of a real candidate');
  p(`Real (imminent) candidate rows:      ${f.nImminent}`);
  p(`Altitude:   median ${FT(f.altitude.medianM)} (${KM(f.altitude.medianM)})   ·   p10–p90 ${FT(f.altitude.p10M)} – ${FT(f.altitude.p90M)}`);
  p(`Distance:   median ${KM(f.distance.medianM)}   ·   p10–p90 ${KM(f.distance.p10M)} – ${KM(f.distance.p90M)}   ·   max ${KM(f.distance.maxM)}`);
  p(`Elevation:  median ${DEG(f.elevation.medianDeg)}   ·   p10–p90 ${DEG(f.elevation.p10Deg)} – ${DEG(f.elevation.p90Deg)}`);
  if (f.rangeStats?.n) p(`(sep<0.5°: n=${f.rangeStats.n}, on-disc <0.27° = ${f.rangeStats.onDisc}, Sun ${f.rangeStats.perBody?.Sun ?? 0} / Moon ${f.rangeStats.perBody?.Moon ?? 0})`);

  const g = r.accuracy;
  p('\ng) WHEN is the separation prediction most EXACT (by lead time)');
  for (const b of g.byLead) p(`  ${b.lead.padEnd(8)} n=${String(b.n).padStart(4)}   median err ${DEG(b.medianDeg)}  ·  mean ${DEG(b.meanDeg)}  ·  p95 ${DEG(b.p95Deg)}`);
  if (g.mostExactLead) p(`→ Most exact at: ${g.mostExactLead} before closest approach (median err ${DEG(g.mostExactMedianDeg)}).`);
  if (g.highElevMedianDeg != null || g.lowElevMedianDeg != null) p(`  At ≥90 s: high-elev (cruise) ${DEG(g.highElevMedianDeg)} vs low-elev ${DEG(g.lowElevMedianDeg)} — higher = steadier.`);

  const h = r.extras;
  p('\nh) Also worth knowing');
  p(`Sun vs Moon episodes:                Sun ${PP(h.sunEpisodes, r.meta.totalEpisodes)}  ·  Moon ${PP(h.moonEpisodes, r.meta.totalEpisodes)}`);
  p(`Disc grazes (confirmed <0.3°):       Sun ${h.sunGrazes}  ·  Moon ${h.moonGrazes}  (total ${h.sunGrazes + h.moonGrazes})`);
  if (h.hitRatePct != null) p(`Early-warning hit rate:              ${h.hitRatePct}%   ·   surprises (no early radio): ${h.surpriseRatePct}%`);
  if (h.bestHour) p(`Best local hour for usable transits: ${String(h.bestHour.hour).padStart(2, '0')}:00 (${h.bestHour.count} passes; Sun ${h.sunPeakHour ?? '?'}h, Moon ${h.moonPeakHour ?? '?'}h)`);
  if (h.leadTimeMedianMin != null) p(`Typical first-warning lead time:     median ${h.leadTimeMedianMin} min  ·  p90 ${h.leadTimeP90Min} min`);
  if (h.weekday?.length) p(`Weekday (confirmed): ${h.weekday.map((w) => `${w.day} ${w.count}`).join(' · ')}`);
  if (h.topRoutes?.length) p(`Top routes: ${h.topRoutes.slice(0, 5).map((x) => `${x.route} (${x.count})`).join(' · ')}`);
  if (h.topFlights?.length) p(`Top flights: ${h.topFlights.slice(0, 6).map((x) => `${x.key} (${x.visits})`).join(' · ')}`);

  const co = r.corridor;
  if (co?.nTracks) {
    p('\ni) Directional CORRIDOR (which axes produce transits — antenna aiming)');
    p(`  ${co.axes.map((x) => `${x.axis} ${x.pct}%`).join('  ·  ')}   (n=${co.nTracks})`);
    p(`→ Your transits arrive mostly along the ${co.dominant} axis (${co.dominantPct}%) — make sure the ADS-B antenna has a clear horizon that way.`);
  }
  const y = r.yield;
  p('\nj) Capture YIELD (of armed captures, how many hit a real on-disc transit)');
  if (y) p(`  ${y.hits} / ${y.fired} fired arms landed on a confirmed <0.27° transit → precision ${y.precisionPct}%.`);
  else p('  (not enough arm history yet — captured from v0.41.0; check back once arms accumulate.)');

  p('\n— Recommended defaults from YOUR data —');
  for (const rec of r.recommendations) {
    p(`• ${rec.label}: ${rec.current}${rec.unit} → \x1b[1m${rec.suggested}${rec.unit}\x1b[0m`);
    p(`    ${rec.rationale}`);
  }
  p('\n(Separations are projected closest-approach degrees unless marked confirmed; an episode = one flyby across radio→candidate→imminent stages; ISS excluded.)');
  return L.join('\n');
}

/** Render the report as a flat, plot-friendly long-format CSV. */
export function formatCsv(r) {
  const rows = [['category', 'key', 'value', 'unit']];
  const add = (cat, key, value, unit = '') => rows.push([cat, key, value ?? '', unit]);
  add('meta', 'coverage_days', r.meta.coverageDays, 'days');
  add('meta', 'total_episodes', r.meta.totalEpisodes);
  add('meta', 'distinct_aircraft', r.meta.totalIcao);
  add('meta', 'high_elev_aircraft', r.meta.highElevCount);
  add('regulars', 'seen_again_ge2', r.regulars.seenAgain);
  add('regulars', 'frequent_ge5', r.regulars.frequent);
  add('regulars', 'regular_ge10', r.regulars.regular);
  add('regulars', 'median_visits', r.regulars.medianVisits);
  for (const b of r.candidates.buckets) {
    add('sep_projected', `lt_${b.thresholdDeg}`, b.projected, 'episodes');
    add('sep_confirmed', `lt_${b.thresholdDeg}`, b.confirmed, 'episodes');
  }
  add('drift', 'sep_median_deg', r.drift.sep.medianDeg, 'deg');
  add('drift', 'sep_p95_deg', r.drift.sep.p95Deg, 'deg');
  add('drift', 'time_median_s', r.drift.time.medianS, 's');
  add('drift', 'time_p95_s', r.drift.time.p95S, 's');
  for (const b of r.accuracy.byLead) add('accuracy_by_lead', b.lead, b.medianDeg, 'deg_median_err');
  add('profile', 'altitude_median_m', r.profile.altitude.medianM, 'm');
  add('profile', 'distance_median_m', r.profile.distance.medianM, 'm');
  add('profile', 'elevation_median_deg', r.profile.elevation.medianDeg, 'deg');
  add('triggers', 'imminent_per_day', r.triggers.imminentPerDay, '/day');
  if (r.triggers.arms) add('triggers', 'actual_arms', r.triggers.arms.total);
  if (Array.isArray(r.extras.hourHistogram)) r.extras.hourHistogram.forEach((n, h) => add('hour_histogram', String(h), n, 'passes'));
  for (const w of (r.extras.weekday ?? [])) add('weekday', w.day, w.count, 'passes');
  for (const x of (r.extras.topRoutes ?? [])) add('top_route', x.route, x.count);
  for (const ax of (r.corridor?.axes ?? [])) add('corridor_axis', ax.axis, ax.count, 'passes');
  if (r.yield) { add('yield', 'fired_arms', r.yield.fired); add('yield', 'on_disc_hits', r.yield.hits); add('yield', 'precision_pct', r.yield.precisionPct, '%'); }
  for (const rec of r.recommendations) add('recommendation', rec.id, rec.suggested, rec.unit);
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
