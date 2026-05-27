// Geometry core for the Sun-Moon Transit Predictor.
//
// Conventions:
//   - Azimuth in degrees, 0 = North, 90 = East, range [0, 360).
//   - Elevation in degrees, range [-90, +90].
//   - Aircraft altitude is mean sea level (MSL) in metres; treated as WGS84
//     ellipsoidal height for M2 (geoid undulation neglected).
//   - Sun/Moon positions come from Astronomy Engine and are topocentric, so
//     parallax (especially for the Moon) is already included.
//   - Refraction defaults to ON ('normal' model). Above 20° elevation it is
//     well below 0.05° and effectively negligible for the <0.3° transit
//     tolerance, but it is left on for consistency.

import * as Astronomy from 'astronomy-engine';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const WGS84_A = 6378137.0;                       // semi-major axis (m)
const WGS84_F = 1 / 298.257223563;                // flattening
const WGS84_E2 = WGS84_F * (2 - WGS84_F);         // first eccentricity squared

const AU_M = 1.495978707e11;                      // 1 AU in metres

export const OBSERVABILITY_MIN_ELEVATION_DEG = 20;

/**
 * @typedef {Object} Observer
 * @property {string} [name]
 * @property {number} latitudeDeg
 * @property {number} longitudeDeg
 * @property {number} elevationM           - WGS84 ellipsoidal height of the observer (m).
 *                                           For typical hobbyist precision a local MSL
 *                                           value is fine; the body comparison is robust
 *                                           to a few tens of metres of observer height.
 * @property {number} [geoidUndulationM]   - EGM2008 N at the observer location (m), used
 *                                           to convert ADS-B `alt_baro` (≈MSL) into HAE
 *                                           before geometric comparison. Default 0.
 *                                           Rheine ≈ +46 m.
 */

/**
 * @typedef {Object} AzEl
 * @property {number} azimuthDeg           - 0 = N, 90 = E, range [0, 360).
 * @property {number} elevationDeg         - range [-90, 90].
 * @property {number|null} rangeM          - line-of-sight distance, metres, or null.
 */

/** @typedef {'Sun' | 'Moon'} CelestialBody */

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function geodeticToEcef(latDeg, lonDeg, hM) {
  const phi = latDeg * DEG;
  const lam = lonDeg * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinLam = Math.sin(lam);
  const cosLam = Math.cos(lam);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const x = (N + hM) * cosPhi * cosLam;
  const y = (N + hM) * cosPhi * sinLam;
  const z = (N * (1 - WGS84_E2) + hM) * sinPhi;
  return { x, y, z };
}

function ecefDeltaToEnu(dx, dy, dz, lat0Deg, lon0Deg) {
  const phi = lat0Deg * DEG;
  const lam = lon0Deg * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinLam = Math.sin(lam);
  const cosLam = Math.cos(lam);
  const e = -sinLam * dx + cosLam * dy;
  const n = -sinPhi * cosLam * dx - sinPhi * sinLam * dy + cosPhi * dz;
  const u = cosPhi * cosLam * dx + cosPhi * sinLam * dy + sinPhi * dz;
  return { e, n, u };
}

function enuToAzEl(e, n, u) {
  const horizontal = Math.hypot(e, n);
  const azRaw = Math.atan2(e, n) * RAD;
  const azimuthDeg = (azRaw + 360) % 360;
  const elevationDeg = Math.atan2(u, horizontal) * RAD;
  const rangeM = Math.hypot(horizontal, u);
  return { azimuthDeg, elevationDeg, rangeM };
}

/**
 * ECEF position of the observer. Cached at the call site to avoid recomputing
 * once per aircraft × per time step (the observer is fixed).
 *
 * @param {Observer} observer
 * @returns {{ x: number, y: number, z: number }}
 */
export function observerEcef(observer) {
  return geodeticToEcef(observer.latitudeDeg, observer.longitudeDeg, observer.elevationM);
}

/**
 * Az/El of a target given a precomputed observer ECEF.
 *
 * Note: `altMHae` is height above the WGS84 ellipsoid. ADS-B `alt_geom` is
 * already HAE, so it can be passed directly. ADS-B `alt_baro` is pressure
 * altitude (~MSL); convert with `altMHae = altMsl + geoidUndulationM` first.
 *
 * @param {{ x: number, y: number, z: number }} obsEcef
 * @param {number} obsLatDeg
 * @param {number} obsLonDeg
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {number} altMHae
 * @returns {AzEl}
 */
export function aircraftAzElFromObsEcef(obsEcef, obsLatDeg, obsLonDeg, latDeg, lonDeg, altMHae) {
  const tgtEcef = geodeticToEcef(latDeg, lonDeg, altMHae);
  const enu = ecefDeltaToEnu(
    tgtEcef.x - obsEcef.x,
    tgtEcef.y - obsEcef.y,
    tgtEcef.z - obsEcef.z,
    obsLatDeg,
    obsLonDeg,
  );
  return enuToAzEl(enu.e, enu.n, enu.u);
}

