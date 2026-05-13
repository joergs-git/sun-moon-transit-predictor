// Service orchestrator: ties the ADS-B poller, transit detector, route
// lookup, notifier, history store and HTTP server together. Exposes a single
// `runService(config)` entry point used by bin/stp.js and exercised by tests.

import { promises as fsp, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
    // Drop matches further than this from the tracking panel entirely.
    // Was 5° pre-v0.7.4; lowered after the user's "alles über 2° ist nicht
    // mehr relevant" decision. The Pushover phone-buzz filter is separate
    // (pushover.radioThresholdDeg, default 1°) so you can dial the panel
    // and the notifications independently.
    looseThresholdDeg: 2.0,
    bodies: ['Sun', 'Moon'],
  },
  pushover: {
    token: '', user: '', device: '', enabled: false,
    minStage: 'radio',        // default: emit all three stages
    // Pushover-only filter on the radio band. Tracker still surfaces all
    // matches inside tracker.looseThresholdDeg (default 5°) to the tracking
    // panel, but the phone only buzzes for radio events whose projected
    // separation is at or below this much tighter threshold (default 1°).
    radioThresholdDeg: 1.0,
  },
  lifecycle: {
    plannedWindowMs: 3600_000,    // surface watchlist entries within ±1 h
    imminentWindowMs: 30_000,     // ±30 s around closest-approach → imminent
    staleGraceMs: 0,              // 0 = no time eviction; cap below does FIFO
    maxEntries: 20,               // tracking-list cap; oldest stale dropped first
  },
  server: { port: 8081, host: '0.0.0.0', publicUrl: '' },
  store: { path: './data/history.db' },
  // Optical setup for the FOV sketch popup. Editable from the web Settings
  // panel; persisted into config/service.json so a restart preserves it.
  optics: {
    telescopeFocalMm: 500,
    sensorWmm: 11.34,
    sensorHmm: 7.13,
    sensorPxW: 1936,
    sensorPxH: 1216,
    sensorName: 'ZWO ASI174MM',
  },
  // Where to write the periodic lifecycle snapshot used to repopulate the
  // tracking panel after a service restart. Set to '' to disable persistence.
  lifecyclePersist: {
    path: './data/lifecycle.json',
    snapshotIntervalMs: 30_000,
  },
  // External tools accessible from the web UI footer. dump1090's status page
  // typically lives on port 8080 of the same host that runs this service.
  externalLinks: {
    dump1090Url: '',          // empty → frontend derives from window.location
  },
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
    optics:    { ...DEFAULT_CONFIG.optics,    ...(user.optics    ?? {}) },
    lifecyclePersist: { ...DEFAULT_CONFIG.lifecyclePersist, ...(user.lifecyclePersist ?? {}) },
    externalLinks:    { ...DEFAULT_CONFIG.externalLinks,    ...(user.externalLinks    ?? {}) },
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
 *   configPaths?: { service?: string, observer?: string },
 * }} args
 */
