// History-based repeat predictor.
//
// Idea: scheduled flights fly the same callsign on the same route at roughly
// the same time most days. If LH123 caused a Sun transit yesterday at 11:23
// and another at 11:21 last Wednesday, today's LH123 around 11:22 is highly
// likely to do the same. We don't need an external schedule API for this
// pattern — `data/history.db` already contains exactly this signal.
//
// The module is split into two layers:
//
//   1. `buildWatchlist(observations, opts)` — pure function. Takes an array of
//      `{flight, body, timestampMs}` observations from any source (the local
//      transit_history table, OpenSky historical pulls, both combined) and
//      buckets them by (flight, body, time-of-day) to produce a watchlist of
//      recurring patterns.
//
//   2. `upcomingExpected(watchlist, nowMs, lookAheadMs)` — returns the next
//      expected occurrence of each watchlist entry within the look-ahead
//      window, sorted by ETA.
//
// The split lets `src/service.js` mix observation sources and re-build the
// watchlist on a slow cadence (hourly / daily) without forcing the predictor
// to know about SQLite or HTTP.

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * @typedef {Object} Observation
 * @property {string} flight        - flight identifier (IATA preferred, e.g. 'LH123')
 * @property {'Sun'|'Moon'} body
 * @property {number} timestampMs   - UTC ms of the event
 */

/**
 * @typedef {Object} WatchlistEntry
 * @property {string} flight
 * @property {'Sun'|'Moon'} body
 * @property {number} expectedTimeOfDayMs   - 0..86_400_000 (median observed UTC time-of-day)
 * @property {number} observations          - total raw observations in this bucket
 * @property {number} distinctDays          - number of distinct UTC days the flight hit
 * @property {number} lastSeenMs            - most recent observation
 * @property {number} stdevMs               - inter-observation time-of-day spread
 */

/**
 * Build a watchlist of recurring (flight, body, time-of-day) patterns.
 *
 * @param {Observation[]} observations
 * @param {{
 *   nowMs?: number,
 *   daysBack?: number,        // ignore observations older than this
 *   minRepeats?: number,      // minimum distinct days with a hit
 *   bucketMinutes?: number,   // time-of-day bucket width in minutes
 * }} [opts]
 * @returns {WatchlistEntry[]}
 */
export function buildWatchlist(observations, opts = {}) {
  const {
    nowMs = Date.now(),
    daysBack = 14,
    minRepeats = 2,
    bucketMinutes = 60,
  } = opts;

  const sinceMs = nowMs - daysBack * DAY_MS;
  const bucketSizeMs = bucketMinutes * 60_000;

  /** @type {Map<string, { flight: string, body: 'Sun'|'Moon', days: Set<number>, times: number[] }>} */
  const buckets = new Map();

  for (const obs of observations) {
    if (!obs.flight || !obs.body || typeof obs.timestampMs !== 'number') continue;
    if (obs.timestampMs < sinceMs) continue;
    const todMs = obs.timestampMs % DAY_MS;
    const bucket = Math.floor(todMs / bucketSizeMs);
    const dayBucket = Math.floor(obs.timestampMs / DAY_MS);
    const key = `${obs.flight}|${obs.body}|${bucket}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = { flight: obs.flight, body: obs.body, days: new Set(), times: [] };
      buckets.set(key, entry);
    }
    entry.days.add(dayBucket);
    entry.times.push(obs.timestampMs);
  }

  /** @type {WatchlistEntry[]} */
  const out = [];
  for (const entry of buckets.values()) {
    if (entry.days.size < minRepeats) continue;
    const todTimes = entry.times.map(t => t % DAY_MS).sort((a, b) => a - b);
    const median = todTimes[Math.floor(todTimes.length / 2)];
    const mean = todTimes.reduce((a, b) => a + b, 0) / todTimes.length;
    const variance = todTimes.length > 1
      ? todTimes.reduce((s, t) => s + (t - mean) ** 2, 0) / (todTimes.length - 1)
      : 0;
    out.push({
      flight: entry.flight,
      body: entry.body,
      expectedTimeOfDayMs: median,
      observations: entry.times.length,
      distinctDays: entry.days.size,
      lastSeenMs: Math.max(...entry.times),
      stdevMs: Math.sqrt(variance),
    });
  }
  return out;
}

/**
 * Compute the next absolute UTC ms an entry's expected time-of-day will fire,
 * within `lookAheadMs` of `nowMs`. Returns null if outside the window.
 *
 * @param {WatchlistEntry} entry
 * @param {number} nowMs
 * @param {number} [lookAheadMs]
 * @returns {number|null}
 */
export function nextExpected(entry, nowMs, lookAheadMs = DAY_MS) {
  const dayStartUtc = nowMs - (nowMs % DAY_MS);
  for (const offset of [0, DAY_MS]) {
    const candidate = dayStartUtc + entry.expectedTimeOfDayMs + offset;
    if (candidate >= nowMs && candidate <= nowMs + lookAheadMs) {
      return candidate;
    }
  }
  return null;
}

/**
 * @typedef {Object} ExpectedEvent
 * @property {string} flight
 * @property {'Sun'|'Moon'} body
 * @property {number} expectedAtMs   - absolute UTC ms
 * @property {number} etaMs          - expectedAtMs - nowMs
 * @property {number} observations
 * @property {number} distinctDays
 * @property {number} stdevMs        - confidence proxy: smaller = more reliable
 */

/**
 * Project the watchlist forward into upcoming expected events, sorted by ETA.
 *
 * @param {WatchlistEntry[]} watchlist
 * @param {number} nowMs
 * @param {number} [lookAheadMs]
 * @returns {ExpectedEvent[]}
 */
export function upcomingExpected(watchlist, nowMs, lookAheadMs = DAY_MS) {
  /** @type {ExpectedEvent[]} */
  const out = [];
  for (const entry of watchlist) {
    const expectedAtMs = nextExpected(entry, nowMs, lookAheadMs);
    if (expectedAtMs === null) continue;
    out.push({
      flight: entry.flight,
      body: entry.body,
      expectedAtMs,
      etaMs: expectedAtMs - nowMs,
      observations: entry.observations,
      distinctDays: entry.distinctDays,
      stdevMs: entry.stdevMs,
    });
  }
  out.sort((a, b) => a.expectedAtMs - b.expectedAtMs);
  return out;
}

/**
 * Convenience: read transit_history rows and convert to Observations.
 *
 * Only `precise` stage rows are taken — those are the ones that actually
 * matched a transit window. `early` rows include candidates that were later
 * superseded or never confirmed; including them would inflate the watchlist
 * with noise.
 *
 * @param {import('./store.js').HistoryStore} store
 * @param {{ daysBack?: number, nowMs?: number }} [opts]
 * @returns {Observation[]}
 */
export function observationsFromHistory(store, opts = {}) {
  const { daysBack = 14, nowMs = Date.now() } = opts;
  const sinceMs = nowMs - daysBack * DAY_MS;
  const rows = store.db.prepare(`
    SELECT flight, body, closest_at_ms
    FROM transit_history
    WHERE recorded_at_ms >= ? AND flight IS NOT NULL AND stage = 'precise'
  `).all(sinceMs);
  return rows.map(r => ({
    flight: r.flight,
    body: r.body,
    timestampMs: r.closest_at_ms,
  }));
}
