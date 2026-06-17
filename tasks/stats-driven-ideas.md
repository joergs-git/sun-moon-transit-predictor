# Stats-driven ideas — what the history data unlocks next

Captured after the v0.41.0 statistics work. Ordered by value/effort.
Reference data: a ~37-day Rheine dataset (busy NW-Europe corridor).

**Status (v0.42.0):** Tier 1 ideas 1–4 ✅ done, idea 5 ✅ as a report section
(per-azimuth floor + antenna integration still open). Ideas 6–11 deferred.

## Tier 1 — high value, modest effort

### 1. One-click "Apply recommended defaults" — ✅ done (v0.42.0)
The report already computes suggested defaults with rationale. Add an **Apply**
button per recommendation (and an "Apply all") in the 📊 Stats modal that PATCHes
`/api/config` with the suggested value. Closes the loop: measure → recommend →
apply, without hand-editing settings. Guardrail: show current→suggested and let
the user deselect any single item.

### 2. Capture-yield / precision metric — ✅ done (v0.42.0)
We now log every arm (`capture_arms`) and every verdict (postmortem
`confirmed`/`probempty`). Join them to answer the real question: **"of the
captures we armed, what fraction caught a genuine on-disc transit?"** That
precision number is the right signal to tune `maxSepDeg` (the 0.5° arming gate):
if yield is high we can tighten to waste fewer clips; if low, the gate or the
elevation floor is wrong. Surface "wasted arms/day" too.

### 3. Self-tuning drift window — ✅ done (v0.42.0, opt-in `sharpcap.adaptiveDrift`)
`maxDriftS` is now a static default (30 s). The data to size it correctly is
already measured per site (time-drift p95). Let the service **recompute
`maxDriftS` from a rolling p95 of recent postmortems** (e.g. weekly), within
clamps. The window then adapts to a site's traffic without anyone touching a
config — a clean instance of "the script learns and adjusts" (the user's item 5,
generalised beyond elevation).

### 4. Per-site elevation floor, applied — ✅ done (v0.42.0, opt-in `sharpcap.adaptiveElevation`)
Item 5 delivered the *recommendation*. The next step is an opt-in
`sharpcap.adaptiveElevation: true` that, when set, lets the service hold the
floor at the learned value (keep ~90 % of confirmed candidates) and re-evaluate
periodically. Strictly opt-in, with the computed value shown in the UI, never
silently overriding a hand-set number.

## Tier 2 — bigger, genuinely useful

### 5. Directional corridor learning — ✅ report section done (v0.42.0); per-azimuth floor + antenna note still open
The user observed their site benefits from **East-West and North-South routes** —
that's a *geometry* fact other sites won't share. Build a learned **azimuth
coverage map** from confirmed candidates (which compass sectors actually produce
transits, at which elevations). Uses:
- **Antenna aiming guidance**: confirm the ADS-B antenna has clear sky toward the
  productive sectors (ties into the FAQ antenna section).
- **Per-azimuth elevation floors**: a corridor that crosses low in the south can
  warrant a lower floor there than elsewhere.
- **Site self-description**: "your transits come mostly from 90°/270° — an E-W
  corridor site" as a one-line learning in the report.

### 6. Confidence calibration from real drift (aircraft)
Aircraft confidence is currently a heuristic. We now have measured sep-drift by
lead time. **Calibrate the live confidence bands from the postmortem drift
distribution** so "green" means an empirically ≤X° likely final error, not a
guessed threshold. Makes the FOV confidence gradient honest per site.

### 7. "Golden hours / today's best windows" heads-up
`hourStats` already finds the peak local hours per body. Turn it into an
optional daily Pushover/e-paper line: *"Today's best Sun window ≈ 10–11 h
(historically your densest)."* Helps plan around the median ~8 min live lead.

### 8. Route/airline-aware pre-warming
Top routes recur (the data shows a heavy Eurowings/Düsseldorf tail). For known
recurring corridors, the predictor could bias scan sensitivity or pre-stage the
watchlist when a familiar flight enters range — a cheap precision win on a busy
site.

## Tier 3 — nice-to-have / polish

### 9. In-modal charts
Render the CSV distributions (sep histogram, drift-by-lead curve, hour
histogram, weekday) as small inline charts in the 📊 Stats modal instead of text.
The data is already in the report object.

### 10. Seasonal / longer-horizon view
With more months of data, expose seasonal Sun-elevation effects and
weekday/holiday traffic patterns (the weekday breakdown is already collected).

### 11. Yield-vs-elevation tradeoff curve
Plot confirmed-candidate count vs elevation floor so the user can *see* the
quantity/quality knee and pick a floor visually, rather than trusting one
recommended number.

---

**Through-line:** the system already *measures* enough to stop shipping guessed
constants. The progression is measure (done) → recommend (done, v0.41.0) →
**apply** (idea 1) → **auto-adapt within guardrails** (ideas 3, 4) → **learn
site geometry** (idea 5). Each step stays opt-in and visible — never a silent
change to a hand-set value.
