# TODO

## Aircraft type filter / collector mode

Idea from a Cloudy Nights reply: let users "collect" transits by aircraft make
and model (e.g. 747, 767, A320, C172, BE33) and optionally raise alert priority
when a wanted type is on a predicted transit path.

Sketch:
- Enrich each ADS-B candidate with ICAO type code, registration and operator,
  looked up from the aircraft's ICAO 24-bit hex address.
- Data source options (all free): the Mictronics DB that ships with tar1090,
  the OpenSky aircraft database, or the hexdb.io API. Prefer a local DB file
  so the predictor stays fully offline-capable.
- Config: a user-defined watchlist of ICAO type codes (and/or specific tail
  numbers) in `config/`.
- Behavior:
  - Tag every candidate in the web UI and log with type code + registration.
  - Separate "collector log" of transits per type, so users can see what they
    have already bagged.
  - Higher-priority Pushover alert when a watchlisted type is in an imminent
    transit window.
