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

    const result = await this._sendPayload(payload);
    if (result.sent) this.lastTriggered.set(key, nowMs);
    return result;
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
