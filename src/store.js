// History store for transit notifications. Backed by node:sqlite (Node 22+
// requires --experimental-sqlite; stable from Node 24). Pure built-in module
// — no native build required, fits the Pi-friendly ARM64 deployment.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Use createRequire so bundlers (Vite/Vitest) leave the `node:sqlite`
// resolution to Node itself. Static `import 'node:sqlite'` confuses Vite's
// resolver since the module is a Node built-in introduced in v22.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

/** Idempotent `ALTER TABLE ... ADD COLUMN` — uses PRAGMA table_info so we
 *  don't have to swallow exceptions to detect a duplicate add. */
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transit_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at_ms  INTEGER NOT NULL,
  closest_at_ms   INTEGER NOT NULL,
  stage           TEXT NOT NULL,
  body            TEXT NOT NULL,
  icao            TEXT NOT NULL,
  callsign        TEXT,
  flight          TEXT,
  airline         TEXT,
  origin          TEXT,
  destination     TEXT,
  altitude_m      REAL,
  ground_speed_ms REAL,
  track_deg       REAL,
  closest_sep_deg REAL,
  duration_ms     INTEGER,
  range_m         REAL,
  payload_json    TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_recorded ON transit_history(recorded_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_history_closest  ON transit_history(closest_at_ms DESC);

-- External schedule observations (e.g. OpenSky historical pulls) used by the
-- predictor to augment local transit_history with flights we may have missed
-- ourselves. Each row is a single (flight, body, timestamp) triple plus a
-- short provenance string so older or revoked sources can be cleaned up.
CREATE TABLE IF NOT EXISTS schedule_observations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,
  fetched_at_ms   INTEGER NOT NULL,
  flight          TEXT NOT NULL,
  body            TEXT NOT NULL,
  timestamp_ms    INTEGER NOT NULL,
  airport         TEXT,
  kind            TEXT,
  UNIQUE(source, flight, timestamp_ms)
);

