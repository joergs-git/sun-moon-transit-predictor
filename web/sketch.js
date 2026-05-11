// FOV sketch renderer — visualises a single transit as it would appear in the
// telescope eyepiece / camera frame. Given a normalised transit entry (from a
// Tracking row or a parsed History payload), produces an SVG string that the
// caller injects into the popup.
//
// Coordinate convention inside the FOV box:
//   - x = (aircraftAz - bodyAz) * cos(bodyEl)   [degrees, east-positive]
//   - y = aircraftEl - bodyEl                   [degrees, up-positive]
// In screen pixels y is flipped (SVG y grows downward). The body sits at the
// FOV centre, which mirrors the typical tracking-mount workflow where the
// telescope keeps the disc fixed and the aircraft sweeps across it.

// ---- Optical setup (edit these to match a different rig) ---------------------
// 500 mm refractor + ZWO ASI174MM sensor (1936×1216 px, 11.34 × 7.13 mm).
const TELESCOPE_FOCAL_MM = 500;
const SENSOR_W_MM = 11.34;
const SENSOR_H_MM = 7.13;

// Generic airliner silhouette dimensions, used until a per-aircraft type
// lookup is wired in. ~A320/B737 envelope; off by no more than ~30 % for
// most narrow- and wide-bodies, which is below the sketch's visual fidelity.
const AC_WINGSPAN_M = 36;
const AC_LENGTH_M = 38;

// Mean apparent angular diameters. Variation is small enough at this scale
// (Sun ±0.014°, Moon ±0.05°) that constants are fine for a sketch.
const BODY_DIAMETER_DEG = { Sun: 0.533, Moon: 0.518 };

// ---- Geometry helpers --------------------------------------------------------
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** FOV size from focal length + sensor in degrees. */
function fovDeg(focalMm, sensorMm) {
  return 2 * Math.atan(sensorMm / 2 / focalMm) * RAD;
}
const FOV_W_DEG = fovDeg(TELESCOPE_FOCAL_MM, SENSOR_W_MM);  // ≈ 1.30°
const FOV_H_DEG = fovDeg(TELESCOPE_FOCAL_MM, SENSOR_H_MM);  // ≈ 0.82°

/** Aircraft angular size at distance r (m). Returns degrees. */
function aircraftAngularDeg(meters, rangeM) {
  if (!rangeM || rangeM <= 0) return 0;
  return Math.atan2(meters, rangeM) * RAD;
}

// ---- Input normalisation -----------------------------------------------------
// Tracking rows (live lifecycle entry) and History rows (DB row + parsed
// payload) carry the same physical quantities under different field names.
// `normalize` converts both to one shape so the renderer doesn't have to
// branch.
/**
 * @typedef {Object} SketchInput
 * @property {'Sun'|'Moon'} body
 * @property {{az: number, el: number}} bodyAt
 * @property {{az: number, el: number, rangeM: number|null}} aircraftAt
 * @property {number|null} sepDeg
 * @property {number|null} trackDeg
 * @property {number|null} groundSpeedMs
 * @property {number|null} altMmsl
 * @property {number|null} closestAtMs
 * @property {string|null} flight
 * @property {string|null} icao
 * @property {Array<{tOffsetMs: number, aircraftAz: number, aircraftEl: number, bodyAz: number, bodyEl: number}>} transitPath
 */

/**
 * Normalise a lifecycle entry (live tracking) into SketchInput.
 * @param {object} entry
 * @returns {SketchInput|null}
 */
export function fromLifecycleEntry(entry) {
  const c = entry?.candidate;
  if (!c?.aircraftAtClosest || !c?.bodyAtClosest) return null;
  return {
    body: entry.body,
    bodyAt: { az: c.bodyAtClosest.azimuthDeg, el: c.bodyAtClosest.elevationDeg },
    aircraftAt: {
      az: c.aircraftAtClosest.azimuthDeg,
      el: c.aircraftAtClosest.elevationDeg,
      rangeM: c.aircraftAtClosest.rangeM ?? null,
    },
    sepDeg: c.closestApproachSepDeg ?? entry.closestApproachSepDeg ?? null,
    trackDeg: c.aircraft?.trackDeg ?? null,
    groundSpeedMs: c.aircraft?.groundSpeedMs ?? null,
    altMmsl: c.aircraft?.altMmsl ?? null,
    closestAtMs: entry.closestApproachAtMs ?? c.closestApproachAtMs ?? null,
    flight: entry.flight ?? entry.callsign ?? null,
    icao: entry.icao ?? null,
    transitPath: Array.isArray(c.transitPath) ? c.transitPath : [],
  };
}

/**
 * Normalise a History row (with parsed `payload`) into SketchInput.
 * Pre-payload-json rows fall back to top-level columns only — the path will
 * be empty so the sketch shows the closest-approach geometry without a line.
 * @param {object} row
 * @returns {SketchInput|null}
 */
