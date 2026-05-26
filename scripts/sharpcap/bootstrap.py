# SharpCap startup bootstrap for sun-moon-transit-predictor.
#
# Point SharpCap's startup script at THIS file (SharpCap: File -> SharpCap
# Settings -> Startup -> "Run this script when SharpCap starts"). On every
# SharpCap launch it downloads the latest trigger_listener.py from GitHub and
# runs it in-process, so you always get the newest listener with no manual
# update step. If the download fails (offline, GitHub down) it falls back to
# the last cached copy.
#
# SharpCap 4.x embeds CPython (Python.NET); older SharpCap used IronPython.
# The download tries the CPython stdlib (urllib + ssl, which works on 4.x)
# first and falls back to .NET System.Net.WebClient (the only path that
# worked on the old IronPython, whose ssl was unreliable).
#
# The matching trigger_listener.py needs no external Python or libraries: it
# uses only the standard library, present in both hosts.

import os
import sys
import traceback

# --- Where to fetch from. install.ps1 rewrites BRANCH if you pass -Branch. ---
OWNER = "joergs-git"
REPO = "sun-moon-transit-predictor"
BRANCH = "main"
LISTENER_PATH_IN_REPO = "scripts/sharpcap/trigger_listener.py"

RAW_URL = "https://raw.githubusercontent.com/{}/{}/{}/{}".format(
    OWNER, REPO, BRANCH, LISTENER_PATH_IN_REPO)


def _bootstrap_dir():
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except Exception:
        return os.environ.get("LOCALAPPDATA", os.getcwd())


CACHE_PATH = os.path.join(_bootstrap_dir(), "trigger_listener.cached.py")
CONFIG_PATH = os.path.join(_bootstrap_dir(), "stp-sharpcap.config.json")


