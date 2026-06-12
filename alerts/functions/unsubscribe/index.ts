// GET /unsubscribe?token=<id>.<hmac> — the one-click opt-out link carried in
// every alert message. Deletes the row outright (notified history cascades),
// then 303-redirects to the static unsubscribed page. An already-removed
// subscription also lands there — the outcome the clicker wanted is true.

import { envOrThrow, verifyToken, sb, redirectToPage } from '../_shared/util.ts';

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token');
  const userId = await verifyToken(token, envOrThrow('ALERTS_HMAC_SECRET'));
  if (!userId) return redirectToPage('invalid-link');
  await sb('DELETE', `alert_users?id=eq.${userId}`);
  return redirectToPage('unsubscribed');
});
