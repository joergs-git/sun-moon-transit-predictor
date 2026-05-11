// Candidate lifecycle state machine.
//
// The tracker only sees the next 60–300 s of live ADS-B. The predictor sees
// 24 h of history-based "expected today" entries. Pushovers fire on stage
// transitions. The UI needs a single, dynamic list that combines all of
// these and survives across ticks so the user can see entries change status
// without them disappearing the moment they stop being a transit match.
//
// This module is that combined view.
//
// Status taxonomy (matches the user's UX request):
//   - 'planned'  : from the predictor watchlist, expected within
//                  `plannedWindowMs` (default 1 h). No live ADS-B match yet.
//   - 'radio'    : ADS-B sees the aircraft in the area; tracker projects min
//                  separation inside [thresholdDeg, looseThresholdDeg].
//   - 'candidate': tracker projects min separation ≤ thresholdDeg, more than
//                  `imminentWindowMs` away from closest approach.
//   - 'imminent' : within ±imminentWindowMs of closestApproachAtMs.
//   - 'stale'    : was actively matched on a previous tick but is not in the
//                  current tracker output any more — held for `staleGraceMs`
//                  (default 10 s) so the UI can show "no longer a candidate"
//                  briefly, then dropped.

const HOUR_MS = 3600_000;
const DEFAULT_PLANNED_WINDOW_MS = HOUR_MS;
const DEFAULT_IMMINENT_WINDOW_MS = 30_000;
const DEFAULT_STALE_GRACE_MS = 10_000;

/**
 * @typedef {Object} LifecycleEntry
 * @property {string} key
 * @property {'planned'|'radio'|'candidate'|'imminent'|'stale'} status
 * @property {'Sun'|'Moon'} body
 * @property {string|null} icao
 * @property {string|null} flight
 * @property {string|null} callsign
 * @property {number} closestApproachAtMs
 * @property {number|null} closestApproachSepDeg
 * @property {number} firstSeenMs
 * @property {number} lastUpdateMs
 * @property {string|null} highestStatusReached
 * @property {object|null} route
 * @property {object|null} candidate     - raw tracker output (when applicable)
 * @property {object|null} watchlistEntry
 */

const STATUS_ORDER = { planned: 0, radio: 1, candidate: 2, imminent: 3, stale: -1 };

function keyForTracker(c) {
  return `${c.icao}|${c.body}`;
}
function keyForExpected(e) {
  return `flight:${e.flight}|${e.body}`;
}

/**
 * Merge live tracker candidates, predictor expected events, and the previous
 * tick's lifecycle map into the next lifecycle map.
 *
 * @param {{
 *   prev: Map<string, LifecycleEntry>,
 *   nowMs: number,
 *   trackerCandidates: Array<object>,     - from findTransits, may include level + route
 *   expected: Array<object>,              - from predictor.upcomingExpected
 *   liveAircraft: Array<{ icao: string, callsign: string|null }>,
 *   imminentWindowMs?: number,
 *   plannedWindowMs?: number,
 *   staleGraceMs?: number,
 * }} args
 * @returns {Map<string, LifecycleEntry>}
 */
