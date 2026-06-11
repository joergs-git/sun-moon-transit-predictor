#!/usr/bin/env python3
"""
E-paper display client for the Sun-Moon Transit Predictor.
v0.31.14

A standalone, decoupled HTTP poller + renderer for a Waveshare 4.2" B/W SPI
panel (400×300) on a Raspberry Pi 5. It carries NO business logic: it reads its
live config from <STP_CONFIG_URL>/api/config and the data to show from the
resolved sourceUrl's /api/state, then draws a browserless readout — clock,
date, location, live-tracking count and the soonest Real candidates (with ETA,
angle, altitude, speed, distance), plus a Sky-now / FOV footer.

Refresh strategy (both cadences come from the browser Settings panel):
  * partial refresh every `quickRefreshS` s  → fast, no flash
  * full refresh    every `longRefreshS`  s  → brief flash, clears ghosting

Run on the Pi via systemd (systemd/stp-display.service). For development on any
machine without the panel:
    python3 epaper_client.py --dry-run            # render once to out.png
    python3 epaper_client.py --dry-run --loop     # re-render to out.png in a loop
    python3 epaper_client.py --dry-run --out x.png

Pi 5 note: the panel needs SPI enabled (raspi-config) and Waveshare's current
gpiozero/lgpio-based driver — RPi.GPIO does NOT work on the Pi 5.
"""

import argparse
import importlib
import signal
import sys
import time

import buzzer
import config
import render


# ── E-paper driver wrapper ──────────────────────────────────────────────────
# Waveshare's per-panel driver modules differ slightly between revisions
# (method names for partial refresh in particular). This wrapper imports the
# configured module and adapts to whatever it exposes, so the main loop stays
# clean and the same code works on both the V2 and the older 4.2" board.
class Panel:
    def __init__(self, driver_name):
        module = importlib.import_module("waveshare_epd.%s" % driver_name)
        self.epd = module.EPD()
        self._has_partial = hasattr(self.epd, "display_Partial")
        self._has_init_fast = hasattr(self.epd, "init_fast")

    def init_full(self):
        self.epd.init()
        self.epd.Clear()

    def show_full(self, img):
        # Re-init to the full waveform so the periodic flash truly clears ghosting.
        self.epd.init()
        self.epd.display(self.epd.getbuffer(img))

    def show_partial(self, img):
        buf = self.epd.getbuffer(img)
        if self._has_partial:
            try:
                # V2 signature: display_Partial(buf, x0, y0, x1, y1)
                self.epd.display_Partial(buf, 0, 0, render.WIDTH, render.HEIGHT)
                return
            except TypeError:
                # Older signature: display_Partial(buf)
                self.epd.display_Partial(buf)
                return
        # Driver has no partial path — fall back to a full refresh.
        self.show_full(img)

    def sleep(self):
        try:
            self.epd.sleep()
        except Exception:
            pass


# ── Dry-run (no hardware) ───────────────────────────────────────────────────
class FilePanel:
    """Stand-in for Panel that writes PNGs instead of driving a panel."""

    def __init__(self, out_path):
        self.out_path = out_path

    def init_full(self):
        pass

    def _save(self, img):
        # Save as PNG; convert 1-bit to a clean black/white image.
        img.convert("L").save(self.out_path)

    def show_full(self, img):
        self._save(img)

    def show_partial(self, img):
        self._save(img)

    def sleep(self):
        pass


_running = True


def _stop(signum, frame):
    global _running
    _running = False


def _log(msg):
    print("[stp-display] %s" % msg, flush=True)


