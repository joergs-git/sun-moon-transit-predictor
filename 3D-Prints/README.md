# 3D-printed enclosure & stand

A printable desk stand that holds the **Raspberry Pi 5**, the **Waveshare 4.2"
e-paper panel** and the **RTL-SDR ADS-B dongle** in one tidy unit — the
browserless readout sitting next to the receiver, antenna upright behind it.

![Pi 5 + e-paper stand with ADS-B dongle and antenna — and a real H-alpha Sun transit on the monitor behind](sunmoon-adsb-casestand.jpg)

*The printed stand in use: the e-paper panel shows the live readout, the green
RTL-SDR dongle feeds `dump1090-fa`, the ADS-B antenna stands behind. On the
monitor: an actual H-alpha capture of an aircraft crossing the solar disc — the
event this whole project exists to catch.*

## Parts

| File | What it is |
|---|---|
| `sunmoon-adsb-pi5-epaper-stand.stl` | The combined desk stand (Pi 5 + 4.2" e-paper + dongle) shown in the photo. Print this if you want the all-in-one unit. |
| `pi5_casebottom.stl` / `pi5_casetop.stl` | A plain two-part Raspberry Pi 5 case (bottom + top), if you'd rather house the Pi separately. |
| `epaper4.2_waveshare_case.stl` | A frame/case for the bare Waveshare 4.2" e-paper module. |

**Printing:** PLA/PETG, 0.2 mm layers, no supports needed for the stand (designed
to print flat). Black looks best with the e-paper bezel; any colour works.

## Components to fit into it

| Component | Notes |
|---|---|
| **Waveshare 4.2" e-paper module** (B/W, **400 × 300**, SPI) | The display that drops into the stand. SPI, **not** I2C. Plugs onto the Pi 5's 40-pin header (or wire the bare module — see the pin map in [display/README.md](../display/README.md)). |
| **Raspberry Pi 5** | Runs everything (tracker + `dump1090-fa` + the panel client). |
| **RTL-SDR USB dongle** (RTL2832U + R820T2) + **1090 MHz antenna** | The ADS-B receiver feeding `dump1090-fa`. A compact antenna: [shorter 1090 MHz antenna](https://amzn.eu/d/06Qrm39Q) ([female–female SMA adapters](https://amzn.eu/d/06Qrm39Q) may be needed for the coax). |
| **Piezo buzzer** (small passive piezo) | Optional audio alerts. Wires across **GPIO13 ↔ GND** — see below. [Example buzzer](https://amzn.eu/d/0bKdLEn7). |
| 2 × female–female jumper wires | To connect the buzzer to the header. |

---

## Piezo buzzer — wiring (the optimal default)

The optional audio alerts (see **[display/README.md](../display/README.md#audio-buzzer-optional)**)
use a small **piezo buzzer**. Wire it with **two jumpers, no extra parts**:

| Buzzer leg | Raspberry Pi 5 pin |
|---|---|
| **+** (signal) | **GPIO13** — physical pin **33** |
| **−** (GND) | any **GND** — e.g. physical pin **34**, right next to it |

GPIO13 and the GND on pin 34 are adjacent on the 40-pin header, so a passive
piezo can plug straight across the two with nothing else.

- **Passive vs active — doesn't matter.** The client always **PWM-drives** the
  pin (default **2000 Hz**). A passive piezo sings at that frequency; an active
  one beeps whenever it's powered. No resistor, no transistor needed at the low
  drive current of a small piezo.
- **Confirm it + find the loudest tone:** on the Pi run
  `cd display && python3 epaper_client.py --test-buzzer` (plays a DC test, a PWM
  tone, then a frequency sweep). Set the loudest as **Drive frequency** in
  Settings.
- **Enable + tune:** ⚙ Settings → **Audio / buzzer** → tick **Enabled**, then
  press **▶ Test signals** to hear the whole sequence. Everything (lengths,
  counts, frequencies, fades, windows) is adjustable there; GPIO13 is the
  default pin.

### What the beeps mean (defaults)

| Cue | Sound |
|---|---|
| **New real candidate** (a tracked plane coming within 1° of a disc, ≤ 2 min out) | a **rising** 3-tone chord (2000 → 2200 → 2400 Hz) |
| **Candidate lost / passed** | a **falling** 3-tone chord (500 → 300 → 100 Hz) with a soft fade |
| **Countdown** as it approaches | quick double-beeps speeding up — every **10 s** from 60 s, **5 s** from 15 s, **2 s** from 8 s |
| **Entry** — the actual disc transit (sep < ~0.35°) | a **rising** 3-tone chord, fired once, from 3 s before |

Rising = arriving, falling = gone — so you can tell what happened without
looking. The countdown only fires for planes whose predicted closest approach is
under the **Alert SEP threshold** (default 1°); the entry chord keeps its own
tight disc-transit gate.
