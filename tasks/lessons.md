# Lessons Learned

(No lessons recorded yet. Append one entry per user correction, format:)

## [YYYY-MM-DD] — <short title>
- **Mistake:** <what was done wrong>
- **Root cause:** <why it happened>
- **Rule:** <what to always/never do instead>
- **Applies to:** <context>

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