def run(panel, once=False):
    """Main poll loop: drives the panel and/or the buzzer from the live config.

    State is fetched once per tick and shared by both: the panel renders it, the
    buzzer's scheduler reacts to it. Either feature can be enabled independently
    in the browser Settings — with the panel off but the buzzer on, we keep
    polling (for the beeps) and leave the screen cleared.
    """
    panel.init_full()

    last_full = 0.0          # monotonic time of the last full refresh
    last_conn_ok = None      # connectivity state, logged only on change
    idle_drawn = False       # so the cleared/idle screen is drawn just once
    display_cfg = dict(config.DEFAULTS)
    buzzer_cfg = dict(config.BUZZER_DEFAULTS)
    last_cfg_fetch = 0.0
    last_test_id = None      # last seen buzzer testId, to detect the Settings test

    buz = buzzer.Buzzer()
    sched = buzzer.BeepScheduler(buz, buzzer_cfg, log=_log)

    while _running:
        now = time.monotonic()

        # Re-read the live display + buzzer config on its own cadence, and apply
        # any pin/frequency change to the buzzer without a restart.
        if now - last_cfg_fetch >= config.CONFIG_REFRESH_S:
            display_cfg = config.fetch_display_config()
            buzzer_cfg = config.fetch_buzzer_config()
            # Claim the GPIO only while enabled; release it when disabled.
            buz.apply(bool(buzzer_cfg.get("enabled")), buzzer_cfg["gpioPin"], buzzer_cfg["freqHz"])
            sched.cfg = buzzer_cfg
            # Settings "Test signals": play the whole sequence once when the id
            # changes (skipped on the first fetch so it doesn't fire at startup).
            test_id = buzzer_cfg.get("testId")
            if last_test_id is not None and test_id != last_test_id:
                for pattern, freq in buzzer.test_sequence(buzzer_cfg):
                    buz.play(pattern, freq=freq)
                _log("buzzer test sequence requested (testId %s)" % test_id)
            last_test_id = test_id
            last_cfg_fetch = now

        display_on = bool(display_cfg.get("enabled"))
        buzzer_on = buz.ok

        # Nothing enabled → clear the screen once, then idle cheaply.
        if not display_on and not buzzer_on:
            if not idle_drawn:
                panel.show_full(render.render_disabled())
                idle_drawn = True
                last_full = now
                _log("display + buzzer disabled via Settings — idling")
            if once:
                break
            time.sleep(2)
            continue

        source_url = config.resolve_source_url(display_cfg)
        quick = max(1.0, float(display_cfg.get("quickRefreshS") or 2))
        long_s = max(quick, float(display_cfg.get("longRefreshS") or 60))

        # Fetch the live state once; share it between buzzer + panel.
        state = None
        conn_ok = True
        reason = ""
        try:
            state = config.fetch_state(source_url)
        except Exception as e:
            conn_ok = False
            reason = str(e)

        # Buzzer reacts to the live candidates.
        if buzzer_on and conn_ok and state is not None:
            try:
                sched.update(state, now)
            except Exception as e:
                _log("buzzer scheduler error: %s" % e)

        # Panel.
        if display_on:
            recovered = conn_ok and (last_conn_ok is False)
            if conn_ok != last_conn_ok:
                _log("connected to %s" % source_url if conn_ok else "offline: %s (%s)" % (source_url, reason))
                last_conn_ok = conn_ok
            img = render.render_state(state, display_cfg) if conn_ok else render.render_offline(source_url, reason)
            need_full = (last_full == 0.0) or (now - last_full >= long_s) or recovered
            if need_full:
                panel.show_full(img)
                last_full = now
            else:
                panel.show_partial(img)
            idle_drawn = False
        elif not idle_drawn:
            # Buzzer-only mode: clear the panel once and leave it.
            panel.show_full(render.render_disabled())
            idle_drawn = True
            last_full = now

        if once:
            break
        time.sleep(quick)

    buz.close()
    panel.sleep()


def main():
    ap = argparse.ArgumentParser(description="E-paper display client for the transit predictor")
    ap.add_argument("--dry-run", action="store_true",
                    help="render to a PNG file instead of the panel (no hardware needed)")
    ap.add_argument("--out", default="out.png", help="output PNG path for --dry-run (default out.png)")
    ap.add_argument("--loop", action="store_true", help="with --dry-run, keep re-rendering (default: render once)")
    ap.add_argument("--test-buzzer", action="store_true",
                    help="run the buzzer self-test (DC + PWM tone + frequency sweep) and exit")
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    if args.test_buzzer:
        cfg = config.fetch_buzzer_config()  # use the configured pin/freq if reachable
        buzzer.selftest(pin=int(cfg.get("gpioPin", 13)), freq=int(cfg.get("freqHz", 2700)))
        return

    if args.dry_run:
        panel = FilePanel(args.out)
        _log("dry-run → %s (config %s)" % (args.out, config.CONFIG_URL))
        run(panel, once=not args.loop)
        _log("wrote %s" % args.out)
        return

    try:
        panel = Panel(config.EPD_DRIVER)
    except Exception as e:
        _log("failed to init panel driver '%s': %s" % (config.EPD_DRIVER, e))
        _log("check: SPI enabled (raspi-config), waveshare-epd installed, STP_EPD_DRIVER correct")
        sys.exit(1)

    _log("starting (driver %s, config %s)" % (config.EPD_DRIVER, config.CONFIG_URL))
    run(panel)
    _log("stopped")


if __name__ == "__main__":
    main()
