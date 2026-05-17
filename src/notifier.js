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
// Default Pushover-only "near" filter for the radio stage. Tracker still
// emits radio-level matches out to the wider looseThresholdDeg (5°) so the
// tracking panel shows them — but we only buzz the phone when the projected
// separation drops under this much tighter band. Override via config.
const DEFAULT_RADIO_THRESHOLD_DEG = 1.0;

const STAGE_ORDER = { radio: 0, candidate: 1, imminent: 2 };

function fmtAlt(altMmsl) {
  // Metric: round to nearest 100 m, surface as e.g. "10700 m".
  return `${Math.round(altMmsl / 100) * 100} m`;
}

function fmtSpeedMs(ms) {
  // Metric: m/s → km/h, rounded to whole km/h (e.g. "828 km/h").
  if (typeof ms !== 'number') return '?';
  return `${Math.round(ms * 3.6)} km/h`;
}

function fmtRangeM(m) {
  // Metric: line-of-sight distance in km, 1 dp (e.g. "47.2 km").
  if (typeof m !== 'number') return null;
  return `${(m / 1000).toFixed(1)} km`;
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
  // is the tight-window match; 'radio' is the wide-net early warning. The
  // ISS gets its own wording — it's a rare, planned event, not traffic.
  let titlePrefix;
  if (candidate.isISS) {
    titlePrefix = stage === 'imminent'
      ? `[!] 🛰 ISS ${bodySym} TRANSIT`
      : `🛰 ISS ${bodySym} transit predicted`;
  } else {
    titlePrefix = stage === 'imminent'
      ? `[!] ${bodySym} TRANSIT`
      : stage === 'candidate'
        ? `${bodySym} candidate`
        : `${bodySym} approach`;
  }
  const title = `${titlePrefix} T-${eta}: ${flight}`;

  const rangeM = candidate.aircraftAtClosest?.rangeM;
  const rangeStr = fmtRangeM(rangeM);
  const lines = [
    `${flight}${routeStr}`,
    `${ac.icao.toUpperCase()} · ${fmtAlt(ac.altMmsl)} · ${fmtSpeedMs(ac.groundSpeedMs)}`
      + (rangeStr ? ` · ${rangeStr}` : ''),
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
   *   radioThresholdDeg?: number,                  - extra Pushover-only filter
   *                                                  on the wide radio band; the
   *                                                  tracker still surfaces the
   *                                                  full 5° band to the UI
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
    this.radioThresholdDeg = opts.radioThresholdDeg ?? DEFAULT_RADIO_THRESHOLD_DEG;
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
          // *Sent  → Pushover dispatch (gated by minStage + radioThresholdDeg)
          // *Rec   → History record (panel band only, NO phone gates) — see H
          radioSent: false, candidateSent: false, imminentSent: false,
          radioRec: false, candidateRec: false, imminentRec: false,
          lastClosestMs: cand.closestApproachAtMs,
        };
        this.state.set(key, st);
      }
      st.lastClosestMs = cand.closestApproachAtMs;

      const tMs = cand.closestApproachAtMs - nowMs;
      const level = cand.level ?? 'candidate';   // back-compat for old callers
      const inImminentWindow = tMs <= this.imminentWindowMs && tMs > -this.imminentWindowMs;

      // Helper: mark a stage + all lower ones, on either the Sent or the Rec
      // flag set (higher stages subsume lower — firing/recording 'imminent'
      // implies the aircraft also passed through 'candidate' and 'radio').
      const mark = (suffix, stage) => {
        if (stage === 'radio') {
          st[`radio${suffix}`] = true;
        } else if (stage === 'candidate') {
          st[`radio${suffix}`] = true; st[`candidate${suffix}`] = true;
        } else if (stage === 'imminent') {
          st[`radio${suffix}`] = true; st[`candidate${suffix}`] = true; st[`imminent${suffix}`] = true;
        }
      };
      // Next not-yet-X stage entered, monotone. `flag` is 'Sent' or 'Rec'.
      const nextStage = (flag) => {
        if (!st[`imminent${flag}`] && inImminentWindow) return 'imminent';
        if (!st[`candidate${flag}`] && level === 'candidate') return 'candidate';
        // 'candidate'-level also counts as having entered the radio band, so
        // we never retroactively re-emit 'radio' for it.
        if (!st[`radio${flag}`] && (level === 'radio' || level === 'candidate')) return 'radio';
        return null;
      };

      const recStage = nextStage('Rec');
      const sendStage = nextStage('Sent');
      // Nothing new this tick for either pipeline — skip the route lookup.
      if (!recStage && !sendStage) continue;

      // Resolve the route once, shared by the history record and the
      // Pushover. Prefer a pre-enriched route on the candidate (set by the
      // service so /api/state and the notifier share one lookup); fall back
      // to our own lookup only when the candidate carries no `route` key —
      // keeps the unit tests, which build raw candidates, working unchanged.
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

      // ---- History record: full panel band, independent of phone gates ----
      // The tracker only ever emits candidates already inside
      // looseThresholdDeg, so every stage entered here is panel-worthy.
      // Recording the radio stage the moment it is entered — even when the
      // phone deliberately stays quiet for the wide early band — is what
      // restores the real lead time in the History table (the v0.7.x bug
      // where Recorded sat ~30 s before Transit: the radio/candidate rows
      // were being suppressed alongside the Pushover, so only the late
      // imminent row survived). Phone behaviour below is unchanged.
      if (recStage) {
        mark('Rec', recStage);
        try {
          this.onEvent({
            stage: recStage, candidate: cand, route,
            payload: null, sent: false, recordedOnly: true,
          });
        } catch { /* history must never break the notifier loop */ }
      }

      // ---- Pushover dispatch: unchanged gating ----
      if (!sendStage) continue;
      if (!this._stageAllowed(sendStage)) {
        // minStage opt-out: mark sent (and lower, by subsumption) so we
        // don't reconsider on the next tick.
        mark('Sent', sendStage);
        continue;
      }
      // Extra Pushover-only filter on the radio band: the panel still shows
      // matches out to looseThresholdDeg, but the phone only buzzes when the
      // projected minimum separation is at/below radioThresholdDeg (1° by
      // default). Mark sent so a still-loose match doesn't re-trigger every
      // poll; an upgrade to candidate/imminent still fires under its gate.
      if (sendStage === 'radio'
          && Number.isFinite(this.radioThresholdDeg)
          && Number.isFinite(cand.closestApproachSepDeg)
          && cand.closestApproachSepDeg > this.radioThresholdDeg) {
        st.radioSent = true;
        continue;
      }

      const payload = buildPayload(sendStage, cand, route, nowMs, this.baseUrl);
      let sent = false;
      let err = null;
      try {
        const res = await this.pushover.send(payload);
        sent = !!res?.sent;
      } catch (e) {
        err = e;
      }
      mark('Sent', sendStage);
      dispatched.push({ stage: sendStage, candidate: cand, route, payload, sent, error: err });
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
