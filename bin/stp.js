#!/usr/bin/env node
// Entry point for the Sun-Moon Transit Predictor service.
// Run with `--experimental-sqlite` on Node 22 (stable on Node 24+):
//   node --experimental-sqlite bin/stp.js
//
// Reads:
//   config/observer.json   (location)
//   config/service.json    (URLs, intervals, Pushover, …) — falls back to
//                          DEFAULT_CONFIG from src/service.js when absent.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadObserver } from '../src/config.js';
import { runService } from '../src/service.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJsonIfExists(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

const observerPath = process.env.STP_OBSERVER ?? resolve(ROOT, 'config', 'observer.json');
const servicePath  = process.env.STP_CONFIG   ?? resolve(ROOT, 'config', 'service.json');

const observer = loadObserver(observerPath);
const config = readJsonIfExists(servicePath);
config.webRoot = config.webRoot ?? resolve(ROOT, 'web');
config.store = config.store ?? {};
if (!config.store.path) config.store.path = resolve(ROOT, 'data', 'history.db');
// Default lifecycle snapshot to data/lifecycle.json so the tracking panel
// survives the nightly auto-update timer and any other restart.
config.lifecyclePersist = config.lifecyclePersist ?? {};
if (!config.lifecyclePersist.path) {
  config.lifecyclePersist.path = resolve(ROOT, 'data', 'lifecycle.json');
}

const service = await runService({
  observer,
  config,
  configPaths: { observer: observerPath, service: servicePath },
});

const addr = service.httpServer?.address();
console.log(`stp listening on http://${addr?.address ?? '?'}:${addr?.port ?? '?'} ` +
            `(observer: ${observer.name ?? '-'}, ${observer.latitudeDeg}, ${observer.longitudeDeg})`);
console.log(`adsb url: ${service.config.adsb.url}`);
console.log(`pushover: ${service.config.pushover.enabled ? 'enabled' : 'disabled'}`);

const shutdown = async (sig) => {
  console.log(`received ${sig}, shutting down`);
  await service.stop();
  process.exit(0);
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
