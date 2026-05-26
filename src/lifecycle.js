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
//                  so the UI can show "no longer a candidate" before it is
//                  dropped entirely.
//
// Coasting: a single ADS-B dropout (the receiver loses the squitter for a
// few seconds, common near the horizon right before a transit) used to flip
// an active contact straight to 'stale'. That is too harsh — the signal
// almost always returns within a poll or two. An untouched but recently
// active entry now *keeps its last live status* for `coastMs` (with a
// `coasting` flag the UI can hint at) before it is allowed to go stale.

const HOUR_MS = 3600_000;
const DEFAULT_PLANNED_WINDOW_MS = HOUR_MS;
const DEFAULT_IMMINENT_WINDOW_MS = 30_000;
// 0 = no time-based drop; stale entries persist until they are pushed off
// the bottom of the panel by the cap below. Set to a positive ms value to
// re-enable an absolute upper age (e.g. 60_000 for the old 1-min behaviour).
const DEFAULT_STALE_GRACE_MS = 0;
const DEFAULT_MAX_ENTRIES = 20;               // cap on the UI panel; FIFO on stale
// How long an untouched but previously-active entry holds its last live
// status through an ADS-B gap before it is allowed to decay to 'stale'.
// 0 disables coasting entirely (old snap-to-stale behaviour).
const DEFAULT_COAST_MS = 25_000;

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
 * @property {boolean} [coasting]         - true while holding a stale-pending
 *                                          status through a brief ADS-B gap
 * @property {boolean} [isISS]            - true for an ISS (SGP4) entry, so
 *                                          the UI can highlight it distinctly
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
 * The returned map is capped at `maxEntries`: when the total would exceed
 * the cap, the *oldest stale* entries (by `lastUpdateMs`) are dropped first.
 * Active statuses (planned / radio / candidate / imminent) are always kept,
 * even past the cap — the cap is purely a UI / memory guard for slow
 * decommissioning of dropped contacts.
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
 *   maxEntries?: number,
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
  maxEntries = DEFAULT_MAX_ENTRIES,
  coastMs = DEFAULT_COAST_MS,
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
    // Track the BEST (minimum) projected sep ever seen for this entry.
    // When the prediction later degrades (e.g. drifts from 0.68° to 2°
    // and the entry goes stale → 'faded'), the UI shows the original
    // best struck through next to the current value — so the user can
    // tell "this was a real-looking close approach that fell apart" at
    // a glance, instead of just seeing a misleadingly wide stale sep.
    const currSep = c.closestApproachSepDeg;
    const prevBest = prevEntry?.bestSepDeg;
    const bestSepDeg = Number.isFinite(currSep)
      ? (Number.isFinite(prevBest) ? Math.min(prevBest, currSep) : currSep)
      : (Number.isFinite(prevBest) ? prevBest : null);
    next.set(key, {
      key,
      status,
      body: c.body,
      icao: c.icao,
      flight: c.route?.flight ?? c.callsign ?? null,
      callsign: c.callsign ?? null,
      closestApproachAtMs: c.closestApproachAtMs,
      closestApproachSepDeg: c.closestApproachSepDeg,
      bestSepDeg,
      firstSeenMs: prevEntry?.firstSeenMs ?? nowMs,
      lastUpdateMs: nowMs,
      highestStatusReached: highest,
      route: c.route ?? prevEntry?.route ?? null,
      candidate: c,
      watchlistEntry: prevEntry?.watchlistEntry ?? null,
      coasting: false,   // live this tick — explicitly not coasting
      isISS: c.isISS === true,
    });
    touched.add(key);
  }

  // ---------- 2. Predictor watchlist entries within the planned window ----------
  // The watchlist is intentionally *not* a real-time enrichment of live
  // contacts — it exists to surface flights that are still outside ADS-B
  // reception, before they can be tracked geometrically. Once a flight is
  // visible to ADS-B, live data wins regardless of what the tracker
  // classifies it as: if the tracker emitted a candidate / radio entry, we
  // already have that above; if the tracker did NOT emit (the aircraft is
  // off-course this time), the planned entry is suppressed too, because
  // continuing to flag a "planned" transit while the actual aircraft is on
  // air and visibly elsewhere is more noise than signal.
  const liveCallsigns = new Set(
    liveAircraft.map(a => a.callsign).filter(Boolean).map(s => s.toUpperCase()),
  );
  for (const e of expected) {
    if (e.etaMs > plannedWindowMs || e.etaMs < -imminentWindowMs) continue;
    const key = keyForExpected(e);
    // Did the tracker loop above already emit something for this flight?
    const trackerHit = Array.from(next.values()).find(
      v => v.body === e.body && (v.flight === e.flight || v.callsign === e.flight),
    );
    if (trackerHit) continue;
    // Live ADS-B sees the flight, but the tracker said it's not on a
    // transit path. Drop the watchlist entry — historical pattern is no
    // longer the best signal we have for this slot.
    if (e.flight && liveCallsigns.has(e.flight.toUpperCase())) continue;

    const prevEntry = prev.get(key);
    const status = 'planned';
    next.set(key, {
      key,
      status,
      body: e.body,
      icao: prevEntry?.icao ?? null,
      flight: e.flight,
      callsign: prevEntry?.callsign ?? null,
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

  // ---------- 3. Coast, then carry forward stale entries ----------
  // Age is always measured from the last *real* contact (lastUpdateMs is
  // never refreshed while coasting or stale) so the coast window and the
  // absolute stale grace both decay correctly across consecutive misses.
  //
  //   age ≤ coastMs        → keep last live status, flag `coasting`
  //   coastMs < age        → 'stale'
  //   age > staleGraceMs   → drop entirely (when staleGraceMs > 0)
  //
  // staleGraceMs = 0 keeps the legacy behaviour: stale entries persist
  // until the cap below evicts them (oldest stale first).
  // Build a set of icaos still present in the current ADS-B snapshot so we
  // can tell "tracker dropped this BUT dump1090 still sees the plane" (the
  // projected path moved out of band → 'faded') apart from "dump1090 lost
  // the plane entirely" (no more squitters → 'lost-signal').
  const liveIcaos = new Set();
  if (Array.isArray(liveAircraft)) {
    for (const ac of liveAircraft) if (ac?.icao) liveIcaos.add(ac.icao);
  }
  for (const [key, prevEntry] of prev) {
    if (touched.has(key)) continue;
    // Don't downgrade a 'planned' entry — planned entries are forecast-only
    // and naturally disappear/re-appear; only real ADS-B contacts coast/stale.
    if (prevEntry.status === 'planned') continue;
    const ageMs = nowMs - prevEntry.lastUpdateMs;
    const wasActive = prevEntry.status !== 'stale';
    if (wasActive && coastMs > 0 && ageMs <= coastMs) {
      // Brief ADS-B gap: hold the last live status so a flight does not
      // visibly "drop and reappear" every time a squitter is missed.
      next.set(key, {
        ...prevEntry,
        coasting: true,
        lastUpdateMs: prevEntry.lastUpdateMs,
      });
      continue;
    }
    if (staleGraceMs > 0 && ageMs > staleGraceMs) continue;
    // Why did this go stale? Categorise so the UI can say WHY instead of a
    // blanket "stale" badge:
    //   past-eta    — predicted closest is already in the past; the transit
    //                 window has come and gone (whether the flight actually
    //                 crossed or not).
    //   lost-signal — the airframe is no longer in dump1090's aircraft.json
    //                 (transponder off, out of receiver range, switched off
    //                 the squawk).
    //   no-fix      — still in dump1090 AND its LAST projection was tight
    //                 (< 0.5°), but the tracker has stopped emitting for it
    //                 — typically because groundSpeedMs / trackDeg dropped
    //                 out of the fix for a few ticks. The projection didn't
    //                 fade out; the fix did. Re-emerges automatically when
    //                 the fix is complete again. v0.30.9.
    //   faded       — still in dump1090 but the projected min-sep moved
    //                 outside the panel band, i.e. the flight changed track
    //                 / altitude and no longer threatens a transit.
    let staleReason = 'faded';
    const lastSep = prevEntry.closestApproachSepDeg;
    if (Number.isFinite(prevEntry.closestApproachAtMs)
        && prevEntry.closestApproachAtMs + imminentWindowMs < nowMs) {
      staleReason = 'past-eta';
    } else if (prevEntry.icao && !liveIcaos.has(prevEntry.icao)) {
      staleReason = 'lost-signal';
    } else if (Number.isFinite(lastSep) && lastSep < 0.5) {
      // Last emission was well inside the imminent-worthy band, so the
      // projection didn't drift out — the tracker just isn't getting the
      // ADS-B fields it needs to recompute. Re-checks every tick; pops
      // straight back to radio/candidate the moment a complete fix arrives.
      staleReason = 'no-fix';
    }
    next.set(key, {
      ...prevEntry,
      status: 'stale',
      coasting: false,
      staleReason,
      lastUpdateMs: prevEntry.lastUpdateMs,
    });
  }

  // ---------- 4. Cap the map: drop oldest stale entries first ----------
  if (next.size > maxEntries) {
    const stale = [];
    const active = [];
    for (const [k, e] of next) {
      (e.status === 'stale' ? stale : active).push([k, e]);
    }
    // Oldest stale first → drop those first.
    stale.sort((a, b) => a[1].lastUpdateMs - b[1].lastUpdateMs);
    const overBy = next.size - maxEntries;
    for (let i = 0; i < Math.min(overBy, stale.length); i++) {
      next.delete(stale[i][0]);
    }
    // If still over (i.e. > maxEntries active rows on a very busy minute),
    // drop the oldest planned entries next. Active radio/candidate/imminent
    // are always kept — they're the whole point of the tool.
    if (next.size > maxEntries) {
      const planned = active
        .filter(([, e]) => e.status === 'planned')
        .sort((a, b) => a[1].closestApproachAtMs - b[1].closestApproachAtMs);
      const stillOver = next.size - maxEntries;
      for (let i = planned.length - 1; i >= 0 && next.size > maxEntries; i--) {
        next.delete(planned[i][0]);
      }
    }
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
 *
 * Order: newest first (highest `firstSeenMs`). A freshly-detected aircraft
 * always appears at the top of the table; the next time another one
 * appears, the previous head row slides down by one. Within identical
 * firstSeenMs values the secondary sort is ETA, which keeps the order
 * stable across ticks. Status urgency is conveyed by the per-row colour
 * coding and the status pill, not by position.
 *
 * @param {Map<string, LifecycleEntry>} map
 * @param {number} nowMs
 */
export function lifecycleArray(map, nowMs) {
  return Array.from(map.values())
    .map(e => ({ ...e, etaMs: e.closestApproachAtMs - nowMs }))
    .sort((a, b) => {
      const seenDelta = (b.firstSeenMs ?? 0) - (a.firstSeenMs ?? 0);
      if (seenDelta !== 0) return seenDelta;
      return (a.closestApproachAtMs - nowMs) - (b.closestApproachAtMs - nowMs);
    });
}
