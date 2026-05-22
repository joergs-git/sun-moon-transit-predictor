<#
.SYNOPSIS
    Install / start / update the sun-moon-transit-predictor SharpCap trigger
    listener on Windows. One script for all three.

.DESCRIPTION
    Downloads the latest bootstrap.py and trigger_listener.py from GitHub into
    a local install folder and wires SharpCap to run the bootstrap at startup.
    From then on SharpCap pulls the newest listener from GitHub on every launch
    (no versioning, always-latest), so you normally never re-run this script.

    Re-running this script simply refreshes the bootstrap and the cached
    fallback listener -- i.e. it doubles as the updater.

    The listener runs INSIDE SharpCap's bundled IronPython and uses only the
    standard library, so a separate Python install is NOT required. The
    -InstallPython switch is offered only for users who also want CPython on
    the box for the manual test tooling (the `nc`-style hand test in the
    README); it is off by default.

.PARAMETER Branch
    Git branch to pull from. Default: main. Until the feature PR is merged,
    pass -Branch claude/sharpcap-windows-trigger-DHPcL.

.PARAMETER InstallDir
    Where to place the files. Default: %LOCALAPPDATA%\stp-sharpcap.

.PARAMETER InstallPython
    Also install CPython via winget (only for optional host-side tooling; the
    listener itself does not need it).

.PARAMETER StartSharpCap
    Launch SharpCap after install so the listener comes up immediately.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -Branch claude/sharpcap-windows-trigger-DHPcL -StartSharpCap
#>
[CmdletBinding()]
param(
    [string]$Owner = "joergs-git",
    [string]$Repo = "sun-moon-transit-predictor",
    [string]$Branch = "main",
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "stp-sharpcap"),
    [switch]$InstallPython,
    [switch]$StartSharpCap,

    # --- Machine-local listener settings (written to stp-sharpcap.config.json,
    #     which survives the auto-update). Only the parameters you pass are
    #     changed; re-running without them keeps the existing values. ---
    [string]$SourceDir,          # SharpCap capture folder to watch (subfolders included)
    [string]$DestDir,            # network destination, UNC or mapped drive
    [switch]$EnableTransfer,     # turn the post-capture transfer on
    [switch]$DisableTransfer,    # turn it off
    [switch]$Move,               # move instead of copy
    [switch]$Copy,               # copy instead of move (default)
    [string[]]$Exts,             # extensions to transfer, e.g. .ser,.txt
    [int]$Port,                  # listener TCP port
    [string]$Token               # shared secret (must match predictor's sharpcap.token)
)

$ErrorActionPreference = "Stop"

# GitHub requires TLS 1.2+. Older Windows PowerShell defaults to TLS 1.0.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

$rawBase = "https://raw.githubusercontent.com/$Owner/$Repo/$Branch/scripts/sharpcap"

function Get-File($relName, $destPath) {
    $url = "$rawBase/$relName"
    Write-Step "Downloading $relName"
    Write-Host "    $url"
    Invoke-WebRequest -Uri $url -OutFile $destPath -UseBasicParsing
    Write-Ok "-> $destPath"
}

# ---------------------------------------------------------------------------
# 1. Install folder
# ---------------------------------------------------------------------------
Write-Step "Install folder: $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ---------------------------------------------------------------------------
# 2. Download bootstrap + listener (cached fallback)
# ---------------------------------------------------------------------------
$bootstrapPath = Join-Path $InstallDir "bootstrap.py"
$cachePath     = Join-Path $InstallDir "trigger_listener.cached.py"

Get-File "bootstrap.py" $bootstrapPath
Get-File "trigger_listener.py" $cachePath

