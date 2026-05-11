// Three-stage Pushover notifier with per-(icao, body) dedup.
//
// Stage rules:
//   - 'radio':    first time we see a (icao, body) at level='radio' (loose
//                 band, wider net, early warning). Sent once. Skip with
//                 minStage='candidate' or 'imminent'.
//   - 'candidate': first time we see a (icao, body) at level='candidate'
//                  (tight 0.3° threshold met). Sent once.
//   - 'imminent': sent once when closestApproachAtMs is within
//                 imminentWindowMs of nowMs (default 30 s). Highest priority.
//
// Stages fire in order: radio → candidate → imminent. Skipping is allowed
// (an aircraft that's directly on the line of sight with no prior 'radio'
// detection will fire 'candidate' on first sighting). Each stage is
// independent; sending one does not prevent the next.
//
// State for a candidate is dropped automatically once its closest approach
// is older than `forgetAfterMs` (default 5 min).

const DEFAULT_IMMINENT_WINDOW_MS = 30_000;
const DEFAULT_FORGET_AFTER_MS = 5 * 60_000;

const STAGE_ORDER = { radio: 0, candidate: 1, imminent: 2 };

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

  // Title prefix per stage. 'imminent' gets the alarm prefix; 'candidate'
  // is the tight-window match; 'radio' is the wide-net early warning.
  const titlePrefix = stage === 'imminent'
    ? `[!] ${bodySym} TRANSIT`
    : stage === 'candidate'
      ? `${bodySym} candidate`
      : `${bodySym} approach`;
  const title = `${titlePrefix} T-${eta}: ${flight}`;

  const lines = [
    `${flight}${routeStr}`,
    `${ac.icao.toUpperCase()} · ${fmtAlt(ac.altMmsl)} · ${fmtSpeedMs(ac.groundSpeedMs)}`,
    `min sep ${sep}° · duration ${dur}s · in ${eta}`,
  ];
  if (route?.airline?.name) lines.unshift(route.airline.name);

  // Pushover renders `timestamp` as the moment the event happened; for the
  // earlier stages the closest approach is in the *future*, so omit it. On
  // 'imminent' alerts the closest approach is within ±30 s of now, which is
  // close enough that stamping it gives the user a useful "T-0" anchor.
  /** @type {import('./pushover.js').PushoverMessage} */
  const msg = {
    title,
    message: lines.join('\n'),
    priority: stage === 'imminent' ? 1 : 0,
  };
  if (stage === 'imminent') {
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
   *   imminentWindowMs?: number,
   *   forgetAfterMs?: number,
   *   minStage?: 'radio'|'candidate'|'imminent',  - opt out of earlier stages
   *   baseUrl?: string,
   * }} opts
   */
  constructor(opts) {
    this.pushover = opts.pushover;
    this.routeLookup = opts.routeLookup ?? (async () => null);
    this.onEvent = opts.onEvent ?? (() => {});
    this.imminentWindowMs = opts.imminentWindowMs ?? DEFAULT_IMMINENT_WINDOW_MS;
    this.forgetAfterMs = opts.forgetAfterMs ?? DEFAULT_FORGET_AFTER_MS;
    this.minStage = opts.minStage ?? 'radio';      // default: send all stages
    this.baseUrl = opts.baseUrl;
    /** @type {Map<string, { radioSent: boolean, candidateSent: boolean,
     *                       imminentSent: boolean, lastClosestMs: number }>} */
    this.state = new Map();
  }

  /**
   * Whether the given stage should be dispatched given the configured minStage.
   * @param {'radio'|'candidate'|'imminent'} stage
   */
  _stageAllowed(stage) {
    return STAGE_ORDER[stage] >= STAGE_ORDER[this.minStage];
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
        st = {
          radioSent: false, candidateSent: false, imminentSent: false,
          lastClosestMs: cand.closestApproachAtMs,
        };
        this.state.set(key, st);
      }
      st.lastClosestMs = cand.closestApproachAtMs;

      const tMs = cand.closestApproachAtMs - nowMs;
      const level = cand.level ?? 'candidate';   // back-compat for old callers
      const inImminentWindow = tMs <= this.imminentWindowMs && tMs > -this.imminentWindowMs;

      // Pick the next stage to fire for this candidate. Stages progress
      // monotonically: once a stage is sent, it is never re-sent. Higher
      // stages can fire even if lower ones never did (e.g. an aircraft that
      // appears straight on the line of sight skips 'radio' entirely).
      let stage = null;
      if (!st.imminentSent && inImminentWindow) {
        stage = 'imminent';
      } else if (!st.candidateSent && level === 'candidate') {
        stage = 'candidate';
      } else if (!st.radioSent && (level === 'radio' || level === 'candidate')) {
        // 'candidate'-level matches also count as having entered the radio
        // band, so we don't double-fire 'radio' for them retroactively.
        stage = 'radio';
      }
      if (!stage) continue;
      if (!this._stageAllowed(stage)) {
        // Mark as "sent" (and all lower stages, by subsumption) so we don't
        // reconsider on the next tick; the user has explicitly opted out.
        if (stage === 'radio') st.radioSent = true;
        if (stage === 'candidate') { st.radioSent = true; st.candidateSent = true; }
        if (stage === 'imminent')  { st.radioSent = true; st.candidateSent = true; st.imminentSent = true; }
        continue;
      }

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
      // Higher stages subsume lower ones — firing 'imminent' implies the
      // aircraft also passed through 'candidate' and 'radio' bands, so we
      // never retroactively emit those on a later tick.
      if (stage === 'radio') {
        st.radioSent = true;
      } else if (stage === 'candidate') {
        st.radioSent = true;
        st.candidateSent = true;
      } else if (stage === 'imminent') {
        st.radioSent = true;
        st.candidateSent = true;
        st.imminentSent = true;
      }

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
