// Shared satellite Sun/Moon transit finder (v0.47.1). Propagates a TLE
// catalogue with the app's own SGP4 + topocentric geometry and reports every
// satellite that came within a threshold of the Sun/Moon around an instant.
// Used by BOTH the CLI (scripts/find-sun-transit.js) and the browser API
// (/api/sat-transit) so there is one source of truth.

import { twoline2satrec, propagateEcef } from './sgp4.js';
import { observerEcef, targetEcefAzEl, bodyAzEl, angularSeparationDeg } from './geometry.js';

export const DISC_DEG = { Sun: 0.525, Moon: 0.52 };

/** Parse a TLE text blob (optionally with name lines) into {name,norad,satrec}. */
export function parseTle(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const sats = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      const prev = lines[i - 1] ?? '';
      const name = (i > 0 && !prev.startsWith('1 ') && !prev.startsWith('2 ') ? prev : '').trim()
        || `NORAD ${lines[i].slice(2, 7)}`;
      try {
        sats.push({ name, norad: lines[i].slice(2, 7).trim(), satrec: twoline2satrec(lines[i], lines[i + 1]) });
      } catch { /* skip unparseable */ }
      i += 1;
    }
  }
  return sats;
}

// Cached Celestrak fetch — the catalogue is ~2-3 MB / 15k sats, so reuse it for
// a few hours and never hammer Celestrak (one fetch per group per cacheMs).
const _tleCache = new Map();   // group → { atMs, sats }
export async function fetchActiveTles({ fetchImpl = fetch, group = 'active', cacheMs = 6 * 3600_000, nowMs = Date.now() } = {}) {
  const hit = _tleCache.get(group);
  if (hit && (nowMs - hit.atMs) < cacheMs) return hit.sats;
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Celestrak HTTP ${res.status}`);
  const sats = parseTle(await res.text());
  if (!sats.length) throw new Error('Celestrak returned no usable TLEs');
  _tleCache.set(group, { atMs: nowMs, sats });
  return sats;
}

/**
 * Find satellites that pass within `sepDeg` of the body around `whenMs`.
 * @param {{observer:object, sats:Array, whenMs:number, windowS?:number,
 *   sepDeg?:number, body?:string, stepMs?:number}} o
 * @returns {{ body:string, bodyAt:object, scanned:number, discDeg:number, hits:Array }}
 */
export function findBodyTransits({ observer, sats, whenMs, windowS = 12, sepDeg = 2, body = 'Sun', stepMs = 250 }) {
  const discDeg = DISC_DEG[body] ?? 0.53;
  const obsEcef = observerEcef(observer);
  const lat = observer.latitudeDeg; const lon = observer.longitudeDeg;
  const t0 = new Date(whenMs);
  const bodyAt0 = bodyAzEl(observer, body, t0);

  const azElAt = (satrec, when) => {
    const ecef = propagateEcef(satrec, when);
    return ecef ? targetEcefAzEl(obsEcef, lat, lon, ecef) : null;
  };

  // Coarse pass at t0 → keep anything within ~5° (or sepDeg+3) of the body.
  const survivors = [];
  for (const s of sats) {
    const ae = azElAt(s.satrec, t0);
    if (!ae || ae.elevationDeg < -2) continue;
    if (angularSeparationDeg(ae, bodyAt0) <= Math.max(5, sepDeg + 3)) survivors.push(s);
  }

  // Fine scan ±window for the survivors → min sep, speed, direction.
  const hits = [];
  for (const s of survivors) {
    let best = null;
    for (let dt = -windowS * 1000; dt <= windowS * 1000; dt += stepMs) {
      const when = new Date(whenMs + dt);
      const ae = azElAt(s.satrec, when);
      if (!ae) continue;
      const sep = angularSeparationDeg(ae, bodyAzEl(observer, body, when));
      if (!best || sep < best.sep) best = { sep, dt, ae };
    }
    if (!best || best.sep > sepDeg) continue;
    const a1 = azElAt(s.satrec, new Date(whenMs + best.dt - 500));
    const a2 = azElAt(s.satrec, new Date(whenMs + best.dt + 500));
    const omega = a1 && a2 ? angularSeparationDeg(a1, a2) : null;       // deg per 1 s
    const eastward = a1 && a2 ? (((a2.azimuthDeg - a1.azimuthDeg + 540) % 360) - 180) > 0 : null;
    hits.push({
      name: s.name, norad: s.norad,
      sepDeg: best.sep, atMs: whenMs + best.dt,
      elevationDeg: best.ae.elevationDeg, azimuthDeg: best.ae.azimuthDeg,
      rangeKm: (best.ae.rangeM ?? 0) / 1000,
      speedDegPerS: omega, crossingS: omega ? discDeg / omega : null,
      eastward, onDisc: best.sep < discDeg / 2,
    });
  }
  hits.sort((a, b) => a.sepDeg - b.sepDeg);
  return { body, bodyAt: bodyAt0, scanned: sats.length, discDeg, hits };
}
