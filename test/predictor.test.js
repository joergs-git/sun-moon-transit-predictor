import { describe, expect, it } from 'vitest';
import {
  buildWatchlist,
  nextExpected,
  observationsFromHistory,
  upcomingExpected,
} from '../src/predictor.js';
import { HistoryStore } from '../src/store.js';

const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;

// A fixed reference instant to avoid flaky tests around real "now".
// 2026-05-11 14:00:00 UTC.
const NOW = new Date('2026-05-11T14:00:00Z').getTime();

function obs(flight, body, daysAgo, hour, minute = 0) {
  const dayStart = NOW - (NOW % DAY_MS) - daysAgo * DAY_MS;
  return {
    flight,
    body,
    timestampMs: dayStart + (hour * 3600 + minute * 60) * 1000,
  };
}

describe('buildWatchlist', () => {
  it('keeps only flights with at least minRepeats distinct-day hits', () => {
    const observations = [
      // LH123 transits Sun on 5 different days at ~11:23
      obs('LH123', 'Sun', 1, 11, 23),
      obs('LH123', 'Sun', 2, 11, 21),
      obs('LH123', 'Sun', 3, 11, 25),
      obs('LH123', 'Sun', 4, 11, 22),
      obs('LH123', 'Sun', 5, 11, 24),
      // OneOff has only one observation — should be filtered.
      obs('XYZ999', 'Sun', 1, 12, 0),
      // Twice-on-same-day flight — distinctDays = 1, should be filtered.
      { flight: 'AB1', body: 'Sun', timestampMs: NOW - DAY_MS + HOUR_MS },
      { flight: 'AB1', body: 'Sun', timestampMs: NOW - DAY_MS + HOUR_MS + 60_000 },
    ];
    const w = buildWatchlist(observations, { nowMs: NOW, minRepeats: 2 });
    expect(w.length).toBe(1);
    expect(w[0].flight).toBe('LH123');
    expect(w[0].body).toBe('Sun');
    expect(w[0].distinctDays).toBe(5);
    expect(w[0].observations).toBe(5);
    // Median of 11:21..11:25 → 11:23
    const expectedHour = w[0].expectedTimeOfDayMs / HOUR_MS;
    expect(expectedHour).toBeGreaterThan(11.3);
    expect(expectedHour).toBeLessThan(11.5);
  });

  it('separates Sun and Moon transits of the same flight', () => {
    const observations = [
      obs('LH123', 'Sun', 1, 11, 23),
      obs('LH123', 'Sun', 2, 11, 22),
      obs('LH123', 'Moon', 1, 22, 5),
      obs('LH123', 'Moon', 2, 22, 8),
    ];
    const w = buildWatchlist(observations, { nowMs: NOW, minRepeats: 2 });
    expect(w.length).toBe(2);
    expect(w.map(e => e.body).sort()).toEqual(['Moon', 'Sun']);
  });

  it('drops observations older than daysBack', () => {
    const observations = [
      obs('LH123', 'Sun', 30, 11, 23),
      obs('LH123', 'Sun', 31, 11, 22),
      obs('LH123', 'Sun', 1,  11, 24),
    ];
    const w = buildWatchlist(observations, { nowMs: NOW, daysBack: 14, minRepeats: 2 });
    expect(w).toEqual([]);
  });
});

describe('nextExpected', () => {
  it('returns today if the slot is still ahead, tomorrow otherwise', () => {
    const dayStart = NOW - (NOW % DAY_MS); // 2026-05-11 00:00 UTC
    // Slot at 18:00 UTC — today (NOW = 14:00) so 4h from now
    const ahead = { flight: 'X', body: 'Sun', expectedTimeOfDayMs: 18 * HOUR_MS,
                    observations: 3, distinctDays: 3, lastSeenMs: NOW - DAY_MS, stdevMs: 0 };
    expect(nextExpected(ahead, NOW)).toBe(dayStart + 18 * HOUR_MS);

    // Slot at 09:00 UTC — already past today, so tomorrow 09:00
    const past = { ...ahead, expectedTimeOfDayMs: 9 * HOUR_MS };
    expect(nextExpected(past, NOW)).toBe(dayStart + DAY_MS + 9 * HOUR_MS);
  });

  it('returns null outside lookAheadMs', () => {
    const dayStart = NOW - (NOW % DAY_MS);
    const past = { flight: 'X', body: 'Sun', expectedTimeOfDayMs: 9 * HOUR_MS,
                   observations: 3, distinctDays: 3, lastSeenMs: NOW - DAY_MS, stdevMs: 0 };
    // Tomorrow 09:00 is ~19h away; with a 1h lookAhead → null.
    expect(nextExpected(past, NOW, HOUR_MS)).toBeNull();
  });
});

describe('upcomingExpected', () => {
  it('returns events sorted by ETA, only within lookAhead', () => {
    const w = [
      { flight: 'A', body: 'Sun', expectedTimeOfDayMs: 16 * HOUR_MS,  observations: 3, distinctDays: 3, lastSeenMs: 0, stdevMs: 0 },
      { flight: 'B', body: 'Sun', expectedTimeOfDayMs: 15 * HOUR_MS,  observations: 3, distinctDays: 3, lastSeenMs: 0, stdevMs: 0 },
      { flight: 'C', body: 'Moon', expectedTimeOfDayMs: 9 * HOUR_MS,  observations: 3, distinctDays: 3, lastSeenMs: 0, stdevMs: 0 },
    ];
    const events = upcomingExpected(w, NOW, 24 * HOUR_MS);
    expect(events.map(e => e.flight)).toEqual(['B', 'A', 'C']);   // 15:00, 16:00, tomorrow 09:00
    expect(events[0].etaMs).toBeLessThan(events[1].etaMs);
    expect(events[1].etaMs).toBeLessThan(events[2].etaMs);
  });
});

describe('observationsFromHistory', () => {
  it('reads only precise-stage rows with a flight from transit_history', () => {
    const store = new HistoryStore(':memory:');
    const cand = (flight, body, closestAtMs) => ({
      icao: '3c6589', callsign: 'DLH4PV', body,
      closestApproachAtMs: closestAtMs, closestApproachSepDeg: 0.18,
      durationMs: 1400,
      aircraft: { altMmsl: 11000, groundSpeedMs: 230, trackDeg: 90 },
    });
    // precise + flight → kept
    store.recordEvent('precise', cand('LH123', 'Sun', NOW - 2 * DAY_MS),
      { flight: 'LH123' }, NOW - 2 * DAY_MS);
    store.recordEvent('precise', cand('LH123', 'Sun', NOW - DAY_MS),
      { flight: 'LH123' }, NOW - DAY_MS);
    // early → excluded
    store.recordEvent('early', cand('LH123', 'Sun', NOW - 3 * DAY_MS),
      { flight: 'LH123' }, NOW - 3 * DAY_MS);
    // precise but no route flight → excluded
    store.recordEvent('precise', cand('LH123', 'Sun', NOW - 4 * DAY_MS),
      null, NOW - 4 * DAY_MS);

    const obs = observationsFromHistory(store, { nowMs: NOW, daysBack: 14 });
    expect(obs.length).toBe(2);
    expect(obs.every(o => o.flight === 'LH123' && o.body === 'Sun')).toBe(true);
    store.close();
  });
});
