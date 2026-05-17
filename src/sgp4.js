// Dependency-free SGP4 propagator (near-Earth model).
//
// This is a faithful JavaScript port of the canonical SGP4 algorithm from
// Vallado et al., "Revisiting Spacetrack Report #3" (AIAA 2006-6753) — the
// same maths the public satellite.js / python-sgp4 libraries implement. Only
// the near-Earth path is included: it is exact for the ISS (orbital period
// ~92 min, far below the 225-min deep-space threshold), keeps the file small
// and the deployment dependency-free / offline.
//
// Validated end-to-end against the official SGP4 verification vector for the
// near-Earth test object 88888 (see test/sgp4.test.js).
//
// Frames: SGP4 outputs position/velocity in the TEME (True Equator, Mean
// Equinox) frame in km / km·s⁻¹. `temeToEcef()` rotates that into ECEF using
// GMST so the existing topocentric reduction in geometry.js can be reused.

const PI = Math.PI;
const TWOPI = 2 * PI;
const DEG2RAD = PI / 180;

// WGS-72 constants — SGP4 is *defined* against WGS-72, not WGS-84. Using
// WGS-84 here is a common and subtle bug; we deliberately keep WGS-72.
const MU = 398600.8;                       // km³/s²
const RADIUSEARTHKM = 6378.135;            // km
const XKE = 60.0 / Math.sqrt((RADIUSEARTHKM ** 3) / MU);
const TUMIN = 1.0 / XKE;
const J2 = 0.001082616;
const J3 = -0.00000253881;
const J4 = -0.00000165597;
const J3OJ2 = J3 / J2;
const X2O3 = 2.0 / 3.0;

/** Gregorian calendar → Julian date. */
function jday(year, mon, day, hr, minute, sec) {
  return (
    367.0 * year
    - Math.floor((7 * (year + Math.floor((mon + 9) / 12.0))) * 0.25)
    + Math.floor((275 * mon) / 9.0)
    + day + 1721013.5
    + ((sec / 60.0 + minute) / 60.0 + hr) / 24.0
  );
}

