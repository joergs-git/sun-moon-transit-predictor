#!/usr/bin/env node
// Pulls historical arrivals + departures at the airports listed in
// config/service.json → opensky.airports for the past N days, classifies
// each event by which body (Sun / Moon) was observable at the time from the
// configured observer, and stores the result in
// data/history.db → schedule_observations.
//
// Designed for a daily cron / systemd-timer:
//
//   node --experimental-sqlite scripts/refresh-schedule.js
//
// Idempotent: re-running over the same window is a no-op (UNIQUE constraint
// on source+flight+timestamp). Old rows beyond `lookbackDays` are pruned.
//
// Reads:
//   STP_OBSERVER (or config/observer.json)
//   STP_CONFIG   (or config/service.json) — opensky.{enabled,airports,lookbackDays}
//
// Exits 0 on success or when opensky is disabled in config.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadObserver } from '../src/config.js';
import { bodyAzEl, isObservable } from '../src/geometry.js';
import { arrivalsAt, departuresAt, flightToObservation } from '../src/opensky.js';
import { HistoryStore } from '../src/store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const observerPath = process.env.STP_OBSERVER ?? resolve(ROOT, 'config', 'observer.json');
const servicePath  = process.env.STP_CONFIG   ?? resolve(ROOT, 'config', 'service.json');

if (!existsSync(servicePath)) {
  console.error(`config not found: ${servicePath}`);
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(servicePath, 'utf8'));
const opensky = cfg.opensky ?? {};
if (!opensky.enabled) {
  console.log('opensky.enabled=false in service.json — nothing to do.');
  process.exit(0);
}

const airports = Array.isArray(opensky.airports) ? opensky.airports : [];
if (airports.length === 0) {
  console.error('opensky.airports list is empty — refusing to fetch the entire OpenSky dataset.');
  process.exit(1);
}

const lookbackDays = Number(opensky.lookbackDays ?? 7);
const observer = loadObserver(observerPath);
const storePath = cfg.store?.path ?? resolve(ROOT, 'data', 'history.db');
const store = new HistoryStore(storePath);

function bodyForTimestamp(timestampMs) {
  const d = new Date(timestampMs);
  const sun = bodyAzEl(observer, 'Sun', d, { applyRefraction: false });
  if (isObservable(sun)) return 'Sun';
  const moon = bodyAzEl(observer, 'Moon', d, { applyRefraction: false });
  if (isObservable(moon)) return 'Moon';
  return null;
}

const ONE_DAY_S = 24 * 3600;
const nowSec = Math.floor(Date.now() / 1000);
const fetchedAtMs = Date.now();

let totalInserted = 0;
let totalSkippedNoBody = 0;

for (const airport of airports) {
  for (let dayOffset = 0; dayOffset < lookbackDays; dayOffset++) {
    const endSec = nowSec - dayOffset * ONE_DAY_S;
    const beginSec = endSec - ONE_DAY_S;
    for (const kind of ['arrival', 'departure']) {
      const fn = kind === 'arrival' ? arrivalsAt : departuresAt;
      let flights = [];
      try {
        flights = await fn(airport, beginSec, endSec);
      } catch (e) {
        console.warn(`[${airport}] ${kind} ${beginSec}-${endSec} failed: ${e.message}`);
        continue;
      }
      for (const f of flights) {
        const obs = flightToObservation(f, kind, bodyForTimestamp);
        if (!obs) { totalSkippedNoBody++; continue; }
        const inserted = store.recordScheduleObservation({
          source: 'opensky',
          flight: obs.flight,
          body: obs.body,
          timestampMs: obs.timestampMs,
          airport,
          kind,
          fetchedAtMs,
        });
        if (inserted) totalInserted++;
      }
      console.log(`[${airport}] ${kind}  day -${dayOffset}: ${flights.length} flights`);
    }
  }
}

const cutoffMs = Date.now() - lookbackDays * ONE_DAY_S * 1000;
const pruned = store.pruneScheduleOlderThan(cutoffMs);

console.log(`\nrefresh-schedule done: inserted=${totalInserted} skipped(no body)=${totalSkippedNoBody} pruned=${pruned}`);
store.close();
