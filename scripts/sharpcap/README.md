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

In **Windows PowerShell** on the Windows PC (the listener now lives on
`main`, so no `-Branch` needed):

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

> **"…kann nicht geladen werden, da die Ausführung von Skripts ... deaktiviert
> ist" / "running scripts is disabled on this system"?** That is the default
> execution policy blocking a double-clicked or directly-invoked `.ps1`. Do
> **not** run `C:\...\install.ps1` on its own — always go through
> `powershell -ExecutionPolicy Bypass -File <path>` as shown above, which
> bypasses the policy for that one run only (and also clears the
> downloaded-file "Mark of the Web" block). If you prefer a persistent
> setting instead, run once:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

You can fetch and run it in one line (no `-Branch` needed — pulls from `main`):

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
transit), the minimum elevation, the **trigger body** (Sun *or* Moon — one
scope can only track one disc at a time), the "push on trigger" toggle, and hit
**Test trigger (2 s)** to fire an immediate test capture against the host in
the form (no save needed). Changes hot-reload and persist to
`config/service.json`.

When the trigger is enabled, a small readout appears in the header next to the
clock — `🎥 ☀ Sun · 3×` — showing the armed body and how many captures it has
armed this session (resets on service restart). It is hidden entirely when the
trigger is off.

Or edit `config/service.json` directly:

```json
"sharpcap": {
  "enabled": true,
  "host": "192.168.1.42",
  "port": 9999,
  "token": "",
  "preBufferS": 10,
  "postBufferS": 10,
  "minElevationDeg": 20,
  "maxSepDeg": 0.5,
  "bodies": ["Sun"],
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
| `minElevationDeg` | skip when target is below this (telescope can't see it). **0 = never gate on elevation** — set this if you'd rather record everything. |
| `maxSepDeg`       | arm any candidate projected within this separation (default 0.5° — generous, "rather over-record than miss"). Lower to be stricter. |
| `bodies`          | which disc to record — a one-element array, `["Sun"]` or `["Moon"]` (the Settings panel exposes this as a single-select; one scope tracks one disc at a time) |
| `dedupMs`         | suppress identical `(icao, body)` re-triggers within this window              |
| `notifyOnTrigger` | send a Pushover (flight, separation, ETA, −pre/+post window) when armed       |

### How arming works (v0.21.11 — "never miss a transit")

The capture is armed by a **per-tick check against every live candidate**, not
by a single one-shot event. Earlier versions fired only on the notifier's
`imminent` stage (a ±30 s window); if ADS-B briefly dropped the aircraft in
exactly that window, the shot was lost. Now, on every 2 s tick, each candidate
whose **projected closest separation ≤ `maxSepDeg`** and whose **closest
approach is near enough that the pre-roll fits** (≤ ~95 s out) arms a capture —
once per `(icao, body)` thanks to dedup. The pre-roll is
`max(0, secondsToClosest − preBufferS)`, so a transit that is already seconds
away records **immediately** (pre-roll 0). A transient send error releases the
dedup slot so the next tick retries. Net effect: as long as the aircraft is
tracked on *any* tick in the ~95 s before closest approach, it records.

If a trigger does NOT fire, the service journal now says why
(`sharpcap: arm skipped … too-low (el 22°, minEl 30°)` etc.) — check it with
`journalctl -u stp.service -f | grep -i sharpcap` on the Pi.

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

## Troubleshooting: "OK" but no recording

The listener replies `{"ok": true, "captureId": …}` the instant it **accepts**
the trigger — the actual `RunCapture()` runs in a background thread *after*
the reply. So a green "OK" / a `captureId` only means *the trigger arrived*,
**not** that a clip was recorded. The capture thread can still abort silently,
almost always because **no camera is selected / live preview isn't running**
in SharpCap (the listener needs `SharpCap.SelectedCamera`).

Where to look:

- **SharpCap scripting console** — every log line is also `print()`ed there,
  so it shows regardless of any file issue. After `accept from … 'manual-test'`
  you'll see the outcome: `SelectedCamera is None, aborting`,
  `RunCapture failed: …`, or `StopCapture done` (it actually recorded — check
  the capture folder).
- **Log file** — `%LOCALAPPDATA%\stp-sharpcap\sharpcap_trigger.log` (paste that
  into the Explorer address bar). The bootstrap and the listener both write
  here. Note: a manually-installed listener (no bootstrap) defaults to the
  same `%LOCALAPPDATA%\stp-sharpcap\` path too; only if `LOCALAPPDATA` is
  unset does it fall back to a CWD-relative `sharpcap_trigger.log` (which under
  a Program Files SharpCap install is admin-only and silently un-writable —
  this was fixed in v0.21.7; older copies logged to SharpCap's working dir).

Fix: select the camera in SharpCap and start the live preview, then trigger
again. If `StopCapture done` appears but you see no file, check the capture
folder + format (*File → SharpCap Settings → General → Capture Folder*).

### `RunCapture failed: SystemError: No writer object when trying to initialize it`

Camera selected, live view running, a *manual* capture works — but the
scripted trigger (and even a bare `SharpCap.SelectedCamera.RunCapture()` in
SharpCap's own console) throws this. The capture-file **writer is built by
`PrepareToCapture()`**, which `RunCapture()` does not call itself — without it
the writer object is null. Fixed in **v0.21.10**: the listener now calls
`PrepareToCapture()` (must return `True`) immediately before `RunCapture()`.

Separately, all capture calls are marshalled onto SharpCap's WPF dispatcher
(v0.21.8) so they run on the UI thread — the pre-roll/duration timing stays on
the background thread, so the UI never freezes. The log shows
`ui-marshal: using WPF Application.Current.Dispatcher` once, then
`PrepareToCapture + RunCapture …` and finally `StopCapture done`.

> Getting the fix requires the **bootstrap auto-download to actually work** —
> see the next item.

### `[bootstrap] download failed … ImportError: Cannot import name WebClient` (stuck on the cached listener)

SharpCap 4.x embeds **CPython (Python.NET)**, not IronPython, and CPython has
no `System.Net.WebClient` — so the bootstrap's GitHub download failed every
time and silently fell back to the cached (old) listener. You'd see
`[bootstrap] using cached listener …` on every start and never receive
updates. Fixed in **v0.21.9**: the bootstrap now downloads via the CPython
stdlib (`urllib`), keeping WebClient only as a fallback for the old IronPython
hosts.

Because the broken bootstrap can't fetch its own fix, **re-run `install.ps1`
once** (PowerShell downloads the fixed bootstrap + a fresh cached listener
directly). After that, restart SharpCap — the log should show
`[bootstrap] downloaded latest listener from …` and auto-update works again.

### `config: failed reading …\stp-sharpcap.config.json` / `Expecting value: line 1 column 1 (char 0)`

The config file has a UTF-8 **BOM** (Windows PowerShell 5.1's
`Set-Content -Encoding UTF8` writes one), which CPython's `json` rejects. The
listener falls back to built-in defaults, so a simple test still works, but
your saved port/token/transfer settings are ignored. Fixed in **v0.21.9**:
the installer writes the config without a BOM, and both the bootstrap and the
listener strip a leading BOM (and tolerate an empty file) when reading. Re-run
`install.ps1` once to rewrite the file cleanly, or just delete it
(`del "$env:LOCALAPPDATA\stp-sharpcap\stp-sharpcap.config.json"`) if you only
need the defaults.
