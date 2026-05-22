# SharpCap-side trigger listener for sun-moon-transit-predictor.
#
# Run this script INSIDE SharpCap (File -> Scripting -> Open script, then Run,
# or pass /script:trigger_listener.py on the SharpCap.exe command line). It
# binds a TCP socket and arms a capture for each JSON trigger that arrives.
#
# Protocol (one JSON object per connection, terminated by '\n'):
#   client -> listener:
#     { "label": "abc123|Sun", "preRollS": 4.7, "durationS": 20, "token": "..." }
#   listener -> client:
#     { "ok": true,  "captureId": "<label>+<startEpochS>" }
#     { "ok": false, "error": "busy" | "unauth" | "bad-json" | "no-camera" | ... }
#
# Design notes:
# - SharpCap should already be running with the camera selected and live
#   preview active. That keeps the USB pipeline warm so RunCapture() starts
#   the first frame in ~10-50 ms, not 500 ms after a cold start.
# - One capture at a time. A trigger arriving while a capture is in progress
#   is rejected with "busy"; the predictor will dedupe and move on.
# - The listener thread is daemonised so SharpCap shutdown does not hang.
# - SharpCap's bundled Python is IronPython on Windows; this script uses only
#   stdlib (socket, threading, json, time) so it runs unchanged there.
#
# Configuration via environment-style globals at the top of the file
# (override before pressing Run if you need to). Keep PORT and SHARED_TOKEN in
# sync with the matching predictor service.json sharpcap.{port,token} fields.

import json
import os
import shutil
import socket
import threading
import time
import traceback

PORT = 9999
BIND = "0.0.0.0"               # set to "127.0.0.1" to restrict to localhost
SHARED_TOKEN = ""              # set to a string to require token == this


def _default_log_path():
    """Resolve a deterministic, writable log path.

    A bare relative name lands in SharpCap.exe's current working directory —
    for a Program Files install that is admin-only, so the write fails
    silently (see _log's except: pass) and the log appears to vanish. So:
      1. STP_LOG_PATH injected by bootstrap.py (the install dir, writable).
      2. %LOCALAPPDATA%\\stp-sharpcap\\sharpcap_trigger.log (manual installs).
      3. the bare relative name as a last resort.
    Set LOG_PATH = "" after this to disable file logging (print() still goes
    to the SharpCap scripting console regardless)."""
    injected = globals().get("STP_LOG_PATH")
    if isinstance(injected, str) and injected:
        return injected
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return os.path.join(local, "stp-sharpcap", "sharpcap_trigger.log")
    return "sharpcap_trigger.log"


LOG_PATH = _default_log_path()

# Maximum allowed values — guard against a buggy client asking for an hour-long
# capture or a half-hour pre-roll that would block subsequent triggers.
MAX_DURATION_S = 120
MAX_PRE_ROLL_S = 90

# --- Optional post-capture transfer to a network drive ---------------------
# After StopCapture, copy (or move) the .ser file(s) SharpCap just wrote into
# a folder on a network drive. Detection is by file modification time, not the
# SharpCap API, so it is independent of the SharpCap version: any matching
# file under SER_SOURCE_DIR touched during the capture window is transferred.
#
# IMPORTANT: SER_SOURCE_DIR must match SharpCap's capture output folder
# (SharpCap: File -> SharpCap Settings -> General -> Capture Folder) and the
# capture format must be set to SER.
TRANSFER_ENABLED = False
SER_SOURCE_DIR = r"C:\\SharpCap Captures"   # SharpCap's local capture folder
SER_DEST_DIR = r"\\\\NAS\\transits"          # UNC path or mapped drive, e.g. r"Z:\\transits"
TRANSFER_MOVE = False          # True = move (delete local original); False = copy
TRANSFER_EXTS = (".ser",)      # extensions to transfer; add ".txt" for the metadata sidecar
TRANSFER_SETTLE_TIMEOUT_S = 60 # max wait for SharpCap to finish writing each file
TRANSFER_SETTLE_INTERVAL_S = 0.5
TRANSFER_POST_STOP_DELAY_S = 1.5   # give SharpCap a moment to finalise/rename the .ser
TRANSFER_RESCAN_S = 2.0            # if nothing new yet, wait this long and scan once more


_state_lock = threading.Lock()
_capture_active = False

