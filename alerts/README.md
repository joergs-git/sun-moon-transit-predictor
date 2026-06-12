# Mass transit alerts — ISS/HST/CSS × Sun/Moon for many subscribers

Push a Pushover message to every subscriber **24–48 h before** the ISS, Hubble
or Tiangong crosses the Sun or Moon **at their location** — exact second
included, promo link to this repo, one-click unsubscribe. Design background:
[`tasks/mass-pushover-service.md`](../tasks/mass-pushover-service.md).

```
docs/alerts/index.html      signup page (GitHub Pages, Leaflet + geolocation)
alerts/functions/…          Supabase Edge Functions: subscribe / confirm / unsubscribe
alerts/schema.sql           Supabase tables (alert_users, alert_notified) + RLS
alerts/notify.js            the worker (GitHub Actions cron, 3×/day)
alerts/lib.js               pure logic — tested in test/alerts-lib.test.js
```

The worker re-uses the Pi service's prediction engine (`src/iss.js`,
`src/sgp4.js`) **read-only** — nothing in `src/` changes.

## Setup (once)

### 1. Supabase

1. Create a project (free tier is fine) at supabase.com.
2. Run [`schema.sql`](./schema.sql) in the SQL editor. RLS stays on with no
   policies — only the service-role key (worker + functions) can touch the
   tables; the browser never talks to the DB directly.
3. Deploy the three functions **with `--no-verify-jwt`** (they serve public
   click links; the HMAC token is the auth):

   ```bash
   supabase functions deploy subscribe   --no-verify-jwt
   supabase functions deploy confirm    --no-verify-jwt
   supabase functions deploy unsubscribe --no-verify-jwt
   ```

   (Copy `alerts/functions/*` into your `supabase/functions/` first, or point
   the CLI at this directory.)
4. Set the function secrets:

   ```bash
   supabase secrets set PUSHOVER_APP_TOKEN=… ALERTS_HMAC_SECRET=…
   ```

   `ALERTS_HMAC_SECRET`: any long random string (`openssl rand -hex 32`).
   `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

### 2. Pushover

Create an **application** at pushover.net/apps → that's `PUSHOVER_APP_TOKEN`.
Free tier: 10 000 messages/month per application — disc transits at a fixed
site are rare, so even ~1000 subscribers stay far below that.

### 3. GitHub repository secrets

`Settings → Secrets and variables → Actions`:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key (Dashboard → API) |
| `PUSHOVER_APP_TOKEN` | same app token as in step 1.4 |
| `ALERTS_HMAC_SECRET` | same secret as in step 1.4 (**must match!**) |

The workflow ([transit-alerts.yml](../.github/workflows/transit-alerts.yml))
runs 3×/day and exits silently while secrets are missing, so merging this
before configuring anything is harmless.

### 4. Signup page

1. Edit `docs/alerts/index.html` → set `FUNCTIONS_BASE` to
   `https://<project-ref>.supabase.co/functions/v1`.
2. Repo `Settings → Pages` → deploy from branch, folder `/docs`.
   Page appears at `https://<owner>.github.io/<repo>/alerts/`.

## How a signup flows

```
page → POST /subscribe → validate key (Pushover users/validate.json)
     → upsert row (confirmed=false) → confirmation push with signed link
user taps → GET /confirm?token=… → confirmed=true
worker run → predicts transits → first time an event enters the 6–48 h
     window: ONE push (fuzzy dedup in alert_notified, restart-safe)
every alert → unsubscribe link → GET /unsubscribe?token=… → row deleted
```

Dead Pushover keys ("user is invalid") flip the row to `disabled=true`
automatically — the service self-cleans.

## Try it without sending anything

```bash
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… PUSHOVER_APP_TOKEN=x \
ALERTS_HMAC_SECRET=x DRY_RUN=1 node alerts/notify.js
```

Or run the workflow manually (workflow_dispatch) with `dry_run` checked.

## Limits & notes (v1)

- **Sun/Moon disc transits only** (`level === 'candidate'`, ≤ 0.3°);
  body elevation floor is the engine's 20°.
- Per-subscriber brute-force prediction: fine into the hundreds of users
  (minutes per run). The corridor-once-then-match optimisation is specced in
  the design doc §3 and slots in behind `pickAlertEvents` without schema
  changes when growth demands it.
- Announce-only — no live countdown (GitHub cron jitter). The message carries
  the exact local time; subscribers set their own alarm.
- Workflow logs are public on a public repo: the worker never logs keys,
  full user ids or coordinates.
