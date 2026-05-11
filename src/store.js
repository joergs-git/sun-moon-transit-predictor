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
    this.insertStmt = this.db.prepare(`
      INSERT INTO transit_history (
        recorded_at_ms, closest_at_ms, stage, body, icao, callsign,
        flight, airline, origin, destination,
        altitude_m, ground_speed_ms, track_deg, closest_sep_deg, duration_ms,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  close() {
    this.db.close();
  }
}
