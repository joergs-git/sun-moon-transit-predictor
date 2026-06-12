// POST /subscribe — signup endpoint for the static page (docs/alerts/).
//
// Body: { pushover_key, lat, lon, elev_m?, tz?, bodies?, min_elev_deg? }
//
// Flow: validate input → validate the Pushover key server-side
// (users/validate.json — typos fail loudly BEFORE anything is stored) →
// upsert the row with confirmed=false → send the double-opt-in push with a
// signed confirm link. The worker only ever notifies confirmed rows, so a
// stranger's key entered here results in exactly one "confirm?" message and
// then silence — never transit spam.

import { CORS, envOrThrow, hmacHex, sb, htmlPage } from '../_shared/util.ts';

const json = (status: number, data: unknown) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', ...CORS },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json(400, { error: 'invalid JSON' }); }

  const key = String(b.pushover_key ?? '').trim();
  const lat = Number(b.lat);
  const lon = Number(b.lon);
  if (!/^[A-Za-z0-9]{20,40}$/.test(key)) return json(400, { error: 'pushover_key looks wrong (30-char key from pushover.net)' });
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return json(400, { error: 'lat must be -90..90' });
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return json(400, { error: 'lon must be -180..180' });
  const elevM = Number.isFinite(Number(b.elev_m)) ? Number(b.elev_m) : 0;
  const tz = typeof b.tz === 'string' && b.tz.length <= 64 ? b.tz : null;
  const bodiesIn = Array.isArray(b.bodies) ? b.bodies.filter((x) => x === 'Sun' || x === 'Moon') : [];
  const bodies = bodiesIn.length ? bodiesIn : ['Sun', 'Moon'];
  const minElev = Math.min(85, Math.max(20, Number(b.min_elev_deg) || 20));

  // Pushover-side key validation — the only external truth about the key.
  const appToken = envOrThrow('PUSHOVER_APP_TOKEN');
  const vRes = await fetch('https://api.pushover.net/1/users/validate.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: appToken, user: key }),
  });
  const v = await vRes.json().catch(() => ({ status: 0 }));
  if (v.status !== 1) return json(400, { error: 'Pushover rejected this user key — check it on pushover.net' });

  // Upsert on pushover_key: re-signup just updates location/options. A row
  // that was confirmed stays confirmed (location move ≠ new consent chain);
  // disabled is reset so an opted-out user can deliberately come back.
  const up = await sb('POST', 'alert_users?on_conflict=pushover_key', {
    pushover_key: key, lat, lon, elev_m: elevM, tz, bodies, min_elev_deg: minElev,
    disabled: false,
  });
  if (!up.ok) return json(500, { error: 'database error' });
  const [row] = await up.json();

  if (!row.confirmed) {
    const secret = envOrThrow('ALERTS_HMAC_SECRET');
    const base = (Deno.env.get('PUBLIC_FUNCTIONS_URL')
      ?? `${envOrThrow('SUPABASE_URL')}/functions/v1`).replace(/\/$/, '');
    const confirmUrl = `${base}/confirm?token=${row.id}.${await hmacHex(row.id, secret)}`;
    const p = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: appToken,
        user: key,
        title: 'Confirm your transit alerts',
        message: 'Tap the link to activate satellite-transit alerts for your '
          + `location.\n\nConfirm: ${confirmUrl}\n\nNot you? Just ignore this — `
          + 'nothing else will ever be sent.',
        url: confirmUrl,
        url_title: '✅ Activate alerts',
      }),
    });
    const pd = await p.json().catch(() => ({ status: 0 }));
    if (pd.status !== 1) return json(502, { error: 'could not send the confirmation push' });
  }

  return json(200, { ok: true, confirmed: !!row.confirmed });
});

// (htmlPage imported for parity with the GET endpoints; not used here.)
void htmlPage;
