// ISS transit prediction.
//
// The ISS is not an ADS-B contact — its state comes from a TLE propagated
// with the embedded SGP4 (src/sgp4.js), fully offline. A forward scan finds
// when the station's topocentric position skims the Sun or Moon disc for the
// fixed observer. Output is shaped exactly like a tracker candidate so the
// lifecycle, notifier, FOV sketch and History "Disc xing" column all reuse
// without special-casing — only an `isISS` flag is added so the UI can give
// the row its own highlight.
//
// An ISS solar/lunar transit at one point on Earth is rare (the centre line
// is a few km wide; a given site sees one every several weeks for the Sun).
// The whole value is in advance planning, so the scan looks days ahead and
// is recomputed on a slow cadence by the service — not every 2 s tick.

import { existsSync, readFileSync, statSync } from 'node:fs';

import {
  observerEcef, targetEcefAzEl, bodyAzEl, angularSeparationDeg, isObservable,
} from './geometry.js';
import { twoline2satrec, sgp4, temeToEcef, unixToJulian } from './sgp4.js';

// ISS must be at least this high to be worth a transit (atmospheric
// extinction + obstructions below this make imaging pointless anyway).
const ISS_MIN_ELEVATION_DEG = 15;
// Coarse scan step. The ISS sweeps the sky at up to ~1°/s, so 2 s can stride
// past a sub-second transit — but never past the *approach*: at 2 s spacing
// the separation curve still shows a clear local minimum within a few
// degrees, which the refine step then resolves to ms precision.
const COARSE_STEP_MS = 2000;
const COARSE_GATE_DEG = 3.0;          // refine only minima tighter than this
const REFINE_TOL_MS = 5;              // golden-section stop tolerance

/**
 * @typedef {Object} IssTle
 * @property {object} satrec
 * @property {string} name
 * @property {number} loadedAtMs
 * @property {string} sourcePath
 */

/**
 * Load a TLE file. Accepts the 2-line form or the 3-line form (name header).
 * Returns null (feature simply stays inactive) when the file is missing or
 * unparseable — the deployment keeps working offline without it.
 *
 * @param {string} path
 * @returns {IssTle|null}
 */
