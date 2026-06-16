#!/usr/bin/env node
// Offline history analysis (v0.40.0) — a founded, all-time statistical report
// over the local SQLite history DB (data/history.db). Read-only intent: it
// only ever SELECTs (the HistoryStore constructor runs idempotent CREATE TABLE
// IF NOT EXISTS migrations, harmless against the live DB under WAL).
//
// Run ON THE PI, from the repo root, with the same Node the service uses:
//   node --experimental-sqlite scripts/analyze-history.js
//   node --experimental-sqlite scripts/analyze-history.js /path/to/history.db
// (Node 24+ has node:sqlite stable, so the flag is optional there.)
//
// Answers, each in ABSOLUTE and PERCENTAGE terms:
//   a. how many of all aircraft ever seen come by regularly
//   b. what % of transits were serious candidates (<0.2°, <0.5°, …)
//   c. how often a capture would (theoretically) have been triggered
//   d. the typical computational drift of a candidate in time and separation
//   e. aircraft per day
//   f. the typical altitude / distance / elevation of a real candidate
//   g. at which lead time the separation prediction is most exact
//   h. extras: Sun vs Moon, best hour, lead time, graze rate, top visitors

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 24 * 3600 * 1000;
const ALL_WINDOW_MS = 3650 * DAY_MS;        // ~10 years = "all time"

// ---- tiny stats helpers ---------------------------------------------------
const nums = (a) => a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
const median = (a) => { const s = nums(a); return s.length ? pctile(s, 50) : null; };
const mean = (a) => { const s = nums(a); return s.length ? s.reduce((p, c) => p + c, 0) / s.length : null; };
function pctile(sortedOrRaw, p) {
  const s = sortedOrRaw.every((v, i, arr) => i === 0 || arr[i - 1] <= v) ? sortedOrRaw : nums(sortedOrRaw);
  if (!s.length) return null;
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
const pct = (part, whole) => (whole > 0 ? (100 * part / whole) : 0);
// "  12.3%  (123 / 1000)"
const PP = (part, whole) => `${pct(part, whole).toFixed(1).padStart(5)}%  (${part} / ${whole})`;
const km = (m) => (Number.isFinite(m) ? `${(m / 1000).toFixed(1)} km` : 'n/a');
// Force comma thousands regardless of the host locale (a German-locale Pi
// would otherwise render 32480 as "32.480" via toLocaleString — misleading).
const ft = (m) => (Number.isFinite(m) ? `${Math.round(m / 0.3048).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ft` : 'n/a');
const deg = (d) => (Number.isFinite(d) ? `${d.toFixed(3)}°` : 'n/a');
const days = (ms) => (Number.isFinite(ms) ? (ms / DAY_MS) : null);
const H = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ---- resolve DB path ------------------------------------------------------
function resolveDbPath() {
  const arg = process.argv[2];
  if (arg) return resolve(arg);
  // config/service.json store.path, else the documented default
  try {
    const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'service.json'), 'utf8'));
    if (cfg?.store?.path) return resolve(REPO_ROOT, cfg.store.path);
  } catch { /* no user config — fall through */ }
  return join(REPO_ROOT, 'data', 'history.db');
}

