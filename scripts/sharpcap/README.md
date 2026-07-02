# SharpCap capture trigger (Windows)

> The predictor starts a **SharpCap recording the instant a transit goes imminent**
> — often < 30 s warning, far too tight for SharpCap's own Sequencer. A tiny
> listener runs inside SharpCap; the Pi triggers it over your LAN. Standard-library
> only, auto-updating, set up in ~2 minutes.

---

## 🚀 Quick start — 3 steps

Everything here is copy-paste. **The install command already includes the Windows
execution-policy bypass**, so it just works (if you still see *"running scripts is
disabled"*, you ran `.\install.ps1` bare — see the note under step 1).

### 1 · Install the listener
In **Windows PowerShell** on the PC running SharpCap:

```powershell
$u="https://raw.githubusercontent.com/joergs-git/sun-moon-transit-predictor/main/scripts/sharpcap/install.ps1"; iwr $u -OutFile "$env:TEMP\stp.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\stp.ps1"
```

> Already cloned the repo? Just run: `powershell -ExecutionPolicy Bypass -File .\install.ps1`
>
> ⚠️ **`.\install.ps1` alone fails** with *"running scripts is disabled on this
> system" (PSSecurityException)* — that's Windows' Execution Policy, **not** an
> error or an admin problem. Always use the `powershell -ExecutionPolicy Bypass
> -File …` form above (nothing permanent changes), or once:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. More ↓ *install.ps1 switches*.

### 2 · Wire it into SharpCap — once
The installer prints the exact path. In SharpCap:

1. **Select your camera** and start the **live preview** (keeps the USB pipeline warm → capture starts in ~10–50 ms).
2. *File → SharpCap Settings → Startup → run script* → point it at the printed `bootstrap.py`.
3. **Restart SharpCap.**

### 3 · Point the predictor at it
On start, the SharpCap scripting console prints the address to use:

```
→ set the predictor's sharpcap.host to: 192.168.1.99:9999
```

Open the predictor UI → **⚙ Settings → SharpCap capture trigger**: toggle **on**,
paste that **host + port**, pick **Sun _or_ Moon**, then hit **Test trigger (2 s)**.

### ✅ Done
A 2-second test clip should record. From now on **updating = just restart SharpCap**
— the listener auto-downloads the latest version every launch.

> **Nothing recorded but it said "OK"?** Almost always: no camera selected / live
> preview not running. → *Troubleshooting* below.

---

## 📖 Details & options

<sub>Open only what you need — the quick start above is enough for a single Sun (or Moon) rig.</sub>

<details>
<summary><b>🖼 How it works (10-second mental model)</b></summary>

```
Predictor (Linux/Pi)            Windows PC
─────────────────────           ──────────────────────────────────
notifier emits 'imminent'  ──▶  trigger_listener.py inside SharpCap
src/sharpcap.js  TCP :9999 ──▶  RunCapture() after preRoll, then StopCapture()
```

The listener listens on TCP `:9999`. The predictor connects, sends one JSON line,
the listener replies one JSON line, then arms the capture. The listener is
**standard-library only** — no CPython, no pip. (It calls `SharpCap.SelectedCamera`,
which only exists inside SharpCap's scripting host, so it *cannot* run as an
external process — which is also why it needs nothing installed.)
</details>

<details>
<summary><b>⚙️ Predictor-side config — buffers, bodies, tuning</b></summary>

**Easiest: the web Settings panel.** Predictor UI → ⚙ Settings → *SharpCap capture
trigger*. Toggle on/off, set host + port, pre-/post-roll (default −10 s / +10 s
around the predicted transit), min elevation, the **trigger body** (Sun *or* Moon
— one scope tracks one disc at a time), "push on trigger", and **Test trigger (2 s)**
to fire an immediate test against the host in the form (no save needed). Changes
hot-reload and persist to `config/service.json`.

When enabled, a readout appears in the header next to the clock — `🎥 ☀ Sun · 3×` —
showing the armed body and how many captures it armed this session (resets on
restart); hidden when off. History / Live-Tracking rows whose transit had a capture
armed get a **⚡ next to the traffic-light**.

**Focused alerts:** while the trigger is on, aircraft Pushovers for the *other* disc
are suppressed (armed for Sun → no Moon buzzes, and vice versa). History + stats
still record both; the ISS is exempt. Turn the trigger off → both bodies push again.

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
| `minElevationDeg` | skip when target is below this. **0 = never gate on elevation** (record everything). |
| `maxSepDeg`       | arm any candidate projected within this separation (default 0.5° — "rather over-record than miss"). Lower = stricter. |
| `bodies`          | which disc to record — `["Sun"]` or `["Moon"]` (one scope tracks one disc)    |
| `dedupMs`         | suppress identical `(icao, body)` re-triggers within this window              |
| `notifyOnTrigger` | Pushover (flight, separation, ETA, −pre/+post window) when armed              |
| `targets`         | **multi-rig** — per-telescope overrides (see *Multiple telescopes*). Empty = single rig |
</details>

<details>
<summary><b>📁 Auto-copy captures to a NAS / network drive</b></summary>

The listener can move/copy the `.ser` SharpCap just wrote to a network folder once
recording stops. **Opt-in.**

**Pick the folders in a dialog (no typing, no typos):**

```powershell
.\install.ps1 -EnableTransfer     # folder picker for source, then destination
.\install.ps1 -PickFolders        # re-pick later without changing anything else
```

<sub>(Prefix with `powershell -ExecutionPolicy Bypass -File` if scripts are blocked.)</sub>

The picker's Network node / mapped drives let you choose a UNC target; "New folder"
creates the destination. **Or pass paths explicitly** (merges, so re-running keeps
what you set):

```powershell
.\install.ps1 -EnableTransfer `
              -SourceDir 'C:\SharpCap Captures' `
              -DestDir '\\NAS\transits' `
              -Move          # optional: move instead of copy
```

> The dialog needs an STA host — `powershell.exe` is STA by default (run it there).
> In an MTA host (e.g. `pwsh`) the installer falls back to a typed prompt.

Config lives in `%LOCALAPPDATA%\stp-sharpcap\stp-sharpcap.config.json` (**not** in the
listener body — so it survives every auto-update):

| Switch / param      | Config key        | Meaning                                              |
|---------------------|-------------------|------------------------------------------------------|
| `-SourceDir <path>` | `sourceDir`       | SharpCap capture folder to watch (**subfolders included**) |
| `-DestDir <path>`   | `destDir`         | network destination, UNC (`\\NAS\share`) or mapped drive (`Z:\…`) |
| `-EnableTransfer` / `-DisableTransfer` | `transferEnabled` | transfer on / off                     |
| `-Move` / `-Copy`   | `move`            | move (delete local original) vs copy (default)       |
| `-Exts .ser,.txt`   | `exts`            | which extensions to transfer                         |
| `-Port <n>`         | `port`            | listener TCP port (match predictor `sharpcap.port`)  |
| `-Token <s>`        | `token`           | shared secret (match predictor `sharpcap.token`)     |

```json
{ "port": 9999, "token": "", "transferEnabled": true,
  "sourceDir": "C:\\SharpCap Captures", "destDir": "\\\\NAS\\transits",
  "move": false, "exts": [".ser"] }
```

<sub>The same keys also work via the `STP_SHARPCAP_CONFIG` env var (point it at a JSON file) for the manual-install path.</sub>

**Correctness guarantees**
- **Only after recording finishes** — runs strictly after `StopCapture()`, then waits per file until its size stops growing (handle released). A half-written `.ser` is never copied.
- **Never re-transfers old files** — the folder is snapshotted *before* `RunCapture()`; only new/grown files are sent, plus an in-process ledger as a second defence.
- Detection is by file modification time, **not** the SharpCap API → version-independent. Set the capture format to **SER** and point `sourceDir` at SharpCap's capture folder (*File → SharpCap Settings → General → Capture Folder*).

<sub>Advanced timing (manual/`.py` constants, rarely touched): `TRANSFER_SETTLE_TIMEOUT_S` (60 — max wait for SharpCap to finish writing a file), `TRANSFER_POST_STOP_DELAY_S` (1.5 — grace after StopCapture, covers the `.tmp` rename), `TRANSFER_RESCAN_S` (2.0 — if nothing new yet, wait and scan once more).</sub>
</details>

<details>
<summary><b>🔭 Multiple telescopes / cameras (multi-rig & two instances)</b></summary>

**Different bodies on different rigs/PCs** — e.g. an Hα solar scope for the Sun on
one machine, a normal scope for the Moon on another. Each entry runs its **own**
listener on its own `host:port`, inherits the shared knobs and overrides just what
differs. Routing is automatic (a Sun candidate arms only Sun rigs, etc.), each with
independent dedup + re-arm state:

```json
"sharpcap": {
  "enabled": true,
  "maxSepDeg": 0.5, "leadDriftFrac": 0.5, "maxCaptureS": 115,
  "targets": [
    { "name": "Ha-Sun", "host": "192.168.1.99", "port": 9999, "bodies": ["Sun"],  "preBufferS": 8,  "postBufferS": 8 },
    { "name": "Moon",   "host": "192.168.1.50", "port": 9999, "bodies": ["Moon"], "preBufferS": 12, "postBufferS": 12 }
  ]
}
```

Each PC runs the same `install.ps1`. A rig is active when it has a `host`; per-rig
`token` is optional (falls back to the base token). You can also manage rigs in the
**web Settings panel** (*SharpCap → Capture rigs → + Add rig*), each with its own
**Test 2 s** button to verify a scope's PC independently.

**Two SharpCap instances on the _same_ PC** (two cameras → two listener ports, since
one process can't bind 9999 twice):

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -AddInstance
# or name/port yourself:
powershell -ExecutionPolicy Bypass -File .\install.ps1 -AddInstance -InstanceName Moon -InstancePort 9998
```

It copies the config to `stp-sharpcap.<name>.config.json` (new port), auto-detects
`SharpCap.exe` (override `-SharpCapPath`), and drops `Desktop\SharpCap-<name>.bat`
that launches SharpCap with `STP_SHARPCAP_CONFIG` set. Then:

1. Launch SharpCap **#1 normally** (base port).
2. Double-click `SharpCap-<name>.bat` for **#2** (second port).
3. Add matching targets in the predictor:
   ```json
   "targets": [
     { "name": "Sun",  "host": "127.0.0.1", "port": 9999, "bodies": ["Sun"]  },
     { "name": "Moon", "host": "127.0.0.1", "port": 9998, "bodies": ["Moon"] }
   ]
   ```

Both instances share the install dir, cached listener and (timestamped, tagged) log.
Re-run `-AddInstance` with a new `-InstanceName` for a third.
</details>

<details>
<summary><b>🛠 Manual install (no auto-update) + listener constants</b></summary>

Prefer no bootstrap / no auto-download:

1. Open SharpCap. **Camera selected, live preview running.**
2. *File → Scripting → Open script…* → `scripts/sharpcap/trigger_listener.py` (copy it onto the Windows PC if the predictor runs elsewhere).
3. Press **Run**. The log shows `listener thread started; SharpCap is free to be used normally`, and right after `bound on 0.0.0.0:9999` the machine's LAN address, e.g. `→ set the predictor's sharpcap.host to: 192.168.1.99:9999`.
4. (Optional) add the script to SharpCap's "Run on startup".

Constants at the top of `trigger_listener.py`:

| Constant         | Default   | Purpose                                        |
|------------------|-----------|------------------------------------------------|
| `PORT`           | `9999`    | TCP port                                       |
| `BIND`           | `0.0.0.0` | `127.0.0.1` to restrict to the local PC        |
| `SHARED_TOKEN`   | `""`      | non-empty → predictor must send a matching token |
| `MAX_DURATION_S` | `120`     | safety cap                                     |
| `MAX_PRE_ROLL_S` | `90`      | safety cap                                     |
| `TRANSFER_ENABLED` | `False` | master switch for the NAS copy (see *Auto-copy*); the `SER_*` / `TRANSFER_*` constants below it mirror the config-file keys |
</details>

<details>
<summary><b>🧠 How arming works — "never miss a transit"</b></summary>

**Per-tick, not one-shot.** On every 2 s tick, each candidate whose **projected
closest separation ≤ `maxSepDeg`** and whose closest approach is near enough that
the pre-roll fits (≤ ~95 s out) arms a capture — once per `(icao, body)` via dedup.
Pre-roll is `max(0, secondsToClosest − preBufferS)`, so a transit already seconds
away records immediately. As long as the aircraft is tracked on *any* tick in the
~95 s before closest approach, it records. (Earlier versions fired only on the ±30 s
`imminent` stage — a brief ADS-B dropout there lost the shot.)

**Drift margin (v0.23.1).** The predicted time is less certain the earlier you arm,
so the window widens by `leadDriftFrac × secondsToClosest` each side, capped at
`maxDriftS`. Defaults `0.5` / `45 s` → arming 50 s out records ±35 s instead of ±10 s.
Set `leadDriftFrac: 0` to use only the fixed buffers.

**Re-arming (v0.23.4).** If the predicted closest-approach moves > `reArmShiftS`
(default 12 s) while still in pre-roll, the predictor re-sends and the listener
**replaces** the pending capture with the fresher time. A capture already recording
is never interrupted; a different target gets `busy`.

Didn't fire? The journal says why — `journalctl -u stp.service -f | grep -i sharpcap`
(e.g. `arm skipped … too-low (el 22°, minEl 30°)`).
</details>

<details>
<summary><b>🔭 Mount control (ASCOM) — point the scope at the night object (v0.55.0, opt-in)</b></summary>

The listener can also **drive an ASCOM mount** so the predictor points the scope
at the active **night** object (star/DSO/planet — **never the Sun**) and, opt-in,
runs an unattended sequence around a pass (`unpark → slew → track`, then `park`).
The listener talks **ASCOM Telescope directly** (`ASCOM.DriverAccess`, lazy import),
so SharpCap keeps only the camera — no Device Hub needed.

**Windows setup:** set your mount's ASCOM **ProgID** for the listener (once):

```powershell
setx STP_MOUNT_PROGID "ASCOM.DeviceHub.Telescope"   # or your driver's ProgID; then restart SharpCap
```

If two rigs share **one** mount, set `STP_MOUNT_PROGID` on **only one** listener
(the other replies `mount-not-configured`, harmless).

**Predictor side:** ⚙ Settings → Scopes → *🔭 Mount control* — tick **Allow mount
slew**, set Lead/Min-elevation, **Save**, then use **Status / Unpark / Slew to
target / Park / Arm sequence**. All safety gates are server-enforced: **never the
Sun, night only, above min elevation, no slew during a capture.** Blind goto —
**framing accuracy = your polar alignment; PA the mount manually first.**

> ⚠️ **Bench-test before any unattended night:** with someone watching the mount,
> click **Unpark → Slew to target → Park** once. Only then arm the sequence.

Wire command (server → listener): `{ "cmd": "mount", "action": "slew",
"raHours": 18.6156, "decDeg": 38.7837, "token": "…" }` → `{ "ok": true,
"slewing": true }`. Actions: `unpark`, `slew`, `track` (`on`), `park`, `status`.
</details>

<details>
<summary><b>🔧 install.ps1 switches & the execution-policy story</b></summary>

`install.ps1` is install + start + update in one. It installs into
`%LOCALAPPDATA%\stp-sharpcap` (`bootstrap.py` + a cached listener as offline
fallback); on every SharpCap launch the bootstrap downloads the latest
`trigger_listener.py` from GitHub and runs it in-process.

| Switch            | Effect                                                                 |
|-------------------|------------------------------------------------------------------------|
| `-Branch <name>`  | which Git branch to pull from (default `main`)                         |
| `-StartSharpCap`  | launch SharpCap right after install                                    |
| `-InstallPython`  | install CPython via winget — **not needed** by the listener; only for optional host-side `nc` test tooling |
| `-InstallDir <p>` | override the install folder                                            |
| `-AddInstance`    | add a second SharpCap instance/port (see *Multiple telescopes*)        |
| `-EnableTransfer` / `-PickFolders` | NAS copy setup (see *Auto-copy*)                       |
| `-Help`           | full usage (also `Get-Help .\install.ps1 -Detailed`)                   |

**Execution policy — why `.\install.ps1` fails and how to fix it.** Windows blocks
`.ps1` scripts by default (`Restricted`/`AllSigned`), and downloaded files carry a
"Mark of the Web" block. This is a security policy, **not** an error in the script
and **not** an admin/rights issue. Two fixes:

```powershell
# Per-run bypass (recommended — changes nothing permanently). Keep your args:
powershell -ExecutionPolicy Bypass -File .\install.ps1 -AddInstance -InstanceName rc12 -InstancePort 9998

# Or allow it once for your user (then .\install.ps1 works directly; reopen PowerShell):
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

The `Bypass` form also clears the Mark-of-the-Web block; if a block persists after
download, run `Unblock-File .\install.ps1` once. **This applies to every**
`install.ps1` **command in this README** (`-EnableTransfer`, `-PickFolders`,
`-AddInstance`).
</details>

<details>
<summary><b>🧪 Test by hand + wire format</b></summary>

From the Linux box, with the listener running:

```bash
echo '{"label":"manual-test|Sun","preRollS":0,"durationS":3}' | nc <windows-ip> 9999
```

SharpCap should kick off a 3 s capture immediately and `nc` should print `"ok": true`.

**Request** (predictor → listener):
```json
{"label": "abc123|Sun", "preRollS": 4.7, "durationS": 20, "token": ""}
```
**Reply** (listener → predictor):
```json
{"ok": true, "captureId": "abc123|Sun+1716300000"}   // or {"ok": false, "error": "busy"}
```
Errors: `bad-json`, `bad-duration`, `over-limit`, `busy`, `unauth`, `no-camera`, `handler-exception`.
</details>

<details>
<summary><b>🩺 Troubleshooting</b></summary>

**"OK" but no recording.** The listener replies `{"ok": true}` the instant it
*accepts* the trigger — `RunCapture()` runs in a background thread *after*. A green
OK means *the trigger arrived*, **not** that a clip was recorded. The capture almost
always aborts because **no camera is selected / live preview isn't running** (the
listener needs `SharpCap.SelectedCamera`). Look at:
- **SharpCap scripting console** — every log line prints there. After `accept from …`
  you'll see `SelectedCamera is None, aborting`, `RunCapture failed: …`, or
  `StopCapture done` (it recorded — check the capture folder).