export function updateLifecycle({
  prev,
  nowMs,
  trackerCandidates,
  expected,
  liveAircraft,
  imminentWindowMs = DEFAULT_IMMINENT_WINDOW_MS,
  plannedWindowMs = DEFAULT_PLANNED_WINDOW_MS,
  staleGraceMs = DEFAULT_STALE_GRACE_MS,
}) {
  /** @type {Map<string, LifecycleEntry>} */
  const next = new Map();
  const touched = new Set();

  // ---------- 1. Live tracker candidates (highest priority signal) ----------
  for (const c of trackerCandidates) {
    const key = keyForTracker(c);
    const tMs = c.closestApproachAtMs - nowMs;
    const inImminentWindow = tMs <= imminentWindowMs && tMs > -imminentWindowMs;
    /** @type {'radio'|'candidate'|'imminent'} */
    let status;
    if (c.level === 'candidate' && inImminentWindow) {
      status = 'imminent';
    } else if (c.level === 'candidate') {
      status = 'candidate';
    } else {
      status = 'radio';
    }
    const prevEntry = prev.get(key);
    const highest = bestStatus(prevEntry?.highestStatusReached, status);
    next.set(key, {
      key,
      status,
      body: c.body,
      icao: c.icao,
      flight: c.route?.flight ?? c.callsign ?? null,
      callsign: c.callsign ?? null,
      closestApproachAtMs: c.closestApproachAtMs,
      closestApproachSepDeg: c.closestApproachSepDeg,
      firstSeenMs: prevEntry?.firstSeenMs ?? nowMs,
      lastUpdateMs: nowMs,
      highestStatusReached: highest,
      route: c.route ?? prevEntry?.route ?? null,
      candidate: c,
      watchlistEntry: prevEntry?.watchlistEntry ?? null,
    });
    touched.add(key);
  }

  // ---------- 2. Predictor watchlist entries within the planned window ----------
  // Cross-reference with live ADS-B: if the callsign is currently on air
  // *but* the tracker did not report a transit candidate, we still keep
  // status='planned' (the aircraft is in the air, the predicted slot is near,
  // it just isn't on the line of sight yet). If it IS reported by the
  // tracker, the loop above already produced a higher-status entry which we
  // do not overwrite.
  const liveCallsigns = new Set(
    liveAircraft.map(a => a.callsign).filter(Boolean).map(s => s.toUpperCase()),
  );
  for (const e of expected) {
    if (e.etaMs > plannedWindowMs || e.etaMs < -imminentWindowMs) continue;
    const key = keyForExpected(e);
    // Did the tracker loop above already emit something for this flight? If
    // a live entry exists with the same flight+body, prefer it (it has more
    // precise data than the watchlist prediction).
    const trackerHit = Array.from(next.values()).find(
      v => v.body === e.body && (v.flight === e.flight || v.callsign === e.flight),
    );
    if (trackerHit) continue;

    const prevEntry = prev.get(key);
    const status = 'planned';
    next.set(key, {
      key,
      status,
      body: e.body,
      icao: prevEntry?.icao ?? null,
      flight: e.flight,
      callsign: liveCallsigns.has(e.flight) ? e.flight : (prevEntry?.callsign ?? null),
      closestApproachAtMs: e.expectedAtMs,
      closestApproachSepDeg: null,
      firstSeenMs: prevEntry?.firstSeenMs ?? nowMs,
      lastUpdateMs: nowMs,
      highestStatusReached: bestStatus(prevEntry?.highestStatusReached, status),
      route: prevEntry?.route ?? null,
      candidate: null,
      watchlistEntry: e,
    });
    touched.add(key);
  }

  // ---------- 3. Carry forward stale entries within the grace period ----------
  for (const [key, prevEntry] of prev) {
    if (touched.has(key)) continue;
    // The entry was active last tick but is missing this tick. If we are
    // within the stale grace period, hold it visible; otherwise drop.
    const ageMs = nowMs - prevEntry.lastUpdateMs;
    if (ageMs > staleGraceMs) continue;
    // Don't downgrade a 'planned' entry to 'stale' — planned entries are
    // forecast-only and naturally disappear/re-appear; only real ADS-B
    // contacts get the "no candidate anymore" treatment.
    if (prevEntry.status === 'planned') continue;
    next.set(key, {
      ...prevEntry,
      status: 'stale',
      lastUpdateMs: prevEntry.lastUpdateMs,
    });
  }

  return next;
}

function bestStatus(a, b) {
  const av = STATUS_ORDER[a] ?? -2;
  const bv = STATUS_ORDER[b] ?? -2;
  return av >= bv ? (a ?? b) : (b ?? a);
}

/**
 * Convert a lifecycle map to a sorted array suitable for /api/state.
 * Order: imminent first (most urgent), then candidate, then radio, then
 * planned, then stale. Within each status, sorted by ETA.
 *
 * @param {Map<string, LifecycleEntry>} map
 * @param {number} nowMs
 */
export function lifecycleArray(map, nowMs) {
  const sortKey = (e) => {
    const sk = STATUS_ORDER[e.status] ?? 0;
    return -sk * 1e15 + (e.closestApproachAtMs - nowMs);
  };
  return Array.from(map.values())
    .map(e => ({ ...e, etaMs: e.closestApproachAtMs - nowMs }))
    .sort((a, b) => sortKey(a) - sortKey(b));
}