async function main() {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    console.error(`No history DB at ${dbPath}\nPass the path explicitly: node --experimental-sqlite scripts/analyze-history.js /path/to/history.db`);
    process.exit(1);
  }

  let HistoryStore;
  try {
    ({ HistoryStore } = await import('../src/store.js'));
  } catch (e) {
    console.error('Failed to load the SQLite layer. On Node 22/23 run with the flag:\n  node --experimental-sqlite scripts/analyze-history.js\n\n' + (e?.message ?? e));
    process.exit(1);
  }

  const store = new HistoryStore(dbPath);
  const db = store.db;                       // raw handle for the few custom queries
  const nowMs = Date.now();
  const W = { windowMs: ALL_WINDOW_MS, nowMs };

  // ---- coverage / denominators -------------------------------------------
  const totalRows = store.count();
  const sight = store.sightingTotals();
  const totalIcao = sight.icao.distinctKeys;
  const highElev = store.highElevTotals();   // distinct ICAO ever ≥30°, + tracking start
  const span = db.prepare(
    'SELECT MIN(recorded_at_ms) AS a, MAX(recorded_at_ms) AS b FROM transit_history',
  ).get();
  const firstMs = Math.min(...[span?.a, highElev.sinceMs].filter(Number.isFinite));
  const lastMs = span?.b ?? nowMs;
  const spanDays = Number.isFinite(firstMs) ? Math.max(1, days(lastMs - firstMs)) : null;

  const ep = store.episodes(W);              // all transit episodes (ISS excluded), + aggregates
  const episodes = ep.episodes;
  const agg = ep.aggregates;
  const nEpisodes = episodes.length;
  const imminent = episodes.filter((e) => e.stages.includes('imminent'));
  const candPlus = episodes.filter((e) => e.stages.includes('candidate') || e.stages.includes('imminent'));

  console.log('\x1b[1m═══ Sun/Moon transit history — all-time analysis ═══\x1b[0m');
  console.log(`DB:            ${dbPath}`);
  console.log(`Coverage:      ${spanDays ? spanDays.toFixed(1) : '?'} days` +
    (Number.isFinite(firstMs) ? `  (${new Date(firstMs).toISOString().slice(0, 10)} → ${new Date(lastMs).toISOString().slice(0, 10)})` : ''));
  console.log(`transit_history rows: ${totalRows}   ·   transit episodes: ${nEpisodes}`);
  console.log(`Distinct aircraft ever seen (ADS-B): ${totalIcao}   ·   ever overhead ≥30°: ${highElev.count}`);

  // ===================================================================== a.
  H('a) How many of all aircraft ever seen come by REGULARLY');
  // aircraft_sightings: a "visit" = a fresh sighting after a ≥30 min gap; the
  // visits column is the recurrence signal. (Tracks ALL traffic, not transits.)
  const sights = db.prepare(
    "SELECT visits, first_seen_ms AS f, last_seen_ms AS l FROM aircraft_sightings WHERE kind='icao'",
  ).all();
  const ge = (n) => sights.filter((s) => s.visits >= n).length;
  const multiDay = sights.filter((s) => s.visits > 1 && (s.l - s.f) >= DAY_MS).length;
  console.log(`Total distinct aircraft (ICAO):     ${totalIcao}`);
  console.log(`Seen again (≥2 visits):             ${PP(ge(2), totalIcao)}`);
  console.log(`Frequent (≥5 visits):               ${PP(ge(5), totalIcao)}`);
  console.log(`Regular (≥10 visits):               ${PP(ge(10), totalIcao)}`);
  console.log(`Returned on a different day:        ${PP(multiDay, totalIcao)}`);
  console.log(`Median / max visits per aircraft:   ${median(sights.map((s) => s.visits)) ?? 'n/a'} / ${sights.length ? Math.max(...sights.map((s) => s.visits)) : 'n/a'}`);
  console.log('(A "visit" = a fresh sighting after a ≥30 min gap; continuous loiter stays one visit.)');

  // ===================================================================== b.
  H('b) What % of transits were SERIOUS candidates (by closest separation)');
  // One value per episode = its tightest projected separation (minSepDeg).
  const seps = episodes.map((e) => e.minSepDeg).filter(Number.isFinite);
  const nSep = seps.length;
  const below = (t) => seps.filter((s) => s < t).length;
  const BUCKETS = [0.1, 0.2, 0.3, 0.5, 1.0, 2.0];
  console.log(`Episodes with a usable separation value: ${nSep}`);
  for (const t of BUCKETS) {
    const tag = t === 0.3 ? ' (≈ disc radius — a graze/hit)' : '';
    console.log(`  < ${t.toFixed(1)}°:  ${PP(below(t), nSep)}${tag}`);
  }
  console.log(`Median / tightest episode separation:    ${deg(median(seps))} / ${deg(nSep ? Math.min(...seps) : null)}`);
  // Funnel framing against the wider populations — numerator is DISTINCT
  // aircraft that ever reached the band (not episode count, which double-counts
  // an aircraft that transited more than once).
  const distinctBelow = (t) => new Set(episodes.filter((e) => Number.isFinite(e.minSepDeg) && e.minSepDeg < t).map((e) => e.icao)).size;
  const d05 = distinctBelow(0.5);
  if (highElev.count) console.log(`Of all aircraft ever overhead ≥30°, reached <0.5°: ${PP(d05, highElev.count)}  (distinct aircraft — the real "serious candidate" rate)`);
  if (totalIcao) console.log(`Of ALL aircraft ever seen, reached <0.5°:           ${PP(d05, totalIcao)}  (distinct aircraft)`);

  // ===================================================================== c.
  H('c) How often a capture would (theoretically) have been TRIGGERED');
  // The SharpCap trigger arms once an episode reaches the time-confirmed
  // 'imminent' stage (the capture-verdict 'confirmed' path). 'candidate' is
  // the earlier projected band. This is the theoretical upper bound — the
  // actual rig also applies its own sep/elevation/dedup gates.
  console.log(`Reached 'imminent' (capture armed):  ${PP(imminent.length, nEpisodes)} of episodes`);
  console.log(`Reached 'candidate' or better:       ${PP(candPlus.length, nEpisodes)} of episodes`);
  if (spanDays) {
    console.log(`Triggered captures per day (avg):    ${(imminent.length / spanDays).toFixed(2)}`);
    console.log(`Candidate-or-better per day (avg):   ${(candPlus.length / spanDays).toFixed(2)}`);
  }

  // ===================================================================== d.
  H('d) Typical computational DRIFT of a candidate (time & separation)');
  const acc = store.predictionAccuracy(W);
  // Time drift: |final closest-approach time − initial prediction|.
  const pm = db.prepare(
    'SELECT predicted_at_ms AS p, actual_at_ms AS a, best_sep_deg AS best, final_sep_deg AS fin, drift_deg AS drift FROM transit_postmortem',
  ).all();
  const tErrS = pm.filter((r) => Number.isFinite(r.p) && Number.isFinite(r.a)).map((r) => Math.abs(r.a - r.p) / 1000);
  console.log(`Post-mortem episodes analysed:       ${pm.length}`);
  console.log('Separation drift  |final − best|:');
  console.log(`    median ${deg(acc.drift?.p50)}   ·   mean ${deg(acc.drift?.mean)}   ·   p95 ${deg(acc.drift?.p95)}`);
  console.log('Closest-approach TIME shift  |final − first prediction|:');
  console.log(`    median ${median(tErrS)?.toFixed(1) ?? 'n/a'} s   ·   mean ${mean(tErrS)?.toFixed(1) ?? 'n/a'} s   ·   p95 ${pctile(tErrS, 95)?.toFixed(1) ?? 'n/a'} s   (n=${tErrS.length})`);

  // ===================================================================== e.
  H('e) Aircraft per DAY');
  // Distinct aircraft that entered the Sun/Moon corridor (got logged), per day.
  const perDay = db.prepare(
    `SELECT date(closest_at_ms/1000,'unixepoch') AS d, COUNT(DISTINCT icao) AS n
     FROM transit_history GROUP BY d`,
  ).all();
  const dayCounts = perDay.map((r) => r.n);
  console.log(`Active days with logged contacts:    ${perDay.length}`);
  console.log(`Aircraft near Sun/Moon corridor/day: median ${median(dayCounts) ?? 'n/a'}   ·   mean ${mean(dayCounts)?.toFixed(1) ?? 'n/a'}   ·   max ${dayCounts.length ? Math.max(...dayCounts) : 'n/a'}`);
  if (spanDays) {
    console.log(`New distinct aircraft ever-seen/day:  ${(totalIcao / spanDays).toFixed(1)}  (all traffic, first-seen basis)`);
    console.log(`New overhead-≥30° aircraft/day:       ${(highElev.count / spanDays).toFixed(1)}`);
  }

  // ===================================================================== f.
  H('f) Typical ALTITUDE / DISTANCE / ELEVATION of a real candidate');
  // Real candidate = an 'imminent' transit_history row (time-confirmed pass).
  const im = db.prepare(
    "SELECT altitude_m AS alt, range_m AS rng, payload_json AS pj FROM transit_history WHERE stage='imminent'",
  ).all();
  const alts = [], rngs = [], elevs = [];
  for (const r of im) {
    if (Number.isFinite(r.alt)) alts.push(r.alt);
    if (Number.isFinite(r.rng)) rngs.push(r.rng);
    try {
      const el = JSON.parse(r.pj)?.candidate?.aircraftAtClosest?.elevationDeg;
      if (Number.isFinite(el)) elevs.push(el);
    } catch { /* old/short payload */ }
  }
  const rs = store.rangeStats({ sepBelowDeg: 0.5, ...W });
  console.log(`Real (imminent) candidate rows:      ${im.length}`);
  console.log(`Altitude:   median ${ft(median(alts))} (${km(median(alts))})   ·   p10–p90 ${ft(pctile(alts, 10))} – ${ft(pctile(alts, 90))}`);
  console.log(`Distance:   median ${km(median(rngs))}   ·   p10–p90 ${km(pctile(rngs, 10))} – ${km(pctile(rngs, 90))}   ·   max ${km(rngs.length ? Math.max(...rngs) : null)}`);
  console.log(`Elevation:  median ${deg(median(elevs))}   ·   p10–p90 ${deg(pctile(elevs, 10))} – ${deg(pctile(elevs, 90))}`);
  if (rs?.n) console.log(`(rangeStats over sep<0.5°: n=${rs.n}, on-disc <0.27° = ${rs.onDisc}, Sun ${rs.perBody?.Sun ?? 0} / Moon ${rs.perBody?.Moon ?? 0})`);

  // ===================================================================== g.
  H('g) WHEN is the separation prediction most EXACT (by lead time)');
  // Error = |projected sep at lead X − tightest (best) sep|. Smaller = better.
  const row = (k, b) => b && b.n
    ? `  ${k.padEnd(7)} n=${String(b.n).padStart(4)}   median err ${deg(b.p50)}   ·   mean ${deg(b.mean)}   ·   p95 ${deg(b.p95)}`
    : `  ${k.padEnd(7)} (no data)`;
  console.log(row('≥90 s', acc.buckets?.['>90s']));
  console.log(row('30–60s', acc.buckets?.['30-60s']));
  console.log(row('<15 s', acc.buckets?.['<10s']));
  const order = [['≥90 s', acc.buckets?.['>90s']], ['30–60 s', acc.buckets?.['30-60s']], ['<15 s', acc.buckets?.['<10s']]]
    .filter(([, b]) => b && b.n).sort((x, y) => (x[1].p50 ?? 9) - (y[1].p50 ?? 9));
  if (order.length) console.log(`→ Most exact at: \x1b[1m${order[0][0]} before closest approach\x1b[0m (median error ${deg(order[0][1].p50)}).`);
  if (acc.stratified) {
    const hi = acc.stratified.high?.['>90s'], lo = acc.stratified.low?.['>90s'];
    if (hi?.n || lo?.n) console.log(`  At ≥90 s, high-elev (≥30°, cruise) median err ${deg(hi?.p50)} vs low-elev ${deg(lo?.p50)} — higher = steadier.`);
  }

  // ===================================================================== h.
  H('h) Also worth knowing');
  // Sun vs Moon
  const sun = episodes.filter((e) => e.body === 'Sun').length;
  const moon = episodes.filter((e) => e.body === 'Moon').length;
  console.log(`Sun vs Moon episodes:                Sun ${PP(sun, nEpisodes)}  ·  Moon ${PP(moon, nEpisodes)}`);
  console.log(`Disc grazes (<0.3°):                 Sun ${agg.sunGrazes ?? 0}  ·  Moon ${agg.moonGrazes ?? 0}  (total ${PP((agg.sunGrazes ?? 0) + (agg.moonGrazes ?? 0), nEpisodes)} of episodes)`);
  if (Number.isFinite(agg.hitRatePct)) console.log(`Early-warning hit rate (radio→tighter): ${agg.hitRatePct.toFixed(1)}%   ·   surprises (no early radio): ${agg.surpriseRatePct?.toFixed?.(1) ?? '?'}%`);
  // Best hour of day (local)
  const hs = store.hourStats({ sepBelowDeg: 0.5, minElevationDeg: 30, ...W });
  if (hs?.peak?.all) console.log(`Best local hour for usable transits: ${String(hs.peak.all.hour).padStart(2, '0')}:00  (${hs.peak.all.count} passes; Sun peak ${hs.peak.Sun ? hs.peak.Sun.hour + ':00' : 'n/a'}, Moon peak ${hs.peak.Moon ? hs.peak.Moon.hour + ':00' : 'n/a'})`);
  // Typical first-warning lead time
  const ch = store.consolidatedHistory({ limit: 1_000_000, ...W });
  const leads = ch.map((r) => r.leadTimeMs).filter(Number.isFinite).map((m) => m / 1000);
  if (leads.length) console.log(`Typical first-warning lead time:     median ${(median(leads) / 60).toFixed(1)} min  ·  p90 ${(pctile(leads, 90) / 60).toFixed(1)} min`);
  // Top recurring flights/airlines
  const topF = store.topSightings({ kind: 'flight', limit: 8 }).filter((x) => x.visits > 1);
  if (topF.length) {
    console.log('Most frequent flights (by visits):');
    for (const f of topF.slice(0, 8)) console.log(`    ${String(f.key).padEnd(10)} ${f.visits} visits`);
  }

  console.log('\n(Notes: separations are PROJECTED closest-approach values in degrees; an episode = one ' +
    'aircraft flyby grouped across its radio→candidate→imminent stages; ISS is excluded from episode stats. ' +
    'Percent denominators are stated inline.)');

  store.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