export function fromHistoryRow(row) {
  const c = row?.payload?.candidate;
  if (!c?.aircraftAtClosest || !c?.bodyAtClosest) return null;
  return {
    body: row.body,
    bodyAt: { az: c.bodyAtClosest.azimuthDeg, el: c.bodyAtClosest.elevationDeg },
    aircraftAt: {
      az: c.aircraftAtClosest.azimuthDeg,
      el: c.aircraftAtClosest.elevationDeg,
      rangeM: c.aircraftAtClosest.rangeM ?? row.range_m ?? null,
    },
    sepDeg: row.closest_sep_deg ?? c.closestApproachSepDeg ?? null,
    trackDeg: row.track_deg ?? c.aircraft?.trackDeg ?? null,
    groundSpeedMs: row.ground_speed_ms ?? c.aircraft?.groundSpeedMs ?? null,
    altMmsl: row.altitude_m ?? c.aircraft?.altMmsl ?? null,
    closestAtMs: row.closest_at_ms ?? c.closestApproachAtMs ?? null,
    flight: row.flight ?? row.callsign ?? null,
    icao: row.icao ?? null,
    transitPath: Array.isArray(c.transitPath) ? c.transitPath : [],
  };
}

// ---- SVG building ------------------------------------------------------------
const SVG_W = 420;
const SVG_H = 290;
const PAD = 14;
const HEADER_H = 18;
const FOOTER_H = 16;

const COLOURS = {
  fovStroke: '#5a6470',
  fovFill: '#080a0d',
  Sun: '#f4b740',
  SunRim: '#ffdb70',
  Moon: '#d4d8df',
  MoonRim: '#ffffff',
  ac: '#f0f4ff',
  acStroke: '#9aa4b2',
  pathStroke: '#7fb3ff',
  label: '#8b949e',
  axis: '#3a4250',
};

/**
 * Convert a (dAz·cosEl, dEl) offset in degrees to pixel coords inside the FOV
 * rectangle defined by (cx, cy, fovPxW, fovPxH).
 */
function degToPx(dxDeg, dyDeg, cx, cy, pxPerDeg) {
  return { x: cx + dxDeg * pxPerDeg, y: cy - dyDeg * pxPerDeg };
}

/** Aircraft footprint relative to the body, in degrees, for a path sample. */
function relOffsetDeg(p, refEl) {
  return {
    dx: (p.aircraftAz - p.bodyAz) * Math.cos(refEl * DEG),
    dy: p.aircraftEl - p.bodyEl,
  };
}

/**
 * Generic top-down airliner silhouette. Drawn at the origin with `length` and
 * `wingspan` in user units (caller positions + rotates via a <g transform>).
 * Length axis = +x; wingspan axis = ±y. Simple, recognisable shape — fuselage
 * ellipse, swept wings, T-tail.
 */
function aircraftPath(lengthPx, wingspanPx) {
  const L = lengthPx;
  const W = wingspanPx;
  const halfW = W / 2;
  // Fuselage: ellipse via path.
  const fuselage = `M ${-L/2},0 C ${-L/2},${-L*0.08} ${L*0.45},${-L*0.07} ${L/2},0 C ${L*0.45},${L*0.07} ${-L/2},${L*0.08} ${-L/2},0 Z`;
  // Wings: swept trapezoid centred at fuselage midpoint, offset slightly back.
  const wingRootX = -L * 0.05;
  const wingTipX  = -L * 0.20;
  const wingChordRoot = L * 0.22;
  const wingChordTip  = L * 0.06;
  const wing = (sign) =>
    `M ${wingRootX},${sign*L*0.05} L ${wingTipX},${sign*halfW} L ${wingTipX - wingChordTip},${sign*halfW} L ${wingRootX - wingChordRoot},${sign*L*0.05} Z`;
  // Horizontal stabiliser: smaller swept trapezoid near the tail.
  const tailRootX = -L * 0.42;
  const tailTipX  = -L * 0.48;
  const tailSpan  = W * 0.32;
  const tailChordRoot = L * 0.10;
  const tailChordTip  = L * 0.04;
  const tail = (sign) =>
    `M ${tailRootX},${sign*L*0.04} L ${tailTipX},${sign*tailSpan/2} L ${tailTipX - tailChordTip},${sign*tailSpan/2} L ${tailRootX - tailChordRoot},${sign*L*0.04} Z`;
  return `${fuselage} ${wing(1)} ${wing(-1)} ${tail(1)} ${tail(-1)}`;
}

