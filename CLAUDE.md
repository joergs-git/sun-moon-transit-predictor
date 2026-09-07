# sun-moon-transit-predictor — project notes for Claude Code

Read `tasks/lessons.md` first, then this file. Global rules in `~/.claude/CLAUDE.md`
apply (identity = `joergsflow`, no co-author lines, English comments, version bump
on every push).

## What this is

Node 20 ESM service (no build step) that predicts aircraft and satellite
(ISS / HST / Tiangong) transits across the Sun/Moon disc and satellite passes
through deep-sky fields. Runs on a Raspberry Pi 5 with `dump1090-fa`, serves a
browser UI on `:8081`, sends Pushover alerts, optionally triggers SharpCap
capture and slews an ASCOM mount. See `README.md` and the GitHub wiki for the
user-facing story.

## Layout

```
src/            service core (predictor, tracker, geometry, iss/sgp4, sharpcap, server …)
web/            browser UI (vanilla JS, no bundler)
alerts/         mass Pushover alert service: notify.js (worker), lib.js (pure, tested),
                functions/ (Supabase Edge Functions), schema.sql, README.md
docs/alerts/    GitHub Pages signup page for the alert service
scripts/        Pi helpers: bootstrap/install, refresh-tle.js, auto-refresh-tle.js, …
systemd/        units + timers for the Pi (service, TLE refresh, TLE guard)
data/           runtime data on the Pi (SQLite, *.tle) — gitignored, never commit
test/           vitest suites (`npm test`, ~330 tests, all must stay green)
tasks/          todo.md, lessons.md and design docs per feature
MILESTONES.md   one table row per release (M<n> (v<x.y.z>) | summary | done)
```

## Conventions that are not obvious from the code

- **Version bump on every push:** `package.json` + `package-lock.json` (two
  places) + a new row at the end of `MILESTONES.md`. There is no CHANGELOG;
  MILESTONES.md is the changelog. Mention `(vX.Y.Z)` in touched tests/CSS/HTML
  comments where the feature is introduced (existing style).
- **Safety-critical paths** (`src/sharpcap.js` arming, capture trigger,
  notifier stages): extend alongside, don't refactor — the existing tests
  guarantee byte-identical Sun/Moon capture behaviour.
- **UI:** never change layout/colours/text unless asked; Settings grouping is
  by rig (Scopes) not "General".
- The Pi service is **offline by default**; the only network touch for TLEs is
  `scripts/refresh-tle.js` via systemd timer. Keep it that way.

## Alert service (alerts/) — GitHub Actions ops

- Workflow `.github/workflows/transit-alerts.yml`, cron `17 */8 * * *`
  (3×/day), single job `notify` running `node alerts/notify.js`.
- Secrets live in repo Settings → Actions: `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `PUSHOVER_APP_TOKEN`, `ALERTS_HMAC_SECRET`.
  The job exits 0 quietly when they are unset (forks).
- **Check a failure:** `gh run list --workflow=transit-alerts --limit 5`, then
  `gh run view <id> --log-failed`. Worker log lines are prefixed `[alerts]`.
- **Safe reproduction:** `gh workflow run transit-alerts -f dry_run=true`
  predicts and logs but sends nothing. Use it before and after a fix.
- TLEs come from Celestrak `gp.php` (single, un-mirrored endpoint). Since
  v0.60.1 each fetch retries with 10 s / 30 s backoff and logs undici's
  `e.cause.code`. A partial outage skips that satellite; only "no TLEs at all"
  fails the run. A lone red run right after green ones is almost always a
  transient runner-egress hiccup — confirm with a dry-run before changing code.
- Supabase project for the service: `sunmoon-pushover-services`
  (`dmoapforrwsvafxucjqj`, eu-west-1). Details and setup in `alerts/README.md`.

## Commands

```bash
npm test                 # vitest, all suites
node alerts/notify.js    # alert worker (needs the env vars above, DRY_RUN=1 to test)
node scripts/refresh-tle.js   # fetch fresh TLEs into data/*.tle
```
