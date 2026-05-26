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

-- Persistent "how often did this come by" tally over ALL detected ADS-B
-- traffic (not just transits). One row per airframe (kind='icao', key=hex)
-- and per ADS-B callsign (kind='flight'). A "visit" is a fresh sighting
-- after a ≥ gap absence (default 30 min) — loiter / continuous tracking
-- stays one visit. Survives restarts (that's the whole point).
CREATE TABLE IF NOT EXISTS aircraft_sightings (
  kind          TEXT NOT NULL,
  key           TEXT NOT NULL,
  visits        INTEGER NOT NULL DEFAULT 1,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_sightings_top
  ON aircraft_sightings(kind, visits DESC, last_seen_ms DESC);

-- Lifetime denominator for the "high-quality detection" funnel: every ICAO
-- ever observed at ≥ 30° elevation in the sky from this site. Recorded
-- exactly once per airframe on first qualifying tick; combined with
-- transit_history.closest_sep_deg gives a true "of the planes that were
-- properly overhead, what fraction came close to Sun/Moon" ratio. Tracking
-- starts from the v0.29.0 first run (no retro fill possible).
CREATE TABLE IF NOT EXISTS aircraft_high_elev (
  icao          TEXT PRIMARY KEY,
  first_seen_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aircraft_high_elev_first
  ON aircraft_high_elev(first_seen_ms);
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
    // v0.30.8: last_sep_deg = projected separation observed at the moment
    // the lifecycle entry transitioned to stale-faded (i.e. the value
    // that drifted out from its best). Lets History show the same
    // "was best, now drifted" pair as the live "Real candidates" panel:
    //   ~~0.68°~~  (2.00°)
    // Filled by an UPDATE across the episode's transit_history rows from
    // service.js's stale-detection diff; legacy rows stay NULL → no
    // change in display.
    ensureColumn(this.db, 'transit_history', 'last_sep_deg', 'REAL');
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

    this._sightSel = this.db.prepare(
      'SELECT visits, first_seen_ms, last_seen_ms FROM aircraft_sightings WHERE kind = ? AND key = ?',
    );
    this._sightIns = this.db.prepare(
      'INSERT INTO aircraft_sightings (kind, key, visits, first_seen_ms, last_seen_ms) VALUES (?, ?, 1, ?, ?)',
    );
    this._sightUpd = this.db.prepare(
      'UPDATE aircraft_sightings SET visits = ?, last_seen_ms = ? WHERE kind = ? AND key = ?',
    );
    this._sightTouch = this.db.prepare(
      'UPDATE aircraft_sightings SET last_seen_ms = ? WHERE kind = ? AND key = ?',
    );

    // High-elevation tracking (v0.29.0). One row per airframe that ever
    // appeared at ≥ 30° elevation from this site — used as the "good
    // observability" denominator in the Detection Funnel widget. INSERT
    // OR IGNORE means re-running on the same airframe is a free no-op.
    this._highElevIns = this.db.prepare(
      'INSERT OR IGNORE INTO aircraft_high_elev (icao, first_seen_ms) VALUES (?, ?)',
    );
    this._highElevAll = this.db.prepare(
      'SELECT icao FROM aircraft_high_elev',
    );
    this._highElevCount = this.db.prepare(
      'SELECT COUNT(*) AS n, MIN(first_seen_ms) AS sinceMs FROM aircraft_high_elev',
    );
    // Aggregated close-approach counts (numerator), split by body and
    // distinct ICAO. Filtered by stage = 'imminent' to count only flights
    // that were ACTUALLY confirmed to pass that close — a "candidate"-only
    // row is just a prediction the tracker emitted, not a confirmed hit.
    this._closeCount = this.db.prepare(
      `SELECT body, COUNT(DISTINCT icao) AS n
       FROM transit_history
       WHERE stage = 'imminent' AND closest_sep_deg IS NOT NULL AND closest_sep_deg < ?
       GROUP BY body`,
    );
  }

  /** Mark an ICAO as having appeared at ≥ 30° elevation. Idempotent. */
  markHighElevation(icao, nowMs) {
    if (!icao) return;
    this._highElevIns.run(String(icao).toLowerCase(), nowMs);
  }

  /** Snapshot the in-DB high-elev ICAO set into memory at service start.
   *  Used as a dedup guard so we don't re-insert known ICAOs every tick. */
  loadHighElevSet() {
    const s = new Set();
    for (const r of this._highElevAll.all()) s.add(r.icao);
    return s;
  }

  /** Total distinct ICAOs ever recorded at ≥ 30° elevation + earliest
   *  observation timestamp (= when the tracking began on this DB). */
  highElevTotals() {
    const r = this._highElevCount.get();
    return { count: r?.n ?? 0, sinceMs: r?.sinceMs ?? null };
  }

  /** Distinct ICAOs from transit_history.stage='imminent' whose closest
   *  approach was < `sepBelowDeg`, grouped by body. Plain object keyed by
   *  body name (lowercased). */
  closeApproachCounts(sepBelowDeg) {
    const out = {};
    for (const r of this._closeCount.all(sepBelowDeg)) {
      out[String(r.body).toLowerCase()] = r.n;
    }
    return out;
  }

  /**
   * Record a sighting of `key` (kind 'icao' | 'flight'). A new row, or a
   * sighting ≥ `gapMs` after the stored last_seen, counts as a fresh visit
   * (+1); otherwise it just advances last_seen. Returns true if it was a
   * new visit. Persistent — the whole point is surviving restarts.
   *
   * @param {'icao'|'flight'} kind
   * @param {string} key
   * @param {number} nowMs
   * @param {number} gapMs
   * @returns {boolean}
   */
  recordSighting(kind, key, nowMs, gapMs) {
    if (!key) return false;
    const row = this._sightSel.get(kind, key);
    if (!row) {
      this._sightIns.run(kind, key, nowMs, nowMs);
      return true;
    }
    const isNewVisit = (nowMs - row.last_seen_ms) > gapMs;
    this._sightUpd.run(row.visits + (isNewVisit ? 1 : 0), nowMs, kind, key);
    return isNewVisit;
  }

  /** Advance last_seen only (continuous presence) — no visit increment. */
  touchSighting(kind, key, nowMs) {
    if (!key) return;
    this._sightTouch.run(nowMs, kind, key);
  }

  /**
   * Top sightings of one kind, by visit count (desc), then recency.
   * @param {{ kind?: 'icao'|'flight', limit?: number }} [opts]
   * @returns {Array<{key:string,visits:number,firstSeenMs:number,lastSeenMs:number}>}
   */
  topSightings({ kind = 'icao', limit = 50 } = {}) {
    const n = Math.min(500, Math.max(1, limit | 0));
    return this.db.prepare(
      `SELECT key, visits, first_seen_ms AS firstSeenMs, last_seen_ms AS lastSeenMs
       FROM aircraft_sightings WHERE kind = ?
       ORDER BY visits DESC, last_seen_ms DESC LIMIT ?`,
    ).all(kind, n);
  }

  /** Totals for the stats header: distinct keys + summed visits per kind. */
  sightingTotals() {
    const r = this.db.prepare(
      `SELECT kind, COUNT(*) AS distinctKeys, COALESCE(SUM(visits),0) AS totalVisits
       FROM aircraft_sightings GROUP BY kind`,
    ).all();
    const out = { icao: { distinctKeys: 0, totalVisits: 0 }, flight: { distinctKeys: 0, totalVisits: 0 } };
    for (const x of r) out[x.kind] = { distinctKeys: x.distinctKeys, totalVisits: x.totalVisits };
    return out;
  }

  /**
   * Retrospective range statistics over aircraft that ACTUALLY passed the
   * disc close (the `imminent` stage = time-confirmed ±30 s of closest
   * approach, consistent with the v0.14.1 sharpening — one row per real
   * transit). Answers "how far away were the planes that came < X°".
   *
   * @param {{ sepBelowDeg?: number, windowMs?: number, nowMs?: number,
   *           buckets?: number }} [opts]
   * @returns {{
   *   sepBelowDeg:number, n:number, onDisc:number,
   *   minM:number|null, maxM:number|null, medianM:number|null,
   *   meanM:number|null, p90M:number|null,
   *   perBody:{Sun:number,Moon:number},
   *   histogram:Array<{fromM:number,toM:number,count:number}>,
   * }}
   */
  rangeStats({ sepBelowDeg = 0.5, windowMs = 3650 * 24 * 3600_000,
               nowMs = Date.now(), buckets = 10 } = {}) {
    const since = nowMs - windowMs;
    const rows = this.db.prepare(
      `SELECT range_m AS r, body, closest_sep_deg AS sep
       FROM transit_history
       WHERE stage = 'imminent' AND range_m IS NOT NULL
         AND closest_sep_deg IS NOT NULL AND closest_sep_deg < ?
         AND recorded_at_ms >= ?
       ORDER BY range_m`,
    ).all(sepBelowDeg, since);

    const empty = {
      sepBelowDeg, n: 0, onDisc: 0,
      minM: null, maxM: null, medianM: null, meanM: null, p90M: null,
      perBody: { Sun: 0, Moon: 0 }, histogram: [],
    };
    if (rows.length === 0) return empty;

    const vals = rows.map(x => x.r);                  // already ASC
    const n = vals.length;
    const minM = vals[0];
    const maxM = vals[n - 1];
    const sum = vals.reduce((a, b) => a + b, 0);
    const meanM = sum / n;
    const at = (q) => vals[Math.min(n - 1, Math.floor(q * n))];
    const medianM = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
    const p90M = at(0.9);
    const perBody = { Sun: 0, Moon: 0 };
    let onDisc = 0;
    for (const x of rows) {
      if (x.body === 'Sun' || x.body === 'Moon') perBody[x.body] += 1;
      if (x.sep < 0.27) onDisc += 1;                  // ~Sun/Moon disc radius
    }
    const histogram = [];
    const span = maxM - minM || 1;
    const bw = span / buckets;
    for (let i = 0; i < buckets; i++) {
      const lo = minM + i * bw;
      const hi = i === buckets - 1 ? maxM : minM + (i + 1) * bw;
      const count = vals.filter(v => v >= lo && (i === buckets - 1 ? v <= hi : v < hi)).length;
      histogram.push({ fromM: lo, toM: hi, count });
    }
    return { sepBelowDeg, n, onDisc, minM, maxM, medianM, meanM, p90M, perBody, histogram };
  }

  /**
   * "Real, usable candidates": of the aircraft that ACTUALLY transited
   * (the `imminent` stage), the ones high enough to be worth a telescope —
   * elevation at closest approach ≥ minElevationDeg (default 30°, the same
   * default as the Pushover gate). Grouped by airframe (ICAO) and by flight
   * so the frontend can reuse the acstats bar renderer.
   *
   * Elevation is not a column — it lives in payload_json under
   * candidate.aircraftAtClosest.elevationDeg — so this parses per row. The
   * window scan is bounded by recorded_at_ms like rangeStats().
   *
   * @param {{ minElevationDeg?: number, windowMs?: number, nowMs?: number,
   *           limit?: number }} [opts]
   * @returns {{
   *   minElevationDeg:number, n:number,
   *   byIcao:Array<{key:string,visits:number,bestElevationDeg:number|null,minSepDeg:number|null}>,
   *   byFlight:Array<{key:string,visits:number,bestElevationDeg:number|null,minSepDeg:number|null}>,
   * }}
   */
  usableCandidates({ minElevationDeg = 30, windowMs = 3650 * 24 * 3600_000,
                     nowMs = Date.now(), limit = 20 } = {}) {
    const since = nowMs - windowMs;
    const lim = Math.min(200, Math.max(1, limit | 0));
    const rows = this.db.prepare(
      `SELECT icao, callsign, flight, body, closest_sep_deg AS sep, payload_json
       FROM transit_history
       WHERE stage = 'imminent' AND recorded_at_ms >= ?`,
    ).all(since);

    const byIcaoM = new Map();
    const byFlightM = new Map();
    let n = 0;
    for (const r of rows) {
      let el = null;
      if (r.payload_json) {
        try {
          const p = JSON.parse(r.payload_json);
          el = p?.candidate?.aircraftAtClosest?.elevationDeg ?? null;
        } catch { /* unparseable payload → treat as unknown elevation */ }
      }
      if (!Number.isFinite(el) || el < minElevationDeg) continue;
      n += 1;
      const sep = Number.isFinite(r.sep) ? r.sep : null;
      const bump = (m, key) => {
        if (!key) return;
        const cur = m.get(key)
          ?? { key, visits: 0, bestElevationDeg: -Infinity, minSepDeg: Infinity };
        cur.visits += 1;
        if (el > cur.bestElevationDeg) cur.bestElevationDeg = el;
        if (sep != null && sep < cur.minSepDeg) cur.minSepDeg = sep;
        m.set(key, cur);
      };
      bump(byIcaoM, r.icao);
      bump(byFlightM, r.flight || r.callsign || '');
    }

    const finalize = (m) => [...m.values()]
      .map(x => ({
        key: x.key,
        visits: x.visits,
        bestElevationDeg: x.bestElevationDeg === -Infinity ? null : x.bestElevationDeg,
        minSepDeg: x.minSepDeg === Infinity ? null : x.minSepDeg,
      }))
      .sort((a, b) => b.visits - a.visits
        || (b.bestElevationDeg ?? 0) - (a.bestElevationDeg ?? 0))
      .slice(0, lim);

    return {
      minElevationDeg, n,
      byIcao: finalize(byIcaoM),
      byFlight: finalize(byFlightM),
    };
  }

  /**
   * "When do the usable hits happen?" — a 24-bin hour-of-day histogram of
   * the *usable* transits, split by body. A usable hit is the same thing the
   * Range-stats and Usable-candidates cards count: a time-confirmed real
   * transit (`stage = 'imminent'`) that actually passed inside
   * `sepBelowDeg` (default 0.5°) AND whose aircraft was at least
   * `minElevationDeg` above the horizon at closest approach (default 30°,
   * the elevation below which the long hazy slant path usually spoils the
   * shot — same gate as usableCandidates() and the Pushover notify gate).
   *
   * The hour is taken from `closest_at_ms` (the actual moment of the
   * transit, i.e. when you'd point the scope) in the **server's local
   * time** — this service runs on the Pi at the observatory, so its wall
   * clock is exactly the "time of day" the user is asking about. Elevation
   * is not a column (it lives in payload_json under
   * candidate.aircraftAtClosest.elevationDeg), so it is parsed per row,
   * mirroring usableCandidates(). ISS rows are kept, consistent with
   * rangeStats()/usableCandidates() (only episodes() excludes the ISS).
   *
   * @param {{ sepBelowDeg?: number, minElevationDeg?: number,
   *           windowMs?: number, nowMs?: number,
   *           hourOf?: (ms:number)=>number }} [opts]
   *   `hourOf` is an injection seam for deterministic tests; production
   *   leaves it at the default (server-local hour).
   * @returns {{
   *   sepBelowDeg:number, minElevationDeg:number, n:number,
   *   perBody:{ Sun:number[], Moon:number[] }, total:number[],
   *   peak:{ Sun:{hour:number,count:number}|null,
   *          Moon:{hour:number,count:number}|null,
   *          all:{hour:number,count:number}|null },
   * }}
   */
  hourStats({ sepBelowDeg = 0.5, minElevationDeg = 30,
              windowMs = 3650 * 24 * 3600_000, nowMs = Date.now(),
              hourOf = (ms) => new Date(ms).getHours() } = {}) {
    const since = nowMs - windowMs;
    const rows = this.db.prepare(
      `SELECT closest_at_ms AS at, body, payload_json
       FROM transit_history
       WHERE stage = 'imminent'
         AND closest_sep_deg IS NOT NULL AND closest_sep_deg < ?
         AND recorded_at_ms >= ?`,
    ).all(sepBelowDeg, since);

    const zero24 = () => new Array(24).fill(0);
    const perBody = { Sun: zero24(), Moon: zero24() };
    const total = zero24();
    let n = 0;
    for (const r of rows) {
      let el = null;
      if (r.payload_json) {
        try {
          const p = JSON.parse(r.payload_json);
          el = p?.candidate?.aircraftAtClosest?.elevationDeg ?? null;
        } catch { /* unparseable payload → treat as unknown elevation */ }
      }
      if (!Number.isFinite(el) || el < minElevationDeg) continue;
      const h = ((hourOf(r.at) % 24) + 24) % 24;     // clamp to 0..23
      if (r.body === 'Sun' || r.body === 'Moon') perBody[r.body][h] += 1;
      total[h] += 1;
      n += 1;
    }

    // Peak hour = the fullest bin (earliest hour wins ties so the readout
    // is stable). null when that series has no hits at all.
    const peakOf = (arr) => {
      let hour = -1, count = 0;
      for (let i = 0; i < 24; i++) if (arr[i] > count) { count = arr[i]; hour = i; }
      return hour < 0 ? null : { hour, count };
    };

    return {
      sepBelowDeg, minElevationDeg, n,
      perBody, total,
      peak: { Sun: peakOf(perBody.Sun), Moon: peakOf(perBody.Moon), all: peakOf(total) },
    };
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
  /**
   * Record the projected sep at the moment a live entry transitioned to
   * stale-faded. Updates ALL transit_history rows for this (icao, body,
   * closest_at_ms) episode in one go so the consolidated history view
   * can show "was best (now last)" alongside the existing stage rows.
   *
   * No-op when the entry has no DB rows yet (e.g. went stale before any
   * stage transition was emitted) — that's fine, then there's nothing
   * to annotate either.
   *
   * @param {string} icao
   * @param {string} body
   * @param {number} closestAtMs
   * @param {number} lastSepDeg   - the value at fade time
   */
  recordFinalSep(icao, body, closestAtMs, lastSepDeg) {
    if (!icao || !body || !Number.isFinite(closestAtMs) || !Number.isFinite(lastSepDeg)) return;
    this.db.prepare(
      `UPDATE transit_history
       SET last_sep_deg = ?
       WHERE icao = ? AND body = ? AND closest_at_ms = ?`,
    ).run(lastSepDeg, icao, body, closestAtMs);
  }

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

    // History-display outcome (v0.14.1). Sharper than the learning-panel
    // taxonomy: only an `imminent` stage means the close approach was
    // actually reached (±30 s, time-confirmed). A `candidate` that never
    // reached `imminent` was only *predicted* — the flight diverged / left
    // the band before the ETA (this is exactly the "stale in Live but
    // graduated in History" confusion). 'faded' = radio that never
    // tightened. (Learning aggregates in episodes() are unchanged.)
    const classify = (stages) => {
      if (stages.has('imminent')) return 'confirmed';
      if (stages.has('candidate')) return 'predicted';
      return 'faded';
    };

    const consolidated = Array.from(byKey.values()).map(ep => {
      const earliest = ep.rows.reduce((a, b) =>
        a.recorded_at_ms < b.recorded_at_ms ? a : b);
      const tightest = ep.rows.reduce((a, b) =>
        ((a.closest_sep_deg ?? Infinity) < (b.closest_sep_deg ?? Infinity)) ? a : b);
      // Headline geometry: prefer an `imminent` row (truest — sampled at
      // the ±30 s of real closest approach), else the tightest *predicted*
      // row. sepConfirmed lets the UI strike through a sep that never
      // actually happened.
      const imminentRows = ep.rows.filter(r => r.stage === 'imminent');
      const base = imminentRows.length
        ? imminentRows.reduce((a, b) =>
          ((a.closest_sep_deg ?? Infinity) < (b.closest_sep_deg ?? Infinity)) ? a : b)
        : tightest;
      const topStage = ep.rows.reduce((a, b) =>
        (STAGE_RANK[a.stage] ?? 0) >= (STAGE_RANK[b.stage] ?? 0) ? a : b);
      const flight = ep.rows.map(r => r.flight).filter(Boolean).pop() ?? null;
      const callsign = ep.rows.map(r => r.callsign).filter(Boolean).pop() ?? null;
      return {
        ...base,
        recorded_at_ms: earliest.recorded_at_ms,
        stage: topStage.stage,
        stages: Array.from(ep.stages),
        flight,
        callsign,
        outcome: classify(ep.stages),
        sepConfirmed: imminentRows.length > 0,
        leadTimeMs: base.closest_at_ms - earliest.recorded_at_ms,
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
      // Alert-learning is an ADS-B-traffic quality signal: hit/surprise/
      // graze rates are "of the aircraft we detected …". The ISS is a
      // deliberately-hunted rare orbital event from a different pipeline —
      // including its rows would skew every aggregate (it would read as a
      // permanent 'surprise' graze). Excluded here only; consolidatedHistory
      // (the History *table*) still keeps ISS so the user sees it there.
      .prepare(`SELECT id, recorded_at_ms, closest_at_ms, stage, body, icao,
                       callsign, flight, closest_sep_deg
                FROM transit_history
                WHERE recorded_at_ms >= ? AND icao <> 'ISS'
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
