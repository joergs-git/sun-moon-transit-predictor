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
# - SharpCap 4.x embeds CPython (Python.NET); older builds used IronPython.
#   This script uses only stdlib (socket, threading, json, time) so it runs
#   unchanged on both. The capture calls are marshalled onto the WPF UI
#   thread (see _run_on_ui) because SharpCap's writer init is UI-affine.
#
# Configuration via environment-style globals at the top of the file
# (override before pressing Run if you need to). Keep PORT and SHARED_TOKEN in
# sync with the matching predictor service.json sharpcap.{port,token} fields.

import json
import os
import shutil
import socket
import subprocess
import threading
import time
import traceback

PORT = 9999
BIND = "0.0.0.0"               # set to "127.0.0.1" to restrict to localhost
SHARED_TOKEN = ""              # set to a string to require token == this


def _default_log_path():
    """Resolve a deterministic, writable log path.

    A bare relative name lands in SharpCap.exe's current working directory --
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

# Maximum allowed values -- guard against a buggy client asking for an hour-long
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
# Re-arm support: a fresh trigger for the SAME target that arrives while the
# previous one is still in its pre-roll wait (not yet recording) replaces it
# with the updated time. Generation guards the handoff -- the superseded
# pre-roll thread sees a newer generation and aborts without touching state.
_capture_gen = 0
_active_label = None
_recording = False
_cancel_event = None   # threading.Event for the in-flight capture's pre-roll

# Reject non-finite trigger numbers (NaN / +/-inf). float("nan") does NOT
# raise, so a malformed packet like {"durationS": NaN} would otherwise slip
# past the <= 0 and > MAX guards (every comparison with NaN is False) and
# reach time.sleep(NaN) in _do_capture -- which raises AFTER RunCapture() but
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
# to copy to) live in a local JSON file so they SURVIVE the auto-update -- the
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
                    with open(path, "r") as f:
                        text = f.read()
                    # Strip a UTF-8 BOM (Windows PowerShell 5.1 Set-Content
                    # -Encoding UTF8 writes one; json.loads then fails with
                    # "Expecting value: line 1 column 1 (char 0)").
                    if text[:1] == u"\ufeff":
                        text = text[1:]
                    if not text.strip():
                        _log("config: {} is empty; skipping".format(path))
                        continue
                    cfg = json.loads(text)
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


# Signatures (abspath, size, int mtime) we have already transferred -- guards
# against ever sending the same file twice, e.g. across two close captures in
# copy mode where the original stays in the source folder.
_transferred_lock = threading.Lock()
_transferred = set()

# v0.30.33 -- captureId -> list of transferred destination paths, populated
# when _transfer_new_files completes. Used by the 'outcome' message handler
# to find the files written for a given capture and rename them with the
# _confirmed / _probempty verdict tag. Capped + time-pruned so the listener
# can run for days without growing the map unbounded. Each entry has a
# 'tMs' timestamp; entries older than 24 h are pruned on each insert.
_capture_files_lock = threading.Lock()
_capture_files = {}     # captureId -> { tMs: epoch_ms, paths: [...] }
_CAPTURE_FILES_TTL_MS = 24 * 3600 * 1000     # 24 h, plain int literal (3600_000 syntax is Python 3.6+; some SharpCap builds embed 3.4)
_CAPTURE_FILES_CAP = 1000

# v0.30.34 -- outcome arrival signalling. _transfer_new_files now waits up
# to OUTCOME_WAIT_S after the source file finished writing for an outcome
# message; when one arrives during the wait, _apply_outcome renames the
# LOCAL source on SSD (instant), then the transfer to NAS runs against the
# final tagged name. Avoids the race where a 20 GB file is still being
# uploaded when the outcome packet would have wanted to rename it.
_outcome_events_lock = threading.Lock()
_outcome_events = {}     # capture_id -> threading.Event
OUTCOME_WAIT_S = 120


def _remember_capture_files(capture_id, paths):
    if not capture_id or not paths:
        return
    now_ms = int(time.time() * 1000)
    with _capture_files_lock:
        # Prune ANY entries older than TTL (cheap; map stays small).
        to_drop = [k for k, v in _capture_files.items() if (now_ms - v["tMs"]) > _CAPTURE_FILES_TTL_MS]
        for k in to_drop:
            del _capture_files[k]
        # Hard cap (oldest first).
        if len(_capture_files) >= _CAPTURE_FILES_CAP:
            sorted_keys = sorted(_capture_files.keys(), key=lambda k: _capture_files[k]["tMs"])
            for k in sorted_keys[:max(1, len(_capture_files) - _CAPTURE_FILES_CAP + 1)]:
                del _capture_files[k]
        existing = _capture_files.get(capture_id, {"tMs": now_ms, "paths": []})
        existing["tMs"] = now_ms
        for p in paths:
            if p and p not in existing["paths"]:
                existing["paths"].append(p)
        _capture_files[capture_id] = existing


def _apply_outcome(capture_id, verdict, final_sep_deg):
    """Rename every still-present file recorded under capture_id by
    appending '_<verdict>' (and optionally '_finalsepNNN') before the
    extension. Updates _capture_files in place so a subsequent transfer
    step picks up the new (verdict-tagged) name. v0.30.34: this is what
    makes the 'rename on SSD BEFORE transfer' flow work -- the
    _transfer_new_files thread waits on _outcome_events[capture_id]; the
    moment we set that event the transfer reads the updated path list
    out of _capture_files and uploads the already-verdict-tagged file
    to the NAS, so the rename doesn't have to race the upload.
    Returns (renamed_count, missing_count) for the reply."""
    if not capture_id or not verdict:
        return (0, 0)
    verdict = str(verdict).lower()
    if verdict not in ("confirmed", "probempty"):
        return (0, 0)
    extra_tag = ""
    if final_sep_deg is not None:
        try:
            extra_tag = "_finalsep{:03d}".format(int(round(float(final_sep_deg) * 100)))
        except (TypeError, ValueError):
            extra_tag = ""
    with _capture_files_lock:
        entry = _capture_files.get(capture_id)
        paths = list(entry["paths"]) if entry else []
    if not paths:
        return (0, 0)
    renamed = 0
    missing = 0
    new_paths = []
    for old_path in paths:
        try:
            if not os.path.isfile(old_path):
                new_paths.append(old_path)
                missing += 1
                continue
            d = os.path.dirname(old_path)
            base, ext = os.path.splitext(os.path.basename(old_path))
            # Don't double-tag if a previous outcome already ran on this
            # file (e.g. retry / network hiccup).
            if "_confirmed" in base or "_probempty" in base:
                new_paths.append(old_path)
                missing += 1
                continue
            new_path = os.path.join(d, "{}_{}{}{}".format(base, verdict, extra_tag, ext))
            if os.path.exists(new_path):
                new_paths.append(old_path)
                missing += 1
                continue
            os.rename(old_path, new_path)
            new_paths.append(new_path)
            renamed += 1
        except OSError:
            _log("outcome rename failed for {!r}:\n{}".format(old_path, traceback.format_exc()))
            new_paths.append(old_path)
    # Update _capture_files so any subsequent step (transfer to NAS,
    # late-arriving second outcome) reads the new path names.
    with _capture_files_lock:
        if capture_id in _capture_files:
            _capture_files[capture_id]["paths"] = new_paths
    return (renamed, missing)


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


def _robocopy_transfer(src, dest, move):
    """Faster Windows-native transfer than shutil over SMB. Returns True on
    success, False (with the shutil fallback running) on any failure mode.

    Uses subprocess.Popen + communicate() instead of the newer
    subprocess.run() so this also works on the older Python 3 that some
    SharpCap builds embed (subprocess.run is Python 3.5+, capture_output
    is 3.7+, text= is 3.7+). Catches every exception class as a safety
    net for stripped-down embedded Python builds (e.g. SharpCap.NET) --
    a broken robocopy path must NEVER swallow the .ser file.

    robocopy can't rename during transfer, so we copy/move to <src basename>
    in the dest dir and then os.rename(...) to the desired (port-tagged)
    dest name locally on the NAS -- a cheap metadata op.

    Flags:
      /MT:4   -- 4 worker threads (Windows Explorer is single-threaded; this
                alone usually beats shutil 2-3x over SMB).
      /Z      -- restartable mode (resumes on a brief network glitch).
      /R:2    -- retry twice on transient errors.
      /W:5    -- wait 5 s between retries.
      /NJH /NJS /NP /NDL -- quieter output (no header/summary, no progress,
                            no directory list).
      /MOV    -- only when move=True; deletes source after success.
    Exit codes: 0..3 = success (0 = nothing copied, >= 1 = files copied,
    >= 4 = error).
    """
    try:
        src_dir = os.path.dirname(src)
        src_name = os.path.basename(src)
        dest_dir = os.path.dirname(dest)
        dest_name = os.path.basename(dest)
        if not src_dir or not dest_dir:
            return False
        cmd = ["robocopy", src_dir, dest_dir, src_name,
               "/MT:4", "/Z", "/R:2", "/W:5",
               "/NJH", "/NJS", "/NP", "/NDL"]
        if move:
            cmd.append("/MOV")
        # Popen + communicate is the lowest-common-denominator API that
        # works on every Python 3.x SharpCap might embed.
        # v0.30.18: also suppress the brief robocopy console window. The
        # CREATE_NO_WINDOW creationflag is Python 3.7+; older 3.x falls
        # back to 0 and a console flashes for ~1 s. STARTUPINFO with
        # STARTF_USESHOWWINDOW + SW_HIDE is the pre-3.7 way and has been
        # in subprocess since Python 2.x -- combining both keeps every
        # version quiet.
        startupinfo = None
        if os.name == "nt":
            try:
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = 0   # SW_HIDE
                startupinfo = si
            except AttributeError:
                startupinfo = None
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            startupinfo=startupinfo,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        _stdout_b, stderr_b = proc.communicate()
        rc = proc.returncode
        if rc is None or rc >= 4:
            try:
                stderr_s = stderr_b.decode("utf-8", "replace").strip()[:200] if stderr_b else ""
            except Exception:
                stderr_s = ""
            _log("robocopy returncode {} for {!r}; stderr: {}".format(
                rc, src_name, stderr_s))
            return False
        # Rename to the port-tagged destination, locally on the NAS.
        landed = os.path.join(dest_dir, src_name)
        if src_name != dest_name and os.path.isfile(landed):
            try:
                os.rename(landed, dest)
            except OSError:
                # Best effort -- if the rename fails (e.g. dest_name exists),
                # leave the file at <landed> rather than abort the transfer.
                pass
        return True
    except Exception:
        # ANY failure (subprocess missing attributes, robocopy not on PATH,
        # OS errors, encoding issues, etc.) -> fall back to shutil. We log
        # once at info-ish level so the user can tell why robocopy is
        # disabled, but the recording is never lost over a transfer-tool
        # quirk.
        _log("robocopy attempt failed for {!r}, falling back to shutil:\n{}".format(
            os.path.basename(src), traceback.format_exc()))
        return False


def _filename_tags(meta):
    """Build the trailing _-separated tag list spliced into transferred .ser
    file names (v0.30.33). Order: body, port, icao, sep -- so grep/sort
    naturally groups recordings by body first.
      body  -> 'Sun' or 'Moon' from meta.body
      port  -> always present (this listener's PORT)
      icao  -> lowercase hex from meta.icao
      sep   -> deg*100 zero-padded to 3 digits ('sep021' = 0.21 deg)
    Sep encoded as deg*100 to dodge the decimal point and keep file
    names shell-safe. Body and icao only emitted when meta carries them
    (a manual-test trigger has no meta -> just port).
    """
    tags = []
    if isinstance(meta, dict):
        body = meta.get("body")
        if body:
            tags.append(str(body))
    tags.append("p{}".format(PORT))
    if isinstance(meta, dict):
        icao = meta.get("icao")
        if icao:
            tags.append(str(icao).lower())
        sep = meta.get("sepDeg")
        if sep is not None:
            try:
                tags.append("sep{:03d}".format(int(round(float(sep) * 100))))
            except (TypeError, ValueError):
                pass
    return "_".join(tags)


def _transfer_new_files(pre_snapshot, label, meta=None, capture_id=None):
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

    # -- Phase 1: wait-until-stable + LOCAL tag rename --------------------
    # On big captures (20 GB+) the SSD->NAS transfer takes many minutes,
    # which is far longer than the predictor's 60 s outcome dispatch.
    # Renaming the source file on the LOCAL SSD with the meta tags FIRST
    # (and then with the verdict tag once the outcome arrives) means
    # the long-running NAS copy ALWAYS sees the final filename and the
    # user gets a correctly-tagged file on the share without any race.
    # v0.30.34.
    local_paths = []
    sigs = []
    for src in files:
        try:
            if not _wait_until_stable(src):
                _log("transfer {!r}: {} vanished before tagging".format(label, src))
                continue
            sig = _signature(src)
            with _transferred_lock:
                if sig in _transferred:
                    continue
            src_dir = os.path.dirname(src)
            base, ext = os.path.splitext(os.path.basename(src))
            base = base.rstrip("_")
            tagged_name = "{}_{}{}".format(base, _filename_tags(meta), ext)
            tagged_src = os.path.join(src_dir, tagged_name)
            if tagged_src != src:
                try:
                    if os.path.exists(tagged_src):
                        # An unlikely collision -- fall back to original.
                        tagged_src = src
                    else:
                        os.rename(src, tagged_src)
                except OSError:
                    _log("transfer {!r}: local rename failed for {}:\n{}".format(
                        label, src, traceback.format_exc()))
                    tagged_src = src
            local_paths.append(tagged_src)
            sigs.append(sig)
            _log("transfer {!r}: source tagged locally -> {}".format(label, tagged_src))
        except Exception:
            _log("transfer {!r}: tag-phase failed for {}:\n{}".format(label, src, traceback.format_exc()))

    if not local_paths:
        return
    if capture_id:
        _remember_capture_files(capture_id, local_paths)

    # -- Phase 2: wait for the predictor's outcome message ---------------
    # The outcome packet arrives ~60 s after the lifecycle entry settles
    # (typically ~T+115 s for past-eta entries). _apply_outcome will
    # rename the SOURCE files in place (instant on SSD); we just block
    # here with a hard cap so a never-arriving outcome doesn't stall the
    # transfer forever.
    if capture_id:
        with _outcome_events_lock:
            ev = threading.Event()
            _outcome_events[capture_id] = ev
        try:
            if ev.wait(OUTCOME_WAIT_S):
                _log("transfer {!r}: outcome received, proceeding to NAS".format(label))
            else:
                _log("transfer {!r}: outcome timed out after {} s, transferring un-verdicted".format(label, OUTCOME_WAIT_S))
        finally:
            with _outcome_events_lock:
                _outcome_events.pop(capture_id, None)

    # -- Phase 3: re-read current paths (outcome may have renamed) -------
    if capture_id:
        with _capture_files_lock:
            entry = _capture_files.get(capture_id)
            current_paths = list(entry["paths"]) if entry else local_paths
    else:
        current_paths = local_paths

    # -- Phase 4: transfer to NAS using the final filename ---------------
    new_nas_paths = []
    verb = "moved" if TRANSFER_MOVE else "copied"
    for idx, src in enumerate(current_paths):
        try:
            if not os.path.isfile(src):
                _log("transfer {!r}: {} missing before NAS copy".format(label, src))
                continue
            dest = _unique_dest(os.path.basename(src))
            t0 = time.time()
            try_robocopy_first = (os.name == "nt"
                                  and SER_DEST_DIR
                                  and os.path.isabs(dest))
            done = False
            if try_robocopy_first:
                # robocopy: multi-threaded SMB-aware; same basename so no
                # post-copy rename needed any more (the meta + verdict
                # tags are already in src). Falls back to shutil on any
                # error.
                done = _robocopy_transfer(src, dest, TRANSFER_MOVE)
            if not done:
                if TRANSFER_MOVE:
                    shutil.move(src, dest)
                else:
                    shutil.copy2(src, dest)
            dt = time.time() - t0
            try:
                size_mb = os.path.getsize(dest) / (1024.0 * 1024.0)
                rate = (size_mb / dt) if dt > 0 else 0.0
                _log("transfer {!r}: {} {} -> {} ({:.1f} MB, {:.1f} s, {:.1f} MB/s)".format(
                    label, verb, src, dest, size_mb, dt, rate))
            except OSError:
                _log("transfer {!r}: {} {} -> {} ({:.1f} s)".format(
                    label, verb, src, dest, dt))
            if idx < len(sigs):
                with _transferred_lock:
                    _transferred.add(sigs[idx])
            new_nas_paths.append(dest)
        except Exception:
            _log("transfer {!r}: NAS-phase failed for {}:\n{}".format(label, src, traceback.format_exc()))

    # Update _capture_files with NAS paths so a LATE outcome (arriving
    # after Phase 2 timed out but the file made it to the NAS) can still
    # rename the dest-side file.
    if capture_id and new_nas_paths:
        with _capture_files_lock:
            if capture_id in _capture_files:
                _capture_files[capture_id]["paths"] = new_nas_paths


# SharpCap is a WPF .NET app and its capture-writer init is UI-thread-affine.
# _do_capture runs on a background thread, so calling cam.RunCapture() /
# StopCapture() directly there fails with "No writer object when trying to
# initialize it" even though a manual (UI-thread) capture works fine. We
# marshal just those two calls onto the WPF dispatcher; the timing (pre-roll
# + duration sleeps) stays on the background thread so the UI never freezes.
# Resolved once and cached. If no WPF dispatcher is available (older/non-WPF
# host) we fall back to a direct call, so behaviour is never worse than before.
_ui_dispatcher = None
_ui_action = None
_ui_resolved = False


def _resolve_ui():
    global _ui_dispatcher, _ui_action, _ui_resolved
    if _ui_resolved:
        return
    _ui_resolved = True
    try:
        import clr  # noqa: F401  (IronPython .NET bridge)
        try:
            clr.AddReference("PresentationFramework")
            clr.AddReference("WindowsBase")
        except Exception:
            pass   # often already loaded by the SharpCap host
        from System.Windows import Application
        from System import Action
        app = Application.Current
        if app is not None and app.Dispatcher is not None:
            _ui_dispatcher = app.Dispatcher
            _ui_action = Action
            _log("ui-marshal: using WPF Application.Current.Dispatcher")
        else:
            _log("ui-marshal: no WPF Application.Current; capture calls run direct")
    except Exception:
        _log("ui-marshal: WPF dispatcher unavailable; capture calls run direct:\n"
             + traceback.format_exc())


def _run_on_ui(func):
    """Run func on SharpCap's UI thread when possible, else directly, and
    return its result. Invoke is synchronous and re-raises func's exception on
    this thread, so the caller's try/except still sees capture failures. The
    result is relayed through a closure because System.Action has no return
    channel (using Func would require pinning the exact generic arity)."""
    _resolve_ui()
    if _ui_dispatcher is None or _ui_action is None:
        return func()
    box = {}

    def _wrapper():
        box["result"] = func()

    _ui_dispatcher.Invoke(_ui_action(_wrapper))
    return box.get("result")


def _do_capture(label, pre_roll_s, duration_s, my_gen, cancel_event, meta=None, capture_id=None):
    """Wait pre_roll_s, then start a capture for duration_s. Runs in its own
    thread so the listener can keep accepting reject-only follow-ups.

    my_gen / cancel_event support re-arming: a replacement trigger for the same
    target sets cancel_event during the pre-roll wait, so this thread aborts
    before recording and the newer generation takes over. The finally only
    clears shared state if we are still the current generation."""
    global _capture_active, _recording
    try:
        if pre_roll_s > 0:
            _log("capture {!r}: waiting pre-roll {:.2f}s".format(label, pre_roll_s))
            # Interruptible wait -- returns True if cancelled (re-armed).
            if cancel_event.wait(pre_roll_s):
                _log("capture {!r}: pre-roll cancelled (re-armed with a fresher time)".format(label))
                return
        try:
            cam = SharpCap.SelectedCamera   # noqa: F821  (provided by SharpCap host)
        except Exception:
            _log("capture {!r}: no SelectedCamera, aborting".format(label))
            return
        if cam is None:
            _log("capture {!r}: SelectedCamera is None, aborting".format(label))
            return
        # A replacement may have arrived in the instant before we locked in --
        # if a newer generation exists, yield to it without recording.
        with _state_lock:
            if my_gen != _capture_gen:
                _log("capture {!r}: superseded before recording, aborting".format(label))
                return
            _recording = True
        # Snapshot the capture folder BEFORE recording so the post-capture diff
        # transfers only the file(s) this capture produces -- never leftovers.
        pre_snapshot = _scan_capture_dir() if TRANSFER_ENABLED else {}
        # SharpCap builds the capture-file writer in PrepareToCapture(); calling
        # RunCapture() without it fails with "No writer object when trying to
        # initialize it" (confirmed in SharpCap 4.1's own console). Returns True
        # when the writer is ready. Marshalled onto the UI thread like the rest.
        _log("capture {!r}: PrepareToCapture + RunCapture (duration {:.2f}s)".format(label, duration_s))
        try:
            ready = _run_on_ui(cam.PrepareToCapture)
        except Exception:
            _log("capture {!r}: PrepareToCapture failed:\n{}".format(label, traceback.format_exc()))
            return
        if ready is False:
            _log("capture {!r}: PrepareToCapture returned False (writer not ready); "
                 "aborting. Check the capture format + folder in SharpCap.".format(label))
            return
        try:
            _run_on_ui(cam.RunCapture)
        except Exception:
            _log("capture {!r}: RunCapture failed:\n{}".format(label, traceback.format_exc()))
            return
        time.sleep(duration_s)
        try:
            _run_on_ui(cam.StopCapture)
            _log("capture {!r}: StopCapture done".format(label))
        except Exception:
            _log("capture {!r}: StopCapture failed:\n{}".format(label, traceback.format_exc()))
            return
        # v0.30.12: release _capture_active BEFORE the transfer so the
        # listener can accept the next trigger while the SMB copy is
        # still running. The camera is idle as soon as StopCapture
        # returns; the file move/copy is pure disk + network I/O that
        # doesn't touch the recorder. Pre-v0.30.12 the listener stayed
        # 'busy' for the entire transfer duration (often 30-60 s over
        # SMB), so a back-to-back transit landing in that window was
        # rejected -- the recording was free but the gate was closed.
        #
        # Safe because each new capture takes its OWN pre_snapshot at
        # _do_capture entry; even if a follow-up capture starts mid-
        # transfer, their file diffs don't overlap (this transfer's
        # source files predate the next capture's RunCapture). Exception
        # in transfer still hits the finally below cleanly.
        with _state_lock:
            if my_gen == _capture_gen:
                _capture_active = False
                _recording = False
        # Transfer runs strictly after StopCapture has returned. Errors
        # are logged but never raised.
        _transfer_new_files(pre_snapshot, label, meta, capture_id)
    finally:
        # Belt-and-braces: clear the flags if for some reason they
        # haven't been cleared above (e.g. an exception escaped from
        # the capture phase before we got to the early release).
        with _state_lock:
            if my_gen == _capture_gen and (_capture_active or _recording):
                _capture_active = False
                _recording = False


def _handle_conn(conn, addr):
    global _capture_active, _capture_gen, _active_label, _recording, _cancel_event
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

        # v0.30.33: 'outcome' message handler. Sent by the predictor ~60 s
        # after a lifecycle entry finishes, carrying the verdict
        # ('confirmed' or 'probempty') for one of OUR earlier captures.
        # We look up the files we transferred under that captureId and
        # rename them with the verdict tag, so the user can sort / delete
        # without opening each .ser. No camera work touched.
        if req.get("type") == "outcome":
            cap_id = req.get("captureId")
            verdict = req.get("verdict")
            final_sep = req.get("finalSepDeg")
            renamed, missing = _apply_outcome(cap_id, verdict, final_sep)
            # Wake any _transfer_new_files thread currently blocked on
            # this captureId so the transfer step uses the freshly-
            # renamed (verdict-tagged) source file instead of starting
            # the multi-minute SSD->NAS copy under the meta-only name.
            with _outcome_events_lock:
                ev = _outcome_events.get(cap_id)
            if ev is not None:
                ev.set()
            _log("outcome {!r}: verdict={} renamed={} missing={}".format(
                cap_id, verdict, renamed, missing))
            reply = '{{"ok": true, "renamed": {}, "missing": {}}}\n'.format(renamed, missing)
            try: conn.sendall(reply.encode("utf-8"))
            except Exception: pass
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

        # Reject NaN/inf before any range check -- see _is_finite above.
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
                # Re-arm: a fresh trigger for the SAME target that is still in
                # its pre-roll (not yet recording) replaces the pending one with
                # the updated time. Anything else -- a different target, or one
                # that is already recording -- is rejected busy (never interrupt
                # a recording in progress).
                if _recording or _active_label != label:
                    _log("reject from {} ({!r}): busy".format(addr, label))
                    conn.sendall(b'{"ok": false, "error": "busy"}\n')
                    return
                _log("re-arm {!r}: replacing pending capture with updated time".format(label))
                if _cancel_event is not None:
                    _cancel_event.set()   # wake + abort the superseded pre-roll
            # Accept (fresh or replacement): bump the generation so the old
            # pre-roll thread yields, and install a new cancel event.
            _capture_gen += 1
            my_gen = _capture_gen
            _capture_active = True
            _active_label = label
            _recording = False
            _cancel_event = threading.Event()
            ev = _cancel_event

        capture_id = "{}+{}".format(label, int(time.time()))
        _log("accept from {}: {!r} preRoll={:.2f}s duration={:.2f}s".format(
            addr, label, pre_roll_s, duration_s))

        # Optional metadata bundle from the predictor (v0.30.0+). Logged as
        # a second human-readable line under the accept; answers "what was
        # this capture OF?" later when browsing the listener logfile. ASCII
        # only to stay safe across SharpCap console encodings (no degree
        # sign, no arrow glyphs).
        meta = req.get("meta") if isinstance(req.get("meta"), dict) else None
        if meta:
            parts = []
            flight = meta.get("flight")
            icao = meta.get("icao")
            body = meta.get("body")
            sep = meta.get("sepDeg")
            origin = meta.get("origin")
            destination = meta.get("destination")
            airline = meta.get("airline")
            closest_at_ms = meta.get("closestAtMs")
            alt_m = meta.get("altMmsl")
            gs_ms = meta.get("groundSpeedMs")
            track_deg = meta.get("trackDeg")
            el_deg = meta.get("elevationDeg")
            az_deg = meta.get("azimuthDeg")
            if flight: parts.append("flight=" + str(flight))
            if icao: parts.append("ICAO=" + str(icao))
            if airline: parts.append("airline=" + str(airline))
            if body: parts.append("body=" + str(body))
            if origin or destination:
                parts.append("route={}->{}".format(origin or "?", destination or "?"))
            if sep is not None:
                try: parts.append("sep={:.3f}deg".format(float(sep)))
                except Exception: pass
            if closest_at_ms is not None:
                try:
                    secs = float(closest_at_ms) / 1000.0
                    parts.append("closestAt=" + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(secs)))
                except Exception: pass
            if alt_m is not None:
                try: parts.append("alt={:.0f}m".format(float(alt_m)))
                except Exception: pass
            if gs_ms is not None:
                try: parts.append("gs={:.0f}km/h".format(float(gs_ms) * 3.6))
                except Exception: pass
            if track_deg is not None:
                try: parts.append("track={:.0f}deg".format(float(track_deg)))
                except Exception: pass
            if el_deg is not None or az_deg is not None:
                try:
                    el_str = "{:.1f}".format(float(el_deg)) if el_deg is not None else "?"
                    az_str = "{:.1f}".format(float(az_deg)) if az_deg is not None else "?"
                    parts.append("azel={}/{}deg".format(az_str, el_str))
                except Exception: pass
            if parts:
                _log("meta  {!r}: {}".format(label, " ".join(parts)))
        try:
            conn.sendall(("{\"ok\": true, \"captureId\": \"" + capture_id + "\"}\n").encode("utf-8"))
        except Exception:
            with _state_lock:
                if my_gen == _capture_gen:
                    _capture_active = False
            return

        t = threading.Thread(target=_do_capture, args=(label, pre_roll_s, duration_s, my_gen, ev, meta, capture_id))
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
