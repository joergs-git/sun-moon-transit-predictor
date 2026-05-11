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

  it('marks a missing previous entry as stale within the grace period', () => {
    const first = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [trackerCand()],
      expected: [],
      liveAircraft: [],
    });
    // Next tick 5 s later — aircraft no longer flagged by the tracker.
    const second = updateLifecycle({
      prev: first,
      nowMs: NOW + 5000,
      trackerCandidates: [],
      expected: [],
      liveAircraft: [],
      staleGraceMs: 10_000,
    });
    expect(second.size).toBe(1);
    expect(Array.from(second.values())[0].status).toBe('stale');
  });

  it('drops stale entries once the grace period elapses', () => {
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
    });
    expect(second.size).toBe(0);
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

describe('lifecycleArray', () => {
  it('sorts by status urgency then ETA', () => {
    const map = updateLifecycle({
      prev: new Map(),
      nowMs: NOW,
      trackerCandidates: [
        trackerCand({ icao: 'far',  closestAtSec: 200, level: 'candidate' }),
        trackerCand({ icao: 'near', closestAtSec: 25,  level: 'candidate' }),
      ],
      expected: [expectedEntry({ flight: 'OTHER', etaMin: 30 })],
      liveAircraft: [],
    });
    const arr = lifecycleArray(map, NOW);
    expect(arr.map(e => e.status)).toEqual(['imminent', 'candidate', 'planned']);
    expect(arr[0].icao).toBe('near');
  });
});
