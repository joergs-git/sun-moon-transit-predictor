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

/** Tiny self-contained HTML page for the click-link endpoints. */
export function htmlPage(title: string, text: string, extra = ''): Response {
  const body = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<body style="font-family:system-ui;max-width:34em;margin:4em auto;padding:0 1em;
             background:#10141a;color:#dde3ec;text-align:center">
<h2>${title}</h2><p>${text}</p>${extra}
<p style="margin-top:3em"><a style="color:#7fb4ff"
   href="https://github.com/joergs-git/sun-moon-transit-predictor">
   🔭 sun-moon-transit-predictor on GitHub</a></p></body>`;
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });
}
