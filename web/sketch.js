// FOV sketch renderer — visualises a single transit as it would appear in the
// telescope eyepiece / camera frame. Given a normalised transit entry (from a
// Tracking row or a parsed History payload), produces an SVG string that the
// caller injects into the popup.

import { resolveAircraftType } from './aircraft-types.js';
//
// Coordinate convention inside the FOV box:
//   - x = (aircraftAz - bodyAz) * cos(bodyEl)   [degrees, east-positive]
//   - y = aircraftEl - bodyEl                   [degrees, up-positive]
// In screen pixels y is flipped (SVG y grows downward). The body sits at the
// FOV centre, which mirrors the typical tracking-mount workflow where the
// telescope keeps the disc fixed and the aircraft sweeps across it.

// ---- Optical setup (edit these to match a different rig) ---------------------
// Mutable so the Settings panel can hot-swap focal length + sensor at
// runtime via setOptics(). Defaults match the original rig (500 mm refractor
// + ZWO ASI174MM, 1936×1216 px, 11.34 × 7.13 mm) so the sketch still works
// before /api/config has answered for the first time.
const OPTICS = {
  TELESCOPE_FOCAL_MM: 500,
  SENSOR_W_MM: 11.34,
  SENSOR_H_MM: 7.13,
  SENSOR_NAME: 'ZWO ASI174MM',
  // Camera orientation for the "Sensor view" (v0.43.0). DRIFT_WEST = the screen
  // direction the body drifts with tracking OFF ('right'|'left'|'up'|'down') =
  // celestial West in the sensor (a one-time drift-test calibration). MIRROR =
  // the image is mirrored (star diagonal / Lunt). Empty DRIFT_WEST → no sensor
  // view (sky view only). See computeSensorMatrix().
  DRIFT_WEST: '',
  MIRROR: false,
};

// Generic airliner fallback envelope (~A320/B737), used only when the ADS-B
// feed gave us no resolvable ICAO type code. When a type *is* known the
// silhouette is scaled to that airframe's real wingspan/length instead — see
// the per-entry wingspanM/lengthM fields wired in from aircraft-types.js.
const AC_WINGSPAN_M = 36;
const AC_LENGTH_M = 38;

// Beyond this separation the dynamic zoom-out (v0.45.0) has shrunk the
// silhouette to an illegible blob, so the aircraft is drawn as a clear ✕ marker
// at its position instead of a tiny shape. (v0.45.4)
const FAR_MARKER_SEP_DEG = 2.0;

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

/**
 * Hot-swap the optical setup at runtime (driven by /api/config). Only keys
 * that are valid positive numbers are accepted; everything else is ignored
 * so a malformed payload can't break the sketch.
 */
export function setOptics(patch) {
  if (!patch || typeof patch !== 'object') return;
  const map = {
    telescopeFocalMm: 'TELESCOPE_FOCAL_MM',
    sensorWmm: 'SENSOR_W_MM',
    sensorHmm: 'SENSOR_H_MM',
  };
  for (const [src, dst] of Object.entries(map)) {
    if (src in patch) {
      const v = Number(patch[src]);
      if (Number.isFinite(v) && v > 0) OPTICS[dst] = v;
    }
  }
  if (typeof patch.sensorName === 'string' && patch.sensorName.trim()) {
    OPTICS.SENSOR_NAME = patch.sensorName.trim();
  }
  if ('driftWest' in patch) {
    const v = String(patch.driftWest ?? '').toLowerCase();
    OPTICS.DRIFT_WEST = ['right', 'left', 'up', 'down'].includes(v) ? v : '';
  }
  if ('mirror' in patch) OPTICS.MIRROR = Boolean(patch.mirror);
}

/**
 * Sensor-frame transform (v0.43.0). Returns a 2×2 matrix {a,b,c,d} that maps a
 * SKY-frame screen offset (dx,dy from the disc centre, y-down) to the SENSOR
 * frame, so the FOV preview can be shown exactly as it appears in SharpCap —
 * or null when not configured / no data.
 *
 * It reuses the same ENU vectors the celestial compass uses, so celestial West
 * (= the drift direction) and North are already parallactic-correct: on an EQ
 * mount the camera↔equatorial angle is fixed, the camera↔alt-az angle rotates
 * with the parallactic angle over the day, and this picks that up automatically
 * because West/North are recomputed from the body's az/el each call. The user
 * calibrates only the constant offset (drift direction) + parity (mirror).
 *
 * @param {{azDeg:number, elDeg:number, latDeg:number, driftWest:string, mirror:boolean}} o
 */
export function computeSensorMatrix({ azDeg, elDeg, latDeg, driftWest, mirror }) {
  const DW = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] }[driftWest];
  if (!DW) return null;
  if (![azDeg, elDeg, latDeg].every(Number.isFinite)) return null;

  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const norm = (v) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };

  const A = azDeg * DEG; const h = elDeg * DEG; const phi = latDeg * DEG;
  const O = [Math.cos(h) * Math.sin(A), Math.cos(h) * Math.cos(A), Math.sin(h)];   // body
  const P = [0, Math.cos(phi), Math.sin(phi)];                                     // celestial pole
  const Rs = [Math.cos(A), -Math.sin(A), 0];                                       // +az tangent (screen right)
  let Us = norm(cross(O, Rs));                                                      // toward-zenith tangent (screen up)
  if (Us[2] < 0) Us = [-Us[0], -Us[1], -Us[2]];
  const Et = norm(cross(P, O));                                                     // celestial East (increasing RA)
  const Wt = [-Et[0], -Et[1], -Et[2]];                                             // celestial West = drift direction
  const projN = (() => { const k = dot(P, O); return norm([P[0] - k * O[0], P[1] - k * O[1], P[2] - k * O[2]]); })();

  // Sky-frame SCREEN unit vectors (x right, y DOWN → y = −Us component).
  const westS = [dot(Wt, Rs), -dot(Wt, Us)];
  const northS = [dot(projN, Rs), -dot(projN, Us)];
  const hs = westS[0] * northS[1] - westS[1] * northS[0];      // source handedness, ±1

  // Desired North direction: perpendicular to D_W, sign chosen so the whole
  // transform is a pure rotation (no mirror) or a reflection (mirror).
  const target = (mirror ? -1 : 1) * hs;
  const DN = target > 0 ? [-DW[1], DW[0]] : [DW[1], -DW[0]];

  // M = [DW DN] · [westS northS]^T  (both bases orthonormal → M orthogonal).
  const a = DW[0] * westS[0] + DN[0] * northS[0];
  const c = DW[0] * westS[1] + DN[0] * northS[1];
  const b = DW[1] * westS[0] + DN[1] * northS[0];
  const dd = DW[1] * westS[1] + DN[1] * northS[1];
  // In the sensor frame the cardinals land at fixed directions by construction:
  // West → D_W, North → D_N, and the opposites for East/South. Handed back so
  // the renderer can label them without recomputing the ENU math.
  const cardinals = { W: DW, E: [-DW[0], -DW[1]], N: DN, S: [-DN[0], -DN[1]] };
  return { a, b, c, d: dd, cardinals };
}

/**
 * Dashed sensor-FOV box centred at (cx,cy), w×h px. With a sensor matrix it is
 * drawn ROTATED into the camera's real sky orientation (a small blue 'W' tick
 * marks the drift/West edge so it maps to the SharpCap drift test); without
 * one it falls back to the axis-aligned dashed rectangle. The box is placed by
 * mapping the sensor's own axis-aligned corners back to the sky frame via Mᵀ
 * (M is orthogonal, so the inverse is the transpose).
 */
/**
 * Screen-space rotation {c,s} that brings celestial North to screen-up (and
 * therefore West to screen-right) for a body at (az,el) seen from latitude lat.
 * Applied to every plotted offset so the whole FOV reads N-up / W-right (the
 * intuitive solar/astro convention) instead of the alt-az frame. The angle is
 * the parallactic angle, so it follows the body over the day. null when lat is
 * missing → the caller keeps the alt-az frame. Reuses the same ENU vectors as
 * computeSensorMatrix.
 */