export async function runService({
  observer,
  config: userConfig = {},
  logger = console,
  fetchImpl = fetch,
  noServer = false,
  store: providedStore,
  configPaths = {},
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
    radioThresholdDeg: config.pushover.radioThresholdDeg,
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
    optics: config.optics,     // surfaced so the FOV sketch picks up edits live
    externalLinks: config.externalLinks,
  };

  // Lifecycle map persists across ticks — that's what gives the UI the
  // "no candidate anymore" grace period and a single dynamic list to read.
  // It is also snapshotted to disk (config.lifecyclePersist.path) so a
  // service restart does NOT empty the tracking panel — see the load below.
  /** @type {Map<string, import('./lifecycle.js').LifecycleEntry>} */
  let lifecycleMap = new Map();
  let lastLifecycleSnapshotMs = 0;

  if (config.lifecyclePersist?.path) {
    try {
      if (existsSync(config.lifecyclePersist.path)) {
        const raw = await fsp.readFile(config.lifecyclePersist.path, 'utf8');
        const snap = JSON.parse(raw);
        if (Array.isArray(snap?.entries)) {
          // Drop entries whose closest-approach time is more than 10 min in
          // the past — they would only confuse the UI after a long downtime.
          const cutoff = Date.now() - 10 * 60_000;
          for (const e of snap.entries) {
            if (typeof e?.closestApproachAtMs !== 'number') continue;
            if (e.closestApproachAtMs < cutoff && e.status !== 'planned') continue;
            // Mark restored entries as stale until the next tick reaffirms
            // them — they have no live ADS-B match by definition right now.
            lifecycleMap.set(e.key, { ...e, status: e.status === 'planned' ? 'planned' : 'stale' });
          }
          logger.info?.(`lifecycle: restored ${lifecycleMap.size} entries from ${config.lifecyclePersist.path}`);
        }
      }
    } catch (e) {
      logger.warn?.('lifecycle snapshot load failed:', e?.message ?? e);
    }
  }

  async function snapshotLifecycle() {
    if (!config.lifecyclePersist?.path) return;
    try {
      const dir = dirname(config.lifecyclePersist.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = {
        savedAtMs: Date.now(),
        entries: Array.from(lifecycleMap.values()),
      };
      await fsp.writeFile(config.lifecyclePersist.path, JSON.stringify(payload), 'utf8');
    } catch (e) {
      logger.warn?.('lifecycle snapshot save failed:', e?.message ?? e);
    }
  }

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

  // Build a sanitised view of the runtime config for the Settings panel.
  // Secrets (Pushover token / user key) are masked so they never leak through
  // /api/config even if the page is loaded over a non-TLS link from a third
  // party — only the last 4 chars are returned to confirm "something is set".
  function publicConfig() {
    const mask = (s) => (s ? `••••${String(s).slice(-4)}` : '');
    return {
      observer: { ...observer, _path: configPaths.observer ?? null },
      pushover: {
        enabled: config.pushover.enabled,
        minStage: config.pushover.minStage,
        device: config.pushover.device ?? '',
        radioThresholdDeg: config.pushover.radioThresholdDeg,
        tokenMasked: mask(config.pushover.token),
        userMasked:  mask(config.pushover.user),
        hasToken: Boolean(config.pushover.token),
        hasUser:  Boolean(config.pushover.user),
      },
      optics: { ...config.optics },
      externalLinks: { ...config.externalLinks },
      tracker: { ...config.tracker },
      _servicePath: configPaths.service ?? null,
    };
  }

  /**
   * Apply a partial config update from the Settings UI. Hot-reloads pushover
   * credentials, observer location and optics in-place — the running service
   * does NOT need a restart for the user's three target areas. Persists
   * changes to disk so the next cold start (and the next nightly auto-update
   * timer) keep the new values.
   *
   * @param {{ observer?: object, pushover?: object, optics?: object,
   *          externalLinks?: object }} patch
   */
  // Re-shape OS errors into actionable hints. The most common failure modes
  // on a Pi install are EROFS (systemd sandbox makes the path read-only —
  // ReadWritePaths in stp.service does not include config/) and EACCES
  // (file owned by a different user). Both have one-line fixes the user can
  // copy-paste, so we surface them instead of the raw syscall name.
  function describeFsError(e, path) {
    const code = e?.code ?? '';
    if (code === 'EROFS') {
      return `cannot write ${path}: filesystem is read-only inside the service sandbox. `
        + `Fix on the Pi: add config/ to ReadWritePaths in /etc/systemd/system/stp.service `
        + `(see systemd/stp.service in the repo), then \`sudo systemctl daemon-reload && sudo systemctl restart stp.service\`.`;
    }
    if (code === 'EACCES') {
      return `cannot write ${path}: permission denied. `
        + `Fix on the Pi: \`sudo chown -R <service-user>:<service-user> $(dirname ${path})\`.`;
    }
    return `cannot write ${path}: ${e?.message ?? e}`;
  }

  async function applyConfigUpdate(patch) {
    const warnings = [];
    const applied = {};

    if (patch.observer && typeof patch.observer === 'object') {
      const o = patch.observer;
      const numKeys = ['latitudeDeg', 'longitudeDeg', 'elevationM', 'temperatureC', 'pressureMbar'];
      for (const k of numKeys) {
        if (k in o) {
          const v = Number(o[k]);
          if (!Number.isFinite(v)) throw new Error(`observer.${k} must be a number`);
          observer[k] = v;
        }
      }
      if (typeof o.name === 'string') observer.name = o.name;
      applied.observer = { ...observer };
      if (configPaths.observer) {
        try {
          await fsp.writeFile(configPaths.observer, JSON.stringify(observer, null, 2), 'utf8');
        } catch (e) {
          // Live edit already applied to the in-memory observer object — only
          // the on-disk copy failed. Warn rather than throw so the user sees
          // the actionable hint *and* the UI does not roll back the apparent
          // save (which would be misleading: the new lat/lon are in effect).
          warnings.push(describeFsError(e, configPaths.observer));
        }
      }
    }

    if (patch.pushover && typeof patch.pushover === 'object') {
      const p = patch.pushover;
      if (typeof p.token === 'string' && p.token && !p.token.startsWith('••••')) {
        config.pushover.token = p.token.trim();
      }
      if (typeof p.user === 'string' && p.user && !p.user.startsWith('••••')) {
        config.pushover.user = p.user.trim();
      }
      if (typeof p.device === 'string') config.pushover.device = p.device.trim();
      if (typeof p.enabled === 'boolean') config.pushover.enabled = p.enabled;
      if (typeof p.minStage === 'string'
          && ['radio', 'candidate', 'imminent'].includes(p.minStage)) {
        config.pushover.minStage = p.minStage;
        notifier.minStage = p.minStage;
      }
      if ('radioThresholdDeg' in p) {
        const v = Number(p.radioThresholdDeg);
        if (!Number.isFinite(v) || v <= 0) throw new Error('pushover.radioThresholdDeg must be a positive number');
        config.pushover.radioThresholdDeg = v;
        notifier.radioThresholdDeg = v;
      }
      // PushoverClient reads this.config on every send() call → in-place mutation
      // is enough; no client reconstruction needed.
      pushover.config = config.pushover;
      applied.pushover = {
        enabled: config.pushover.enabled,
        minStage: config.pushover.minStage,
        device: config.pushover.device,
        radioThresholdDeg: config.pushover.radioThresholdDeg,
        hasToken: Boolean(config.pushover.token),
        hasUser:  Boolean(config.pushover.user),
      };
    }

    if (patch.tracker && typeof patch.tracker === 'object') {
      const t = patch.tracker;
      // Only the two thresholds are user-editable from the UI — the look-
      // ahead horizon and step size are perf-tuning knobs that we don't want
      // exposed casually. Validate strictly so a bad input never zeroes out
      // the panel.
      if ('looseThresholdDeg' in t) {
        const v = Number(t.looseThresholdDeg);
        if (!Number.isFinite(v) || v <= 0) throw new Error('tracker.looseThresholdDeg must be a positive number');
        config.tracker.looseThresholdDeg = v;
      }
      if ('thresholdDeg' in t) {
        const v = Number(t.thresholdDeg);
        if (!Number.isFinite(v) || v <= 0) throw new Error('tracker.thresholdDeg must be a positive number');
        config.tracker.thresholdDeg = v;
      }
      // findTransits() reads trackerOpts fresh on every tick, so mutating
      // config.tracker in-place is enough — next poll picks up the new
      // values, the lifecycle list shrinks to match.
      applied.tracker = { ...config.tracker };
    }

    if (patch.optics && typeof patch.optics === 'object') {
      const o = patch.optics;
      const numKeys = ['telescopeFocalMm', 'sensorWmm', 'sensorHmm', 'sensorPxW', 'sensorPxH'];
      for (const k of numKeys) {
        if (k in o) {
          const v = Number(o[k]);
          if (!Number.isFinite(v) || v <= 0) throw new Error(`optics.${k} must be a positive number`);
          config.optics[k] = v;
        }
      }
      if (typeof o.sensorName === 'string') config.optics.sensorName = o.sensorName;
      applied.optics = { ...config.optics };
    }

    if (patch.externalLinks && typeof patch.externalLinks === 'object') {
      if (typeof patch.externalLinks.dump1090Url === 'string') {
        config.externalLinks.dump1090Url = patch.externalLinks.dump1090Url.trim();
      }
      applied.externalLinks = { ...config.externalLinks };
    }

    // Persist the service-level changes (pushover, optics, externalLinks)
    // back to service.json. observer.json is written separately above.
    if (configPaths.service) {
      try {
        // Read-modify-write so we don't clobber fields the UI doesn't expose.
        let existing = {};
        if (existsSync(configPaths.service)) {
          try { existing = JSON.parse(await fsp.readFile(configPaths.service, 'utf8')); }
          catch { /* fall through */ }
        }
        const merged = {
          ...existing,
          tracker:       { ...(existing.tracker       ?? {}), ...config.tracker },
          pushover:      { ...(existing.pushover      ?? {}), ...config.pushover },
          optics:        { ...(existing.optics        ?? {}), ...config.optics },
          externalLinks: { ...(existing.externalLinks ?? {}), ...config.externalLinks },
        };
        await fsp.writeFile(configPaths.service, JSON.stringify(merged, null, 2), 'utf8');
      } catch (e) {
        // Stay non-fatal here: hot-reload already succeeded; only the
        // persistence write failed. Surface the actionable hint as a warning
        // so the UI shows it but the user's edit still takes effect live.
        warnings.push(describeFsError(e, configPaths.service));
      }
    } else {
      warnings.push('no service config path provided — changes are in memory only');
    }

    return { ok: true, applied, warnings };
  }

  const httpServer = noServer ? null : createHttpServer({
    port: config.server.port,
    host: config.server.host,
    getState: () => state,
    store,
    webRoot: config.webRoot,
    getConfig: () => publicConfig(),
    updateConfig: applyConfigUpdate,
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

    // Persist lifecycle on a slow cadence so a restart can repopulate the UI.
    // Cheap (< 5 KB), async, and we never block the tick on the write.
    if (config.lifecyclePersist?.path
        && nowMs - lastLifecycleSnapshotMs >= (config.lifecyclePersist.snapshotIntervalMs ?? 30_000)) {
      lastLifecycleSnapshotMs = nowMs;
      snapshotLifecycle();
    }

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
      // Flush lifecycle snapshot before tearing down so SIGTERM right after
      // a tick still leaves a fresh tracking list on disk for the next start.
      await snapshotLifecycle();
      if (httpServer) await httpServer.stop();
      store.close();
    },
  };
}
