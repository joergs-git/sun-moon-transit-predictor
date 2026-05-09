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