/** SVG text helper. */
function txt(x, y, str, opts = {}) {
  const { fill = COLOURS.label, size = 11, weight = 400, anchor = 'start' } = opts;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="ui-monospace, Menlo, monospace" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${str}</text>`;
}

function fmtSepArcmin(deg) {
  if (deg == null) return '—';
  if (deg >= 1) return `${deg.toFixed(2)}°`;
  return `${(deg * 60).toFixed(1)}'`;
}
function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString();
}
function fmtAlt(m) {
  if (m == null) return '—';
  return `${Math.round(m / 100) * 100} m`;
}
function fmtSpeed(ms) {
  if (ms == null) return '—';
  return `${Math.round(ms * 3.6)} km/h`;
}
function fmtRange(m) {
  if (m == null) return '—';
  return `${(m / 1000).toFixed(1)} km`;
}

/**
 * Build the SVG for one transit.
 * @param {SketchInput} d
 * @returns {string} SVG markup.
 */
export function buildSketchSvg(d) {
  // FOV pixel rectangle, padded to leave room for top header and bottom
  // legend. Aspect ratio is locked to the sensor's, not the SVG canvas.
  const innerW = SVG_W - 2 * PAD;
  const innerH = SVG_H - HEADER_H - FOOTER_H - 2 * PAD;
  const pxPerDegW = innerW / FOV_W_DEG;
  const pxPerDegH = innerH / FOV_H_DEG;
  const pxPerDeg = Math.min(pxPerDegW, pxPerDegH);
  const fovPxW = FOV_W_DEG * pxPerDeg;
  const fovPxH = FOV_H_DEG * pxPerDeg;
  const fovX = (SVG_W - fovPxW) / 2;
  const fovY = HEADER_H + PAD + (innerH - fovPxH) / 2;
  const cx = fovX + fovPxW / 2;
  const cy = fovY + fovPxH / 2;

  // Body disc.
  const bodyDiameterDeg = BODY_DIAMETER_DEG[d.body] ?? 0.53;
  const bodyR = (bodyDiameterDeg / 2) * pxPerDeg;
  const bodyFill = d.body === 'Sun' ? COLOURS.Sun : COLOURS.Moon;
  const bodyRim  = d.body === 'Sun' ? COLOURS.SunRim : COLOURS.MoonRim;

  // Transit path: project each sample into relative-FOV coords. Body motion
  // is subtracted per-sample, so the line shows the path as it appears in a
  // tracking-mount eyepiece where the disc stays centred.
  const refEl = d.bodyAt.el;
  const pathPts = (d.transitPath ?? []).map(p => {
    const { dx, dy } = relOffsetDeg(p, refEl);
    return { ...degToPx(dx, dy, cx, cy, pxPerDeg), tOffsetMs: p.tOffsetMs };
  });

  // Aircraft anchor point at closest approach. Prefer the tOffsetMs=0 path
  // sample (computed at the refined closest time) so it lands on the line.
  // Fallback to the aircraftAt / bodyAt deltas if the path is missing.
  let anchor;
  const midSample = pathPts.find(p => p.tOffsetMs === 0);
  if (midSample) {
    anchor = { x: midSample.x, y: midSample.y };
  } else {
    const dx = (d.aircraftAt.az - d.bodyAt.az) * Math.cos(refEl * DEG);
    const dy = d.aircraftAt.el - d.bodyAt.el;
    anchor = degToPx(dx, dy, cx, cy, pxPerDeg);
  }

  // Apparent heading angle from the path (end - start). When the path is
  // missing, fall back to 90° (horizontal) so the silhouette still has a
  // sensible orientation. A more refined fallback would project trackDeg
  // into local az/el; deferred until typed silhouettes are added.
  let headingRad = 0;
  if (pathPts.length >= 2) {
    const a = pathPts[0];
    const b = pathPts[pathPts.length - 1];
    headingRad = Math.atan2(b.y - a.y, b.x - a.x);
  }

  // Aircraft silhouette size from line-of-sight distance.
  const wingspanDeg = aircraftAngularDeg(AC_WINGSPAN_M, d.aircraftAt.rangeM);
  const lengthDeg   = aircraftAngularDeg(AC_LENGTH_M,   d.aircraftAt.rangeM);
  // Enforce a small visual minimum (3 px) so a very distant aircraft is
  // still discernible — purely a UI affordance, the labels carry the truth.
  const wingPx = Math.max(wingspanDeg * pxPerDeg, 3);
  const lenPx  = Math.max(lengthDeg   * pxPerDeg, 3);

  // ---- Compose SVG ----------------------------------------------------------
  const header =
    `${txt(PAD, HEADER_H, `${d.body} transit · ${d.flight ?? '—'}`, { fill: '#e6edf3', size: 13, weight: 600 })}` +
    `${txt(SVG_W - PAD, HEADER_H, `Sep ${fmtSepArcmin(d.sepDeg)}  ·  ${fmtTime(d.closestAtMs)}`, { fill: '#e6edf3', size: 12, anchor: 'end' })}`;

  const fovRect =
    `<rect x="${fovX}" y="${fovY}" width="${fovPxW}" height="${fovPxH}" ` +
    `fill="${COLOURS.fovFill}" stroke="${COLOURS.fovStroke}" stroke-width="1" rx="2"/>`;

  // Axis crosshair through the body centre — subtle, helps eye lock to the
  // disc when the aircraft passes off-centre.
  const cross =
    `<line x1="${fovX}" y1="${cy}" x2="${fovX + fovPxW}" y2="${cy}" stroke="${COLOURS.axis}" stroke-width="0.5" stroke-dasharray="2 4"/>` +
    `<line x1="${cx}" y1="${fovY}" x2="${cx}" y2="${fovY + fovPxH}" stroke="${COLOURS.axis}" stroke-width="0.5" stroke-dasharray="2 4"/>`;

  const bodyDisc =
    `<defs><radialGradient id="bodyGrad" cx="35%" cy="35%" r="65%">` +
    `<stop offset="0%" stop-color="${bodyRim}" stop-opacity="0.95"/>` +
    `<stop offset="100%" stop-color="${bodyFill}" stop-opacity="1"/>` +
    `</radialGradient></defs>` +
    `<circle cx="${cx}" cy="${cy}" r="${bodyR}" fill="url(#bodyGrad)" stroke="${bodyRim}" stroke-width="0.5"/>`;

  // Motion line + tick marks at each sample, arrowhead at the latest one.
  let pathSvg = '';
  if (pathPts.length >= 2) {
    const poly = pathPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    pathSvg += `<polyline points="${poly}" fill="none" stroke="${COLOURS.pathStroke}" stroke-width="1.2" stroke-opacity="0.85" stroke-dasharray="6 3"/>`;
    for (const p of pathPts) {
      const isAnchor = p.tOffsetMs === 0;
      pathSvg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isAnchor ? 2.2 : 1.4}" fill="${COLOURS.pathStroke}" />`;
    }
    // Arrowhead in direction of motion at the last point.
    const last = pathPts[pathPts.length - 1];
    const hx = Math.cos(headingRad);
    const hy = Math.sin(headingRad);
    const tipX = last.x + hx * 8;
    const tipY = last.y + hy * 8;
    const baseLX = last.x - hy * 4;
    const baseLY = last.y + hx * 4;
    const baseRX = last.x + hy * 4;
    const baseRY = last.y - hx * 4;
    pathSvg += `<polygon points="${tipX},${tipY} ${baseLX},${baseLY} ${baseRX},${baseRY}" fill="${COLOURS.pathStroke}" />`;
  }

  // Aircraft silhouette: translate to anchor, rotate to apparent heading.
  const acGroup =
    `<g transform="translate(${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)}) rotate(${(headingRad * RAD).toFixed(1)})">` +
    `<path d="${aircraftPath(lenPx, wingPx)}" fill="${COLOURS.ac}" stroke="${COLOURS.acStroke}" stroke-width="0.5"/>` +
    `</g>`;

  // Axis labels (AZ on FOV bottom, EL on FOV left side). Helps users tell
  // which way the disc would drift on a fixed altaz mount.
  const axisLabels =
    txt(fovX + 4, fovY + 12, 'EL ↑', { fill: COLOURS.label, size: 10 }) +
    txt(fovX + fovPxW - 4, fovY + fovPxH - 4, 'AZ →', { fill: COLOURS.label, size: 10, anchor: 'end' });

  // Footer line: range, alt, speed, FOV info.
  const footY = SVG_H - PAD + 2;
  const footL = `R ${fmtRange(d.aircraftAt.rangeM)} · Alt ${fmtAlt(d.altMmsl)} · v ${fmtSpeed(d.groundSpeedMs)}`;
  const footR = `FOV ${FOV_W_DEG.toFixed(2)}° × ${FOV_H_DEG.toFixed(2)}° · ${TELESCOPE_FOCAL_MM} mm`;
  const footer =
    txt(PAD, footY, footL, { fill: COLOURS.label, size: 11 }) +
    txt(SVG_W - PAD, footY, footR, { fill: COLOURS.label, size: 11, anchor: 'end' });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" width="${SVG_W}" height="${SVG_H}">` +
    header +
    fovRect +
    cross +
    bodyDisc +
    pathSvg +
    acGroup +
    axisLabels +
    footer +
    `</svg>`
  );
}

// Expose optical setup for tests / external introspection.
export const SKETCH_OPTICS = Object.freeze({
  TELESCOPE_FOCAL_MM,
  SENSOR_W_MM,
  SENSOR_H_MM,
  FOV_W_DEG,
  FOV_H_DEG,
  AC_WINGSPAN_M,
  AC_LENGTH_M,
  BODY_DIAMETER_DEG,
});
