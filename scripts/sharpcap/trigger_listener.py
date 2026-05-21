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
import socket
import threading
import time
import traceback

PORT = 9999
BIND = "0.0.0.0"               # set to "127.0.0.1" to restrict to localhost
SHARED_TOKEN = ""              # set to a string to require token == this
LOG_PATH = "sharpcap_trigger.log"   # next to SharpCap.exe; comment out to disable

# Maximum allowed values — guard against a buggy client asking for an hour-long
# capture or a half-hour pre-roll that would block subsequent triggers.
MAX_DURATION_S = 120
MAX_PRE_ROLL_S = 90


_state_lock = threading.Lock()
_capture_active = False


def _log(line):
    msg = "[{}] {}".format(time.strftime("%Y-%m-%dT%H:%M:%S"), line)
    print(msg)
    if LOG_PATH:
        try:
            with open(LOG_PATH, "a") as f:
                f.write(msg + "\n")
        except Exception:
            pass


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


_listener_thread = threading.Thread(target=_serve)
_listener_thread.daemon = True
_listener_thread.start()
_log("listener thread started; SharpCap is free to be used normally")
