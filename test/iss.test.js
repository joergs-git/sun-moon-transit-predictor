import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadIssTle, predictIssTransits, predictSkyTargetTransits, nextIssVisiblePass,
} from '../src/iss.js';
import { observerEcef, targetEcefAzEl } from '../src/geometry.js';

// A valid, well-formed ISS (ZARYA) element set. SGP4 correctness itself is
// gated by the official 88888 verification vectors in sgp4.test.js — here we
// only exercise parsing, the geometry helper and the scan's output shape.
const NAME = 'ISS (ZARYA)';
const L1 = '1 25544U 98067A   24123.54791667  .00016717  00000-0  30074-3 0  9994';
const L2 = '2 25544  51.6402 211.1063 0004604  47.1827  85.0114 15.49814641450000';

const tmp = mkdtempSync(join(tmpdir(), 'stp-iss-'));
const observer = { name: 'Rheine', latitudeDeg: 52.28, longitudeDeg: 7.44, elevationM: 50 };

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('loadIssTle', () => {
  it('parses the 3-line (named) form', () => {
    const p = join(tmp, 'iss3.tle');
    writeFileSync(p, `${NAME}\n${L1}\n${L2}\n`);
    const tle = loadIssTle(p);
    expect(tle).not.toBeNull();
    expect(tle.name).toBe(NAME);
    expect(tle.satrec.satnum).toBe('25544');
    expect(tle.satrec.jdsatepoch).toBeGreaterThan(2451545); // > J2000
  });

  it('parses the bare 2-line form', () => {
    const p = join(tmp, 'iss2.tle');
    writeFileSync(p, `${L1}\n${L2}\n`);
    const tle = loadIssTle(p);
    expect(tle).not.toBeNull();
    expect(tle.name).toBe('ISS');
  });

  it('returns null for a missing or garbage file', () => {
    expect(loadIssTle(join(tmp, 'nope.tle'))).toBeNull();
    const bad = join(tmp, 'bad.tle');
    writeFileSync(bad, 'not a tle at all');
    expect(loadIssTle(bad)).toBeNull();
  });
});

describe('targetEcefAzEl', () => {
  it('puts a point directly overhead near 90° elevation', () => {
    const obs = observerEcef(observer);
    // 400 km straight up along the observer's local vertical ≈ scale the
    // observer ECEF vector outward.
    const scale = (Math.hypot(obs.x, obs.y, obs.z) + 400000) / Math.hypot(obs.x, obs.y, obs.z);
    const up = { x: obs.x * scale, y: obs.y * scale, z: obs.z * scale };
    const azel = targetEcefAzEl(obs, observer.latitudeDeg, observer.longitudeDeg, up);
    expect(azel.elevationDeg).toBeGreaterThan(88);
    expect(azel.rangeM).toBeGreaterThan(390000);
  });
});

describe('predictIssTransits', () => {
  const tle = (() => {
    const p = join(tmp, 'iss.tle');
    writeFileSync(p, `${NAME}\n${L1}\n${L2}\n`);
    return loadIssTle(p);
  })();

  it('runs without throwing and returns an array', () => {
    const ev = predictIssTransits(observer, tle.satrec, {
      fromMs: Date.UTC(2024, 4, 3, 0, 0, 0),
      horizonMs: 24 * 3600_000,
      bodies: ['Sun', 'Moon'],
    });
    expect(Array.isArray(ev)).toBe(true);
  });

  it('emits well-formed, tracker-shaped candidates when any are found', () => {
    // 14-day scan to make it likely at least one approach inside 1° turns up
    // for this observer; assert structure only (timing correctness is the
    // SGP4 suite's job).
    const ev = predictIssTransits(observer, tle.satrec, {
      fromMs: Date.UTC(2024, 4, 3, 0, 0, 0),
      horizonMs: 14 * 24 * 3600_000,
      bodies: ['Sun', 'Moon'],
      looseThresholdDeg: 1.0,
    });
    for (const c of ev) {
      expect(c.icao).toBe('ISS');
      expect(c.isISS).toBe(true);
      expect(['Sun', 'Moon']).toContain(c.body);
      expect(typeof c.closestApproachAtMs).toBe('number');
      expect(c.closestApproachSepDeg).toBeLessThanOrEqual(1.0 + 1e-9);
      expect(Array.isArray(c.transitPath)).toBe(true);
      expect(['radio', 'candidate']).toContain(c.level);
    }
  });

  it('honours tag/typeDesc so any satellite (HST, Tiangong) is labelled and keyed distinctly', () => {
    // The predictor is generic: the same TLE re-tagged as "HST" must produce
    // candidates keyed off the custom tag (so they never collide with the ISS
    // in the (icao,body) lifecycle map) while keeping isISS=true (the
    // "orbiting satellite, not ADS-B" flag the rest of the pipeline reads).
    // Observer chosen so this fixture reliably yields a transit (the scan
    // gate only refines minima a few degrees from the disc, so a hit must
    // actually occur for the tagging assertions to be non-vacuous).
    const under = { name: 'under-track', latitudeDeg: 30, longitudeDeg: -10, elevationM: 50 };
    const ev = predictIssTransits(under, tle.satrec, {
      fromMs: Date.UTC(2024, 4, 3, 0, 0, 0),
      horizonMs: 14 * 24 * 3600_000,
      bodies: ['Sun', 'Moon'],
      looseThresholdDeg: 1.0,
      name: 'HST',
      tag: 'HST',
      typeDesc: 'Hubble Space Telescope',
    });
    expect(ev.length).toBeGreaterThan(0);   // same elements, re-tagged as HST
    for (const c of ev) {
      expect(c.icao).toBe('HST');
      expect(c.callsign).toBe('HST');
      expect(c.isISS).toBe(true);
      expect(c.aircraft.typeCode).toBe('HST');
      expect(c.aircraft.typeDesc).toBe('Hubble Space Telescope');
    }
  });
});