function northUpScreenRot(azDeg, elDeg, latDeg) {
  if (![azDeg, elDeg, latDeg].every(Number.isFinite)) return null;
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const norm = (v) => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
  const A = azDeg * DEG; const h = elDeg * DEG; const phi = latDeg * DEG;
  const O = [Math.cos(h) * Math.sin(A), Math.cos(h) * Math.cos(A), Math.sin(h)];
  const P = [0, Math.cos(phi), Math.sin(phi)];
  const Rs = [Math.cos(A), -Math.sin(A), 0];
  let Us = norm(cross(O, Rs));
  if (Us[2] < 0) Us = [-Us[0], -Us[1], -Us[2]];
  const k = dot(P, O);
  const Nt = norm([P[0] - k * O[0], P[1] - k * O[1], P[2] - k * O[2]]);
  // Celestial North as a SCREEN vector (y-down): x = +Rs comp, y = −Us comp.
  const ax = dot(Nt, Rs); const ay = -dot(Nt, Us);
  const theta = -Math.PI / 2 - Math.atan2(ay, ax);   // rotate North to (0,−1) = up
  return { c: Math.cos(theta), s: Math.sin(theta) };
}

/** Rotate a screen offset (ox,oy) by a {c,s} rotation (identity when null). */
function rotOff(rot, ox, oy) {
  return rot ? { x: rot.c * ox - rot.s * oy, y: rot.s * ox + rot.c * oy } : { x: ox, y: oy };
}

function fovBoxSvg(cx, cy, w, h, m, rot) {
  if (!m) {
    return `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" `
      + `width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" `
      + `stroke="${COLOURS.fovStroke}" stroke-width="1.2" stroke-dasharray="6 4" rx="2"/>`;
  }
  // Mᵀ maps a sensor-frame coord back to the sky frame; then the north-up screen
  // rotation (if any) is applied so the box sits correctly in the N-up view.
  const inv = (sx, sy) => {
    const o = rotOff(rot, m.a * sx + m.b * sy, m.c * sx + m.d * sy);
    return { x: cx + o.x, y: cy + o.y };
  };
  const hw = w / 2; const hh = h / 2;
  const poly = [inv(-hw, -hh), inv(hw, -hh), inv(hw, hh), inv(-hw, hh)]
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const dw = m.cardinals.W;                           // drift/West direction in the sensor
  const wEdge = inv(dw[0] * hw, dw[1] * hh);           // West-edge midpoint (blue dot)
  // R / T labels at the RIGHT and TOP edge MIDPOINTS (not corners) of the image,
  // pushed just outside — so the orientation incl. the mirror is unambiguous.
  const rEdge = inv(hw * 1.18, 0);
  const tEdge = inv(0, -hh * 1.28);
  return `<polygon points="${poly}" fill="none" stroke="${COLOURS.fovStroke}" stroke-width="1.2" stroke-dasharray="6 4"/>`
    + `<circle cx="${wEdge.x.toFixed(1)}" cy="${wEdge.y.toFixed(1)}" r="1.8" fill="#7fd0ff"/>`
    + txt(wEdge.x + 4, wEdge.y + 3, 'W', { fill: '#7fd0ff', size: 9 })
    + txt(rEdge.x, rEdge.y + 3, 'R', { fill: COLOURS.label, size: 9, anchor: 'middle' })
    + txt(tEdge.x, tEdge.y + 3, 'T', { fill: COLOURS.label, size: 9, anchor: 'middle' });
}

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
 * @property {string|null} [origin]      - departure IATA/ICAO, if routed
 * @property {string|null} [destination] - arrival IATA/ICAO, if routed
 * @property {string|null} icao
 * @property {string|null} typeCode      - ICAO type designator, if resolvable
 * @property {boolean} [isISS]           - draw the station glyph, not a plane
 * @property {number|null} wingspanM     - real wingspan when the type is known
 * @property {number|null} lengthM       - real length when the type is known
 * @property {number} [nowMs]            - live time → drives the "now" marker
 *                                         + the ETA in the header
 * @property {number} [obsLat]           - observer latitude °, for the
 *                                         parallactic celestial N/E rose
 * @property {Array<{tOffsetMs: number, aircraftAz: number, aircraftEl: number, bodyAz: number, bodyEl: number}>} transitPath
 */

/**
 * Resolve the per-airframe silhouette dimensions from an ADS-B `typeCode`.
 * Returns nulls (→ generic fallback) when the type is unknown or absent.
 * @param {string|null|undefined} typeCode
 */
function dimsFromType(typeCode) {
  const spec = resolveAircraftType(typeCode);
  return {
    typeCode: typeCode ?? null,
    wingspanM: spec?.wingspanM ?? null,
    lengthM: spec?.lengthM ?? null,
  };
}

/**
 * Normalise a lifecycle entry (live tracking) into SketchInput.
 * @param {object} entry
 * @returns {SketchInput|null}
 */
export function fromLifecycleEntry(entry) {
  const c = entry?.candidate;
  if (!c?.aircraftAtClosest || !c?.bodyAtClosest) return null;
  const route = entry.route ?? c?.route ?? null;
  // v0.30.19: surface the FROZEN first-emission geometry alongside the
  // current one so buildSketchSvg can paint a grey "where we initially
  // thought it would go" overlay under the white current path. The
  // overlay is rendered only when the initial geometry differs
  // meaningfully from the current — see buildSketchSvg.
  const ic = entry.initialCandidate;
  const initialAircraftAt = ic?.aircraftAtClosest && ic !== c ? {
    az: ic.aircraftAtClosest.azimuthDeg,
    el: ic.aircraftAtClosest.elevationDeg,
    rangeM: ic.aircraftAtClosest.rangeM ?? null,
  } : null;
  const initialBodyAt = ic?.bodyAtClosest && ic !== c ? {
    az: ic.bodyAtClosest.azimuthDeg,
    el: ic.bodyAtClosest.elevationDeg,
  } : null;
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
    origin: route?.origin?.iata ?? route?.origin?.icao ?? null,
    destination: route?.destination?.iata ?? route?.destination?.icao ?? null,
    icao: entry.icao ?? null,
    isISS: c.isISS === true || c.aircraft?.typeCode === 'ISS',
    ...dimsFromType(c.aircraft?.typeCode),
    transitPath: Array.isArray(c.transitPath) ? c.transitPath : [],
    initialAircraftAt,
    initialBodyAt,
    initialSepDeg: Number.isFinite(ic?.closestApproachSepDeg) && ic !== c
      ? ic.closestApproachSepDeg : null,
    initialTransitPath: ic && ic !== c && Array.isArray(ic.transitPath)
      ? ic.transitPath : [],
    // v0.30.21: per-tick prediction history for the FOV mini-chart
    // overlay (lead-time on X, predicted sep on Y, segment colour by
    // confidence bucket).
    predictionHistory: Array.isArray(entry.predictionHistory)
      ? entry.predictionHistory : [],
  };
}

/**
 * Normalise a "Total live trackings" row into SketchInput (v0.45.1). These rows
 * carry only the aircraft's CURRENT az/el/range + the nearest body — no closest-
 * approach prediction and no path. So the sketch shows where the plane sits
 * relative to the disc *right now* (the dynamic zoom keeps a wide offset on
 * canvas). `bodyAzEl` is the body's current {az, el} from state.bodies.
 * @param {object} row
 * @param {{az:number, el:number}|null} bodyAzEl
 * @returns {SketchInput|null}
 */
