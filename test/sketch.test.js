// Smoke tests for the FOV sketch renderer. The renderer is DOM-free — it
// only assembles SVG strings — so we can exercise it from Vitest without
// jsdom. The goal here is to pin the integration with tracker output so a
// shape change in TransitCandidate fails loudly, and to verify the optics
// match the documented 500 mm + ASI174MM setup.

import { describe, expect, it } from 'vitest';
import { sunAzEl } from '../src/geometry.js';
import { findTransits } from '../src/tracker.js';
import {
  buildSketchSvg,
  buildSideViewSvg,
  fromHistoryRow,
  fromLifecycleEntry,
  SKETCH_OPTICS,
} from '../web/sketch.js';

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
  return { lat: observer.latitudeDeg + dLat, lon: observer.longitudeDeg + dLon, altMmsl };
}

function syntheticTransitCandidate() {
  // Pre-position an aircraft a few seconds west of the Sun line of sight
  // moving east, so findTransits returns one candidate with a populated
  // transitPath.
  const t0 = new Date('2026-06-21T11:30:00Z').getTime();
  const sun = sunAzEl(RHEINE, new Date(t0));
  const pos = aircraftAtBodyLineOfSight(RHEINE, sun, 11000);
  const groundSpeed = 230;
  const dWest = groundSpeed * 2;
  const dLon = -(dWest / (EARTH_R * Math.cos(pos.lat * DEG))) * RAD;
  const ac = {
    icao: 'aaa111',
    callsign: 'TST123',
    lat: pos.lat,
    lon: pos.lon + dLon,
    altMmsl: 11000,
    altSource: 'geometric',
    groundSpeedMs: groundSpeed,
    trackDeg: 90,
    verticalRateMs: 0,
    seenPosS: 0,
    receivedAtMs: t0,
  };
  const cands = findTransits(RHEINE, [ac], t0);
  expect(cands.length).toBe(1);
  return cands[0];
}

describe('FOV optics', () => {
  it('matches the documented 500 mm + ASI174MM FOV', () => {
    expect(SKETCH_OPTICS.FOV_W_DEG).toBeGreaterThan(1.29);
    expect(SKETCH_OPTICS.FOV_W_DEG).toBeLessThan(1.31);
    expect(SKETCH_OPTICS.FOV_H_DEG).toBeGreaterThan(0.81);
    expect(SKETCH_OPTICS.FOV_H_DEG).toBeLessThan(0.83);
  });
});

