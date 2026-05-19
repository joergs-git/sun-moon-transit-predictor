import { describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/store.js';

function makeCandidate({ icao = 'abc123', body = 'Sun', closestInMs = 90_000,
                        callsign = 'DLH123', sepDeg = 0.12, durationMs = 4000 } = {}) {
  return {
    icao,
    callsign,
    body,
    closestApproachAtMs: 1_000_000_000_000 + closestInMs,
    closestApproachSepDeg: sepDeg,
    entersAtMs: 1_000_000_000_000 + closestInMs - durationMs / 2,
    leavesAtMs: 1_000_000_000_000 + closestInMs + durationMs / 2,
    durationMs,
    aircraftAtClosest: { azimuthDeg: 180, elevationDeg: 60, rangeM: 12000 },
    bodyAtClosest: { azimuthDeg: 180, elevationDeg: 60, rangeM: 1.5e11 },
    aircraft: {
      icao,
      callsign,
      lat: 52.5,
      lon: 7.5,
      altMmsl: 10668,
      altSource: 'geometric',
      groundSpeedMs: 230,
      trackDeg: 90,
      verticalRateMs: 0,
      seenPosS: 0.5,
      receivedAtMs: 1_000_000_000_000,
    },
  };
}

describe('HistoryStore', () => {
  it('persists transit events and returns them in reverse-chronological order', () => {
    const store = new HistoryStore(':memory:');
    try {
      const c = makeCandidate();
      store.recordEvent('early',   c, null, 1_000_000_000_000);
      store.recordEvent('precise', c, {
        flight: 'LH123',
        airline: { name: 'Lufthansa' },
        origin: { iata: 'FRA' },
        destination: { iata: 'JFK' },
      }, 1_000_000_000_000 + 60_000);

      const rows = store.recent({ limit: 10 });
      expect(rows.length).toBe(2);
      expect(rows[0].stage).toBe('precise');
      expect(rows[0].flight).toBe('LH123');
      expect(rows[0].origin).toBe('FRA');
      expect(rows[0].destination).toBe('JFK');
      expect(rows[1].stage).toBe('early');
      expect(rows[1].flight).toBeNull();
      expect(store.count()).toBe(2);
    } finally {
      store.close();
    }
  });

  it('honours the limit parameter', () => {
    const store = new HistoryStore(':memory:');
    try {
      for (let i = 0; i < 5; i += 1) {
        store.recordEvent('early', makeCandidate({ icao: `a${i}` }), null, 1_000_000_000_000 + i);
      }
      expect(store.recent({ limit: 3 }).length).toBe(3);
      expect(store.recent({ limit: 10 }).length).toBe(5);
    } finally {
      store.close();
    }
  });

  it('classifies episodes (graduated / faded / surprise) from recorded stages', () => {
    const store = new HistoryStore(':memory:');
    try {
      const nowMs = 1_700_000_000_000;
      // Episode 1 — radio then candidate then imminent → graduated
      const a = makeCandidate({ icao: 'aaa111', body: 'Sun', sepDeg: 0.9, closestInMs: 0 });
      a.closestApproachAtMs = nowMs - 3 * 3600_000;
      store.recordEvent('radio',     a, null, a.closestApproachAtMs - 60_000);
      store.recordEvent('candidate', a, null, a.closestApproachAtMs - 30_000);
      store.recordEvent('imminent',  { ...a, closestApproachSepDeg: 0.18 },
                        null, a.closestApproachAtMs);
      // Episode 2 — radio only → faded
      const b = makeCandidate({ icao: 'bbb222', body: 'Moon', sepDeg: 0.7, closestInMs: 0 });
      b.closestApproachAtMs = nowMs - 6 * 3600_000;
      store.recordEvent('radio', b, null, b.closestApproachAtMs - 60_000);
      // Episode 3 — candidate without prior radio → surprise
      const c = makeCandidate({ icao: 'ccc333', body: 'Sun', sepDeg: 0.22, closestInMs: 0 });
      c.closestApproachAtMs = nowMs - 8 * 3600_000;
      store.recordEvent('candidate', c, null, c.closestApproachAtMs);

      const { episodes, aggregates } = store.episodes({ windowMs: 24 * 3600_000, nowMs });
      expect(episodes.length).toBe(3);
      // Episodes come back newest first.
      const outcomes = episodes.map(e => e.outcome);
      expect(outcomes).toEqual(['graduated', 'faded', 'surprise']);
      expect(aggregates.radioFired).toBe(2);
      expect(aggregates.radioGraduated).toBe(1);
      expect(aggregates.radioFaded).toBe(1);
      expect(aggregates.surprises).toBe(1);
      expect(aggregates.totalEpisodes).toBe(3);
      // 1 of 2 radios graduated → 50 %
      expect(aggregates.hitRatePct).toBe(50);
      // 1 of 2 tight transits had no prior radio → 50 %
      expect(aggregates.surpriseRatePct).toBe(50);
      // The graduated episode should carry the tighter sep from the imminent row.
      expect(episodes[0].minSepDeg).toBeCloseTo(0.18, 5);
    } finally {
      store.close();
    }
  });

  it('consolidates a three-stage episode into one history row', () => {
    const store = new HistoryStore(':memory:');
    try {
      const nowMs = 1_700_000_000_000;
      const a = makeCandidate({ icao: 'aaa111', body: 'Sun', sepDeg: 0.9, closestInMs: 0 });
      a.closestApproachAtMs = nowMs - 3 * 3600_000;
      // radio fires earliest (T-90s), candidate at T-30s, imminent at T-0
      // with the refined geometry and the tightest sep value.
      store.recordEvent('radio',     { ...a, closestApproachSepDeg: 0.9 },
                        null, a.closestApproachAtMs - 90_000);
      store.recordEvent('candidate', { ...a, closestApproachSepDeg: 0.25 },
                        null, a.closestApproachAtMs - 30_000);
      store.recordEvent('imminent',  { ...a, closestApproachSepDeg: 0.18 },
                        null, a.closestApproachAtMs);

      const rows = store.consolidatedHistory({ limit: 10, windowMs: 24 * 3600_000, nowMs });
      expect(rows.length).toBe(1);
      const r = rows[0];
      // Earliest recorded_at_ms (radio stage) wins for the time column.
      expect(r.recorded_at_ms).toBe(a.closestApproachAtMs - 90_000);
      // Imminent row drives the headline geometry (real closest approach).
      expect(r.closest_sep_deg).toBeCloseTo(0.18, 5);
      // Highest stage reached.
      expect(r.stage).toBe('imminent');
      // All three stages remembered.
      expect(r.stages.sort()).toEqual(['candidate', 'imminent', 'radio']);
      // v0.14.1: imminent fired → 'confirmed' and the sep actually happened.
      expect(r.outcome).toBe('confirmed');
      expect(r.sepConfirmed).toBe(true);
      // Lead time is the full radio→imminent span.
      expect(r.leadTimeMs).toBe(90_000);
    } finally {
      store.close();
    }
  });

  it('marks a candidate that never reached imminent as predicted/unconfirmed', () => {
    const store = new HistoryStore(':memory:');
    try {
      const nowMs = 1_700_500_000_000;
      const a = makeCandidate({ icao: 'bbb222', body: 'Moon', sepDeg: 0.2, closestInMs: 0 });
      a.closestApproachAtMs = nowMs - 2 * 3600_000;
      // radio then a tight candidate prediction — but the flight diverged,
      // imminent NEVER fired (the "stale in Live, graduated in History" bug).
      store.recordEvent('radio',     { ...a, closestApproachSepDeg: 1.4 },
                        null, a.closestApproachAtMs - 600_000);
      store.recordEvent('candidate', { ...a, closestApproachSepDeg: 0.2 },
                        null, a.closestApproachAtMs - 400_000);

      const [r] = store.consolidatedHistory({ limit: 10, windowMs: 24 * 3600_000, nowMs });
      expect(r.outcome).toBe('predicted');     // not 'confirmed'/'graduated'
      expect(r.sepConfirmed).toBe(false);      // → UI strikes the sep through
      expect(r.closest_sep_deg).toBeCloseTo(0.2, 5); // tightest *predicted*
      expect(r.stage).toBe('candidate');       // never reached imminent
    } finally {
      store.close();
    }
  });

  it('aggregates per-body disc-graze rates from episode min separations', () => {
    const store = new HistoryStore(':memory:');
    try {
      const nowMs = 1_700_000_000_000;
      const mk = (icao, body, sepDeg, closestAt) => {
        const c = makeCandidate({ icao, body, sepDeg, closestInMs: 0 });
        c.closestApproachAtMs = closestAt;
        store.recordEvent('candidate', c, null, closestAt);
      };
      // 4 episodes total: 2× Sun (one graze 0.18°, one miss 0.5°),
      //                  2× Moon (one graze 0.22°, one miss 0.7°).
      mk('aaa', 'Sun',  0.18, nowMs - 1 * 3600_000);
      mk('bbb', 'Sun',  0.50, nowMs - 2 * 3600_000);
      mk('ccc', 'Moon', 0.22, nowMs - 3 * 3600_000);
      mk('ddd', 'Moon', 0.70, nowMs - 4 * 3600_000);

      const { aggregates: a } = store.episodes({ windowMs: 24 * 3600_000, nowMs });
      expect(a.totalEpisodes).toBe(4);
      expect(a.sunGrazes).toBe(1);
      expect(a.moonGrazes).toBe(1);
      expect(a.grazeThresholdDeg).toBe(0.3);
      // Denominator is the full pool (4), so each body = 25 %.
      expect(a.sunGrazePct).toBe(25);
      expect(a.moonGrazePct).toBe(25);
    } finally {
      store.close();
    }
  });

  it('keeps two same-flight approaches more than an episode-window apart separate', () => {
    const store = new HistoryStore(':memory:');
    try {
      const nowMs = 1_700_000_000_000;
      const make = (closestAtMs, stage) => {
        const c = makeCandidate({ icao: 'same111', body: 'Sun', sepDeg: 0.5, closestInMs: 0 });
        c.closestApproachAtMs = closestAtMs;
        store.recordEvent(stage, c, null, closestAtMs);
      };
      // Two transits ~3 h apart — distinct episodes.
      make(nowMs - 6 * 3600_000, 'radio');
      make(nowMs - 6 * 3600_000 + 30_000, 'candidate');
      make(nowMs - 3 * 3600_000, 'radio');
      const { episodes } = store.episodes({ windowMs: 24 * 3600_000, nowMs });
      expect(episodes.length).toBe(2);
    } finally {
      store.close();
    }
  });

  it('excludes ISS rows from learning aggregates but keeps them in History', () => {
    const store = new HistoryStore(':memory:');
    try {
      const nowMs = 1_000_000_000_000;
      const plane = makeCandidate({ icao: 'abc123', sepDeg: 0.15, closestInMs: 0 });
      const iss = makeCandidate({ icao: 'ISS', callsign: 'ISS (ZARYA)', sepDeg: 0.1, closestInMs: 60_000 });
      store.recordEvent('candidate', plane, null, nowMs - 1000);
      store.recordEvent('imminent',  iss,   null, nowMs - 500);

      // Learning: ISS must NOT contaminate the episode aggregates.
      const { episodes, aggregates } = store.episodes({ windowMs: 24 * 3600_000, nowMs: nowMs + 120_000 });
      expect(episodes.every(e => e.icao !== 'ISS')).toBe(true);
      expect(aggregates.totalEpisodes).toBe(1);

      // History table: ISS row IS still present.
      const hist = store.consolidatedHistory({ nowMs: nowMs + 120_000 });
      expect(hist.some(r => r.icao === 'ISS')).toBe(true);
      expect(hist.some(r => r.icao === 'abc123')).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('HistoryStore — aircraft sightings (persistent tally)', () => {
  const GAP = 30 * 60 * 1000;

  it('counts a visit on first sight and again only after the gap', () => {
    const store = new HistoryStore(':memory:');
    try {
      const t0 = 1_000_000_000_000;
      expect(store.recordSighting('icao', '3c6444', t0, GAP)).toBe(true);          // new
      expect(store.recordSighting('icao', '3c6444', t0 + 5 * 60_000, GAP)).toBe(false); // within gap
      expect(store.recordSighting('icao', '3c6444', t0 + 40 * 60_000, GAP)).toBe(true); // > gap → +1
      const [row] = store.topSightings({ kind: 'icao' });
      expect(row.key).toBe('3c6444');
      expect(row.visits).toBe(2);
      expect(row.firstSeenMs).toBe(t0);
      expect(row.lastSeenMs).toBe(t0 + 40 * 60_000);
    } finally { store.close(); }
  });

  it('touchSighting advances last_seen without a visit bump', () => {
    const store = new HistoryStore(':memory:');
    try {
      const t0 = 2_000_000_000_000;
      store.recordSighting('flight', 'DLH4AB', t0, GAP);
      store.touchSighting('flight', 'DLH4AB', t0 + 90_000);
      const [row] = store.topSightings({ kind: 'flight' });
      expect(row.visits).toBe(1);
      expect(row.lastSeenMs).toBe(t0 + 90_000);
    } finally { store.close(); }
  });

  it('ranks by visits desc and separates kinds; totals aggregate', () => {
    const store = new HistoryStore(':memory:');
    try {
      let t = 3_000_000_000_000;
      const visit = (kind, key, n) => {
        for (let i = 0; i < n; i++) { store.recordSighting(kind, key, t, GAP); t += GAP + 1000; }
      };
      visit('icao', 'aaa111', 3);
      visit('icao', 'bbb222', 5);
      visit('flight', 'BAW7', 2);
      const ic = store.topSightings({ kind: 'icao', limit: 10 });
      expect(ic.map(r => r.key)).toEqual(['bbb222', 'aaa111']);
      expect(ic[0].visits).toBe(5);
      expect(store.topSightings({ kind: 'flight' }).length).toBe(1);
      const tot = store.sightingTotals();
      expect(tot.icao.distinctKeys).toBe(2);
      expect(tot.icao.totalVisits).toBe(8);
      expect(tot.flight.totalVisits).toBe(2);
    } finally { store.close(); }
  });
});

describe('HistoryStore — rangeStats (retrospective close-pass distances)', () => {
  it('aggregates only imminent rows that actually passed < sepBelowDeg', () => {
    const store = new HistoryStore(':memory:');
    try {
      const nowMs = 2_000_000_000_000;
      // The five rows that should count: imminent, range known, sep < 0.5,
      // inside the window. Sep 0.4 is the only one outside the ~disc radius.
      const sample = [
        [4000,  'Sun',  0.2],
        [8000,  'Moon', 0.2],
        [12000, 'Sun',  0.2],
        [16000, 'Moon', 0.2],
        [20000, 'Sun',  0.4],
      ];
      for (const [r, body, sep] of sample) {
        store.recordEvent('imminent', {
          ...makeCandidate({ body, sepDeg: sep }),
          aircraftAtClosest: { azimuthDeg: 180, elevationDeg: 60, rangeM: r },
        }, null, nowMs - 1000);
      }

      // Excluded: not imminent / sep ≥ 0.5 / range unknown / out of window.
      store.recordEvent('candidate', {
        ...makeCandidate({ body: 'Sun', sepDeg: 0.1 }),
        aircraftAtClosest: { azimuthDeg: 0, elevationDeg: 0, rangeM: 5000 },
      }, null, nowMs - 1000);
      store.recordEvent('imminent', {
        ...makeCandidate({ body: 'Sun', sepDeg: 0.6 }),
        aircraftAtClosest: { azimuthDeg: 0, elevationDeg: 0, rangeM: 9000 },
      }, null, nowMs - 1000);
      store.recordEvent('imminent', {
        ...makeCandidate({ body: 'Sun', sepDeg: 0.2 }),
        aircraftAtClosest: { azimuthDeg: 0, elevationDeg: 0, rangeM: null },
      }, null, nowMs - 1000);
      store.recordEvent('imminent', {
        ...makeCandidate({ body: 'Moon', sepDeg: 0.2 }),
        aircraftAtClosest: { azimuthDeg: 0, elevationDeg: 0, rangeM: 7000 },
      }, null, nowMs - 2 * 24 * 3600_000); // older than the 1-day window

      const s = store.rangeStats({
        sepBelowDeg: 0.5, windowMs: 24 * 3600_000, nowMs, buckets: 10,
      });
      expect(s.n).toBe(5);
      expect(s.minM).toBe(4000);
      expect(s.maxM).toBe(20000);
      expect(s.medianM).toBe(12000);
      expect(s.meanM).toBe(12000);
      expect(s.p90M).toBe(20000);
      expect(s.onDisc).toBe(4);                       // the 0.4° one is off-disc
      expect(s.perBody).toEqual({ Sun: 3, Moon: 2 });
      expect(s.histogram.length).toBe(10);
      expect(s.histogram.reduce((a, b) => a + b.count, 0)).toBe(5);
    } finally { store.close(); }
  });

  it('returns a zeroed shape when nothing qualifies', () => {
    const store = new HistoryStore(':memory:');
    try {
      const s = store.rangeStats({ nowMs: 2_000_000_000_000 });
      expect(s.n).toBe(0);
      expect(s.minM).toBeNull();
      expect(s.medianM).toBeNull();
      expect(s.histogram).toEqual([]);
      expect(s.perBody).toEqual({ Sun: 0, Moon: 0 });
    } finally { store.close(); }
  });
});

describe('HistoryStore — usableCandidates (elevation-gated real transits)', () => {
  it('keeps only imminent rows whose elevation ≥ gate, grouped by icao/flight', () => {
    const store = new HistoryStore(':memory:');
    try {
      const nowMs = 2_000_000_000_000;
      const at = nowMs - 1000;
      const rec = (stage, icao, callsign, el, sep) => {
        const c = makeCandidate({ icao, callsign, sepDeg: sep });
        c.aircraftAtClosest = { azimuthDeg: 180, elevationDeg: el, rangeM: 12000 };
        store.recordEvent(stage, c, null, at);
      };
      // Counted: imminent, elevation ≥ 30°.
      rec('imminent', 'aaa111', 'DLHAAA', 50, 0.2);
      rec('imminent', 'aaa111', 'DLHAAA', 47, 0.1);   // 2nd usable pass, tighter sep
      rec('imminent', 'bbb222', 'DLHBBB', 35, 0.4);
      // Excluded: too low (elevation < gate).
      rec('imminent', 'ccc333', 'DLHCCC', 20, 0.2);
      // Excluded: not an imminent (confirmed) transit.
      rec('candidate', 'ddd444', 'DLHDDD', 80, 0.2);

      const u = store.usableCandidates({
        minElevationDeg: 30, windowMs: 24 * 3600_000, nowMs, limit: 20,
      });
      expect(u.minElevationDeg).toBe(30);
      expect(u.n).toBe(3);                              // 2×aaa + 1×bbb
      expect(u.byIcao.map((x) => x.key)).toEqual(['aaa111', 'bbb222']);
      const aaa = u.byIcao.find((x) => x.key === 'aaa111');
      expect(aaa.visits).toBe(2);
      expect(aaa.bestElevationDeg).toBe(50);
      expect(aaa.minSepDeg).toBeCloseTo(0.1, 6);
      expect(u.byFlight.map((x) => x.key)).toEqual(['DLHAAA', 'DLHBBB']);

      // Gate 0 disables the elevation filter (still imminent-only → ccc joins).
      const all = store.usableCandidates({
        minElevationDeg: 0, windowMs: 24 * 3600_000, nowMs,
      });
      expect(all.n).toBe(4);
      expect(all.byIcao.some((x) => x.key === 'ddd444')).toBe(false); // candidate excluded
    } finally { store.close(); }
  });
});

describe('HistoryStore — hourStats (best hours for usable hits)', () => {
  // Deterministic, timezone-independent hour: derive the bin straight from
  // closest_at_ms instead of the server's local clock.
  const hourOf = (ms) => Math.floor(ms / 3600_000) % 24;

  it('buckets imminent / sep<0.5 / elevation≥gate hits per body & hour', () => {
    const store = new HistoryStore(':memory:');
    try {
      const nowMs = 2_000_000_000_000;
      const at = nowMs - 1000;                         // inside the window
      const rec = (stage, body, hour, sep, el, recordedAt = at) => {
        const c = makeCandidate({ body, sepDeg: sep });
        c.closestApproachAtMs = hour * 3600_000;       // hourOf → `hour`
        c.aircraftAtClosest = { azimuthDeg: 180, elevationDeg: el, rangeM: 12000 };
        store.recordEvent(stage, c, null, recordedAt);
      };
      // Counted.
      rec('imminent', 'Sun',  9, 0.2, 50);
      rec('imminent', 'Sun',  9, 0.1, 40);             // peak Sun = 09h (×2)
      rec('imminent', 'Sun', 14, 0.3, 35);
      rec('imminent', 'Moon', 22, 0.2, 60);
      rec('imminent', 'Moon', 22, 0.4, 33);            // peak Moon = 22h (×2)
      rec('imminent', 'Moon',  6, 0.2, 31);
      // Excluded: low / wide / not confirmed / outside the window.
      rec('imminent',  'Sun', 3, 0.2, 20);             // elevation < gate
      rec('imminent',  'Sun', 4, 0.6, 80);             // sep ≥ 0.5
      rec('candidate', 'Sun', 9, 0.1, 80);             // not imminent
      rec('imminent',  'Sun', 9, 0.1, 80, nowMs - 2 * 24 * 3600_000); // old

      const s = store.hourStats({
        sepBelowDeg: 0.5, minElevationDeg: 30,
        windowMs: 24 * 3600_000, nowMs, hourOf,
      });

      expect(s.n).toBe(6);
      expect(s.perBody.Sun.length).toBe(24);
      expect(s.perBody.Sun[9]).toBe(2);
      expect(s.perBody.Sun[14]).toBe(1);
      expect(s.perBody.Moon[22]).toBe(2);
      expect(s.perBody.Moon[6]).toBe(1);
      expect(s.perBody.Sun.reduce((a, b) => a + b, 0)).toBe(3);
      expect(s.perBody.Moon.reduce((a, b) => a + b, 0)).toBe(3);
      expect(s.total[9]).toBe(2);
      expect(s.total[22]).toBe(2);
      expect(s.peak.Sun).toEqual({ hour: 9, count: 2 });
      expect(s.peak.Moon).toEqual({ hour: 22, count: 2 });
      // Tie on the combined series (09h & 22h both 2) → earliest hour wins.
      expect(s.peak.all).toEqual({ hour: 9, count: 2 });
    } finally { store.close(); }
  });

  it('returns a zeroed 24-bin shape when nothing qualifies', () => {
    const store = new HistoryStore(':memory:');
    try {
      const s = store.hourStats({ nowMs: 2_000_000_000_000, hourOf });
      expect(s.n).toBe(0);
      expect(s.perBody.Sun).toEqual(new Array(24).fill(0));
      expect(s.perBody.Moon).toEqual(new Array(24).fill(0));
      expect(s.total).toEqual(new Array(24).fill(0));
      expect(s.peak).toEqual({ Sun: null, Moon: null, all: null });
    } finally { store.close(); }
  });

  it('defaults to the server-local hour of closest_at_ms', () => {
    const store = new HistoryStore(':memory:');
    try {
      const nowMs = 2_000_000_000_000;
      // Two usable Sun hits at the same wall-clock hour (1 h apart in days).
      const t1 = nowMs - 3 * 3600_000;
      const t2 = t1 - 24 * 3600_000;
      for (const t of [t1, t2]) {
        const c = makeCandidate({ body: 'Sun', sepDeg: 0.2 });
        c.closestApproachAtMs = t;
        c.aircraftAtClosest = { azimuthDeg: 180, elevationDeg: 55, rangeM: 12000 };
        store.recordEvent('imminent', c, null, nowMs - 1000);
      }
      const s = store.hourStats({ windowMs: 30 * 24 * 3600_000, nowMs });
      const expectedHour = new Date(t1).getHours();     // == new Date(t2)
      expect(s.n).toBe(2);
      expect(s.perBody.Sun[expectedHour]).toBe(2);
      expect(s.peak.Sun).toEqual({ hour: expectedHour, count: 2 });
    } finally { store.close(); }
  });
});
