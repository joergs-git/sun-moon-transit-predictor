#!/usr/bin/env node
// Opt-in satellite TLE fetcher. Writes data/<sat>.tle so the offline SGP4 in
// src/iss.js has fresh elements for every catalogued target (ISS + the extra
// satellites in config.iss.satellites — HST, Tiangong, …). The running service
// never fetches anything itself (Pi-friendly, offline by default) — this script
// is the only network touch; run it from cron / a systemd timer once or twice
// a day.
//
//   node scripts/refresh-tle.js                       # → all satellites → ./data/*.tle
//   node scripts/refresh-tle.js /opt/stp/data/iss.tle # legacy: ISS only, explicit path
//
// A TLE older than ~3 days noticeably degrades transit timing (the cross-track
// drift grows ~1–3 km/day), so a daily refresh is recommended. Exits non-zero
// if EVERY satellite fails, so a timer/cron surfaces a total outage; a partial
// failure (one satellite unreachable) is logged but does not fail the run.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Celestrak's gp.php returns the current public element set in classic 2-line
// (plus name) form. Catalogue numbers:
//   25544 = ISS (ZARYA)            — the easy ~50″ target
//   20580 = HST (Hubble)           — a tough ~5″ target
//   48274 = CSS / Tianhe (Tiangong) — ~20″, the easiest after the ISS
// Keep this list in sync with config.iss (tlePath) + config.iss.satellites.
const SATS = [
  { catnr: 25544, out: './data/iss.tle' },
  { catnr: 20580, out: './data/hst.tle' },
  { catnr: 48274, out: './data/tiangong.tle' },
];
const TIMEOUT_MS = 15000;

function log(...a) { console.log('[refresh-tle]', ...a); }

/** Fetch one satellite's TLE from Celestrak and write it to disk. */
async function fetchOne({ catnr, out }) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${catnr}&FORMAT=tle`;
  const outPath = resolve(out);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let text;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = (await res.text()).trim();
  } finally {
    clearTimeout(timer);
  }

  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  // Accept the 3-line (name + L1 + L2) form; sanity-check the element lines and
  // confirm the catalogue number matches what we asked for (gp.php returns an
  // HTML/empty error page on a bad/decayed CATNR rather than a 4xx).
  const l1 = lines.find((l) => l.startsWith('1 '));
  const l2 = lines.find((l) => l.startsWith('2 '));
  if (!l1 || !l2 || !l1.includes(String(catnr))) {
    throw new Error(`unexpected payload (no valid TLE for ${catnr}):\n${text.slice(0, 200)}`);
  }

  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, `${text}\n`, 'utf8');
  log(`wrote ${outPath}`);
  log(`  ${l1}`);
}

async function main() {
  // Legacy single-path mode: `refresh-tle.js <path>` fetches only the ISS to
  // that path, preserving the original behaviour / any existing cron entry.
  const targets = process.argv[2]
    ? [{ catnr: 25544, out: process.argv[2] }]
    : SATS;

  let ok = 0;
  let failed = 0;
  for (const sat of targets) {
    try {
      await fetchOne(sat);
      ok += 1;
    } catch (e) {
      failed += 1;
      console.error(`[refresh-tle] ${sat.catnr} failed:`, e?.message ?? e);
    }
  }
  log(`done: ${ok} ok, ${failed} failed`);
  // Only a total wipe-out is a hard error — one unreachable satellite must not
  // block the others (e.g. the ISS refreshing while HST momentarily 404s).
  if (ok === 0) process.exit(1);
}

main().catch((e) => {
  console.error('[refresh-tle] failed:', e?.message ?? e);
  process.exit(1);
});
