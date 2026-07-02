"""
Bootstrap + live configuration for the e-paper display client.
v0.52.3

Design: the panel is administered ENTIRELY from the browser — no SSH/systemd
editing. The client reads its live `display`/`buzzer` config from a Node
service's ``/api/config`` on a short interval, so changes in the browser
Settings panel take effect within seconds. Everything (enabled, data source,
refresh cadences, list options) lives there.

Where does it read that config from? It PREFERS the Node service running on
THIS Pi (127.0.0.1) — the normal setup, where the display Pi also runs the
predictor and is configured from its own browser. STP_CONFIG_URL is only a
FALLBACK, used when no local service answers (a diskless panel Pi that renders
a remote host). This ordering makes the common case self-healing: even if
STP_CONFIG_URL was mistakenly pointed at another Pi, a panel Pi with its own
service still reads its own browser-set config (v0.52.3). Set STP_CONFIG_URL
only for the diskless-panel case.

This mirrors DEFAULT_CONFIG.display in src/service.js — keep the DEFAULTS below
in sync with that block.
"""

import json
import os
import urllib.request

# ── Bootstrap fallback ─────────────────────────────────────────────────────
# STP_CONFIG_URL is the FALLBACK config host, used only when no local Node
# service answers. Default is this same Pi, so a standard install needs no env
# at all. Set as an Environment= line in systemd/stp-display.service ONLY for a
# diskless panel Pi that has no local service and must read a remote host.
CONFIG_URL = os.environ.get("STP_CONFIG_URL", "http://127.0.0.1:8081").rstrip("/")


def _port_of(url, default_port):
    """Best-effort port from an http URL (`http://host:port/...`); default if
    absent/unparseable. Stdlib-only string work so it runs on any interpreter."""
    try:
        hostport = url.split("://", 1)[-1].split("/", 1)[0]
        if ":" in hostport:
            return int(hostport.rsplit(":", 1)[1])
    except Exception:
        pass
    return default_port


# The local Node service on THIS Pi, on the same port as the configured host.
# Tried first for config, so a panel Pi always trusts its own browser settings.
LOCAL_CONFIG_URL = "http://127.0.0.1:%d" % _port_of(CONFIG_URL, 8081)


def _config_candidates():
    """Config hosts to try, in priority order, de-duplicated: the local Node
    service first (fully browser-administrable, no SSH), then STP_CONFIG_URL as
    the diskless-panel fallback."""
    out = []
    for u in (LOCAL_CONFIG_URL, CONFIG_URL):
        u = (u or "").rstrip("/")
        if u and u not in out:
            out.append(u)
    return out

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
    # v0.47.3: refresh only the changed region (the ticking clock) on a quick
    # tick instead of the whole panel — gentler on the e-ink controller.
    "regionPartial": False,
}

# Buzzer alert defaults — mirrors DEFAULT_CONFIG.buzzer in src/service.js. All
# *Ms are milliseconds. Fetched from /api/config alongside the display block so
# the buzzer is configured entirely from the browser, like the panel.
BUZZER_DEFAULTS = {
    "enabled": False,
    "gpioPin": 13,
    "freqHz": 2000,
    "sepThresholdDeg": 1.0,
    "newEtaMaxS": 120,
    "newBeeps": 3, "newOnMs": 100, "newGapMs": 50, "newFadePct": 0, "newFreqStepHz": 200,
    "lostBeeps": 3, "lostOnMs": 100, "lostFreqHz": 500, "lostFadePct": 30, "lostFreqStepHz": -200,
    "phase1BeforeS": 60, "phase1EveryS": 10, "phase1Beeps": 2, "phase1OnMs": 50, "phase1FadePct": 0,
    "phase2BeforeS": 15, "phase2EveryS": 5, "phase2Beeps": 2, "phase2OnMs": 50, "phase2FadePct": 0,
    "phase3BeforeS": 8, "phase3EveryS": 2, "phase3Beeps": 2, "phase3OnMs": 50, "phase3FadePct": 0,
    "entryBeforeS": 3, "entryBeeps": 3, "entryOnMs": 100, "entryFadePct": 0, "entryFreqStepHz": 200,
}


def _http_json(url, timeout=HTTP_TIMEOUT_S):
    """GET a URL and parse JSON. Raises on any network/parse error."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _fetch_config(timeout):
    """Fetch ``/api/config`` from the first reachable candidate host (local Node
    first, STP_CONFIG_URL fallback). Returns (base_url, data) on success so the
    caller knows WHICH host answered — used for the data-source fallback and the
    'display disabled' diagnostic. Returns (None, None) if none answer."""
    for base in _config_candidates():
        try:
            data = _http_json("%s/api/config" % base, timeout=timeout)
            return base, data
        except Exception:
            continue  # try the next candidate
    return None, None


def fetch_display_config(timeout=HTTP_TIMEOUT_S):
    """
    Return the merged `display` block from the first reachable config host.

    Always returns a complete dict: starts from DEFAULTS and overlays whatever
    the server provides, plus ``_configFrom`` = the host that answered (or the
    fallback URL when none did). On any error returns DEFAULTS so a server
    hiccup never crashes the client — the caller decides what to render then.
    """
    cfg = dict(DEFAULTS)
    base, data = _fetch_config(timeout)
    if data is not None:
        block = (data or {}).get("display") or {}
        for key in DEFAULTS:
            if key in block and block[key] is not None:
                cfg[key] = block[key]
    # Record where the config came from (or would have) for diagnostics; stays
    # out of DEFAULTS so it is never treated as a server-provided field.
    cfg["_configFrom"] = base or CONFIG_URL
    return cfg


def fetch_buzzer_config(timeout=HTTP_TIMEOUT_S):
    """Return the merged `buzzer` block from the first reachable config host.

    Same contract as fetch_display_config: always a complete dict (DEFAULTS
    overlaid with whatever the server provides); returns defaults on any error.
    """
    cfg = dict(BUZZER_DEFAULTS)
    base, data = _fetch_config(timeout)
    if data is not None:
        block = (data or {}).get("buzzer") or {}
        for key in BUZZER_DEFAULTS:
            if key in block and block[key] is not None:
                cfg[key] = block[key]
        # Pass through the transient one-shot test id (not a saved default).
        cfg["testId"] = block.get("testId", 0)
    return cfg


def resolve_source_url(display_cfg):
    """
    Effective data host the panel renders from.

    An explicit ``sourceUrl`` (a LAN URL set in the browser) wins; blank falls
    back to the SAME host the config came from (local Node if one is running
    here, else STP_CONFIG_URL), so 'self/auto' stays consistent. Same pattern as
    pushover.url in the Node service: '' = self/auto, explicit = override.
    """
    src = (display_cfg.get("sourceUrl") or "").strip()
    if src:
        return src.rstrip("/")
    return (display_cfg.get("_configFrom") or CONFIG_URL).rstrip("/")


def fetch_state(source_url, timeout=HTTP_TIMEOUT_S):
    """GET the live ``/api/state`` snapshot from the resolved data host."""
    return _http_json("%s/api/state" % source_url, timeout=timeout)