export function fromTotalLiveRow(row, bodyAzEl) {
  if (!row || !bodyAzEl
      || !Number.isFinite(row.azimuthDeg) || !Number.isFinite(row.elevationDeg)
      || !Number.isFinite(bodyAzEl.az) || !Number.isFinite(bodyAzEl.el)) return null;
  return {
    body: row.body,
    bodyAt: { az: bodyAzEl.az, el: bodyAzEl.el },
    aircraftAt: { az: row.azimuthDeg, el: row.elevationDeg, rangeM: row.rangeM ?? null },
    sepDeg: row.sepDeg ?? null,
    trackDeg: row.trackDeg ?? null,
    groundSpeedMs: row.groundSpeedMs ?? null,
    altMmsl: row.altMmsl ?? null,
    closestAtMs: null,            // no prediction — current snapshot only
    flight: row.callsign ?? null,
    icao: row.icao ?? null,
    isISS: false,
    transitPath: [],              // no trajectory; the glyph sits at the current offset
  };
}

/**
 * Normalise a future satellite (ISS/HST/CSS) transit Sky-plan row into
 * SketchInput (v0.45.3). The server surfaces a compact `geom` (bodyAt,
 * aircraftAt, transitPath) on the next-transit summary so an upcoming pass can
 * be previewed in the FOV before it is imminent.
 * @param {{body:string, sepDeg:number|null, atMs:number|null, satTag:string,
 *   geom:{bodyAt:object, aircraftAt:object, transitPath:Array}|null}} row
 * @returns {SketchInput|null}
 */
export function fromSatTransit(row) {
  const g = row?.geom;
  if (!g?.bodyAt || !g?.aircraftAt
      || !Number.isFinite(g.bodyAt.az) || !Number.isFinite(g.aircraftAt.az)) return null;
  return {
    body: row.body,
    bodyAt: g.bodyAt,
    aircraftAt: g.aircraftAt,
    sepDeg: row.sepDeg ?? null,
    trackDeg: null, groundSpeedMs: null, altMmsl: null,
    closestAtMs: row.atMs ?? null,
    flight: row.satTag ?? 'ISS',
    icao: row.satTag ?? 'ISS',
    isISS: true,                  // draws the satellite glyph, not an airliner
    transitPath: Array.isArray(g.transitPath) ? g.transitPath : [],
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
  const route = c?.route ?? null;
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
    origin: row.origin ?? route?.origin?.iata ?? route?.origin?.icao ?? null,
    destination: row.destination ?? route?.destination?.iata ?? route?.destination?.icao ?? null,
    icao: row.icao ?? null,
    isISS: c.isISS === true || c.aircraft?.typeCode === 'ISS' || row.icao === 'ISS',
    ...dimsFromType(c.aircraft?.typeCode),
    transitPath: Array.isArray(c.transitPath) ? c.transitPath : [],
  };
}

// ---- SVG building ------------------------------------------------------------
const SVG_W = 420;
// Two-line footer (R/Alt/v on top, FOV/focal/sensor below) needs ~14 px more
// height than the single-line version that used to overlap on narrower
// configs. Bump SVG_H accordingly; innerH (the FOV box) is unchanged because
// FOOTER_H grows by the same amount.
const SVG_H = 304;
const PAD = 14;
const HEADER_H = 18;
const FOOTER_H = 30;
const FOOTER_LINE_H = 14;

// One shared annotation size for the whole right-hand column — every label
// in the FOV sketch and the plan-view mini-map uses LABEL_SIZE, so nothing
// reads bigger or smaller than its neighbour (the FOV sketch title is the
// single deliberate exception at TITLE_SIZE). The AirNav box CSS
// (.fov-aux & descendants) is aligned to the same 11 px.
const LABEL_SIZE = 11;
const TITLE_SIZE = 13;

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
// ISS glyph: a central core along +x with a cross-truss along ±y carrying
// two solar-array panels. Returned as an SVG fragment (caller transforms it).
// Drawn at the origin like aircraftPath; sized to be visible even when the
// true angular size is sub-pixel.
function issGlyph(coreLen, span) {
  const L = Math.max(coreLen, 7);
  const W = Math.max(span, 14);
  const half = W / 2;
  const c = COLOURS.ac;
  const s = COLOURS.acStroke;
  const panel = '#5a8fb0';
  const panelW = W * 0.42;
  const panelH = L * 0.5;
  return (
    // core module
    `<rect x="${-L / 2}" y="${-L * 0.16}" width="${L}" height="${L * 0.32}" rx="${L * 0.12}" fill="${c}" stroke="${s}" stroke-width="0.5"/>` +
    // truss
    `<line x1="0" y1="${-half}" x2="0" y2="${half}" stroke="${s}" stroke-width="1"/>` +
    // two solar arrays
    `<rect x="${-panelH / 2}" y="${-half}" width="${panelH}" height="${panelW}" fill="${panel}" stroke="${s}" stroke-width="0.5"/>` +
    `<rect x="${-panelH / 2}" y="${half - panelW}" width="${panelH}" height="${panelW}" fill="${panel}" stroke="${s}" stroke-width="0.5"/>`
  );
}

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

