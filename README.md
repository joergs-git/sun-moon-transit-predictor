# sun-moon-transit-predictor
Predicts and detects aircraft transits across the **sun and moon disc** from a
fixed observer location (Rheine, Germany), so the camera at the telescope can
be armed in time. End-to-end runs on a single **Raspberry Pi 5** (Raspberry
Pi OS Lite, 64-bit) alongside `dump1090-fa`, with a small browser UI and
Pushover notifications in two stages: an early candidate alert and a precise
T-minus alert once live ADS-B has nailed down the transit time.

![Plane direction and FOV](/sun-moon-transit-predictor.png) 
![Plane in front of sun](/sun-n-plane.png) 
![Fov projection](/sunplane.png)

## ⚡ Quick start (Raspberry Pi)

**Catch an aircraft — or the ISS — crossing the Sun or Moon, automatically.**
A little Raspberry Pi listens to every plane your antenna can hear, runs the
geometry for *your* exact spot on Earth, and pings your phone (and optionally
fires your camera) in the seconds before one slides across the disc. Set it up
once; it then runs unattended for months, browser-administered, drawing ~5 W.

You need **two cheap parcels** and about 15 minutes:

1. **An ADS-B receiver** — an RTL-SDR USB stick + a 1090 MHz antenna (~€30).
   [Example bundle](https://amzn.eu/d/03rcjsBg)
2. **A Raspberry Pi** (Pi 4 or 5) + microSD card + USB-C power (~€80).
   [Example kit](https://amzn.eu/d/0gSlAqV8)

Then three steps:

```bash
# 1. Flash "Raspberry Pi OS Lite (Legacy, 64-bit)" with Raspberry Pi Imager.
#    In "Edit Settings" set your Wi-Fi + enable SSH, then boot the Pi & SSH in.

# 2. Plug the SDR stick into a USB-2 port (antenna attached), then run:
curl -fsSL https://raw.githubusercontent.com/joergs-git/sun-moon-transit-predictor/main/scripts/bootstrap-pi5.sh | bash

# 3. Reboot once (so the SDR driver takes hold), then open in any browser:
#    http://<your-pi-ip>:8081/
```

That single line installs **everything**: the ADS-B decoder (`dump1090-fa`)
*and* its RTL-SDR driver, Node.js, the predictor service, and a nightly
auto-updater. After that, **everything else lives in your browser** — your
location, your telescope optics, your phone alerts, your capture rigs.

> **Already have an ADS-B feed?** (an existing `dump1090`, a PiAware box, a
> network `aircraft.json`) Skip the receiver install with
> `... bootstrap-pi5.sh | bash -s -- --no-dump1090`, then point `adsb.url` at
> your feed.
>
> **Want zero prompts** (cloud-init / Ansible)? Pass coordinates as env vars —
> see [Install on the Pi](#quick-install-on-the-pi-5).

Everything below is the long-form version: the full shopping list, every
install option, how the prediction works, and the complete reference.

## Overview

```
[ADS-B antenna] → [dump1090-fa]   ─┐
                  aircraft.json    │ poll 2 s
                                   ▼
                            [stp service]
                              tracker   → 300 s (5 min) linear extrapolation
                              geometry  → topocentric Az/El (Sun/Moon)
                              notifier  → 3-stage Pushover (radio→candidate→imminent)
                              store     → SQLite history
                              server    → /api/* + web UI on :8081
                              sharpcap  → optional live capture trigger (Windows) ─┐
                                                                                    ▼
                                                              [SharpCap PC] RunCapture()
                                                              records the transit, optional
                                                              auto-copy of the .ser to a NAS
```

The optional **SharpCap capture trigger** closes the loop from prediction to
imaging: when a transit goes *imminent*, the service fires a TCP trigger to a
listener running inside SharpCap on a Windows capture PC, which starts a
recording framed around the predicted closest approach (configurable pre/post
roll) and can auto-copy the resulting `.ser` to a network drive. Off by
default; see **[SharpCap capture trigger](#sharpcap-capture-trigger-optional)**.

## Hardware + software bill of materials

### Shopping list — the short answer

If you only want the bottom-line "what do I order to make this work",
it is essentially **two parcels**:

**A. A tiny 1090 MHz ADS-B receiver — USB stick + antenna.**
A short, telescopic 1090 MHz antenna plus an RTL-SDR-based USB dongle.
Plugs into the Pi's USB port; the antenna sits anywhere with a clear
view of the sky (a windowsill is usually enough for 100-200 km range).
Example kit, just to anchor the picture in your head:
[RTL-SDR + 1090 MHz antenna bundle](https://amzn.eu/d/03rcjsBg).
Any RTL-SDR (RTL2832U + R820T2 tuner) clone works as long as it decodes
1090 MHz Mode S — the **RTL-SDR Blog v3** is the gold standard if you
want one purchase that you never have to reconsider.

**B. A small Raspberry Pi with a microSD card.**
The matchbox-sized computer that the receiver plugs into. Anything from
a Pi 4 upwards is fine; a **Pi 5 (4 GB)** is the validated host. Needs
a microSD card (16 GB+, endurance grade like SanDisk High Endurance),
a USB-C power supply, and an Ethernet cable *or* your Wi-Fi credentials.
Example:
[Raspberry Pi 5 starter kit](https://amzn.eu/d/0gSlAqV8).

**That's it.** Plug the dongle into the Pi, antenna into the dongle, Pi
into your network, follow the one-liner installer below, and from then
on **everything else lives in your browser** — your observer location,
your telescope optics, your Pushover notification target, your SharpCap
capture rigs. After setup the Pi sits in a corner, draws maybe 5 W, and
runs unattended for months at a time.

#### Why does it have to be local on a Pi at home?

In principle one *could* host this as an internet service, but two
constraints make the Pi-at-home form factor the obvious choice:

1. **You only care about the sky above YOUR observatory.** The maths
   has to run for your exact WGS84 coordinates — an aircraft only
   crosses a 0.5° solar/lunar disc when the geometry from a specific
   ground point lines up. There is no sensible way to time-share that
   computation across multiple users in different cities.
2. **The receiver has to be near the antenna.** 1090 MHz line-of-sight
   covers maybe 200-400 km from a rooftop; the things you can photograph
   from your garden are inside that radius anyway. A Hamburg-based ADS-B
   feed cannot tell you what is crossing the Sun above Munich.
3. **Latency is real.** The pipeline runs every 2 seconds end-to-end,
   from ADS-B fix to "fire SharpCap NOW". Every hop you add to that
   path eats into the < 1-second window when an aircraft is actually
   on disc. Local TCP between a Pi and a Windows capture machine is
   < 5 ms; a public cloud round-trip is 30-100 ms even on a good day.

Hence: small Pi + small dongle + small antenna, on your LAN, near your
telescope. Once installed it is browser-administered and effectively
maintenance-free.

The detailed bills of materials below add the optional + situational
items (active LNA, PoE HAT, external SSD, SharpCap integration, etc.)
for the cases where you want to push the setup further.

### Required hardware

| Item | Notes |
|---|---|
| **Raspberry Pi 5** (4 GB or 8 GB) | The host. Earlier Pi models work too but the v0.7+ tracker tick + browser UI was profiled on the Pi 5. |
| **microSD card** (≥ 16 GB, A1/A2 endurance) | Boot media. SanDisk High Endurance / Samsung PRO Endurance recommended — the SQLite history and lifecycle snapshot write small batches continuously. |
| **USB-C power supply** (5 V / 5 A) | Official Raspberry Pi 5 PSU or equivalent. Skip if you go the PoE route below. |
| **RTL-SDR USB stick** (RTL2832U + R820T2 tuner) | The 1090 MHz ADS-B receiver. The **RTL-SDR Blog v3** is the de-facto standard — clean clock, metal case, bias-T for active antennas. Any clone works as long as it decodes 1090 MHz Mode S. |
| **1090 MHz ADS-B antenna** | A FlightAware 1090 MHz outdoor antenna or any λ/4 mag-mount tuned for 1090 MHz. Sky view = range. |
| **Coax + adapters** | SMA male ↔ whatever your antenna terminates in. Short and shielded — every dB lost on the cable is range lost. |
| **Network** | Ethernet *or* Wi-Fi to a router that can reach the Pi from your browser. The HTTP API is unauthenticated; keep the Pi on a trusted LAN or front it with a reverse proxy. |

### Optional / situational

| Item | When you want it |
|---|---|
| **Waveshare PoE HAT** (or equivalent IEEE 802.3af/at HAT) | If you want **PoE-only operation** — single Ethernet cable provides power *and* network, no USB-C PSU needed. Mounts on the Pi 5's 40-pin GPIO header. Verify the HAT's spec matches the Pi 5 power budget (≥ 5 V/5 A continuous including ADS-B-stick draw). |
| **Active LNA** (Uputronics / RTL-SDR Blog) at the antenna feedpoint | Pulls weaker / further aircraft out of the noise; powered via the RTL-SDR's bias-T. Only worth it if you're seeing < 200 km range. |
| **1090 MHz bandpass / SAW filter** | Cuts strong out-of-band signals (FM broadcast, cellular) that can desensitise the RTL. Often built into the LNAs above. |
| **Active cooling case** (Argon ONE V3, Pi 5 official cooler, etc.) | The Pi 5 throttles under sustained load; the tracker tick is light but if you co-host other services you'll want active cooling. |
| **External USB-C SSD** | Move `data/history.db` and `data/lifecycle.json` off the SD card by symlinking the `data/` directory. Massively extends SD-card life for multi-year deployments. |
| **Pushover account** ([pushover.net](https://pushover.net)) | Phone notifications for the three transit stages. The pipeline runs fine without it (`pushover.enabled=false`), but you'll only see transits in the web UI. |
| **Windows PC running [SharpCap](https://www.sharpcap.co.uk/)** + camera | Only if you want the predictor to *automatically start a capture* the moment a transit goes imminent (too tight a window — often < 30 s — for SharpCap's own Sequencer). Runs a tiny stdlib-only Python listener inside SharpCap (4.x uses embedded **CPython**, not IronPython — the listener is portable across both); the Pi triggers it over TCP. Multi-rig: drive several scopes/PCs in parallel via `sharpcap.targets[]`. See **[SharpCap capture trigger](#sharpcap-capture-trigger-optional)**. Off by default. |
| **Waveshare 4.2" B/W e-paper panel** (SPI, 400×300) | A **browserless** physical readout — clock, location, live count and the soonest Real candidates (ETA, altitude, speed, distance, angle) plus Sky-now + an FOV preview. Plugs onto the Pi's 40-pin header (SPI, **not** I2C). Configured entirely from the web Settings panel; can also be driven from a **remote** predictor over the LAN. See **[E-paper display](#-e-paper-display-optional-v0310)**. Off by default. |

### Required software (installed by `scripts/install-pi5.sh`)

| Item | What it does |
|---|---|
| **Raspberry Pi OS Lite, 64-bit — *Legacy* (Bullseye)** | **Use the Legacy image.** In Raspberry Pi Imager: *Choose OS → Raspberry Pi OS (other) → "Raspberry Pi OS Lite (Legacy, 64-bit)"*. This is the **known-good** image — the current (Bookworm) Lite image caused dependency/version trouble with the ADS-B + Node stack during bring-up. Set hostname, SSH key and Wi-Fi in the Imager's "Edit Settings" before flashing for a zero-touch first boot. |
| **`dump1090-fa`** (FlightAware) | The ADS-B decoder for the RTL-SDR / AirNav FlightStick — exposes `aircraft.json` on `http://localhost:8080/data/aircraft.json` (polled every 2 s). **Not** in the default repos — but the `bootstrap-pi5.sh` one-liner installs it **by default** (skip with `--no-dump1090`). Manual steps: **[ADS-B receiver setup](#ads-b-receiver-setup-dump1090-fa--airnav-flightstick)** below. |
| **Node.js 22+** | Runtime. Pulled from NodeSource by the installer if absent. Needs `--experimental-sqlite` on Node 22; stable on Node 24+. |
| **`git`** | Not on a fresh Pi OS Lite image — `sudo apt-get install -y git` first (the `bootstrap-pi5.sh` one-liner does this for you). |
| **This repo** (`sun-moon-transit-predictor`) | `git clone https://github.com/joergs-git/sun-moon-transit-predictor.git` — contains `bin/stp.js`, the systemd units in `systemd/`, the install + auto-update scripts in `scripts/`, the web UI in `web/`. |

### Optional external services

| Item | What you get |
|---|---|
| **adsbdb.com** (no account needed) | IATA flight numbers, origin / destination airports, airline names attached to every candidate. Used live for the tracking panel and Pushover payload, cached for 1 h per callsign. Skip with `routes.enabled=false`. |
| **OpenSky Network** account (free) | Optional schedule augmentation: backfills the predictor's watchlist with flights you may not have seen yourself yet. Configured via `scripts/refresh-schedule.js`. Off by default. |
| **AirNav On-Demand API v2** (paid, token) | Optional rich airframe + live route + **photo** for an aircraft. Paste the bearer token from `airnavradar.com/api/dashboard` into **⚙ Settings → AirNav Radar API** (stored masked in `service.json`, **server-side only** — the browser uses our `/api/acinfo` proxy). **Each upstream call is billed in credits**, so it is fetched **only** on an explicit row click (FOV box) or a flight-number hover, and cached per airframe for the session (static data 6 h, live 60 s). Off until a token is set. |

## ADS-B receiver setup (dump1090-fa + AirNav FlightStick)

**The [Quick start](#-quick-start-raspberry-pi) one-liner already does all of
this for you** — `bootstrap-pi5.sh` installs `dump1090-fa` + the RTL-SDR
driver by default. This section is the manual reference: what those steps
actually are, for troubleshooting or if you ran with `--no-dump1090`.

The **AirNav RadarBox / AirNav ADS-B FlightStick** is a standard RTL-SDR
(RTL2832U + R820T2, built-in 1090 MHz SAW filter) — it needs **no special
driver**, just `dump1090-fa` from FlightAware's apt repo. Plug the
FlightStick into a **USB-2** port (USB-3 ports are RF-noisy at 1090 MHz),
antenna attached, then:

```bash
# 1. FlightAware apt repo + the decoder (pulls in rtl-sdr automatically).
#    NOTE: the repo-package version (here 1.3) bumps occasionally — if this
#    404s, check the directory listing at
#    https://www.flightaware.com/adsb/piaware/files/packages/pool/piaware/f/flightaware-apt-repository/
#    or use the official installer: flightaware.com/adsb/piaware/install
sudo apt-get update
wget -O /tmp/fa-repo.deb \
  https://www.flightaware.com/adsb/piaware/files/packages/pool/piaware/f/flightaware-apt-repository/flightaware-apt-repository_1.3_all.deb
sudo dpkg -i /tmp/fa-repo.deb && rm /tmp/fa-repo.deb
sudo apt-get update
sudo apt-get install -y dump1090-fa

# 2. Stop the DVB-T kernel driver grabbing the stick (idempotent; harmless
#    if dump1090-fa already did it). Then reboot so it takes effect.
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf
sudo reboot
```

After the reboot it runs as a systemd service (`dump1090-fa`) on port
**8080**. Verify — **do not start the app until this returns aircraft**
(needs sky view + planes overhead):

```bash
systemctl status dump1090-fa --no-pager
curl -s localhost:8080/data/aircraft.json | head -c 300   # JSON with "aircraft":[…]
# or open  http://<pi-ip>:8080/  (SkyAware map) in a browser
```

**Gain:** leave the dump1090-fa default — the FlightStick's built-in
filter makes AGC work well out of the box. Only if range is poor, tune
`--gain` in `/etc/default/dump1090-fa` then
`sudo systemctl restart dump1090-fa` (no other experiments needed). The
app's `adsb.url` default (`http://localhost:8080/data/aircraft.json`)
already matches this — nothing to configure on the app side.

> **Sidenote — sharing to AirNav RadarBox (`rbfeeder`).** Optional and
> fully independent of this predictor. `rbfeeder` + your AirNav sharing
> key runs alongside `dump1090-fa` (reads the same decoder) and uploads to
> airnavradar.com; this app only ever needs the local `aircraft.json` on
> :8080, so the two don't interfere. **MLAT active** = the feeder's
> *multilateration* client is up: for Mode-S aircraft that do **not**
> broadcast their own GPS position, several internet-connected stations
> jointly compute the position from the signal's time-difference-of-arrival.
> It needs a **precise station location** — use the **same WGS84 decimal
> degrees** you put in `config/observer.json` so the feed and the
> predictor agree.

## Quick install on the Pi 5

The [Quick start](#-quick-start-raspberry-pi) at the top is all most people
need. This section is the full reference: every flag, the manual path, and
the zero-touch first-boot recipe.

Recommended OS image: **Raspberry Pi OS Lite (Legacy, 64-bit)** — see the
[Required software](#required-software-installed-by-scriptsinstall-pi5sh)
note above; the Legacy image is the validated one. Set hostname, SSH key
and Wi-Fi in the Imager's "Edit Settings" before flashing.

### From a blank image (one-liner bootstrap)

On a fresh OS with nothing installed yet, `scripts/bootstrap-pi5.sh`
installs the apt prerequisites (`git`, `curl`, `ca-certificates`),
`dump1090-fa` + the RTL-SDR driver (the ADS-B data source — **on by
default**), clones the repo, and hands off to `install-pi5.sh` (forwarding
all remaining flags + `STP_*` env vars). Review it first — piping a remote
script to a shell runs code as you:

```bash
curl -fsSL https://raw.githubusercontent.com/joergs-git/sun-moon-transit-predictor/main/scripts/bootstrap-pi5.sh | bash
# zero-touch (coordinates via env, no prompts):
curl -fsSL .../scripts/bootstrap-pi5.sh | STP_LAT=52.28 STP_LON=7.44 STP_ELEV=50 bash -s -- --non-interactive
# bring-your-own ADS-B feed (skip the dump1090-fa install):
curl -fsSL .../scripts/bootstrap-pi5.sh | bash -s -- --no-dump1090
```

`dump1090-fa` is the ADS-B **data source** — without it (and `--no-dump1090`
with no replacement feed) the predictor has no aircraft to track. A reboot
after the bootstrap is recommended so the DVB-T blacklist takes effect.

### Manual install (no bootstrap)

Raspberry Pi OS Lite has **no `git`** out of the box — install it first
(the bootstrap one-liner above does this for you):

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/joergs-git/sun-moon-transit-predictor.git
cd sun-moon-transit-predictor
bash scripts/install-pi5.sh
```

`install-pi5.sh` (idempotent — safe to re-run after every `git pull`):

1. installs Node.js 22 from NodeSource if it isn't already present,
2. runs `npm install --omit=dev`,
3. prompts for observer coordinates + Pushover credentials and writes
   `config/observer.json` + `config/service.json` with the **current
   defaults** (both **gitignored** so `git pull` / the auto-updater can
   never overwrite them),
4. installs and starts the `stp.service` systemd unit (light sandboxing —
   `ProtectSystem=strict`, `ReadWritePaths=…/data`),
5. unless `--no-auto-update`: installs `stp-update.timer` (nightly) +
   `stp-update.path` (version-badge click-to-update) + the narrow sudoers
   rule,
6. **always** installs `stp-tle.timer` (daily ISS TLE refresh) and does one
   initial TLE fetch, so the ISS feature is active out of the box.

After it finishes, browse to `http://<pi-ip>:8081/`. Logs:
`journalctl -u stp.service -f`.

Re-running the script keeps existing config files. Useful flags:

| Flag | Effect |
|---|---|
| `--overwrite`        | Re-prompt for everything; rewrite both config files. |
| `--non-interactive`  | Zero prompts; reads defaults from env vars (see below). Pairs well with cloud-init / Ansible / first-boot scripts. |
| `--no-auto-update`   | Skip the nightly `stp-update.timer` install. |

### Zero-touch first-boot install

For a true zero-interaction setup, drop credentials in env vars and let the
installer write everything in one shot:

```bash
STP_LAT=52.2833 \
STP_LON=7.4406 \
STP_ELEV=50 \
STP_GEOID_M=46 \
STP_PUSHOVER_TOKEN=azGD…  \
STP_PUSHOVER_USER=uQiR… \
bash scripts/install-pi5.sh --non-interactive
```

The full env-var list is in the script's header (`bash scripts/install-pi5.sh --help`).

## Service control (systemd)

The installer registers `stp.service` as a systemd unit and starts it. From
then on it auto-restarts on failure and comes back after a reboot. The
day-to-day commands:

```bash
# status / start / stop / restart
sudo systemctl status   stp.service
sudo systemctl start    stp.service
sudo systemctl stop     stp.service
sudo systemctl restart  stp.service

# enable / disable autostart on boot
sudo systemctl enable   stp.service
sudo systemctl disable  stp.service

# logs (live tail and last hour)
journalctl -u stp.service -f
journalctl -u stp.service --since "1 hour ago" --no-pager
```

After editing `config/observer.json` or `config/service.json`, restart the
service so the changes are picked up:

```bash
sudo systemctl restart stp.service
```

To remove the unit (without uninstalling Node or the repo):

```bash
sudo systemctl disable --now stp.service
sudo rm /etc/systemd/system/stp.service
sudo systemctl daemon-reload
```

## Updating the service

### Auto-update is on by default

**What triggers an update?** Every commit pushed (or merged) to the
`main` branch on `github.com/joergs-git/sun-moon-transit-predictor`. The
Pi tracks `origin/main` directly — GitHub *Releases* / tags are *not*
required and are ignored. Latency: up to 24 hours (the next 03:30 timer
firing). To pull immediately, see *Manual update* below.

The installer drops `scripts/auto-update.sh` plus a systemd timer
(`stp-update.timer`) that fires nightly at **03:30 ± 15 min**. Each run:

1. **Backs up** `config/observer.json` and `config/service.json` to a temp
   dir (defensive — even if upstream renames or .gitignores them, your
   per-site setup survives).
2. `git pull --ff-only` (no merges, no force).
3. **Restores** the configs if anything changed underneath them.
4. Runs `npm install --omit=dev` only if `package.json` / lockfile moved.
5. Restarts `stp.service` only if backend code (`src/`, `bin/`,
   `package*.json`, `systemd/stp.service`, `config/service.example.json`)
   changed. Frontend-only commits don't restart — the browser picks them
   up on the next refresh.

The restart is graceful (~5 s downtime; SIGTERM → flush SQLite → exit →
systemd respawn). No interactive prompt, no SSH session needed, no manual
intervention on the Pi.

Inspect / probe / disable:

```bash
# what's scheduled and when next?
systemctl list-timers | grep stp-update

# run an update right now (same code path the timer uses)
sudo systemctl start stp-update.service
journalctl -u stp-update.service -n 50 --no-pager

# turn the auto-updater off without touching the main service
sudo systemctl disable --now stp-update.timer
```

### Click-to-update from the web UI (v0.8.1)

The small version badge next to the page title is clickable. Clicking it
(after a confirm dialog) makes the service **pull `origin/main` and restart**
— no SSH needed.

Security model — the unauthenticated LAN UI never gets a shell:

* `POST /api/update` only **drops a trigger file** (`data/update.request`);
  it runs no `git`/`systemctl`. A confirmed JSON body is required, which
  also blocks naive cross-site drive-by triggering (the request needs a
  CORS preflight this server does not answer).
* A privileged **`stp-update.path`** systemd unit watches that file and
  fires the same `stp-update.service` the nightly timer uses. The updater
  deletes the trigger on start, so a single click can't loop it.
* `update.debounceMs` (default 30 s) swallows double-clicks / two clients.
* Take it out entirely with `"update": { "enabled": false }` in
  `config/service.json`, or `sudo systemctl disable --now stp-update.path`.

```bash
# is the click-to-update watcher active?
systemctl status stp-update.path --no-pager
```

#### Troubleshooting: "I click the version, confirm, but nothing updates"

The endpoint only **drops a trigger file** — the actual `git pull` +
restart is done by the privileged `stp-update.path` → `stp-update.service`
units. Nothing happens if that watcher isn't running:

* **It's a no-op on non-systemd hosts** (e.g. a macOS dev box). Click-to-
  update is a Pi/Linux feature; test it on the Pi, not the laptop.
* **`stp-update.path` not installed/enabled on the Pi.** The unit was added
  in v0.8.1. `auto-update.sh` (nightly / code update) does **not** install
  systemd units, so a Pi set up before v0.8.1 and only code-updated never
  got it. One-time fix on the Pi:

  ```bash
  cd ~/sun-moon-transit-predictor
  bash scripts/install-pi5.sh           # idempotent; installs + enables stp-update.path
  systemctl is-active stp-update.path   # → active
  ```

Since v0.10.1 the UI no longer fails silently: after you confirm, the line
under the title reports **requested → consumed (restarting…)**, or, if no
watcher consumes the trigger within ~12 s, **"stuck — stp-update.path not
installed/enabled (run scripts/install-pi5.sh)"**. The nightly updater also
logs this warning to `journalctl -u stp-update.service`.

### Manual update

The same script is safe to run on demand:

```bash
cd ~/sun-moon-transit-predictor
bash scripts/auto-update.sh
```

Or the long form, which is what `auto-update.sh` automates:

```bash
git pull --ff-only
npm install --omit=dev          # only if package.json changed
sudo systemctl restart stp.service
journalctl -u stp.service -n 30 --no-pager
```

### Frontend-only updates

Files in `web/` are served live from disk by the Node process — no build
step, no bundling. After a pull, a hard browser refresh (`Ctrl+Shift+R`) is
enough; `systemctl restart` is not needed for HTML / JS / CSS-only changes.
The auto-updater detects this and skips the restart.

### What is preserved across updates

`config/observer.json` and `config/service.json` are **gitignored**. They
are written once by the installer and never overwritten by `git pull`,
`auto-update.sh`, or a re-run of the installer (use `--overwrite` to force).
The schema reference lives at `config/observer.example.json` and
`config/service.example.json` — diff your real files against those when a
release notes a new field.

### One-time migration from v0.1.x → v0.2.0

Earlier versions tracked `config/observer.json` in git. Pulling v0.2.0+ on
top of an older checkout will refuse with
`error: Your local changes ... would be overwritten by merge` (which is
git protecting your real coordinates). Run this exact sequence once, on
each existing Pi, the first time you update:

```bash
cd ~/sun-moon-transit-predictor

# 1. Back up the real coords (still intact on disk)
cp config/observer.json /tmp/observer.json.bak

# 2. Reset the working-tree file to HEAD so the pull's deletion can apply
git checkout -- config/observer.json

# 3. Pull — succeeds now and removes the old tracked file
git pull --ff-only

# 4. Restore the real config; observer.json is now gitignored, so git
#    will never touch it again
cp /tmp/observer.json.bak config/observer.json
rm /tmp/observer.json.bak

# 5. Verify
cat config/observer.json

# 6. Re-run the installer. Your config is kept (no prompts) — the only
#    new artefact is the nightly auto-update timer + sudoers fragment.
bash scripts/install-pi5.sh

# 7. Sanity check
systemctl status stp.service
systemctl list-timers | grep stp-update
curl -s http://localhost:8081/api/health
node scripts/test-push.js          # optional: confirm Pushover end-to-end
```

After this one-time step, **every subsequent push to `main` rolls onto the
Pi automatically** the next night via `auto-update.sh`, with the same
backup/restore guard built in. You will never need to repeat steps 1–4.

### Push-driven updates (GitHub webhook)

Webhooks require an inbound HTTPS endpoint, which a typical home Pi behind
NAT does not expose. Workable patterns if you need near-real-time updates:

- a public reverse tunnel (Cloudflare Tunnel, Tailscale Funnel, ngrok)
  pointing at a tiny webhook receiver on the Pi that runs `auto-update.sh`,
  or
- a GitHub Actions job that opens an SSH tunnel via Tailscale and runs
  `bash scripts/auto-update.sh` on the Pi after each merge to `main`.

For a hobby setup the bundled nightly timer is almost always enough.

## Pushover setup & test push

A fresh checkout has **no `config/service.json`** — only
`config/service.example.json`. Without a service config the Pushover client
runs in disabled mode (`enabled: false`) and silently no-ops every send.
That's safe for first-boot but means *nothing will alert* until you
provide credentials.

### 1. Provide credentials

`scripts/install-pi5.sh` prompts for your Pushover **application token** and
**user key** the first time it runs and writes them into
`config/service.json`. To re-do it later:

```bash
bash scripts/install-pi5.sh --overwrite
```

Or edit `config/service.json` directly:

```json
"pushover": {
  "token":   "azGD…<your app token>",
  "user":    "uQiR…<your user/group key>",
  "device":  "",
  "enabled": true,
  "minStage": "radio",
  "radioThresholdDeg": 1.0
}
```

`device` is optional — leave empty to fan out to every device on the
account. `minStage` controls which stages dispatch at all
(`radio` = all, `imminent` = only the ±30 s alert). `radioThresholdDeg`
adds a tighter Pushover-only filter on top: the tracker still surfaces
matches inside `tracker.looseThresholdDeg` (2° by default) to the
tracking panel, but the phone only buzzes when the projected minimum
separation is at or below this value (default **1°** — i.e. only
flights likely to actually graze the body). Restart the service
(`sudo systemctl restart stp.service`) after editing, or use the
**Settings** panel in the web UI for hot-reload.

### Alert learning

The UI surfaces a rolling 14-day stats panel showing how well the
early-warning radio stage predicts the tight transits that actually
matter. Each history row gets one of three outcome tags:

- **graduated** — radio alert paid off: the flight later reached
  candidate or imminent.
- **faded** — radio alert never tightened up: false positive of the
  early stage.
- **surprise** — candidate or imminent fired with *no* prior radio
  warning. Useful to spot under-detected geometries.

Headline numbers in the panel:

- **hit rate** = `radioGraduated / radioFired` — how often a radio
  alert was worth paying attention to.
- **surprise rate** = `surprises / (graduated + surprises)` — how
  often we missed an early heads-up for a transit that actually
  fired.

Same data is available raw via `GET /api/learning?windowDays=…`.

### 2. Send a test push

A small helper ships in `scripts/test-push.js`. It loads the live
`config/service.json` and sends a single low-priority message via the same
`PushoverClient` the notifier uses, so it verifies token, user key,
network, and TLS in one shot.

```bash
node scripts/test-push.js
node scripts/test-push.js "custom message"      # optional payload
```

Expected output: `pushover: sent (status=1, request=…)`. The push should
land on every Pushover-equipped device within a couple of seconds. If the
config is disabled or missing keys, the script prints `pushover: disabled`
and exits 1 without contacting the API.

### 3. Verify in production

To confirm the live service can actually reach Pushover (not just the
helper), tail the journal while temporarily lowering `thresholdDeg` in
`config/service.json` to a wide value (e.g. `30`) and restarting — the next
overhead aircraft will then trip both an early and a precise notification.
Restore the threshold afterwards:

```bash
sudo systemctl restart stp.service
journalctl -u stp.service -f | grep -iE 'push|notif'
```

## Web UI

`http://<host>:8081/` ships a single-page UI with two panels:

- **Sky now** — current Sun/Moon Az/El with the observability flag.
- **Tracking** — the unified lifecycle list (see *Candidate lifecycle*
  above). One row per `(icao, body)` or `(flight, body)`, sorted by status
  urgency then ETA. Status pill on the left with the icon (📅 📡 ✈️ 🎯 ❌);
  whole-row tint for `imminent` / `candidate` so urgent rows draw the eye.
  Polls `/api/state` every 2 s — rows transition status in real time as
  the tracker sees them appear, converge, and (sometimes) drop.
- **History** — paginated list backed by `/api/history`, showing every
  persisted notification (radio + candidate + imminent stages) with
  Transit time, callsign, IATA flight, origin / destination, body, minimum
  separation, altitude and speed.

### FOV preview pane (v0.7.1+)

Top right of the page, beside **Sky now**, sits a permanent FOV
preview pane (originally a click-to-open modal, v0.6.0). It auto-shows
the most recently spotted live candidate whose minimum angular
separation is under **1°** — i.e. visually close enough to actually
intersect or graze the body — and refreshes on every 2 s state poll.
Clicking a row in **Tracking** or **History** pins that entry into the
pane (an orange bar marks the pinned row); the pin is released as soon
as a newer qualifying live candidate (sep < 1°) arrives. Press
**Escape** at any time to drop the pin and resume auto-tracking.

The sketch itself shows:

- **FOV rectangle** sized to the optical setup configured in
  **Settings** (default 500 mm + ZWO ASI174MM → FOV ≈ 1.30° × 0.82°);
  changes take effect on the next poll, no reload needed.
- **Sun / Moon disc** centred at the body's apparent diameter
  (Sun 0.53°, Moon 0.52°).
- **Aircraft silhouette** scaled by line-of-sight distance using a
  generic ~36 m airliner footprint — at 10 km this works out to
  ~0.2°, roughly a third of the Sun's diameter.
- **Apparent transit line** (dashed) connecting five samples of the
  aircraft–body relative position at ±60, ±30 and 0 s around closest
  approach, with an arrowhead in the direction of motion. Body drift
  is subtracted per sample, so the line shows the path as seen through
  a tracking mount keeping the disc centred.

The sketch is built client-side from a small `transitPath` array that
the tracker attaches to every `TransitCandidate`. History rows written
before v0.6.0 can still be pinned, but without the motion line (the
disc + aircraft anchor point are derived from the existing
`payload_json`).

### Settings panel (v0.7.0+)

The header now exposes a `⚙ Settings` button that opens an in-browser
form for the three configuration areas you actually touch in the field:

- **Observer** — name, latitude, longitude, elevation, plus optional
  temperature and pressure for the refraction model.
- **Pushover** — app token, user key, device, master enable + minimum
  stage. Token and user key are stored on the Pi but **never echoed
  back in plaintext** — `GET /api/config` returns them as
  `••••<last4>` so a page reload (or a forgotten browser tab) cannot
  leak the secret. Leaving the masked value untouched on save keeps
  the existing credentials.
- **Telescope & sensor** — focal length, sensor width/height in mm,
  pixel count, and a free-text sensor name. The FOV preview pane picks
  the new optics up on the next state poll, no reload needed.
- **Tracker** — `horizonS`, `thresholdDeg`, `looseThresholdDeg`,
  `minAltitudeM`, `minBodyElevationDeg` (v0.30.37+). All hot-reload.
- **AirNav Radar API** — bearer token (masked after save).
- **SharpCap capture trigger** — toggle, host/port for the main rig,
  per-rig list (`targets[]`) with body / pre-buffer / post-buffer /
  maxSepDeg / minElevationDeg overrides. Hot-reload + `Test trigger`
  button per rig.

(The dump1090-status link in the header is hardcoded to `http://<host>:8080/`
since v0.15.2 — the configurable "External links" field that used to be
here was removed in M46.)

Saved changes hot-reload the running service in place and are written
back to `config/observer.json` + `config/service.json` so the next
restart (including the nightly auto-update timer) keeps the new
values.

> **Upgrading from a pre-v0.7.0 install:** older `stp.service` units
> only listed `data/` under `ReadWritePaths`, so saving from the
> Settings panel fails with `EROFS: read-only file system`. Refresh
> the systemd unit on the Pi with one of:
>
> ```bash
> # Option A — re-run the installer (preserves existing configs):
> bash scripts/install-pi5.sh --non-interactive
>
> # Option B — drop-in override, no reinstall needed:
> sudo systemctl edit stp.service        # opens an empty override
> # Paste these three lines, save and exit:
> #   [Service]
> #   ReadWritePaths=
> #   ReadWritePaths=/home/<user>/sun-moon-transit-predictor/data \
> #                  /home/<user>/sun-moon-transit-predictor/config
> sudo systemctl daemon-reload
> sudo systemctl restart stp.service
> ```
>
> Hot-reload of the in-memory state still works even when the disk
> write fails — the Settings panel just shows the actionable hint as a
> warning so you see exactly what to fix.

### Tracking-list persistence across restarts (v0.7.0+)

The unified tracking panel is snapshotted to `data/lifecycle.json`
every 30 s and on `SIGTERM`. On startup the file is read back so the
panel does not appear empty after the auto-update timer restarts the
service overnight. Entries whose predicted closest-approach time is
already more than 10 minutes in the past are dropped on load to keep
the panel meaningful; restored live entries are marked `stale` until
the next tick reaffirms them.

**What is persisted, what is not.** The History panel reads from
`<repo>/data/history.db` (SQLite, see `src/store.js`), which is written
**server-side every time the notifier dispatches a stage** — both `early`
and `precise` rows. Closing the browser does not lose anything; the next
load (even days later) re-reads the same DB file. What is **not** written
is the live "candidate" stream (`/api/state.candidates`) — those rows are
recomputed in memory each tick and only graduate to the DB if they trip a
notification. If you want every detected near-miss persisted, you would
need to call `store.recordEvent` from the tracker tick rather than only
from the notifier — happy to add that as a config switch if useful.

## 🖥️ E-paper display (optional, v0.31.0)

A standalone client that drives a **Waveshare 4.2" B/W SPI e-paper panel**
(400×300) on the Pi 5 for a **browserless** at-a-glance readout — no browser, no
monitor needed:

A fixed three-paragraph layout with large, legible body text:

- **Header** (two lines) — big bold **clock** + **date** on line 1; **place** +
  **GPS** on line 2
- **Nearest plane** — the nearest tracked plane in detail, with **ETA** and
  **SEP** as the big bold headline figures and route/bearing/distance/altitude/
  speed small underneath, plus a large **FOV preview** on the right
- **Sky-now + aircraft** — Sun/Moon **elevation** (left) and the tracked
  **aircraft** with big **SEP** / **ETA** per plane (right); the aircraft
  heading carries a **(candidates / total live)** counter

Planes come from the unified live-tracking list, so the panel keeps showing
nearby traffic even when nothing is a Real candidate.

The client lives in `display/` and carries no logic of its own — it polls the
predictor's `/api/state`, so it can render data from **this Pi or a remote Pi on
the LAN**.

### Configured entirely from the browser

Open ⚙ **Settings → E-paper display** and the client picks the changes up live
(within a few seconds, no restart):

| Setting | Meaning |
|---|---|
| **Enabled** | Master on/off. Off → the panel clears once and idles. |
| **Data source URL** | Blank = this Pi (localhost). Set a LAN URL like `http://192.168.1.50:8081` to drive a **local** panel from a **remote** ADS-B/Node host. |
| **Quick refresh (s)** | Partial-refresh cadence — fast, flash-free text update. Default 2, floor 1. |
| **Long refresh (s)** | Full-refresh cadence — the periodic brief flash that clears e-paper ghosting. Default 60, must be ≥ Quick. |

The on-panel layout itself is fixed (the three paragraphs above) — there are no
list-length or compact toggles.

#### Audio buzzer (optional)

A piezo buzzer wired between a **GPIO pin (default GPIO13)** and **GND** gives an
audible transit countdown — driven by `display/buzzer.py` in the same client (no
extra service), configured from ⚙ **Settings → Audio / buzzer**. The client
always **PWM-drives** the pin, so it works for both **passive** (needs a
frequency) and **active** (beeps on power) buzzers — no need to know which you
have. Confirm yours and find the loudest tone with
`cd display && python3 epaper_client.py --test-buzzer` (2000 Hz is the default).
A **Test signals** button in Settings plays the whole sequence once on the Pi.
Defaults: **3 × 0.1 s** when a new Real candidate comes within **2 min**,
**1 × 1.5 s at 1000 Hz** (a distinct tone) when one is lost/passes, an
accelerating countdown for candidates within `0.3°` — every **10 s** from 40 s,
**5 s** from 15 s, **2 × 0.05 s** every **2 s** from 8 s — then a single **5 s
blast** from 2 s before the transit. Beep length, count, frequency, intervals
and windows are all adjustable in Settings. See
**[display/README.md](display/README.md#audio-buzzer-optional)**.

> **E-paper isn't a video display.** A full refresh flashes for a couple of
> seconds; a partial refresh is quick (~0.3–0.5 s) but builds up ghosting. The
> two-cadence design (quick partial + periodic full clear) gives a lively yet
> clean panel; ~1–2 s is the practical floor for the quick refresh.

### Quick install (Pi 5)

> **SPI, not I2C** — the 4.2" panel plugs onto the 40-pin header and talks SPI.
> The Pi 5's new GPIO needs Waveshare's **gpiozero/lgpio** driver (the old
> `RPi.GPIO` does not work on the Pi 5).

**Easiest — let the installer do everything** (enables SPI, installs the Python
panel libraries, adds the spi/gpio groups, installs + enables the service):

```bash
# fresh box, with the panel, in one line:
curl -fsSL https://raw.githubusercontent.com/joergs-git/sun-moon-transit-predictor/main/scripts/bootstrap-pi5.sh | bash -s -- --with-display

# already have the repo:
bash scripts/install-pi5.sh --with-display
```

Then **reboot once** (so SPI + group membership take effect) and turn the panel
on in the web UI: ⚙ **Settings → E-paper display → Enabled → Save**.

<details><summary>Manual install (if you'd rather not use the flag)</summary>

```bash
# 1. Enable SPI, then reboot.
sudo raspi-config nonint do_spi 0 && sudo reboot

# 2. Python deps + group access for the panel.
pip3 install -r display/requirements.txt
sudo usermod -aG spi,gpio "$USER"

# 3. Install + start the service (fills in install dir + user).
sudo cp systemd/stp-display.service /etc/systemd/system/
sudo sed -i "s|__INSTALL_DIR__|$(pwd)|g; s|__USER__|$USER|g" /etc/systemd/system/stp-display.service
sudo systemctl daemon-reload
sudo systemctl enable --now stp-display.service

# 4. Turn it on in the web UI: ⚙ Settings → E-paper display → Enabled → Save
journalctl -u stp-display -f
```
</details>

Full wiring table, the **two-Pi (remote source)** setup, the `--dry-run`
hardware-free preview and troubleshooting are in
**[`display/README.md`](display/README.md)**.

## ISS transits (v0.9.0)

The International Space Station is predicted alongside aircraft and shown in
**LIVE-TRACKING-SIGNALS**, **History** and the **FOV preview**, in front of
both the Sun and the Moon, with its own cyan highlight + 🛰 badge (and a
small station glyph instead of an aircraft silhouette in the sketch).

* **Offline, dependency-free.** Position comes from an embedded **SGP4**
  propagator (`src/sgp4.js`, validated against the official Spacetrack
  #3 / Vallado *88888* verification vectors) applied to a local TLE file —
  the running service never touches the network for this.
* **The TLE.** The feature stays inactive ("no ISS info" in Sky-now) until
  `data/iss.tle` exists. Since v0.10.3 `scripts/install-pi5.sh` does an
  initial fetch **and** installs a daily **`stp-tle.timer`** (05:40 ± 20 min,
  Persistent) — so on a normal Pi install ISS info just appears and stays
  fresh. Re-run `install-pi5.sh` once if you upgraded from < v0.10.3.

  ```bash
  # see / force a refresh:
  systemctl list-timers | grep stp-tle
  node scripts/refresh-tle.js          # → data/iss.tle (Celestrak, CATNR 25544)
  systemctl start stp-tle.service      # same, via the timer's unit
  ```
  An ISS TLE older than ~3 days noticeably degrades transit timing; the
  daily timer keeps it current. No network at install time? The timer
  retries — or run the command above once you're online.

* **Tuning** (`config/service.json → iss`): `horizonMs` (how far ahead to
  scan for the next Sun/Moon transit, default **14 days** — these are weeks
  apart at a fixed site; raising it costs more CPU per recompute since the
  scan is O(horizon)), `visibleHorizonMs` (next-visible-pass cap, default
  **30 days**; cheap — the scan returns at the first pass found),
  `recomputeMs` (scan cadence, default 10 min), `thresholdDeg` /
  `looseThresholdDeg`. Set `"enabled": false` to switch it off entirely.
* An ISS transit is written to History like any transit and feeds the
  **Disc xing** column (its angular rate is huge, so the full-disc crossing
  time is well under a second).
* **Pushover (v0.10.0).** ISS transits ride the same notifier path as
  aircraft, so you get a heads-up the moment a Sun/Moon transit is
  predicted (and again ±30 s before). Titles read `🛰 ISS Sun transit
  predicted …`. Disable per the usual `pushover` settings if unwanted.
* **Next visible pass (v0.10.0).** The Sky-now panel shows the next
  naked-eye ISS pass for the site — station above 20°, sky dark (Sun below
  −6°, "after dusk") and the ISS sunlit (offline cylindrical Earth-shadow
  test). It is a *visibility* line, independent of any disc transit.
* **Alert-learning** hit/surprise/graze rates are an ADS-B-traffic quality
  signal and therefore *exclude* ISS rows (a deliberately-hunted orbital
  event would otherwise skew them); the ISS still appears in the History
  table itself.

### Good to know — ISS transit prediction is only reliable a few days out

SGP4 propagated from a TLE drifts roughly **1–3 km/day cross-track** (more
after a reboost). The ISS transit *centre line* is only a few km wide and
the Sun/Moon disc is 0.5°, so a transit predicted **> ~3 days** ahead is
essentially noise: it appears, then **vanishes after the next daily TLE
refresh** (and a different phantom may appear). This is physics, not a bug.

Consequences in this tool (v0.10.9+):

* A transit only fires **Pushover** and gets a **History** row once it is
  within `iss.notifyWithinMs` (default **3 days / 72 h**) — close enough
  that SGP4+TLE is trustworthy. This stops phantom-transit alert spam and
  the "⚡ surprise" pollution it caused in the learning stats.
* The Sky-now **"Next ISS Sun/Moon transit"** line still *previews* the
  soonest predicted transit even weeks out, but anything beyond the notify
  window is shown **flagged "tentative — refines with each daily TLE"**.
  So Sky-now saying "none in the next N days" while an old, now-stale row
  sits in History is expected — they reflect *different TLEs* at different
  times, each correct for its own.
* **Visible passes** (the other Sky-now line) are unaffected — they recur
  ~daily and the *next* one is near, so it stays accurate.
* Want it sooner/later anyway? Tune `iss.notifyWithinMs` in
  `config/service.json`. Reliable horizon for sub-disc accuracy is roughly
  **≤ 48–72 h**; keep the TLE fresh (the daily `stp-tle.timer`).

### Good to know — observer coordinates & elevation

* `latitudeDeg` / `longitudeDeg` are **decimal degrees, WGS84** (e.g.
  `52.2870`, `7.4223`). There is **no aviation-vs-astronomy datum
  difference** — ADS-B, AirNav and this tool all use WGS84. The same point
  just has several notations; mixing them up is the usual confusion:
  * `52°17'13.7"N` = degrees-minutes-**seconds** → `52 + 17/60 + 13.7/3600`
    = **52.2871°** decimal.
  * `52.1714` is **not** decimal degrees — it is the packed
    aviation/NMEA "degrees + decimal-minutes" form (`52°17.14'`) ≈
    **52.2857°**. Putting that into `latitudeDeg` lands you ~13 km off.
  Use the **decimal** form (your phone GPS / Google-Maps right-click at the
  antenna gives it directly), and use the **same** value for the rbfeeder
  /AirNav station so the feed and the predictor agree.
* `elevationM` is the **WGS84 ellipsoidal height of your site** — in
  practice your local **height above sea level is fine** (the geometry is
  robust to a few tens of metres of observer height). It is **not** "height
  above ground" and **not** the antenna's height over the roof — just the
  site elevation (Rheine ≈ 40–50 m), never `0`.
* `geoidUndulationM` is a *separate* field: EGM2008 N at the site (Rheine
  ≈ **+46 m**). It only corrects aircraft *barometric* altitude (≈ MSL) to
  ellipsoidal before the geometric comparison — it is **not** applied to
  your own elevation. Set it (~46 for Rheine) for the best aircraft-
  altitude accuracy; `0` is tolerable.

### Good to know — how far can you actually see an aircraft, and the elevation rule

There is **no single hard distance**. How far a plane stays usable depends on
its size, how the Sun lights it (a sunlit fuselage or a contrail carries far
further than a shaded belly), the ground visibility (aerosol / humidity haze)
and the atmospheric seeing on the day.

Rule of thumb for **clear North-German air**, for *good visual recognition of
the airframe* (wings, engines, type) — **not** mere detection:

* **8–10× binoculars:** the airframe shape is clearly recognizable out to
  roughly **30–40 km slant distance**, and the type is still guessable to
  **~20–25 km**. *Mere* detection of a jet or its contrail reaches much
  further — **60–80 km+**.
* **Small telescope at ~40–80×:** more geometric detail (~**30–50 km**), but
  it is **turbulence-limited** — at low elevation the unsteady air smears the
  image before haze ever does.

**Why elevation dominates everything.** Both the slant distance to a cruising
airliner (~11 km altitude) *and* the amount of hazy, turbulent air you look
through scale with `1 / sin(elevation)`. The slant range is simply
`R = h / sin(el)`. Below **~20°** the line of sight grazes the worst — the
haziest, most turbulent low air — and clouds often sit right on the horizon.
**≥ 30°** is the practical sweet spot; **≥ 45°** is best.

This is why the predictor (**v0.15.0**):

* shows a **3-state visibility traffic-light** per row — **red below 30°**,
  **amber 30–45°**, **green ≥ 45°** (aircraft elevation at closest approach);
* by default only sends **Pushover** notifications when the target is
  **≥ 30° elevation** (configurable via `pushover.minElevationDeg`; set `0`
  to disable the gate). The **ISS is exempt** — it has its own 15° visibility
  gate. **History and all statistics still record everything**, regardless of
  the notify gate.

| Elevation | Slant range @ ~11 km | Rel. air mass | Visual usability |
|---|---|---|---|
| 20° | ~32 km | ~2.9 | usable but shimmery, weak contrast |
| 30° | ~22 km | ~2.0 | practical entry point — much steadier |
| 45° | ~15.5 km | ~1.4 | very good |
| 60–90° | 11–13 km | ~1.0–1.15 | optimal (also best for transit photos) |

## Predictive watchlist (24 h preview)

The live tracker only sees `tracker.horizonS` seconds into the future
(default **300 s = 5 min** since v0.23.4, linear ADS-B extrapolation).
The **predictor** complements it with a 24 h preview built
from past transits: any `(flight, body)` pair that hit ≥ 2 distinct days in
the last 14 produces a watchlist entry, and the next expected occurrence is
surfaced in `state.expected`. The "Expected today" panel in the web UI
renders this list as `ETA · Time · Body · Flight · Seen · Days · Spread`.
"Spread" is the standard deviation of the observed time-of-day across days
— think of it as a confidence proxy: `±5m` means the flight is reliably on
schedule, `±45m` means highly variable.

Defaults (override under `predictor` in `config/service.json`):

| Key                  | Default          | Meaning |
|---|---|---|
| `enabled`            | `true`           | Master switch. |
| `daysBack`           | `14`             | History window scanned for repeats. |
| `minRepeats`         | `2`              | Min number of distinct UTC days an entry must hit. |
| `bucketMinutes`      | `60`             | Time-of-day binning width — coarse enough to absorb day-to-day jitter, fine enough that the median predicted time is meaningful to ~1 h. |
| `rebuildIntervalMs`  | `3600000` (1 h)  | Cadence for re-scanning the history table. |
| `lookAheadMs`        | `86400000` (24 h)| Window into the future the predictor surfaces. |

The predictor is **fully local** — it reads only `data/history.db` and
needs no external API. The watchlist warms up over the first 1–2 weeks of
operation as the same scheduled flights repeat. Entries decay automatically
as observations age out of `daysBack`.

## Schedule augmentation (OpenSky, optional)

For faster watchlist warm-up, or coverage of flights your local ADS-B
receiver missed (offline, low signal, terrain-shadowed), you can pull
historical arrivals + departures from
[OpenSky Network](https://opensky-network.org/) at airports near you and
feed them into the predictor as additional observations.

Off by default. Enable with two changes in `config/service.json`:

```json
"opensky": {
  "enabled": true,
  "airports": ["EDDF", "EDDL", "EHAM"],
  "lookbackDays": 7
}
```

(Or set `STP_OPENSKY_AIRPORTS=EDDF,EDDL,EHAM` before running the
installer in `--non-interactive` mode — the script writes the section for
you and flips `enabled`.)

Then run the fetcher manually to populate `data/history.db`:

```bash
node --experimental-sqlite scripts/refresh-schedule.js
```

Output:

```
[EDDF] arrival   day -0: 142 flights
[EDDF] departure day -0: 138 flights
…
refresh-schedule done: inserted=1840 skipped(no body)=120 pruned=0
```

`pruned` removes rows older than `lookbackDays` so the table stays bounded.
The job is **idempotent** — re-running over the same window inserts zero
new rows (`UNIQUE(source, flight, timestamp_ms)` constraint).

For nightly automation, drop a unit + timer pair next to the existing
auto-update timer (the runner is `node scripts/refresh-schedule.js`).
Anonymous OpenSky has a generous 4000 req/day quota; one nightly run for
3–5 nearby airports is well under that limit.

**Caveat.** OpenSky tells us *that* a flight existed at a given airport,
not *whether it overflew our observer*. The predictor groups observations
by `(flight, body, time-of-day)`, so an arriving flight at FRA at 11:00 UTC
becomes a "11:00 ± 1 h Sun watchlist entry" — useful as a heads-up, but
your local ADS-B history remains the ground truth for transit timing.
Don't enable OpenSky if you only fly low priority on accuracy and want
fewer false-positive watchlist entries.

## SharpCap capture trigger (optional)

Closes the loop from *prediction* to *imaging*. An aircraft transit gives you
seconds, not minutes, of warning — far too tight to arm SharpCap's own
Sequencer by hand. Instead the predictor pushes a trigger to a small listener
running **inside SharpCap** the moment a transit goes `imminent`, and SharpCap
records a clip framed around the predicted closest approach.

```
predictor (Pi/Linux)                     Windows capture PC
────────────────────                     ─────────────────────────────────────
notifier emits 'imminent'  ── TCP :9999 ▶ trigger_listener.py (in SharpCap)
src/sharpcap.js sends one JSON line       RunCapture() after preRoll,
                                          StopCapture() after the window,
                                          optional auto-copy of the .ser → NAS
```

- **Predictor side:** ⚙ **Settings → SharpCap capture trigger** — toggle on,
  set the Windows host + port, the pre-/post-roll (default −10 s / +10 s around
  the transit), the minimum elevation and a "push on trigger" option, then hit
  **Test trigger (2 s)**. Hot-reloads and persists to `config/service.json`
  (`sharpcap` block). Off by default.
- **Windows side:** a one-shot PowerShell installer sets up a bootstrap that
  pulls the latest listener from GitHub on every SharpCap launch, plus an
  optional post-capture copy/move of the `.ser` to a network drive. The
  listener uses stdlib only (`socket`, `threading`, `json`, `time`,
  `subprocess`, `shutil`), runs on whatever Python SharpCap embeds (CPython
  in 4.x; IronPython in older builds — both work), so **no separate Python
  install** is needed.

**Multi-rig (v0.24+, fixed v0.30.1).** Drive several telescopes/PCs at
once via `sharpcap.targets[]`. Each entry runs its own listener on its
own `host:port`, inherits the shared knobs, overrides per-rig fields
(`bodies`, `maxSepDeg`, buffers…). A Sun candidate arms only Sun rigs,
a Moon candidate only Moon rigs — independent dedup + re-arm state per
rig. The top-level `sharpcap.{host,port,…}` block is auto-promoted to
its own implicit "main" rig when `targets[]` is populated (suppressed
only on host:port collision).

**Rich filename tagging (v0.30.32+).** The listener renames the source
`.ser` ON THE LOCAL SSD with all known meta tags before the (often
multi-minute, multi-GB) NAS upload starts:

```
HH_MM_SS_Sun_p9999_4080e9_BER-LHR_sep021.ser
         │   │    │      │       │
         │   │    │      │       └─ predicted sep 0.21 deg
         │   │    │      └─────────── origin → destination
         │   │    └────────────────── ICAO 4080E9 (lowercase)
         │   └─────────────────────── port (which rig)
         └──────────────────────────── body
```

**Outcome verdict (v0.30.33+).** ~60 s after the lifecycle entry
finishes, the predictor sends a `type:"outcome"` packet. The listener
appends `_confirmed` (entry reached imminent stage) or `_probempty`
(entry faded before imminent — recording most likely shows empty sky)
plus `_finalsepNNN` (drift at end) to the same file ON THE SSD, then
the NAS upload uses the final tagged name. The 60 s wait gives a 20 GB
upload time to settle without racing the rename.

Full Windows install, the one-time SharpCap startup-script wiring, the
machine-local folder config, the wire-format and a hand-test recipe live in
**[`scripts/sharpcap/README.md`](scripts/sharpcap/README.md)**.

## Candidate lifecycle (planned → radio → candidate → imminent → stale)

Every `(icao, body)` entry the service tracks goes through up to four
**status** transitions during its lifetime. They show up in the UI as a
single dynamic list — the user requested an "approach radar"-style flow
rather than two disjoint tables — and the notifier turns three of them
into Pushover messages:

| Status | Trigger | Push priority | Typical lead time |
|---|---|---|---|
| **planned** 📅 | predictor watchlist (recurring history) says a flight is expected within `lifecycle.plannedWindowMs` (default 1 h) | none (UI only) | minutes to hours |
| **radio** 📡 | tracker projects `[thresholdDeg, looseThresholdDeg]` separation (default 0.3°–2°) within `horizonS` (default 15 min) | 0 | up to ~15 min |
| **candidate** ✈️ | tracker projects `≤ thresholdDeg` separation (default 0.3°) within `horizonS`, more than `imminentWindowMs` away | 0 | 30 s – ~15 min |
| **imminent** 🎯 | closest approach within ±`imminentWindowMs` (default ±30 s) | 1 | ≤ 30 s |
| **stale** ❌ | was tracked last tick, gone from the tracker output now — first **coasts** on its last status for ~25 s (brief ADS-B gap), then held as `stale` until the **30-min** grace (`lifecycle.staleGraceMs = 1800000`) expires or the panel cap displaces it | none (UI only) | — |

Stage rules:

- **Subsumption.** Higher stages "consume" the lower ones — an aircraft
  that appears directly on the line of sight fires `candidate` (or
  `imminent`) on the first sighting and does *not* retroactively emit
  `radio`. Each stage fires at most once per `(icao, body)` per detection
  cycle, then dedupes for 5 min before forgetting state.
- **Subscription control.** `pushover.minStage` (default `radio`) is the
  earliest stage that may push. Set to `candidate` to silence the wide-net
  early-warning stage if it gets too chatty; `imminent` for "alert me only
  at the last 30 s".
- **What goes into SQLite.** Only `radio`, `candidate` and `imminent` are
  persisted to `transit_history`. `planned` is regenerated from the
  watchlist each tick; `stale` is a UI-only display state.
- **Coasting.** A single missed ADS-B squitter no longer flips a contact
  to `stale`: it holds its last live status for `lifecycle.coastMs`
  (default 25 s) before decaying, so a flight doesn't visibly drop and
  reappear near the horizon.
- **Panel cap & stale grace.** The tracking list is capped at
  `lifecycle.maxEntries` (default **10**). A `stale` entry is dropped once
  it is older than `lifecycle.staleGraceMs` (default **1 800 000 ms =
  30 min**) or, on a busy minute, when the cap displaces it (oldest stale
  first, FIFO by `lastUpdateMs`; active rows are always kept). Set
  `staleGraceMs: 0` to revert to the old cap-only eviction (stale entries
  persist until pushed off the bottom).

Each notification carries: callsign, IATA flight number (if adsbdb resolves
it), airline, origin/destination, altitude (ft), ground speed (kt), minimum
separation, transit duration, ETA. Same payload is recorded in the SQLite
history table.

### Tuning the live look-ahead

`tracker.horizonS` (default **300 s = 5 min** since v0.23.4 / M62; was
900 s before but linear extrapolation degrades fast for descending /
turning approach traffic, so the 15-min horizon produced too many
speculative candidates that fired a radio alert then faded) is the
window the live tracker linearly extrapolates each aircraft over.
Clamped to `[10, 1800]` in code. Typical settings:

| Use case | `horizonS` | What you get |
|---|---|---|
| Maximum precision | 60 | First-detection at ~T-60 s; lowest false-positive rate. |
| **Default** | **300** | First-detection at ~T-5 min; few false-positives; SharpCap arms ~95 s out anyway, a Pushover 1–2 min ahead is ample warning. |
| Conservative | 600 | First-detection at ~T-10 min; more "faded" false-positives but earlier heads-up. |
| Wide net | 1800 | First-detection at ~T-30 min (upper clamp); maximum lead, most noise. |

`tracker.looseThresholdDeg` (default **2°** since v0.7.4; was 5° in
v0.1–v0.7.3) is the **radio band** width — anything wider is dropped from
the tracking panel entirely. Editable in the Settings UI under the
**Tracker** fieldset. Set to the same value as `thresholdDeg` to disable
the radio stage and fall back to the old two-stage flow. The Pushover
phone-buzz threshold (`pushover.radioThresholdDeg`, default 1°) is a
separate, tighter filter on top of this.

## How the prediction works

Every poll cycle (default every 2 s) the service answers one question:

> *Which aircraft, currently visible to the local ADS-B receiver, will line
> up between my observer location and the Sun or Moon disc within the next
> 300 seconds (5 min) — while that body sits above the observability floor?*

1. **Sky position.** Topocentric Az/El of the Sun and Moon are computed for
   the configured observer (WGS84, refraction-corrected). Bodies below the
   observability floor (default **20°**, auto-widened down to the lowest
   enabled rig's `minElevationDeg` since v0.30.37, hard-floored at 5°) are
   flagged `observable: false` and skipped — the floor keeps obstructions,
   haze, and refraction residuals out of the budget.
2. **Aircraft position.** Each aircraft from `dump1090-fa`'s `aircraft.json`
   is converted WGS84 → ECEF → ENU into Az/El relative to the same observer,
   using `alt_geom` (fallback `alt_baro`) as MSL. ADS-B `seen_pos` latency is
   back-stamped onto the actual fix time, so the projection starts from when
   the position was sampled, not from "now".
3. **Forward projection.** Position and velocity are linearly extrapolated
   on the local tangent plane in 0.5 s steps across the next 300 s
   (5 min default; clamped to `[10, 1800]` via `tracker.horizonS`).
4. **Separation test.** Great-circle angular separation between the
   predicted aircraft Az/El and the body's Az/El is computed at each step.
   When the *minimum* separation across the trajectory drops below
   `thresholdDeg` (default 0.3°; the Sun's disc is ~0.27° wide), the
   aircraft becomes a **transit candidate** with closest-approach time,
   minimum separation, and transit duration.
5. **Three-stage pipeline.** Each match is classified by its projected
   minimum separation and time-to-closest: **radio** (inside the wide
   panel band, `looseThresholdDeg`, default 2° — early warning),
   **candidate** (inside the tight band, `thresholdDeg`, default 0.3°)
   and **imminent** (closest approach within ±30 s). A Pushover fires once
   per stage, deduplicated per `(icao, body)`; the phone has its own
   tighter filter (`pushover.radioThresholdDeg`, default 1°) so it stays
   quiet on the widest band.

The browser UI and the SQLite history give you the same view after the
fact. Since v0.8.0 the History is logged at the full panel band
**independent of the Pushover phone filter** — the early `radio` row is
recorded even when the phone deliberately stays silent, so the `Lead`
column (Transit − Recorded) reflects the true advance warning. Each row
carries callsign, IATA flight, origin / destination, minimum separation,
ETA, altitude and ground speed.

**Headless on the Pi.** The detection loop runs inside `stp.service` on
the Pi 24/7 — the polling interval, geometry, transit search, Pushover
dispatch and SQLite write are all server-side. The browser UI is **just a
viewer** for state the service has already computed; closing the tab does
not pause anything and never causes a missed transit. The Pi can run
without a monitor, keyboard, or any client connected.

## End-to-end pipeline reference

This section unpacks the per-tick logic so the "what is computed when"
question has a single answer to point at. The five-step summary above is
the user-facing version; the layout below is the engineering view.

### 1. Data sources

| Source | What | Refresh | Module |
|---|---|---|---|
| `dump1090-fa` (local) | `aircraft.json` (live ADS-B) | **every 2 s** | `adsb.js` |
| `astronomy-engine` | Sun/Moon ephemerides | **recomputed every tick** (no cache) | `geometry.js` |
| `data/history.db` | dispatched Pushovers | **rebuilt hourly** into the watchlist | `predictor.js` + `store.js` |
| `adsbdb.com` | IATA flight, route, airline | per candidate, **1 h positive cache, 5 min negative** | `adsbdb.js` |

### 2. The 2-second tick (`service.js → tick()`)

The main heartbeat. Each pass executes the following in order:

**a) Coarse Sun/Moon trajectory** — `tracker.js → sampleBodyTrajectory`. Az/El
for each tracked body is computed across the next `horizonS` seconds
(default 300 s = 5 min look-ahead, lowered from 900 s in v0.23.4 because
linear extrapolation degrades fast past ~5 min) at `stepS` resolution
(default 0.5 s), yielding **601 Az/El samples per body** per tick.
Geometric (no refraction) to match the aircraft side, which is also
un-refracted.

**b) Coarse aircraft route vector** — `tracker.js → extrapolate`. Each
ADS-B contact is linearly extrapolated from `lat/lon/altMmsl` using
`groundSpeedMs` + `trackDeg`, anchored at `receivedAtMs` (the actual sample
time of the position, **not** "now" — this back-stamps ADS-B latency).
WGS84 → ECEF → ENU → Az/El, same 0.5 s grid over 300 s, **601 Az/El points
per aircraft**.

**c) Pairwise separation scan**. For every (aircraft × body) pair the
angular separation is computed at every one of the 1801 sample indices and
the minimum is remembered. A candidate is emitted when:

* `min sep ≤ tracker.thresholdDeg` (default 0.3°) → `level = candidate`
* `min sep ≤ tracker.looseThresholdDeg` (default 2°) → `level = radio`
* otherwise the pair is dropped entirely (never reaches the panel).

**d) Sub-step refinement — the fine route vector** — `tracker.js →
parabolicVertex`. The grid step is 0.5 s, but a transit can land between
two samples. A parabola is fitted through the three separation values
`(i-1, i, i+1)` around the minimum; the analytic vertex gives a
fractional-step refinement of both the closest-approach **time** and the
**minimum separation**. Net effect: timing is accurate to a few tens of
milliseconds despite the coarser sampling grid — far cheaper than running
the grid at 0.05 s.

**e) FOV path sampling** — `tracker.js → sampleTransitPath`. For the
FOV-preview sketch the tracker emits 21 dense samples at
`[-5, -4.5, …, +5] s` around closest approach. Pre-v0.7.6 used 5 samples at
`±60 s` which, at typical airliner angular speeds, produced a misleading
V-line through the disc.

**v0.30.19+ initial-guess overlay.** The lifecycle entry now also stores
`initialCandidate` — the very first emission's geometry — frozen across
all subsequent ticks. The FOV sketch paints this in **grey under the
white current path**, so the user can see at a glance how much the
prediction has drifted between first contact and now. A stable cruise
flight shows the two paths overlapping; a drifting approach traffic
shows two distinct paths.

**v0.30.21+ prediction-drift mini-chart.** Top-right inset in the FOV
widget: a small line plot of predicted-sep-over-time, with line
segments coloured by sep value (green when the projection is in disc
range, red when far). Surfaces the convergence story visually — a
healthy prediction's line trends down + green, a drifting one hooks
up + red as it approaches ETA.

**f) Route lookup** — `adsbdb.js`. Each candidate's callsign is enriched
with `flight / origin / destination / airline` via adsbdb.com. Hits are
cached for 1 h, misses for 5 min, so a flight is queried at most once per
hour across the entire service lifetime.

**g) Lifecycle merge** — `lifecycle.js → updateLifecycle`. Three inputs are
folded into a single `Map<key, LifecycleEntry>`:

1. **Live tracker candidates** (highest signal — actual ADS-B geometry)
2. **Watchlist** (predictor.js, the *flight-schedule* source — see below)
3. **Previous tick's map** (so `stale` entries linger — coasting through
   brief ADS-B gaps — and the FIFO 10-cap / 30-min stale grace age out
   displaced rows in order of `lastUpdateMs`)

Per-row status is derived from `(level, time-to-closest, presence)`:

* `imminent` — `level=candidate` AND closest-approach within
  `±lifecycle.imminentWindowMs` (default 30 s)
* `candidate` — `level=candidate` outside the imminent window
* `radio` — `level=radio` (in the loose band, outside the tight band)
* `planned` — comes from the watchlist; no live ADS-B match yet
* `stale` — was active on a previous tick, no longer in tracker output;
  coasts on its last status for ~25 s, then held until the 30-min stale
  grace expires or the 10-row cap displaces it (oldest stale first)

**h) Notifier dispatch** — `notifier.js → tick`. For each candidate, the
next un-sent stage is evaluated. Stages escalate monotonically
`radio → candidate → imminent`. Pushover dispatch on `radio` carries an
**extra filter**: only fires when projected sep ≤ `pushover.radioThresholdDeg`
(default 1°). The panel-band knob (`tracker.looseThresholdDeg`, default 2°)
and the Pushover knob are independent — you can show 2° in the UI but only
buzz the phone at 1°. Per-`(icao, body, stage)` dedup; state is forgotten
5 min after closest approach. Every dispatched event writes one row to
`transit_history`.

### 3. Slower periodic processes

| Job | Cadence | Code |
|---|---|---|
| **Watchlist rebuild** (the "flight schedule" source) | **hourly** | `predictor.js → buildWatchlist` reading `transit_history` |
| **Lifecycle snapshot** → `data/lifecycle.json` | every **30 s** + on `SIGTERM` | `service.js → snapshotLifecycle` |
| **ISS transit + visible-pass recompute** | every **10 min** (`iss.recomputeMs`) | `iss.js` (SGP4 over `data/iss.tle`) |
| **Nightly auto-update** (`git pull` + restart) | once per night (03:30 ±15 min) | `stp-update.timer` → `scripts/auto-update.sh` |
| **Click-to-update** (version badge) | on demand | `stp-update.path` watches `data/update.request` → `stp-update.service` |
| **Daily ISS TLE refresh** | once per day (05:40 ±20 min) | `stp-tle.timer` → `scripts/refresh-tle.js` |
| **OpenSky schedule augmentation** (optional) | at watchlist-rebuild time | `opensky.js` + `scripts/refresh-schedule.js` |

### 4. The watchlist (flight-schedule source) in detail

There is no external schedule API. Instead `transit_history` itself is the
input:

1. The last `predictor.daysBack` days (default 14) of dispatched events are
   reduced to `{flight, body, timestampMs}` tuples.
2. Tuples are bucketed by `(flight, body, time-of-day)` at
   `predictor.bucketMinutes` granularity (default 60 min).
3. A bucket graduates to a watchlist entry once it has hit at least
   `predictor.minRepeats` distinct UTC days (default 2) — i.e. the pattern
   has repeated.
4. The median time-of-day inside each bucket becomes the predicted
   `expectedTimeOfDayMs`; the standard deviation across observations is
   surfaced as `stdevMs` (confidence marker — small spread = tight
   schedule, wide spread = ad-hoc).
5. `upcomingExpected()` filters the watchlist to "next occurrence inside
   `predictor.lookAheadMs`" (default 24 h). The lifecycle merge then
   promotes anything inside `±lifecycle.plannedWindowMs` (default 1 h) to a
   `planned` row in the tracking panel.

### 5. Persistence + outcome classification

| Artefact | Written when | Used for |
|---|---|---|
| `transit_history` (SQLite) | when a stage is first entered inside the panel band (v0.8.0: independent of the Pushover phone filter, so the `radio`-stage row is logged and `Lead` reflects the true advance warning) | History panel, watchlist source, episode classification |
| `lifecycle.json` (JSON) | every 30 s + on `SIGTERM` | Tracking panel survives restarts (entries coast through brief ADS-B gaps, v0.8.0) |
| `config/observer.json` + `service.json` | on Settings save | Hot-reload + survive restart |

**Episode classification** runs lazily on `/api/learning` and `/api/history`
reads — see `store.js → episodes()`. History rows that share
`(icao, body)` and whose `closest_at_ms` values fall within ±5 min are
grouped into one *episode*. The set of stages it contains determines the
outcome label:

* `radio` AND (`candidate` OR `imminent`) → **graduated** (early warning paid off)
* `radio` only → **faded** (false positive of the early stage)
* `candidate` OR `imminent` with no prior `radio` → **surprise** (we missed the build-up)

### 6. Frontend poll cadences

The HTTP API is stateless (the service is the source of truth), so the
browser is pure pull:

| Endpoint / job | Interval | Why |
|---|---|---|
| Wall-clock readout in the header | 1 s | self-corrects from `Date.now()` each tick |
| `GET /api/state` (Sky now, Tracking, FOV pane) | 2 s | matches the tick |
| `GET /api/history` (history rows + outcomes) | 15 s | history only grows on Pushover dispatch |
| `GET /api/learning` (stats cards) | 60 s | aggregates change at the rate of new episodes |

Closing the tab pauses nothing — the service keeps running and the next
load picks up wherever it left off, including the restored tracking list.

### 7. Design principles

* **Linear aircraft extrapolation** stays meter-accurate to ~60 s and is
  reasonable through ~10 min in stable cruise; well past 15 min the
  assumption breaks (turns, ATC vectoring, wind). `horizonS=900` (15 min)
  is the default — a compromise between catching a flight as it enters
  ADS-B range and the false-positive ("faded") rate; the upper clamp at
  1800 s exists so a typo in `service.json` can't blow up the per-tick
  CPU budget.
* **Un-refracted geometry on both sides**. The tracker compares Az/El of
  the aircraft (raw ECEF→ENU) against Az/El of the body (geometric, no
  refraction). Refraction is only applied at the "Sky now" display step so
  the user sees what they would actually observe through the eyepiece.
* **Parabolic-vertex refinement instead of a finer grid**. Halving `stepS`
  from 0.5 s to 0.05 s would cost ~5× more samples per tick; the vertex
  fit gets the same sub-tenth-of-a-second timing precision for a handful
  of multiplications.
* **Geoid offset for barometric altitudes only**. ADS-B `alt_geom` (GNSS)
  is already WGS84 ellipsoidal height; `alt_baro` (pressure altitude) is
  closer to MSL. The geoid undulation (≈46 m around Rheine) is only added
  to barometric sources, preventing a systematic 46 m / ~0.05° offset.
* **Service is single source of truth**. The browser UI is a viewer. Tab
  close, browser crash, or laptop sleep never miss a transit — the
  pipeline keeps running on the Pi and the next page load reflects the
  full server state.

## Configuration

### `config/observer.json` (see `observer.example.json`)

```json
{
  "name": "Rheine",
  "latitudeDeg": 52.2833,
  "longitudeDeg": 7.4406,
  "elevationM": 50.0,
  "geoidUndulationM": 46.0
}
```

`elevationM` is the observer's WGS84 ellipsoidal height (a local MSL value
within ~50 m is fine). `geoidUndulationM` is the EGM2008 N at the observer
location — used only when an aircraft reports `alt_baro` (pressure
altitude, ≈MSL); the offset is added so the geometric comparison happens in
the right reference frame. Look up your local N at e.g.
[unavco.org/software/geodetic-utilities](https://www.unavco.org/software/geodetic-utilities/geoid-height-calculator/).
Default 0 is fine if you only see GPS-equipped aircraft (`alt_geom`).

### `config/service.json` (see `service.example.json`)

```json
{
  "adsb":     { "url": "http://localhost:8080/data/aircraft.json", "pollIntervalMs": 2000 },
  "tracker":  { "horizonS": 300, "stepS": 0.5, "thresholdDeg": 0.3, "looseThresholdDeg": 2.0, "bodies": ["Sun", "Moon"] },
  "pushover": { "token": "...", "user": "...", "enabled": true },
  "server":   { "port": 8081, "host": "0.0.0.0", "publicUrl": "" },
  "store":    { "path": "./data/history.db" },
  "routes":   { "enabled": true, "ttlMs": 3600000, "negativeTtlMs": 300000 },
  "display":  { "enabled": false, "sourceUrl": "", "quickRefreshS": 2, "longRefreshS": 60 }
}
```

`display` configures the optional [e-paper panel](#-e-paper-display-optional-v0310)
client — edit it from the web Settings panel rather than by hand; the Python
client reads it live from `/api/config`.

For the complete list of currently-supported fields (`sharpcap.targets[]`,
`tracker.minAltitudeM`, `tracker.minBodyElevationDeg`, `iss.*`,
`predictor.*`, `lifecycle.*`, `update.*`, `driftPersist.*`,
`lifecyclePersist.*`, `display.*`, etc.) refer to
[`config/service.example.json`](config/service.example.json) — that
file is kept in sync with the installer defaults.

`thresholdDeg` (default 0.3°) is the maximum line-of-sight separation that
triggers a candidate — the Sun's angular radius is ~0.27°, so 0.3° catches
near-misses too. `stepS` (default 0.5 s) is the sample step the tracker
walks across the look-ahead horizon; the closest-approach time is then
sub-step refined with a parabolic vertex fit, so this only sets the lower
bound on detection coverage, not the time precision of the alert.

## HTTP API

The service exposes a small JSON API and serves the web UI on the same
port (default `8081`, bind host `0.0.0.0`). Replace `<host>` below with the
Pi's hostname or IP address — for example `http://raspberrypi.local:8081/`
or `http://192.168.1.42:8081/`.

| Method & path              | Description |
|---|---|
| `GET /`                    | Web UI (live state + history table). |
| `GET /api/state`           | Current observer, Sun/Moon Az/El + observability, aircraft count, `lifecycle[]` (unified per-`(icao, body)` tracking list with status enum, M11 — primary feed for the new UI), plus `candidates[]` (live tracker output, backward compat), `expected[]` (history-based 24 h watchlist, backward compat) and `optics` (current FOV setup). Refreshed every poll. |
| `GET /api/history?limit=…` | Past notifications (radio / candidate / imminent stages) from SQLite, newest first. Default 100, max 500. Each row now also carries `outcome` (`graduated` / `faded` / `surprise` / `null`) computed across the episode it belongs to — see *Alert learning* below. |
| `GET /api/config`          | Sanitised view of the runtime config used by the Settings panel: observer, masked Pushover credentials (incl. the notification `url`), optics, tracker, AirNav. Pushover token + user key come back as `••••<last4>` so the page never echoes the secret in plaintext. |
| `POST /api/config`         | Apply a partial config update (`{ observer, pushover, optics, tracker, airnav }`). Hot-reloads the running service in place and persists changes back to `config/observer.json` + `config/service.json`. Masked secret placeholders (`••••…`) are ignored so a no-op resave never overwrites the real token. |
| `GET /api/learning?windowDays=…` | Rolling alert-effectiveness stats over the requested window (default 14 days, capped at 90). Returns aggregates (`radioFired`, `radioGraduated`, `surprises`, `hitRatePct`, `surpriseRatePct`, …) plus the last 20 classified episodes. |
| `GET /api/hourstats?sepDeg=…&minElevationDeg=…&windowDays=…` | "Best hours" — 24-bin hour-of-day histogram of the *usable* hits (imminent-confirmed, `sep < sepDeg` default 0.5°, elevation ≥ `minElevationDeg` default 30°), split per body in **observatory-local time** (hour of `closest_at_ms`). Returns `perBody.{Sun,Moon}[24]`, `total[24]`, `n` and `peak.{Sun,Moon,all}` (`{hour,count}`/`null`). Retrospective; `windowDays` default 3650, capped at 3650. |
| `GET /api/health`          | Liveness probe — always returns `{ ok: true, time: <ISO> }`. |

Responses are `Cache-Control: no-store`; no authentication, so keep the
service on a trusted LAN or front it with a reverse proxy if you need to
expose it publicly.

### Example calls

```bash
# liveness
curl -s http://<host>:8081/api/health
# → {"ok":true,"time":"2026-05-11T12:00:00.000Z"}

# current sky + active candidates
curl -s http://<host>:8081/api/state | jq

# last 20 dispatched notifications
curl -s 'http://<host>:8081/api/history?limit=20' | jq '.events[]'

# open the live UI in a browser
xdg-open http://<host>:8081/        # Linux
open     http://<host>:8081/        # macOS
```

### Sample `/api/state` response (abbreviated)

```jsonc
{
  "observer":     { "name": "Rheine", "latitudeDeg": 52.2833, "longitudeDeg": 7.4406, "elevationM": 50 },
  "nowMs":        1762870000000,
  "lastUpdateMs": 1762869998000,
  "aircraftCount": 17,
  "bodies": {
    "Sun":  { "azimuthDeg": 178.4, "elevationDeg": 42.1, "rangeM": 1.5e11, "observable": true  },
    "Moon": { "azimuthDeg":  65.2, "elevationDeg": -8.7, "rangeM": 3.8e8,  "observable": false }
  },
  "candidates": [
    {
      "icao":                "3c6589",
      "callsign":            "DLH4PV",
      "body":                "Sun",
      "minSeparationDeg":    0.18,
      "closestApproachAtMs": 1762870042000,
      "transitDurationS":    1.4,
      "altitudeFt":          37000,
      "groundSpeedKt":       454,
      "route":               { "iataFlight": "LH123", "origin": "FRA", "destination": "JFK", "airline": "Lufthansa" }
    }
  ]
}
```

`observable: false` on a body means it is below the 20° horizon floor — any
aircraft passing in front of it is *not* reported, by design.

## Where files live

| Path | Purpose | Tracked in git? |
|---|---|---|
| `<repo>/config/observer.json`         | Observer location (lat / lon / elevation, geoid undulation). **Personal.** | no — gitignored |
| `<repo>/config/observer.example.json` | Schema reference / template for `observer.json`.            | yes |
| `<repo>/config/service.json`          | Runtime config (ADS-B URL, intervals, Pushover keys, server, DB, routes). **Personal.** | no — gitignored |
| `<repo>/config/service.example.json`  | Schema reference / template for `service.json`.             | yes |
| `<repo>/data/history.db`              | SQLite history of all recorded transit-stage events (created on first run). | no — gitignored |
| `<repo>/data/lifecycle.json`          | Tracking-panel snapshot so a restart doesn't empty the list. | no — gitignored |
| `<repo>/data/iss.tle`                 | ISS two-line elements for the offline SGP4 (written by `refresh-tle.js`). Feature inactive until present. | no — gitignored |
| `<repo>/data/update.request`          | Transient click-to-update trigger; consumed by `stp-update.path`. | no — gitignored |
| `<repo>/web/`                         | Static frontend served at `http://<host>:<port>/`.          | yes |
| `<repo>/display/`                     | Optional e-paper panel client (Python) + its README.        | yes |
| `<repo>/bin/stp.js`                   | Service entry point.                                        | yes |
| `<repo>/scripts/install-pi5.sh`       | Idempotent Pi installer (interactive or `--non-interactive`). | yes |
| `<repo>/scripts/auto-update.sh`       | Pull + install-deps + restart-on-change. Backs up local config first. | yes |
| `<repo>/scripts/refresh-tle.js`       | Opt-in ISS TLE fetcher (Celestrak); run by `stp-tle.timer`. | yes |
| `<repo>/scripts/test-push.js`         | One-shot Pushover sanity check.                             | yes |
| `<repo>/systemd/stp.service`          | Template for the main systemd unit.                         | yes |
| `<repo>/systemd/stp-display.service`  | Template for the optional e-paper display client unit.       | yes |
| `<repo>/systemd/stp-update.{service,timer,path}` | Auto-update + click-to-update watcher templates.  | yes |
| `<repo>/systemd/stp-tle.{service,timer}` | Daily ISS TLE refresh templates.                         | yes |
| `/etc/systemd/system/stp.service`     | Generated unit (paths and user templated by the installer). | n/a (system) |
| `/etc/systemd/system/stp-update.{service,timer,path}` | Generated auto-update + click-watcher units.  | n/a (system) |
| `/etc/systemd/system/stp-tle.{service,timer}` | Generated ISS-TLE refresh unit + timer.              | n/a (system) |
| `/etc/sudoers.d/stp-update`           | Narrow rule: `<user> NOPASSWD: /bin/systemctl restart stp.service`. | n/a (system) |

The main service runs sandboxed: `ProtectSystem=strict`,
`ProtectHome=read-only`, and the only writable path is `<repo>/data/`. The
SQLite history file therefore *must* live inside `data/` (the default) —
pointing `store.path` outside that directory will fail at write time when
running under systemd.

**Config preservation contract.** `observer.json` and `service.json` are
gitignored from the first commit that contains this README. Neither
`git pull` nor `auto-update.sh` will ever touch them. The installer only
rewrites them when run with `--overwrite`. If you ever need to roll back,
copy from the matching `*.example.json` and re-edit.

## Project layout

```
.
├── package.json                  src deps + npm scripts
├── vitest.config.js              test runner config
├── bin/stp.js                    service entry point
├── config/
│   ├── observer.example.json     schema reference (real observer.json is gitignored)
│   └── service.example.json      schema reference (real service.json is gitignored)
├── src/
│   ├── geometry.js               topocentric Az/El + great-circle separation
│   ├── adsb.js                   fetch + normalise dump1090 aircraft.json
│   ├── tracker.js                extrapolation + transit detection (sub-step refined)
│   ├── pushover.js               Pushover REST client
│   ├── notifier.js               3-stage dispatch (radio/candidate/imminent) + dedup
│   ├── adsbdb.js                 callsign → route + hex → airframe, in-memory TTL cache
│   ├── airnav.js                 AirNav On-Demand API v2 client (server-side, cached)
│   ├── sharpcap.js               imminent-transit → SharpCap TCP capture trigger (opt-in)
│   ├── sgp4.js                   dependency-free SGP4 (ISS), TLE parse, TEME→ECEF
│   ├── iss.js                    offline ISS transit + visible-pass prediction
│   ├── store.js                  SQLite history (node:sqlite) + episode stats
│   ├── server.js                 HTTP server (built-in, no framework)
│   ├── service.js                orchestrator (the polling loop)
│   ├── predictor.js              history-based 24 h watchlist (M10)
│   ├── opensky.js                OpenSky Network REST client (M10, opt-in)
│   ├── lifecycle.js              candidate state machine: planned→radio→candidate→imminent→stale (+coasting)
│   ├── config.js                 loadObserver()
│   └── index.js                  public re-exports
├── web/
│   ├── index.html                Sky-now + LIVE-TRACKING-SIGNALS + History + FOV UI
│   ├── app.js                    vanilla-JS poller
│   ├── sketch.js                 FOV transit sketch (SVG, incl. ISS glyph)
│   ├── aircraft-types.js         offline ICAO-type → specs table
│   └── style.css                 dark theme
├── scripts/
│   ├── bootstrap-pi5.sh          bare-image one-liner: apt deps + clone + install-pi5.sh
│   ├── install-pi5.sh            idempotent installer (interactive or --non-interactive)
│   ├── auto-update.sh            git pull → npm install → restart, with config backup
│   ├── refresh-schedule.js       OpenSky daily fetcher (M10, opt-in)
│   ├── refresh-tle.js            ISS TLE fetcher (Celestrak, opt-in / stp-tle.timer)
│   ├── test-push.js              one-shot Pushover sanity check
│   └── sharpcap/                 Windows SharpCap trigger: listener, bootstrap, PS installer, README
├── systemd/
│   ├── stp.service               main service unit template
│   ├── stp-update.service        auto-update oneshot template
│   ├── stp-update.timer          nightly schedule (03:30 ±15 min)
│   ├── stp-update.path           click-to-update trigger watcher
│   ├── stp-tle.service           ISS TLE refresh oneshot template
│   └── stp-tle.timer             daily ISS TLE schedule (05:40 ±20 min)
└── test/                         17 vitest files, ~205 cases
```

## Manual run (development / non-Pi)

Useful for hacking on the code, testing config changes, or running on a
non-Pi machine that already has `dump1090-fa` (or an equivalent feed)
reachable on the network.

```bash
npm install
cp config/service.example.json config/service.json   # then edit
node --experimental-sqlite bin/stp.js
```

The process logs the listening URL, the resolved ADS-B URL, and whether
Pushover is enabled. Stop it with `Ctrl+C` — it traps `SIGINT` / `SIGTERM`,
closes the HTTP server, flushes SQLite, and exits cleanly.

`--experimental-sqlite` is needed on Node 22; on Node 24+ the flag becomes a
no-op since `node:sqlite` is stable.

### Environment variables

| Variable        | Default                          | Purpose |
|---|---|---|
| `STP_OBSERVER`  | `<repo>/config/observer.json`    | Override the observer-config path. |
| `STP_CONFIG`    | `<repo>/config/service.json`     | Override the service-config path. |

Useful for running multiple observer locations from a single checkout, or
for keeping production credentials out of the repo:

```bash
STP_OBSERVER=/etc/stp/observer-rheine.json \
STP_CONFIG=/etc/stp/service.prod.json     \
  node --experimental-sqlite bin/stp.js
```

## Tests

```bash
npm test
```

~205 vitest cases across 17 files cover geometry, ADS-B parsing, tracker
(including the ADS-B latency back-stamp, sub-step vertex refinement,
barometric geoid offset, and the level=candidate/radio split), Pushover
client, notifier (3-stage pipeline with minStage filter), route lookup
with TTL cache, history store (with stage-rename migration), the HTTP
server, the history-based predictor, the OpenSky REST client, the SGP4
propagator (validated against the official Vallado 88888 verification
vectors), the SharpCap trigger (dedup / re-arm / busy-vs-network-fail
distinction), and the lifecycle state machine (planned / radio /
candidate / imminent / stale + coasting + the four stale-reason
classifications).

## Assumptions and limitations

- **Geometry**: 0° = N, 90° = E. WGS84 → ECEF → ENU for aircraft Az/El.
  Observer ECEF is computed once per tick and reused for every aircraft × body.
- **Reference frame for the comparison**: both aircraft and body are
  compared in *geometric* (un-refracted) coordinates. `/api/state` still
  exposes the refracted body position via the regular `bodyAzEl` for
  display. Differential refraction along two near-coincident lines of sight
  is well below the search noise.
- **Observability**: `isObservable(azEl, minElevationDeg)` returns `true`
  only above the threshold (default 20°). Since v0.30.37 the tracker
  auto-widens this down to the lowest enabled rig's `minElevationDeg`
  (hard-floored at 5° for refraction sanity), so a clear-horizon site
  with a 10°-tolerant main rig will see candidates with the body between
  10° and 20° elevation that the old hardcoded floor would have hidden.
- **Aircraft altitude**: prefers `alt_geom`, falls back to `alt_baro`.
  `alt_geom` is GPS height above WGS84 ellipsoid (DO-260) and is fed
  straight in. `alt_baro` is pressure altitude (≈MSL on standard atm.) and
  is converted to HAE by adding `observer.geoidUndulationM` (default 0;
  ≈+46 m at Rheine).
- **Extrapolation**: linear, locally-flat tangent plane, 300 s horizon
  (default — clamped to `[10, 1800]`). Error versus geodesic is well
  under 1 m at our typical speeds within ~60 s; reasonable through
  ~5 min in stable cruise. Aircraft are projected from their **fix
  time** (`receivedAtMs`), not from `now`, so a `seen_pos` lag of
  several seconds does not bias the predicted position.
- **Sub-step time precision**: after the discrete minimum is located, a
  parabolic vertex is fitted through the three samples around it. With the
  default `stepS = 0.5 s` this gives sub-100-ms closest-approach time.
- **ADS-B liveness**: aircraft with `seen_pos > 30 s` are dropped during
  parsing — stale fixes are not extrapolated.
- **No camera trigger**: explicitly out of scope. We push, you arm the camera.

## Status

Production-ready and in daily use; ~78 named milestones (M1 → M78,
covering v0.0 → v0.30.39). Detailed history with per-milestone scope
lives in **[`MILESTONES.md`](MILESTONES.md)**. For "what changed in
release X" see `git log --oneline`.

## Trivia & statistical insights

A mix of physical-geometry math, real prediction statistics from a
month-plus of live operation, astronomical curiosities, and the
amusing-in-hindsight bugs that shaped the architecture. Numbers are
from the running site (Rheine, Germany) unless noted; your data will
look broadly similar but specific values drift with traffic patterns
and weather.

### Physical geometry — how forgiving is an "on-disc" transit, really?

The Sun and Moon disc both span about **0.53°** of sky — angular
radius **~0.27°**. That radius, multiplied by your slant range to the
aircraft, is how many METRES of lateral track error pushes the plane
out of the disc:

| Body elevation | Slant range @ 12 km alt | Lateral tolerance for disc-edge |
|---|---|---|
| 90° (overhead) | 12.0 km | **~57 m** (≈ half an A320) |
| 60° elev | 13.9 km | ~65 m |
| 45° elev | 17.0 km | ~80 m |
| 30° elev | 24.0 km | ~113 m |
| 20° elev | 35.1 km | ~165 m |
| 10° elev | 69.1 km | **~326 m** |

Counterintuitive result: at LOWER body elevation the lateral tolerance
GROWS (longer slant range = same 0.27° spans more metres). But low-
elevation traffic is overwhelmingly descent / approach aircraft that
get ATC-vectored constantly, so they drift 500-1000 m in the last
minute — which overwhelms the geometric tolerance. Cruise traffic at
high elevation has < 50 m of late-stage drift (autopilot + LNAV + GPS
is mathematically exact at this scale), so the system records very
tight bullseye transits when the prediction holds.

### Prediction accuracy — what the postmortem table actually shows

After ~90 finished episodes the prediction-error stats break down
roughly like this (the live panel auto-updates, these are typical
ranges):

| Lead at sample | High-elev (≥ 30°, cruise) | Low-elev (< 30°, descent / approach) |
|---|---|---|
| > 90 s | p50 ~0.20° · p95 ~1.5° | p50 ~0.30° · p95 ~2.5° |
| 30–60 s | p50 ~0.08° · p95 ~1° | p50 ~0.10° · p95 ~2° |
| < 10 s | p50 ~0.04° · p95 < 0.3° | p50 ~0.13° · p95 ~2° |

The clean read: **high-elev cruise predictions converge to <0.05°
median in the last 10 seconds — well inside the 0.27° disc radius**.
Low-elev approach traffic plateaus at ~0.13° median (still on-disc on
average), but the long-tail (P95 ~2°) reflects ATC-vectoring drift
that mathematically cannot be predicted from ADS-B alone. The
predictor reports it honestly — it does not hide the long tail.

**Field calibration (n=1014 episodes).** A larger run confirms the
shape and sharpens the takeaways:

- **Lead time barely matters.** Aggregate P50 is **0.09–0.18°** and
  P95 **~0.93°** across *all* lead buckets — waiting from 90 s out to
  10 s out buys only ~0.09°. There is no reason to hold out for a
  late lock-in; the prediction does not meaningfully tighten as the
  ETA approaches.
- **Elevation is the real lever.** At ≥ 30° the > 90 s bucket is
  already 0.09° (n=293); below 30° it sits at 0.21° (n=664) and is
  what drags the aggregate down. Treat transits ≥ 30° as reliable;
  keep more margin (or skepticism) below that. This validates the
  default 30° Pushover gate — it is gating on the genuine accuracy
  cliff, not an arbitrary line.
- **Aim for the best, not the last.** The prediction drifts back out
  after its tightest point — median 0.34°, P95 0.97° (`final − best`).
  The *best* projected moment is more trustworthy than the *final*
  one, which is exactly why the live table and SharpCap arming track
  `bestSepDeg` rather than the latest value.

**Sun vs Moon — no per-body difference, by design.** The error budget
is entirely the *aircraft* trajectory; both body positions are known
to arcsecond precision (topocentric, parallax-corrected), so there is
**no physical reason for prediction accuracy to differ between the two
discs**. `predictionAccuracy()` therefore blends both bodies on
purpose — any Sun/Moon gap you could split out would be a *traffic-mix
/ time-of-day* confound (Moon transits cluster at different hours →
different elevations and traffic), not a property of the body. The
elevation split above is the cut that actually carries signal.

### Wind-drift as a detector

The drift-bias sampler runs every tick over every aircraft above 20°
elevation, comparing actual position vs. a constant-velocity
extrapolation of the previous fix. The mean residual across many
flights = systematic wind / ATC bias for the day. Two observed days
worth contrasting:

- **Day 1 (light Ostwind):** mean drift 0.9 m/s @ 97° E across
  n=1407 samples. σ_E = 7.5 m/s, SE = 0.20 m/s → 4.5σ above zero,
  statistically significant.
- **Day 2 (calm):** mean drift 0.1 m/s @ 108° E across n=4000 samples.
  σ_E = 8.0 m/s, SE = 0.13 m/s → 0.8σ, indistinguishable from no wind.

The system actually detects real-world wind conditions — and is
honest when there isn't a meaningful signal. Standard Error (σ/√n), not
raw σ, is the correct test for "is the mean different from zero" (see
v0.30.39 fix).

### Disc-crossing duration — a transit is over before you can react

Angular speed of an airliner across the sky is roughly `v / range`:

| Airliner speed | Slant range | ω (deg/s) | Time to cross 0.53° Sun disc |
|---|---|---|---|
| 250 m/s (≈ 900 km/h) | 12 km | 1.19°/s | **~0.45 s** |
| 250 m/s | 25 km | 0.57°/s | ~0.93 s |
| 250 m/s | 60 km | 0.24°/s | ~2.2 s |

For an overhead cruise jet you have **less than half a second of disc
contact** — explains why SharpCap's own Sequencer is too slow and why
this whole project exists.

### Sun-disc radius isn't quite constant

The Sun's angular diameter varies between **0.524°** (Aphelion ~July 4)
and **0.541°** (Perihelion ~January 3) — about 3 % swing. The disc
radius therefore ranges from 0.262° to 0.270°. The Moon swings wider:
**0.490°** (Apogee) to **0.564°** (Perigee, a "supermoon"). The
predictor uses fixed nominal disc sizes in the search threshold; the
real variation rounds inside the 0.3° candidate band so it doesn't
affect detection.

### Hit rate at a mid-European urban site

From a few days' worth of stats at Rheine, NW Germany (well-served by
Amsterdam approach traffic + Frankfurt overflights):

- ~**5-15 confirmed-imminent transits per day**, mixed Sun + Moon.
- Of those, ~**15-20% are on-disc bullseyes** (< disc radius). The
  rest are near-misses 0.3-2° off-centre.
- So about **2-3 actual photographable transits per day** for the
  site — multiply by a typical clear-sky fraction in NW Germany and
  you get the realistic photographic output.

### Architectural war stories (one-liners)

A few bugs that shaped the current design. All in `MILESTONES.md` if
you want the full reconstruction.

- **The `→` arrow that broke a Windows install** (v0.30.15): a single
  U+2192 in a Python comment crashed the SharpCap bootstrap's cache
  writer because Windows defaults to cp1252 encoding for text-mode
  file writes. Forced the listener body to pure ASCII forever after.

- **`subprocess.run` is too new** (v0.30.17): some SharpCap builds
  embed Python 3.4. `subprocess.run` arrived in 3.5,
  `capture_output=True` in 3.7. Had to drop to `Popen + communicate`
  to stay portable.

- **The console window that flashed for 1 second** (v0.30.18):
  `CREATE_NO_WINDOW` flag is Python 3.7+. Older Python silently fell
  back to 0 and a CMD window briefly popped on every robocopy
  invocation. Combine with `STARTUPINFO + STARTF_USESHOWWINDOW +
  SW_HIDE` (in subprocess since Python 2) to cover all versions.

- **The 120 s outcome wait** (v0.30.34): a 20 GB SSD → NAS copy takes
  many minutes. The predictor's `_probempty` / `_confirmed` verdict
  arrives ~60 s after the lifecycle settles, so the LOCAL rename on
  SSD has to happen FIRST, then the long upload uses the already-
  tagged filename. Listener blocks on `threading.Event[captureId]`
  for up to 120 s before starting the NAS phase — so the final
  filename never races the upload.

- **TCP-storm on busy listener** (v0.30.3): the per-rig dedup was
  releasing the slot on EVERY failed send. A "busy" response (listener
  recording for another ICAO) would clear dedup, next tick fired
  again, repeat 25 times in 60 s. Fix: distinguish JSON-reply-but-
  `ok:false` (= listener said no, keep dedup) from no-reply (= network
  failed, release dedup).

- **Drift sampler's "low signal" flag was using the wrong test**
  (v0.30.39): comparing the mean magnitude to within-population σ is
  not a significance test — that ratio never converges to <1 even
  with millions of samples. The right comparison is Standard Error
  of the mean (σ / √n), which shrinks with n. With n=1407 samples a
  0.9 m/s mean against σ=7.5 is 4.5 standard errors above zero —
  highly significant, even though the population variance suggests
  noise.

### Headline numbers at a glance

- **~205 vitest cases** across 17 files cover the whole pipeline.
- **5-15 confirmed-imminent transits per day** at a mid-European site.
- **57-326 m** of lateral track-error pushes an aircraft off the disc,
  depending on body elevation.
- **0.5 - 2 seconds** is a typical disc-crossing time for an airliner.
- **~120 s** is the worst case for the outcome-verdict pipeline to
  settle on the final filename (lifecycle-stale + outcome-wait).
- **78 named milestones**, M1 → M78, in `MILESTONES.md`.

## License

TBD.
