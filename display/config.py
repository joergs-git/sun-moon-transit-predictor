"""
Bootstrap + live configuration for the e-paper display client.
v0.31.10

Design: there is exactly ONE local/bootstrap value — STP_CONFIG_URL — which
tells the client where to read its live `display` config block from. Everything
else (enabled, data source, refresh cadences, list options) is configured from
the browser Settings panel of the Node service and fetched from
``<config host>/api/config`` on a short interval, so the panel reconfigures
itself within seconds with no SSH login or service restart.

This mirrors DEFAULT_CONFIG.display in src/service.js — keep the DEFAULTS below
in sync with that block.
"""

import json
import os
import urllib.request

# ── The single bootstrap value ────────────────────────────────────────────
# Where the live `display` config lives. Default: this same Pi. Set as an
# Environment= line in systemd/stp-display.service. Cannot itself come from the
# API (chicken-and-egg: we need it to reach the API in the first place).
CONFIG_URL = os.environ.get("STP_CONFIG_URL", "http://127.0.0.1:8081").rstrip("/")

# Waveshare driver module name. For the 4.2" B/W panel: newer revisions use
# ``epd4in2_V2``, older ones ``epd4in2``. Override via env if the panel shows
# garbage / nothing on first run.
EPD_DRIVER = os.environ.get("STP_EPD_DRIVER", "epd4in2_V2")

# How often (s) to re-read the live `display` config block from /api/config.
CONFIG_REFRESH_S = float(os.environ.get("STP_CONFIG_REFRESH_S", "5"))

# Network timeout (s) for both config and state fetches. Kept short so a dead
# host fails fast and the loop falls back to the offline screen promptly.
HTTP_TIMEOUT_S = float(os.environ.get("STP_HTTP_TIMEOUT_S", "1.5"))

# Fallback defaults — used when the server is unreachable or omits a field.
# Mirrors DEFAULT_CONFIG.display in src/service.js.
DEFAULTS = {
    "enabled": False,
    "sourceUrl": "",
    "quickRefreshS": 2,
    "longRefreshS": 60,
}

# Buzzer alert defaults — mirrors DEFAULT_CONFIG.buzzer in src/service.js. All
# *Ms are milliseconds. Fetched from /api/config alongside the display block so
# the buzzer is configured entirely from the browser, like the panel.
BUZZER_DEFAULTS = {
    "enabled": False,
    "gpioPin": 13,
    "freqHz": 2000,
    "sepThresholdDeg": 0.3,
    "newEtaMaxS": 120,
    "newBeeps": 3, "newOnMs": 100, "newGapMs": 50, "newFadePct": 0, "newEcho": 0,
    "lostBeeps": 1, "lostOnMs": 1500, "lostFreqHz": 1000, "lostFadePct": 30, "lostEcho": 0,
    "phase1BeforeS": 40, "phase1EveryS": 10, "phase1Beeps": 1, "phase1OnMs": 500, "phase1FadePct": 0, "phase1Echo": 0,
    "phase2BeforeS": 15, "phase2EveryS": 5, "phase2Beeps": 1, "phase2OnMs": 500, "phase2FadePct": 0, "phase2Echo": 0,
    "phase3BeforeS": 8, "phase3EveryS": 2, "phase3Beeps": 2, "phase3OnMs": 50, "phase3FadePct": 0, "phase3Echo": 0,
    "entryBeforeS": 2, "entryBeeps": 1, "entryOnMs": 5000, "entryFadePct": 40, "entryEcho": 0,
}


def _http_json(url, timeout=HTTP_TIMEOUT_S):
    """GET a URL and parse JSON. Raises on any network/parse error."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_display_config(timeout=HTTP_TIMEOUT_S):
    """
    Return the merged `display` block from ``<CONFIG_URL>/api/config``.

    Always returns a complete dict: starts from DEFAULTS and overlays whatever
    the server provides. On any error returns DEFAULTS unchanged so a server
    hiccup never crashes the client — the caller decides what to render then.
    """
    cfg = dict(DEFAULTS)
    try:
        data = _http_json("%s/api/config" % CONFIG_URL, timeout=timeout)
        block = (data or {}).get("display") or {}
        for key in DEFAULTS:
            if key in block and block[key] is not None:
                cfg[key] = block[key]
    except Exception:
        # Stay silent here; the main loop logs connectivity state once, not per
        # tick, to avoid flooding journalctl when the server is down.
        pass
    return cfg


def fetch_buzzer_config(timeout=HTTP_TIMEOUT_S):
    """Return the merged `buzzer` block from ``<CONFIG_URL>/api/config``.

    Same contract as fetch_display_config: always a complete dict (DEFAULTS
    overlaid with whatever the server provides); returns defaults on any error.
    """
    cfg = dict(BUZZER_DEFAULTS)
    try:
        data = _http_json("%s/api/config" % CONFIG_URL, timeout=timeout)
        block = (data or {}).get("buzzer") or {}
        for key in BUZZER_DEFAULTS:
            if key in block and block[key] is not None:
                cfg[key] = block[key]
        # Pass through the transient one-shot test id (not a saved default).
        cfg["testId"] = block.get("testId", 0)
    except Exception:
        pass
    return cfg


def resolve_source_url(display_cfg):
    """
    Effective data host the panel renders from.

    An explicit ``sourceUrl`` (a LAN URL set in the browser) wins; blank falls
    back to the bootstrap host (this Pi). Same pattern as pushover.url in the
    Node service: '' = self/auto, explicit = override.
    """
    src = (display_cfg.get("sourceUrl") or "").strip()
    return src.rstrip("/") if src else CONFIG_URL


def fetch_state(source_url, timeout=HTTP_TIMEOUT_S):
    """GET the live ``/api/state`` snapshot from the resolved data host."""
    return _http_json("%s/api/state" % source_url, timeout=timeout)
