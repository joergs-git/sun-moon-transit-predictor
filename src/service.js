// Service orchestrator: ties the ADS-B poller, transit detector, route
// lookup, notifier, history store and HTTP server together. Exposes a single
// `runService(config)` entry point used by bin/stp.js and exercised by tests.

import { fetchAircraft } from './adsb.js';
import { RouteLookup } from './adsbdb.js';
import { bodyAzEl, isObservable } from './geometry.js';
import { lifecycleArray, updateLifecycle } from './lifecycle.js';
import { Notifier } from './notifier.js';
import {
  buildWatchlist,
  observationsFromHistory,
  upcomingExpected,
} from './predictor.js';
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
    horizonS: 300,            // 5-minute look-ahead by default
    stepS: 0.5,
    thresholdDeg: 0.3,        // tight band → 'candidate' level
    looseThresholdDeg: 5.0,   // wider band → 'radio' level (early warning)
    bodies: ['Sun', 'Moon'],
  },
  pushover: {
    token: '', user: '', device: '', enabled: false,
    minStage: 'radio',        // default: emit all three stages
  },
  lifecycle: {
    plannedWindowMs: 3600_000,    // surface watchlist entries within ±1 h
    imminentWindowMs: 30_000,     // ±30 s around closest-approach → imminent
    staleGraceMs: 60_000,         // keep dropped contacts visible for 1 min
    maxEntries: 20,               // tracking-list cap; oldest stale FIFO-out
  },
  server: { port: 8081, host: '0.0.0.0', publicUrl: '' },
  store: { path: './data/history.db' },
  routes: { enabled: true, ttlMs: 3600_000, negativeTtlMs: 300_000 },
  predictor: {
    enabled: true,
    daysBack: 14,             // history window for the watchlist
    minRepeats: 2,            // min distinct days a (flight,body) must hit
    bucketMinutes: 60,        // time-of-day binning width — coarse enough to absorb day-to-day jitter, fine enough that the median predicted time is meaningful to ~1 h
    rebuildIntervalMs: 3600_000,   // re-scan history every hour
    lookAheadMs: 24 * 3600_000,    // surface expected events for the next 24 h
  },
  // Optional: feed schedule_observations (populated by scripts/refresh-schedule.js)
  // into the predictor as additional observations alongside transit_history.
  // The fetcher script is opt-in (opensky.enabled=true + airports list); this
  // flag only controls whether the running service *consumes* whatever rows
  // already exist in the schedule_observations table.
  opensky: {
    enabled: false,
    airports: [],             // ICAO codes the refresh script should pull from
    lookbackDays: 7,
  },
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
    adsb:      { ...DEFAULT_CONFIG.adsb,      ...(user.adsb      ?? {}) },
    tracker:   { ...DEFAULT_CONFIG.tracker,   ...(user.tracker   ?? {}) },
    pushover:  { ...DEFAULT_CONFIG.pushover,  ...(user.pushover  ?? {}) },
    server:    { ...DEFAULT_CONFIG.server,    ...(user.server    ?? {}) },
    store:     { ...DEFAULT_CONFIG.store,     ...(user.store     ?? {}) },
    routes:    { ...DEFAULT_CONFIG.routes,    ...(user.routes    ?? {}) },
    predictor: { ...DEFAULT_CONFIG.predictor, ...(user.predictor ?? {}) },
    opensky:   { ...DEFAULT_CONFIG.opensky,   ...(user.opensky   ?? {}) },
    lifecycle: { ...DEFAULT_CONFIG.lifecycle, ...(user.lifecycle ?? {}) },
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
    minStage: config.pushover.minStage ?? 'radio',
    imminentWindowMs: config.lifecycle.imminentWindowMs,
    baseUrl: config.server.publicUrl || undefined,
  });

  const state = {
    observer,
    nowMs: Date.now(),
    lastUpdateMs: 0,
    aircraftCount: 0,
    bodies: {},
    candidates: [],            // backward-compat: tracker output (live)
    expected: [],              // backward-compat: predictor watchlist (24 h)
    lifecycle: [],             // primary unified view used by the new UI
    watchlistMeta: { lastBuildMs: 0, entries: 0 },
  };

  // Lifecycle map persists across ticks — that's what gives the UI the
  // "no candidate anymore" grace period and a single dynamic list to read.
  /** @type {Map<string, import('./lifecycle.js').LifecycleEntry>} */
  let lifecycleMap = new Map();

  // History-based predictor — pulled into the tick loop so /api/state stays
  // a single source of truth. Re-build the watchlist on a slow cadence
  // (default hourly) since `transit_history` only grows by ~10 rows/day in
  // typical operation. Pluggable observation source: anything that returns
  // {flight, body, timestampMs} arrays can be merged in (OpenSky, manual
  // imports, etc.) — see attachExtraObservations below.
  let watchlist = [];
  let watchlistBuiltAtMs = 0;
  /** @type {(() => Promise<import('./predictor.js').Observation[]>)[]} */
  const extraObservationSources = [];

  async function rebuildWatchlist(nowMs) {
    if (!config.predictor.enabled) {
      watchlist = [];
      return;
    }
    try {
      const localObs = observationsFromHistory(store, {
        nowMs,
        daysBack: config.predictor.daysBack,
      });
      let combined = localObs;
      for (const src of extraObservationSources) {
        try {
          const extra = await src();
          if (Array.isArray(extra)) combined = combined.concat(extra);
        } catch (e) {
          logger.warn?.('extra observation source failed:', e?.message ?? e);
        }
      }
      watchlist = buildWatchlist(combined, {
        nowMs,
        daysBack: config.predictor.daysBack,
        minRepeats: config.predictor.minRepeats,
        bucketMinutes: config.predictor.bucketMinutes,
      });
      watchlistBuiltAtMs = nowMs;
      state.watchlistMeta = { lastBuildMs: nowMs, entries: watchlist.length };
    } catch (e) {
      logger.error?.('watchlist rebuild failed:', e);
    }
  }

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

    const trackerOpts = {
      ...config.tracker,
      geoidUndulationM: observer.geoidUndulationM ?? config.tracker.geoidUndulationM ?? 0,
    };
    const candidates = findTransits(observer, aircraft, nowMs, trackerOpts);

    // Single route lookup per candidate, shared by /api/state and notifier.
    const enriched = await Promise.all(candidates.map(async (c) => {
      let route = null;
      if (c.callsign) {
        try { route = await routeLookup.lookup(c.callsign); } catch { /* ignore */ }
      }
      return { ...c, route };
    }));
    state.candidates = enriched;
    state.lastUpdateMs = nowMs;

    // Refresh the predictor watchlist on the configured cadence, then surface
    // upcoming-today expected events. The rebuild is async but cheap (single
    // SELECT) — it runs at most once per `rebuildIntervalMs`.
    if (config.predictor.enabled
        && nowMs - watchlistBuiltAtMs >= config.predictor.rebuildIntervalMs) {
      await rebuildWatchlist(nowMs);
    }
    state.expected = upcomingExpected(watchlist, nowMs, config.predictor.lookAheadMs);

    // Unified lifecycle state — merges live tracker + watchlist + previous
    // tick's contacts. The notifier still drives Pushover; the lifecycle
    // adds visibility for 'planned' and 'stale' states which never push but
    // matter in the UI.
    lifecycleMap = updateLifecycle({
      prev: lifecycleMap,
      nowMs,
      trackerCandidates: enriched,
      expected: state.expected,
      liveAircraft: aircraft,
      imminentWindowMs: config.lifecycle.imminentWindowMs,
      plannedWindowMs: config.lifecycle.plannedWindowMs,
      staleGraceMs: config.lifecycle.staleGraceMs,
      maxEntries: config.lifecycle.maxEntries,
    });
    state.lifecycle = lifecycleArray(lifecycleMap, nowMs);

    try {
      await notifier.tick(enriched, nowMs);
    } catch (e) {
      logger.error?.('notifier tick failed:', e);
    }
  }

  // If schedule augmentation is enabled, pull rows from schedule_observations
  // each time the watchlist is rebuilt. The refresh script populates the
  // table on its own cadence (cron / systemd timer); this just consumes.
  if (config.opensky?.enabled) {
    extraObservationSources.push(async () => {
      const sinceMs = Date.now() - config.predictor.daysBack * 24 * 3600_000;
      return store.scheduleObservations({ sinceMs, source: 'opensky' });
    });
  }

  // initial tick (await so the first /api/state has data)
  await rebuildWatchlist(Date.now());
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
    /**
     * Register an additional observation source (called on each watchlist
     * rebuild). Used by the optional OpenSky integration to augment local
     * history with public schedule data.
     * @param {() => Promise<import('./predictor.js').Observation[]>} fn
     */
    addObservationSource(fn) { extraObservationSources.push(fn); },
    async stop() {
      stopping = true;
      if (intervalHandle) clearInterval(intervalHandle);
      if (httpServer) await httpServer.stop();
      store.close();
    },
  };
}
