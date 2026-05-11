// Live transit detector: extrapolates each aircraft over a short horizon and
// looks for moments when the line-of-sight from the observer crosses within
// the configured tolerance of the Sun or Moon. Pure function — no I/O, no
// time source other than the explicit `nowMs` argument, so it is trivial to
// unit-test.
//
// Accuracy notes (see tasks/lessons.md):
//   - The sample at index `i` represents the geometry at `nowMs + i * stepS`.
//     Aircraft positions are projected from the actual ADS-B fix time
//     (`receivedAtMs`), not from `nowMs`, so the `seenPosS` lag does not
//     produce a systematic position error.
//   - Both the body and the aircraft are compared in *geometric* (un-refracted)
//     coordinates. Differential refraction along two nearby lines of sight is
//     well below the discretisation noise of the search.
//   - After the discrete minimum is located, a parabolic vertex is fitted
//     through the three samples around it. This recovers sub-step time and
//     separation precision without inflating the trajectory cache.
//   - For barometric altitudes (no GPS-derived `alt_geom`), the configured
//     `geoidUndulationM` (observer.json) is added so the value approximates
//     WGS84 ellipsoidal height before geometric conversion.

import {
  aircraftAzElFromObsEcef,
  angularSeparationDeg,
  bodyAzEl,
  isObservable,
  observerEcef,
} from './geometry.js';

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * @typedef {Object} TransitCandidate
 * @property {string} icao
 * @property {string|null} callsign
 * @property {'Sun'|'Moon'} body
 * @property {'candidate'|'radio'} level   - 'candidate' = min sep ≤ thresholdDeg
 *                                          (will pass close to disc); 'radio' =
 *                                          min sep ≤ looseThresholdDeg only
 *                                          (in the area but not a tight match,
 *                                          useful as an early-warning stage).
 * @property {number} closestApproachAtMs
 * @property {number} closestApproachSepDeg
 * @property {number} entersAtMs            - first time ≤ effective threshold (loose for radio, tight for candidate)
 * @property {number} leavesAtMs            - last time ≤ effective threshold
 * @property {number} durationMs
 * @property {{ azimuthDeg: number, elevationDeg: number, rangeM: number|null }} aircraftAtClosest
 * @property {{ azimuthDeg: number, elevationDeg: number, rangeM: number|null }} bodyAtClosest
 * @property {import('./adsb.js').Aircraft} aircraft
 */

/**
 * Linear-extrapolate an aircraft `dtSec` seconds forward from the *fix time*
 * (`ac.receivedAtMs`). Treats the locally-tangent plane as flat (error <1 m
 * for our 60-second horizon).
 *
 * @param {import('./adsb.js').Aircraft} ac
 * @param {number} dtSec
 * @returns {{ lat: number, lon: number, altMmsl: number }}
 */
export function extrapolate(ac, dtSec) {
  const gs = ac.groundSpeedMs ?? 0;
  const track = (ac.trackDeg ?? 0) * DEG;
  const vRate = ac.verticalRateMs ?? 0;
  const dN = gs * Math.cos(track) * dtSec;
  const dE = gs * Math.sin(track) * dtSec;
  const dLat = (dN / EARTH_RADIUS_M) * RAD;
  const dLon = (dE / (EARTH_RADIUS_M * Math.cos(ac.lat * DEG))) * RAD;
  return {
    lat: ac.lat + dLat,
    lon: ac.lon + dLon,
    altMmsl: ac.altMmsl + vRate * dtSec,
  };
}

/**
 * Sample the body's Az/El across the look-ahead horizon. Refraction is OFF
 * here — the comparison against geometric aircraft positions has to use the
 * same reference frame, otherwise the ~0.04° refraction lift would show up
 * as a one-sided bias near the 20° threshold.
 */
function sampleBodyTrajectory(observer, body, nowMs, horizonS, stepS) {
  const samples = [];
  const n = Math.floor(horizonS / stepS) + 1;
  for (let i = 0; i < n; i++) {
    const tSec = i * stepS;
    const azel = bodyAzEl(observer, body, new Date(nowMs + tSec * 1000), {
      applyRefraction: false,
    });
    samples.push({ tSec, azel });
  }
  return samples;
}

