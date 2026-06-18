#!/usr/bin/env node
// Which satellite crossed the Sun (or Moon) at a given time + place? (v0.47.0)
//
// Propagates the WHOLE active-satellite catalogue (Celestrak) with the app's
// own SGP4 and reports every satellite that came within a threshold of the
// Sun/Moon around the requested instant — with its angular speed and the
// estimated disc-crossing time, so you can match what you saw (e.g. "≈5 s,
// WNW→E"). Reuses src/sgp4.js + src/geometry.js, so it's identical maths to the
// built-in ISS/HST/Tiangong prediction — just over the full catalogue.
//
// Run ON THE PI (it needs internet for the TLEs), from the repo root:
//   node scripts/find-sun-transit.js --time 2026-06-18T19:23:30
//        (no 'Z' → local time; append Z for UTC: ...T17:23:30Z)
// Options:
//   --time <ISO>     instant to centre on (default: now). Local unless ...Z.
//   --window <s>     half-window scanned each side (default 8)
//   --sep <deg>      report threshold around the body (default 1.5)
//   --body Sun|Moon  which disc (default Sun)
//   --group <name>   Celestrak GROUP (default 'active'; e.g. 'starlink', 'visual')
//   --tle <file>     use a local TLE file instead of fetching (offline)
//   --lat --lon --elev   override the observer (default: config/observer.json)

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { twoline2satrec, propagateEcef } from '../src/sgp4.js';
import { observerEcef, targetEcefAzEl, bodyAzEl, angularSeparationDeg } from '../src/geometry.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISC_DEG = { Sun: 0.525, Moon: 0.52 };

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function loadObserver() {
  let o = {};
  try { o = JSON.parse(readFileSync(join(REPO, 'config', 'observer.json'), 'utf8')); } catch { /* defaults */ }
  return {
    name: o.name ?? 'observer',
    latitudeDeg: Number(arg('lat', o.latitudeDeg)),
    longitudeDeg: Number(arg('lon', o.longitudeDeg)),
    elevationM: Number(arg('elev', o.elevationM ?? 0)),
  };
}

function parseTle(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  const sats = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      const name = (i > 0 && !lines[i - 1].startsWith('1 ') && !lines[i - 1].startsWith('2 ') ? lines[i - 1] : '').trim() || `NORAD ${lines[i].slice(2, 7)}`;
      try { sats.push({ name, norad: lines[i].slice(2, 7).trim(), satrec: twoline2satrec(lines[i], lines[i + 1]) }); }
      catch { /* skip unparseable */ }
      i += 1;
    }
  }
  return sats;
}

async function loadTles() {
  const file = arg('tle');
  if (file) return parseTle(readFileSync(resolve(file), 'utf8'));
  const group = arg('group', 'active');
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  process.stderr.write(`Fetching TLEs: ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Celestrak HTTP ${res.status} — try --tle <file> or another --group`);
  return parseTle(await res.text());
}

