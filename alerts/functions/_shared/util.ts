// Shared helpers for the alert edge functions (Deno / Supabase Edge Runtime).
//
// Deploy NOTE: these functions serve public click-links and a cross-origin
// signup form — deploy with --no-verify-jwt; the HMAC token is the auth.

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function envOrThrow(k: string): string {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

/** hex HMAC-SHA256 — must match alerts/lib.js actionToken(). */
export async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Verify `<userId>.<hmacHex>` → userId or null. */
export async function verifyToken(token: string | null, secret: string): Promise<string | null> {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const got = token.slice(dot + 1);
  const want = await hmacHex(userId, secret);
  if (got.length !== want.length) return null;
  let diff = 0;
  for (let i = 0; i < got.length; i += 1) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0 ? userId : null;
}

/** PostgREST call with the service-role key (auto-injected env). */
export async function sb(method: string, path: string, body?: unknown): Promise<Response> {
  const url = envOrThrow('SUPABASE_URL');
  const key = envOrThrow('SUPABASE_SERVICE_ROLE_KEY');
  return fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// The click-link endpoints redirect to static GitHub Pages instead of
// serving HTML themselves — the gateway delivered function-rendered HTML
// as unrendered plain text (lost Content-Type), and a 303 + Location is
// immune to that. The pages live in docs/alerts/.
const PAGES_BASE = (Deno.env.get('PUBLIC_PAGES_URL')
  ?? 'https://joergs-git.github.io/sun-moon-transit-predictor/alerts').replace(/\/$/, '');

/** 303-redirect to one of the static feedback pages in docs/alerts/. */
export function redirectToPage(page: 'confirmed' | 'unsubscribed' | 'invalid-link'): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${PAGES_BASE}/${page}.html`, ...CORS },
  });
}

/**
 * Admin heads-up Pushover when a NEW user confirms (first confirmation only;
 * the caller passes the just-confirmed row). Best-effort and self-contained —
 * it must NEVER throw or block the user's confirm flow, so every external call
 * is wrapped and the whole thing no-ops unless ADMIN_PUSHOVER_USER is set.
 *
 * Message e.g.: "New registrant from Madrid, Spain · Europe/Madrid. Total now 98."
 *
 * Set the admin key as a secret (NOT in the repo):
 *   supabase secrets set ADMIN_PUSHOVER_USER=<your pushover user key>
 */
export async function notifyAdminNewUser(
  user: { lat: number; lon: number; tz?: string | null },
): Promise<void> {
  const adminUser = Deno.env.get('ADMIN_PUSHOVER_USER');
  const appToken = Deno.env.get('PUSHOVER_APP_TOKEN');
  if (!adminUser || !appToken) return;           // feature off / not configured

  // Reverse-geocode the coordinates → "City, Region, Country" (best-effort,
  // no API key — BigDataCloud's free client endpoint). Falls back to the
  // timezone, then the raw coordinates.
  let place = '';
  try {
    const g = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${user.lat}&longitude=${user.lon}&localityLanguage=en`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (g.ok) {
      const d = await g.json();
      const region = d.city || d.locality || d.principalSubdivision;   // city, else region
      place = [region, d.countryName]
        .filter((x: unknown) => typeof x === 'string' && x.trim())
        .join(', ');                                                    // e.g. "Madrid, Spain"
    }
  } catch { /* geocoding is best-effort */ }
  if (!place) place = (user.tz && user.tz.trim()) || `${user.lat.toFixed(2)}, ${user.lon.toFixed(2)}`;

  // Total confirmed subscribers — count=exact, no row payload (limit=1).
  let total = '?';
  try {
    const base = envOrThrow('SUPABASE_URL');
    const key = envOrThrow('SUPABASE_SERVICE_ROLE_KEY');
    const c = await fetch(`${base}/rest/v1/alert_users?confirmed=eq.true&select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
    });
    const range = c.headers.get('content-range');          // e.g. "0-0/98" or "*/98"
    const n = range?.split('/')[1];
    if (n && n !== '*') total = n;
  } catch { /* count is best-effort */ }

  const tzPart = user.tz && user.tz.trim() ? ` · ${user.tz}` : '';
  try {
    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: appToken,
        user: adminUser,
        title: '🆕 New transit-alert registrant',
        message: `New registrant from ${place}${tzPart}. Total now ${total}.`,
      }),
    });
  } catch { /* admin push is best-effort */ }
}
