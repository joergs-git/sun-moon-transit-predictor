#!/usr/bin/env node
// Offline history analysis (v0.41.0) — thin CLI over the shared src/stats.js
// report core (the same module the browser /api/stats/report* endpoints use).
//
// Run ON THE PI, from the repo root, with the same Node the service uses:
//   node --experimental-sqlite scripts/analyze-history.js            # text
//   node --experimental-sqlite scripts/analyze-history.js --csv       # CSV
//   node --experimental-sqlite scripts/analyze-history.js --json      # JSON
//   node --experimental-sqlite scripts/analyze-history.js /path/to/history.db
// (Node 24+ has node:sqlite stable, so the flag is optional there.)
//
// Prefer the browser: ⚙→📊 Statistics in the web UI generates, shows and
// downloads the same report without any SSH.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveDbPath(argPath) {
  if (argPath) return resolve(argPath);
  try {
    const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'service.json'), 'utf8'));
    if (cfg?.store?.path) return resolve(REPO_ROOT, cfg.store.path);
  } catch { /* no user config */ }
  return join(REPO_ROOT, 'data', 'history.db');
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--csv') ? 'csv' : args.includes('--json') ? 'json' : 'text';
  const pathArg = args.find((a) => !a.startsWith('--'));
  const dbPath = resolveDbPath(pathArg);
  if (!existsSync(dbPath)) {
    console.error(`No history DB at ${dbPath}\nPass the path: node --experimental-sqlite scripts/analyze-history.js /path/to/history.db`);
    process.exit(1);
  }

  let HistoryStore, stats;
  try {
    ({ HistoryStore } = await import('../src/store.js'));
    stats = await import('../src/stats.js');
  } catch (e) {
    console.error('Failed to load the analysis modules. On Node 22/23 run with the flag:\n  node --experimental-sqlite scripts/analyze-history.js\n\n' + (e?.message ?? e));
    process.exit(1);
  }

  const store = new HistoryStore(dbPath);
  const report = stats.buildReport(store, { dbPath });
  store.close();

  if (mode === 'json') process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (mode === 'csv') process.stdout.write(stats.formatCsv(report));
  else process.stdout.write(stats.formatText(report) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
