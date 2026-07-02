#!/usr/bin/env node
// Event-driven "pre-run" TLE refresh guard (v0.53.0).
//
// Why this exists: prediction confidence is rated from the TLE age AT THE EVENT
// (src/skyplan.js) — green only when < 1 day old at the event. For an ISS pass
// in the small hours, the daily 05:40 cron refresh is BOTH too coarse and
// mistimed, so the run is predicted with a 1-2 day-old TLE → only 🟡 medium. A
// photographer wants maximum reliability, so we refresh AHEAD of a run instead
// of waiting for a fixed schedule.
//
// This guard is cheap and event-driven: it asks the LOCAL running service what
// ISS events are coming up (it never re-runs SGP4 itself) and fetches a fresh
// TLE ONLY when a run is within STP_TLE_LEAD_H and the current TLE is older than
// STP_TLE_FRESH_H. On quiet days (no ISS run within the window) it does nothing
// — zero Celestrak load. Run it from a short systemd timer (stp-tle-guard.timer,
// every ~3 h); the frequent tick is just the check, the FETCH is triggered by
// the upcoming run. Keeping the TLE < ~13 h old through the pre-run window means
// the event is predicted with a < 1-day TLE → 🟢 green.
//
// Config via env (all optional):
//   STP_STATE_URL   where the running service is   (default http://127.0.0.1:8081)
//   STP_TLE_LEAD_H  refresh once a run is within N hours   (default 24)
//   STP_TLE_FRESH_H ...but only if the TLE is older than N hours (default 10)

import { fetchOne, SATS } from './refresh-tle.js';

const STATE_URL = (process.env.STP_STATE_URL || process.env.STP_CONFIG_URL || 'http://127.0.0.1:8081')
  .replace(/\/+$/, '');
const LEAD_H = Number(process.env.STP_TLE_LEAD_H || 24);
const FRESH_H = Number(process.env.STP_TLE_FRESH_H || 10);
const STATE_TIMEOUT_MS = 4000;

function log(...a) { console.log('[auto-refresh-tle]', ...a); }

/** GET the live /api/state from the local service (short timeout, throws on error). */
async function fetchState() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${STATE_URL}/api/state`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Every upcoming ISS event time (ms) the service already knows about: the next
 *  naked-eye visible pass, the next Sun/Moon transit, and any ISS sky-target
 *  (field/transit) pass in the current plan. We only need the soonest. */
function upcomingIssEventMs(state, nowMs) {
  const out = [];
  const iss = state.iss ?? {};
  if (Number.isFinite(iss.visiblePass?.startMs)) out.push(iss.visiblePass.startMs);
  if (Number.isFinite(iss.nextTransit?.atMs)) out.push(iss.nextTransit.atMs);
  if (Number.isFinite(iss.nextAtMs)) out.push(iss.nextAtMs);
  for (const r of state.skyTargetPlan ?? []) {
    if ((r.satTag === 'ISS' || r.satName === 'ISS') && Number.isFinite(r.atMs)) out.push(r.atMs);
  }
  return out.filter((t) => t >= nowMs);
}

async function main() {
  let state;
  try {
    state = await fetchState();
  } catch (e) {
    // The service being down is not this guard's problem — the daily timer still
    // covers the baseline. Log once and exit success so the timer stays quiet.
    log(`service not reachable at ${STATE_URL} (${e?.message ?? e}) — skipping`);
    return;
  }

  const nowMs = Number.isFinite(state.nowMs) ? state.nowMs : Date.now();
  const events = upcomingIssEventMs(state, nowMs);
  if (!events.length) { log(`no upcoming ISS event known — nothing to do`); return; }

  const soonestMs = Math.min(...events);
  const leadH = (soonestMs - nowMs) / 3600_000;
  if (leadH > LEAD_H) {
    log(`next ISS event in ${leadH.toFixed(1)} h (> lead ${LEAD_H} h) — too early, skipping`);
    return;
  }

  // TLE age reported by the service (days → hours). If it is missing we cannot
  // judge freshness, so refresh to be safe (an imminent run is worth one fetch).
  const ageH = Number.isFinite(state.iss?.tleAgeDays) ? state.iss.tleAgeDays * 24 : Infinity;
  if (ageH < FRESH_H) {
    log(`ISS event in ${leadH.toFixed(1)} h but TLE only ${ageH.toFixed(1)} h old `
      + `(< fresh ${FRESH_H} h) — already fresh, skipping`);
    return;
  }

  log(`ISS event in ${leadH.toFixed(1)} h and TLE ${Number.isFinite(ageH) ? ageH.toFixed(1) + ' h' : 'unknown'} `
    + `old → fetching fresh TLEs now so the run is predicted with a < 1-day TLE`);
  let ok = 0;
  let failed = 0;
  for (const sat of SATS) {
    try { await fetchOne(sat); ok += 1; }
    catch (e) { failed += 1; console.error(`[auto-refresh-tle] ${sat.catnr} failed:`, e?.message ?? e); }
  }
  log(`done: ${ok} ok, ${failed} failed`);
  // The running service reloads data/iss.tle on its next tick (src/service.js),
  // so the confidence upgrades to green within seconds — no restart needed.
  if (ok === 0) process.exit(1);
}

main().catch((e) => {
  console.error('[auto-refresh-tle] failed:', e?.message ?? e);
  process.exit(1);
});
