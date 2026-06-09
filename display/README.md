# E-paper display client

A standalone, browserless readout for the Sun-Moon Transit Predictor on a
**Waveshare 4.2" B/W SPI e-paper panel** (400×300) driven by a **Raspberry Pi 5**.

It shows, updating in near-real time, a fixed three-paragraph layout:

1. **Header** (two lines) — line 1: big bold **clock** + **date**; line 2:
   **place** + **GPS**. Two lines so everything stays readable (the full GPS
   always fits). The live counts moved down to the aircraft heading.
2. **Nearest plane** — the nearest tracked plane in detail: callsign + body,
   with **ETA** and **SEP** as the big, bold headline figures and **route,
   bearing, distance, altitude, speed** small underneath, plus a large **FOV
   preview** against the body disc on the right. (Labelled *REAL CANDIDATE*
   when it has reached candidate/imminent, else *NEAREST PLANE*.)
3. **Sky-now + aircraft** — Sun/Moon **elevation** (large, left) and the tracked
   **aircraft** on the right, each with big **SEP** and **ETA** payloads. The
   aircraft heading shows a **(candidates / total live)** counter.

The planes come from the unified live-tracking list, so the panel keeps showing
nearby traffic even when nothing currently qualifies as a Real candidate.

The client carries no business logic — it polls the predictor's HTTP API and
renders. So the data can come from **the same Pi** or a **remote Pi on the LAN**
(see *Remote data source* below).

---

## How it's configured — everything from the browser

There is exactly **one** local setting on the display Pi: `STP_CONFIG_URL` (in
the systemd unit) — where to read the live config from. **Everything else is set
in the web Settings panel** (⚙ Settings → *E-paper display*) and applied live
within a few seconds, no restart:

| Setting | Meaning |
|---|---|
| **Enabled** | Master on/off. Off → the panel is cleared once and idles. |
| **Data source URL** | Blank = read from this Pi (localhost). Set a LAN URL (e.g. `http://192.168.1.50:8081`) to drive a local panel from a remote ADS-B/Node host. |
| **Quick refresh (s)** | Partial-refresh cadence — fast, flash-free text update. Default 2. Floor 1. |
| **Long refresh (s)** | Full-refresh cadence — periodic brief flash that clears e-paper ghosting. Default 60. Must be ≥ Quick. |

The layout itself is fixed (the three paragraphs above) — there are no
list-length or compact knobs.

> **Why e-paper can't truly do "video".** A full refresh flashes for ~2–4 s; a
> partial refresh is fast (~0.3–0.5 s) but accumulates ghosting. The two-cadence
> design (quick partial + periodic full) is the standard way to get a lively yet
> clean panel. A 1–2 s quick refresh is the practical floor.

---

## Hardware wiring (Pi 5 ↔ 4.2" SPI HAT)

The 4.2" e-Paper HAT plugs onto the Pi's 40-pin header. If you use the HAT it is
keyed; if you wire the bare module, use these BCM pins:

| Panel | Pi 5 pin (BCM) |
|---|---|
| VCC | 3V3 |
| GND | GND |
| DIN (MOSI) | GPIO10 |
| CLK (SCLK) | GPIO11 |
| CS | GPIO8 (CE0) |
| DC | GPIO25 |
| RST | GPIO17 |
| BUSY | GPIO24 |

> **This is an SPI panel, not I2C** — there is no I2C variant of the 4.2".

---

## Install (Raspberry Pi 5)

> **Easiest:** run the main installer with `--with-display` — it does steps 1–4
> below for you (SPI, Python libraries, spi/gpio groups, service):
> ```bash
> bash scripts/install-pi5.sh --with-display
> # or on a fresh box: curl -fsSL .../bootstrap-pi5.sh | bash -s -- --with-display
> ```
> Then reboot once and do step 5 (enable it in the web UI). The manual steps:

