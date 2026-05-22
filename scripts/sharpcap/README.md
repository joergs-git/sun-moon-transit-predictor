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

## Install (automated — recommended)

`install.ps1` is install, start and update in one. It downloads the latest
listener from GitHub, sets up a bootstrap that **always pulls the newest
version on every SharpCap start** (no versioning), and tells you the one-time
SharpCap wiring step.

In PowerShell on the Windows PC:

```powershell
# until the feature PR is merged, pass the feature branch:
powershell -ExecutionPolicy Bypass -File install.ps1 -Branch claude/sharpcap-windows-trigger-DHPcL

# after merge to main, simply:
powershell -ExecutionPolicy Bypass -File install.ps1
```

You can fetch and run it in one line:

```powershell
$u="https://raw.githubusercontent.com/joergs-git/sun-moon-transit-predictor/main/scripts/sharpcap/install.ps1"; iwr $u -OutFile "$env:TEMP\stp-install.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\stp-install.ps1"
```

What it does:

- Installs into `%LOCALAPPDATA%\stp-sharpcap` (`bootstrap.py` +
  `trigger_listener.cached.py` as offline fallback).
- Prints the one-time SharpCap step: *File → SharpCap Settings → Startup →
  run script* → point it at the installed `bootstrap.py`.
- On every SharpCap launch the bootstrap downloads the latest
  `trigger_listener.py` from GitHub and runs it in-process. **Updating = just
  restart SharpCap.** Re-running `install.ps1` refreshes the bootstrap itself.

Switches:

| Switch            | Effect                                                                 |
|-------------------|------------------------------------------------------------------------|
| `-Branch <name>`  | which Git branch to pull from (default `main`)                         |
| `-StartSharpCap`  | launch SharpCap right after install                                    |
| `-InstallPython`  | also install CPython via winget — **not needed by the listener** (it   |
|                   | runs in SharpCap's IronPython); only for the optional host-side `nc`   |
|                   | test tooling                                                           |
| `-InstallDir <p>` | override the install folder                                            |
| `-Help`           | print full usage and exit (also `Get-Help .\install.ps1 -Detailed`)    |

### Defining the folders (do this once)

The folder to watch on the Windows PC and the network destination are
machine-specific, so they live in a local config file
(`%LOCALAPPDATA%\stp-sharpcap\stp-sharpcap.config.json`) — **not** in the
listener body. This is important: the bootstrap re-downloads the listener from
GitHub on every start, but it never touches your config, so your paths survive
every update.

**Easiest — pick the folders in a dialog (no typing, no typos):**

```powershell
.\install.ps1 -EnableTransfer    # pops a classic folder picker for source + destination
```

`-EnableTransfer` without paths opens the standard Windows folder browser for
the SharpCap capture folder and then the network destination (the picker's
Network node / mapped drives let you choose a UNC target, and the "New folder"
button creates the destination). To re-pick later without changing anything
else:

```powershell
.\install.ps1 -PickFolders
```

**Or pass the paths explicitly** (also merges, so re-running keeps what you set):

```powershell
.\install.ps1 -EnableTransfer `
              -SourceDir 'C:\SharpCap Captures' `
              -DestDir '\\NAS\transits' `
              -Move          # optional: move instead of copy
```

> The dialog needs an STA host — Windows PowerShell (`powershell.exe`) is STA
> by default, so run it there. In an MTA host (e.g. `pwsh`) the installer
> falls back to a typed prompt automatically.

Config params:

| Switch / param        | Config key        | Meaning                                              |
|-----------------------|-------------------|------------------------------------------------------|
| `-SourceDir <path>`   | `sourceDir`       | SharpCap capture folder to watch (**subfolders included** — `os.walk` recurses, so SharpCap's date subfolders are fine) |
| `-DestDir <path>`     | `destDir`         | network destination, UNC (`\\NAS\share`) or mapped drive (`Z:\...`) |
| `-EnableTransfer`     | `transferEnabled` | turn transfer on                                     |
| `-DisableTransfer`    | `transferEnabled` | turn transfer off                                    |
| `-Move` / `-Copy`     | `move`            | move (delete local original) vs copy (default)       |
| `-Exts .ser,.txt`     | `exts`            | which extensions to transfer                         |
| `-Port <n>`           | `port`            | listener TCP port (match predictor `sharpcap.port`)  |
| `-Token <s>`          | `token`           | shared secret (match predictor `sharpcap.token`)     |
| `-PickFolders`        | —                 | choose `sourceDir` + `destDir` in a folder dialog    |

You can also edit the JSON directly:

```json
{
  "port": 9999,
  "token": "",
  "transferEnabled": true,
  "sourceDir": "C:\\SharpCap Captures",
  "destDir": "\\\\NAS\\transits",
  "move": false,
  "exts": [".ser"]
}
```

> The same keys also work via the `STP_SHARPCAP_CONFIG` env var (point it at a
> JSON file) for the manual-install path that doesn't use the bootstrap.

> **Why no standalone Python?** `trigger_listener.py` calls
> `SharpCap.SelectedCamera`, which only exists inside SharpCap's scripting
> host (IronPython). It cannot run as an external Python process, so it needs
> no CPython and no pip packages — it is standard-library only.

## Install (manual — if you prefer no auto-update)

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

## Optional: copy the .ser to a network drive after each capture

The listener can transfer the file(s) SharpCap just wrote into a folder on a
network drive once the recording has stopped. This is **opt-in** — set
`TRANSFER_ENABLED = True` at the top of `trigger_listener.py`.

| Constant                    | Default                | Purpose                                                       |
|-----------------------------|------------------------|---------------------------------------------------------------|
| `TRANSFER_ENABLED`          | `False`                | master switch                                                 |
| `SER_SOURCE_DIR`            | `C:\SharpCap Captures` | **must match** SharpCap's capture folder                      |
| `SER_DEST_DIR`              | `\\NAS\transits`       | UNC path or mapped drive (e.g. `Z:\transits`)                 |
| `TRANSFER_MOVE`             | `False`                | `True` = move (delete local original); `False` = copy         |
| `TRANSFER_EXTS`             | `(".ser",)`            | extensions to transfer; add `".txt"` for the metadata sidecar |
| `TRANSFER_SETTLE_TIMEOUT_S` | `60`                   | max wait for SharpCap to finish writing each file             |
| `TRANSFER_POST_STOP_DELAY_S`| `1.5`                  | grace after StopCapture before scanning (covers `.tmp` rename)|
| `TRANSFER_RESCAN_S`         | `2.0`                  | if nothing new yet, wait and scan once more                   |

How it guarantees correctness:

- **Transfer only after the recording is finished.** It runs strictly after
  `StopCapture()` returns, then waits per file until the file size stops
  growing (the handle is released) before touching it — a half-written `.ser`
  is never copied.
- **Old files are never re-transferred.** The capture folder is snapshotted
  *before* `RunCapture()`; only files that are new — or that grew — relative
  to that snapshot are sent. Leftovers from earlier captures (e.g. in copy
  mode) are excluded by construction, and an in-process ledger of already-sent
  files is a second line of defence.
- Detection is by file modification time, **not** the SharpCap API, so it is
  independent of the SharpCap version. Set the capture format to **SER** and
  point `SER_SOURCE_DIR` at SharpCap's capture folder
  (*File → SharpCap Settings → General → Capture Folder*).

## Configure (predictor side)

**Easiest: the web Settings panel.** Open the predictor UI → ⚙ Settings →
*SharpCap capture trigger*. There you can toggle it on/off, set the Windows
host + port, the pre-/post-roll (default −10 s / +10 s around the predicted
transit), the minimum elevation, the "push on trigger" toggle, and hit
**Test trigger (2 s)** to fire an immediate test capture against the host in
the form (no save needed). Changes hot-reload and persist to
`config/service.json`.

Or edit `config/service.json` directly:

```json
"sharpcap": {
  "enabled": true,
  "host": "192.168.1.42",
  "port": 9999,
  "token": "",
  "preBufferS": 10,
  "postBufferS": 10,
  "triggerOnStage": "imminent",
  "minElevationDeg": 20,
  "bodies": ["Sun", "Moon"],
  "dedupMs": 60000,
  "connectTimeoutMs": 2000,
  "notifyOnTrigger": true
}
```

| Key               | What it does                                                                  |
|-------------------|-------------------------------------------------------------------------------|
| `host`            | Windows PC running SharpCap                                                   |
| `preBufferS`      | recording starts this many seconds *before* closest approach (default 10)     |
| `postBufferS`     | recording stops this many seconds *after* closest approach (default 10)       |
| `triggerOnStage`  | fire on `imminent` (default ±30 s window), `candidate`, or `radio`            |
| `minElevationDeg` | skip when target is below this — telescope can't see anyway                   |
| `bodies`          | which body to record (`Sun`, `Moon`, or both)                                 |
| `dedupMs`         | suppress identical `(icao, body)` re-triggers within this window              |
| `notifyOnTrigger` | send a Pushover (flight, separation, ETA, −pre/+post window) when armed       |

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