// Origin/destination come from a free external lookup (adsbdb / AirNav), so
// they are clamped to a strict airport charset before being placed into the
// SVG markup — txt() does not escape. Used only for the transit-view header
// route ("ORIG→DEST"); the plan/side views no longer repeat it.
function safeIata(s) {
  return typeof s === 'string'
    ? s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
    : '';
}
// Nearest 8-point compass label for a bearing in degrees (from North).
const COMPASS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function compass8(deg) {
  return COMPASS8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
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
/**
 * Small "prediction drift over time" overlay drawn in the top-right
 * corner of the FOV widget. Reads `d.predictionHistory` (per-tick
 * snapshots of the projected closest-approach sep + leadTime). Each
 * line segment is coloured by its midpoint's lead time on a green ->
 * yellow -> red gradient (low lead = high confidence = green; high
 * lead = low confidence = red). Empty when the history has fewer than
 * two valid samples. v0.30.21.
 */
function buildPredictionChart(d, wX, wY, wW, wH) {
  const hist = (d.predictionHistory ?? [])
    .filter((p) => Number.isFinite(p.leadMs) && Number.isFinite(p.sepDeg));
  if (hist.length < 2) return '';

  const CW = 132;
  const CH = 56;
  const cX = wX + wW - CW - 4;          // top-right of widget rect
  const cY = wY + 4;
  const PAD_IN_L = 16;                  // y-axis label gutter
  const PAD_IN_R = 4;
  const PAD_IN_T = 12;                  // title row
  const PAD_IN_B = 11;                  // x-axis tick row
  const plotX = cX + PAD_IN_L;
  const plotY = cY + PAD_IN_T;
  const plotW = CW - PAD_IN_L - PAD_IN_R;
  const plotH = CH - PAD_IN_T - PAD_IN_B;

  // Domain
  const leads = hist.map((p) => p.leadMs);
  const seps = hist.map((p) => p.sepDeg);
  const leadMin = Math.min(...leads);
  const leadMax = Math.max(...leads);
  const sepMin = Math.min(...seps);
  const sepMax = Math.max(...seps);
  const leadRange = Math.max(1, leadMax - leadMin);
  const sepPad = Math.max(0.02, (sepMax - sepMin) * 0.15);
  const sepLo = Math.max(0, sepMin - sepPad);
  const sepHi = sepMax + sepPad;
  const sepRange = Math.max(0.01, sepHi - sepLo);

  // Higher lead = lower confidence = further left on the chart (older
  // prediction); lead approaching 0 = ETA imminent = right edge.
  const xOf = (lead) => plotX + plotW * (1 - (lead - leadMin) / leadRange);
  // Lower sep = better = bottom of chart; higher sep = drift = top.
  const yOf = (sep) => plotY + plotH * (1 - (sep - sepLo) / sepRange);

  // v0.30.23 — colour the line by the SEP value itself, not by lead time.
  // The intuitive read: when the line dips toward the disc-radius region,
  // it ALSO turns green. Lead-time was the original design but every
  // segment in a 4-minute lead window came out red regardless of how
  // much the prediction had tightened, which hid the very signal the
  // chart was supposed to surface.
  //
  // Anchors:
  //   sep <= 0.1°  -> 120 (green) -- well within Sun/Moon disc
  //   sep = ~0.5°  -> 60  (yellow) -- near-miss band edge
  //   sep >= 2°    -> 0   (red)   -- out of the panel band
  // Log scale across [0.05°, 2°] so the 0.1-0.5° range is properly
  // discriminated (most of the interesting drift sits there).
  const LOG_LO = Math.log10(0.1);
  const LOG_HI = Math.log10(2.0);
  const hueForSep = (sepDeg) => {
    const s = Math.max(0.05, sepDeg);
    const t = Math.max(0, Math.min(1, (Math.log10(s) - LOG_LO) / (LOG_HI - LOG_LO)));
    return (120 * (1 - t)).toFixed(0);
  };
  const stroke = (sepDeg) => `hsl(${hueForSep(sepDeg)}, 70%, 55%)`;

  let svg = '';
  // Backing card so the chart reads against busy FOV content underneath.
  svg += `<rect x="${cX}" y="${cY}" width="${CW}" height="${CH}" `
       + `fill="rgba(14,16,22,0.88)" stroke="#3a3f4a" stroke-width="0.5" rx="3"/>`;
  // Title + axis labels
  svg += txt(cX + 6, cY + 9, 'sep ° over time', { fill: '#9aa0a6', size: 7 });
  svg += txt(cX + CW - 4, cY + 9, sepRange < 9 ? seps[seps.length - 1].toFixed(2) + '°' : '—', {
    fill: stroke(seps[seps.length - 1]), size: 8, anchor: 'end', weight: 600,
  });
  // x-axis tick labels: leftmost = oldest lead, rightmost = current
  svg += txt(plotX, cY + CH - 2,
    '-' + Math.round(leadMax / 1000) + 's',
    { fill: '#6a6f76', size: 7 });
  svg += txt(plotX + plotW, cY + CH - 2,
    leadMin <= 0 ? 'past ETA' : '-' + Math.round(leadMin / 1000) + 's',
    { fill: '#6a6f76', size: 7, anchor: 'end' });
  // y-axis bounds
  svg += txt(cX + 4, plotY + 4, sepHi.toFixed(2),
    { fill: '#6a6f76', size: 6.5 });
  svg += txt(cX + 4, plotY + plotH,
    sepLo.toFixed(2),
    { fill: '#6a6f76', size: 6.5 });

  // Coloured line segments — one per pair of consecutive samples. The
  // segment's hue is derived from the AVERAGE sep across its endpoints,
  // so the line literally turns red-orange-yellow-green as the predicted
  // sep tightens toward the disc.
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1];
    const b = hist[i];
    const midSep = (a.sepDeg + b.sepDeg) / 2;
    svg += `<line x1="${xOf(a.leadMs).toFixed(1)}" y1="${yOf(a.sepDeg).toFixed(1)}" `
         + `x2="${xOf(b.leadMs).toFixed(1)}" y2="${yOf(b.sepDeg).toFixed(1)}" `
         + `stroke="${stroke(midSep)}" stroke-width="1.4"/>`;
  }
  // Highlight the latest sample with a small dot.
  const last = hist[hist.length - 1];
  svg += `<circle cx="${xOf(last.leadMs).toFixed(1)}" cy="${yOf(last.sepDeg).toFixed(1)}" `
       + `r="2" fill="${stroke(last.sepDeg)}"/>`;
  return svg;
}


