// SharpCap trigger client. Sends a single-line JSON record over TCP to the
// SharpCap-side listener (scripts/sharpcap/trigger_listener.py running inside
// SharpCap as an IronPython script). The listener arms a capture with an
// optional pre-roll so the recording window straddles closest approach.
//
// Wire format (one JSON object terminated by '\n'):
//   { "label": "abc123|Sun", "preRollS": 4.7, "durationS": 20, "token": "..." }
// Reply (one JSON object terminated by '\n'):
//   { "ok": true, "captureId": "..." }            on success
//   { "ok": false, "error": "busy"|"unauth"|... } on failure
//
// The connection is closed by the listener after the reply, so trigger() is a
// short-lived single-shot RPC. Failures NEVER throw out of trigger() — a dead
// Windows host must not bring the predictor service down — they are returned
// as { sent: false, error } so the caller can log and move on.

import net from 'node:net';

const DEFAULT_PORT = 9999;
const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
const DEFAULT_PRE_BUFFER_S = 5;     // start capture this much BEFORE closest approach
const DEFAULT_POST_BUFFER_S = 15;   // keep recording this much AFTER closest approach
const DEFAULT_DEDUP_MS = 60_000;    // suppress identical (icao|body) re-triggers
// Tick-based arming (armForCandidate): "rather over-record than miss a shot".
const DEFAULT_MAX_SEP_DEG = 0.5;    // arm any candidate projected within this sep
const DEFAULT_MAX_PRE_ROLL_S = 85;  // keep pre-roll under the listener's 90 s cap
// Arming early (to never miss a lost-tracking case) means the predicted
// closest-approach TIME is less accurate the further out we are — for a
// candidate that then goes stale the estimate can drift 30 s+. Widen the
// recording window symmetrically by leadDriftFrac × leadSeconds (capped) so a
// drifting prediction still lands inside the clip. Generous on purpose
// ("rather over-record than miss"): at lead 50 s, 0.5 → ±25 s extra around
// the normal pre/post window; at lead 80 s the cap (45 s) holds it to ±55 s.
const DEFAULT_LEAD_DRIFT_FRAC = 0.5;
const DEFAULT_MAX_DRIFT_S = 45;
// Keep the total clip safely under the listener's MAX_DURATION_S (120 s) so a
// generous preBuffer+postBuffer+drift combo is never rejected as 'over-limit'.
const DEFAULT_MAX_CAPTURE_S = 115;
// Re-arm an already-armed capture when the refined closest-approach prediction
// moves more than this — the listener replaces the still-pending (pre-roll)
// capture with the fresher time. Fixes the "armed early on a stale prediction
// that later corrected" miss.
const DEFAULT_REARM_SHIFT_S = 12;

/**
 * @typedef {Object} SharpCapConfig
 * @property {boolean} [enabled]
 * @property {string}  [host]              - Windows host running SharpCap
 * @property {number}  [port]              - listener TCP port (default 9999)
 * @property {string}  [token]             - optional shared secret
 * @property {number}  [preBufferS]        - seconds before closest approach
 * @property {number}  [postBufferS]       - seconds after closest approach
 * @property {number}  [connectTimeoutMs]
 * @property {number}  [dedupMs]
 * @property {'radio'|'candidate'|'imminent'} [triggerOnStage]
 * @property {number}  [minElevationDeg]   - skip if body/aircraft is too low (0 = off)
 * @property {string[]} [bodies]           - which bodies to record (default Sun + Moon)
 */

/**
 * Pull a compact human-readable metadata bundle out of a tracker candidate.
 * Shipped alongside the trigger payload so the SharpCap-side listener can
 * print provenance to its scripting console AND append a structured line to
 * its persistent logfile — answers "what was this clip OF?" months later.
 * All fields are optional; the listener tolerates a missing meta entirely
 * (backward compatible with pre-v0.30 servers).
 */