function bodyIsObservableSomewhere(samples) {
  for (const s of samples) if (isObservable(s.azel)) return true;
  return false;
}

/**
 * Convert ADS-B reported altitude to WGS84 ellipsoidal height (HAE).
 *   - `alt_geom` (DO-260) is already HAE: identity.
 *   - `alt_baro` is pressure altitude (≈MSL on standard atm.): add geoid
 *     undulation N so HAE ≈ MSL + N. At Rheine N ≈ +46 m (EGM2008).
 */
function altHaeOf(ac, geoidUndulationM) {
  return ac.altSource === 'barometric'
    ? ac.altMmsl + geoidUndulationM
    : ac.altMmsl;
}

/**
 * Parabolic vertex through three equally-spaced samples (sepA, sepB, sepC) at
 * t-step, t, t+step where sepB is the discrete minimum. Returns the
 * sub-sample {dt, sep} relative to the centre sample. Falls back to (0, sepB)
 * if the three points are not strictly convex (denominator ≤ 0), which avoids
 * spurious extrapolation when the curve is degenerate or the discrete min is
 * at the edge of the search window.
 */
function parabolicVertex(sepA, sepB, sepC, stepS) {
  const denom = sepA - 2 * sepB + sepC;
  if (denom <= 0) return { dt: 0, sep: sepB };
  // delta in [-1, +1]; positive means vertex lies between B and C.
  const delta = 0.5 * (sepA - sepC) / denom;
  const dt = delta * stepS;
  const sep = sepB - 0.25 * (sepA - sepC) * delta;
  return { dt, sep };
}

function candidateForBody(ac, body, acTrajectory, bodySamples, thresholdDeg, looseThresholdDeg, nowMs, stepS) {
  let minSep = Infinity;
  let minIdx = -1;
  let tightEnters = -1;
  let tightLeaves = -1;
  let looseEnters = -1;
  let looseLeaves = -1;

  // bodySamples and acTrajectory share the same indexing (same step + horizon).
  for (let i = 0; i < bodySamples.length; i++) {
    if (!isObservable(bodySamples[i].azel)) continue;
    const ac_i = acTrajectory[i];
    if (!ac_i || ac_i.acAzEl.elevationDeg <= 0) continue;
    const sep = angularSeparationDeg(ac_i.acAzEl, bodySamples[i].azel);
    if (sep < minSep) { minSep = sep; minIdx = i; }
    if (sep <= thresholdDeg) {
      if (tightEnters === -1) tightEnters = i;
      tightLeaves = i;
    }
    if (sep <= looseThresholdDeg) {
      if (looseEnters === -1) looseEnters = i;
      looseLeaves = i;
    }
  }

  const level = tightEnters !== -1 ? 'candidate'
              : looseEnters !== -1 ? 'radio'
              : null;
  if (!level) return null;

  // Window timestamps reported at the effective level: tight band for
  // 'candidate', looser band for 'radio'. The closest-approach time itself is
  // always the global minimum (refined below).
  const entersIdx = level === 'candidate' ? tightEnters : looseEnters;
  const leavesIdx = level === 'candidate' ? tightLeaves : looseLeaves;

  // Sub-step refinement for time and separation. Use the discrete sample for
  // aircraft / body Az/El at closest — the geometric refinement of those
  // points is below display precision at the 0.5 s default step.
  let refinedTSec = bodySamples[minIdx].tSec;
  let refinedSep = minSep;
  if (minIdx > 0 && minIdx < bodySamples.length - 1) {
    const prev = acTrajectory[minIdx - 1] && isObservable(bodySamples[minIdx - 1].azel)
      ? angularSeparationDeg(acTrajectory[minIdx - 1].acAzEl, bodySamples[minIdx - 1].azel)
      : null;
    const next = acTrajectory[minIdx + 1] && isObservable(bodySamples[minIdx + 1].azel)
      ? angularSeparationDeg(acTrajectory[minIdx + 1].acAzEl, bodySamples[minIdx + 1].azel)
      : null;
    if (prev !== null && next !== null) {
      const v = parabolicVertex(prev, minSep, next, stepS);
      refinedTSec = bodySamples[minIdx].tSec + v.dt;
      refinedSep = v.sep;
    }
  }

  return {
    icao: ac.icao,
    callsign: ac.callsign,
    body,
    level,
    closestApproachAtMs: nowMs + refinedTSec * 1000,
    closestApproachSepDeg: refinedSep,
    entersAtMs: nowMs + bodySamples[entersIdx].tSec * 1000,
    leavesAtMs: nowMs + bodySamples[leavesIdx].tSec * 1000,
    durationMs: (bodySamples[leavesIdx].tSec - bodySamples[entersIdx].tSec) * 1000,
    aircraftAtClosest: acTrajectory[minIdx].acAzEl,
    bodyAtClosest: bodySamples[minIdx].azel,
    aircraft: ac,
  };
}