def _log(msg):
    line = "[bootstrap] {}".format(msg)
    print(line)
    try:
        with open(os.path.join(_bootstrap_dir(), "sharpcap_trigger.log"), "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _download_latest():
    """Return the latest listener source from GitHub, or None on failure.

    SharpCap 4.x embeds CPython (Python.NET), where the stdlib urllib + ssl
    work fine — and .NET's `System.Net.WebClient` is NOT importable (that is
    an IronPython-ism). Older SharpCap used IronPython, whose ssl is flaky but
    which has WebClient. So try urllib first, fall back to WebClient."""
    source = _download_urllib()
    if source is None:
        source = _download_webclient()
    if not source:
        return None
    if "trigger_listener" not in source:
        _log("download returned unexpected content; ignoring")
        return None
    # Open the cache for writing in UTF-8 explicitly. On Windows Python's
    # default text-mode encoding is cp1252; the moment the listener source
    # carries a non-cp1252 char (e.g. >= or arrow glyph in a comment) the
    # default-encoding write raises UnicodeEncodeError and we lose the
    # cache. UTF-8 happily round-trips anything; on the next start we
    # also have to READ as UTF-8, see _load_cached() below.
    try:
        try:
            f = open(CACHE_PATH, "w", encoding="utf-8")        # Python 3
        except TypeError:
            import io
            f = io.open(CACHE_PATH, "w", encoding="utf-8")     # very old Python 2 / IronPython
        try:
            f.write(source)
        finally:
            f.close()
    except Exception:
        _log("warning: could not write cache file:\n" + traceback.format_exc())
    _log("downloaded latest listener from {}".format(RAW_URL))
    return source


def _download_urllib():
    """Stdlib download — the working path on SharpCap 4.x (CPython)."""
    try:
        try:
            from urllib.request import urlopen, Request   # Python 3 / CPython
        except ImportError:
            from urllib2 import urlopen, Request           # very old Python 2
        req = Request(RAW_URL, headers={"User-Agent": "stp-sharpcap-bootstrap"})
        data = urlopen(req, timeout=15).read()
        try:
            return data.decode("utf-8")
        except Exception:
            return data
    except Exception:
        _log("urllib download failed:\n" + traceback.format_exc())
        return None


def _download_webclient():
    """.NET WebClient fallback — only works on the old IronPython SharpCap."""
    try:
        import clr  # noqa: F401  (IronPython .NET bridge)
        from System.Net import WebClient, ServicePointManager
        try:
            ServicePointManager.SecurityProtocol = 3072 | 12288   # Tls12 | Tls13
        except Exception:
            ServicePointManager.SecurityProtocol = 3072           # Tls12
        wc = WebClient()
        wc.Headers.Add("User-Agent", "stp-sharpcap-bootstrap")
        return wc.DownloadString(RAW_URL)
    except Exception:
        _log("webclient download failed:\n" + traceback.format_exc())
        return None


def _load_cached():
    try:
        if os.path.exists(CACHE_PATH):
            # Read as UTF-8 to match _download_latest's write (any non-cp1252
            # char in a comment would crash a default-encoding read on
            # Windows). Fallback to default-encoding handles caches written
            # by pre-v0.30.15 bootstraps.
            try:
                f = open(CACHE_PATH, "r", encoding="utf-8")
            except TypeError:
                f = open(CACHE_PATH, "r")
            try:
                _log("using cached listener {}".format(CACHE_PATH))
                return f.read()
            finally:
                f.close()
    except UnicodeDecodeError:
        try:
            f = open(CACHE_PATH, "r")
            try:
                _log("using cached listener {} (default encoding fallback)".format(CACHE_PATH))
                return f.read()
            finally:
                f.close()
        except Exception:
            _log("reading cache failed (both encodings):\n" + traceback.format_exc())
    except Exception:
        _log("reading cache failed:\n" + traceback.format_exc())
    return None


def _load_local_config():
    """Machine-local settings (which folder to watch, network destination,
    port, token). Kept separate from the listener body so it survives the
    auto-update — the listener is re-pulled from GitHub, this file is not."""
    # Honour STP_SHARPCAP_CONFIG (absolute path to a JSON file) before the
    # install-dir default — lets a user run a SECOND SharpCap instance on the
    # SAME PC with its own config (different port → distinct listener) by
    # launching it from a shortcut / batch that sets this env var first.
    # Single-instance setups never see it and use the default install config.
    path = os.environ.get("STP_SHARPCAP_CONFIG") or CONFIG_PATH
    try:
        if os.path.exists(path):
            import json
            # Strip a UTF-8 BOM — PowerShell 5.1's `Set-Content -Encoding
            # UTF8` writes one and CPython's json.load chokes on it with
            # "Expecting value: line 1 column 1 (char 0)".
            with open(path, "r") as f:
                text = f.read()
            if text[:1] == u"\ufeff":
                text = text[1:]
            if not text.strip():
                _log("local config {} is empty; using defaults".format(path))
                return None
            cfg = json.loads(text)
            _log("loaded local config {}".format(path))
            return cfg
    except Exception:
        _log("reading local config failed:\n" + traceback.format_exc())
    return None


def _run():
    source = _download_latest() or _load_cached()
    if not source:
        _log("ERROR: no listener available (download failed and no cache). "
             "Re-run install.ps1 on this machine while online.")
        return
    # Execute in this script's globals so the SharpCap host object (injected by
    # SharpCap into the startup script's namespace) is visible to the listener.
    ns = globals()
    cfg = _load_local_config()
    if cfg is not None:
        # The listener applies this over its built-in defaults at startup.
        ns["STP_LOCAL_CONFIG"] = cfg
    # Make the listener log to the SAME file as the bootstrap, in the install
    # dir (always writable) — its own default is a CWD-relative name that
    # silently fails to write under a Program Files SharpCap install.
    ns["STP_LOG_PATH"] = os.path.join(_bootstrap_dir(), "sharpcap_trigger.log")
    try:
        exec(compile(source, "trigger_listener.py", "exec"), ns)
    except Exception:
        _log("listener crashed on start:\n" + traceback.format_exc())


_run()