# Reject non-finite trigger numbers (NaN / +/-inf). float("nan") does NOT
# raise, so a malformed packet like {"durationS": NaN} would otherwise slip
# past the <= 0 and > MAX guards (every comparison with NaN is False) and
# reach time.sleep(NaN) in _do_capture — which raises AFTER RunCapture() but
# BEFORE StopCapture(), leaving the camera recording until manual stop.
# Implemented without math.isfinite so it also runs on the older IronPython
# bundled with some SharpCap builds: NaN is the only value not equal to
# itself, and the explicit inf membership test catches the rest.
_INF = float("inf")
_NEG_INF = float("-inf")


def _is_finite(x):
    return x == x and x != _INF and x != _NEG_INF


def _log(line):
    msg = "[{}] {}".format(time.strftime("%Y-%m-%dT%H:%M:%S"), line)
    print(msg)   # always goes to SharpCap's scripting console
    if LOG_PATH:
        try:
            d = os.path.dirname(LOG_PATH)
            if d and not os.path.isdir(d):
                os.makedirs(d)
            with open(LOG_PATH, "a") as f:
                f.write(msg + "\n")
        except Exception:
            pass


# Friendly JSON config key -> module constant. The constants above are only
# fallback defaults; the machine-specific values (which folders to watch, where
# to copy to) live in a local JSON file so they SURVIVE the auto-update — the
# listener body is re-pulled from GitHub on every start, but this config is not.
_CONFIG_KEY_MAP = {
    "port": "PORT",
    "bind": "BIND",
    "token": "SHARED_TOKEN",
    "transferEnabled": "TRANSFER_ENABLED",
    "sourceDir": "SER_SOURCE_DIR",
    "destDir": "SER_DEST_DIR",
    "move": "TRANSFER_MOVE",
    "exts": "TRANSFER_EXTS",
    "settleTimeoutS": "TRANSFER_SETTLE_TIMEOUT_S",
    "postStopDelayS": "TRANSFER_POST_STOP_DELAY_S",
    "rescanS": "TRANSFER_RESCAN_S",
    "maxDurationS": "MAX_DURATION_S",
    "maxPreRollS": "MAX_PRE_ROLL_S",
}


def _candidate_config_paths():
    paths = []
    env = os.environ.get("STP_SHARPCAP_CONFIG")
    if env:
        paths.append(env)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        paths.append(os.path.join(local, "stp-sharpcap", "stp-sharpcap.config.json"))
    # cwd is usually SharpCap.exe's folder when run as a startup script.
    paths.append(os.path.join(os.getcwd(), "stp-sharpcap.config.json"))
    return paths


def _apply_local_config():
    """Override the fallback constants from a machine-local JSON config.

    Source of the config, in priority order:
      1. STP_LOCAL_CONFIG global injected by bootstrap.py (it knows the
         install dir, so this is the reliable path under auto-update).
      2. A JSON file at one of _candidate_config_paths() (manual install)."""
    cfg = None
    g = globals()
    inj = g.get("STP_LOCAL_CONFIG")
    if isinstance(inj, dict):
        cfg = inj
        _log("config: using settings injected by bootstrap")
    else:
        for path in _candidate_config_paths():
            try:
                if os.path.isfile(path):
                    with open(path) as f:
                        cfg = json.load(f)
                    _log("config: loaded {}".format(path))
                    break
            except Exception:
                _log("config: failed reading {}:\n{}".format(path, traceback.format_exc()))
    if not isinstance(cfg, dict):
        _log("config: none found, using built-in defaults")
        return
    for json_key, const_name in _CONFIG_KEY_MAP.items():
        if json_key in cfg and cfg[json_key] is not None:
            val = cfg[json_key]
            if const_name == "TRANSFER_EXTS" and isinstance(val, list):
                val = tuple(val)
            g[const_name] = val
    _log("config: transfer={} source={!r} dest={!r} move={}".format(
        g["TRANSFER_ENABLED"], g["SER_SOURCE_DIR"], g["SER_DEST_DIR"], g["TRANSFER_MOVE"]))


# Signatures (abspath, size, int mtime) we have already transferred — guards
# against ever sending the same file twice, e.g. across two close captures in
# copy mode where the original stays in the source folder.
_transferred_lock = threading.Lock()
_transferred = set()


def _scan_capture_dir():
    """Map {abspath: mtime} of all files under SER_SOURCE_DIR matching
    TRANSFER_EXTS. Used both for the pre-capture snapshot and the post-capture
    diff so detection never relies on a wall-clock window."""
    snap = {}
    if not SER_SOURCE_DIR or not os.path.isdir(SER_SOURCE_DIR):
        return snap
    exts = tuple(e.lower() for e in TRANSFER_EXTS)
    for root, _dirs, files in os.walk(SER_SOURCE_DIR):
        for name in files:
            if not name.lower().endswith(exts):
                continue
            path = os.path.join(root, name)
            try:
                snap[path] = os.path.getmtime(path)
            except OSError:
                pass
    return snap


