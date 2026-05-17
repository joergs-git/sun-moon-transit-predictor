import { describe, expect, it } from 'vitest';
import { twoline2satrec, sgp4, propagateEcef, gstime } from '../src/sgp4.js';

// Official SGP4 verification object 88888 (near-Earth) from Spacetrack
// Report #3 / Vallado "Revisiting Spacetrack Report #3". The expected TEME
// state vectors below are the published reference values; a generous
// tolerance (1 km / 0.02 km·s⁻¹) still catches any transcription bug, which
// would throw the propagation off by hundreds of km.
const L1 = '1 88888U          80275.98708465  .00073094  13844-3  66816-4 0    8';
const L2 = '2 88888  72.8435 115.9689 0086731  52.6988 110.5714 16.05824518  105';

describe('sgp4 — official 88888 verification vector', () => {
  const sat = twoline2satrec(L1, L2);

  it('matches the reference state at epoch (tsince = 0)', () => {
    const { r, v } = sgp4(sat, 0.0);
    expect(r[0]).toBeCloseTo(2328.97048951, 0);
    expect(r[1]).toBeCloseTo(-5995.22076416, 0);
    expect(r[2]).toBeCloseTo(1719.97067261, 0);
    expect(v[0]).toBeCloseTo(2.91207, 1);
    expect(v[1]).toBeCloseTo(-0.98340, 1);
    expect(v[2]).toBeCloseTo(-7.09081, 1);
  });

  it('matches the reference state at tsince = 360 min', () => {
    const { r } = sgp4(sat, 360.0);
    expect(r[0]).toBeCloseTo(2456.10705566, -1);
    expect(r[1]).toBeCloseTo(-6071.93853760, -1);
    expect(r[2]).toBeCloseTo(1222.89727783, -1);
  });

  it('stays on a sane LEO radius across a full day', () => {
    for (let m = 0; m <= 1440; m += 30) {
      const { r } = sgp4(sat, m);
      const radiusKm = Math.hypot(r[0], r[1], r[2]);
      expect(radiusKm).toBeGreaterThan(6500);
      expect(radiusKm).toBeLessThan(7200);
    }
  });
});

describe('gstime', () => {
  it('returns a value in [0, 2π)', () => {
    const g = gstime(2451545.0);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThan(2 * Math.PI);
  });
});

describe('propagateEcef', () => {
  it('produces an ECEF vector at LEO altitude (≈ 6.7–7.0 Mm from geocentre)', () => {
    const sat = twoline2satrec(L1, L2);
    // Epoch of the TLE: 1980 day 275.98708465 → use the satrec jd directly.
    const whenMs = (sat.jdsatepoch - 2440587.5) * 86400000;
    const e = propagateEcef(sat, new Date(whenMs));
    expect(e).not.toBeNull();
    const rMm = Math.hypot(e.x, e.y, e.z) / 1e6;
    expect(rMm).toBeGreaterThan(6.5);
    expect(rMm).toBeLessThan(7.2);
  });
});