function buildTriggerMeta(c) {
  if (!c) return undefined;
  const meta = {};
  if (c.callsign) meta.flight = String(c.callsign).trim().toUpperCase();
  if (c.icao) meta.icao = String(c.icao).toUpperCase();
  if (c.body) meta.body = c.body;
  if (Number.isFinite(c.closestApproachSepDeg)) meta.sepDeg = c.closestApproachSepDeg;
  if (Number.isFinite(c.closestApproachAtMs)) meta.closestAtMs = c.closestApproachAtMs;
  const r = c.route;
  if (r) {
    if (r.airline?.name || r.airline?.iata) meta.airline = r.airline?.name ?? r.airline?.iata;
    const oCode = r.origin?.iata ?? r.origin?.icao;
    const dCode = r.destination?.iata ?? r.destination?.icao;
    if (oCode) meta.origin = oCode;
    if (dCode) meta.destination = dCode;
  }
  const ac = c.aircraftAtClosest;
  if (ac) {
    if (Number.isFinite(ac.altMmsl)) meta.altMmsl = ac.altMmsl;
    if (Number.isFinite(ac.elevationDeg)) meta.elevationDeg = ac.elevationDeg;
    if (Number.isFinite(ac.azimuthDeg)) meta.azimuthDeg = ac.azimuthDeg;
  }
  if (Number.isFinite(c.groundSpeedMs)) meta.groundSpeedMs = c.groundSpeedMs;
  if (Number.isFinite(c.trackDeg)) meta.trackDeg = c.trackDeg;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export class SharpCapTrigger {
  /**
   * @param {SharpCapConfig} config
   * @param {{ logger?: { info?: Function, warn?: Function, error?: Function },
   *           netImpl?: typeof net }} [opts]
   */
  constructor(config = {}, { logger = console, netImpl = net } = {}) {
    this.config = { ...config };
    this.logger = logger;
    this.net = netImpl;
    /** @type {Map<string, number>} key → last triggered at ms */
    this.lastTriggered = new Map();
    /** @type {Map<string, number>} key → closestApproachAtMs that was armed */
    this.armedClosest = new Map();
  }

  get enabled() {
    return Boolean(this.config?.enabled && this.config.host);
  }

  get triggerOnStage() {
    return this.config.triggerOnStage ?? 'imminent';
  }

  /**
   * Should this candidate/stage actually go to SharpCap? Pure check — no I/O.
   * @param {{ stage: string, candidate: any }} evt
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  shouldTrigger(evt) {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    if (evt.stage !== this.triggerOnStage) return { ok: false, reason: 'wrong-stage' };
    const c = evt.candidate;
    if (!c) return { ok: false, reason: 'no-candidate' };

    const bodies = this.config.bodies;
    if (Array.isArray(bodies) && bodies.length && !bodies.includes(c.body)) {
      return { ok: false, reason: 'body-filtered' };
    }

    const minEl = this.config.minElevationDeg;
    if (Number.isFinite(minEl) && minEl > 0) {
      const el = c.aircraftAtClosest?.elevationDeg ?? c.bodyAtClosest?.elevationDeg;
      if (Number.isFinite(el) && el < minEl) return { ok: false, reason: 'too-low' };
    }

    return { ok: true };
  }

  /**
   * Trigger a SharpCap recording for the given transit candidate.
   * Computes pre-roll from (closestApproachAtMs - nowMs - preBufferS) so the
   * recording window straddles closest approach by pre/postBufferS seconds.
   *
   * @param {{ stage: string, candidate: any }} evt
   * @param {number} [nowMs]
   * @returns {Promise<{ sent: boolean, response?: any, error?: any, reason?: string }>}
   */
  async triggerFromEvent(evt, nowMs = Date.now()) {
    const decide = this.shouldTrigger(evt);
    if (!decide.ok) return { sent: false, reason: decide.reason };

    const c = evt.candidate;
    const key = `${c.icao ?? c.callsign ?? 'unknown'}|${c.body}`;
    const dedupMs = this.config.dedupMs ?? DEFAULT_DEDUP_MS;
    const last = this.lastTriggered.get(key);
    if (last != null && nowMs - last < dedupMs) {
      return { sent: false, reason: 'deduped' };
    }

    const preBufferS = Number.isFinite(this.config.preBufferS) ? this.config.preBufferS : DEFAULT_PRE_BUFFER_S;
    const postBufferS = Number.isFinite(this.config.postBufferS) ? this.config.postBufferS : DEFAULT_POST_BUFFER_S;
    const tToClosestS = (c.closestApproachAtMs - nowMs) / 1000;
    const preRollS = Math.max(0, tToClosestS - preBufferS);
    const durationS = Math.max(1, preBufferS + postBufferS);

    const payload = { label: key, preRollS, durationS };
    if (this.config.token) payload.token = this.config.token;
    const meta = buildTriggerMeta(c);
    if (meta) payload.meta = meta;

    const result = await this._sendPayload(payload);
    if (result.sent) this.lastTriggered.set(key, nowMs);
    return result;
  }

  /**
   * Tick-based arming — the "never miss a transit" path. Unlike
   * triggerFromEvent (which only fires on a single notifier stage event,
   * the fragile ±30 s 'imminent' window), this is meant to be called every
   * service tick for every live candidate. It arms the capture as soon as
   * the closest approach is near enough that the pre-roll fits the listener's
   * cap, so even a brief / marginal candidate that the imminent stage would
   * have missed (e.g. an ADS-B gap in the last 30 s) still gets recorded. The
   * (icao|body) dedup keeps it to one capture per episode.
   *
   * Gates, in order: enabled → body filter → capture-worthy separation
   * (maxSepDeg, generous on purpose) → elevation → time window → dedup.
   *
   * @param {any} candidate  a tracker candidate (closestApproachAtMs etc.)
   * @param {number} [nowMs]
   * @returns {Promise<{ sent: boolean, response?: any, error?: any, reason?: string }>}
   */
  async armForCandidate(candidate, nowMs = Date.now()) {
    if (!this.enabled) return { sent: false, reason: 'disabled' };
    const c = candidate;
    if (!c || !Number.isFinite(c.closestApproachAtMs)) {
      return { sent: false, reason: 'no-candidate' };
    }

    const bodies = this.config.bodies;
    if (Array.isArray(bodies) && bodies.length && !bodies.includes(c.body)) {
      return { sent: false, reason: 'body-filtered' };
    }

    // Capture-worthy separation. Deliberately generous (default 0.5°, the
    // near-miss band) so we err toward over-recording rather than missing a
    // tight pass that the projection slightly under/over-estimated.
    const maxSepDeg = Number.isFinite(this.config.maxSepDeg)
      ? this.config.maxSepDeg : DEFAULT_MAX_SEP_DEG;
    if (Number.isFinite(c.closestApproachSepDeg) && c.closestApproachSepDeg > maxSepDeg) {
      return { sent: false, reason: 'too-wide' };
    }

    const minEl = this.config.minElevationDeg;
    if (Number.isFinite(minEl) && minEl > 0) {
      const el = c.aircraftAtClosest?.elevationDeg ?? c.bodyAtClosest?.elevationDeg;
      if (Number.isFinite(el) && el < minEl) return { sent: false, reason: 'too-low' };
    }

    const preBufferS = Number.isFinite(this.config.preBufferS) ? this.config.preBufferS : DEFAULT_PRE_BUFFER_S;
    const postBufferS = Number.isFinite(this.config.postBufferS) ? this.config.postBufferS : DEFAULT_POST_BUFFER_S;
    const maxPreRollS = Number.isFinite(this.config.maxPreRollS) ? this.config.maxPreRollS : DEFAULT_MAX_PRE_ROLL_S;
    const tToClosestS = (c.closestApproachAtMs - nowMs) / 1000;
    // Too far out for the pre-roll to fit the listener cap → wait (a later
    // tick will arm it). Too far past closest (beyond the post-roll) → the
    // window would record nothing useful.
    if (tToClosestS > preBufferS + maxPreRollS) return { sent: false, reason: 'too-early' };
    if (tToClosestS < -postBufferS) return { sent: false, reason: 'too-late' };

    const key = `${c.icao ?? c.callsign ?? 'unknown'}|${c.body}`;
    const dedupMs = this.config.dedupMs ?? DEFAULT_DEDUP_MS;
    const last = this.lastTriggered.get(key);
    let reArm = false;
    if (last != null && nowMs - last < dedupMs) {
      // Already armed this episode. Normally dedup → skip. But if the refined
      // closest-approach prediction has moved more than reArmShiftS since we
      // armed, re-send: the listener replaces the still-pending (pre-roll)
      // capture with the fresher time. This fixes the "armed early on a stale
      // prediction that later corrected" miss without waiting out dedupMs.
      const reArmShiftS = Number.isFinite(this.config.reArmShiftS)
        ? this.config.reArmShiftS : DEFAULT_REARM_SHIFT_S;
      const armedClosest = this.armedClosest.get(key);
      const shiftS = Number.isFinite(armedClosest)
        ? Math.abs(c.closestApproachAtMs - armedClosest) / 1000 : 0;
      if (shiftS <= reArmShiftS) return { sent: false, reason: 'deduped' };
      reArm = true;
    }

    // Widen the window by a drift margin that scales with how early we armed —
    // the predicted closest-approach time gets less certain the further out we
    // are, so an early arm records a proportionally longer clip to stay safe.
    // Window = [closest − preBuffer − drift, closest + postBuffer + drift].
    const driftFrac = Number.isFinite(this.config.leadDriftFrac) ? this.config.leadDriftFrac : DEFAULT_LEAD_DRIFT_FRAC;
    const maxDriftS = Number.isFinite(this.config.maxDriftS) ? this.config.maxDriftS : DEFAULT_MAX_DRIFT_S;
    const maxCaptureS = Number.isFinite(this.config.maxCaptureS) ? this.config.maxCaptureS : DEFAULT_MAX_CAPTURE_S;
    let driftS = Math.min(Math.max(0, tToClosestS) * driftFrac, maxDriftS);
    // Trim the drift so preBuffer+postBuffer+2·drift never exceeds the
    // listener's safety cap — keeps the window centred and never 'over-limit'.
    const driftRoom = Math.max(0, (maxCaptureS - preBufferS - postBufferS) / 2);
    driftS = Math.min(driftS, driftRoom);
    const preRollS = Math.max(0, tToClosestS - preBufferS - driftS);
    const durationS = Math.max(1, Math.min(preBufferS + postBufferS + 2 * driftS, maxCaptureS));
    const payload = { label: key, preRollS, durationS };
    if (this.config.token) payload.token = this.config.token;
    const meta = buildTriggerMeta(c);
    if (meta) payload.meta = meta;

    // Claim the dedup slot BEFORE the await so two ticks in the same window
    // can't both fire; release it on hard NETWORK failure so the next tick
    // retries — the whole point is to not miss a transit because of a
    // transient send error. v0.30.3: a listener-level rejection (busy /
    // unauth / no-camera / over-limit / bad-*) is NOT a transient error;
    // the listener received our payload and gave a definitive answer.
    // Treating those as "retry next tick" caused a TCP-storm during every
    // recording (~25 busy entries in the listener log for a 110 s clip)
    // because each "busy" deleted the dedup, and the next tick re-fired.
    this.lastTriggered.set(key, nowMs);
    this.armedClosest.set(key, c.closestApproachAtMs);
    const result = await this._sendPayload(payload);
    if (!result.sent && !result.response) {
      // No JSON reply at all → connect/timeout/socket-closed. Listener may
      // be down or restarting; clear dedup so the next tick retries.
      this.lastTriggered.delete(key);
      this.armedClosest.delete(key);
    }
    if (result.sent && reArm) result.reArmed = true;
    return result;
  }

  /**
   * Fire an immediate, short test capture (no pre-roll), bypassing the
   * stage/body/elevation/dedup gates. Used by the Settings "Test trigger"
   * button to verify connectivity to the Windows host. Requires only that a
   * host is configured — works even when `enabled` is still false so you can
   * test before switching the feature on.
   * @param {number} [durationS]
   * @returns {Promise<{ sent: boolean, response?: any, error?: any, reason?: string }>}
   */
  async testTrigger(durationS = 2) {
    if (!this.config?.host) {
      return { sent: false, reason: 'no-host', error: new Error('sharpcap.host is not set') };
    }
    const payload = { label: 'manual-test', preRollS: 0, durationS: Math.max(1, Number(durationS) || 2) };
    if (this.config.token) payload.token = this.config.token;
    return this._sendPayload(payload);
  }

  /**
   * Low-level: send one JSON payload and read one JSON reply. Internal — use
   * triggerFromEvent() for the real flow.
   * @param {object} payload
   */
  async _sendPayload(payload) {
    const host = this.config.host;
    const port = this.config.port ?? DEFAULT_PORT;
    const timeoutMs = this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (res) => { if (!settled) { settled = true; resolve(res); } };

      const socket = this.net.createConnection({ host, port });
      let buf = '';
      const timer = setTimeout(() => {
        try { socket.destroy(); } catch { /* ignore */ }
        finish({ sent: false, error: new Error(`sharpcap connect/reply timeout after ${timeoutMs} ms`) });
      }, timeoutMs);

      socket.setEncoding('utf8');
      socket.on('connect', () => {
        try { socket.write(JSON.stringify(payload) + '\n'); }
        catch (e) {
          clearTimeout(timer);
          try { socket.destroy(); } catch { /* ignore */ }
          finish({ sent: false, error: e });
        }
      });
      socket.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          const line = buf.slice(0, nl);
          try { socket.end(); } catch { /* ignore */ }
          let resp;
          try { resp = JSON.parse(line); }
          catch (e) { finish({ sent: false, error: new Error(`invalid JSON reply: ${e.message}`) }); return; }
          if (resp && resp.ok) finish({ sent: true, response: resp });
          else finish({ sent: false, response: resp, error: new Error(resp?.error ?? 'unknown listener error') });
        }
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        finish({ sent: false, error: err });
      });
      socket.on('close', () => {
        if (!settled) {
          clearTimeout(timer);
          finish({ sent: false, error: new Error('sharpcap socket closed before reply') });
        }
      });
    });
  }
}
