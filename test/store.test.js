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
});
