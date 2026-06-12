// GET /unsubscribe?token=<id>.<hmac> — the one-click opt-out link carried in
// every alert message. Deletes the row outright (notified history cascades)
// and confirms with a tiny page. No login, no second step.

import { envOrThrow, verifyToken, sb, htmlPage } from '../_shared/util.ts';

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token');
  const userId = await verifyToken(token, envOrThrow('ALERTS_HMAC_SECRET'));
  if (!userId) {
    return htmlPage('Invalid link', 'This unsubscribe link is not valid.');
  }
  const res = await sb('DELETE', `alert_users?id=eq.${userId}`);
  const rows = res.ok ? await res.json() : [];
  if (!rows.length) {
    return htmlPage('Already unsubscribed', 'This subscription was already removed.');
  }
  return htmlPage('👋 Unsubscribed',
    'Your location and Pushover key were deleted. You can re-subscribe any time.');
});
