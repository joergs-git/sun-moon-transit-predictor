# Lessons Learned

(No lessons recorded yet. Append one entry per user correction, format:)

## [YYYY-MM-DD] — <short title>
- **Mistake:** <what was done wrong>
- **Root cause:** <why it happened>
- **Rule:** <what to always/never do instead>
- **Applies to:** <context>

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
