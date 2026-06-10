import { describe, expect, it } from 'vitest';
import { lifecycleArray, updateLifecycle } from '../src/lifecycle.js';

const NOW = 1_000_000_000_000;
const HOUR = 3600_000;

function trackerCand({
  icao = 'aaa111', body = 'Sun', level = 'candidate',
  closestAtSec = 90, sep = 0.18, callsign = 'LH123',
} = {}) {
  return {
    icao, body, level, callsign,
    closestApproachAtMs: NOW + closestAtSec * 1000,
    closestApproachSepDeg: sep,
    aircraft: { altMmsl: 11000, groundSpeedMs: 230, trackDeg: 90 },
    route: { flight: callsign },
  };
}

function expectedEntry({
  flight = 'LH123', body = 'Sun', etaMin = 30, stdevMin = 5,
} = {}) {
  return {
    flight, body,
    expectedAtMs: NOW + etaMin * 60_000,
    etaMs: etaMin * 60_000,
    observations: 5,
    distinctDays: 5,
    stdevMs: stdevMin * 60_000,
  };
}

describe('updateLifecycle', () => {
  it('promotes a tracker candidate to imminent when within ±30 s', () => {
    const map = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [trackerCand({ closestAtSec: 20, level: 'candidate' })],
      expected: [],
      liveAircraft: [],
    });
    expect(map.size).toBe(1);
    const entry = Array.from(map.values())[0];
    expect(entry.status).toBe('imminent');
  });

  it('classifies a level=radio tracker hit as status=radio', () => {
    const map = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [trackerCand({ level: 'radio', sep: 2.0 })],
      expected: [],
      liveAircraft: [],
    });
    expect(Array.from(map.values())[0].status).toBe('radio');
  });

  it('adds expected entries inside the planned window as status=planned', () => {
    const map = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [],
      expected: [expectedEntry({ etaMin: 30 })],         // within 1h → planned
      liveAircraft: [],
    });
    expect(map.size).toBe(1);
    const entry = Array.from(map.values())[0];
    expect(entry.status).toBe('planned');
    expect(entry.flight).toBe('LH123');
  });

  it('skips planned entries outside the planned window', () => {
    const map = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [],
      expected: [expectedEntry({ etaMin: 180 })],        // 3 h away — outside 1h window
      liveAircraft: [],
      plannedWindowMs: HOUR,
    });
    expect(map.size).toBe(0);
  });

  it('prefers a tracker hit over a watchlist entry for the same flight+body', () => {
    const map = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [trackerCand({ callsign: 'LH123' })],
      expected: [expectedEntry({ flight: 'LH123' })],
      liveAircraft: [],
    });
    expect(map.size).toBe(1);
    expect(Array.from(map.values())[0].status).toBe('candidate');
  });

  it('drops a watchlist entry when the callsign is in live ADS-B', () => {
    // Even though the tracker did NOT classify LH123 as a transit candidate
    // this tick (e.g., off-course today), the aircraft is on air and visible
    // in ADS-B. The watchlist's historical pattern is no longer the best
    // signal we have — suppress the planned entry. v0.7.8+ behaviour, after
    // the user's "Die plandaten waren nicht als anreicherung gedacht" call.
    const map = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [],
      expected: [expectedEntry({ flight: 'LH123' })],
      liveAircraft: [{ icao: 'aaa111', callsign: 'LH123' }],
    });
    expect(map.size).toBe(0);
  });

  it('keeps a watchlist entry when the callsign is NOT in live ADS-B', () => {
    // Same setup as above but the aircraft hasn't entered ADS-B reception
    // yet — the planned entry IS the only signal we have, so keep it.
    const map = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [],
      expected: [expectedEntry({ flight: 'LH123' })],
      liveAircraft: [],
    });
    expect(map.size).toBe(1);
    expect(Array.from(map.values())[0].status).toBe('planned');
  });

  it('marks a missing previous entry as stale within the grace period', () => {
    const first = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [trackerCand()],
      expected: [],
      liveAircraft: [],
    });
    // Next tick 5 s later — aircraft no longer flagged by the tracker.
    // coastMs:0 disables the v0.8.0 coast so this stays a pure stale test.
    const second = updateLifecycle({
      prev: first,
      nowMs: NOW + 5000,
      trackerCandidates: [],
      expected: [],
      liveAircraft: [],
      staleGraceMs: 10_000,
      coastMs: 0,
    });
    expect(second.size).toBe(1);
    expect(Array.from(second.values())[0].status).toBe('stale');
  });

  it('drops stale entries once the grace period elapses (when staleGraceMs > 0)', () => {
    const first = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [trackerCand()],
      expected: [],
      liveAircraft: [],
    });
    const second = updateLifecycle({
      prev: first,
      nowMs: NOW + 15_000,
      trackerCandidates: [],
      expected: [],
      liveAircraft: [],
      staleGraceMs: 10_000,
      coastMs: 0,
    });
    expect(second.size).toBe(0);
  });

  it('keeps stale entries indefinitely when staleGraceMs is 0 (default)', () => {
    const first = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [trackerCand()],
      expected: [],
      liveAircraft: [],
    });
    // Simulate a full hour without further activity — entry must still be
    // present and flagged stale; the only way it leaves the panel is via
    // the 20-cap (covered by a separate test below).
    const later = updateLifecycle({
      prev: first,
      nowMs: NOW + 3600_000,
      trackerCandidates: [],
      expected: [],
      liveAircraft: [],
    });
    expect(later.size).toBe(1);
    expect(Array.from(later.values())[0].status).toBe('stale');
  });

  it('preserves firstSeenMs across promotions', () => {
    const t0 = NOW;
    const m1 = updateLifecycle({
      prev: new Map(),
      nowMs: t0,
      trackerCandidates: [trackerCand({ level: 'radio', sep: 2.0 })],
      expected: [],
      liveAircraft: [],
    });
    const m2 = updateLifecycle({
      prev: m1,
      nowMs: t0 + 30_000,
      trackerCandidates: [trackerCand({ level: 'candidate', sep: 0.15 })],
      expected: [],
      liveAircraft: [],
    });
    const e = Array.from(m2.values())[0];
    expect(e.firstSeenMs).toBe(t0);
    expect(e.status).toBe('candidate');
    expect(e.highestStatusReached).toBe('candidate');
  });
});