async function main() {
  const observer = loadObserver();
  if (!Number.isFinite(observer.latitudeDeg) || !Number.isFinite(observer.longitudeDeg)) {
    console.error('No observer location (config/observer.json or --lat/--lon).'); process.exit(1);
  }
  const body = arg('body', 'Sun');
  const t0 = arg('time') ? new Date(arg('time')) : new Date();
  if (Number.isNaN(t0.getTime())) { console.error('Bad --time. Use e.g. 2026-06-18T19:23:30 (local) or ...Z (UTC).'); process.exit(1); }
  const windowS = Number(arg('window', 8));
  const sepThresh = Number(arg('sep', 1.5));
  const discDeg = DISC_DEG[body] ?? 0.53;

  const obsEcef = observerEcef(observer);
  const bodyAt0 = bodyAzEl(observer, body, t0);
  process.stderr.write(`Observer ${observer.latitudeDeg.toFixed(3)},${observer.longitudeDeg.toFixed(3)} · ${body} at ${t0.toISOString()} → az ${bodyAt0.azimuthDeg.toFixed(1)}° el ${bodyAt0.elevationDeg.toFixed(1)}°\n`);

  const sats = await loadTles();
  process.stderr.write(`Propagating ${sats.length} satellites…\n`);

  const azElAt = (satrec, when) => {
    const ecef = propagateEcef(satrec, when);
    return ecef ? targetEcefAzEl(obsEcef, observer.latitudeDeg, observer.longitudeDeg, ecef) : null;
  };

  // Coarse pass at t0: keep anything within ~5° of the body.
  const survivors = [];
  for (const s of sats) {
    const ae = azElAt(s.satrec, t0);
    if (!ae || ae.elevationDeg < -2) continue;
    if (angularSeparationDeg(ae, bodyAt0) <= Math.max(5, sepThresh + 3)) survivors.push(s);
  }

  // Fine scan ±window at 0.25 s for the survivors → min sep + angular speed.
  const STEP_MS = 250;
  const hits = [];
  for (const s of survivors) {
    let best = null;
    for (let dt = -windowS * 1000; dt <= windowS * 1000; dt += STEP_MS) {
      const when = new Date(t0.getTime() + dt);
      const ae = azElAt(s.satrec, when);
      if (!ae) continue;
      const bd = bodyAzEl(observer, body, when);
      const sep = angularSeparationDeg(ae, bd);
      if (!best || sep < best.sep) best = { sep, dt, ae, bd };
    }
    if (!best || best.sep > sepThresh) continue;
    // Angular speed around the minimum (1 s baseline).
    const a1 = azElAt(s.satrec, new Date(t0.getTime() + best.dt - 500));
    const a2 = azElAt(s.satrec, new Date(t0.getTime() + best.dt + 500));
    const omega = a1 && a2 ? angularSeparationDeg(a1, a2) : null;   // deg per 1 s
    // Eastward? azimuth increasing through the pass.
    const eastward = a1 && a2 ? (((a2.azimuthDeg - a1.azimuthDeg + 540) % 360) - 180) > 0 : null;
    hits.push({
      name: s.name, norad: s.norad, sep: best.sep,
      atMs: t0.getTime() + best.dt,
      el: best.ae.elevationDeg, az: best.ae.azimuthDeg, rangeKm: (best.ae.rangeM ?? 0) / 1000,
      omega, crossingS: omega ? discDeg / omega : null, eastward,
    });
  }

  hits.sort((a, b) => a.sep - b.sep);
  if (!hits.length) {
    console.log(`\nNo satellite within ${sepThresh}° of the ${body} in ±${windowS} s. Try a wider --window/--sep, or --group active vs starlink/visual.`);
    return;
  }
  console.log(`\n${hits.length} satellite(s) within ${sepThresh}° of the ${body} disc (${discDeg}°):\n`);
  console.log('min-sep   when (UTC)        sat                              el    range   speed     ~disc   dir');
  for (const h of hits.slice(0, 25)) {
    const onDisc = h.sep < discDeg / 2 ? ' ★ON DISC' : '';
    console.log(
      `${h.sep.toFixed(3)}°  ${new Date(h.atMs).toISOString().slice(11, 19)}  ${h.name.slice(0, 30).padEnd(30)}  `
      + `${h.el.toFixed(0).padStart(2)}°  ${h.rangeKm.toFixed(0).padStart(5)}km  `
      + `${h.omega ? (h.omega.toFixed(3) + '°/s') : '  ?  '}  ${h.crossingS ? h.crossingS.toFixed(1) + 's' : ' ? '}  `
      + `${h.eastward == null ? '?' : (h.eastward ? '→E' : '→W')}${onDisc}`);
  }
  console.log('\n(Match what you saw: a ~5–6 s, WNW→E crossing → look for ~0.09°/s, ~5–6 s "~disc", dir →E.)');
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
