// GET /confirm?token=<id>.<hmac> — the double-opt-in click. Flips the row to
// confirmed=true, then 303-redirects to the static confirmed page (the edge
// gateway mangled function-served HTML into plain text, see util.ts). Forged
// or stale tokens land on the invalid-link page; repeat clicks are idempotent.

import { envOrThrow, verifyToken, sb, redirectToPage } from '../_shared/util.ts';

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token');
  const userId = await verifyToken(token, envOrThrow('ALERTS_HMAC_SECRET'));
  if (!userId) return redirectToPage('invalid-link');
  const res = await sb('PATCH', `alert_users?id=eq.${userId}`, { confirmed: true, disabled: false });
  const rows = res.ok ? await res.json() : [];
  if (!rows.length) return redirectToPage('invalid-link');
  return redirectToPage('confirmed');
});