export function buildSketchSvg(d) {
  // FOV pixel rectangle, padded to leave room for top header and bottom
  // legend. Aspect ratio is locked to the sensor's, not the SVG canvas.
  // FOV is recomputed per call so a setOptics() in between two opens of the
  // popup reflects the new rig without page reload.
  const fovWDeg = fovDeg(OPTICS.TELESCOPE_FOCAL_MM, OPTICS.SENSOR_W_MM);
  const fovHDeg = fovDeg(OPTICS.TELESCOPE_FOCAL_MM, OPTICS.SENSOR_H_MM);
  const refEl = d.bodyAt.el;
  const innerW = SVG_W - 2 * PAD;
  const innerH = SVG_H - HEADER_H - FOOTER_H - 2 * PAD;

  // Body disc — sized first because the widget scale is built around it.
  const bodyDiameterDeg = BODY_DIAMETER_DEG[d.body] ?? 0.53;
  const bodyFill = d.body === 'Sun' ? COLOURS.Sun : COLOURS.Moon;
  const bodyRim  = d.body === 'Sun' ? COLOURS.SunRim : COLOURS.MoonRim;

  // Scale (v0.20.0): disc-centred, not FOV-centred. The Sun/Moon must ALWAYS
  // be fully visible in the widget, with enough surrounding room to also
  // show aircraft that pass close by the disc (≈ near-miss range). We fix
  // the disc to roughly half the widget's smaller dimension and derive
  // pxPerDeg from there — the sensor FOV rectangle and the aircraft are
  // then drawn at the SAME pxPerDeg, so their proportions relative to the
  // disc are physically accurate. At long focal lengths the FOV box ends
  // up smaller than the disc (a dashed rectangle inside it = "this strip
  // of the Sun lands on the sensor"); at short focal lengths the FOV box
  // is bigger than the disc and may extend beyond the widget edge (the
  // footer carries the exact angular dims so the truth is never lost).
  // 0.5 of min(innerW, innerH) → disc occupies ≈ half the widget height,
  // leaves room either side for aircraft at sep up to ≈ half the widget
  // half-width in degrees before they fall off the canvas.
  const widgetMinSide = Math.min(innerW, innerH);
  const discScale = (widgetMinSide * 0.5) / bodyDiameterDeg;
  // Dynamic zoom-to-fit (v0.45.0): for a wide pass the aircraft sits far from
  // the disc, so scale DOWN until that separation fits inside the widget — the
  // disc, the sensor box and the aircraft all shrink together, keeping their
  // true relative proportions (a 3° pass → small disc + small box + the plane
  // still visible at a sensible distance). `showDeg` is the offset we must keep
  // on-canvas: the closest-approach separation (≈ the plane's distance to the
  // disc centre), floored at the disc itself. Never zoom IN past the disc-
  // centred scale, and keep the disc ≥ a few px so it never vanishes.
  const showDeg = Math.max(Number.isFinite(d.sepDeg) ? d.sepDeg : 0, bodyDiameterDeg * 0.75);
  const fitScale = (widgetMinSide * 0.42) / showDeg;
  const minScale = 6 / (bodyDiameterDeg / 2);            // disc radius ≥ 6 px
  const pxPerDeg = Math.max(minScale, Math.min(discScale, fitScale));

  // Disc sits at the widget centre; FOV rectangle is centred on the disc.
  const cx = SVG_W / 2;
  const cy = HEADER_H + PAD + innerH / 2;
  const bodyR = (bodyDiameterDeg / 2) * pxPerDeg;
  const fovPxW = fovWDeg * pxPerDeg;
  const fovPxH = fovHDeg * pxPerDeg;
  const fovX = cx - fovPxW / 2;
  const fovY = cy - fovPxH / 2;

  // North-up frame (v0.45.2): rotate every plotted offset so celestial North is
  // up and West is right — the intuitive solar/astro convention — instead of the
  // raw alt-az frame. The angle is the parallactic angle (follows the body over
  // the day). Needs the observer latitude; without it we keep the alt-az frame.
  const northRot = northUpScreenRot(d.bodyAt?.az, d.bodyAt?.el, d.obsLat);
  // Project a (dAz·cosEl, dEl) degree offset to a screen point, with the N-up
  // rotation applied. Replaces the bare degToPx for all sky content.
  const project = (dxDeg, dyDeg) => {
    const o = rotOff(northRot, dxDeg * pxPerDeg, -dyDeg * pxPerDeg);
    return { x: cx + o.x, y: cy + o.y };
  };

  // Widget viewing-area bounds (the visible sketch rectangle). Crosshair,
  // axis labels and horizon compass are anchored to THIS, not the FOV box —
  // the FOV box has become a free-floating dashed overlay whose size varies
  // with focal length and isn't a useful reference frame any more.
  const widgetX = PAD;
  const widgetY = HEADER_H + PAD;
  const widgetW = innerW;
  const widgetH = innerH;

  // Transit path: project each sample into relative-FOV coords. Body motion
  // is subtracted per-sample, so the line shows the path as it appears in a
  // tracking-mount eyepiece where the disc stays centred. Each point carries
  // its angular offset (degOff) so we can drop the wild-distance samples
  // that older recordings produced — see the visibility filter below.
  const pathPts = (d.transitPath ?? []).map(p => {
    const { dx, dy } = relOffsetDeg(p, refEl);
    return {
      ...project(dx, dy),
      tOffsetMs: p.tOffsetMs,
      degOff: Math.hypot(dx, dy),
    };
  });

  // Pre-v0.7.6 recordings sampled at ±60 s with only 5 points. At typical
  // airliner angular speeds the outer samples sat 30°+ off-FOV with the
  // elevation already dropping as range grew; connecting them through t=0
  // drew a misleading V-line straight through the disc. Drop samples whose
  // angular offset from the body exceeds 2× the FOV diagonal — for new
  // recordings (dense ±5 s) this drops only the farthest tail samples, for
  // old recordings it leaves at most the t=0 sample (which is by definition
  // at sep < 1°) so no misleading polyline is drawn at all.
  // Keep path samples that fall inside the actually-drawn area (half its
  // diagonal, in degrees, at the current scale). Scale-correct for both
  // the normal optical view AND the zoomed-out view, and still drops the
  // wild ±60 s tails of pre-v0.7.6 recordings.
  const viewMaxDeg = Math.hypot(innerW, innerH) / pxPerDeg / 2;
  const visiblePathPts = pathPts.filter(p => p.degOff <= viewMaxDeg);

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
    anchor = project(dx, dy);
  }

  // Apparent heading angle from the visible-portion samples (end - start).
  // Restricting to visiblePathPts means the silhouette orientation reflects
  // the local direction of travel near the disc — much more accurate than
  // taking the wide-spread t=±60 s endpoints from older recordings.
  let headingRad = 0;
  if (visiblePathPts.length >= 2) {
    const a = visiblePathPts[0];
    const b = visiblePathPts[visiblePathPts.length - 1];
    headingRad = Math.atan2(b.y - a.y, b.x - a.x);
  }

  // Aircraft silhouette size from line-of-sight distance. Use the resolved
  // type's real dimensions when available, otherwise the generic envelope.
  const wsM  = Number.isFinite(d.wingspanM) ? d.wingspanM : AC_WINGSPAN_M;
  const lenM = Number.isFinite(d.lengthM)   ? d.lengthM   : AC_LENGTH_M;
  const wingspanDeg = aircraftAngularDeg(wsM,  d.aircraftAt.rangeM);
  const lengthDeg   = aircraftAngularDeg(lenM, d.aircraftAt.rangeM);
  // Enforce a small visual minimum (3 px) so a very distant aircraft is
  // still discernible — purely a UI affordance, the labels carry the truth.
  const wingPx = Math.max(wingspanDeg * pxPerDeg, 3);
  const lenPx  = Math.max(lengthDeg   * pxPerDeg, 3);

  // ---- Compose SVG ----------------------------------------------------------
  const acTag = d.typeCode ? ` · ${d.typeCode}` : '';
  const orig = safeIata(d.origin);
  const dest = safeIata(d.destination);
  const legStr = orig && dest ? `${orig}→${dest}` : '';

  // ETA in minutes + the closest-approach wall-clock. Soft red so it is
  // noticeable but unobtrusive (user request). Falls back to just the
  // clock when there is no live time (old callers / tests, back-compat).
  const clock = fmtTime(d.closestAtMs);
  let etaClock = clock;
  if (Number.isFinite(d.nowMs) && Number.isFinite(d.closestAtMs)) {
    const dMs = d.closestAtMs - d.nowMs;
    const mins = Math.round(dMs / 60_000);
    const eta = Math.abs(dMs) < 45_000 ? 'now'
      : mins > 0 ? `in ${mins} min`
        : `${-mins} min ago`;
    etaClock = `${eta} · ${clock}`;
  }

  // Two-row header so the (variable-length) title and the route/ETA never
  // collide — they used to overlap mid-line when both got long (title was
  // start-anchored, the right block end-anchored from the opposite edge).
  //   Row 1: "<body> transit · <flight> · <type>"   |  "Sep X′"
  //   Row 2: "<ORIG→DEST> · <ETA · clock>" (route muted, ETA/clock soft red)
  // Row 2 is a single start-anchored line, so it can be any length without
  // colliding with anything.
  const sub = (legStr ? `${legStr} · ` : '')
    + `<tspan fill="#ff8f8f">${etaClock}</tspan>`;
  const header =
    `${txt(PAD, HEADER_H, `${d.body} transit · ${d.flight ?? '—'}${acTag}`, { fill: '#e6edf3', size: TITLE_SIZE, weight: 600 })}` +
    `${txt(SVG_W - PAD, HEADER_H, `Sep ${fmtSepArcmin(d.sepDeg)}`, { fill: '#e6edf3', size: LABEL_SIZE, anchor: 'end' })}` +
    `${txt(PAD, HEADER_H + 13, sub, { fill: COLOURS.label, size: LABEL_SIZE, anchor: 'start' })}`;

  // Widget background (v0.20.0): the dark backdrop is no longer the FOV
  // box, it's the whole viewing area. The FOV rectangle has become a
  // dashed overlay that floats inside (or partly outside) this backdrop
  // depending on focal length. Without this dedicated background the disc
  // would sit on the page colour wherever the FOV overlay doesn't reach.
  const widgetBg =
    `<rect x="${widgetX}" y="${widgetY}" width="${widgetW}" height="${widgetH}" ` +
    `fill="${COLOURS.fovFill}" stroke="${COLOURS.fovStroke}" stroke-width="1" rx="2"/>`;

  // Sensor FOV rectangle: dashed outline, no fill — sits ON TOP of the disc so
  // the user sees which slice of the Sun/Moon their sensor will capture. When a
  // camera orientation is configured (drift-test calibration) the box is drawn
  // ROTATED + a small 'W' tick marking the drift (West) edge, so it matches how
  // the sensor actually sits on the sky — no separate view / toggle needed. The
  // rotation is parallactic-correct and follows the Sun over the day (EQ mount).
  const sensorM = computeSensorMatrix({
    azDeg: d.bodyAt?.az, elDeg: d.bodyAt?.el, latDeg: d.obsLat,
    driftWest: OPTICS.DRIFT_WEST, mirror: OPTICS.MIRROR,
  });
  const fovRect = fovBoxSvg(cx, cy, fovPxW, fovPxH, sensorM, northRot);

  // Axis crosshair through the body centre — subtle, helps eye lock to the
  // disc when the aircraft passes off-centre. Spans the whole widget now
  // (was spanning the FOV box; at long focal lengths the FOV is too small
  // for the crosshair to be a useful reference).
  const cross =
    `<line x1="${widgetX}" y1="${cy}" x2="${widgetX + widgetW}" y2="${cy}" stroke="${COLOURS.axis}" stroke-width="0.5" stroke-dasharray="2 4"/>` +
    `<line x1="${cx}" y1="${widgetY}" x2="${cx}" y2="${widgetY + widgetH}" stroke="${COLOURS.axis}" stroke-width="0.5" stroke-dasharray="2 4"/>`;

  // Body disc (v0.20.0): always fully visible, full solid gradient fill —
  // the disc is the primary reference object. The FOV-clipping that v0.19
  // applied here is gone; "what the sensor captures" is now shown by the
  // dashed FOV rectangle layered on top of the disc, not by hiding the
  // off-sensor part of the disc.
  const bodyDisc =
    `<defs><radialGradient id="bodyGrad" cx="35%" cy="35%" r="65%">` +
    `<stop offset="0%" stop-color="${bodyRim}" stop-opacity="0.95"/>` +
    `<stop offset="100%" stop-color="${bodyFill}" stop-opacity="1"/>` +
    `</radialGradient></defs>` +
    `<circle cx="${cx}" cy="${cy}" r="${bodyR}" fill="url(#bodyGrad)" ` +
    `stroke="${bodyRim}" stroke-width="0.5"/>`;

  // Motion line + tick marks at each sample, arrowhead at the latest one.
  // Uses visiblePathPts so the polyline never connects through wild-distance
  // tails of older recordings — see the visibility filter above.
  let pathSvg = '';
  if (visiblePathPts.length >= 2) {
    const poly = visiblePathPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    pathSvg += `<polyline points="${poly}" fill="none" stroke="${COLOURS.pathStroke}" stroke-width="1.2" stroke-opacity="0.85" stroke-dasharray="6 3"/>`;
    for (const p of visiblePathPts) {
      const isAnchor = p.tOffsetMs === 0;
      pathSvg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isAnchor ? 2.2 : 1.4}" fill="${COLOURS.pathStroke}" />`;
    }
    // Arrowhead in direction of motion at the last visible point.
    const last = visiblePathPts[visiblePathPts.length - 1];
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

  // Silhouette: an aircraft outline, or — for the ISS — a small station
  // glyph (core module + two solar-array wings) so it never reads as a
  // plane. Both are translated to the anchor and rotated to the apparent
  // direction of travel.
  // Far/illegible → a clear ✕ marker (diagonal, so it never reads as the
  // horizontal/vertical centre crosshair) at the aircraft's position; otherwise
  // the true-shape silhouette / ISS glyph, rotated to the heading.
  const farMarker = (Number.isFinite(d.sepDeg) && d.sepDeg > FAR_MARKER_SEP_DEG)
    || Math.max(wingPx, lenPx) < 6;
  let acGroup;
  if (farMarker) {
    const a = 6;
    acGroup =
      `<g transform="translate(${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)})">`
      + `<line x1="${-a}" y1="${-a}" x2="${a}" y2="${a}" stroke="${COLOURS.ac}" stroke-width="1.5"/>`
      + `<line x1="${-a}" y1="${a}" x2="${a}" y2="${-a}" stroke="${COLOURS.ac}" stroke-width="1.5"/>`
      + `</g>`;
  } else {
    const glyph = d.isISS
      ? issGlyph(Math.max(lenPx, 7), Math.max(wingPx, 14))
      : `<path d="${aircraftPath(lenPx, wingPx)}" fill="${COLOURS.ac}" stroke="${COLOURS.acStroke}" stroke-width="0.5"/>`;
    acGroup =
      `<g transform="translate(${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)}) rotate(${(headingRad * RAD).toFixed(1)})">` +
      glyph +
      `</g>`;
  }

  // v0.30.19 — "initial guess" overlay. When the lifecycle entry has
  // carried forward a frozen first-emission geometry that's measurably
  // different from the current one, paint that geometry under the white
  // current silhouette in grey + dotted line so the user can see at a
  // glance how much the prediction has drifted between first contact and
  // now. Same path/anchor/heading math as above, just for the initial
  // values; only rendered when the two anchors are far enough apart to
  // actually be distinguishable (< ~half a silhouette length and they
  // just look like noise).
  let initialPathSvg = '';
  let initialGlyphSvg = '';
  if (d.initialAircraftAt && d.initialBodyAt) {
    const initialPathPts = (d.initialTransitPath ?? []).map(p => {
      const { dx, dy } = relOffsetDeg(p, refEl);
      return {
        ...project(dx, dy),
        tOffsetMs: p.tOffsetMs,
        degOff: Math.hypot(dx, dy),
      };
    });
    const initialVisible = initialPathPts.filter(p => p.degOff <= viewMaxDeg);
    let initialAnchor;
    const initialMid = initialPathPts.find(p => p.tOffsetMs === 0);
    if (initialMid) {
      initialAnchor = { x: initialMid.x, y: initialMid.y };
    } else {
      const dxi = (d.initialAircraftAt.az - d.initialBodyAt.az) * Math.cos(refEl * DEG);
      const dyi = d.initialAircraftAt.el - d.initialBodyAt.el;
      initialAnchor = project(dxi, dyi);
    }
    const overlayDistPx = Math.hypot(initialAnchor.x - anchor.x, initialAnchor.y - anchor.y);
    const OVERLAY_MIN_PX = 6;     // half a silhouette length-ish; below this it just clutters
    if (overlayDistPx >= OVERLAY_MIN_PX) {
      let initialHeadingRad = headingRad;
      if (initialVisible.length >= 2) {
        const a = initialVisible[0];
        const b = initialVisible[initialVisible.length - 1];
        initialHeadingRad = Math.atan2(b.y - a.y, b.x - a.x);
      }
      if (initialVisible.length >= 2) {
        const poly = initialVisible
          .map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        initialPathSvg = `<polyline points="${poly}" fill="none" stroke="#7a7d83" stroke-width="1" stroke-opacity="0.55" stroke-dasharray="3 4"/>`;
      }
      const initialGlyph = d.isISS
        ? issGlyph(Math.max(lenPx, 7), Math.max(wingPx, 14))
        : `<path d="${aircraftPath(lenPx, wingPx)}" fill="#7a7d83" stroke="#9aa0a6" stroke-width="0.4" opacity="0.6"/>`;
      initialGlyphSvg =
        `<g transform="translate(${initialAnchor.x.toFixed(1)} ${initialAnchor.y.toFixed(1)}) rotate(${(initialHeadingRad * RAD).toFixed(1)})">` +
        initialGlyph +
        `</g>`;
    }
  }

  // Axis labels (AZ on bottom, EL on left side). Helps users tell which
  // way the disc would drift on a fixed altaz mount. Anchored to the
  // widget edges as of v0.20.0 — the FOV box is no longer the reference
  // frame (it shrinks below a useful label-anchor size at long focal
  // lengths and may extend beyond the widget at short focal lengths).
  // ---- Compass overlays --------------------------------------------------
  // Default frame is now North-up / West-right (v0.45.2) — the intuitive
  // solar/astro convention. When the observer latitude is known the whole
  // content is rotated to it (see `project`), so the compass is FIXED: N top,
  // S bottom, W right, E left, with a dashed 'Z' tick toward the zenith (the
  // alt-az "up", now tilted) so the horizon relationship isn't lost. Without a
  // latitude (old callers / tests) we fall back to the raw alt-az frame: the
  // EL/AZ axis labels + the azimuth-derived horizon compass.
  const Ab = d.bodyAt?.az;
  const rose = '#7fd0ff';
  let axisLabels = '';
  let compass = '';
  if (northRot) {
    const lab = (s, x, y, col, anchor = 'middle') => txt(x, y, s, { fill: col, size: LABEL_SIZE, anchor });
    compass +=
      lab('N', cx, widgetY + 12, rose)
      + lab('S', cx, widgetY + widgetH - 4, COLOURS.label)
      + lab('W', widgetX + widgetW - 8, cy + 4, COLOURS.label)
      + lab('E', widgetX + 8, cy + 4, COLOURS.label);
    // Zenith direction (alt-az "up" = +1° elevation, rotated into the frame).
    const zo = rotOff(northRot, 0, -1);
    const zl = bodyR + 16;
    const zx = cx + zo.x * zl; const zy = cy + zo.y * zl;
    compass +=
      `<line x1="${cx}" y1="${cy}" x2="${zx.toFixed(1)}" y2="${zy.toFixed(1)}" stroke="${COLOURS.axis}" stroke-width="1" stroke-dasharray="2 2"/>`
      + txt(zx + 3, zy + 3, 'Z', { fill: COLOURS.axis, size: 9 });
  } else if (Number.isFinite(Ab)) {
    axisLabels =
      txt(widgetX + 4, widgetY + 12, 'EL ↑', { fill: COLOURS.label, size: LABEL_SIZE }) +
      txt(widgetX + widgetW - 4, widgetY + widgetH - 4, 'AZ →', { fill: COLOURS.label, size: LABEL_SIZE, anchor: 'end' });
    const edge = (bearing, x, y, anchor) =>
      txt(x, y, compass8(bearing), { fill: COLOURS.label, size: LABEL_SIZE, anchor });
    compass +=
      edge(Ab, cx, widgetY + widgetH - 4, 'middle')           // down → horizon
      + edge(Ab + 180, cx, widgetY + 11, 'middle')            // up   → anti-horizon
      + edge(Ab + 90, widgetX + widgetW - 4, cy + 4, 'end')   // right
      + edge(Ab - 90, widgetX + 4, cy + 4, 'start');          // left
  }

  // Two-line footer. Line 1 = live aircraft state (R/Alt/v), line 2 = the
  // optical rig (FOV/focal/sensor). Left-aligned on both rows so long
  // sensor names never collide with the range field — that was the overlap
  // bug visible in v0.7.4 on focal lengths beyond ~600 mm.
  const footYBot = SVG_H - PAD + 2;
  const footYTop = footYBot - FOOTER_LINE_H;
  const footTop = `R ${fmtRange(d.aircraftAt.rangeM)} · Alt ${fmtAlt(d.altMmsl)} · v ${fmtSpeed(d.groundSpeedMs)}`;
  // Auto zoom-out was removed in v0.19.0 — the FOV box is always rendered
  // at the true optical scale, so no "zoomed out" badge is needed here.
  const footBot =
    `FOV ${fovWDeg.toFixed(2)}° × ${fovHDeg.toFixed(2)}° · ${OPTICS.TELESCOPE_FOCAL_MM} mm · ${OPTICS.SENSOR_NAME}`;
  const footer =
    txt(PAD, footYTop, footTop, { fill: COLOURS.label, size: LABEL_SIZE }) +
    txt(PAD, footYBot, footBot, { fill: COLOURS.label, size: LABEL_SIZE });

  // Time-lapse "now" marker: where the aircraft sits on the predicted path
  // *at the current moment*, interpolated along the visible samples by
  // their tOffsetMs (0 = closest approach). Drawn only while the live time
  // is inside the depicted window — before it enters / after it leaves
  // there is no marker, so the static path + closest-approach silhouette
  // stand alone. The pulse keeps it feeling alive between the 2 s refreshes.
  let nowMarker = '';
  if (Number.isFinite(d.nowMs) && Number.isFinite(d.closestAtMs)
      && visiblePathPts.length >= 2) {
    const tNow = d.nowMs - d.closestAtMs;
    const first = visiblePathPts[0];
    const lastP = visiblePathPts[visiblePathPts.length - 1];
    const lo = Math.min(first.tOffsetMs, lastP.tOffsetMs);
    const hi = Math.max(first.tOffsetMs, lastP.tOffsetMs);
    if (tNow >= lo && tNow <= hi) {
      let mx = null;
      let my = null;
      for (let i = 1; i < visiblePathPts.length; i++) {
        const a = visiblePathPts[i - 1];
        const b = visiblePathPts[i];
        const t0 = Math.min(a.tOffsetMs, b.tOffsetMs);
        const t1 = Math.max(a.tOffsetMs, b.tOffsetMs);
        if (tNow >= t0 && tNow <= t1) {
          const span = b.tOffsetMs - a.tOffsetMs;
          const f = span === 0 ? 0 : (tNow - a.tOffsetMs) / span;
          mx = a.x + (b.x - a.x) * f;
          my = a.y + (b.y - a.y) * f;
          break;
        }
      }
      if (mx !== null) {
        nowMarker =
          `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="3.4" `
          + `fill="#ffba70" stroke="#1b1f24" stroke-width="0.5">`
          + `<animate attributeName="r" values="3.4;5.4;3.4" dur="1.4s" repeatCount="indefinite"/>`
          + `<animate attributeName="opacity" values="1;0.45;1" dur="1.4s" repeatCount="indefinite"/>`
          + `</circle>`
          + txt(mx + 6, my - 5, 'now', { fill: '#ffba70', size: LABEL_SIZE });
      }
    }
  }

  // Z-order (back → front):
  //   widget backdrop → crosshair → disc → dashed sensor FOV (on top of disc
  //   so it stays legible against the bright fill) → motion path → aircraft
  //   → "now" marker → axis & compass labels → footer.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" width="${SVG_W}" height="${SVG_H}">` +
    header +
    widgetBg +
    cross +
    bodyDisc +
    fovRect +
    initialPathSvg +
    initialGlyphSvg +
    pathSvg +
    acGroup +
    buildPredictionChart(d, widgetX, widgetY, widgetW, widgetH) +
    nowMarker +
    axisLabels +
    compass +
    footer +
    `</svg>`
  );
}

