# Lessons Learned

(No lessons recorded yet. Append one entry per user correction, format:)

## [YYYY-MM-DD] — <short title>
- **Mistake:** <what was done wrong>
- **Root cause:** <why it happened>
- **Rule:** <what to always/never do instead>
- **Applies to:** <context>

## [2026-07-02] — A user preference must not be gated on an unrelated feature toggle
- **Mistake:** The body-observability floor (drives the "Sun/Moon below observable
  limit (< N°)" banner AND the tracker's candidate-emission gate) was auto-widened
  only from `sharpcapTargets` where `trigger.enabled` was true. A user who set the
  scope floor to 10° but left SharpCap **auto-capture** disabled still got the
  hardcoded 20° default → Sun at 13–16° flagged not observable, every 10–20°
  transit silently dropped.
- **Root cause:** Two orthogonal concepts were conflated behind one flag. `enabled`
  means "fire a SharpCap recording"; `minElevationDeg` means "lowest elevation
  worth tracking". Gating the *tracking floor* on the *capture toggle* let one knob
  silently override an explicit user setting.
- **Rule:** When a setting expresses a *what-to-do* preference (a floor, a filter,
  a threshold), apply it independently of *whether-to-act* toggles. Before trusting
  derived config, verify against the LIVE `/api/config` + `/api/state` on the box,
  not the placeholder dev config — the ground truth exposed the disabled-rig case
  a code read alone would have missed.
- **Applies to:** src/service.js `effectiveMinBodyElevDeg` derivation; any
  auto-widen/auto-narrow loop that iterates rigs/triggers with an `enabled` guard.

## [2026-06-23] — Overlay and plotted content must share ONE coordinate frame
- **Mistake:** In the FOV sketch the sensor-FOV box was rotated into the camera
  frame (via `computeSensorMatrix`), but the transit path, aircraft silhouette,
  anchor and compass were still plotted in the North-up sky frame (`project` used
  only `northUpScreenRot`). With a non-North-up camera (user's RASA: driftWest=
  'up' → West is screen-up) the plane was drawn on the WRONG side of the disc
  relative to the box and to SharpCap — left/E→W instead of right/bottom→top.
- **Root cause:** Two transforms for the same picture. The box answered "where
  does the sensor sit on the sky?" while everything else answered "where is N-up?"
  — so any camera rotation desynced the box from the content it framed.
- **Rule:** When ONE element of a composite view is transformed into a special
  frame (camera/sensor/rotated overlay), EVERY positional element in that view
  must go through the SAME frame map. Here: a single `frameOff` (Mᵀ when a sensor
  matrix exists, else the N-up rotation) feeds `project`, the box and the compass.
  Mᵀ = sky→sensor was already proven by the unit tests' `apply()` helper — reuse
  the verified transform, don't invent a parallel one.
- **Applies to:** web/sketch.js buildSketchSvg/fovBoxSvg; any overlay drawn on
  top of independently-projected content.

## [2026-06-21] — A disabled override must never silence an enabled fallback
- **Mistake:** A disabled multi-rig target (`rasa`) that shared the main rig's
  host:port shadowed the *enabled* base rig, so the whole site could not arm
  SharpCap despite the main switch being on — a real 0.24° Moon transit was lost.
  I initially framed it as "working as designed" and offered only a warning.
- **Root cause:** The address-collision suppression treated ANY same-address
  target as a replacement of the base, including disabled ones. But suppression
  exists solely to prevent double-firing the same listener — which a disabled
  target cannot do.
- **Rule:** An OFF override must never override an ON thing to OFF. Collision/
  shadow suppression should consider only *enabled* entries. When the user calls
  a behaviour "Schwachsinn," fix the behaviour — don't just add a warning around it.
- **Applies to:** buildSharpcapTargets in src/service.js; any "specific config
  shadows the general one" precedence rule.

## [2026-06-21] — A class `display:` rule defeats the UA `[hidden]` rule
- **Mistake:** The active-target pulldown showed visible-but-empty when SharpCap
  was disabled. `renderActiveTarget` set `bar.hidden = true` then returned before
  populating the `<select>`, assuming the element would disappear.
- **Root cause:** `.active-target-bar { display: flex }` (an author class rule)
  overrides the user-agent `[hidden] { display: none }`, so the `hidden`
  attribute had no visual effect — the bar was ALWAYS shown. Plus the visibility
  was wrongly gated on `sharpcap.enabled`, even though the selection filters the
  whole display/Pushover pipeline, not just capture.
- **Rule:** Whenever you set `display:` on a class, also add `&[hidden]{display:none}`
  (or `.cls[hidden]{display:none}`) so toggling the `hidden` attribute still
  works. And don't gate a control's visibility on a flag it isn't actually tied
  to — verify what the control drives before hiding it.
- **Applies to:** any element toggled via `el.hidden = …` that also has a class
  setting `display`; web/style.css + web/app.js.

## [2026-06-08] — Don't assume a PyPI package exists; don't over-sandbox HW services
- **Mistake (1):** Install script ran `pip install waveshare-epd` — that package
  is not reliably on PyPI, so the driver was missing → `No module named
  'waveshare_epd'` and the display service fail-looped 100+ times on the Pi.
- **Mistake (2):** The stp-display systemd unit used `ProtectHome=read-only`,
  `ProtectSystem=strict` and a `DeviceAllow=` whitelist. That whitelist made
  `DevicePolicy` closed and omitted `/dev/gpiomem`, and read-only home blocked
  lgpio's `.lgd-nfy` notify file in the working dir → every gpiozero pin factory
  failed → `Unable to load any default pin factory!`.
- **Root cause:** Wrote hardware-install + sandbox config from memory without a
  real Pi 5 to test on; copied the main service's strict sandbox onto a service
  that needs raw GPIO/SPI device access.
- **Rule:** (a) Verify a dependency is actually installable from the source you
  name — for vendor hardware libs default to the official Git repo + `pip install
  --no-deps`, not an assumed PyPI name. (b) Services that touch GPIO/SPI need
  `/dev/gpiomem*`, `/dev/gpiochip*`, `/dev/spidev*` and a writable CWD for lgpio;
  do NOT apply `ProtectHome`/`ProtectSystem=strict`/`DeviceAllow` whitelists to
  them — use group membership (spi/gpio) + `GPIOZERO_PIN_FACTORY=lgpio` on Pi 5.
- **Applies to:** install-pi5.sh, systemd units for hardware, any Pi 5 GPIO work.

## [2026-06-08] — Validate config patches transactionally, not field-by-field
- **Mistake:** The new `display` config validator in `applyConfigUpdate`
  mutated `config.display.<field>` in place as it validated each field, then
  ran a cross-field check (`longRefreshS ≥ quickRefreshS`) at the end. A POST
  with `quick=10, long=5` wrote both values BEFORE the cross-check threw — so
  `config.display` was left invalid (quick=10, long=5), and every SUBSEQUENT
  save then failed the cross-check too, wedging all config writes.
- **Root cause:** Copied the existing per-field in-place pattern (pushover /
  tracker) without realising it only works when fields are independent. Adding
  a cross-field invariant on top of in-place mutation leaves partial state
  behind on a failed validation.
- **Rule:** When a config block has ANY cross-field invariant, validate into a
  working copy (`const next = { ...config.block }`) and commit
  (`config.block = next`) only after EVERY check passes. Never mutate live
  config before all validation (incl. cross-field) succeeds.
- **Applies to:** `applyConfigUpdate` in src/service.js, any future config
  block with interdependent fields.

## [2026-05-18] — Don't add config knobs for deterministic values
- **Mistake:** Added an "External links / dump1090 URL" Settings section +
  `externalLinks` config plumbing. The dump1090 page is always
  `http://<same-host>:8080/` — there is exactly one correct value, so the
  override knob was pointless and confused the user.
- **Root cause:** Reflexively made a value "configurable" instead of asking
  whether it has a single derivable correct value.
- **Rule:** Before adding a Settings field / config key, ask "is there more
  than one legitimate value?" If it's deterministically derivable from
  context (host, port, window.location), hardcode + derive it. Configurable
  ≠ better; an unnecessary knob is a UX and maintenance liability.
- **Applies to:** Settings panel, DEFAULT_CONFIG, any "make it configurable"
  impulse in this project.

## [2026-06-01] — Make the common path the default, not a hidden flag
- **Mistake:** The Pi bootstrap one-liner skipped dump1090-fa (the ADS-B
  receiver driver) unless the user remembered to add `--with-dump1090`. A
  fresh install "almost worked" but had no data source — the single most
  common case (plug in an RTL-SDR dongle, want it to work) needed an opt-in
  flag nobody discovers from a copy-paste curl line.
- **Root cause:** Defaulted an essential-for-most step to OFF because it is
  "hardware-specific", optimising for the rare BYO-feed user over the
  majority.
- **Rule:** Install/enable what the majority needs BY DEFAULT; give the
  minority an opt-OUT flag (`--no-dump1090`), not the majority an opt-IN.
  Quick-start commands must be copy-paste-complete — no remembered flags.
- **Applies to:** bootstrap-pi5.sh, install scripts, any "default on or off"
  decision, README quick-start one-liners.

## [2026-06-12] — Settings grouping + asking decisions concisely
- **Mistake:** Put "Telescope & sensor" optics under the **General** settings
  tab; user moved it to **Scopes**. Also asked a multi-option "how deep should
  the feature go" question that the user found confusing ("Ich verstehe nicht
  was du meinst").
- **Root cause:** (1) Grouped by "it's basic config" instead of "it's part of
  the telescope rig". (2) Framed a decision in abstract option-labels instead of
  a concrete example of the end behaviour.
- **Rule:** Telescope / optics / FOV settings belong with the **rig (Scopes)**,
  not General. When asking the user to choose, lead with a concrete "if you pick
  X then Y happens" example, not abstract scope tiers — and keep it short.
- **Applies to:** Settings tab grouping, AskUserQuestion phrasing on this project.

## [2026-06-12] — Don't touch the safety-critical capture path when extending it
- **Mistake/Risk:** Generalising the SharpCap trigger to sky-targets could have
  meant editing the tested `armForCandidate` arming logic.
- **Rule:** Added a PARALLEL `armForSkyTarget` (separate dedup key namespace)
  instead of refactoring the aircraft path, so the 28 existing trigger tests
  still guarantee the Sun/Moon capture behaviour is byte-identical. When
  extending a safety / money / hardware path, add alongside; don't refactor under
  time pressure.
- **Applies to:** sharpcap.js, capture trigger, any tested critical path.
