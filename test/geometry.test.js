import { describe, expect, it } from 'vitest';
import {
  aircraftAzEl,
  angularSeparationDeg,
  bodyAzEl,
  isObservable,
  moonAzEl,
  OBSERVABILITY_MIN_ELEVATION_DEG,
  sunAzEl,
} from '../src/geometry.js';

const RHEINE = {
  name: 'Rheine',
  latitudeDeg: 52.2833,
  longitudeDeg: 7.4406,
  elevationM: 50.0,
};

describe('sunAzEl', () => {
  it('summer solstice noon in Rheine peaks near 61° elevation, due south', () => {
    const t = new Date('2026-06-21T11:30:00Z');
    const sun = sunAzEl(RHEINE, t);
    expect(sun.elevationDeg).toBeGreaterThan(60.0);
    expect(sun.elevationDeg).toBeLessThan(62.0);
    expect(sun.azimuthDeg).toBeGreaterThan(175);
    expect(sun.azimuthDeg).toBeLessThan(185);
    expect(isObservable(sun)).toBe(true);
  });

  it('winter solstice noon in Rheine peaks near 14° elevation, due south, below 20° threshold', () => {
    const t = new Date('2026-12-21T11:30:00Z');
    const sun = sunAzEl(RHEINE, t);
    expect(sun.elevationDeg).toBeGreaterThan(13.0);
    expect(sun.elevationDeg).toBeLessThan(15.5);
    expect(sun.azimuthDeg).toBeGreaterThan(175);
    expect(sun.azimuthDeg).toBeLessThan(185);
    expect(isObservable(sun)).toBe(false);
  });

  it('March equinox noon in Rheine peaks near 37.7° elevation', () => {
    const t = new Date('2026-03-20T11:30:00Z');
    const sun = sunAzEl(RHEINE, t);
    expect(sun.elevationDeg).toBeGreaterThan(36.5);
    expect(sun.elevationDeg).toBeLessThan(38.5);
    expect(isObservable(sun)).toBe(true);
  });
});

describe('moonAzEl', () => {
  it('returns a position different from the Sun at the same instant', () => {
    const t = new Date('2026-01-15T21:00:00Z');
    const sun = sunAzEl(RHEINE, t);
    const moon = moonAzEl(RHEINE, t);
    expect(angularSeparationDeg(sun, moon)).toBeGreaterThan(1.0);
    expect(moon.azimuthDeg).toBeGreaterThanOrEqual(0);
    expect(moon.azimuthDeg).toBeLessThan(360);
    expect(moon.elevationDeg).toBeGreaterThanOrEqual(-90);
    expect(moon.elevationDeg).toBeLessThanOrEqual(90);
    expect(moon.rangeM).toBeGreaterThan(3.5e8);
    expect(moon.rangeM).toBeLessThan(4.1e8);
  });

  it("bodyAzEl('Moon', ...) matches moonAzEl(...)", () => {
    const t = new Date('2026-01-15T21:00:00Z');
    const a = bodyAzEl(RHEINE, 'Moon', t);
    const b = moonAzEl(RHEINE, t);
    expect(a.azimuthDeg).toBeCloseTo(b.azimuthDeg, 9);
    expect(a.elevationDeg).toBeCloseTo(b.elevationDeg, 9);
    expect(a.rangeM).toBeCloseTo(b.rangeM, 3);
  });
});

describe('isObservable', () => {
  it('uses a strict greater-than 20° threshold', () => {
    expect(OBSERVABILITY_MIN_ELEVATION_DEG).toBe(20);
    expect(isObservable({ azimuthDeg: 0, elevationDeg: 19.99, rangeM: null })).toBe(false);
    expect(isObservable({ azimuthDeg: 0, elevationDeg: 20.0, rangeM: null })).toBe(false);
    expect(isObservable({ azimuthDeg: 0, elevationDeg: 20.01, rangeM: null })).toBe(true);
  });
});

describe('refraction', () => {
  it('above 20° elevation, refraction shift stays below 0.05°', () => {
    const t = new Date('2026-03-20T11:30:00Z'); // sun ~37° in Rheine
    const refracted = sunAzEl(RHEINE, t, { applyRefraction: true });
    const geometric = sunAzEl(RHEINE, t, { applyRefraction: false });
    const delta = Math.abs(refracted.elevationDeg - geometric.elevationDeg);
    expect(delta).toBeLessThan(0.05);
  });
});

describe('aircraftAzEl', () => {
  it('aircraft directly overhead has elevation ~90° and range ~10 km', () => {
    const result = aircraftAzEl(
      RHEINE,
      RHEINE.latitudeDeg,
      RHEINE.longitudeDeg,
      RHEINE.elevationM + 10000,
    );
    expect(result.elevationDeg).toBeGreaterThan(89.999);
    expect(Math.abs(result.rangeM - 10000)).toBeLessThan(1.0);
  });

  it('aircraft 1° due north has azimuth ~0°', () => {
    const result = aircraftAzEl(
      RHEINE,
      RHEINE.latitudeDeg + 1.0,
      RHEINE.longitudeDeg,
      RHEINE.elevationM,
    );
    expect(result.azimuthDeg).toBeLessThan(0.1);
  });

  it('aircraft 1° due east has azimuth ~90°', () => {
    const result = aircraftAzEl(
      RHEINE,
      RHEINE.latitudeDeg,
      RHEINE.longitudeDeg + 1.0,
      RHEINE.elevationM,
    );
    expect(Math.abs(result.azimuthDeg - 90)).toBeLessThan(0.5);
  });
});

describe('angularSeparationDeg', () => {
  it('returns 0 for identical positions', () => {
    const p = { azimuthDeg: 123, elevationDeg: 45, rangeM: null };
    expect(angularSeparationDeg(p, p)).toBeCloseTo(0, 9);
  });

  it('returns 90° between zenith and a horizon point', () => {
    const zenith = { azimuthDeg: 0, elevationDeg: 90, rangeM: null };
    const horizonSouth = { azimuthDeg: 180, elevationDeg: 0, rangeM: null };
    expect(angularSeparationDeg(zenith, horizonSouth)).toBeCloseTo(90, 6);
  });

  it('scales az difference by cos(elevation) for small angles', () => {
    const a = { azimuthDeg: 100, elevationDeg: 60, rangeM: null };
    const b = { azimuthDeg: 101, elevationDeg: 60, rangeM: null };
    // At el=60°, a 1° azimuth difference projects to 1° * cos(60°) = 0.5° on the sky.
    expect(angularSeparationDeg(a, b)).toBeCloseTo(0.5, 2);
  });
});
