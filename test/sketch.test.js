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
    expect(input.transitPath.length).toBe(5);
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
