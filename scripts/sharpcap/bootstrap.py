# SharpCap startup bootstrap for sun-moon-transit-predictor.
#
# Point SharpCap's startup script at THIS file (SharpCap: File -> SharpCap
# Settings -> Startup -> "Run this script when SharpCap starts"). On every
# SharpCap launch it downloads the latest trigger_listener.py from GitHub and
# runs it in-process, so you always get the newest listener with no manual
# update step. If the download fails (offline, GitHub down) it falls back to
# the last cached copy.
#
# This runs inside SharpCap's IronPython host, so it uses .NET (System.Net)
# for the HTTPS download rather than urllib — IronPython's stdlib ssl support
# is unreliable, but the .NET WebClient always works.
#
# The matching trigger_listener.py needs no external Python or libraries: it
# uses only the standard library, which SharpCap's IronPython provides.

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


def _log(msg):
    line = "[bootstrap] {}".format(msg)
    print(line)
    try:
        with open(os.path.join(_bootstrap_dir(), "sharpcap_trigger.log"), "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _download_latest():
    """Return the latest listener source from GitHub, or None on failure."""
    try:
        import clr  # noqa: F401  (IronPython .NET bridge)
        from System.Net import WebClient, ServicePointManager
        # Force TLS 1.2 (+1.3 when available); GitHub rejects older protocols.
        # Numeric values avoid enum-name differences across .NET versions.
        try:
            ServicePointManager.SecurityProtocol = 3072 | 12288   # Tls12 | Tls13
        except Exception:
            ServicePointManager.SecurityProtocol = 3072           # Tls12
        wc = WebClient()
        wc.Headers.Add("User-Agent", "stp-sharpcap-bootstrap")
        source = wc.DownloadString(RAW_URL)
        if source and "trigger_listener" in source:
            try:
                with open(CACHE_PATH, "w") as f:
                    f.write(source)
            except Exception:
                _log("warning: could not write cache file:\n" + traceback.format_exc())
            _log("downloaded latest listener from {}".format(RAW_URL))
            return source
        _log("download returned unexpected content; ignoring")
        return None
    except Exception:
        _log("download failed:\n" + traceback.format_exc())
        return None


def _load_cached():
    try:
        if os.path.exists(CACHE_PATH):
            with open(CACHE_PATH, "r") as f:
                _log("using cached listener {}".format(CACHE_PATH))
                return f.read()
    except Exception:
        _log("reading cache failed:\n" + traceback.format_exc())
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
    try:
        exec(compile(source, "trigger_listener.py", "exec"), ns)
    except Exception:
        _log("listener crashed on start:\n" + traceback.format_exc())


_run()