def _diff_new_files(pre_snapshot):
    """Files that appeared, or whose mtime advanced, since the pre-capture
    snapshot. Anything already present and unchanged (i.e. an older capture's
    leftovers) is by construction excluded."""
    out = []
    for path, mtime in _scan_capture_dir().items():
        prev = pre_snapshot.get(path)
        if prev is None or mtime > prev + 1e-6:
            out.append(path)
    return out


def _wait_until_stable(path):
    """Block until a file's size stops growing (SharpCap has released it) or
    the settle timeout elapses. Returns False only if the file vanished."""
    last_size = -1
    stable = 0
    deadline = time.time() + TRANSFER_SETTLE_TIMEOUT_S
    while time.time() < deadline:
        try:
            size = os.path.getsize(path)
        except OSError:
            return False
        if size == last_size and size > 0:
            stable += 1
            if stable >= 3:
                return True
        else:
            stable = 0
            last_size = size
        time.sleep(TRANSFER_SETTLE_INTERVAL_S)
    return True   # proceed anyway after the timeout


def _unique_dest(name):
    """Collision-safe destination path inside SER_DEST_DIR."""
    dest = os.path.join(SER_DEST_DIR, name)
    if not os.path.exists(dest):
        return dest
    base, ext = os.path.splitext(name)
    i = 1
    while True:
        cand = os.path.join(SER_DEST_DIR, "{}_{}{}".format(base, i, ext))
        if not os.path.exists(cand):
            return cand
        i += 1


def _signature(path):
    """Stable identity of a settled file: (abspath, size, int mtime)."""
    st = os.stat(path)
    return (os.path.abspath(path), st.st_size, int(st.st_mtime))


def _transfer_new_files(pre_snapshot, label):
    """Copy/move the file(s) SharpCap created during this capture to the
    network destination. `pre_snapshot` is {path: mtime} captured BEFORE
    RunCapture(); only files that are new or grew relative to it are sent, so
    leftovers from older captures are never re-transferred. Best-effort: every
    failure is logged, none raises. Called only AFTER StopCapture() returns."""
    if not TRANSFER_ENABLED:
        return
    if not SER_DEST_DIR:
        _log("transfer: SER_DEST_DIR not set, skipping")
        return

    # Give SharpCap a moment to finalise (it may rename .ser.tmp -> .ser only
    # after StopCapture returns), then diff against the pre-capture snapshot.
    if TRANSFER_POST_STOP_DELAY_S > 0:
        time.sleep(TRANSFER_POST_STOP_DELAY_S)
    files = _diff_new_files(pre_snapshot)
    if not files and TRANSFER_RESCAN_S > 0:
        time.sleep(TRANSFER_RESCAN_S)
        files = _diff_new_files(pre_snapshot)
    if not files:
        _log("transfer {!r}: no new {} files under {}".format(label, TRANSFER_EXTS, SER_SOURCE_DIR))
        return

    try:
        if not os.path.isdir(SER_DEST_DIR):
            os.makedirs(SER_DEST_DIR)
    except Exception:
        _log("transfer: cannot create dest dir {!r}:\n{}".format(SER_DEST_DIR, traceback.format_exc()))
        return

    for src in files:
        try:
            # Block until SharpCap has stopped growing the file (handle freed)
            # before we touch it — never transfer a half-written capture.
            if not _wait_until_stable(src):
                _log("transfer {!r}: {} vanished before transfer".format(label, src))
                continue
            sig = _signature(src)
            with _transferred_lock:
                if sig in _transferred:
                    continue
            dest = _unique_dest(os.path.basename(src))
            if TRANSFER_MOVE:
                shutil.move(src, dest)
                _log("transfer {!r}: moved {} -> {}".format(label, src, dest))
            else:
                shutil.copy2(src, dest)
                _log("transfer {!r}: copied {} -> {}".format(label, src, dest))
            with _transferred_lock:
                _transferred.add(sig)
        except Exception:
            _log("transfer {!r}: failed for {}:\n{}".format(label, src, traceback.format_exc()))


