// Live transit detector: extrapolates each aircraft over a short horizon and
// looks for moments when the line-of-sight from the observer crosses within
// the configured tolerance of the Sun or Moon. Pure function — no I/O, no
// time source other than the explicit `nowMs` argument, so it is trivial to
// unit-test.

import {
  aircraftAzEl,
  angularSeparationDeg,
  bodyAzEl,
  isObservable,
} from './geometry.js';

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * @typedef {Object} TransitCandidate
 * @property {string} icao
 * @property {string|null} callsign
 * @property {'Sun'|'Moon'} body
 * @property {number} closestApproachAtMs
 * @property {number} closestApproachSepDeg
 * @property {number} entersAtMs            - first time ≤ threshold
 * @property {number} leavesAtMs            - last time ≤ threshold
 * @property {number} durationMs
 * @property {{ azimuthDeg: number, elevationDeg: number, rangeM: number|null }} aircraftAtClosest
 * @property {{ azimuthDeg: number, elevationDeg: number, rangeM: number|null }} bodyAtClosest
 * @property {import('./adsb.js').Aircraft} aircraft
 */

/**
 * Linear-extrapolate an aircraft `dtSec` seconds into the future.
 * Treats the locally-tangent plane as flat (error <1 m for our 60-second
 * horizon).
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

function sampleBodyTrajectory(observer, body, nowMs, horizonS, stepS) {
  const samples = [];
  for (let t = 0; t <= horizonS; t += stepS) {
    const azel = bodyAzEl(observer, body, new Date(nowMs + t * 1000));
    samples.push({ tSec: t, azel });
  }
  return samples;
}

function bodyIsObservableSomewhere(samples) {
  for (const s of samples) if (isObservable(s.azel)) return true;
  return false;
}

function candidateForBody(observer, ac, body, samples, thresholdDeg, nowMs) {
  let minSep = Infinity;
  let minAtT = 0;
  let minAcAzEl = null;
  let minBodyAzEl = null;
  let entersT = null;
  let leavesT = null;

  for (const sample of samples) {
    if (!isObservable(sample.azel)) continue;
    const projected = extrapolate(ac, sample.tSec);
    const acAzEl = aircraftAzEl(observer, projected.lat, projected.lon, projected.altMmsl);
    if (acAzEl.elevationDeg <= 0) continue;
    const sep = angularSeparationDeg(acAzEl, sample.azel);
    if (sep < minSep) {
      minSep = sep;
      minAtT = sample.tSec;
      minAcAzEl = acAzEl;
      minBodyAzEl = sample.azel;
    }
    if (sep <= thresholdDeg) {
      if (entersT === null) entersT = sample.tSec;
      leavesT = sample.tSec;
    }
  }

  if (entersT === null) return null;

  return {
    icao: ac.icao,
    callsign: ac.callsign,
    body,
    closestApproachAtMs: nowMs + minAtT * 1000,
    closestApproachSepDeg: minSep,
    entersAtMs: nowMs + entersT * 1000,
    leavesAtMs: nowMs + leavesT * 1000,
    durationMs: (leavesT - entersT) * 1000,
    aircraftAtClosest: minAcAzEl,
    bodyAtClosest: minBodyAzEl,
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
 *           bodies?: ('Sun'|'Moon')[] }} [opts]
 * @returns {TransitCandidate[]}
 */
export function findTransits(observer, aircraftList, nowMs, opts = {}) {
  const {
    horizonS = 60,
    stepS = 1,
    thresholdDeg = 0.3,
    bodies = ['Sun', 'Moon'],
  } = opts;

  const trajectories = new Map();
  for (const body of bodies) {
    const samples = sampleBodyTrajectory(observer, body, nowMs, horizonS, stepS);
    if (bodyIsObservableSomewhere(samples)) {
      trajectories.set(body, samples);
    }
  }
  if (trajectories.size === 0) return [];

  /** @type {TransitCandidate[]} */
  const candidates = [];
  for (const ac of aircraftList) {
    if (typeof ac.groundSpeedMs !== 'number' || typeof ac.trackDeg !== 'number') continue;
    for (const [body, samples] of trajectories) {
      const cand = candidateForBody(observer, ac, body, samples, thresholdDeg, nowMs);
      if (cand) candidates.push(cand);
    }
  }
  candidates.sort((a, b) => a.closestApproachAtMs - b.closestApproachAtMs);
  return candidates;
}
