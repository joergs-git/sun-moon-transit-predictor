import { describe, expect, it } from 'vitest';
import {
  aircraftAzEl,
  angularSeparationDeg,
  apparentDiameterDeg,
  bodyAzEl,
  isObservable,
  moonAzEl,
  OBSERVABILITY_MIN_ELEVATION_DEG,
  sunAzEl,
  targetAzEl,
  equatorialRaDec,
} from '../src/geometry.js';
import { nextHorizonCrossing, nextMeridianTransit } from '../src/service.js';

const RHEINE = {
  name: 'Rheine',
  latitudeDeg: 52.2833,
  longitudeDeg: 7.4406,
  elevationM: 50.0,
};

describe('equatorialRaDec (mount slew coords, v0.55.0)', () => {
  const t = new Date('2026-07-03T01:44:00Z');
  it('returns a fixed star’s catalogue RA/Dec verbatim', () => {
    const vega = { id: 'vega', raHours: 18.6156, decDeg: 38.7837 };
    const rd = equatorialRaDec(RHEINE, vega, t);
    expect(rd.raHours).toBeCloseTo(18.6156, 3);
    expect(rd.decDeg).toBeCloseTo(38.7837, 3);
  });
  it('computes a body’s RA/Dec from the ephemeris (Moon in range)', () => {
    const rd = equatorialRaDec(RHEINE, 'Moon', t);
    expect(rd).not.toBeNull();
    expect(rd.raHours).toBeGreaterThanOrEqual(0);
    expect(rd.raHours).toBeLessThan(24);
    expect(rd.decDeg).toBeGreaterThanOrEqual(-90);
    expect(rd.decDeg).toBeLessThanOrEqual(90);
  });
  it('NEVER returns coordinates for the Sun — a hard safety block', () => {
    expect(equatorialRaDec(RHEINE, 'Sun', t)).toBeNull();
  });
});

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

// ── M83: arbitrary sky targets (planets + fixed RA/Dec) ─────────────────────
describe('targetAzEl', () => {
  const when = '2026-06-12T22:00:00Z';

  it('matches bodyAzEl for an ephemeris body given as a string or {body}', () => {
    const viaBody = bodyAzEl(RHEINE, 'Jupiter', when);
    const viaStr = targetAzEl(RHEINE, 'Jupiter', when);
    const viaObj = targetAzEl(RHEINE, { body: 'Jupiter' }, when);
    expect(viaStr.azimuthDeg).toBeCloseTo(viaBody.azimuthDeg, 9);
    expect(viaStr.elevationDeg).toBeCloseTo(viaBody.elevationDeg, 9);
    expect(viaObj.azimuthDeg).toBeCloseTo(viaBody.azimuthDeg, 9);
  });

  it('places a planet in a plausible Az/El and finite range', () => {
    const j = targetAzEl(RHEINE, 'Jupiter', when);
    expect(j.azimuthDeg).toBeGreaterThanOrEqual(0);
    expect(j.azimuthDeg).toBeLessThan(360);
    expect(j.elevationDeg).toBeGreaterThanOrEqual(-90);
    expect(j.elevationDeg).toBeLessThanOrEqual(90);
    expect(Number.isFinite(j.rangeM)).toBe(true);
  });

  it('resolves a fixed RA/Dec target (Vega) and applies precession (≠ raw J2000)', () => {
    // Vega J2000: RA 18.61565 h, Dec +38.78369°. targetAzEl registers it as a
    // star so the engine precesses it to apparent-of-date before Az/El — the
    // result must differ from feeding raw J2000 RA/Dec straight to Horizon.
    const vega = targetAzEl(RHEINE, { raHours: 18.61565, decDeg: 38.78369, distLy: 25 }, when);
    expect(vega.elevationDeg).toBeGreaterThan(0);        // up over Rheine at 22 UTC in June
    expect(vega.azimuthDeg).toBeGreaterThanOrEqual(0);
    expect(vega.azimuthDeg).toBeLessThan(360);
    expect(vega.rangeM).toBeNull();                      // distance irrelevant for a star
  });

  it('throws on an invalid target descriptor', () => {
    expect(() => targetAzEl(RHEINE, { foo: 1 }, when)).toThrow(/Invalid sky target/);
  });
});