1. **Enable SPI**: `sudo raspi-config` → *Interface Options* → *SPI* → *Yes*, then reboot.
2. **Install Python deps + the Waveshare driver** (the driver is not on PyPI —
   it comes from Waveshare's GitHub):
   ```bash
   sudo apt-get install -y git python3-pil python3-lgpio python3-gpiozero \
     python3-spidev python3-rpi-lgpio
   git clone --depth 1 https://github.com/waveshareteam/e-Paper /tmp/e-Paper
   sudo pip3 install --break-system-packages --no-deps /tmp/e-Paper/RaspberryPi_JetsonNano/python
   ```
3. **Add the service user to the spi/gpio groups** (so it can reach the panel):
   ```bash
   sudo usermod -aG spi,gpio "$USER"
   ```
4. **Install the systemd unit** (replace the placeholders, or let the bootstrap
   script do it):
   ```bash
   sudo cp systemd/stp-display.service /etc/systemd/system/
   sudo sed -i "s|__INSTALL_DIR__|$(pwd)|g; s|__USER__|$USER|g" /etc/systemd/system/stp-display.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now stp-display.service
   ```
5. **Turn it on** in the web UI: open `http://<pi>:8081/` → ⚙ Settings →
   *E-paper display* → tick **Enabled** → Save.
6. **Watch logs**: `journalctl -u stp-display -f`

---

## Remote data source (two-Pi setup)

To drive a panel on a **display Pi** from a **central ADS-B/Node Pi**:

- Install this client on the **display Pi** (steps above). Leave
  `STP_CONFIG_URL=http://127.0.0.1:8081` if the display Pi also runs the
  predictor (it serves the Settings page); otherwise point it at whichever host
  serves the web UI you'll configure from.
- In Settings → *E-paper display*, set **Data source URL** to the central Pi,
  e.g. `http://192.168.1.50:8081`.

The panel then renders that host's live state. If the source goes away, the
panel shows **SERVER OFFLINE** and recovers automatically.

---

## Develop / preview without hardware

The renderer runs anywhere with Pillow — no panel needed:

```bash
cd display
python3 epaper_client.py --dry-run                 # render once → out.png
python3 epaper_client.py --dry-run --loop          # keep refreshing out.png
STP_CONFIG_URL=http://192.168.1.50:8081 python3 epaper_client.py --dry-run
```

---

## Driver

There is **no reliable PyPI package** for the Waveshare panel — install the
official library from GitHub (this is what `--with-display` does):

```bash
git clone --depth 1 https://github.com/waveshareteam/e-Paper /tmp/e-Paper
sudo pip3 install --break-system-packages --no-deps /tmp/e-Paper/RaspberryPi_JetsonNano/python
```

`--no-deps` is important on the Pi 5: it stops pip pulling the Pi-4-only
`RPi.GPIO`/`spidev` wheels. The runtime backends come from apt instead
(`python3-lgpio python3-gpiozero python3-spidev python3-rpi-lgpio`). On the Pi 5
the panel is driven via the **gpiozero lgpio** pin factory — the service sets
`GPIOZERO_PIN_FACTORY=lgpio` so it skips the broken RPi.GPIO/pigpio fallbacks.

Newer 4.2" boards use the `epd4in2_V2` driver (the default). If the panel shows
nothing or garbage on first run, switch to the older driver via the unit's
`Environment=STP_EPD_DRIVER=epd4in2` line, then
`sudo systemctl daemon-reload && sudo systemctl restart stp-display`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No module named 'waveshare_epd'` | Driver not installed — run the GitHub install in *Driver* above (or re-run `install-pi5.sh --with-display`). |
| `Unable to load any default pin factory!` / `unable to open /dev/gpiomem` | GPIO blocked. Ensure the unit has **no** `ProtectHome`/`DeviceAllow` (v0.31.1 unit fixes this), the user is in the `gpio` group, and `python3-lgpio`/`python3-rpi-lgpio` are installed. Reboot once after group changes. |
| `No module named 'waveshare_epd.epd4in2_V2'` | Older board — set `STP_EPD_DRIVER=epd4in2` in the unit, daemon-reload, restart. |
| `failed to init panel driver` | SPI not enabled, driver not installed, or wrong `STP_EPD_DRIVER`. See logs. |
| Nothing / garbage on screen | Try `STP_EPD_DRIVER=epd4in2` (older board) vs `epd4in2_V2`. |
| `SERVER OFFLINE` | The **Data source URL** host is unreachable. Check the predictor is up and the IP/port are right. |
| Permission denied on `/dev/spidev0.0` | Service user not in `spi`/`gpio` groups (step 3); re-login or reboot. |
| Heavy ghosting | Lower **Long refresh** (more frequent full clears). |
| Text feels laggy | Raise **Quick refresh** toward 2–3 s; the panel can't partial-refresh faster than ~1 s. |