describe('maxEntries cap', () => {
  it('drops the oldest stale entries first when the cap is hit', () => {
    // Build a previous tick with 5 stale entries (different lastUpdateMs)
    // plus 3 active candidates this tick. With maxEntries=5, we expect all
    // 3 active to survive and only the 2 newest stale to remain.
    const prev = new Map();
    for (let i = 0; i < 5; i++) {
      prev.set(`stale${i}|Sun`, {
        key: `stale${i}|Sun`,
        status: 'stale',          // pre-flagged stale to simplify the test
        body: 'Sun',
        icao: `stale${i}`,
        flight: null,
        callsign: null,
        closestApproachAtMs: NOW - 5000,
        closestApproachSepDeg: 0.2,
        firstSeenMs: NOW - 30_000,
        lastUpdateMs: NOW - (10 - i) * 1000,    // 10s, 9s, ..., 6s ago
        highestStatusReached: 'candidate',
        route: null,
        candidate: null,
        watchlistEntry: null,
      });
    }
    const next = updateLifecycle({
      prev,
      nowMs: NOW,
      trackerCandidates: [
        trackerCand({ icao: 'active1', closestAtSec: 100 }),
        trackerCand({ icao: 'active2', closestAtSec: 120 }),
        trackerCand({ icao: 'active3', closestAtSec: 140 }),
      ],
      expected: [],
      liveAircraft: [],
      maxEntries: 5,
      staleGraceMs: 60_000,
    });
    expect(next.size).toBe(5);
    const icaos = Array.from(next.values()).map(e => e.icao).sort();
    // 3 actives must be present
    expect(icaos).toContain('active1');
    expect(icaos).toContain('active2');
    expect(icaos).toContain('active3');
    // The 2 newest stale (stale3 and stale4 — most recent lastUpdateMs)
    // survive; the 3 oldest (stale0–stale2) are dropped.
    expect(icaos).toContain('stale3');
    expect(icaos).toContain('stale4');
    expect(icaos).not.toContain('stale0');
    expect(icaos).not.toContain('stale1');
    expect(icaos).not.toContain('stale2');
  });
});