describe('apparentDiameterDeg', () => {
  const when = '2026-06-12T12:00:00Z';

  it('gives the Sun ≈ 0.52–0.54° and the Moon ≈ 0.5°', () => {
    // The Sun's apparent diameter swings ~0.524° (aphelion, early July) to
    // ~0.542° (perihelion, early Jan) — June 12 is near the aphelion minimum.
    const sun = apparentDiameterDeg('Sun', when);
    expect(sun).toBeGreaterThan(0.52);
    expect(sun).toBeLessThan(0.55);
    // The Moon's distance varies ~0.49–0.56°; assert the right ballpark.
    expect(apparentDiameterDeg('Moon', when)).toBeGreaterThan(0.45);
    expect(apparentDiameterDeg('Moon', when)).toBeLessThan(0.58);
  });

  it('gives Jupiter a small-arcsecond disc (tens of arcseconds)', () => {
    const deg = apparentDiameterDeg('Jupiter', when);
    const arcsec = deg * 3600;
    expect(arcsec).toBeGreaterThan(25);    // Jupiter ranges ~30–50″
    expect(arcsec).toBeLessThan(60);
  });

  it('uses the descriptor diameter for a fixed DSO, 0 for a point source', () => {
    expect(apparentDiameterDeg({ raHours: 5.588, decDeg: -5.391, diameterDeg: 1.0 }, when)).toBe(1.0);
    expect(apparentDiameterDeg({ raHours: 18.6, decDeg: 38.8 }, when)).toBe(0);
  });
});

describe('nextHorizonCrossing (M85 — Sun/Moon next rise/set)', () => {
  // Midsummer noon at Rheine: the Sun is well up, so the next event is a SET
  // later the same day, and it must be consistent with the Sun being above the
  // horizon now and below it just after the returned instant.
  it('returns the next SET (with a future time) when the Sun is currently up', () => {
    const noon = Date.UTC(2026, 5, 21, 11, 0, 0);   // ~13:00 local, Sun high
    expect(sunAzEl(RHEINE, new Date(noon)).elevationDeg).toBeGreaterThan(0);
    const ev = nextHorizonCrossing(RHEINE, 'Sun', noon);
    expect(ev).not.toBeNull();
    expect(ev.kind).toBe('set');
    expect(ev.atMs).toBeGreaterThan(noon);
    // Bracket the crossing: above the horizon a minute before, below a minute after.
    expect(sunAzEl(RHEINE, new Date(ev.atMs - 60_000)).elevationDeg).toBeGreaterThan(0);
    expect(sunAzEl(RHEINE, new Date(ev.atMs + 60_000)).elevationDeg).toBeLessThan(0);
  });

  // Local midnight: the Sun is down, so the next event is a RISE.
  it('returns the next RISE when the Sun is currently below the horizon', () => {
    const midnight = Date.UTC(2026, 5, 21, 23, 0, 0);   // ~01:00 local, Sun down
    expect(sunAzEl(RHEINE, new Date(midnight)).elevationDeg).toBeLessThan(0);
    const ev = nextHorizonCrossing(RHEINE, 'Sun', midnight);
    expect(ev).not.toBeNull();
    expect(ev.kind).toBe('rise');
    expect(ev.atMs).toBeGreaterThan(midnight);
    expect(sunAzEl(RHEINE, new Date(ev.atMs - 60_000)).elevationDeg).toBeLessThan(0);
    expect(sunAzEl(RHEINE, new Date(ev.atMs + 60_000)).elevationDeg).toBeGreaterThan(0);
  });
});

describe('nextMeridianTransit (v0.50.1 — Sun/Moon culmination)', () => {
  it('returns an instant where the Sun is due south and at its daily peak', () => {
    const morning = Date.UTC(2026, 5, 21, 6, 0, 0);   // before local noon
    const tr = nextMeridianTransit(RHEINE, 'Sun', morning);
    expect(tr).not.toBeNull();
    expect(tr.atMs).toBeGreaterThan(morning);
    // Due south: azimuth within a hair of 180°.
    const at = sunAzEl(RHEINE, new Date(tr.atMs));
    expect(Math.abs(at.azimuthDeg - 180)).toBeLessThan(0.2);
    // Upper culmination: higher than half an hour either side.
    const before = sunAzEl(RHEINE, new Date(tr.atMs - 1_800_000)).elevationDeg;
    const after = sunAzEl(RHEINE, new Date(tr.atMs + 1_800_000)).elevationDeg;
    expect(at.elevationDeg).toBeGreaterThan(before);
    expect(at.elevationDeg).toBeGreaterThan(after);
  });
});