export function loadIssTle(path) {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8').trim();
    const lines = raw.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
    let name = 'ISS';
    let l1;
    let l2;
    if (lines.length >= 3 && !lines[0].startsWith('1 ')) {
      name = lines[0].replace(/^0 /, '').trim() || 'ISS';
      [, l1, l2] = lines;
    } else if (lines.length >= 2) {
      [l1, l2] = lines;
    } else {
      return null;
    }
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) return null;
    const satrec = twoline2satrec(l1, l2);
    return { satrec, name, loadedAtMs: Date.now(), sourcePath: path, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

const EARTH_R_M = 6378137.0;

/** ISS topocentric Az/El + slant range (m) at a wall-clock time, or null. */
function issAzEl(satrec, obsEcef, obsLat, obsLon, whenMs) {
  const tsinceMin = (unixToJulian(whenMs) - satrec.jdsatepoch) * 1440.0;
  const teme = sgp4(satrec, tsinceMin);
  if (!teme) return null;
  const ecef = temeToEcef(teme.r, new Date(whenMs));
  return { ...targetEcefAzEl(obsEcef, obsLat, obsLon, ecef), ecef };
}

/** ISS ECEF position only (m) at a time, or null. */
function issEcef(satrec, whenMs) {
  const tsinceMin = (unixToJulian(whenMs) - satrec.jdsatepoch) * 1440.0;
  const teme = sgp4(satrec, tsinceMin);
  if (!teme) return null;
  return temeToEcef(teme.r, new Date(whenMs));
}

/**
 * Unit vector (ECEF) from Earth centre toward the Sun. The Sun is ~1 AU
 * away, so the observer→Sun direction equals the geocentric direction to
 * well within the precision a shadow test needs. Built from the Sun's
 * topocentric Az/El by the inverse of geometry.js's ENU rotation.
 */
function sunUnitEcef(observer, whenMs) {
  const s = bodyAzEl(observer, 'Sun', new Date(whenMs));
  const az = s.azimuthDeg * Math.PI / 180;
  const el = s.elevationDeg * Math.PI / 180;
  const e = Math.cos(el) * Math.sin(az);
  const n = Math.cos(el) * Math.cos(az);
  const u = Math.sin(el);
  const phi = observer.latitudeDeg * Math.PI / 180;
  const lam = observer.longitudeDeg * Math.PI / 180;
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const sl = Math.sin(lam);
  const cl = Math.cos(lam);
  // Transpose of ecefDeltaToEnu (orthonormal → inverse = transpose).
  const x = -sl * e - sp * cl * n + cp * cl * u;
  const y = cl * e - sp * sl * n + cp * sl * u;
  const z = cp * n + sp * u;
  const m = Math.hypot(x, y, z) || 1;
  return { x: x / m, y: y / m, z: z / m };
}

/**
 * Is the ISS sunlit at this ECEF position? Cylindrical-umbra approximation
 * (ignores penumbra / shadow cone taper — sub-second at LEO, irrelevant for
 * a visible-pass heads-up): in shadow iff it sits on the anti-Sun side and
 * its perpendicular distance from the Earth–Sun axis is less than R⊕.
 */
function issSunlit(issEcefM, sunHat) {
  const proj = issEcefM.x * sunHat.x + issEcefM.y * sunHat.y + issEcefM.z * sunHat.z;
  if (proj >= 0) return true;                       // Sun-facing hemisphere
  const px = issEcefM.x - proj * sunHat.x;
  const py = issEcefM.y - proj * sunHat.y;
  const pz = issEcefM.z - proj * sunHat.z;
  return Math.hypot(px, py, pz) >= EARTH_R_M;
}

/**
 * Predict ISS transits across the given bodies for the observer over
 * `[fromMs, fromMs + horizonMs]`. Returns tracker-shaped candidates.
 *
 * @param {import('./geometry.js').Observer} observer
 * @param {object} satrec
 * @param {{
 *   fromMs?: number, horizonMs?: number, bodies?: ('Sun'|'Moon')[],
 *   thresholdDeg?: number, looseThresholdDeg?: number, name?: string,
 * }} [opts]
 * @returns {Array<object>}
 */
export function predictIssTransits(observer, satrec, opts = {}) {
  const {
    fromMs = Date.now(),
    horizonMs = 24 * 3600_000,
    bodies = ['Sun', 'Moon'],
    thresholdDeg = 0.3,
    looseThresholdDeg = 1.0,
    name = 'ISS',
  } = opts;

  const obsEcef = observerEcef(observer);
  const obsLat = observer.latitudeDeg;
  const obsLon = observer.longitudeDeg;
  const out = [];

  for (const body of bodies) {
    // Walk a coarse grid, remembering the running minimum of a "visible"
    // separation (∞ when the ISS or the body is not observable so dips
    // only register on geometrically real approaches).
    let prev2 = Infinity;
    let prev1 = Infinity;
    let prevT = fromMs;
    let prev1T = fromMs;

    const sepAt = (tMs) => {
      const iss = issAzEl(satrec, obsEcef, obsLat, obsLon, tMs);
      if (!iss || iss.elevationDeg < ISS_MIN_ELEVATION_DEG) return Infinity;
      const b = bodyAzEl(observer, body, new Date(tMs));
      if (!isObservable(b)) return Infinity;
      return angularSeparationDeg(iss, b);
    };

    for (let t = fromMs; t <= fromMs + horizonMs; t += COARSE_STEP_MS) {
      const s = sepAt(t);
      // Local minimum bracketed by [prev2 @ prev1T-step, s @ t] around prev1.
      if (prev1 < prev2 && prev1 <= s && prev1 < COARSE_GATE_DEG) {
        const refined = refineMinimum(sepAt, prev1T - COARSE_STEP_MS, t);
        if (refined && refined.sep <= looseThresholdDeg) {
          out.push(buildIssCandidate(
            observer, satrec, obsEcef, obsLat, obsLon, body,
            refined.tMs, refined.sep, thresholdDeg, looseThresholdDeg, name,
          ));
        }
      }
      prev2 = prev1; prev1 = s; prev1T = prevT; prevT = t;
    }
  }

  out.sort((a, b) => a.closestApproachAtMs - b.closestApproachAtMs);
  return out;
}

/** Golden-section minimisation of sep(t) on [aMs,bMs] → {tMs, sep}. */
function refineMinimum(sepAt, aMs, bMs) {
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = aMs;
  let b = bMs;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = sepAt(c);
  let fd = sepAt(d);
  let guard = 0;
  while (b - a > REFINE_TOL_MS && guard < 100) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = sepAt(c); }
    else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = sepAt(d); }
    guard += 1;
  }
  const tMs = Math.round((a + b) / 2);
  const sep = sepAt(tMs);
  if (!Number.isFinite(sep)) return null;
  return { tMs, sep };
}

