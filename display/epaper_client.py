#!/usr/bin/env python3
"""
E-paper display client for the Sun-Moon Transit Predictor.
v0.47.3 — guarded shutdown (clean restart) + opt-in region-only refresh.

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

from PIL import ImageChops

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

    def show_partial_region(self, img, x0, y0, x1, y1):
        """Refresh ONLY the (x0,y0)→(x1,y1) window (v0.47.3). x must be byte-
        aligned (caller's job). Falls back to a full-area partial when the driver
        lacks the windowed display_Partial signature."""
        buf = self.epd.getbuffer(img)
        if self._has_partial:
            try:
                self.epd.display_Partial(buf, int(x0), int(y0), int(x1), int(y1))
                return
            except TypeError:
                pass   # older driver: no windowed partial → fall back below
        self.show_partial(img)

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

    def show_partial_region(self, img, x0, y0, x1, y1):
        self._save(img)

    def sleep(self):
        pass


_running = True


def _stop(signum, frame):
    global _running
    _running = False


def _log(msg):
    print("[stp-display] %s" % msg, flush=True)


# ── Panel watchdog (v0.47.2) ────────────────────────────────────────────────
# Waveshare's ReadBusy() is an UN-timed busy-wait: if the e-ink controller
# wedges (which, over a night of 2-second partial refreshes, eventually happens)
# the SPI call never returns and the whole client freezes — the symptom the user
# saw (panel + clock frozen, Pi otherwise fine). A SIGALRM interrupts the wedged
# wait so the loop can re-init the panel and carry on instead of hanging forever.
PANEL_TIMEOUT_S = 20
_HAS_ALARM = hasattr(signal, "SIGALRM")


class _PanelTimeout(Exception):
    pass


def _alarm_handler(signum, frame):
    raise _PanelTimeout()


def _guard(fn, seconds=PANEL_TIMEOUT_S):
    """Run a hardware-blocking call with a hard timeout. True = ok, False =
    timed out. A no-op guard on platforms without SIGALRM (so --dry-run on a
    Mac/Windows dev box still works)."""
    if not _HAS_ALARM:
        fn()
        return True
    old = signal.signal(signal.SIGALRM, _alarm_handler)
    signal.alarm(max(1, int(seconds)))
    try:
        fn()
        return True
    except _PanelTimeout:
        return False
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)


def run(panel, once=False):
    """Main poll loop: drives the panel and/or the buzzer from the live config.

    State is fetched once per tick and shared by both: the panel renders it, the
    buzzer's scheduler reacts to it. Either feature can be enabled independently
    in the browser Settings — with the panel off but the buzzer on, we keep
    polling (for the beeps) and leave the screen cleared.
    """
    _guard(panel.init_full)   # don't let a wedged panel hang us at startup

    last_full = 0.0          # monotonic time of the last full refresh
    panel_fail = 0           # consecutive panel-update timeouts (for back-off)
    prev_img = None          # last image pushed, for region-only diffing
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
                panel.show_full(render.render_disabled(config.CONFIG_URL))
                idle_drawn = True
                last_full = now
                # Name the config host: if it's a remote (not localhost) while
                # the panel is meant to be on, STP_CONFIG_URL is likely pointed
                # at the main tracker Pi (display.enabled=false there). See
                # render_disabled / stp-display.service comments.
                _log("display + buzzer disabled per config from %s — idling "
                     "(if unexpected, check STP_CONFIG_URL points at THIS Pi)"
                     % config.CONFIG_URL)
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
            img = (render.render_state(state, display_cfg, source_url=source_url)
                   if conn_ok else render.render_offline(source_url, reason))
            need_full = (last_full == 0.0) or (now - last_full >= long_s) or recovered
            region_on = bool(display_cfg.get("regionPartial"))

            # Pick the gentlest panel op. Region mode (v0.47.3): on a quick tick
            # refresh ONLY the changed pixels (the ticking clock → a tiny window)
            # — far fewer/smaller ReadBusy cycles — and SKIP entirely when nothing
            # changed. The periodic full refresh still clears any ghosting.
            op = None
            kind = "partial"
            if need_full:
                op = lambda: panel.show_full(img)        # noqa: E731
                kind = "full"
            elif region_on and prev_img is not None:
                bbox = ImageChops.difference(img.convert("1"), prev_img.convert("1")).getbbox()
                if bbox is None:
                    kind = "skip"
                else:
                    x0 = (bbox[0] // 8) * 8                                   # byte-align x
                    x1 = min(render.WIDTH, ((bbox[2] + 7) // 8) * 8)
                    y0 = max(0, bbox[1] - 1)
                    y1 = min(render.HEIGHT, bbox[3] + 1)
                    if (x1 - x0) * (y1 - y0) > 0.6 * render.WIDTH * render.HEIGHT:
                        op = lambda: panel.show_partial(img)                  # noqa: E731
                    else:
                        op = lambda a=x0, b=y0, c=x1, d=y1: panel.show_partial_region(img, a, b, c, d)  # noqa: E731
                        kind = "region"
            else:
                op = lambda: panel.show_partial(img)     # noqa: E731

            if kind == "skip":
                idle_drawn = False
                panel_fail = 0                            # nothing to draw → done
            else:
                # Drive the panel under the watchdog so a wedged BUSY-wait can't
                # freeze the whole client. On timeout: re-init, force a clean full
                # next loop, back off so we don't hammer a struggling panel.
                ok = _guard(op)
                if ok:
                    if need_full:
                        last_full = now
                    prev_img = img
                    idle_drawn = False
                    panel_fail = 0
                else:
                    panel_fail += 1
                    _log("panel update timed out (>%ds) — recovering [%d]" % (PANEL_TIMEOUT_S, panel_fail))
                    last_full = 0.0                       # force a full re-init next loop
                    prev_img = None                       # next diff starts clean
                    _guard(panel.init_full)               # try to un-wedge the controller now
                    time.sleep(min(30, 2 * panel_fail))   # back off a struggling panel
        elif not idle_drawn:
            # Buzzer-only mode: clear the panel once and leave it.
            panel.show_full(render.render_disabled(config.CONFIG_URL))
            idle_drawn = True
            last_full = now

        if once:
            break
        time.sleep(quick)

    # Guarded shutdown so a wedged panel.sleep() (another ReadBusy) can't hang
    # the process — otherwise `systemctl restart` waits out TimeoutStopSec and
    # the new instance collides with still-held GPIO. (v0.47.3)
    _guard(buz.close, seconds=5)
    _guard(panel.sleep, seconds=8)


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
