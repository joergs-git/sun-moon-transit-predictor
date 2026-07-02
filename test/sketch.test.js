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
  computeSensorMatrix,
  fromHistoryRow,
  fromLifecycleEntry,
  setOptics,
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

  it('draws a sky-target STAR as a point marker, not a Sun/Moon-sized disc (v0.54.1)', () => {
    const base = {
      bodyAt: { az: 255, el: 62 }, aircraftAt: { az: 255.3, el: 61.7 },
      sepDeg: 0.30, isISS: true, transitPath: [], body: 'Vega (α Lyr)',
    };
    // A star carries objectDiameterDeg 0 → must render as a POINT, not fall back
    // to the 0.53° Sun/Moon disc (which made the ISS-pass proportion look wrong).
    const star = buildSketchSvg({ ...base, bodyDiameterDeg: 0 });
    const moon = buildSketchSvg({ ...base, body: 'Moon', bodyDiameterDeg: 0.518 });
    const maxR = (s) => Math.max(...[...s.matchAll(/<circle[^>]*r="([\d.]+)"/g)].map((m) => +m[1]));
    expect(maxR(star)).toBeLessThan(6);          // small marker, a few px
    expect(star).not.toContain('radialGradient'); // no gradient body disc
    expect(maxR(moon)).toBeGreaterThan(20);      // a real disc, order of magnitude bigger
    expect(moon).toContain('radialGradient');
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

describe('sensor-view transform (v0.43.0)', () => {
  const apply = (m, x, y) => ({ x: m.a * x + m.c * y, y: m.b * x + m.d * y });
  const near = (v, t) => Math.abs(v - t) < 1e-9;

  it('returns null when not configured', () => {
    expect(computeSensorMatrix({ azDeg: 180, elDeg: 40, latDeg: 52, driftWest: '', mirror: false })).toBe(null);
    expect(computeSensorMatrix({ azDeg: NaN, elDeg: 40, latDeg: 52, driftWest: 'right', mirror: false })).toBe(null);
  });

  it('is a pure rotation without mirror, a reflection with mirror', () => {
    const rot = computeSensorMatrix({ azDeg: 150, elDeg: 35, latDeg: 52, driftWest: 'right', mirror: false });
    const ref = computeSensorMatrix({ azDeg: 150, elDeg: 35, latDeg: 52, driftWest: 'right', mirror: true });
    expect(rot.a * rot.d - rot.b * rot.c).toBeCloseTo(1, 9);    // det +1
    expect(ref.a * ref.d - ref.b * ref.c).toBeCloseTo(-1, 9);   // det -1
  });

  it('maps celestial West to the chosen drift direction (right)', () => {
    // At the meridian (south) the sky-frame West vector is screen-right [1,0].
    const m = computeSensorMatrix({ azDeg: 180, elDeg: 40, latDeg: 52, driftWest: 'right', mirror: true });
    const w = apply(m, 1, 0);
    expect(near(w.x, 1) && near(w.y, 0)).toBe(true);
  });

  it('flips N/S with the mirror (Lunt): at meridian, North goes down', () => {
    // Sky-frame North at the meridian is screen-up [0,-1].
    const mirrored = computeSensorMatrix({ azDeg: 180, elDeg: 40, latDeg: 52, driftWest: 'right', mirror: true });
    const plain = computeSensorMatrix({ azDeg: 180, elDeg: 40, latDeg: 52, driftWest: 'right', mirror: false });
    expect(apply(mirrored, 0, -1).y).toBeGreaterThan(0.99);     // down
    expect(apply(plain, 0, -1).y).toBeLessThan(-0.99);          // up
  });

  it('rotates with the Sun (parallactic): matrices differ off the meridian', () => {
    const a = computeSensorMatrix({ azDeg: 120, elDeg: 30, latDeg: 52, driftWest: 'right', mirror: true });
    const b = computeSensorMatrix({ azDeg: 240, elDeg: 30, latDeg: 52, driftWest: 'right', mirror: true });
    expect(Math.abs(a.b - b.b) + Math.abs(a.d - b.d)).toBeGreaterThan(0.1);
  });

  it('draws an ✕ marker for a far/illegible aircraft, the silhouette when close (v0.45.4)', () => {
    const base = {
      body: 'Sun', flight: 'X', closestAtMs: 1.7e12, nowMs: 1.7e12,
      bodyAt: { az: 140, el: 30 }, obsLat: 52.28,
      aircraftAt: { az: 140.1, el: 30.1, rangeM: 42000 },
    };
    const cross = /x1="-6" y1="-6" x2="6" y2="6"/;
    const close = buildSketchSvg({ ...base, sepDeg: 0.3 });
    expect(close).not.toMatch(cross);
    expect(close).toContain('<path d="M ');       // true-shape silhouette
    const far = buildSketchSvg({ ...base, sepDeg: 4.0 });
    expect(far).toMatch(cross);                    // ✕ marker instead
  });

  it('uses a North-up frame with obsLat, falls back to alt-az without it (v0.45.2)', () => {
    const candidate = syntheticTransitCandidate();
    const entry = {
      body: 'Sun', icao: candidate.icao, flight: 'TST123', callsign: 'TST123',
      closestApproachAtMs: candidate.closestApproachAtMs,
      closestApproachSepDeg: candidate.closestApproachSepDeg,
      candidate,
    };
    setOptics({ driftWest: '' });   // isolate from the sensor-box test
    const input = fromLifecycleEntry(entry);

    // No obsLat → raw alt-az frame (EL ↑ / AZ → axis labels, no zenith tick).
    const altaz = buildSketchSvg(input);
    expect(altaz).toContain('EL ↑');
    expect(altaz).toContain('AZ →');
    expect(altaz).not.toMatch(/>Z</);

    // With obsLat → North-up: no EL/AZ labels, a fixed N/S/E/W rose (N in the
    // rose colour at the top) and a zenith 'Z' tick.
    const northUp = buildSketchSvg({ ...input, obsLat: 52.28 });
    expect(northUp).not.toContain('EL ↑');
    expect(northUp).not.toContain('AZ →');
    expect(northUp).toMatch(/>N</);
    expect(northUp).toMatch(/>Z</);
    expect(northUp).toContain('#7fd0ff');   // North drawn in the rose colour
  });

  it('rotates the FOV box to the camera orientation when configured (W/R/T labels)', () => {
    const candidate = syntheticTransitCandidate();
    const entry = {
      body: 'Sun', icao: candidate.icao, flight: 'TST123', callsign: 'TST123',
      closestApproachAtMs: candidate.closestApproachAtMs,
      closestApproachSepDeg: candidate.closestApproachSepDeg,
      candidate,
    };
    const input = { ...fromLifecycleEntry(entry), obsLat: 52.28 };

    // Not configured → the FOV box is the plain axis-aligned dashed rect, and
    // there are no R/T edge labels (those are unique to the rotated box; a bare
    // <polygon> can be the aircraft arrowhead, so we key on R/T instead).
    setOptics({ driftWest: '' });
    const plain = buildSketchSvg(input);
    expect(plain).not.toMatch(/>R</);
    expect(plain).not.toMatch(/>T</);

    // Configured → the box becomes a rotated, dashed fovStroke <polygon> with
    // W/R/T edge labels.
    setOptics({ driftWest: 'right', mirror: true });
    const rotated = buildSketchSvg(input);
    expect(rotated).toMatch(/<polygon[^>]*stroke="#5a6470"[^>]*stroke-dasharray="6 4"/);
    expect(rotated).toMatch(/>R</);
    expect(rotated).toMatch(/>T</);
    setOptics({ driftWest: '' });   // reset for other tests
  });

  it('plots the transit path/aircraft in the SENSOR frame, not North-up (v0.49.0 bugfix)', () => {
    // Body at the meridian where the sky-frame West vector is screen-right
    // ([1,0]); an aircraft a hair to higher azimuth therefore sits to the
    // celestial WEST of the disc. Same elevation → the offset is pure-West.
    const base = {
      body: 'Sun', flight: 'X', closestAtMs: 1.7e12,
      bodyAt: { az: 180, el: 40 }, obsLat: 52.0,
      aircraftAt: { az: 180.25, el: 40.0, rangeM: 14000 },
      sepDeg: 0.19,
    };
    // Aircraft silhouette anchor Y (the <g transform="translate(x y) rotate…">)
    // and the body-disc centre Y (the radial-gradient circle).
    const acY = (svg) => {
      const m = svg.match(/translate\(([\-\d.]+) ([\-\d.]+)\) rotate/);
      return m ? parseFloat(m[2]) : null;
    };
    const discY = (svg) => {
      const m = svg.match(/<circle cx="[\d.]+" cy="([\d.]+)" r="[\d.]+" fill="url\(#bodyGrad\)"/);
      return m ? parseFloat(m[1]) : null;
    };

    // driftWest='up' → celestial West is screen-UP, so a West aircraft is ABOVE
    // the disc centre. The blue 'W' tick must likewise sit above the centre.
    setOptics({ driftWest: 'up', mirror: false });
    const up = buildSketchSvg(base);
    expect(acY(up)).toBeLessThan(discY(up));

    // driftWest='down' → West is screen-DOWN, so the same aircraft is BELOW.
    setOptics({ driftWest: 'down', mirror: false });
    const down = buildSketchSvg(base);
    expect(acY(down)).toBeGreaterThan(discY(down));

    // The plane MOVED when only the camera orientation changed — the exact
    // thing the old code got wrong (it always drew the path North-up, ignoring
    // the sensor calibration the FOV box was already using).
    expect(Math.abs(acY(up) - acY(down))).toBeGreaterThan(5);
    setOptics({ driftWest: '' });   // reset for other tests
  });
});
