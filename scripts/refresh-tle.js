#!/usr/bin/env node
// Opt-in ISS TLE fetcher. Writes data/iss.tle so the offline SGP4 in
// src/iss.js has fresh elements. The running service never fetches anything
// itself (Pi-friendly, offline by default) — this script is the only network
// touch, run it from cron / a systemd timer once or twice a day.
//
//   node scripts/refresh-tle.js                       # → ./data/iss.tle
//   node scripts/refresh-tle.js /opt/stp/data/iss.tle # explicit path
//
// A TLE older than ~3 days noticeably degrades ISS transit timing, so a
// daily refresh is recommended. Exits non-zero on failure so a timer/cron
// surfaces the problem instead of silently serving a stale element set.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ISS (ZARYA) = NORAD catalogue number 25544. Celestrak's gp.php returns the
// current public element set in classic 2-line (plus name) form.
const CATNR = 25544;
const URL = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${CATNR}&FORMAT=tle`;
const OUT = resolve(process.argv[2] || './data/iss.tle');
const TIMEOUT_MS = 15000;

function log(...a) { console.log('[refresh-tle]', ...a); }

async function main() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let text;
  try {
    const res = await fetch(URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = (await res.text()).trim();
  } finally {
    clearTimeout(timer);
  }

  const lines = text.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  // Accept the 3-line (name + L1 + L2) form; sanity-check the element lines.
  const l1 = lines.find(l => l.startsWith('1 '));
  const l2 = lines.find(l => l.startsWith('2 '));
  if (!l1 || !l2 || !l1.includes('25544') ) {
    throw new Error(`unexpected payload (no valid ISS TLE):\n${text.slice(0, 200)}`);
  }

  const dir = dirname(OUT);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(OUT, `${text}\n`, 'utf8');
  log(`wrote ${OUT}`);
  log(l1);
  log(l2);
}

main().catch((e) => {
  console.error('[refresh-tle] failed:', e?.message ?? e);
  process.exit(1);
});
