# SharpCap trigger (Windows side)

Live trigger that lets `sun-moon-transit-predictor` start a SharpCap recording
the moment an aircraft transit becomes imminent — typically 30 s or less of
warning, too tight for the SharpCap Sequencer.

## How it works

```
Predictor (Linux/Pi)            Windows PC
─────────────────────           ──────────────────────────────────
notifier emits 'imminent'  ──▶  trigger_listener.py inside SharpCap
src/sharpcap.js TCP        ──▶  RunCapture() after preRoll, then StopCapture()
```

The listener listens on TCP `:9999`. The predictor connects, sends one JSON
line, the listener replies one JSON line, then arms the capture.

## Install (one-time)

1. Open SharpCap. **Camera must already be selected, live preview running**
   (warm USB pipeline → first frame within ~10-50 ms of `RunCapture()`).
2. `File → Scripting → Open script…` → pick this file:
   `scripts/sharpcap/trigger_listener.py` (copy it onto the Windows PC if the
   predictor runs on a different machine).
3. Press **Run**. The script log should show
   `listener thread started; SharpCap is free to be used normally`.
4. (Optional) put the script in SharpCap's "Run on startup" so it comes up
   with SharpCap.

## Configure (Windows side)

Edit the constants at the top of `trigger_listener.py` if you need to:

| Constant       | Default       | Purpose                                       |
|----------------|---------------|-----------------------------------------------|
| `PORT`         | `9999`        | TCP port                                      |
| `BIND`         | `0.0.0.0`     | `127.0.0.1` to restrict to local SharpCap-PC  |
| `SHARED_TOKEN` | `""`          | non-empty → predictor must send matching token|
| `MAX_DURATION_S`| `120`        | safety cap                                    |
| `MAX_PRE_ROLL_S`| `90`         | safety cap                                    |

## Configure (predictor side)

In `config/service.json`:

```json
"sharpcap": {
  "enabled": true,
  "host": "192.168.1.42",
  "port": 9999,
  "token": "",
  "preBufferS": 5,
  "postBufferS": 15,
  "triggerOnStage": "imminent",
  "minElevationDeg": 20,
  "bodies": ["Sun", "Moon"],
  "dedupMs": 60000,
  "connectTimeoutMs": 2000
}
```

| Key               | What it does                                                                  |
|-------------------|-------------------------------------------------------------------------------|
| `host`            | Windows PC running SharpCap                                                   |
| `preBufferS`      | recording starts this many seconds *before* closest approach                  |
| `postBufferS`     | recording stops this many seconds *after* closest approach                    |
| `triggerOnStage`  | fire on `imminent` (default ±30 s window), `candidate`, or `radio`            |
| `minElevationDeg` | skip when target is below this — telescope can't see anyway                   |
| `bodies`          | which body to record (`Sun`, `Moon`, or both)                                 |
| `dedupMs`         | suppress identical `(icao, body)` re-triggers within this window              |

## Wire-format

Request (predictor → listener):
```json
{"label": "abc123|Sun", "preRollS": 4.7, "durationS": 20, "token": ""}
```

Reply (listener → predictor):
```json
{"ok": true, "captureId": "abc123|Sun+1716300000"}
```
or
```json
{"ok": false, "error": "busy"}
```

Errors: `bad-json`, `bad-duration`, `over-limit`, `busy`, `unauth`,
`no-camera`, `handler-exception`.

## Test by hand

From the Linux box, with the listener running:

```bash
echo '{"label":"manual-test|Sun","preRollS":0,"durationS":3}' | nc <windows-ip> 9999
```

You should see SharpCap kick off a 3 s capture immediately, and `nc` should
print the JSON reply with `"ok": true`.