def _do_capture(label, pre_roll_s, duration_s):
    """Wait pre_roll_s, then start a capture for duration_s. Runs in its own
    thread so the listener can keep accepting reject-only follow-ups."""
    global _capture_active
    try:
        if pre_roll_s > 0:
            _log("capture {!r}: waiting pre-roll {:.2f}s".format(label, pre_roll_s))
            time.sleep(pre_roll_s)
        try:
            cam = SharpCap.SelectedCamera   # noqa: F821  (provided by SharpCap host)
        except Exception:
            _log("capture {!r}: no SelectedCamera, aborting".format(label))
            return
        if cam is None:
            _log("capture {!r}: SelectedCamera is None, aborting".format(label))
            return
        # Snapshot the capture folder BEFORE recording so the post-capture diff
        # transfers only the file(s) this capture produces — never leftovers.
        pre_snapshot = _scan_capture_dir() if TRANSFER_ENABLED else {}
        _log("capture {!r}: RunCapture (duration {:.2f}s)".format(label, duration_s))
        try:
            cam.RunCapture()
        except Exception:
            _log("capture {!r}: RunCapture failed:\n{}".format(label, traceback.format_exc()))
            return
        time.sleep(duration_s)
        try:
            cam.StopCapture()
            _log("capture {!r}: StopCapture done".format(label))
        except Exception:
            _log("capture {!r}: StopCapture failed:\n{}".format(label, traceback.format_exc()))
            return
        # Transfer runs only here, i.e. strictly after StopCapture has returned.
        _transfer_new_files(pre_snapshot, label)
    finally:
        with _state_lock:
            _capture_active = False


def _handle_conn(conn, addr):
    global _capture_active
    try:
        conn.settimeout(2.0)
        buf = b""
        while b"\n" not in buf:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
            if len(buf) > 16384:
                break
        line = buf.split(b"\n", 1)[0]
        try:
            req = json.loads(line.decode("utf-8"))
        except Exception:
            conn.sendall(b'{"ok": false, "error": "bad-json"}\n')
            return

        if SHARED_TOKEN and req.get("token") != SHARED_TOKEN:
            _log("reject from {}: bad token".format(addr))
            conn.sendall(b'{"ok": false, "error": "unauth"}\n')
            return

        try:
            pre_roll_s = float(req.get("preRollS", 0) or 0)
        except Exception:
            pre_roll_s = 0.0
        try:
            duration_s = float(req.get("durationS", 0) or 0)
        except Exception:
            duration_s = 0.0
        label = str(req.get("label", "unlabeled"))

        # Reject NaN/inf before any range check — see _is_finite above.
        if not _is_finite(duration_s) or not _is_finite(pre_roll_s):
            conn.sendall(b'{"ok": false, "error": "bad-number"}\n')
            return
        if duration_s <= 0:
            conn.sendall(b'{"ok": false, "error": "bad-duration"}\n')
            return
        if duration_s > MAX_DURATION_S or pre_roll_s > MAX_PRE_ROLL_S:
            conn.sendall(b'{"ok": false, "error": "over-limit"}\n')
            return

        with _state_lock:
            if _capture_active:
                _log("reject from {} ({!r}): busy".format(addr, label))
                conn.sendall(b'{"ok": false, "error": "busy"}\n')
                return
            _capture_active = True

        capture_id = "{}+{}".format(label, int(time.time()))
        _log("accept from {}: {!r} preRoll={:.2f}s duration={:.2f}s".format(
            addr, label, pre_roll_s, duration_s))
        try:
            conn.sendall(("{\"ok\": true, \"captureId\": \"" + capture_id + "\"}\n").encode("utf-8"))
        except Exception:
            with _state_lock:
                _capture_active = False
            return

        t = threading.Thread(target=_do_capture, args=(label, pre_roll_s, duration_s))
        t.daemon = True
        t.start()
    except Exception:
        _log("handler error:\n" + traceback.format_exc())
        try: conn.sendall(b'{"ok": false, "error": "handler-exception"}\n')
        except Exception: pass
    finally:
        try: conn.close()
        except Exception: pass


def _serve():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((BIND, PORT))
    srv.listen(4)
    _log("sun-moon-transit-predictor SharpCap listener bound on {}:{}".format(BIND, PORT))
    while True:
        try:
            conn, addr = srv.accept()
        except Exception:
            _log("accept failed:\n" + traceback.format_exc())
            time.sleep(0.5)
            continue
        t = threading.Thread(target=_handle_conn, args=(conn, addr))
        t.daemon = True
        t.start()


_apply_local_config()

_listener_thread = threading.Thread(target=_serve)
_listener_thread.daemon = True
_listener_thread.start()
_log("listener thread started; SharpCap is free to be used normally")
