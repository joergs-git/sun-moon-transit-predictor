import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIssTle, predictIssTransits } from '../src/iss.js';
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
});
