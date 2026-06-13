// GET /confirm?token=<id>.<hmac> — the double-opt-in click. Flips the row to
// confirmed=true, then 303-redirects to the static confirmed page (the edge
// gateway mangled function-served HTML into plain text, see util.ts). Forged
// or stale tokens land on the invalid-link page; repeat clicks are idempotent.
//
// On the FIRST confirmation (the user actually becomes a subscriber) it also
// fires a best-effort admin Pushover ("New registrant from <place>. Total now
// N.") — nothing about the user's flow changes; see notifyAdminNewUser.

import { envOrThrow, verifyToken, sb, redirectToPage, notifyAdminNewUser } from '../_shared/util.ts';

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token');
  const userId = await verifyToken(token, envOrThrow('ALERTS_HMAC_SECRET'));
  if (!userId) return redirectToPage('invalid-link');

  // Read the prior state so we can tell a first confirmation from a repeat
  // click (only the first should notify the admin).
  const cur = await sb('GET', `alert_users?id=eq.${userId}&select=confirmed&limit=1`);
  const curRows = cur.ok ? await cur.json() : [];
  if (!curRows.length) return redirectToPage('invalid-link');
  const wasConfirmed = curRows[0].confirmed === true;

  // Idempotent confirm (also clears `disabled`, like before).
  const res = await sb('PATCH', `alert_users?id=eq.${userId}`, { confirmed: true, disabled: false });
  const rows = res.ok ? await res.json() : [];
  if (!rows.length) return redirectToPage('invalid-link');

  if (!wasConfirmed) {
    // Best-effort, AFTER the response when the runtime supports it — so the
    // user's redirect isn't delayed by the geocode/count/push.
    const task = notifyAdminNewUser(rows[0]).catch((e) => console.error('admin notify failed:', e));
    const wu = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil;
    if (typeof wu === 'function') wu(task); else await task;
  }

  return redirectToPage('confirmed');
});