/** Assemble a tracker-shaped candidate (plus isISS) for one transit. */
function buildIssCandidate(
  observer, satrec, obsEcef, obsLat, obsLon, body,
  closestMs, sepDeg, thresholdDeg, looseThresholdDeg, name,
) {
  const issAt = issAzEl(satrec, obsEcef, obsLat, obsLon, closestMs);
  const bodyAt = bodyAzEl(observer, body, new Date(closestMs));

  // Apparent angular rate from a ±0.5 s finite difference → disc-crossing
  // time and the synthetic ground speed the "Disc xing" column expects
  // (it computes ω = groundSpeedMs / rangeM, so we pick groundSpeedMs to
  // reproduce the true angular rate at the real slant range).
  const a = issAzEl(satrec, obsEcef, obsLat, obsLon, closestMs - 500);
  const c = issAzEl(satrec, obsEcef, obsLat, obsLon, closestMs + 500);
  let omegaDegPerSec = 0;
  if (a && c) omegaDegPerSec = angularSeparationDeg(a, c) / 1.0;
  const omegaRad = omegaDegPerSec * Math.PI / 180;
  const rangeM = issAt?.rangeM ?? null;
  const bodyDiamDeg = body === 'Sun' ? 0.533 : 0.518;
  const durationMs = omegaDegPerSec > 0
    ? Math.round((bodyDiamDeg / omegaDegPerSec) * 1000)
    : null;

  // Dense path for the FOV sketch: ±1.5 s around closest, ~0.1 s steps.
  const transitPath = [];
  for (let dt = -1500; dt <= 1500; dt += 100) {
    const iss = issAzEl(satrec, obsEcef, obsLat, obsLon, closestMs + dt);
    const b = bodyAzEl(observer, body, new Date(closestMs + dt));
    if (!iss) continue;
    transitPath.push({
      tOffsetMs: dt,
      aircraftAz: iss.azimuthDeg, aircraftEl: iss.elevationDeg,
      bodyAz: b.azimuthDeg, bodyEl: b.elevationDeg,
    });
  }

  const level = sepDeg <= thresholdDeg ? 'candidate' : 'radio';
  return {
    icao: 'ISS',
    callsign: name,
    body,
    level,
    isISS: true,
    source: 'iss',
    closestApproachAtMs: closestMs,
    closestApproachSepDeg: sepDeg,
    entersAtMs: durationMs ? closestMs - durationMs / 2 : closestMs,
    leavesAtMs: durationMs ? closestMs + durationMs / 2 : closestMs,
    durationMs,
    aircraftAtClosest: issAt
      ? { azimuthDeg: issAt.azimuthDeg, elevationDeg: issAt.elevationDeg, rangeM }
      : null,
    bodyAtClosest: {
      azimuthDeg: bodyAt.azimuthDeg, elevationDeg: bodyAt.elevationDeg,
      rangeM: bodyAt.rangeM ?? null,
    },
    aircraft: {
      icao: 'ISS',
      callsign: name,
      altMmsl: rangeM != null && issAt ? null : null,   // not meaningful for orbit
      groundSpeedMs: rangeM != null ? omegaRad * rangeM : null,
      trackDeg: null,
      typeCode: 'ISS',
      registration: null,
      typeDesc: 'International Space Station',
      verticalRateMs: 0,
    },
    transitPath,
    route: null,
  };
}

/**
 * Next *visible* ISS pass for the observer: the station climbs above
 * `minElevationDeg`, the sky is dark enough (Sun below `sunBelowDeg`, i.e.
 * after dusk / before dawn) and the ISS itself is sunlit (not in Earth's
 * shadow) — the classic naked-eye pass. Returns the first such pass within
 * the horizon, or null.
 *
 * @param {import('./geometry.js').Observer} observer
 * @param {object} satrec
 * @param {{ fromMs?: number, horizonMs?: number, stepMs?: number,
 *           minElevationDeg?: number, sunBelowDeg?: number }} [opts]
 * @returns {{ startMs:number, peakMs:number, endMs:number,
 *             maxElevationDeg:number, startAzDeg:number, endAzDeg:number,
 *             durationS:number }|null}
 */
export function nextIssVisiblePass(observer, satrec, opts = {}) {
  const {
    fromMs = Date.now(),
    horizonMs = 48 * 3600_000,
    stepMs = 15_000,
    minElevationDeg = 20,
    sunBelowDeg = -6,            // civil dusk; "nach Dämmerung"
  } = opts;

  const obsEcef = observerEcef(observer);
  const obsLat = observer.latitudeDeg;
  const obsLon = observer.longitudeDeg;

  let cur = null;   // pass being accumulated

  for (let t = fromMs; t <= fromMs + horizonMs; t += stepMs) {
    const iss = issAzEl(satrec, obsEcef, obsLat, obsLon, t);
    // Cheap reject first: ISS itself must be high enough. Skips the Sun /
    // shadow maths for the ~98 % of the orbit the station is low or down.
    if (!iss || iss.elevationDeg < minElevationDeg) {
      if (cur) { finalisePass(cur); return cur; }
      continue;
    }
    const sun = bodyAzEl(observer, 'Sun', new Date(t));
    const dark = sun.elevationDeg < sunBelowDeg;
    const lit = issSunlit(iss.ecef, sunUnitEcef(observer, t));
    if (dark && lit) {
      if (!cur) {
        cur = {
          startMs: t, peakMs: t, endMs: t,
          maxElevationDeg: iss.elevationDeg,
          startAzDeg: iss.azimuthDeg, endAzDeg: iss.azimuthDeg,
        };
      }
      if (iss.elevationDeg > cur.maxElevationDeg) {
        cur.maxElevationDeg = iss.elevationDeg;
        cur.peakMs = t;
      }
      cur.endMs = t;
      cur.endAzDeg = iss.azimuthDeg;
    } else if (cur) {
      finalisePass(cur);
      return cur;
    }
  }
  if (cur) { finalisePass(cur); return cur; }
  return null;
}

function finalisePass(p) {
  p.durationS = Math.round((p.endMs - p.startMs) / 1000);
  p.maxElevationDeg = Math.round(p.maxElevationDeg);
  p.startAzDeg = Math.round(p.startAzDeg);
  p.endAzDeg = Math.round(p.endAzDeg);
}