- **Log file** — `%LOCALAPPDATA%\stp-sharpcap\sharpcap_trigger.log` (paste into the
  Explorer address bar).

Fix: select the camera, start live preview, trigger again. If `StopCapture done`
appears but no file, check the capture folder + format (SER).

**`RunCapture failed: … No writer object when trying to initialize it`.** The writer
is built by `PrepareToCapture()`, which `RunCapture()` doesn't call itself. Fixed in
**v0.21.10** (the listener now calls `PrepareToCapture()` first). Capture calls are
also marshalled onto SharpCap's WPF dispatcher (v0.21.8) so the UI never freezes.
→ needs the bootstrap auto-download to work (next item).

**`[bootstrap] download failed … Cannot import name WebClient` (stuck on cached
listener).** SharpCap 4.x embeds **CPython (Python.NET)**, which has no
`System.Net.WebClient`, so the download failed and fell back to the old cached
listener. Fixed in **v0.21.9** (downloads via CPython `urllib`). Because a broken
bootstrap can't fetch its own fix, **re-run `install.ps1` once**, then restart
SharpCap — the log should show `[bootstrap] downloaded latest listener from …`.

**`config: failed reading …config.json` / `Expecting value: line 1 column 1`.** The
config has a UTF-8 **BOM** (Windows PowerShell 5.1's `Set-Content -Encoding UTF8`
writes one), which CPython's `json` rejects; the listener falls back to defaults so
a test still works but your saved settings are ignored. Fixed in **v0.21.9** (BOM-free
write + BOM-tolerant read). Re-run `install.ps1` once to rewrite it, or delete it:
`del "$env:LOCALAPPDATA\stp-sharpcap\stp-sharpcap.config.json"`.

**"running scripts is disabled on this system".** Execution policy — see
*install.ps1 switches & the execution-policy story* above.
</details>