CREATE INDEX IF NOT EXISTS idx_schedule_ts ON schedule_observations(timestamp_ms DESC);
`;

export class HistoryStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // Stage rename migration (v0.4.0). Idempotent: re-running just touches
    // zero rows the second time. Keeps history under one stable vocabulary.
    this.db.exec(`
      UPDATE transit_history SET stage = 'candidate' WHERE stage = 'early';
      UPDATE transit_history SET stage = 'imminent'  WHERE stage = 'precise';
    `);
    // v0.5.0: add range_m (line-of-sight observer→aircraft, metres) so the
    // History table can show distance. Idempotent — only adds the column
    // when the running DB doesn't already have it.
    ensureColumn(this.db, 'transit_history', 'range_m', 'REAL');
    this.insertStmt = this.db.prepare(`
      INSERT INTO transit_history (
        recorded_at_ms, closest_at_ms, stage, body, icao, callsign,
        flight, airline, origin, destination,
        altitude_m, ground_speed_ms, track_deg, closest_sep_deg, duration_ms,
        range_m, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Insert-or-ignore so refresh runs are idempotent — same (source, flight,
    // timestamp) combination won't create duplicate rows.
    this.insertScheduleStmt = this.db.prepare(`
      INSERT OR IGNORE INTO schedule_observations
        (source, fetched_at_ms, flight, body, timestamp_ms, airport, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Persist a single schedule observation (e.g. from an OpenSky pull).
   * Idempotent on (source, flight, timestamp_ms).
   * @returns {boolean} true if a new row was inserted, false if it already existed
   */
  recordScheduleObservation({ source, flight, body, timestampMs, airport, kind, fetchedAtMs = Date.now() }) {
    const res = this.insertScheduleStmt.run(
      source, fetchedAtMs, flight, body, timestampMs, airport ?? null, kind ?? null,
    );
    return res.changes > 0;
  }

  /**
   * Read schedule observations within a time window, optionally limited by
   * source. Returned in the same shape predictor.observationsFromHistory()
   * uses, so callers can mix-and-match.
   *
   * @param {{ sinceMs?: number, source?: string }} [opts]
   * @returns {Array<{ flight: string, body: 'Sun'|'Moon', timestampMs: number }>}
   */
  scheduleObservations({ sinceMs = 0, source } = {}) {
    const where = ['timestamp_ms >= ?'];
    const args = [sinceMs];
    if (source) { where.push('source = ?'); args.push(source); }
    const rows = this.db
      .prepare(`SELECT flight, body, timestamp_ms FROM schedule_observations
                WHERE ${where.join(' AND ')}`)
      .all(...args);
    return rows.map(r => ({ flight: r.flight, body: r.body, timestampMs: r.timestamp_ms }));
  }

  /**
   * Drop schedule observations older than `cutoffMs`. Used by the refresh
   * script to bound table growth.
   */
  pruneScheduleOlderThan(cutoffMs) {
    return this.db
      .prepare('DELETE FROM schedule_observations WHERE timestamp_ms < ?')
      .run(cutoffMs).changes;
  }

  /**
   * @param {string} stage  'early' | 'precise'
   * @param {import('./tracker.js').TransitCandidate} candidate
   * @param {object|null} route
   * @param {number} recordedAtMs
   */
  recordEvent(stage, candidate, route, recordedAtMs) {
    const ac = candidate.aircraft;
    this.insertStmt.run(
      recordedAtMs,
      candidate.closestApproachAtMs,
      stage,
      candidate.body,
      candidate.icao,
      candidate.callsign,
      route?.flight ?? null,
      route?.airline?.name ?? null,
      route?.origin?.iata ?? route?.origin?.icao ?? null,
      route?.destination?.iata ?? route?.destination?.icao ?? null,
      ac.altMmsl,
      ac.groundSpeedMs,
      ac.trackDeg,
      candidate.closestApproachSepDeg,
      candidate.durationMs,
      candidate.aircraftAtClosest?.rangeM ?? null,
      JSON.stringify({ candidate, route }),
    );
  }

  /**
   * @param {{ limit?: number }} [opts]
   */
  recent({ limit = 100 } = {}) {
    return this.db
      .prepare('SELECT * FROM transit_history ORDER BY recorded_at_ms DESC LIMIT ?')
      .all(limit);
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM transit_history').get().n;
  }

  /**
   * Episode-consolidated history view: one row per real transit, with the
   * earliest recorded_at_ms (first detection) combined with the
   * tightest-sep snapshot (best refined payload + range/alt/speed). Drops
   * the radio/candidate/imminent duplication that made the v0.7.x History
   * table feel cluttered ("why does recorded sit 30 s before transit so
   * often" — because that was the imminent row of a 3-row episode).
   *
   * Per consolidated row:
   *   - recorded_at_ms = earliest stage's recorded time (lead-time signal)
   *   - closest_at_ms  = tightest-sep stage's refined closest-approach time
   *   - stage          = highest stage reached (radio / candidate / imminent)
   *   - stages         = the full set of stages that fired in the episode
   *   - closest_sep_deg, range_m, altitude_m, ground_speed_ms, payload =
   *       all taken from the tightest-sep stage (best-refined snapshot)
   *   - outcome        = graduated / faded / surprise
   *   - leadTimeMs     = closest_at_ms - recorded_at_ms (advance warning)
   *
   * Sorted by recorded_at_ms DESC. Capped at `limit`.
   *
   * @param {{ limit?: number, windowMs?: number, episodeWindowMs?: number,
   *           nowMs?: number }} [opts]
   */
  consolidatedHistory({ limit = 100, windowMs = 30 * 24 * 3600_000,
                        episodeWindowMs = 5 * 60_000, nowMs = Date.now() } = {}) {
    const since = nowMs - windowMs;
    const rows = this.db
      .prepare(`SELECT * FROM transit_history
                WHERE recorded_at_ms >= ?
                ORDER BY icao, body, closest_at_ms`)
      .all(since);

    // Episode grouping: same algorithm as episodes() — (icao, body) groups
    // split on a > episodeWindowMs gap between consecutive closest_at_ms.
    const STAGE_RANK = { radio: 0, candidate: 1, imminent: 2 };
    /** @type {Map<string, { rows: any[], stages: Set<string>, latestClosestAtMs: number }>} */
    const byKey = new Map();
    let curKey = '';
    let cur = null;
    for (const r of rows) {
      const groupKey = `${r.icao}|${r.body}`;
      if (groupKey !== curKey) { curKey = groupKey; cur = null; }
      if (!cur || (r.closest_at_ms - cur.latestClosestAtMs) > episodeWindowMs) {
        cur = {
          key: `${groupKey}|${r.closest_at_ms}`,
          rows: [],
          stages: new Set(),
          latestClosestAtMs: r.closest_at_ms,
        };
        byKey.set(cur.key, cur);
      }
      cur.rows.push(r);
      cur.stages.add(r.stage);
      cur.latestClosestAtMs = Math.max(cur.latestClosestAtMs, r.closest_at_ms);
    }

    const classify = (stages) => {
      const tightened = stages.has('candidate') || stages.has('imminent');
      if (stages.has('radio') && tightened) return 'graduated';
      if (stages.has('radio') && !tightened) return 'faded';
      return 'surprise';
    };

    const consolidated = Array.from(byKey.values()).map(ep => {
      const earliest = ep.rows.reduce((a, b) =>
        a.recorded_at_ms < b.recorded_at_ms ? a : b);
      const tightest = ep.rows.reduce((a, b) =>
        ((a.closest_sep_deg ?? Infinity) < (b.closest_sep_deg ?? Infinity)) ? a : b);
      const topStage = ep.rows.reduce((a, b) =>
        (STAGE_RANK[a.stage] ?? 0) >= (STAGE_RANK[b.stage] ?? 0) ? a : b);
      // Base shape is the tightest-sep row (best-refined geometry +
      // payload), overridden with the earliest recorded time and the
      // top stage. flight/callsign prefer non-null wins (route lookup
      // often only resolves on later stages).
      const flight = ep.rows.map(r => r.flight).filter(Boolean).pop() ?? null;
      const callsign = ep.rows.map(r => r.callsign).filter(Boolean).pop() ?? null;
      return {
        ...tightest,
        recorded_at_ms: earliest.recorded_at_ms,
        stage: topStage.stage,
        stages: Array.from(ep.stages),
        flight,
        callsign,
        outcome: classify(ep.stages),
        leadTimeMs: tightest.closest_at_ms - earliest.recorded_at_ms,
      };
    });

    consolidated.sort((a, b) => b.recorded_at_ms - a.recorded_at_ms);
    return consolidated.slice(0, limit);
  }

  /**
   * Group rows in transit_history into "episodes" (one row per real transit
   * approach) and classify each by which stages fired.
   *
   * Two rows belong to the same episode when they share (icao, body) and
   * their closest_at_ms values are within `episodeWindowMs` of each other
   * (default 5 min) — far enough apart to absorb the predictor refining the
   * time as the aircraft gets closer, tight enough that two unrelated
   * approaches by the same registration on the same day never collide.
   *
   * Outcome taxonomy:
   *   - 'graduated' : early-warning radio fired AND the flight later reached
   *                   candidate or imminent — the alert paid off.
   *   - 'faded'     : radio fired but the flight never tightened up — false
   *                   positive of the early-warning stage.
   *   - 'surprise'  : candidate or imminent fired with no prior radio — we
   *                   missed the build-up entirely.
   *
   * @param {{ windowMs?: number, episodeWindowMs?: number, nowMs?: number }} [opts]
   * @returns {{
   *   windowMs: number,
   *   episodes: Array<{
   *     key: string, icao: string, body: 'Sun'|'Moon',
   *     flight: string|null, callsign: string|null,
   *     firstRecordedAtMs: number, lastRecordedAtMs: number,
   *     closestAtMs: number,
   *     stages: Array<'radio'|'candidate'|'imminent'>,
   *     minSepDeg: number|null,
   *     outcome: 'graduated'|'faded'|'surprise',
   *     rowIds: number[],
   *   }>,
   *   aggregates: {
   *     totalEpisodes: number,
   *     radioFired: number,
   *     radioGraduated: number,
   *     radioFaded: number,
   *     surprises: number,
   *     candidateOrImminent: number,
   *     hitRatePct: number|null,
   *     surpriseRatePct: number|null,
   *   },
   * }}
   */
  episodes({ windowMs = 14 * 24 * 3600_000, episodeWindowMs = 5 * 60_000, nowMs = Date.now() } = {}) {
    const since = nowMs - windowMs;
    const rows = this.db
      .prepare(`SELECT id, recorded_at_ms, closest_at_ms, stage, body, icao,
                       callsign, flight, closest_sep_deg
                FROM transit_history
                WHERE recorded_at_ms >= ?
                ORDER BY icao, body, closest_at_ms`)
      .all(since);

    // One forward sweep per (icao, body) group: start a fresh episode when
    // the gap between consecutive closest-approach timestamps exceeds the
    // episode window. Each row contributes one stage to its episode.
    /** @type {Map<string, any>} */
    const byKey = new Map();
    let curKey = '';
    let cur = null;
    for (const r of rows) {
      // Reset cursor on group boundary.
      const groupKey = `${r.icao}|${r.body}`;
      if (groupKey !== curKey) { curKey = groupKey; cur = null; }
      if (!cur || (r.closest_at_ms - cur.closestAtMs) > episodeWindowMs) {
        cur = {
          key: `${groupKey}|${r.closest_at_ms}`,
          icao: r.icao,
          body: r.body,
          flight: r.flight,
          callsign: r.callsign,
          firstRecordedAtMs: r.recorded_at_ms,
          lastRecordedAtMs:  r.recorded_at_ms,
          closestAtMs: r.closest_at_ms,
          stages: new Set(),
          minSepDeg: null,
          rowIds: [],
        };
        byKey.set(cur.key, cur);
      }
      cur.stages.add(r.stage);
      cur.rowIds.push(r.id);
      // Flight / callsign on the latest row wins — earlier rows may not yet
      // have had the route lookup answer, the later ones often do.
      if (r.flight) cur.flight = r.flight;
      if (r.callsign) cur.callsign = r.callsign;
      cur.lastRecordedAtMs = Math.max(cur.lastRecordedAtMs, r.recorded_at_ms);
      cur.closestAtMs = r.closest_at_ms;          // latest refinement
      if (Number.isFinite(r.closest_sep_deg)) {
        if (cur.minSepDeg == null || r.closest_sep_deg < cur.minSepDeg) {
          cur.minSepDeg = r.closest_sep_deg;
        }
      }
    }

    const classify = (stages) => {
      const tightened = stages.has('candidate') || stages.has('imminent');
      if (stages.has('radio') && tightened) return 'graduated';
      if (stages.has('radio') && !tightened) return 'faded';
      return 'surprise';   // candidate/imminent without prior radio
    };

    const episodes = Array.from(byKey.values())
      .map(e => ({ ...e, stages: Array.from(e.stages), outcome: classify(e.stages) }))
      .sort((a, b) => b.closestAtMs - a.closestAtMs);

    const total = episodes.length;
    const radioFired = episodes.filter(e => e.stages.includes('radio')).length;
    const radioGraduated = episodes.filter(e => e.outcome === 'graduated').length;
    const radioFaded = episodes.filter(e => e.outcome === 'faded').length;
    const surprises = episodes.filter(e => e.outcome === 'surprise').length;
    const candidateOrImminent = episodes.filter(
      e => e.stages.includes('candidate') || e.stages.includes('imminent'),
    ).length;
    // Disc-graze count per body. An episode counts as a "graze" when its
    // tightest stage drove min separation below `grazeThresholdDeg` (default
    // 0.3°). At typical airliner ranges (~10 km) the angular wingspan is
    // ≈0.2°, the Sun/Moon disc radius is ≈0.27°, so a 0.3°-from-centre pass
    // means the silhouette at least partially overlaps the disc edge — i.e.
    // a real grazing transit, not a near-miss. The user wants this as a
    // running quality signal that "refines with more data".
    const grazeThresholdDeg = 0.3;
    const sunGrazes = episodes.filter(
      e => e.body === 'Sun'  && Number.isFinite(e.minSepDeg) && e.minSepDeg < grazeThresholdDeg,
    ).length;
    const moonGrazes = episodes.filter(
      e => e.body === 'Moon' && Number.isFinite(e.minSepDeg) && e.minSepDeg < grazeThresholdDeg,
    ).length;
    const aggregates = {
      totalEpisodes: total,
      radioFired,
      radioGraduated,
      radioFaded,
      surprises,
      candidateOrImminent,
      sunGrazes,
      moonGrazes,
      grazeThresholdDeg,
      // Hit rate: of all radio alerts, how many panned out into a tight
      // transit. The user's "wie oft kommt es vor, dass ein echter 1°
      // candidate tatsächlich ernst wird".
      hitRatePct: radioFired > 0 ? (radioGraduated / radioFired) * 100 : null,
      // Surprise rate: of all tight transits we ended up actually firing,
      // how many came without any prior radio heads-up. The user's "wie oft
      // ein echter Kandidat erkannt wird, der vorher nicht ermittelt wurde".
      surpriseRatePct: candidateOrImminent > 0
        ? (surprises / candidateOrImminent) * 100
        : null,
      // Disc-graze rates: % of ALL detected aircraft (both bodies pooled in
      // the denominator) that actually skimmed each body's disc within the
      // graze threshold. Refines as the rolling window accumulates events.
      sunGrazePct:  total > 0 ? (sunGrazes  / total) * 100 : null,
      moonGrazePct: total > 0 ? (moonGrazes / total) * 100 : null,
    };
    return { windowMs, episodes, aggregates };
  }

  close() {
    this.db.close();
  }
}
