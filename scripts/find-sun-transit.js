#!/usr/bin/env node
// Which satellite crossed the Sun (or Moon) at a given time + place? (v0.47.1)
// Thin CLI over src/sattransit.js — the same core the browser "🛰 Sat-transit
// search" (/api/sat-transit) uses.
//
// Run ON THE PI (needs internet for the TLEs), from the repo root:
//   node scripts/find-sun-transit.js --time 2026-06-18T19:23:30
//        (no 'Z' → local time; append Z for UTC)
// Options: --window <s> (8) · --sep <deg> (1.5) · --body Sun|Moon ·
//          --group <name> (active) · --tle <file> (offline) · --lat --lon --elev

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseTle, fetchActiveTles, findBodyTransits } from '../src/sattransit.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };

function loadObserver() {
  let o = {};
  try { o = JSON.parse(readFileSync(join(REPO, 'config', 'observer.json'), 'utf8')); } catch { /* defaults */ }
  return {
    latitudeDeg: Number(arg('lat', o.latitudeDeg)),
    longitudeDeg: Number(arg('lon', o.longitudeDeg)),
    elevationM: Number(arg('elev', o.elevationM ?? 0)),
  };
}

async function main() {
  const observer = loadObserver();
  if (!Number.isFinite(observer.latitudeDeg) || !Number.isFinite(observer.longitudeDeg)) {
    console.error('No observer location (config/observer.json or --lat/--lon).'); process.exit(1);
  }
  const body = arg('body', 'Sun');
  const t0 = arg('time') ? new Date(arg('time')) : new Date();
  if (Number.isNaN(t0.getTime())) { console.error('Bad --time. e.g. 2026-06-18T19:23:30 (local) or ...Z (UTC).'); process.exit(1); }
  const windowS = Number(arg('window', 8));
  const sepDeg = Number(arg('sep', 1.5));

  const file = arg('tle');
  let sats;
  if (file) sats = parseTle(readFileSync(resolve(file), 'utf8'));
  else { process.stderr.write(`Fetching Celestrak GROUP=${arg('group', 'active')} TLEs…\n`); sats = await fetchActiveTles({ group: arg('group', 'active') }); }

  const r = findBodyTransits({ observer, sats, whenMs: t0.getTime(), windowS, sepDeg, body });
  process.stderr.write(`Observer ${observer.latitudeDeg.toFixed(3)},${observer.longitudeDeg.toFixed(3)} · ${body} at ${t0.toISOString()} → az ${r.bodyAt.azimuthDeg.toFixed(1)}° el ${r.bodyAt.elevationDeg.toFixed(1)}° · scanned ${r.scanned}\n`);

  if (!r.hits.length) {
    console.log(`\nNo satellite within ${sepDeg}° of the ${body} in ±${windowS} s. Try a wider --window/--sep, or --group starlink/visual.`);
    return;
  }
  console.log(`\n${r.hits.length} satellite(s) within ${sepDeg}° of the ${body} disc (${r.discDeg}°):\n`);
  console.log('min-sep   when(UTC)  NORAD   sat                            el   range    speed    ~disc  dir');
  for (const h of r.hits.slice(0, 30)) {
    console.log(
      `${h.sepDeg.toFixed(3)}°  ${new Date(h.atMs).toISOString().slice(11, 19)}  ${h.norad.padStart(5)}  `
      + `${h.name.slice(0, 28).padEnd(28)}  ${h.elevationDeg.toFixed(0).padStart(2)}° ${h.rangeKm.toFixed(0).padStart(5)}km  `
      + `${h.speedDegPerS ? h.speedDegPerS.toFixed(3) + '°/s' : '  ?  '}  ${h.crossingS ? h.crossingS.toFixed(1) + 's' : ' ? '}  `
      + `${h.eastward == null ? '?' : (h.eastward ? '→E' : '→W')}${h.onDisc ? ' ★ON DISC' : ''}`);
  }
  console.log('\n(Match what you saw: a ~5 s, WNW→E crossing → ~0.1–0.2°/s, dir →E, low elevation.)');
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