/**
 * Tiny offline plan-view map: observer at centre, aircraft at its real
 * lat/lon, the sight line between them, a heading tick and range rings.
 * Pure SVG from data we already have (dump1090 / recorded payload) — no
 * tiles, no network, no API key. Returns '' when geometry is missing.
 *
 * @param {{ obsLat:number, obsLon:number, acLat:number, acLon:number,
 *           trackDeg:number|null, rangeM:number|null, label:string }} m
 */
export function buildMiniMapSvg(m) {
  if (!m || ![m.obsLat, m.obsLon, m.acLat, m.acLon].every(Number.isFinite)) return '';
  const W = 260;
  const H = 150;
  const margin = 22;
  // Local equirectangular metres relative to the observer (north up).
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos(m.obsLat * DEG);
  const E = (m.acLon - m.obsLon) * mPerLon;
  const N = (m.acLat - m.obsLat) * mPerLat;
  const distM = Number.isFinite(m.rangeM) ? m.rangeM : Math.hypot(E, N);
  // Fit both points with headroom; floor so an overhead aircraft still maps.
  const R = Math.max(Math.hypot(E, N) * 1.25, 1500);
  const scale = (Math.min(W, H) / 2 - margin) / R;
  const cx = W / 2;
  const cy = H / 2;
  const sx = cx + E * scale;
  const sy = cy - N * scale;
  const bearing = (Math.atan2(E, N) * RAD + 360) % 360;

  // Range rings at R/2 and R, labelled in km.
  const ring = (rad) =>
    `<circle cx="${cx}" cy="${cy}" r="${(rad * scale).toFixed(1)}" fill="none" `
    + `stroke="${COLOURS.axis}" stroke-width="0.5" stroke-dasharray="2 4"/>`
    + txt(cx + 2, cy - rad * scale - 2, `${(rad / 1000).toFixed(0)} km`,
      { fill: COLOURS.label, size: LABEL_SIZE });

  // Heading vector from the aircraft in its track direction — doubled
  // length (24 px) and amber so it stands out from the blue sight line.
  let headSvg = '';
  if (Number.isFinite(m.trackDeg)) {
    const hx = sx + Math.sin(m.trackDeg * DEG) * 24;
    const hy = sy - Math.cos(m.trackDeg * DEG) * 24;
    headSvg = `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" `
      + `x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" stroke="#ffba70" stroke-width="2"/>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="${COLOURS.fovFill}" stroke="${COLOURS.fovStroke}" stroke-width="1" rx="3"/>`
    + ring(R) + ring(R / 2)
    // What this is: a top-down plan view (not the eyepiece). Rings = great-
    // circle distance from the observer; this is "where on the ground", the
    // FOV sketch above is "where in the eyepiece".
    + txt(6, 12, 'PLAN VIEW · rings = km from you', { fill: COLOURS.label, size: LABEL_SIZE })
    + txt(cx, 24, 'N ↑', { fill: COLOURS.label, size: LABEL_SIZE, anchor: 'middle' })
    // sight line observer → aircraft
    + `<line x1="${cx}" y1="${cy}" x2="${sx.toFixed(1)}" y2="${sy.toFixed(1)}" `
    + `stroke="${COLOURS.pathStroke}" stroke-width="1" stroke-dasharray="4 3" stroke-opacity="0.8"/>`
    + headSvg
    // observer marker
    + `<circle cx="${cx}" cy="${cy}" r="3" fill="${COLOURS.SunRim}"/>`
    + txt(cx + 6, cy + 11, 'you', { fill: COLOURS.label, size: LABEL_SIZE })
    // aircraft marker
    + `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="3.2" fill="${COLOURS.ac}" stroke="${COLOURS.acStroke}" stroke-width="0.5"/>`
    // Route/flight is shown once, in the transit-view header (not repeated
    // here or in the side view).
    + txt(W - 4, H - 6,
      `${m.label ?? ''} · ${(distM / 1000).toFixed(1)} km · brg ${bearing.toFixed(0)}°`,
      { fill: COLOURS.label, size: LABEL_SIZE, anchor: 'end' })
    + `</svg>`
  );
}