/**
 * Scan the given aircraft for upcoming transits across Sun and/or Moon.
 *
 * @param {import('./geometry.js').Observer} observer
 * @param {import('./adsb.js').Aircraft[]} aircraftList
 * @param {number} nowMs
 * @param {{ horizonS?: number, stepS?: number, thresholdDeg?: number,
 *           bodies?: ('Sun'|'Moon')[], geoidUndulationM?: number }} [opts]
 * @returns {TransitCandidate[]}
 */
export function findTransits(observer, aircraftList, nowMs, opts = {}) {
  const {
    stepS = 0.5,
    thresholdDeg = 0.3,
    bodies = ['Sun', 'Moon'],
    geoidUndulationM = observer.geoidUndulationM ?? 0,
  } = opts;
  // Loose threshold defines the 'radio' (approach) detection band: aircraft
  // whose projected min separation lands inside [thresholdDeg, looseThresholdDeg]
  // are still reported so the UI / Pushover pipeline can give a much earlier
  // heads-up. Set loose=tight (or omit) to disable the radio stage.
  const looseThresholdDeg = Math.max(thresholdDeg, opts.looseThresholdDeg ?? thresholdDeg);
  // Clamp horizon to sane bounds. Linear extrapolation is meter-accurate at
  // 60 s; well past 5 min the assumption breaks (turns, climbs, wind shift)
  // and the prediction is mostly noise. Allow up to 600 s for users who
  // explicitly want a wider net but cap the upper end so a typo in
  // service.json can't blow up the per-tick CPU budget.
  const horizonS = Math.min(600, Math.max(10, opts.horizonS ?? 300));

  // Body trajectories — geometric (un-refracted) for like-for-like comparison.
  const trajectories = new Map();
  for (const body of bodies) {
    const samples = sampleBodyTrajectory(observer, body, nowMs, horizonS, stepS);
    if (bodyIsObservableSomewhere(samples)) {
      trajectories.set(body, samples);
    }
  }
  if (trajectories.size === 0) return [];

  const obsEcef = observerEcef(observer);
  const lat0 = observer.latitudeDeg;
  const lon0 = observer.longitudeDeg;
  const sampleCount = trajectories.values().next().value.length;

  /** @type {TransitCandidate[]} */
  const candidates = [];

  for (const ac of aircraftList) {
    if (typeof ac.groundSpeedMs !== 'number' || typeof ac.trackDeg !== 'number') continue;

    // Project aircraft from the *fix time*, not from nowMs. The body sampling
    // step at index i is at "nowMs + i*stepS", so the elapsed time since the
    // last fix to that sample is `i*stepS + fixLagS`.
    const fixLagS = (nowMs - (ac.receivedAtMs ?? nowMs)) / 1000;

    // Compute the per-aircraft trajectory once and reuse across bodies.
    const acTrajectory = new Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const dtFromFix = i * stepS + fixLagS;
      const projected = extrapolate(ac, dtFromFix);
      const altHae = altHaeOf({ ...ac, altMmsl: projected.altMmsl }, geoidUndulationM);
      const acAzEl = aircraftAzElFromObsEcef(
        obsEcef, lat0, lon0, projected.lat, projected.lon, altHae,
      );
      acTrajectory[i] = { tSec: i * stepS, acAzEl };
    }

    for (const [body, samples] of trajectories) {
      const cand = candidateForBody(
        ac, body, acTrajectory, samples,
        thresholdDeg, looseThresholdDeg, nowMs, stepS,
      );
      if (cand) candidates.push(cand);
    }
  }
  candidates.sort((a, b) => a.closestApproachAtMs - b.closestApproachAtMs);
  return candidates;
}
