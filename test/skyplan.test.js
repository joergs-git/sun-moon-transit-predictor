import { describe, expect, it } from 'vitest';
import { confidenceFor, atLeastConfidence, buildSkyTargetPlan } from '../src/skyplan.js';

const DAY = 86_400_000;

describe('confidenceFor', () => {
  it('grades by TLE age at the event', () => {
    expect(confidenceFor('HST', 0.5)).toBe('green');
    expect(confidenceFor('HST', 2)).toBe('amber');
    expect(confidenceFor('HST', 4)).toBe('orange');
    expect(confidenceFor('HST', 9)).toBe('red');
  });

  it('caps the ISS at amber beyond ~2 days (reboost risk), not green', () => {
    expect(confidenceFor('ISS', 0.5)).toBe('green');   // close in is fine
    expect(confidenceFor('ISS', 2.5)).toBe('amber');   // would be green by age alone
    expect(confidenceFor('CSS', 2.5)).toBe('amber');   // others follow plain age
  });

  it('returns null when the TLE age is unknown', () => {
    expect(confidenceFor('ISS', null)).toBeNull();
    expect(confidenceFor('ISS', NaN)).toBeNull();
  });
});

describe('atLeastConfidence', () => {
  it('orders the levels green > amber > orange > red', () => {
    expect(atLeastConfidence('green', 'amber')).toBe(true);
    expect(atLeastConfidence('amber', 'green')).toBe(false);
    expect(atLeastConfidence('amber', 'amber')).toBe(true);
    expect(atLeastConfidence(null, 'red')).toBe(false);
  });
});

describe('buildSkyTargetPlan', () => {
  const now = Date.UTC(2026, 5, 12, 20, 0, 0);
  const cand = (over) => ({
    satTag: 'ISS', satName: 'ISS', targetId: 't', targetName: 'M42', kind: 'field',
    closestApproachSepDeg: 0.1, missArcmin: 6, timeInFieldMs: 800, sunlit: true,
    satAtClosest: { elevationDeg: 40 }, ...over,
  });

  it('filters out past events and events beyond the horizon, sorts by time', () => {
    const rows = buildSkyTargetPlan([
      cand({ closestApproachAtMs: now + 2 * DAY }),
      cand({ closestApproachAtMs: now - 1 * DAY }),       // past → dropped
      cand({ closestApproachAtMs: now + 30 * DAY }),      // beyond 7 d → dropped
      cand({ closestApproachAtMs: now + 1 * DAY }),
    ], { nowMs: now, planHorizonDays: 7 });
    expect(rows.map((r) => r.atMs)).toEqual([now + 1 * DAY, now + 2 * DAY]);
    expect(rows[0].leadMs).toBe(1 * DAY);
  });

  it('drops events below the minimum elevation', () => {
    const rows = buildSkyTargetPlan([
      cand({ closestApproachAtMs: now + DAY, satAtClosest: { elevationDeg: 10 } }),
      cand({ closestApproachAtMs: now + DAY, satAtClosest: { elevationDeg: 45 } }),
    ], { nowMs: now, minElevationDeg: 20 });
    expect(rows.length).toBe(1);
    expect(rows[0].elevationDeg).toBe(45);
  });

  it('firstPerCombo keeps only the soonest pass per satellite×object', () => {
    const rows = buildSkyTargetPlan([
      cand({ closestApproachAtMs: now + 3 * DAY, satTag: 'ISS', targetId: 'm42' }),
      cand({ closestApproachAtMs: now + 1 * DAY, satTag: 'ISS', targetId: 'm42' }),   // sooner ISS×m42
      cand({ closestApproachAtMs: now + 2 * DAY, satTag: 'HST', targetId: 'm42' }),   // different sat
      cand({ closestApproachAtMs: now + 4 * DAY, satTag: 'ISS', targetId: 'vega' }),  // different object
    ], { nowMs: now, planHorizonDays: 30, firstPerCombo: true });
    // One row per (sat, object): ISS×m42 (soonest = +1 d), HST×m42, ISS×vega.
    expect(rows.length).toBe(3);
    const issM42 = rows.find((r) => r.satTag === 'ISS' && r.targetId === 'm42');
    expect(issM42.atMs).toBe(now + 1 * DAY);
  });

  it('derives confidence from TLE epoch and flags single-scope conflicts', () => {
    const epoch = now - 0.2 * DAY;   // fresh TLE
    const rows = buildSkyTargetPlan([
      cand({ closestApproachAtMs: now + 0.5 * DAY }),
      cand({ closestApproachAtMs: now + 0.5 * DAY + 3 * 60_000, satTag: 'CSS', satName: 'Tiangong' }),
      cand({ closestApproachAtMs: now + 5 * DAY }),
    ], { nowMs: now, tleEpochMsByTag: { ISS: epoch, CSS: epoch }, reslewMinGapMin: 5 });
    // Event at +0.5 d: TLE age ≈ 0.7 d → green (CSS) / capped amber? ISS at 0.7 d < 2 → green.
    expect(rows[0].confidence).toBe('green');
    // Second event is 3 min after the first (< 5 min reslew) → conflict.
    expect(rows[1].conflictWithPrev).toBe(true);
    // Event at +5 d: TLE age ≈ 5.2 d → orange.
    expect(rows[2].confidence).toBe('orange');
    expect(rows[2].conflictWithPrev).toBeUndefined();
  });
});
