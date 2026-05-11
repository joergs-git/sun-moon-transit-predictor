// Two-stage Pushover notifier with per-(icao, body) dedup.
//
// Stage rules:
//   - 'early':   first detection of a (icao, body) candidate. Sent once.
//   - 'precise': sent once when closestApproachAtMs is within
//                preciseWindowMs of nowMs (default 30 s).
//
// State for a candidate is dropped automatically once its closest approach
// is older than `forgetAfterMs` (default 5 min).

const DEFAULT_PRECISE_WINDOW_MS = 30_000;
const DEFAULT_FORGET_AFTER_MS = 5 * 60_000;

function fmtAlt(altMmsl) {
  const ft = Math.round(altMmsl * 3.28084 / 100) * 100;
  return `${ft}ft`;
}

function fmtSpeedMs(ms) {
  if (typeof ms !== 'number') return '?';
  return `${Math.round(ms / 0.514444)}kt`;
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function buildPayload(stage, candidate, route, nowMs, baseUrl) {
  const ac = candidate.aircraft;
  const callsign = candidate.callsign ?? ac.icao.toUpperCase();
  const flight = route?.flight ?? callsign;
  const origin = route?.origin?.iata ?? route?.origin?.icao ?? null;
  const destination = route?.destination?.iata ?? route?.destination?.icao ?? null;
  const routeStr = origin && destination ? ` ${origin}→${destination}` : '';

  const tMs = candidate.closestApproachAtMs - nowMs;
  const eta = fmtCountdown(tMs);
  const sep = candidate.closestApproachSepDeg.toFixed(2);
  const dur = (candidate.durationMs / 1000).toFixed(1);
  const bodySym = candidate.body === 'Sun' ? 'Sun' : 'Moon';

  const titlePrefix = stage === 'precise' ? `[!] ${bodySym} TRANSIT` : `${bodySym} candidate`;
  const title = `${titlePrefix} T-${eta}: ${flight}`;

  const lines = [
    `${flight}${routeStr}`,
    `${ac.icao.toUpperCase()} · ${fmtAlt(ac.altMmsl)} · ${fmtSpeedMs(ac.groundSpeedMs)}`,
    `min sep ${sep}° · duration ${dur}s · in ${eta}`,
  ];
  if (route?.airline?.name) lines.unshift(route.airline.name);

  // Pushover renders `timestamp` as the moment the event happened; for an
  // early alert the closest approach is in the *future*, so omit it. On
  // 'precise' alerts the closest approach is within ±30 s of now, which is
  // close enough that stamping it gives the user a useful "T-0" anchor.
  /** @type {import('./pushover.js').PushoverMessage} */
  const msg = {
    title,
    message: lines.join('\n'),
    priority: stage === 'precise' ? 1 : 0,
  };
  if (stage === 'precise') {
    msg.timestamp = Math.round(candidate.closestApproachAtMs / 1000);
  }
  if (baseUrl) {
    msg.url = baseUrl;
    msg.urlTitle = 'Sun-Moon Transit Predictor';
  }
  return msg;
}

function candidateKey(candidate) {
  return `${candidate.icao}|${candidate.body}`;
}

export class Notifier {
  /**
   * @param {{
   *   pushover: import('./pushover.js').PushoverClient,
   *   routeLookup?: (callsign: string) => Promise<object|null>,
   *   onEvent?: (evt: { stage: string, candidate: any, route: object|null,
   *                     payload: any, sent: boolean, error?: any }) => void,
   *   preciseWindowMs?: number,
   *   forgetAfterMs?: number,
   *   baseUrl?: string,
   * }} opts
   */
  constructor(opts) {
    this.pushover = opts.pushover;
    this.routeLookup = opts.routeLookup ?? (async () => null);
    this.onEvent = opts.onEvent ?? (() => {});
    this.preciseWindowMs = opts.preciseWindowMs ?? DEFAULT_PRECISE_WINDOW_MS;
    this.forgetAfterMs = opts.forgetAfterMs ?? DEFAULT_FORGET_AFTER_MS;
    this.baseUrl = opts.baseUrl;
    /** @type {Map<string, { earlySent: boolean, preciseSent: boolean,
     *                       lastClosestMs: number }>} */
    this.state = new Map();
  }

  /**
   * Process the current set of candidates and dispatch any pending
   * notifications. Returns the list of dispatched events for the test
   * harness.
   *
   * @param {import('./tracker.js').TransitCandidate[]} candidates
   * @param {number} nowMs
   */
  async tick(candidates, nowMs) {
    const dispatched = [];

    for (const cand of candidates) {
      const key = candidateKey(cand);
      let st = this.state.get(key);
      if (!st) {
        st = { earlySent: false, preciseSent: false, lastClosestMs: cand.closestApproachAtMs };
        this.state.set(key, st);
      }
      st.lastClosestMs = cand.closestApproachAtMs;

      const tMs = cand.closestApproachAtMs - nowMs;
      const stage = !st.earlySent
        ? 'early'
        : !st.preciseSent && tMs <= this.preciseWindowMs && tMs > -this.preciseWindowMs
          ? 'precise'
          : null;
      if (!stage) continue;

      // Prefer a pre-enriched route on the candidate (set by the service so
      // /api/state and the notifier share the same lookup). Fall back to our
      // own lookup only if the candidate carries no `route` key — keeps the
      // unit tests, which build raw candidates, working unchanged.
      let route;
      if ('route' in cand) {
        route = cand.route;
      } else {
        try {
          route = cand.callsign ? await this.routeLookup(cand.callsign) : null;
        } catch {
          route = null;
        }
      }
      const payload = buildPayload(stage, cand, route, nowMs, this.baseUrl);
      let sent = false;
      let err = null;
      try {
        const res = await this.pushover.send(payload);
        sent = !!res?.sent;
      } catch (e) {
        err = e;
      }
      if (stage === 'early') st.earlySent = true;
      if (stage === 'precise') st.preciseSent = true;

      const evt = { stage, candidate: cand, route, payload, sent, error: err };
      this.onEvent(evt);
      dispatched.push(evt);
    }

    this.cleanup(nowMs);
    return dispatched;
  }

  cleanup(nowMs) {
    for (const [key, st] of this.state) {
      if (nowMs - st.lastClosestMs > this.forgetAfterMs) {
        this.state.delete(key);
      }
    }
  }
}