// Visibility band hues — kept in lockstep with web/app.js (VIS_AMBER_DEG /
// VIS_GREEN_DEG) and the .vis-* CSS so the side view, the row dot and the
// notify gate all tell the same story.
const SIDE_AMBER_DEG = 30;
const SIDE_GREEN_DEG = 45;
const SIDE_FLOOR_DEG = 20;            // physical "barely anything below this"
const VIS_RED = '#ff5d5d';
const VIS_AMBER = '#f0c83c';
const VIS_GREEN = '#5fd07f';
function sideBandColour(elDeg) {
  if (elDeg >= SIDE_GREEN_DEG) return VIS_GREEN;
  if (elDeg >= SIDE_AMBER_DEG) return VIS_AMBER;
  return VIS_RED;
}

/**
 * Vertical "side view" companion to the plan-view mini-map: the observer at
 * the origin, the aircraft at its real slant range + height, and the
 * line-of-sight wedge filled in the visibility colour for its elevation
 * band (red < 30°, amber 30–45°, green ≥ 45°). The 20/30/45° reference
 * rays are drawn in their band colours so the angle reads at a glance. The
 * x and y axes share one scale, so the drawn angle IS the true elevation.
 *
 * @param {{ elevationDeg:number, rangeM:number }} m
 */
export function buildSideViewSvg(m) {
  const el = m?.elevationDeg;
  const slant = m?.rangeM;
  if (!Number.isFinite(el) || el <= 0 || !Number.isFinite(slant) || slant <= 0) {
    return '';
  }
  const W = 260;
  const H = 150;
  const margin = 22;
  const ox = margin;                  // observer at bottom-left
  const oy = H - margin;
  const xmax = W - 6;
  const ymin = margin;

  const a = el * DEG;
  const ground = slant * Math.cos(a); // horizontal distance, metres
  const height = slant * Math.sin(a); // height above the observer plane, m
  // One isotropic scale for both axes → the drawn angle equals el exactly.
  const sX = ground > 0 ? (xmax - ox) / ground : Infinity;
  const sY = height > 0 ? (oy - ymin) / height : Infinity;
  let scale = Math.min(sX, sY);
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  const acX = ox + ground * scale;
  const acY = oy - height * scale;

  // Where a ray at `deg` elevation leaves the plot rectangle.
  const rayEnd = (deg) => {
    const r = deg * DEG;
    const dx = Math.cos(r);
    const dy = Math.sin(r);
    const tX = dx > 1e-6 ? (xmax - ox) / dx : Infinity;
    const tY = dy > 1e-6 ? (oy - ymin) / dy : Infinity;
    const t = Math.min(tX, tY);
    return { x: ox + dx * t, y: oy - dy * t };
  };
  const guide = (deg, col) => {
    const e = rayEnd(deg);
    return `<line x1="${ox}" y1="${oy}" x2="${e.x.toFixed(1)}" y2="${e.y.toFixed(1)}" `
      + `stroke="${col}" stroke-width="0.7" stroke-dasharray="2 3" stroke-opacity="0.65"/>`
      + txt(e.x - 1, e.y - 3, `${deg}°`, { fill: col, size: LABEL_SIZE, anchor: 'end' });
  };

  const band = sideBandColour(el);
  const altKm = (height / 1000).toFixed(height >= 1000 ? 0 : 1);
  const slantKm = (slant / 1000).toFixed(1);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="${COLOURS.fovFill}" stroke="${COLOURS.fovStroke}" stroke-width="1" rx="3"/>`
    // Elevation wedge: the triangle under the line of sight, filled in the
    // visibility colour for this elevation band → "how good is this" is
    // instantly obvious without reading the number.
    + `<polygon points="${ox},${oy} ${acX.toFixed(1)},${oy} ${acX.toFixed(1)},${acY.toFixed(1)}" `
    + `fill="${band}" fill-opacity="0.18"/>`
    // Reference rays at the floor / band edges, in their band colours.
    + guide(SIDE_FLOOR_DEG, VIS_RED)
    + guide(SIDE_AMBER_DEG, VIS_AMBER)
    + guide(SIDE_GREEN_DEG, VIS_GREEN)
    // Ground / horizon line.
    + `<line x1="${ox}" y1="${oy}" x2="${xmax}" y2="${oy}" stroke="${COLOURS.axis}" stroke-width="0.8"/>`
    + txt(6, 12, 'SIDE VIEW · elevation = visibility', { fill: COLOURS.label, size: LABEL_SIZE })
    // Line of sight observer → aircraft + a vertical drop to the ground.
    + `<line x1="${ox}" y1="${oy}" x2="${acX.toFixed(1)}" y2="${acY.toFixed(1)}" `
    + `stroke="${band}" stroke-width="1.6"/>`
    + `<line x1="${acX.toFixed(1)}" y1="${oy}" x2="${acX.toFixed(1)}" y2="${acY.toFixed(1)}" `
    + `stroke="${COLOURS.axis}" stroke-width="0.6" stroke-dasharray="2 2" stroke-opacity="0.7"/>`
    // Observer + aircraft markers.
    + `<circle cx="${ox}" cy="${oy}" r="3" fill="${COLOURS.SunRim}"/>`
    + txt(ox + 5, oy - 5, 'you', { fill: COLOURS.label, size: LABEL_SIZE })
    + `<circle cx="${acX.toFixed(1)}" cy="${acY.toFixed(1)}" r="3.2" fill="${COLOURS.ac}" stroke="${COLOURS.acStroke}" stroke-width="0.5"/>`
    + txt(W - 4, H - 6,
      `${el.toFixed(0)}° · ${slantKm} km · alt ${altKm} km`,
      { fill: band, size: LABEL_SIZE, anchor: 'end' })
    + `</svg>`
  );
}

// Live snapshot of the optical setup. Reflects setOptics() calls. Not frozen
// so tests / debug code can see the current values, but external code should
// treat it as read-only — use setOptics() to mutate. FOV_*_DEG remain as
// computed getters so old tests / consumers keep working.
Object.defineProperties(OPTICS, {
  FOV_W_DEG: { enumerable: true, get() { return fovDeg(OPTICS.TELESCOPE_FOCAL_MM, OPTICS.SENSOR_W_MM); } },
  FOV_H_DEG: { enumerable: true, get() { return fovDeg(OPTICS.TELESCOPE_FOCAL_MM, OPTICS.SENSOR_H_MM); } },
});
export const SKETCH_OPTICS = OPTICS;
export const SKETCH_GEOMETRY = Object.freeze({
  AC_WINGSPAN_M,
  AC_LENGTH_M,
  BODY_DIAMETER_DEG,
  fovDeg,
});
