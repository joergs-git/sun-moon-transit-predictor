// Mass transit-alert service — pure logic (no I/O, no env).
//
// Everything here is deliberately side-effect-free so it can be unit-tested
// without a Supabase instance, Pushover account or network: TLE text parsing,
// the event filter (which predictor candidates become a push), fuzzy dedup
// against already-sent rows, the HMAC unsubscribe/confirm token and the
// message text itself. alerts/notify.js wires these to the real world.
//
// The prediction core is REUSED from the Pi service (src/iss.js, src/sgp4.js)
// — read-only imports, no changes to src/.

import { createHmac, timingSafeEqual } from 'node:crypto';

import { twoline2satrec } from '../src/sgp4.js';

/** Satellites the service watches. Keep in sync with scripts/refresh-tle.js. */
export const SATELLITES = [
  { catnr: 25544, tag: 'ISS', name: 'ISS (ZARYA)', typeDesc: 'International Space Station' },
  { catnr: 20580, tag: 'HST', name: 'HST', typeDesc: 'Hubble Space Telescope' },
  { catnr: 48274, tag: 'CSS', name: 'CSS (TIANHE)', typeDesc: 'Tiangong space station' },
];

/**
 * Parse Celestrak TLE text (2- or 3-line form) into a satrec.
 * Returns null on garbage instead of throwing — a partial Celestrak outage
 * must not kill the whole run (same policy as scripts/refresh-tle.js).
 */
export function satrecFromTleText(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const l1 = lines.find((l) => l.startsWith('1 '));
  const l2 = lines.find((l) => l.startsWith('2 '));
  if (!l1 || !l2) return null;
  try {
    return twoline2satrec(l1, l2);
  } catch {
    return null;
  }
}

// The Pi predictor's body-observability floor is 20° (src/geometry.js
// OBSERVABILITY_MIN_ELEVATION_DEG, applied inside predictIssTransits), so
// per-user minima below that are unreachable in v1 — clamp instead of lying.
export const BODY_ELEVATION_FLOOR_DEG = 20;

/**
 * Filter tracker-shaped predictor candidates down to push-worthy events.
 *
 * @param {Array<object>} candidates - output of predictIssTransits
 * @param {{
 *   nowMs: number,
 *   leadMinMs: number,        // ignore events closer than this (cron jitter)
 *   leadMaxMs: number,        // ignore events further out than this
 *   minElevationDeg?: number, // user preference, clamped to the 20° floor
 *   bodies?: string[],        // user's body opt-in, e.g. ['Sun','Moon']
 * }} opts
 * @returns {Array<object>}
 */
export function pickAlertEvents(candidates, opts) {
  const {
    nowMs,
    leadMinMs,
    leadMaxMs,
    minElevationDeg = BODY_ELEVATION_FLOOR_DEG,
    bodies = ['Sun', 'Moon'],
  } = opts;
  const minElev = Math.max(BODY_ELEVATION_FLOOR_DEG, minElevationDeg);
  return candidates.filter((c) => {
    if (c.level !== 'candidate') return false;          // on-disc only, no grazes
    if (!bodies.includes(c.body)) return false;
    const lead = c.closestApproachAtMs - nowMs;
    if (lead < leadMinMs || lead > leadMaxMs) return false;
    const elev = c.aircraftAtClosest?.elevationDeg;
    if (!Number.isFinite(elev) || elev < minElev) return false;
    return true;
  });
}

/**
 * Fuzzy "did we already tell this user about this event" test. The closest-
 * approach time of the same physical event wanders by seconds between TLE
 * refreshes, so equality on a timestamp would re-notify — instead any prior
 * row for the same (sat, body) within ±proximityMs counts as the same event.
 *
 * @param {Array<{sat:string, body:string, event_at_ms:number}>} notifiedRows
 * @param {{icao:string, body:string, closestApproachAtMs:number}} ev
 * @param {number} [proximityMs]
 * @returns {boolean}
 */
export function alreadyNotified(notifiedRows, ev, proximityMs = 30 * 60_000) {
  return notifiedRows.some((r) => r.sat === ev.icao
    && r.body === ev.body
    && Math.abs(Number(r.event_at_ms) - ev.closestApproachAtMs) <= proximityMs);
}

/**
 * Signed action token for the click links (confirm / unsubscribe):
 * `<userId>.<hmac-sha256-hex>`. The id rides along in the clear (it is a
 * random uuid, not secret); the HMAC proves the link was minted by us.
 */
export function actionToken(userId, secret) {
  const sig = createHmac('sha256', secret).update(String(userId)).digest('hex');
  return `${userId}.${sig}`;
}

/** Verify an action token → userId, or null if missing/forged. */
export function verifyActionToken(token, secret) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const got = token.slice(dot + 1);
  const want = createHmac('sha256', secret).update(userId).digest('hex');
  if (got.length !== want.length) return null;
  if (!timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8'))) return null;
  return userId;
}

/** Format an epoch ms in the user's IANA timezone (falls back to UTC). */
export function fmtLocal(ms, tz) {
  const d = new Date(ms);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC',
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'short',
    }).format(d);
  } catch {
    return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  }
}

const BODY_GLYPH = { Sun: '☀', Moon: '🌙' };

/**
 * Build the Pushover payload pieces for one event. The caller adds token,
 * user key and the promo url/url_title.
 *
 * @param {object} ev   - tracker-shaped candidate (predictIssTransits output)
 * @param {{ tz?: string }} user
 * @param {{ unsubscribeUrl: string }} opts
 * @returns {{ title: string, message: string }}
 */
export function formatAlert(ev, user, { unsubscribeUrl }) {
  const glyph = BODY_GLYPH[ev.body] ?? '';
  const when = fmtLocal(ev.closestApproachAtMs, user.tz);
  const elev = Math.round(ev.aircraftAtClosest?.elevationDeg ?? 0);
  const sepArcmin = (ev.closestApproachSepDeg * 60).toFixed(1);
  const durS = ev.durationMs ? (ev.durationMs / 1000).toFixed(1) : null;
  const title = `🛰 ${ev.icao} crosses the ${ev.body} at your location`;
  const lines = [
    `${glyph} ${ev.body} transit by ${ev.callsign ?? ev.icao}`,
    `When: ${when}`,
    `Elevation ${elev}°, miss ${sepArcmin}′${durS ? `, ~${durS} s across the disc` : ''}`,
    '',
    `Stop these alerts: ${unsubscribeUrl}`,
  ];
  return { title, message: lines.join('\n') };
}
