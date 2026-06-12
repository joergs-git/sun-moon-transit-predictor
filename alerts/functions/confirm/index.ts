// GET /confirm?token=<id>.<hmac> — the double-opt-in click. Flips the row to
// confirmed=true and shows a tiny confirmation page. Forged/stale tokens get
// a 403 page, repeat clicks are harmless (idempotent update).

import { envOrThrow, verifyToken, sb, htmlPage } from '../_shared/util.ts';

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token');
  const userId = await verifyToken(token, envOrThrow('ALERTS_HMAC_SECRET'));
  if (!userId) {
    return htmlPage('Invalid link', 'This confirmation link is not valid.');
  }
  const res = await sb('PATCH', `alert_users?id=eq.${userId}`, { confirmed: true, disabled: false });
  const rows = res.ok ? await res.json() : [];
  if (!rows.length) {
    return htmlPage('Unknown subscription',
      'This subscription does not exist (maybe it was already removed).');
  }
  return htmlPage('✅ Alerts activated',
    'You will get a Pushover message 1–2 days ahead whenever the ISS, Hubble '
    + 'or Tiangong crosses the Sun or Moon as seen from your location.');
});
