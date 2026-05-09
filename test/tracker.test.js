import { describe, expect, it } from 'vitest';
import { sunAzEl } from '../src/geometry.js';
import { extrapolate, findTransits } from '../src/tracker.js';

const RHEINE = {
  name: 'Rheine',
  latitudeDeg: 52.2833,
  longitudeDeg: 7.4406,
  elevationM: 50.0,
};

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const EARTH_R = 6371008.8;

function aircraftAtBodyLineOfSight(observer, bodyAzEl, altMmsl) {
  const elRad = bodyAzEl.elevationDeg * DEG;
  const azRad = bodyAzEl.azimuthDeg * DEG;
  const horizDist = (altMmsl - observer.elevationM) / Math.tan(elRad);
  const dN = horizDist * Math.cos(azRad);
  const dE = horizDist * Math.sin(azRad);
  const dLat = (dN / EARTH_R) * RAD;
  const dLon = (dE / (EARTH_R * Math.cos(observer.latitudeDeg * DEG))) * RAD;
  return {
    lat: observer.latitudeDeg + dLat,
    lon: observer.longitudeDeg + dLon,
    altMmsl,
  };
}

function makeAircraft(overrides = {}) {
  return {
    icao: 'test01',
    callsign: 'TST123',
    lat: 52.5,
    lon: 7.5,
    altMmsl: 11000,
    altSource: 'geometric',
    groundSpeedMs: 230,
    trackDeg: 90,
    verticalRateMs: 0,
    seenPosS: 0,
    receivedAtMs: 0,
    ...overrides,
  };
}

describe('extrapolate', () => {
  it('moves an aircraft north when track is 0°', () => {
    const ac = makeAircraft({ trackDeg: 0, groundSpeedMs: 100 });
    const after = extrapolate(ac, 60); // 6 km north
    expect(after.lat).toBeGreaterThan(ac.lat);
    expect(after.lon).toBeCloseTo(ac.lon, 5);
    const dN = (after.lat - ac.lat) * DEG * EARTH_R;
    expect(dN).toBeCloseTo(6000, 0);
  });

  it('moves an aircraft east when track is 90°', () => {
    const ac = makeAircraft({ trackDeg: 90, groundSpeedMs: 100 });
    const after = extrapolate(ac, 60);
    expect(after.lon).toBeGreaterThan(ac.lon);
    expect(after.lat).toBeCloseTo(ac.lat, 5);
  });

  it('applies vertical rate', () => {
    const ac = makeAircraft({ verticalRateMs: 5 });
    const after = extrapolate(ac, 60);
    expect(after.altMmsl).toBeCloseTo(ac.altMmsl + 300, 3);
  });
});

describe('findTransits', () => {
  it('detects a synthetic aircraft parked on the sun line of sight', () => {
    const t0 = new Date('2026-06-21T11:30:00Z').getTime();
    const sun = sunAzEl(RHEINE, new Date(t0));
    const pos = aircraftAtBodyLineOfSight(RHEINE, sun, 11000);
    const ac = makeAircraft({
      ...pos,
      groundSpeedMs: 0,
      trackDeg: 0,
      receivedAtMs: t0,
    });
    const candidates = findTransits(RHEINE, [ac], t0);
    expect(candidates.length).toBe(1);
    const c = candidates[0];
    expect(c.body).toBe('Sun');
    expect(c.icao).toBe('test01');
    expect(c.closestApproachSepDeg).toBeLessThan(0.15); // synthetic placement uses flat-earth, residual ~5 arcmin
    expect(c.entersAtMs).toBeGreaterThanOrEqual(t0);
    expect(Math.abs(c.aircraftAtClosest.elevationDeg - sun.elevationDeg)).toBeLessThan(0.15);
  });

  it('returns no candidates when both bodies are below the threshold', () => {
    const t0 = new Date('2026-12-21T22:00:00Z').getTime(); // sun deep below horizon
    const ac = makeAircraft({ receivedAtMs: t0 });
    const candidates = findTransits(RHEINE, [ac], t0, { bodies: ['Sun'] });
    expect(candidates).toEqual([]);
  });

  it('skips aircraft missing ground speed or track', () => {
    const t0 = new Date('2026-06-21T11:30:00Z').getTime();
    const sun = sunAzEl(RHEINE, new Date(t0));
    const pos = aircraftAtBodyLineOfSight(RHEINE, sun, 11000);
    const ac = makeAircraft({
      ...pos,
      groundSpeedMs: null,
      trackDeg: null,
      receivedAtMs: t0,
    });
    expect(findTransits(RHEINE, [ac], t0)).toEqual([]);
  });

  it('does not flag a far-away aircraft', () => {
    const t0 = new Date('2026-06-21T11:30:00Z').getTime();
    const ac = makeAircraft({
      lat: 53.0,
      lon: 9.0,
      altMmsl: 11000,
      groundSpeedMs: 230,
      trackDeg: 270,
      receivedAtMs: t0,
    });
    const candidates = findTransits(RHEINE, [ac], t0);
    expect(candidates).toEqual([]);
  });
});