/**
 * Az/El of a target whose ECEF position is already known (metres). Used for
 * the ISS, where SGP4 → TEME → ECEF gives a Cartesian position directly, so
 * the geodetic round-trip in `aircraftAzElFromObsEcef` would be wasted work.
 *
 * @param {{ x: number, y: number, z: number }} obsEcef
 * @param {number} obsLatDeg
 * @param {number} obsLonDeg
 * @param {{ x: number, y: number, z: number }} tgtEcef  - metres
 * @returns {AzEl}
 */
export function targetEcefAzEl(obsEcef, obsLatDeg, obsLonDeg, tgtEcef) {
  const enu = ecefDeltaToEnu(
    tgtEcef.x - obsEcef.x,
    tgtEcef.y - obsEcef.y,
    tgtEcef.z - obsEcef.z,
    obsLatDeg,
    obsLonDeg,
  );
  return enuToAzEl(enu.e, enu.n, enu.u);
}

/**
 * Az/El of an aircraft as seen from the observer. Convenience wrapper that
 * recomputes observer ECEF on every call — for tight loops, prefer caching
 * `observerEcef(observer)` and using `aircraftAzElFromObsEcef`.
 *
 * @param {Observer} observer
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {number} altMHae - height above WGS84 ellipsoid, metres.
 * @returns {AzEl}
 */
export function aircraftAzEl(observer, latDeg, lonDeg, altMHae) {
  return aircraftAzElFromObsEcef(
    observerEcef(observer),
    observer.latitudeDeg,
    observer.longitudeDeg,
    latDeg,
    lonDeg,
    altMHae,
  );
}

function bodyEnumOf(body) {
  if (body === 'Sun') return Astronomy.Body.Sun;
  if (body === 'Moon') return Astronomy.Body.Moon;
  throw new Error(`Unsupported body: ${body}. Expected 'Sun' or 'Moon'.`);
}

/**
 * Az/El of a celestial body (Sun or Moon) as seen from the observer.
 *
 * @param {Observer} observer
 * @param {CelestialBody} body
 * @param {Date|string|number} whenUtc
 * @param {{ applyRefraction?: boolean }} [opts]
 * @returns {AzEl}
 */
export function bodyAzEl(observer, body, whenUtc, opts = {}) {
  const { applyRefraction = true } = opts;
  const aobs = new Astronomy.Observer(
    observer.latitudeDeg,
    observer.longitudeDeg,
    observer.elevationM,
  );
  const time = Astronomy.MakeTime(whenUtc instanceof Date ? whenUtc : new Date(whenUtc));
  const equ = Astronomy.Equator(bodyEnumOf(body), time, aobs, true, true);
  const hor = Astronomy.Horizon(time, aobs, equ.ra, equ.dec, applyRefraction ? 'normal' : null);
  return {
    azimuthDeg: hor.azimuth,
    elevationDeg: hor.altitude,
    rangeM: equ.dist * AU_M,
  };
}

/**
 * Convenience wrapper for the Sun.
 * @param {Observer} observer
 * @param {Date|string|number} whenUtc
 * @param {{ applyRefraction?: boolean }} [opts]
 * @returns {AzEl}
 */
export function sunAzEl(observer, whenUtc, opts) {
  return bodyAzEl(observer, 'Sun', whenUtc, opts);
}

/**
 * Convenience wrapper for the Moon.
 * @param {Observer} observer
 * @param {Date|string|number} whenUtc
 * @param {{ applyRefraction?: boolean }} [opts]
 * @returns {AzEl}
 */
export function moonAzEl(observer, whenUtc, opts) {
  return bodyAzEl(observer, 'Moon', whenUtc, opts);
}

/**
 * Great-circle angular distance between two Az/El positions, in degrees.
 *
 * @param {AzEl} a
 * @param {AzEl} b
 * @returns {number}
 */
export function angularSeparationDeg(a, b) {
  const phiA = a.elevationDeg * DEG;
  const phiB = b.elevationDeg * DEG;
  const dLam = (b.azimuthDeg - a.azimuthDeg) * DEG;
  const cosD = Math.sin(phiA) * Math.sin(phiB)
    + Math.cos(phiA) * Math.cos(phiB) * Math.cos(dLam);
  return Math.acos(clamp(cosD, -1, 1)) * RAD;
}

/**
 * Whether a body at this Az/El is above the observability threshold (>20°).
 *
 * @param {AzEl} azEl
 * @returns {boolean}
 */
export function isObservable(azEl, minElevationDeg) {
  // v0.30.37: threshold is now a parameter so the tracker can lower it
  // when a rig wants to record below the default 20° (e.g. a clear-
  // southern-horizon site with minElevationDeg = 10 on the main rig).
  // Falls back to OBSERVABILITY_MIN_ELEVATION_DEG when caller doesn't
  // pass anything, preserving the historical default behaviour.
  const thr = Number.isFinite(minElevationDeg) ? minElevationDeg : OBSERVABILITY_MIN_ELEVATION_DEG;
  return azEl.elevationDeg > thr;
}
