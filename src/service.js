// Service orchestrator: ties the ADS-B poller, transit detector, route
// lookup, notifier, history store and HTTP server together. Exposes a single
// `runService(config)` entry point used by bin/stp.js and exercised by tests.

import { promises as fsp, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';

// Single source of truth for the running version — read from package.json so
// the UI badge can never drift from the actual deployed build.
const PKG_VERSION = (() => {
  try { return createRequire(import.meta.url)('../package.json').version ?? null; }
  catch { return null; }
})();

import { fetchAircraft } from './adsb.js';
import { RouteLookup, AircraftLookup } from './adsbdb.js';
import { AirnavClient } from './airnav.js';
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
import { SharpCapTrigger } from './sharpcap.js';
import { HistoryStore } from './store.js';
import { findTransits } from './tracker.js';
import { loadIssTle, predictIssTransits, nextIssVisiblePass } from './iss.js';

export const DEFAULT_CONFIG = {
  adsb: {
    url: 'http://localhost:8080/data/aircraft.json',
    pollIntervalMs: 2000,
  },
  tracker: {
    // 5-minute look-ahead by default (v0.23.4; was 900 s). Linear-extrapolation
    // error grows fast past a few minutes — especially for descending/turning
    // approach traffic — so a 15-minute horizon produced a lot of speculative
    // candidates that fired a 'radio' alert and then faded (false alarms). A
    // 300 s window keeps predictions accurate and the alerts trustworthy: the
    // SharpCap trigger only arms ~95 s out anyway, and a Pushover 1–2 min
    // before is ample warning to glance at the capture. Raise it (clamp upper
    // bound 1800 s) if you want earlier, noisier heads-ups.
    horizonS: 300,
    stepS: 0.5,
    thresholdDeg: 0.3,        // tight band → 'candidate' level
    // Drop matches further than this from the tracking panel entirely.
    // Was 5° pre-v0.7.4; lowered after the user's "alles über 2° ist nicht
    // mehr relevant" decision. The Pushover phone-buzz filter is separate
    // (pushover.radioThresholdDeg, default 1°) so you can dial the panel
    // and the notifications independently.
    looseThresholdDeg: 2.0,
    // Minimum aircraft altitude (m MSL) to consider; 0 = no gate. Set to e.g.
    // 2000 to drop low traffic (helicopters, light aircraft, drones) that you
    // don't want cluttering predictions/alerts. Aircraft with no altitude
    // data are skipped while the gate is on (can't verify they're high
    // enough). Applies to the whole pipeline (candidates → notifier → arming
    // → History → stats) so a single knob controls "what counts".
    minAltitudeM: 0,
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
    // Pushover-only elevation gate (v0.15.0). Below ~30° a target is barely
    // usable visually (long hazy/turbulent slant path, horizon clouds), so
    // by default the phone only buzzes when the aircraft is at least this
    // many degrees above the horizon at closest approach. 0 disables the
    // gate. The ISS is exempt (it has its own 15° visibility gate). History
    // and all statistics still record everything regardless of this gate.
    minElevationDeg: 30,
    // Clickable URL Pushover shows on the notification (tap → opens the
    // predictor web UI). Blank → auto-derived from the host's first
    // non-internal LAN IPv4 and the server port, e.g.
    // http://192.168.1.50:8081/. Set explicitly to override.
    url: '',
  },
  lifecycle: {
    plannedWindowMs: 3600_000,    // surface watchlist entries within ±1 h
    imminentWindowMs: 30_000,     // ±30 s around closest-approach → imminent
    // v0.8.0: stale entries now auto-vanish 30 min after the last real
    // contact (was 0 = never, cap-only). Combined with the smaller panel
    // cap this keeps "LIVE-TRACKING-SIGNALS" genuinely live.
    staleGraceMs: 1_800_000,      // 30 min absolute stale age → drop
    maxEntries: 10,               // tracking-list cap (was 20)
    // Hold the last live status through a brief ADS-B dropout so a flight
    // does not flip to 'stale' on a single missed squitter near the horizon.
    coastMs: 25_000,
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
  // Click-to-update from the version badge. The HTTP layer only ever drops
  // `triggerPath` (no shell/sudo); a privileged systemd stp-update.path unit
  // watches it and runs stp-update.service. Path sits under data/ which the
  // service already has write access to. debounceMs swallows double-clicks
  // and rapid LAN re-triggers. Set enabled:false to take the endpoint out.
  update: {
    enabled: true,
    triggerPath: './data/update.request',
    debounceMs: 30_000,
  },
  // SharpCap live trigger (Windows-side capture). Sends a TCP packet to a
  // long-running listener inside SharpCap (scripts/sharpcap/trigger_listener.py)
  // the moment a transit becomes imminent — meant for the aircraft case where
  // it can take ~30 s of warning to know a flight will actually cross the
  // disc. The pre/postBufferS values frame the recording around closest
  // approach: capture starts (closestApproach − preBufferS) and stops
  // (closestApproach + postBufferS). Disabled by default; off-net failures
  // are logged but never break the predictor service.
  sharpcap: {
    enabled: false,
    host: '',
    port: 9999,
    token: '',
    // Recording window straddles the predicted closest approach: start
    // preBufferS before it, stop postBufferS after it (so the default −10/+10
    // gives a 20 s clip centred on the transit). Editable from Settings.
    preBufferS: 10,
    postBufferS: 10,
    triggerOnStage: 'imminent',
    minElevationDeg: 20,
    bodies: ['Sun', 'Moon'],
    dedupMs: 60_000,
    connectTimeoutMs: 2000,
    // Tick-based arming (the "never miss a transit" path): arm as soon as a
    // candidate's projected closest separation is within maxSepDeg AND the
    // closest approach is near enough that the pre-roll fits the listener cap.
    // maxSepDeg is generous on purpose — better an extra clip than a missed
    // shot. Set lower to be stricter, or minElevationDeg=0 to never gate on
    // elevation.
    maxSepDeg: 0.5,
    // Arming early means the predicted closest-approach time is less certain
    // (a stale candidate's estimate can drift 30 s+), so widen the recording
    // window by leadDriftFrac × secondsToClosest on each side (capped at
    // maxDriftS). Generous by default — at lead 50 s → ±25 s extra. Set
    // leadDriftFrac:0 to disable and use only pre/postBufferS.
    leadDriftFrac: 0.5,
    maxDriftS: 45,
    // Hard ceiling on total clip length (s) so preBuffer+postBuffer+drift can
    // never exceed the listener's MAX_DURATION_S (120) and get rejected as
    // over-limit. Keep below the listener's cap.
    maxCaptureS: 115,
    // Re-arm an already-armed capture when the refined closest-approach time
    // moves more than this many seconds — the listener replaces the still-
    // pending pre-roll with the fresher time. Fixes "armed early on a stale
    // prediction that later corrected".
    reArmShiftS: 12,
    // Send a Pushover when a capture is actually triggered (key params + ETA).
    notifyOnTrigger: true,
    // Multi-rig: leave empty for a single rig (host/port/bodies above). To
    // drive two telescopes on two PCs, list them here — each overrides the
    // base fields and is routed by its own `bodies`, e.g.
    //   [ { "name":"Ha-Sun","host":"192.168.1.99","bodies":["Sun"] },
    //     { "name":"Moon","host":"192.168.1.50","bodies":["Moon"] } ]
    targets: [],
  },
  // ISS transits (offline SGP4 from a TLE file). Inactive until a TLE is
  // present at tlePath — fetch it opt-in with scripts/refresh-tle.js. The
  // forward scan is rare-event work, so it runs on recomputeMs cadence and
  // when the TLE file changes, never on the 2 s tick.
  iss: {
    enabled: true,
    tlePath: './data/iss.tle',
    // How far ahead to scan for a Sun/Moon transit. ISS disc transits at a
    // fixed site are weeks apart, so the default is generous; raising it
    // finds transits further out at the cost of more CPU on each
    // (10-min-cadence) recompute — the scan is O(horizon).
    horizonMs: 14 * 24 * 3600_000,   // 14 days
    // Visible-pass scan horizon. Cheap regardless of size: nextIssVisiblePass
    // returns at the FIRST pass it finds, so a 30-day cap just means "tell me
    // the next one even if it's weeks out" without scanning 30 days.
    visibleHorizonMs: 30 * 24 * 3600_000,
    // Only feed an ISS transit to the notifier + History once it is this
    // close. SGP4+TLE drifts ~1–3 km/day cross-track; the transit centre
    // line is a few km wide, so a prediction >~3 days out is noise that
    // appears/vanishes with every daily TLE refresh. Beyond this the
    // Sky-now line still PREVIEWS the soonest predicted transit, flagged
    // "tentative" — it just won't push/log a phantom.
    notifyWithinMs: 3 * 24 * 3600_000,   // 72 h
    recomputeMs: 600_000,       // re-scan every 10 min
    thresholdDeg: 0.3,          // tight → candidate
    looseThresholdDeg: 1.0,     // surface approaches up to here
  },
  // Persistent "how often did it come by" tally over ALL detected ADS-B
  // traffic (airframe hex + ADS-B callsign), kept in SQLite so it survives
  // restarts. A visit = a fresh sighting ≥ gapMs after the last one.
  sightings: { enabled: true, gapMs: 1_800_000, flushMs: 300_000 },
  routes: { enabled: true, ttlMs: 3600_000, negativeTtlMs: 300_000 },
  // AirNav On-Demand API v2 (optional; off until a token is set). The
  // token lives ONLY here / in service.json (masked in /api/config) — the
  // browser calls our /api/acinfo proxy, never AirNav directly. Every
  // call is billed in credits, so the client caches hard and the UI only
  // fetches on an explicit row click / flight-number hover.
  airnav: {
    enabled: false,
    token: '',
    baseUrl: 'https://api.airnavradar.com/v2',
    ttlMs: 6 * 3600_000,        // static airframe data — stable, cache 6 h
    liveTtlMs: 60_000,          // live flight (route/pos) — cache 60 s
    negativeTtlMs: 300_000,     // failures — 5 min
  },
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
    sightings: { ...DEFAULT_CONFIG.sightings, ...(user.sightings ?? {}) },
    iss:       { ...DEFAULT_CONFIG.iss,       ...(user.iss       ?? {}) },
    airnav:    { ...DEFAULT_CONFIG.airnav,    ...(user.airnav    ?? {}) },
    update:    { ...DEFAULT_CONFIG.update,    ...(user.update    ?? {}) },
    predictor: { ...DEFAULT_CONFIG.predictor, ...(user.predictor ?? {}) },
    opensky:   { ...DEFAULT_CONFIG.opensky,   ...(user.opensky   ?? {}) },
    lifecycle: { ...DEFAULT_CONFIG.lifecycle, ...(user.lifecycle ?? {}) },
    optics:    { ...DEFAULT_CONFIG.optics,    ...(user.optics    ?? {}) },
    sharpcap:  { ...DEFAULT_CONFIG.sharpcap,  ...(user.sharpcap  ?? {}) },
    lifecyclePersist: { ...DEFAULT_CONFIG.lifecyclePersist, ...(user.lifecyclePersist ?? {}) },
  };
}

// First non-internal IPv4 of the host — used to build the default Pushover
// click URL ("http://<lan-ip>:<port>/") when pushover.url is left blank, so
// tapping the notification opens this predictor's own web UI. Returns '' if
// no LAN address can be found (then no link is attached).
function lanIPv4() {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      const fam = typeof ni.family === 'number' ? ni.family === 4 : ni.family === 'IPv4';
      if (fam && !ni.internal && ni.address) return ni.address;
    }
  }
  return '';
}

