# Lessons Learned

(No lessons recorded yet. Append one entry per user correction, format:)

## [YYYY-MM-DD] — <short title>
- **Mistake:** <what was done wrong>
- **Root cause:** <why it happened>
- **Rule:** <what to always/never do instead>
- **Applies to:** <context>

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