describe('lifecycleArray', () => {
  it('sorts by imminence (soonest closest-approach first)', () => {
    // Two ticks: 'first' is 200 s out, 'second' is 25 s out. The sooner one
    // ('second') lands at the top — position is by imminence, not detection age.
    const after1 = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [trackerCand({ icao: 'first', closestAtSec: 200 })],
      expected: [],
      liveAircraft: [],
    });
    const after2 = updateLifecycle({
      prev: after1,
      nowMs: NOW + 1000,
      trackerCandidates: [
        trackerCand({ icao: 'first',  closestAtSec: 200 }),
        trackerCand({ icao: 'second', closestAtSec: 25, level: 'candidate' }),
      ],
      expected: [],
      liveAircraft: [],
    });
    const arr = lifecycleArray(after2, NOW + 1000);
    expect(arr.map(e => e.icao)).toEqual(['second', 'first']);
    // Status pill is still derived per row; position no longer depends on it.
    expect(arr[0].status).toBe('imminent');
    expect(arr[1].status).toBe('candidate');
  });

  it('orders by ETA — nearer before farther', () => {
    const map = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [
        trackerCand({ icao: 'far',  closestAtSec: 200, level: 'candidate' }),
        trackerCand({ icao: 'near', closestAtSec: 25,  level: 'candidate' }),
      ],
      expected: [],
      liveAircraft: [],
    });
    const arr = lifecycleArray(map, NOW);
    // Both seeded in the same tick → firstSeenMs is identical → tiebreak by
    // ETA: 'near' (25 s) comes before 'far' (200 s).
    expect(arr.map(e => e.icao)).toEqual(['near', 'far']);
  });
});

describe('updateLifecycle — coasting (v0.8.0)', () => {
  it('holds the last live status through a brief ADS-B gap', () => {
    const first = updateLifecycle({
      prev: new Map(), nowMs: NOW,
      trackerCandidates: [trackerCand({ level: 'candidate' })],
      expected: [], liveAircraft: [],
    });
    // 5 s gap, default coastMs (25 s) → still 'candidate', flagged coasting.
    const second = updateLifecycle({
      prev: first, nowMs: NOW + 5000,
      trackerCandidates: [], expected: [], liveAircraft: [],
    });
    const e = Array.from(second.values())[0];
    expect(e.status).toBe('candidate');
    expect(e.coasting).toBe(true);
  });

  it('decays to stale once the coast window is exceeded', () => {
    const first = updateLifecycle({
      prev: new Map(), nowMs: NOW,
      trackerCandidates: [trackerCand({ level: 'candidate' })],
      expected: [], liveAircraft: [],
    });
    const second = updateLifecycle({
      prev: first, nowMs: NOW + 30_000,   // > 25 s coast window
      trackerCandidates: [], expected: [], liveAircraft: [],
    });
    const e = Array.from(second.values())[0];
    expect(e.status).toBe('stale');
    expect(e.coasting).toBe(false);
  });

  it('measures the coast window from the last real contact, not per tick', () => {
    let map = updateLifecycle({
      prev: new Map(), nowMs: NOW,
      trackerCandidates: [trackerCand({ level: 'candidate' })],
      expected: [], liveAircraft: [],
    });
    // Three consecutive missed ticks. lastUpdateMs must NOT be refreshed
    // while coasting, otherwise the entry would coast forever.
    map = updateLifecycle({ prev: map, nowMs: NOW + 10_000,
      trackerCandidates: [], expected: [], liveAircraft: [] });
    expect(Array.from(map.values())[0].status).toBe('candidate');
    map = updateLifecycle({ prev: map, nowMs: NOW + 20_000,
      trackerCandidates: [], expected: [], liveAircraft: [] });
    expect(Array.from(map.values())[0].status).toBe('candidate');
    map = updateLifecycle({ prev: map, nowMs: NOW + 30_000,
      trackerCandidates: [], expected: [], liveAircraft: [] });
    expect(Array.from(map.values())[0].status).toBe('stale');
  });

  it('a re-acquired contact clears the coasting flag', () => {
    let map = updateLifecycle({
      prev: new Map(), nowMs: NOW,
      trackerCandidates: [trackerCand({ level: 'candidate' })],
      expected: [], liveAircraft: [],
    });
    map = updateLifecycle({ prev: map, nowMs: NOW + 5000,
      trackerCandidates: [], expected: [], liveAircraft: [] });
    expect(Array.from(map.values())[0].coasting).toBe(true);
    // Signal returns on the next tick.
    map = updateLifecycle({
      prev: map, nowMs: NOW + 7000,
      trackerCandidates: [trackerCand({ level: 'candidate' })],
      expected: [], liveAircraft: [],
    });
    const e = Array.from(map.values())[0];
    expect(e.status).toBe('candidate');
    expect(e.coasting).toBe(false);
  });
});
