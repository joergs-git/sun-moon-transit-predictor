#!/usr/bin/env node
// Mass transit-alert worker. Run by .github/workflows/transit-alerts.yml on a
// 6–12 h cron (and by hand via `node alerts/notify.js`). One run:
//
//   1. fetch fresh TLEs for ISS / HST / CSS from Celestrak
//   2. fetch confirmed subscribers from Supabase
//   3. per subscriber: predict Sun/Moon disc transits over the lead window
//      (re-uses src/iss.js verbatim — the same engine the Pi runs)
//   4. fuzzy-dedup against alert_notified, send Pushover, record the send
//
// Announce-only by design: the message carries the exact local time 24–48 h
// ahead; there is no live countdown (GitHub cron jitter makes that a lie).
//
// Env (all required unless noted):
//   SUPABASE_URL                e.g. https://xyz.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   service key — worker only, never the browser
//   PUSHOVER_APP_TOKEN          the operator's Pushover application token
//   ALERTS_HMAC_SECRET          signs the unsubscribe links
//   FUNCTIONS_BASE_URL          optional, default <SUPABASE_URL>/functions/v1
//   PROMO_URL                   optional, default = this GitHub repo
//   LEAD_MIN_HOURS / LEAD_MAX_HOURS   optional, default 6 / 48
//   DRY_RUN=1                   optional — predict + log, send nothing

import { predictIssTransits } from '../src/iss.js';
import {
  SATELLITES, satrecFromTleText, pickAlertEvents, alreadyNotified,
  actionToken, formatAlert,
} from './lib.js';

const env = (k, fallback) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) {
    console.error(`[alerts] missing required env ${k}`);
    process.exit(1);
  }
  return v;
};

const SUPABASE_URL = env('SUPABASE_URL').replace(/\/$/, '');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const PUSHOVER_TOKEN = env('PUSHOVER_APP_TOKEN');
const HMAC_SECRET = env('ALERTS_HMAC_SECRET');
const FUNCTIONS_BASE = env('FUNCTIONS_BASE_URL', `${SUPABASE_URL}/functions/v1`).replace(/\/$/, '');
const PROMO_URL = env('PROMO_URL', 'https://github.com/joergs-git/sun-moon-transit-predictor');
const LEAD_MIN_MS = Number(env('LEAD_MIN_HOURS', '6')) * 3600_000;
const LEAD_MAX_MS = Number(env('LEAD_MAX_HOURS', '48')) * 3600_000;
const DRY_RUN = process.env.DRY_RUN === '1';

const log = (...a) => console.log('[alerts]', ...a);

async function fetchTle(catnr) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${catnr}&FORMAT=tle`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Supabase PostgREST call with the service key. Throws on non-2xx. */
async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'GET' ? 'count=none' : 'return=minimal',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase ${method} ${path.split('?')[0]} → HTTP ${res.status}`);
  return method === 'GET' ? res.json() : null;
}

async function sendPushover(userKey, { title, message }) {
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: PUSHOVER_TOKEN,
      user: userKey,
      title,
      message,
      url: PROMO_URL,
      url_title: '🔭 sun-moon-transit-predictor on GitHub',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.status === 1) return { ok: true };
  // "user is invalid/disabled" → the key is dead, deactivate the row so the
  // service self-cleans instead of burning quota on it every run.
  const userDead = res.status >= 400 && res.status < 500
    && (data.errors ?? []).some((e) => /user/i.test(e) && /invalid|disabled/i.test(e));
  return { ok: false, userDead, status: res.status };
}

async function main() {
  const nowMs = Date.now();

  // 1. TLEs — a partial Celestrak outage skips that satellite, never the run.
  const sats = [];
  for (const s of SATELLITES) {
    try {
      const satrec = satrecFromTleText(await fetchTle(s.catnr));
      if (!satrec) throw new Error('unparseable TLE');
      sats.push({ ...s, satrec });
      log(`TLE ok: ${s.tag}`);
    } catch (e) {
      console.error(`[alerts] TLE failed for ${s.tag}: ${e?.message ?? e}`);
    }
  }
  if (!sats.length) {
    console.error('[alerts] no TLEs at all — aborting');
    process.exit(1);
  }

  // 2. Subscribers.
  const users = await sb('GET',
    'alert_users?confirmed=eq.true&disabled=eq.false'
    + '&select=id,pushover_key,lat,lon,elev_m,tz,bodies,min_elev_deg');
  log(`${users.length} confirmed subscriber(s)`);

  let sent = 0;
  let skippedDup = 0;
  let failed = 0;

  for (const u of users) {
    const observer = {
      latitudeDeg: Number(u.lat),
      longitudeDeg: Number(u.lon),
      elevationM: Number(u.elev_m) || 0,
    };

    // 3. Predict per satellite, then filter to the announce window.
    let events = [];
    for (const s of sats) {
      const cands = predictIssTransits(observer, s.satrec, {
        fromMs: nowMs,
        horizonMs: LEAD_MAX_MS,
        bodies: ['Sun', 'Moon'],
        tag: s.tag,
        name: s.name,
        typeDesc: s.typeDesc,
      });
      events = events.concat(pickAlertEvents(cands, {
        nowMs,
        leadMinMs: LEAD_MIN_MS,
        leadMaxMs: LEAD_MAX_MS,
        minElevationDeg: Number(u.min_elev_deg) || undefined,
        bodies: Array.isArray(u.bodies) ? u.bodies : ['Sun', 'Moon'],
      }));
    }
    if (!events.length) continue;

    // 4. Dedup against everything already sent to this user for the future.
    const notified = await sb('GET',
      `alert_notified?user_id=eq.${u.id}&event_at_ms=gte.${nowMs - 3600_000}`
      + '&select=sat,body,event_at_ms');

    for (const ev of events) {
      if (alreadyNotified(notified, ev)) {
        skippedDup += 1;
        continue;
      }
      const unsubscribeUrl = `${FUNCTIONS_BASE}/unsubscribe?token=${actionToken(u.id, HMAC_SECRET)}`;
      const payload = formatAlert(ev, u, { unsubscribeUrl });

      if (DRY_RUN) {
        log(`DRY ${u.id.slice(0, 8)}…: ${ev.icao} × ${ev.body} @ ${new Date(ev.closestApproachAtMs).toISOString()}`);
        sent += 1;
        continue;
      }

      const r = await sendPushover(u.pushover_key, payload);
      if (r.ok) {
        sent += 1;
        await sb('POST', 'alert_notified', {
          user_id: u.id, sat: ev.icao, body: ev.body, event_at_ms: ev.closestApproachAtMs,
        });
      } else if (r.userDead) {
        log(`deactivating dead key for user ${u.id.slice(0, 8)}…`);
        await sb('PATCH', `alert_users?id=eq.${u.id}`, { disabled: true });
        failed += 1;
        break;                                   // no point trying their other events
      } else {
        console.error(`[alerts] pushover HTTP ${r.status} for user ${u.id.slice(0, 8)}…`);
        failed += 1;
      }
      await new Promise((res) => setTimeout(res, 250));   // be gentle to the API
    }
  }

  log(`done: ${sent} sent${DRY_RUN ? ' (dry-run)' : ''}, ${skippedDup} duplicate(s) skipped, ${failed} failed`);
}

main().catch((e) => {
  console.error('[alerts] fatal:', e?.message ?? e);
  process.exit(1);
});