describe('predictSkyTargetTransits', () => {
  const tle = (() => {
    const p = join(tmp, 'iss-sky.tle');
    writeFileSync(p, `${NAME}\n${L1}\n${L2}\n`);
    return loadIssTle(p);
  })();
  // Observer placed under the fixture's ground track so a Sun approach exists
  // (the same spot the multi-sat tagging test uses).
  const under = { name: 'under-track', latitudeDeg: 30, longitudeDeg: -10, elevationM: 50 };
  const fromMs = Date.UTC(2024, 4, 3, 0, 0, 0);
  const sunBox = { id: 'sun', name: 'Sun', body: 'Sun', fovWidthDeg: 2, fovHeightDeg: 2 };

  it('finds a satellite pass through a framed field and shapes it correctly', () => {
    // Daytime Sun transit → disable the night gates so the approach registers.
    const ev = predictSkyTargetTransits(under, tle.satrec, {
      fromMs, horizonMs: 14 * 24 * 3600_000, targets: [sunBox],
      tag: 'ISS', name: 'ISS', requireSunlit: false, requireDarkSky: false,
    });
    expect(ev.length).toBeGreaterThan(0);
    const c = ev[0];
    expect(c.satTag).toBe('ISS');
    expect(c.targetName).toBe('Sun');
    expect(['transit', 'field']).toContain(c.kind);
    expect(c.closestApproachSepDeg).toBeLessThanOrEqual(c.fieldRadiusDeg + 1e-9);
    expect(c.missArcmin).toBeCloseTo(c.closestApproachSepDeg * 60, 6);
    expect(c.timeInFieldMs).toBeGreaterThan(0);
    expect(c.entersFieldAtMs).toBeLessThanOrEqual(c.closestApproachAtMs);
    expect(c.leavesFieldAtMs).toBeGreaterThanOrEqual(c.closestApproachAtMs);
    expect(c.satAtClosest).not.toBeNull();
    expect(Array.isArray(c.transitPath)).toBe(true);
    // Object-centred path: the closest sample sits near (0,0) arcmin.
    const nearest = c.transitPath.reduce((a, b) => (Math.abs(b.tOffsetMs) < Math.abs(a.tOffsetMs) ? b : a));
    expect(Math.hypot(nearest.dAzArcmin, nearest.dElArcmin)).toBeLessThan(c.fieldRadiusDeg * 60 + 1);
    expect(typeof c.sunlit).toBe('boolean');
  });

  it('classifies a sub-disc miss as a transit (through the object)', () => {
    const ev = predictSkyTargetTransits(under, tle.satrec, {
      fromMs, horizonMs: 14 * 24 * 3600_000, targets: [sunBox],
      requireSunlit: false, requireDarkSky: false,
    });
    // The fixture's closest Sun approach here is ~0.05° ≪ Sun radius (~0.27°).
    const through = ev.find((c) => c.throughObject);
    expect(through).toBeDefined();
    expect(through.kind).toBe('transit');
    expect(through.closestApproachSepDeg).toBeLessThan(through.objectDiameterDeg / 2 + 1e-9);
  });

  it('the dark-sky gate suppresses a daytime Sun approach', () => {
    const ev = predictSkyTargetTransits(under, tle.satrec, {
      fromMs, horizonMs: 14 * 24 * 3600_000, targets: [sunBox],
      requireSunlit: false, requireDarkSky: true, sunBelowDeg: -6,
    });
    expect(ev.length).toBe(0);   // the Sun is necessarily up during its own transit
  });

  it('runs for a fixed RA/Dec (DSO) target without throwing', () => {
    const m42 = { id: 'm42', name: 'M42', raHours: 5.588, decDeg: -5.391, diameterDeg: 1.0, fovWidthDeg: 1.5, fovHeightDeg: 1.0 };
    const ev = predictSkyTargetTransits(under, tle.satrec, {
      fromMs, horizonMs: 14 * 24 * 3600_000, targets: [m42],
    });
    expect(Array.isArray(ev)).toBe(true);
  });
});

describe('nextIssVisiblePass', () => {
  const tle = (() => {
    const p = join(tmp, 'issvp.tle');
    writeFileSync(p, `${NAME}\n${L1}\n${L2}\n`);
    return loadIssTle(p);
  })();

  it('returns null or a well-formed pass without throwing', () => {
    const pass = nextIssVisiblePass(observer, tle.satrec, {
      fromMs: Date.UTC(2024, 4, 3, 0, 0, 0),
      horizonMs: 3 * 24 * 3600_000,
    });
    if (pass !== null) {
      expect(pass.endMs).toBeGreaterThanOrEqual(pass.startMs);
      expect(pass.peakMs).toBeGreaterThanOrEqual(pass.startMs);
      expect(pass.peakMs).toBeLessThanOrEqual(pass.endMs);
      expect(pass.maxElevationDeg).toBeGreaterThanOrEqual(20);
      expect(pass.durationS).toBeGreaterThanOrEqual(0);
      expect(pass.startAzDeg).toBeGreaterThanOrEqual(0);
      expect(pass.startAzDeg).toBeLessThan(360);
    }
  });
});