describe('sketch renderer', () => {
  it('accepts a lifecycle-style entry and renders an SVG with the body disc + path', () => {
    const candidate = syntheticTransitCandidate();
    const entry = {
      body: 'Sun',
      icao: candidate.icao,
      flight: 'TST123',
      callsign: 'TST123',
      closestApproachAtMs: candidate.closestApproachAtMs,
      closestApproachSepDeg: candidate.closestApproachSepDeg,
      candidate,
    };
    const input = fromLifecycleEntry(entry);
    expect(input).not.toBeNull();
    expect(input.transitPath.length).toBe(21);
    const svg = buildSketchSvg(input);
    expect(svg.startsWith('<svg')).toBe(true);
    // FOV rectangle, body disc (radial gradient), motion line, aircraft silhouette.
    expect(svg).toContain('<rect');
    expect(svg).toContain('radialGradient');
    expect(svg).toContain('<circle');
    expect(svg).toContain('<polyline');
    expect(svg).toContain('<path');
    expect(svg).toContain('Sun');
  });

  it('draws the time-lapse "now" marker only while inside the path window', () => {
    const candidate = syntheticTransitCandidate();
    const entry = {
      body: 'Sun', icao: candidate.icao, flight: 'TST123', callsign: 'TST123',
      closestApproachAtMs: candidate.closestApproachAtMs,
      closestApproachSepDeg: candidate.closestApproachSepDeg,
      candidate,
    };
    const input = fromLifecycleEntry(entry);
    // No nowMs → no marker (back-compat; existing callers unaffected).
    expect(buildSketchSvg(input)).not.toContain('<animate');
    // nowMs at closest approach → marker present (pulsing + "now" label).
    const atClosest = buildSketchSvg({ ...input, nowMs: input.closestAtMs });
    expect(atClosest).toContain('<animate');
    expect(atClosest).toContain('>now<');
    // nowMs far outside the depicted window → no marker.
    const wayOff = buildSketchSvg({ ...input, nowMs: input.closestAtMs + 1e12 });
    expect(wayOff).not.toContain('<animate');
  });

  it('puts route + ETA/clock in the header (ETA only with a live nowMs)', () => {
    const candidate = syntheticTransitCandidate();
    const entry = {
      body: 'Sun', icao: candidate.icao, flight: 'TST123', callsign: 'TST123',
      route: { origin: { iata: 'BER' }, destination: { iata: 'LTN' } },
      closestApproachAtMs: candidate.closestApproachAtMs,
      closestApproachSepDeg: candidate.closestApproachSepDeg,
      candidate,
    };
    const input = fromLifecycleEntry(entry);
    expect(input.origin).toBe('BER');
    expect(input.destination).toBe('LTN');
    // No nowMs → header shows the clock only, no "min" ETA wording.
    const noNow = buildSketchSvg(input);
    expect(noNow).toContain('BER→LTN');
    expect(noNow).not.toMatch(/\d+ min/);
    // With a live nowMs → soft-red ETA + clock.
    const live = buildSketchSvg({ ...input, nowMs: input.closestAtMs - 7 * 60_000 });
    expect(live).toContain('BER→LTN');
    expect(live).toContain('in 7 min');
    expect(live).toContain('#ff8f8f');
  });

  it('draws the horizon compass always and the celestial rose only with obsLat', () => {
    const candidate = syntheticTransitCandidate();
    const entry = {
      body: 'Sun', icao: candidate.icao, flight: 'TST123', callsign: 'TST123',
      closestApproachAtMs: candidate.closestApproachAtMs,
      closestApproachSepDeg: candidate.closestApproachSepDeg,
      candidate,
    };
    const input = fromLifecycleEntry(entry);
    const az = input.bodyAt.az;
    const C = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const dir = (b) => C[Math.round((((b % 360) + 360) % 360) / 45) % 8];

    // Horizon compass only needs the body azimuth → present even without lat.
    const noLat = buildSketchSvg(input);
    for (const b of [az, az + 90, az + 180, az - 90]) {
      expect(noLat).toContain(`>${dir(b)}<`);
    }
    expect(noLat).not.toContain('#7fd0ff');         // no celestial rose

    // With observer latitude → the parallactic N/E rose is added.
    const withLat = buildSketchSvg({ ...input, obsLat: 52.28 });
    expect(withLat).toContain('#7fd0ff');
    expect(withLat).toContain('>N<');
    expect(withLat).toContain('>E<');
  });

  it('falls back gracefully when transitPath is missing (old history row)', () => {
    const candidate = syntheticTransitCandidate();
    // Simulate an old DB row: the payload still has aircraftAtClosest /
    // bodyAtClosest but no transitPath (pre-feature data).
    const legacyCandidate = { ...candidate };
    delete legacyCandidate.transitPath;
    const row = {
      body: 'Sun',
      icao: 'aaa111',
      flight: 'TST123',
      callsign: 'TST123',
      closest_at_ms: candidate.closestApproachAtMs,
      closest_sep_deg: candidate.closestApproachSepDeg,
      range_m: candidate.aircraftAtClosest.rangeM,
      altitude_m: 11000,
      ground_speed_ms: 230,
      track_deg: 90,
      payload: { candidate: legacyCandidate, route: null },
    };
    const input = fromHistoryRow(row);
    expect(input).not.toBeNull();
    expect(input.transitPath).toEqual([]);
    const svg = buildSketchSvg(input);
    // Still a valid SVG with the body and aircraft, just no polyline.
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<circle');
    expect(svg).not.toContain('<polyline');
  });

  it('returns null when essential fields are missing', () => {
    expect(fromLifecycleEntry({})).toBeNull();
    expect(fromLifecycleEntry({ candidate: {} })).toBeNull();
    expect(fromHistoryRow({ payload: null })).toBeNull();
  });
});

describe('side view', () => {
  it('renders an SVG and colours the wedge by elevation band', () => {
    // 50° → green band (≥ 45°).
    const green = buildSideViewSvg({ elevationDeg: 50, rangeM: 18000, label: 'D-AIBC' });
    expect(green.startsWith('<svg')).toBe(true);
    expect(green).toContain('SIDE VIEW');
    expect(green).toContain('#5fd07f');          // green band hue
    expect(green).toContain('50° · 18.0 km');    // elevation + slant caption
    // 22° → red band (< 30°).
    const red = buildSideViewSvg({ elevationDeg: 22, rangeM: 32000 });
    expect(red).toContain('#ff5d5d');
    // The 20/30/45 reference rays are always drawn.
    expect(red).toContain('20°');
    expect(red).toContain('45°');
  });

  it('returns "" when elevation or range is missing/invalid', () => {
    expect(buildSideViewSvg({ rangeM: 18000 })).toBe('');
    expect(buildSideViewSvg({ elevationDeg: 30 })).toBe('');
    expect(buildSideViewSvg({ elevationDeg: 0, rangeM: 18000 })).toBe('');
    expect(buildSideViewSvg(null)).toBe('');
  });
});