/** Fractional day-of-year → month/day/h/m/s. */
function days2mdhms(year, days) {
  const lmonth = [31, (year % 4) === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const dayofyr = Math.floor(days);
  let i = 0;
  let inttemp = 0;
  while (dayofyr > inttemp + lmonth[i] && i < 11) {
    inttemp += lmonth[i];
    i += 1;
  }
  const mon = i + 1;
  const day = dayofyr - inttemp;
  let temp = (days - dayofyr) * 24.0;
  const hr = Math.floor(temp);
  temp = (temp - hr) * 60.0;
  const minute = Math.floor(temp);
  const sec = (temp - minute) * 60.0;
  return { mon, day, hr, minute, sec };
}

/**
 * Greenwich Mean Sidereal Time (radians) for a UT1 Julian date.
 * IAU-82 polynomial — the conventional GMST used with TEME.
 */
export function gstime(jdut1) {
  const tut1 = (jdut1 - 2451545.0) / 36525.0;
  let temp = -6.2e-6 * tut1 * tut1 * tut1
    + 0.093104 * tut1 * tut1
    + (876600.0 * 3600 + 8640184.812866) * tut1
    + 67310.54841;
  temp = (temp * DEG2RAD / 240.0) % TWOPI;   // 360/86400 = 1/240, to radians
  if (temp < 0.0) temp += TWOPI;
  return temp;
}

/**
 * Parse a TLE pair into a satrec and run SGP4 initialisation.
 * @param {string} line1
 * @param {string} line2
 * @returns {object} satrec
 */
export function twoline2satrec(line1, line2) {
  const satrec = {};
  satrec.satnum = line1.substring(2, 7).trim();

  let epochyr = parseInt(line1.substring(18, 20), 10);
  const epochdays = parseFloat(line1.substring(20, 32));
  satrec.bstar = parseFloat(
    `${line1[53]}.${line1.substring(54, 59)}E${line1.substring(59, 61)}`,
  );

  satrec.inclo = parseFloat(line2.substring(8, 16)) * DEG2RAD;
  satrec.nodeo = parseFloat(line2.substring(17, 25)) * DEG2RAD;
  satrec.ecco = parseFloat(`0.${line2.substring(26, 33).trim()}`);
  satrec.argpo = parseFloat(line2.substring(34, 42)) * DEG2RAD;
  satrec.mo = parseFloat(line2.substring(43, 51)) * DEG2RAD;
  // mean motion: rev/day → rad/min
  satrec.no = parseFloat(line2.substring(52, 63)) / (1440.0 / TWOPI);

  epochyr += epochyr < 57 ? 2000 : 1900;
  const mdhms = days2mdhms(epochyr, epochdays);
  satrec.jdsatepoch = jday(epochyr, mdhms.mon, mdhms.day, mdhms.hr, mdhms.minute, mdhms.sec);

  sgp4init(satrec);
  return satrec;
}

/** SGP4 near-Earth initialisation (Vallado sgp4init, isimp/deep-space dropped). */
function sgp4init(satrec) {
  const ss = 78.0 / RADIUSEARTHKM + 1.0;
  const qzms2t = ((120.0 - 78.0) / RADIUSEARTHKM) ** 4;

  const cosio = Math.cos(satrec.inclo);
  const sinio = Math.sin(satrec.inclo);
  const eo = satrec.ecco;
  const eosq = eo * eo;
  const betao2 = 1.0 - eosq;             // omeosq
  const betao = Math.sqrt(betao2);       // rteosq
  const theta2 = cosio * cosio;
  const x3thm1 = 3.0 * theta2 - 1.0;     // con41

  // Recover the un-Kozai'd mean motion + semimajor axis (Vallado `initl`).
  // SGP4/Vallado carries J2 directly (not the Spacetrack-#3 k2 = ½·J2), so
  // the recovery coefficient is 0.75·J2 — mixing the two conventions is a
  // classic factor-of-2 bug worth ~km at epoch.
  const ak = (XKE / satrec.no) ** X2O3;
  const d1 = 0.75 * J2 * x3thm1 / (betao * betao2);
  let del = d1 / (ak * ak);
  const adel = ak * (1.0 - del * del - del * (1.0 / 3.0 + 134.0 * del * del / 81.0));
  del = d1 / (adel * adel);
  satrec.no = satrec.no / (1.0 + del);

  const aodp = (XKE / satrec.no) ** X2O3;
  const s4 = ss;
  const qoms24 = qzms2t;

  // s and qoms2t adjusted for low perigee (kept simple — ISS perigee is
  // well above 156 km so the standard branch applies; the low-perigee
  // refinements are omitted for brevity and never hit for the ISS).
  const pinvsq = 1.0 / (aodp * aodp * betao2 * betao2);
  const tsi = 1.0 / (aodp - s4);
  satrec.eta = aodp * eo * tsi;
  const etasq = satrec.eta * satrec.eta;
  const eeta = eo * satrec.eta;
  const psisq = Math.abs(1.0 - etasq);
  const coef = qoms24 * (tsi ** 4);
  const coef1 = coef / (psisq ** 3.5);

  const c2 = coef1 * satrec.no * (aodp * (1.0 + 1.5 * etasq + eeta * (4.0 + etasq))
    + 0.375 * J2 * tsi / psisq * x3thm1 * (8.0 + 3.0 * etasq * (8.0 + etasq)));
  satrec.c1 = satrec.bstar * c2;
  const c3 = coef1 * tsi * J3OJ2 * satrec.no * sinio / eo;
  satrec.x1mth2 = 1.0 - theta2;
  satrec.c4 = 2.0 * satrec.no * coef1 * aodp * betao2 * (
    satrec.eta * (2.0 + 0.5 * etasq)
    + eo * (0.5 + 2.0 * etasq)
    - 2.0 * J2 * tsi / (aodp * psisq) * (
      -3.0 * x3thm1 * (1.0 - 2.0 * eeta + etasq * (1.5 - 0.5 * eeta))
      + 0.75 * satrec.x1mth2 * (2.0 * etasq - eeta * (1.0 + etasq))
        * Math.cos(2.0 * satrec.argpo)
    ));
  const theta4 = theta2 * theta2;
  const temp1 = 1.5 * J2 * pinvsq * satrec.no;
  const temp2 = 0.5 * temp1 * J2 * pinvsq;
  const temp3 = -0.46875 * J4 * pinvsq * pinvsq * satrec.no;

  satrec.mdot = satrec.no
    + 0.5 * temp1 * betao * x3thm1
    + 0.0625 * temp2 * betao * (13.0 - 78.0 * theta2 + 137.0 * theta4);
  satrec.argpdot = -0.5 * temp1 * (1.0 - 5.0 * theta2)
    + 0.0625 * temp2 * (7.0 - 114.0 * theta2 + 395.0 * theta4)
    + temp3 * (3.0 - 36.0 * theta2 + 49.0 * theta4);
  const xhdot1 = -temp1 * cosio;
  satrec.nodedot = xhdot1
    + (0.5 * temp2 * (4.0 - 19.0 * theta2) + 2.0 * temp3 * (3.0 - 7.0 * theta2)) * cosio;

  satrec.c5 = 2.0 * coef1 * aodp * betao2
    * (1.0 + 2.75 * (etasq + eeta) + eeta * etasq);
  satrec.omgcof = satrec.bstar * c3 * Math.cos(satrec.argpo);
  satrec.xmcof = eo > 1e-4 ? -X2O3 * coef * satrec.bstar / eeta : 0.0;
  satrec.nodecf = 3.5 * betao2 * xhdot1 * satrec.c1;
  satrec.t2cof = 1.5 * satrec.c1;
  satrec.xlcof = 0.125 * J3OJ2 * sinio * (3.0 + 5.0 * cosio) / (1.0 + cosio);
  satrec.aycof = -0.5 * J3OJ2 * sinio;
  satrec.delmo = (1.0 + satrec.eta * Math.cos(satrec.mo)) ** 3;
  satrec.sinmao = Math.sin(satrec.mo);

  // Higher-order drag terms.
  const c1sq = satrec.c1 * satrec.c1;
  satrec.d2 = 4.0 * aodp * tsi * c1sq;
  const temp = satrec.d2 * tsi * satrec.c1 / 3.0;
  satrec.d3 = (17.0 * aodp + s4) * temp;
  satrec.d4 = 0.5 * temp * aodp * tsi * (221.0 * aodp + 31.0 * s4) * satrec.c1;
  satrec.t3cof = satrec.d2 + 2.0 * c1sq;
  satrec.t4cof = 0.25 * (3.0 * satrec.d3 + satrec.c1 * (12.0 * satrec.d2 + 10.0 * c1sq));
  satrec.t5cof = 0.2 * (3.0 * satrec.d4 + 12.0 * satrec.c1 * satrec.d3
    + 6.0 * satrec.d2 * satrec.d2 + 15.0 * c1sq * (2.0 * satrec.d2 + c1sq));

  satrec.aodp = aodp;
  satrec.eo = eo;
  satrec.sinio = sinio;
  satrec.cosio = cosio;
  satrec.x3thm1 = x3thm1;
  satrec.x7thm1 = 7.0 * theta2 - 1.0;
  satrec.xnodp = satrec.no;
}

/**
 * Propagate `tsince` minutes from epoch. Returns TEME position (km) and
 * velocity (km/s), or null on a numerical failure (decayed orbit, etc.).
 * @param {object} s satrec
 * @param {number} tsince minutes since epoch
 */
export function sgp4(s, tsince) {
  const xmdf = s.mo + s.mdot * tsince;
  const argpdf = s.argpo + s.argpdot * tsince;
  const nodedf = s.nodeo + s.nodedot * tsince;
  let argpm = argpdf;
  let mm = xmdf;
  const t2 = tsince * tsince;
  const nodem = nodedf + s.nodecf * t2;
  let tempa = 1.0 - s.c1 * tsince;
  let tempe = s.bstar * s.c4 * tsince;
  let templ = s.t2cof * t2;

  const delomg = s.omgcof * tsince;
  const delm = s.xmcof * (((1.0 + s.eta * Math.cos(xmdf)) ** 3) - s.delmo);
  const temp = delomg + delm;
  mm = xmdf + temp;
  argpm = argpdf - temp;
  const t3 = t2 * tsince;
  const t4 = t3 * tsince;
  tempa = tempa - s.d2 * t2 - s.d3 * t3 - s.d4 * t4;
  tempe = tempe + s.bstar * s.c5 * (Math.sin(mm) - s.sinmao);
  templ = templ + s.t3cof * t3 + t4 * (s.t4cof + tsince * s.t5cof);

  const am = s.aodp * tempa * tempa;
  if (am < 1.0) return null;          // decayed
  const em = s.eo - tempe;
  if (em >= 1.0 || em < -0.001) return null;
  const emClamped = em < 1.0e-6 ? 1.0e-6 : em;

  mm = mm + s.xnodp * templ;
  const xlm = mm + argpm + nodem;
  const xlmMod = xlm % TWOPI;
  argpm %= TWOPI;
  const nodemMod = nodem % TWOPI;
  mm = (xlmMod - argpm - nodemMod) % TWOPI;

  const nm = XKE / (am ** 1.5);

  // Solve Kepler's equation for (E + ω).
  const axnl = emClamped * Math.cos(argpm);
  const aynl = emClamped * Math.sin(argpm) + (1.0 / (am * (1.0 - emClamped * emClamped))) * s.aycof;
  const xl = mm + argpm + nodemMod + (1.0 / (am * (1.0 - emClamped * emClamped))) * s.xlcof * axnl;

  let u = (xl - nodemMod) % TWOPI;
  let eo1 = u;
  let tem5 = 9999.9;
  let ktr = 1;
  let sineo1 = 0;
  let coseo1 = 0;
  while (Math.abs(tem5) >= 1.0e-12 && ktr <= 10) {
    sineo1 = Math.sin(eo1);
    coseo1 = Math.cos(eo1);
    tem5 = 1.0 - coseo1 * axnl - sineo1 * aynl;
    tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
    if (Math.abs(tem5) >= 0.95) tem5 = tem5 > 0.0 ? 0.95 : -0.95;
    eo1 += tem5;
    ktr += 1;
  }

  // Short-period periodics → position and velocity.
  const ecose = axnl * coseo1 + aynl * sineo1;
  const esine = axnl * sineo1 - aynl * coseo1;
  const el2 = axnl * axnl + aynl * aynl;
  const pl = am * (1.0 - el2);
  if (pl < 0.0) return null;

  const rl = am * (1.0 - ecose);
  const rdotl = Math.sqrt(am) / rl * esine;
  const rvdotl = Math.sqrt(pl) / rl;
  const betal = Math.sqrt(1.0 - el2);
  const temp0 = esine / (1.0 + betal);
  const sinu = am / rl * (sineo1 - aynl - axnl * temp0);
  const cosu = am / rl * (coseo1 - axnl + aynl * temp0);
  let su = Math.atan2(sinu, cosu);
  const sin2u = (cosu + cosu) * sinu;
  const cos2u = 1.0 - 2.0 * sinu * sinu;
  const tempP = 1.0 / pl;
  const temp1 = 0.5 * J2 * tempP;
  const temp2 = temp1 * tempP;

  const mrt = rl * (1.0 - 1.5 * temp2 * betal * s.x3thm1)
    + 0.5 * temp1 * s.x1mth2 * cos2u;
  su -= 0.25 * temp2 * s.x7thm1 * sin2u;
  const xnode = nodemMod + 1.5 * temp2 * s.cosio * sin2u;
  const xinc = s.inclo + 1.5 * temp2 * s.cosio * s.sinio * cos2u;
  const mvt = rdotl - nm * temp1 * s.x1mth2 * sin2u / XKE;
  const rvdot = rvdotl + nm * temp1 * (s.x1mth2 * cos2u + 1.5 * s.x3thm1) / XKE;

  // Orientation vectors.
  const sinsu = Math.sin(su);
  const cossu = Math.cos(su);
  const snod = Math.sin(xnode);
  const cnod = Math.cos(xnode);
  const sini = Math.sin(xinc);
  const cosi = Math.cos(xinc);
  const xmx = -snod * cosi;
  const xmy = cnod * cosi;
  const ux = xmx * sinsu + cnod * cossu;
  const uy = xmy * sinsu + snod * cossu;
  const uz = sini * sinsu;
  const vx = xmx * cossu - cnod * sinsu;
  const vy = xmy * cossu - snod * sinsu;
  const vz = sini * cossu;

  const r = [mrt * ux * RADIUSEARTHKM, mrt * uy * RADIUSEARTHKM, mrt * uz * RADIUSEARTHKM];
  const vkmps = XKE * RADIUSEARTHKM / 60.0;
  const v = [
    (mvt * ux + rvdot * vx) * vkmps,
    (mvt * uy + rvdot * vy) * vkmps,
    (mvt * uz + rvdot * vz) * vkmps,
  ];
  return { r, v };
}

/**
 * Rotate a TEME position vector (km) into ECEF (km) for the given UTC date.
 * Polar motion is neglected — sub-metre at LEO, far below the sketch's
 * fidelity and the disc-transit tolerance.
 * @param {number[]} rteme
 * @param {Date} when
 */
export function temeToEcef(rteme, when) {
  const jd = unixToJulian(when.getTime());
  const g = gstime(jd);
  const cosg = Math.cos(g);
  const sing = Math.sin(g);
  return {
    x: (cosg * rteme[0] + sing * rteme[1]) * 1000,    // → metres
    y: (-sing * rteme[0] + cosg * rteme[1]) * 1000,
    z: rteme[2] * 1000,
  };
}

/** Unix ms → Julian date (UTC≈UT1; sub-second, irrelevant for a transit). */
export function unixToJulian(ms) {
  return ms / 86400000.0 + 2440587.5;
}

/**
 * High-level helper: ECEF position (metres) of a satrec at a JS Date.
 * @param {object} satrec
 * @param {Date} when
 * @returns {{x:number,y:number,z:number}|null}
 */
export function propagateEcef(satrec, when) {
  const tsinceMin = (unixToJulian(when.getTime()) - satrec.jdsatepoch) * 1440.0;
  const out = sgp4(satrec, tsinceMin);
  if (!out) return null;
  return temeToEcef(out.r, when);
}
