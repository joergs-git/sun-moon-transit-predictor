// Service orchestrator: ties the ADS-B poller, transit detector, route
// lookup, notifier, history store and HTTP server together. Exposes a single
// `runService(config)` entry point used by bin/stp.js and exercised by tests.

import { fetchAircraft } from './adsb.js';
import { RouteLookup } from './adsbdb.js';
import { bodyAzEl, isObservable } from './geometry.js';
import { Notifier } from './notifier.js';
import { PushoverClient } from './pushover.js';
import { createHttpServer } from './server.js';
import { HistoryStore } from './store.js';
import { findTransits } from './tracker.js';

export const DEFAULT_CONFIG = {
  adsb: {
    url: 'http://localhost:8080/data/aircraft.json',
    pollIntervalMs: 2000,
  },
  tracker: {
    horizonS: 60,
    stepS: 1,
    thresholdDeg: 0.3,
    bodies: ['Sun', 'Moon'],
  },
  pushover: { token: '', user: '', device: '', enabled: false },
  server: { port: 8081, host: '0.0.0.0', publicUrl: '' },
  store: { path: './data/history.db' },
  routes: { enabled: true, ttlMs: 3600_000, negativeTtlMs: 300_000 },
  webRoot: 'web',
};

function snapshotBody(observer, body, nowMs) {
  const azel = bodyAzEl(observer, body, new Date(nowMs));
  return {
    azimuthDeg: azel.azimuthDeg,
    elevationDeg: azel.elevationDeg,
    rangeM: azel.rangeM,
    observable: isObservable(azel),
  };
}

function mergeConfig(user) {
  return {
    ...DEFAULT_CONFIG,
    ...user,
    adsb:    { ...DEFAULT_CONFIG.adsb,    ...(user.adsb    ?? {}) },
    tracker: { ...DEFAULT_CONFIG.tracker, ...(user.tracker ?? {}) },
    pushover:{ ...DEFAULT_CONFIG.pushover,...(user.pushover?? {}) },
    server:  { ...DEFAULT_CONFIG.server,  ...(user.server  ?? {}) },
    store:   { ...DEFAULT_CONFIG.store,   ...(user.store   ?? {}) },
    routes:  { ...DEFAULT_CONFIG.routes,  ...(user.routes  ?? {}) },
  };
}

/**
 * Start the full service. Returns a handle with .stop().
 *
 * @param {{
 *   observer: import('./geometry.js').Observer,
 *   config?: object,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   fetchImpl?: typeof fetch,
 *   noServer?: boolean,
 *   store?: HistoryStore,
 * }} args
 */
export async function runService({
  observer,
  config: userConfig = {},
  logger = console,
  fetchImpl = fetch,
  noServer = false,
  store: providedStore,
}) {
  const config = mergeConfig(userConfig);
  const store = providedStore ?? new HistoryStore(config.store.path);
  const pushover = new PushoverClient(config.pushover, { fetchImpl });
  const routeLookup = config.routes.enabled
    ? new RouteLookup({ fetchImpl, ttlMs: config.routes.ttlMs, negativeTtlMs: config.routes.negativeTtlMs })
    : { lookup: async () => null };

  const notifier = new Notifier({
    pushover,
    routeLookup: (cs) => routeLookup.lookup(cs),
    onEvent: (evt) => {
      try { store.recordEvent(evt.stage, evt.candidate, evt.route, Date.now()); }
      catch (e) { logger.error?.('store record failed:', e); }
    },
    baseUrl: config.server.publicUrl || undefined,
  });

  const state = {
    observer,
    nowMs: Date.now(),
    lastUpdateMs: 0,
    aircraftCount: 0,
    bodies: {},
    candidates: [],
  };

  const httpServer = noServer ? null : createHttpServer({
    port: config.server.port,
    host: config.server.host,
    getState: () => state,
    store,
    webRoot: config.webRoot,
  });
  if (httpServer) await httpServer.start();

  let stopping = false;
  let intervalHandle = null;

  async function tick() {
    const nowMs = Date.now();
    state.nowMs = nowMs;
    state.bodies = Object.fromEntries(
      config.tracker.bodies.map((b) => [b, snapshotBody(observer, b, nowMs)]),
    );

    let aircraft = [];
    try {
      aircraft = await fetchAircraft(config.adsb.url, { fetchImpl });
    } catch (e) {
      logger.warn?.('aircraft fetch failed:', e?.message ?? e);
    }
    state.aircraftCount = aircraft.length;

    const candidates = findTransits(observer, aircraft, nowMs, config.tracker);

    const enriched = await Promise.all(candidates.map(async (c) => {
      let route = null;
      if (c.callsign) {
        try { route = await routeLookup.lookup(c.callsign); } catch { /* ignore */ }
      }
      return { ...c, route };
    }));
    state.candidates = enriched;
    state.lastUpdateMs = nowMs;

    try {
      await notifier.tick(candidates, nowMs);
    } catch (e) {
      logger.error?.('notifier tick failed:', e);
    }
  }

  // initial tick (await so the first /api/state has data)
  await tick();
  intervalHandle = setInterval(() => {
    if (stopping) return;
    tick().catch((e) => logger.error?.('tick failed:', e));
  }, config.adsb.pollIntervalMs);

  return {
    state,
    httpServer,
    notifier,
    store,
    config,
    async stop() {
      stopping = true;
      if (intervalHandle) clearInterval(intervalHandle);
      if (httpServer) await httpServer.stop();
      store.close();
    },
  };
}
