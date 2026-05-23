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

  it('skips aircraft below minAltitudeM and keeps those at/above', () => {
    const t0 = new Date('2026-06-21T11:30:00Z').getTime();
    const sun = sunAzEl(RHEINE, new Date(t0));
    const high = makeAircraft({ ...aircraftAtBodyLineOfSight(RHEINE, sun, 11000),
      icao: 'high01', groundSpeedMs: 0, trackDeg: 0, receivedAtMs: t0 });
    const low  = makeAircraft({ ...aircraftAtBodyLineOfSight(RHEINE, sun, 800),
      icao: 'low01',  groundSpeedMs: 0, trackDeg: 0, receivedAtMs: t0 });
    // Without the gate both pass through the tracker.
    expect(findTransits(RHEINE, [high, low], t0).length).toBe(2);
    // With a 2000 m gate only the high-altitude airframe remains.
    const filtered = findTransits(RHEINE, [high, low], t0, { minAltitudeM: 2000 });
    expect(filtered.length).toBe(1);
    expect(filtered[0].icao).toBe('high01');
    // Aircraft with no altitude data are skipped while the gate is on.
    const noAlt = makeAircraft({ ...aircraftAtBodyLineOfSight(RHEINE, sun, 11000),
      icao: 'na01', altMmsl: null, groundSpeedMs: 0, trackDeg: 0, receivedAtMs: t0 });
    const gated = findTransits(RHEINE, [noAlt], t0, { minAltitudeM: 2000 });
    expect(gated).toEqual([]);
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

  it('compensates for seen_pos lag — predicted position uses receivedAtMs, not nowMs', () => {
    // Place an aircraft whose *current* position (10 s after the last fix) is
    // on the line of sight to the Sun. Its `lat,lon` (the fix) is therefore
    // 10 s behind. A correct tracker projects from receivedAtMs and finds
    // the transit; the buggy one (projecting from nowMs) misses it because
    // it under-projects by 10 s × ground speed.
    const t0 = new Date('2026-06-21T11:30:00Z').getTime();
    const lagSec = 10;
    const sun = sunAzEl(RHEINE, new Date(t0));
    const altMmsl = 11000;
    const currentPos = aircraftAtBodyLineOfSight(RHEINE, sun, altMmsl);
    // Walk the position back by `lagSec` seconds along the eastbound track.
    const groundSpeed = 230;                   // m/s
    const dWest = groundSpeed * lagSec;        // metres travelled in the lag
    const dLon = -(dWest / (EARTH_R * Math.cos(currentPos.lat * DEG))) * RAD;
    const ac = makeAircraft({
      lat: currentPos.lat,
      lon: currentPos.lon + dLon,              // fix is dWest west of "now"
      altMmsl,
      groundSpeedMs: groundSpeed,
      trackDeg: 90,                             // due east
      receivedAtMs: t0 - lagSec * 1000,
      seenPosS: lagSec,
    });
    const cands = findTransits(RHEINE, [ac], t0);
    expect(cands.length).toBe(1);
    expect(cands[0].closestApproachSepDeg).toBeLessThan(0.15);
    expect(cands[0].closestApproachAtMs).toBeGreaterThanOrEqual(t0);
    expect(cands[0].closestApproachAtMs).toBeLessThan(t0 + 5000);
  });

  it('returns sub-step closest approach time via quadratic vertex refinement', () => {
    // With stepS = 1 s, an aircraft whose true closest approach falls at
    // ~0.4 s past sample t=2 should report a refined time that is NOT exactly
    // on a sample boundary. Validates parabolicVertex hookup.
    const t0 = new Date('2026-06-21T11:30:00Z').getTime();
    const sun = sunAzEl(RHEINE, new Date(t0 + 2400));   // sun position 2.4s ahead
    const altMmsl = 11000;
    const currentPos = aircraftAtBodyLineOfSight(RHEINE, sun, altMmsl);
    // Now wind position back 2.4 s along an eastbound track so the aircraft
    // arrives at currentPos at t0 + 2400 ms.
    const groundSpeed = 230;
    const dWest = groundSpeed * 2.4;
    const dLon = -(dWest / (EARTH_R * Math.cos(currentPos.lat * DEG))) * RAD;
    const ac = makeAircraft({
      lat: currentPos.lat,
      lon: currentPos.lon + dLon,
      altMmsl,
      groundSpeedMs: groundSpeed,
      trackDeg: 90,
      receivedAtMs: t0,
    });
    // Wide threshold ensures both neighbouring samples are flagged so the
    // candidate is constructed; the test then asserts that the *refined*
    // closest-approach time is between samples, not on one.
    const cands = findTransits(RHEINE, [ac], t0, { stepS: 1, thresholdDeg: 3.0 });
    expect(cands.length).toBe(1);
    const closestSec = (cands[0].closestApproachAtMs - t0) / 1000;
    expect(closestSec).toBeGreaterThan(2.0);
    expect(closestSec).toBeLessThan(3.0);
    // Refinement must NOT land on a discrete sample boundary (would mean
    // the parabola fit was skipped or the math is broken).
    expect(Math.abs(closestSec - Math.round(closestSec))).toBeGreaterThan(0.05);
  });

  it('reports level=candidate for tight matches and level=radio for near-misses', () => {
    const t0 = new Date('2026-06-21T11:30:00Z').getTime();
    const sun = sunAzEl(RHEINE, new Date(t0));
    // Tight: on the line of sight → 'candidate' (sep ≈ 0)
    const tightPos = aircraftAtBodyLineOfSight(RHEINE, sun, 11000);
    const tightAc = makeAircraft({
      ...tightPos, altMmsl: 11000,
      groundSpeedMs: 0, trackDeg: 0,
      receivedAtMs: t0, icao: 'tightAA',
    });
    // Radio: offset ~6° in azimuth so the projected sep stays well above
    // the 0.3° tight threshold even after the sun's ~1.25°/5min motion, but
    // comfortably inside the 10° radio band.
    const radioPos = aircraftAtBodyLineOfSight(
      RHEINE, { azimuthDeg: sun.azimuthDeg + 6, elevationDeg: sun.elevationDeg, rangeM: null }, 11000,
    );
    const radioAc = makeAircraft({
      ...radioPos, altMmsl: 11000,
      groundSpeedMs: 0, trackDeg: 0,
      receivedAtMs: t0, icao: 'radioBB',
    });
    const cands = findTransits(RHEINE, [tightAc, radioAc], t0, {
      thresholdDeg: 0.3, looseThresholdDeg: 10.0, horizonS: 60,
    });
    expect(cands.length).toBe(2);
    const byIcao = Object.fromEntries(cands.map(c => [c.icao, c]));
    expect(byIcao.tightAA.level).toBe('candidate');
    expect(byIcao.tightAA.closestApproachSepDeg).toBeLessThan(0.3);
    expect(byIcao.radioBB.level).toBe('radio');
    expect(byIcao.radioBB.closestApproachSepDeg).toBeGreaterThan(0.3);
    expect(byIcao.radioBB.closestApproachSepDeg).toBeLessThan(10.0);
  });

  it('returns no candidate when the projected min is outside both thresholds', () => {
    const t0 = new Date('2026-06-21T11:30:00Z').getTime();
    const ac = makeAircraft({
      lat: 53.0, lon: 9.0, altMmsl: 11000,
      groundSpeedMs: 230, trackDeg: 270,
      receivedAtMs: t0,
    });
    const cands = findTransits(RHEINE, [ac], t0, {
      thresholdDeg: 0.3, looseThresholdDeg: 1.0,
    });
    expect(cands).toEqual([]);
  });

  it('emits a dense transitPath spanning ±5 s around closest approach', () => {
    // Sampling switched from 5 wide-spaced offsets (±60 s) to 21 dense
    // ones (every 0.5 s in ±5 s) in v0.7.6 — see PATH_OFFSETS_SEC. The wide
    // offsets were producing a misleading V-shape inside the FOV; the
    // tight sampling renders the actual near-horizontal arc.
    const t0 = new Date('2026-06-21T11:30:00Z').getTime();
    const sun = sunAzEl(RHEINE, new Date(t0));
    const pos = aircraftAtBodyLineOfSight(RHEINE, sun, 11000);
    const groundSpeed = 230;
    const dWest = groundSpeed * 2;
    const dLon = -(dWest / (EARTH_R * Math.cos(pos.lat * DEG))) * RAD;
    const ac = makeAircraft({
      lat: pos.lat,
      lon: pos.lon + dLon,
      altMmsl: 11000,
      groundSpeedMs: groundSpeed,
      trackDeg: 90,
      receivedAtMs: t0,
    });
    const cands = findTransits(RHEINE, [ac], t0);
    expect(cands.length).toBe(1);
    const path = cands[0].transitPath;
    expect(Array.isArray(path)).toBe(true);
    expect(path.length).toBe(21);
    // First and last offsets cover the symmetric ±5 s window.
    expect(path[0].tOffsetMs).toBe(-5000);
    expect(path[path.length - 1].tOffsetMs).toBe(5000);
    // Offsets are monotonically increasing and evenly spaced at 0.5 s.
    for (let i = 1; i < path.length; i++) {
      expect(path[i].tOffsetMs).toBeGreaterThan(path[i - 1].tOffsetMs);
      expect(path[i].tOffsetMs - path[i - 1].tOffsetMs).toBe(500);
    }
    // A sample at the t=0 anchor must exist and approximately match the
    // reported closest separation (sub-step discretisation aside).
    const mid = path.find(p => p.tOffsetMs === 0);
    expect(mid).toBeDefined();
    const sepMid = Math.hypot(
      (mid.aircraftAz - mid.bodyAz) * Math.cos(mid.bodyEl * DEG),
      mid.aircraftEl - mid.bodyEl,
    );
    expect(Math.abs(sepMid - cands[0].closestApproachSepDeg)).toBeLessThan(0.2);
    // All samples must be above the horizon for both sides.
    for (const s of path) {
      expect(s.aircraftEl).toBeGreaterThan(0);
      expect(s.bodyEl).toBeGreaterThan(0);
    }
  });

  it('applies geoidUndulationM for barometric altitudes only', () => {
    // For a barometric source at "10000 m MSL", a 46 m geoid offset shifts
    // the apparent HAE up by 46 m, which moves the aircraft Az/El upward by
    // a fraction of a degree — enough to shift closest separation. For a
    // geometric source the offset must NOT be applied (already HAE).
    const t0 = new Date('2026-06-21T11:30:00Z').getTime();
    const sun = sunAzEl(RHEINE, new Date(t0));
    const pos = aircraftAtBodyLineOfSight(RHEINE, sun, 10000);
    const baroAc = makeAircraft({
      ...pos, altMmsl: 10000, altSource: 'barometric',
      groundSpeedMs: 0, trackDeg: 0, receivedAtMs: t0,
    });
    const geomAc = makeAircraft({
      ...pos, altMmsl: 10000, altSource: 'geometric',
      groundSpeedMs: 0, trackDeg: 0, receivedAtMs: t0,
      icao: 'test02',
    });
    const candsNoOffset = findTransits(RHEINE, [baroAc, geomAc], t0, { geoidUndulationM: 0 });
    const candsWithOffset = findTransits(RHEINE, [baroAc, geomAc], t0, { geoidUndulationM: 46 });
    // Geometric aircraft separation must be unchanged by the offset.
    const geomSep0 = candsNoOffset.find(c => c.icao === 'test02').closestApproachSepDeg;
    const geomSep46 = candsWithOffset.find(c => c.icao === 'test02').closestApproachSepDeg;
    expect(geomSep46).toBeCloseTo(geomSep0, 6);
    // Barometric aircraft separation must change with the offset.
    const baroSep0 = candsNoOffset.find(c => c.icao === 'test01').closestApproachSepDeg;
    const baroSep46 = candsWithOffset.find(c => c.icao === 'test01').closestApproachSepDeg;
    expect(Math.abs(baroSep46 - baroSep0)).toBeGreaterThan(0.0);
  });
});