# Pin the bootstrap to the branch we installed from so its in-SharpCap
# download targets the same branch (it defaults to main otherwise).
if ($Branch -ne "main") {
    Write-Step "Pinning bootstrap to branch '$Branch'"
    $content = Get-Content -Raw -Path $bootstrapPath
    $content = $content -replace 'BRANCH = "main"', ("BRANCH = `"" + $Branch + "`"")
    Set-Content -Path $bootstrapPath -Value $content -Encoding UTF8
    Write-Ok "bootstrap will pull from '$Branch'"
}

# ---------------------------------------------------------------------------
# 2b. Machine-local config (folders to watch + network destination). Merged
#     so re-running as an updater never wipes paths you set earlier.
# ---------------------------------------------------------------------------
$configPath = Join-Path $InstallDir "stp-sharpcap.config.json"
Write-Step "Local config: $configPath"

# Start from the existing file (so unspecified settings are preserved), or an
# ordered template with sane defaults if this is a first install.
$cfg = [ordered]@{}
if (Test-Path $configPath) {
    try {
        $existing = Get-Content -Raw -Path $configPath | ConvertFrom-Json
        foreach ($p in $existing.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
        Write-Ok "merging into existing config"
    } catch {
        Write-Warn2 "existing config unreadable; rewriting from template"
    }
}
function Set-Default($k, $v) { if (-not $cfg.Contains($k)) { $cfg[$k] = $v } }
Set-Default "port" 9999
Set-Default "token" ""
Set-Default "transferEnabled" $false
Set-Default "sourceDir" "C:\SharpCap Captures"
Set-Default "destDir" "\\NAS\transits"
Set-Default "move" $false
Set-Default "exts" @(".ser")

# Apply only the parameters the user actually passed.
if ($PSBoundParameters.ContainsKey("Port"))    { $cfg["port"] = $Port }
if ($PSBoundParameters.ContainsKey("Token"))   { $cfg["token"] = $Token }
if ($SourceDir)       { $cfg["sourceDir"] = $SourceDir }
if ($DestDir)         { $cfg["destDir"] = $DestDir }
if ($EnableTransfer)  { $cfg["transferEnabled"] = $true }
if ($DisableTransfer) { $cfg["transferEnabled"] = $false }
if ($Move)            { $cfg["move"] = $true }
if ($Copy)            { $cfg["move"] = $false }
if ($Exts)            { $cfg["exts"] = $Exts }

($cfg | ConvertTo-Json -Depth 5) | Set-Content -Path $configPath -Encoding UTF8
Write-Ok ("transfer={0}  source='{1}'  dest='{2}'  move={3}" -f `
    $cfg["transferEnabled"], $cfg["sourceDir"], $cfg["destDir"], $cfg["move"])
if (-not $cfg["transferEnabled"]) {
    Write-Warn2 "Transfer is OFF. Enable + set folders e.g.:"
    Write-Warn2 "  .\install.ps1 -EnableTransfer -SourceDir 'C:\SharpCap Captures' -DestDir '\\NAS\transits'"
}

# ---------------------------------------------------------------------------
# 3. Optional: CPython (NOT needed by the listener; for host-side tooling only)
# ---------------------------------------------------------------------------
if ($InstallPython) {
    Write-Step "Checking for Python (optional host tooling)"
    $havePython = $null -ne (Get-Command python -ErrorAction SilentlyContinue)
    if ($havePython) {
        Write-Ok ("Python already present: " + (python --version 2>&1))
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Step "Installing Python via winget"
        winget install --id Python.Python.3.12 -e --source winget --accept-package-agreements --accept-source-agreements
        Write-Ok "Python installed (restart the shell to pick up PATH)"
    } else {
        Write-Warn2 "winget not found; skipping Python. Install it from https://www.python.org/ if you want the host-side test tooling."
    }
} else {
    Write-Step "Skipping Python install (listener uses SharpCap's IronPython; pass -InstallPython only for optional host tooling)"
}

# ---------------------------------------------------------------------------
# 4. Locate SharpCap (best-effort) and explain the one-time startup wiring
# ---------------------------------------------------------------------------
Write-Step "Locating SharpCap"
$sharpCapExe = $null
$candidates = @(
    (Join-Path ${env:ProgramFiles} "SharpCap\SharpCap.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "SharpCap\SharpCap.exe"),
    (Join-Path ${env:ProgramFiles} "SharpCap 4.1 (64 bit)\SharpCap.exe"),
    (Join-Path ${env:ProgramFiles} "SharpCap 4.0 (64 bit)\SharpCap.exe")
)
foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $sharpCapExe = $c; break }
}
if (-not $sharpCapExe) {
    # Fall back to the uninstall registry, then a shallow Program Files scan.
    try {
        $reg = Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                             "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
               Get-ItemProperty | Where-Object { $_.DisplayName -like "SharpCap*" } | Select-Object -First 1
        if ($reg -and $reg.InstallLocation) {
            $maybe = Join-Path $reg.InstallLocation "SharpCap.exe"
            if (Test-Path $maybe) { $sharpCapExe = $maybe }
        }
    } catch { }
}
if ($sharpCapExe) { Write-Ok "Found: $sharpCapExe" } else { Write-Warn2 "SharpCap.exe not auto-located (that's fine; the manual step below still works)." }

# ---------------------------------------------------------------------------
# 5. One-time SharpCap startup-script wiring (manual; version-robust)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Step "ONE-TIME SETUP IN SHARPCAP"
Write-Host @"
    SharpCap must be told to run the bootstrap at startup. Do this once:

      1. Open SharpCap.
      2. File -> SharpCap Settings -> Startup tab.
      3. Tick 'Run a script when SharpCap starts' and set the script to:

           $bootstrapPath

      4. Make sure your camera is selected and live preview runs, then
         restart SharpCap.

    From then on SharpCap pulls the newest listener from GitHub on every
    start. To update, you do nothing -- just restart SharpCap.

    The trigger listener binds TCP port 9999. Match the predictor's
    config/service.json -> sharpcap.host to this PC's IP.
"@ -ForegroundColor Gray

# ---------------------------------------------------------------------------
# 6. Optional: launch SharpCap now
# ---------------------------------------------------------------------------
if ($StartSharpCap) {
    if ($sharpCapExe) {
        Write-Step "Starting SharpCap"
        Start-Process -FilePath $sharpCapExe
        Write-Ok "SharpCap launched."
    } else {
        Write-Warn2 "Cannot start SharpCap automatically (exe not found). Start it yourself."
    }
}

Write-Host ""
Write-Ok "Done. Files installed in $InstallDir"
