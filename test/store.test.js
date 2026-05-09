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
});