// Effective clickable URL for Pushover: an explicit pushover.url wins;
// otherwise auto-derive from the LAN IP + server port; '' → no link.
function effectivePushoverUrl(config) {
  const explicit = String(config.pushover?.url ?? '').trim();
  if (explicit) return explicit;
  const ip = lanIPv4();
  if (ip) return `http://${ip}:${config.server.port}/`;
  return String(config.server?.publicUrl ?? '').trim();
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

  // AirNav client — rebuilt on a token/baseUrl change via applyConfigUpdate.
  // Held in a mutable holder so the /api/acinfo proxy always uses the
  // current token without restarting the service.
  function buildAirnav() {
    if (!config.airnav?.enabled || !config.airnav?.token) return null;
    return new AirnavClient({
      token: config.airnav.token,
      baseUrl: config.airnav.baseUrl,
      fetchImpl,
      ttlMs: config.airnav.ttlMs,
      liveTtlMs: config.airnav.liveTtlMs,
      negativeTtlMs: config.airnav.negativeTtlMs,
    });
  }
  let airnav = buildAirnav();

  // v0.21.0: free fallback for the /api/acinfo proxy. adsbdb's hex endpoint
  // gives registration, type, manufacturer, operator and a planespotters
  // photo URL — covers the bulk of what AirNav delivers (no MSN / first
  // flight / decommissioned status, no live flight info). Always available
  // because it has no token + no billing; the proxy uses it as a graceful
  // degradation when AirNav is disabled, missing a token, out of credits
  // or returns a soft miss.
  const freeAircraft = new AircraftLookup({ fetchImpl });

  // SharpCap live capture trigger(s). One SharpCapTrigger per target rig so a
  // multi-scope site can record different bodies on different PCs — e.g. an
  // Hα solar scope (Sun) on one host and a normal scope (Moon) on another.
  // Each target inherits the shared sharpcap knobs (sep/drift/elevation/…) and
  // overrides host/port/bodies/buffers; routing is automatic via each
  // trigger's body filter (a Sun candidate arms only Sun targets, etc.). No
  // `targets` array → a single implicit target = the base config (back-compat).
  function buildSharpcapTargets() {
    const base = config.sharpcap;
    const list = Array.isArray(base.targets) && base.targets.length ? base.targets : [base];
    return list.map((t, i) => {
      const merged = { ...base, ...t };
      delete merged.targets;
      return {
        name: t.name ?? base.name ?? `rig-${i + 1}`,
        trigger: new SharpCapTrigger(merged, { logger }),
      };
    });
  }
  let sharpcapTargets = buildSharpcapTargets();
  const sharpcapAnyEnabled = () => sharpcapTargets.some((t) => t.trigger.enabled);
  // Union of bodies across enabled rigs — drives both notifier.pushBodies and
  // the header readout. If Sun is armed on rig A and Moon on rig B, both push.
  const sharpcapArmedBodies = () => {
    const s = new Set();
    for (const { trigger } of sharpcapTargets) {
      if (trigger.enabled) for (const b of (trigger.config.bodies ?? [])) s.add(b);
    }
    return Array.from(s);
  };
  // Session-cumulative count of captures armed across all rigs (resets on
  // restart). Surfaced in state.sharpcap for the header status readout.
  let sharpcapArmedCount = 0;
  // Recent armed episodes — {icao, body, closestAtMs, armedAtMs, rig}, capped —
  // so the UI can put a ⚡ next to the matching Live / History row. In-memory:
  // resets on restart. Capped to keep /api/state small.
  const SHARPCAP_ARMED_MAX = 200;
  const sharpcapArmedLog = [];

  // Short Pushover when a capture is armed: the key params + ETA to closest
  // approach + the −pre/+post recording window. Best-effort; never blocks.
  function notifySharpcapTrigger(candidate, res, rig, trigCfg) {
    if (trigCfg.notifyOnTrigger === false) return;
    const flight = candidate.callsign ?? candidate.icao?.toUpperCase() ?? 'unknown';
    const etaS = Math.round((candidate.closestApproachAtMs - Date.now()) / 1000);
    const sep = Number.isFinite(candidate.closestApproachSepDeg)
      ? candidate.closestApproachSepDeg.toFixed(2) : '?';
    const pre = trigCfg.preBufferS;
    const post = trigCfg.postBufferS;
    const msg = {
      title: `🎥 SharpCap REC · ${rig} · ${candidate.body}`,
      message: [
        `✈ ${flight} · ${candidate.body} transit`,
        `sep ${sep}° · ETA ${etaS}s`,
        `capture −${pre}s/+${post}s`
          + (res.response?.captureId ? ` · ${res.response.captureId}` : ''),
      ].join('\n'),
      priority: 0,
    };
    pushover.send(msg).catch((e) => logger.warn?.('sharpcap push failed:', e?.message ?? e));
  }

  // Tick-based SharpCap arming — the "never miss a transit" path. Called every
  // tick with the live candidate list, for every target rig. Each rig's
  // armForCandidate gates on body/sep/elevation/time + dedup, so a Sun
  // candidate arms only the Sun rig(s) and a Moon candidate only the Moon
  // rig(s), each with independent dedup/re-arm state. Quiet reasons (too-early
  // / too-wide / deduped / body-filtered) are not logged.
  function armSharpcapForCandidates(candidates, nowMs) {
    if (!sharpcapAnyEnabled()) return;
    for (const c of candidates) {
      const who = `${c.icao ?? c.callsign ?? '?'}|${c.body}`;
      for (const { name, trigger } of sharpcapTargets) {
        if (!trigger.enabled) continue;
        trigger.armForCandidate(c, nowMs).then((res) => {
          if (res.sent) {
            // A re-arm replaces the same episode's pending capture — don't
            // double-count it, just refresh the time on the listener.
            if (!res.reArmed) {
              sharpcapArmedCount += 1;
              sharpcapArmedLog.push({
                icao: c.icao ?? null, body: c.body,
                closestAtMs: c.closestApproachAtMs, armedAtMs: Date.now(), rig: name,
              });
              if (sharpcapArmedLog.length > SHARPCAP_ARMED_MAX) sharpcapArmedLog.shift();
            }
            logger.info?.(`sharpcap[${name}]: capture ${res.reArmed ? 're-armed' : 'armed'} for ${who} (${res.response?.captureId ?? ''})`);
            if (!res.reArmed) notifySharpcapTrigger(c, res, name, trigger.config);
          } else if (res.error) {
            logger.warn?.(`sharpcap[${name}] arm failed for ${who}: ${res.error?.message ?? res.error}`);
          } else if (res.reason === 'too-low' || res.reason === 'too-late') {
            logger.info?.(`sharpcap[${name}]: arm skipped for ${who}: ${res.reason}`
              + (Number.isFinite(c.aircraftAtClosest?.elevationDeg)
                ? ` (el ${c.aircraftAtClosest.elevationDeg.toFixed(0)}°, minEl ${trigger.config.minElevationDeg}°)`
                : ''));
          }
        }).catch((e) => logger.warn?.(`sharpcap[${name}] arm threw:`, e?.message ?? e));
      }
    }
  }

  const notifier = new Notifier({
    pushover,
    routeLookup: (cs) => routeLookup.lookup(cs),
    // History record only. The SharpCap capture is NOT armed here anymore —
    // the old onEvent path fired solely on the fragile ±30 s 'imminent' stage,
    // so an ADS-B gap in that window meant a missed shot. Arming now runs on
    // every tick against the live candidates (see armSharpcapForCandidates),
    // which is the "never miss a transit" path.
    onEvent: (evt) => {
      try { store.recordEvent(evt.stage, evt.candidate, evt.route, Date.now()); }
      catch (e) { logger.error?.('store record failed:', e); }
    },
    minStage: config.pushover.minStage ?? 'radio',
    radioThresholdDeg: config.pushover.radioThresholdDeg,
    minElevationDeg: config.pushover.minElevationDeg,
    imminentWindowMs: config.lifecycle.imminentWindowMs,
    baseUrl: effectivePushoverUrl(config) || undefined,
  });

  // Detection funnel — cumulative for the running session. Sets of ICAO
  // hex strings; memory is bounded by real traffic (a busy European site
  // sees a few thousand distinct airframes per day) and reset on restart,
  // which the UI labels explicitly ("since start").
  const detectedIcaos = new Set();
  const inBandIcaos = new Set();
  const nearIcaos = new Set();
  const veryNearIcaos = new Set();
  const state_sinceMs = Date.now();

  // Per-session memory for the persistent sightings tally — avoids a DB
  // write every 2 s for an aircraft that just sits in reception. Keyed
  // `${kind}:${key}` → { lastSeenMs, lastFlushMs }.
  const sightSeen = new Map();

  // ISS prediction cache. Recomputed on a slow cadence (config.iss.recomputeMs)
  // and whenever the TLE file changes on disk. The notifier de-dupes the
  // Pushover + History rows per (icao,body), so no extra bookkeeping here.
  let issTle = config.iss?.enabled ? loadIssTle(config.iss.tlePath) : null;
  let issEvents = [];
  let issVisiblePass = null;
  let lastIssComputeMs = 0;

  const state = {
    observer,
    version: PKG_VERSION,
    nowMs: Date.now(),
    lastUpdateMs: 0,
    aircraftCount: 0,
    bodies: {},
    candidates: [],            // backward-compat: tracker output (live)
    expected: [],              // backward-compat: predictor watchlist (24 h)
    lifecycle: [],             // primary unified view used by the new UI
    watchlistMeta: { lastBuildMs: 0, entries: 0 },
    optics: config.optics,     // surfaced so the FOV sketch picks up edits live
    // Session-cumulative detection funnel for the bar chart under "Alert
    // learning": every unique airframe the receiver saw, how many ever
    // projected inside the panel band, and how many ever skimmed < 0.5°.
    detectStats: {
      totalUnique: 0, inBand: 0, near: 0, veryNear: 0,
      bandDeg: config.tracker.looseThresholdDeg, nearDeg: 0.5, veryNearDeg: 0.2,
      sinceMs: state_sinceMs,
    },
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
        minElevationDeg: config.pushover.minElevationDeg,
        url: config.pushover.url ?? '',
        tokenMasked: mask(config.pushover.token),
        userMasked:  mask(config.pushover.user),
        hasToken: Boolean(config.pushover.token),
        hasUser:  Boolean(config.pushover.user),
      },
      airnav: {
        enabled: config.airnav.enabled,
        baseUrl: config.airnav.baseUrl,
        tokenMasked: mask(config.airnav.token),
        hasToken: Boolean(config.airnav.token),
      },
      optics: { ...config.optics },
      tracker: { ...config.tracker },
      sharpcap: {
        enabled: config.sharpcap.enabled,
        host: config.sharpcap.host ?? '',
        port: config.sharpcap.port,
        preBufferS: config.sharpcap.preBufferS,
        postBufferS: config.sharpcap.postBufferS,
        triggerOnStage: config.sharpcap.triggerOnStage,
        minElevationDeg: config.sharpcap.minElevationDeg,
        maxSepDeg: config.sharpcap.maxSepDeg,
        bodies: config.sharpcap.bodies,
        notifyOnTrigger: config.sharpcap.notifyOnTrigger !== false,
        tokenMasked: mask(config.sharpcap.token),
        hasToken: Boolean(config.sharpcap.token),
        // Multi-rig targets (tokens masked). Empty/absent → single-rig mode
        // using the fields above.
        targets: (config.sharpcap.targets ?? []).map((t) => ({
          name: t.name ?? null,
          host: t.host ?? '',
          port: t.port ?? config.sharpcap.port,
          bodies: t.bodies ?? config.sharpcap.bodies,
          preBufferS: t.preBufferS ?? config.sharpcap.preBufferS,
          postBufferS: t.postBufferS ?? config.sharpcap.postBufferS,
          tokenMasked: mask(t.token),
          hasToken: Boolean(t.token ?? config.sharpcap.token),
        })),
      },
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
   *          tracker?: object, airnav?: object }} patch
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
      if ('minElevationDeg' in p) {
        // 0 disables the elevation gate; otherwise it is a 0–90° threshold.
        const v = Number(p.minElevationDeg);
        if (!Number.isFinite(v) || v < 0 || v > 90) {
          throw new Error('pushover.minElevationDeg must be between 0 and 90 (0 = off)');
        }
        config.pushover.minElevationDeg = v;
        notifier.minElevationDeg = v;
      }
      if ('url' in p) {
        // Clickable Pushover URL. '' → re-derive from the LAN IP + port.
        config.pushover.url = String(p.url ?? '').trim();
        notifier.baseUrl = effectivePushoverUrl(config) || undefined;
      }
      // PushoverClient reads this.config on every send() call → in-place mutation
      // is enough; no client reconstruction needed.
      pushover.config = config.pushover;
      applied.pushover = {
        enabled: config.pushover.enabled,
        minStage: config.pushover.minStage,
        device: config.pushover.device,
        radioThresholdDeg: config.pushover.radioThresholdDeg,
        minElevationDeg: config.pushover.minElevationDeg,
        url: config.pushover.url,
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
      if ('minAltitudeM' in t) {
        const v = Number(t.minAltitudeM);
        if (!Number.isFinite(v) || v < 0) throw new Error('tracker.minAltitudeM must be ≥ 0 (0 = off)');
        config.tracker.minAltitudeM = v;
      }
      if ('horizonS' in t) {
        const v = Number(t.horizonS);
        if (!Number.isFinite(v) || v < 10) throw new Error('tracker.horizonS must be ≥ 10 seconds');
        // findTransits() re-clamps to the upper bound on its own — let it
        // do the work so service.js doesn't duplicate the policy constant.
        config.tracker.horizonS = v;
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

    if (patch.airnav && typeof patch.airnav === 'object') {
      const a = patch.airnav;
      // Never accept the masked placeholder back as the real token.
      if (typeof a.token === 'string' && a.token && !a.token.startsWith('••••')) {
        config.airnav.token = a.token.trim();
      }
      if (typeof a.enabled === 'boolean') config.airnav.enabled = a.enabled;
      if (typeof a.baseUrl === 'string' && a.baseUrl.trim()) {
        config.airnav.baseUrl = a.baseUrl.trim();
      }
      airnav = buildAirnav();   // hot-swap the client with the new token
      applied.airnav = {
        enabled: config.airnav.enabled,
        baseUrl: config.airnav.baseUrl,
        hasToken: Boolean(config.airnav.token),
      };
    }

    if (patch.sharpcap && typeof patch.sharpcap === 'object') {
      const s = patch.sharpcap;
      if (typeof s.enabled === 'boolean') config.sharpcap.enabled = s.enabled;
      if (typeof s.host === 'string') config.sharpcap.host = s.host.trim();
      if ('port' in s) {
        const v = Number(s.port);
        if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error('sharpcap.port must be an integer 1–65535');
        config.sharpcap.port = v;
      }
      if ('preBufferS' in s) {
        const v = Number(s.preBufferS);
        if (!Number.isFinite(v) || v < 0) throw new Error('sharpcap.preBufferS must be ≥ 0');
        config.sharpcap.preBufferS = v;
      }
      if ('postBufferS' in s) {
        const v = Number(s.postBufferS);
        if (!Number.isFinite(v) || v < 0) throw new Error('sharpcap.postBufferS must be ≥ 0');
        config.sharpcap.postBufferS = v;
      }
      if ('minElevationDeg' in s) {
        const v = Number(s.minElevationDeg);
        if (!Number.isFinite(v) || v < 0 || v > 90) throw new Error('sharpcap.minElevationDeg must be between 0 and 90 (0 = off)');
        config.sharpcap.minElevationDeg = v;
      }
      if ('maxSepDeg' in s) {
        const v = Number(s.maxSepDeg);
        if (!Number.isFinite(v) || v <= 0 || v > 5) throw new Error('sharpcap.maxSepDeg must be > 0 and ≤ 5');
        config.sharpcap.maxSepDeg = v;
      }
      if ('bodies' in s) {
        // Single-body selection from the UI ('Sun' | 'Moon'); a one scope can
        // only track one disc at a time. Accept an array or a bare string.
        const raw = Array.isArray(s.bodies) ? s.bodies : [s.bodies];
        const allowed = raw.filter((b) => b === 'Sun' || b === 'Moon');
        if (!allowed.length) throw new Error('sharpcap.bodies must contain "Sun" or "Moon"');
        config.sharpcap.bodies = allowed;
      }
      if (typeof s.triggerOnStage === 'string'
          && ['radio', 'candidate', 'imminent'].includes(s.triggerOnStage)) {
        config.sharpcap.triggerOnStage = s.triggerOnStage;
      }
      if (typeof s.notifyOnTrigger === 'boolean') config.sharpcap.notifyOnTrigger = s.notifyOnTrigger;
      if (typeof s.token === 'string' && s.token && !s.token.startsWith('••••')) {
        config.sharpcap.token = s.token.trim();
      }
      if ('targets' in s) {
        // Multi-rig: an array of { name?, host, port?, bodies?, preBufferS?,
        // postBufferS?, token?, … } overriding the base config per rig. Each
        // entry is validated; an empty array clears multi-rig (back to single).
        if (s.targets != null && !Array.isArray(s.targets)) {
          throw new Error('sharpcap.targets must be an array');
        }
        const targets = (s.targets ?? []).map((t, i) => {
          if (!t || typeof t !== 'object') throw new Error(`sharpcap.targets[${i}] must be an object`);
          if (typeof t.host !== 'string' || !t.host.trim()) throw new Error(`sharpcap.targets[${i}].host is required`);
          if ('port' in t) {
            const v = Number(t.port);
            if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`sharpcap.targets[${i}].port must be 1–65535`);
          }
          if ('bodies' in t) {
            const raw = Array.isArray(t.bodies) ? t.bodies : [t.bodies];
            if (!raw.every((b) => b === 'Sun' || b === 'Moon')) throw new Error(`sharpcap.targets[${i}].bodies must be Sun/Moon`);
          }
          return { ...t, host: t.host.trim() };
        });
        config.sharpcap.targets = targets;
      }
      // Rebuild the trigger set from the updated config (per-rig dedup/re-arm
      // state resets, which is fine on a manual settings change).
      sharpcapTargets = buildSharpcapTargets();
      applied.sharpcap = {
        enabled: config.sharpcap.enabled,
        host: config.sharpcap.host,
        port: config.sharpcap.port,
        preBufferS: config.sharpcap.preBufferS,
        postBufferS: config.sharpcap.postBufferS,
        triggerOnStage: config.sharpcap.triggerOnStage,
        minElevationDeg: config.sharpcap.minElevationDeg,
        maxSepDeg: config.sharpcap.maxSepDeg,
        bodies: config.sharpcap.bodies,
        targets: (config.sharpcap.targets ?? []).map((t) => ({
          name: t.name ?? null, host: t.host, port: t.port ?? config.sharpcap.port,
          bodies: t.bodies ?? config.sharpcap.bodies, hasToken: Boolean(t.token ?? config.sharpcap.token),
        })),
        notifyOnTrigger: config.sharpcap.notifyOnTrigger,
        hasToken: Boolean(config.sharpcap.token),
      };
    }

    // Persist the service-level changes (pushover, optics, tracker, airnav)
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
          tracker:       { ...(existing.tracker  ?? {}), ...config.tracker },
          pushover:      { ...(existing.pushover ?? {}), ...config.pushover },
          optics:        { ...(existing.optics   ?? {}), ...config.optics },
          airnav:        { ...(existing.airnav   ?? {}), ...config.airnav },
          sharpcap:      { ...(existing.sharpcap ?? {}), ...config.sharpcap },
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

  // Click-to-update: drop a trigger file the privileged systemd
  // stp-update.path unit watches. The HTTP layer never runs git/systemctl
  // itself, so the unauthenticated LAN UI gains no shell. Debounced so a
  // double-click (or two LAN clients) can't queue the updater twice.
  let lastUpdateRequestMs = 0;
  async function requestUpdate() {
    if (!config.update?.enabled) {
      return { ok: false, message: 'click-to-update is disabled (update.enabled=false in service.json)' };
    }
    const now = Date.now();
    const debounce = config.update.debounceMs ?? 30_000;
    if (now - lastUpdateRequestMs < debounce) {
      return { ok: true, pending: true, message: 'Update already requested — the service will pull & restart shortly.' };
    }
    const p = config.update.triggerPath;
    try {
      const dir = dirname(p);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      await fsp.writeFile(p, JSON.stringify({ requestedAtMs: now }), 'utf8');
      lastUpdateRequestMs = now;
      logger.info?.(`update requested via web UI → wrote trigger ${p}`);
      return {
        ok: true, pending: false,
        // The HTTP layer only drops the trigger; an external privileged
        // consumer (the systemd stp-update.path unit, Linux/Pi only) does
        // the git pull + restart. The UI watches state.update to confirm
        // the trigger was actually picked up — see the tick() diagnostic.
        message: 'Update requested. Waiting for the background updater to pull & restart…',
      };
    } catch (e) {
      return { ok: false, message: describeFsError(e, p) };
    }
  }

  const httpServer = noServer ? null : createHttpServer({
    port: config.server.port,
    host: config.server.host,
    getState: () => state,
    store,
    webRoot: config.webRoot,
    getConfig: () => publicConfig(),
    updateConfig: applyConfigUpdate,
    requestUpdate,
    // /api/acinfo proxy (v0.21.0 — two-tier source):
    //   1. AirNav On-Demand if a token is configured AND the lookup yields
    //      anything (richest payload: static airframe + live route + photos).
    //   2. Free fallback via adsbdb hex endpoint (static airframe + photo,
    //      no live flight info, no billing). Used when AirNav is disabled,
    //      out of credits, or returns nothing for this hex.
    // The token never leaves the server. The response carries a `source`
    // field ('airnav' | 'adsbdb') so the frontend can label appropriately.
    requestAcInfo: async (hex) => {
      if (airnav) {
        const info = await airnav.lookup(hex);
        if (info) return { ...info, source: 'airnav' };
      }
      const aircraft = await freeAircraft.lookup(hex);
      if (!aircraft) return null;
      return { hex: String(hex).toLowerCase(), aircraft, live: null, source: 'adsbdb' };
    },
    // Free callsign → route (adsbdb, no token, cached). Powers the
    // flight-number hover even when AirNav is off.
    requestRoute: (cs) => routeLookup.lookup(cs),
    // Settings "Test trigger" button → fire an immediate 2 s capture. Optional
    // host/port let the user test before saving the form; otherwise the live
    // config is used. The token always comes from the saved config (the form
    // only ever sends the masked placeholder).
    requestSharpcapTest: async (opts = {}) => {
      const durationS = Number(opts.durationS) || 2;
      const host = typeof opts.host === 'string' ? opts.host.trim() : '';
      if (host) {
        const tmp = new SharpCapTrigger({
          ...config.sharpcap,
          enabled: true,
          host,
          port: Number(opts.port) || config.sharpcap.port,
        }, { logger });
        return tmp.testTrigger(durationS);
      }
      // No explicit host → test the first configured rig that has one.
      const first = sharpcapTargets.find((t) => t.trigger.config.host);
      if (!first) return { sent: false, reason: 'no-host', error: new Error('no sharpcap host configured') };
      return first.trigger.testTrigger(durationS);
    },
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

    // Click-to-update self-diagnostic. The endpoint only drops a trigger
    // file; a privileged systemd stp-update.path unit (Linux/Pi only) is
    // what actually pulls + restarts. So "did anything consume it?" is the
    // honest signal: the file vanishing = updater picked it up (restart
    // imminent); still there after a grace = NOTHING is consuming it (not
    // a systemd host, or stp-update.path not installed/enabled) — surface
    // that instead of a silent no-op.
    if (config.update?.enabled && lastUpdateRequestMs > 0) {
      const ageMs = nowMs - lastUpdateRequestMs;
      const stillThere = existsSync(config.update.triggerPath);
      let status;
      if (!stillThere) {
        // Trigger consumed. A real update restarts us (this process dies,
        // state resets). If we're still alive 20 s later it was a no-op
        // ("already up to date") — return to idle so the badge doesn't
        // hang on "updating…" forever (the v0.10.0 bug).
        status = ageMs > 20_000 ? 'idle' : 'consumed';
      } else if (ageMs < 12_000) {
        status = 'pending';
      } else if (ageMs > 600_000) {
        // Stuck for 10 min → nothing is ever going to consume it. Clean up
        // the stale trigger so a future (fixed) watcher / click starts
        // fresh, and stop reporting the error indefinitely.
        status = 'idle';
        fsp.rm(config.update.triggerPath, { force: true }).catch(() => {});
      } else {
        status = 'stuck';
      }
      if (status === 'idle') lastUpdateRequestMs = 0;
      state.update = lastUpdateRequestMs
        ? { requestedAtMs: lastUpdateRequestMs, ageMs, status, triggerPath: config.update.triggerPath }
        : { requestedAtMs: 0, ageMs: 0, status: 'idle' };
    } else {
      state.update = { requestedAtMs: 0, ageMs: 0, status: 'idle' };
    }

    // Detection funnel: every airframe with a usable fix counts toward the
    // total regardless of how far off the Sun/Moon line it is; a candidate
    // (tracker only emits ≤ looseThresholdDeg) folds it into the in-band
    // bucket, and a sub-0.5° projected min separation into the near bucket.
    for (const a of aircraft) {
      if (a.icao) detectedIcaos.add(a.icao);
    }

    // Persistent sightings tally over ALL detected traffic. The in-memory
    // map throttles DB writes: a real visit (fresh / ≥ gap) hits SQLite
    // immediately (the count must never be lost); continuous presence only
    // flushes last_seen every flushMs. recordSighting also re-checks the
    // stored last_seen so a plane seen before a restart still counts as a
    // new visit if the gap elapsed.
    if (config.sightings?.enabled) {
      const gapMs = config.sightings.gapMs ?? 1_800_000;
      const flushMs = config.sightings.flushMs ?? 300_000;
      const bump = (kind, key) => {
        if (!key) return;
        const mk = `${kind}:${key}`;
        const mem = sightSeen.get(mk);
        try {
          if (!mem || (nowMs - mem.lastSeenMs) > gapMs) {
            store.recordSighting(kind, key, nowMs, gapMs);
            sightSeen.set(mk, { lastSeenMs: nowMs, lastFlushMs: nowMs });
          } else {
            mem.lastSeenMs = nowMs;
            if (nowMs - mem.lastFlushMs > flushMs) {
              store.touchSighting(kind, key, nowMs);
              mem.lastFlushMs = nowMs;
            }
          }
        } catch (e) { logger.error?.('sighting record failed:', e?.message ?? e); }
      };
      for (const a of aircraft) {
        if (a.icao) bump('icao', String(a.icao).toLowerCase());
        if (a.callsign) bump('flight', String(a.callsign).trim().toUpperCase());
      }
    }
    for (const c of enriched) {
      if (!c.icao || !Number.isFinite(c.closestApproachSepDeg)) continue;
      if (c.closestApproachSepDeg < config.tracker.looseThresholdDeg) inBandIcaos.add(c.icao);
      if (c.closestApproachSepDeg < 0.5) nearIcaos.add(c.icao);
      if (c.closestApproachSepDeg < 0.2) veryNearIcaos.add(c.icao);
    }
    state.detectStats = {
      totalUnique: detectedIcaos.size,
      liveCount: aircraft.length,        // aircraft with a usable fix right now
      inBand: inBandIcaos.size,
      near: nearIcaos.size,
      veryNear: veryNearIcaos.size,
      bandDeg: config.tracker.looseThresholdDeg,
      nearDeg: 0.5,
      veryNearDeg: 0.2,
      sinceMs: state_sinceMs,
    };

    // Refresh the predictor watchlist on the configured cadence, then surface
    // upcoming-today expected events. The rebuild is async but cheap (single
    // SELECT) — it runs at most once per `rebuildIntervalMs`.
    if (config.predictor.enabled
        && nowMs - watchlistBuiltAtMs >= config.predictor.rebuildIntervalMs) {
      await rebuildWatchlist(nowMs);
    }
    state.expected = upcomingExpected(watchlist, nowMs, config.predictor.lookAheadMs);

    // ISS transits — recomputed on a slow cadence (rare-event work) and fed
    // into the lifecycle AND the notifier as ordinary candidates, so the
    // list / FOV / Disc-xing reuse and the user gets a Pushover the moment
    // a Sun/Moon transit is predicted (v0.10.0 — was previously suppressed;
    // the user explicitly wants the early heads-up for these rare events).
    // The notifier also writes the History row(s) via its onEvent hook, so
    // no separate ISS recordEvent is needed here.
    if (config.iss?.enabled
        && (issTle == null || nowMs - lastIssComputeMs >= config.iss.recomputeMs)) {
      const fresh = loadIssTle(config.iss.tlePath);
      if (fresh) issTle = fresh;
      if (issTle) {
        try {
          issEvents = predictIssTransits(observer, issTle.satrec, {
            fromMs: nowMs,
            horizonMs: config.iss.horizonMs,
            bodies: config.tracker.bodies,
            thresholdDeg: config.iss.thresholdDeg,
            looseThresholdDeg: config.iss.looseThresholdDeg,
            name: issTle.name,
          });
        } catch (e) {
          logger.warn?.('ISS prediction failed:', e?.message ?? e);
          issEvents = [];
        }
        try {
          issVisiblePass = nextIssVisiblePass(observer, issTle.satrec, {
            fromMs: nowMs,
            // Visible passes recur ~daily; the long cap only matters at high
            // latitude / midsummer when twilight kills them for weeks. The
            // scan returns at the first hit, so this is essentially free.
            horizonMs: config.iss.visibleHorizonMs ?? config.iss.horizonMs,
          });
        } catch (e) {
          logger.warn?.('ISS visible-pass calc failed:', e?.message ?? e);
          issVisiblePass = null;
        }
      }
      lastIssComputeMs = nowMs;
    }
    // Drop a visible pass once it is over so the Sky-now line never shows a
    // stale "next pass" that already happened.
    if (issVisiblePass && issVisiblePass.endMs < nowMs) issVisiblePass = null;
    // TLE age in days (epoch is a Julian date; JD 2440587.5 = Unix epoch).
    const issTleAgeDays = issTle
      ? (nowMs / 86400000 + 2440587.5 - issTle.satrec.jdsatepoch)
      : null;
    const nextTransit = issEvents.find(e => e.closestApproachAtMs >= nowMs) ?? null;
    const notifyWithinMs = config.iss.notifyWithinMs ?? 3 * 24 * 3600_000;
    state.iss = {
      active: Boolean(issTle),
      name: issTle?.name ?? null,
      tleAgeDays: issTleAgeDays != null ? Math.round(issTleAgeDays * 10) / 10 : null,
      upcoming: issEvents.length,
      nextAtMs: nextTransit?.closestApproachAtMs ?? null,
      // Full next-transit summary so Sky-now can preview body + separation
      // even when it is weeks out. `tentative` = beyond the trustworthy
      // notify window: SGP4+TLE that far out is noise that shifts with
      // every daily TLE refresh, so we show it but do NOT push/log it.
      nextTransit: nextTransit
        ? {
          atMs: nextTransit.closestApproachAtMs,
          body: nextTransit.body,
          sepDeg: nextTransit.closestApproachSepDeg,
          level: nextTransit.level,
          tentative: (nextTransit.closestApproachAtMs - nowMs) > notifyWithinMs,
        }
        : null,
      horizonDays: Math.round((config.iss.horizonMs / 86400000) * 10) / 10,
      notifyWithinDays: Math.round((notifyWithinMs / 86400000) * 10) / 10,
      visiblePass: issVisiblePass,
    };

    // Feed the lifecycle + notifier only the ISS transits that are close
    // enough to be trustworthy (≤ notifyWithinMs). Beyond that a far-future
    // SGP4 prediction would push a Pushover + write a History row that the
    // next daily TLE makes vanish ("phantom transit" / surprise-stat noise)
    // — the Sky-now line still previews it, flagged tentative.
    const issForLifecycle = issEvents.filter(
      ev => ev.closestApproachAtMs >= nowMs - config.lifecycle.imminentWindowMs
        && (ev.closestApproachAtMs - nowMs) <= notifyWithinMs,
    );

    // Unified lifecycle state — merges live tracker + watchlist + previous
    // tick's contacts. The notifier still drives Pushover; the lifecycle
    // adds visibility for 'planned' and 'stale' states which never push but
    // matter in the UI.
    lifecycleMap = updateLifecycle({
      prev: lifecycleMap,
      nowMs,
      trackerCandidates: issForLifecycle.length ? enriched.concat(issForLifecycle) : enriched,
      expected: state.expected,
      liveAircraft: aircraft,
      imminentWindowMs: config.lifecycle.imminentWindowMs,
      plannedWindowMs: config.lifecycle.plannedWindowMs,
      staleGraceMs: config.lifecycle.staleGraceMs,
      maxEntries: config.lifecycle.maxEntries,
      coastMs: config.lifecycle.coastMs,
    });
    state.lifecycle = lifecycleArray(lifecycleMap, nowMs);

    // Persist lifecycle on a slow cadence so a restart can repopulate the UI.
    // Cheap (< 5 KB), async, and we never block the tick on the write.
    if (config.lifecyclePersist?.path
        && nowMs - lastLifecycleSnapshotMs >= (config.lifecyclePersist.snapshotIntervalMs ?? 30_000)) {
      lastLifecycleSnapshotMs = nowMs;
      snapshotLifecycle();
    }

    // When the SharpCap trigger is armed, the other (un-armed) disc's aircraft
    // Pushovers are just noise — suppress them. The allow-list is the UNION of
    // bodies across all enabled rigs: Sun-rig + Moon-rig → both push; only a
    // Sun rig → Moon stays quiet. Trigger off → null = both push. ISS exempt.
    const scBodies = sharpcapArmedBodies();
    notifier.pushBodies = scBodies.length ? scBodies : null;

    try {
      // ISS rides the same notifier path as aircraft → Pushover the moment a
      // transit is predicted, plus the History row(s) via its onEvent hook.
      await notifier.tick(
        issForLifecycle.length ? enriched.concat(issForLifecycle) : enriched,
        nowMs,
      );
    } catch (e) {
      logger.error?.('notifier tick failed:', e);
    }

    // Arm SharpCap against the same live candidate set, every tick — so a
    // transit is never missed because the notifier's single 'imminent' event
    // landed in an ADS-B gap. Fire-and-forget; dedup keeps it to one capture
    // per (icao|body) episode.
    armSharpcapForCandidates(
      issForLifecycle.length ? enriched.concat(issForLifecycle) : enriched,
      nowMs,
    );

    // Header status readout: are any rigs live, for which bodies, how many
    // captures armed this session, and a per-rig breakdown for the tooltip.
    state.sharpcap = {
      enabled: sharpcapAnyEnabled(),
      body: scBodies.join('+'),
      armedCount: sharpcapArmedCount,
      armed: sharpcapArmedLog.slice(),
      targets: sharpcapTargets
        .filter((t) => t.trigger.enabled)
        .map((t) => ({ name: t.name, body: (t.trigger.config.bodies ?? []).join('+') })),
    };
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
    get sharpcapTargets() { return sharpcapTargets; },
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
      // Best-effort: persist the latest last_seen for everything still in
      // session memory (visit counts were already written immediately).
      try {
        for (const [mk, mem] of sightSeen) {
          const i = mk.indexOf(':');
          store.touchSighting(mk.slice(0, i), mk.slice(i + 1), mem.lastSeenMs);
        }
      } catch { /* shutting down — ignore */ }
      store.close();
    },
  };
}
