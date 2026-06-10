"""
Piezo buzzer driver + transit beep scheduler (Pi-side).
v0.31.9

Wiring: a piezo buzzer between a GPIO pin (default GPIO13) and GND.

Active vs passive: most piezo "Summer" are PASSIVE — they need an AC/PWM drive
to make sound (steady DC just clicks). A few are ACTIVE (built-in oscillator)
and beep on any HIGH. Driving the pin with PWM at a chosen frequency works for
BOTH: a passive element sings at that frequency, an active one beeps whenever it
is powered. So we always PWM-drive — no need to know the type up front. Run
``python3 epaper_client.py --test-buzzer`` to confirm yours and find the loudest
frequency.

Two pieces:
  * ``Buzzer``        — the hardware: PWM on a background thread so beeping never
                        blocks the display poll/render loop. No-op on a machine
                        without gpiozero/lgpio (dev box / --dry-run).
  * ``BeepScheduler`` — pure logic that turns successive /api/state snapshots
                        into beep patterns per the user's configurable cadences.
"""

import queue
import threading
import time

# gpiozero auto-selects the lgpio pin factory on the Pi 5 (RPi.GPIO does not
# work there). Absent on a dev machine → the Buzzer degrades to a silent no-op.
try:
    from gpiozero import PWMOutputDevice
    _HAVE_GPIO = True
except Exception:  # pragma: no cover - hardware-only path
    PWMOutputDevice = None
    _HAVE_GPIO = False


class Buzzer:
    """PWM-driven buzzer with a background pattern player.

    A "pattern" is a list of ``(on_s, off_s)`` tone/silence pairs. ``play()``
    enqueues one and returns immediately; the worker thread renders it. Safe to
    call on a box without GPIO — it simply does nothing (``ok`` stays False).
    """

    def __init__(self, duty=0.5):
        self.duty = duty
        self.freq = 2700.0
        self._pin = None
        self._dev = None              # opened lazily — only while enabled
        self._lock = threading.Lock()
        self._q = queue.Queue(maxsize=32)
        self._stop = threading.Event()
        self.ok = False               # True only while actively driving a pin
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    # ── hardware ──
    def _open(self, pin, freq):
        try:
            with self._lock:
                if self._dev is not None:
                    try:
                        self._dev.close()
                    except Exception:
                        pass
                self._dev = PWMOutputDevice(pin, frequency=freq, initial_value=0.0)
                self._pin = int(pin)
                self.freq = float(freq)
                self.ok = True
        except Exception:
            self._dev = None
            self.ok = False

    def apply(self, enabled, pin, freq):
        """Reconcile the hardware with the live config: open/retune the pin when
        enabled, release it when disabled — so GPIO is only claimed while audio
        is on. Safe to call every config refresh. No-op without gpiozero."""
        if not _HAVE_GPIO:
            self.ok = False
            return
        if not enabled:
            if self._dev is not None:
                with self._lock:
                    try:
                        self._dev.value = 0.0
                        self._dev.close()
                    except Exception:
                        pass
                    self._dev = None
                    self._pin = None
            self.ok = False
            return
        pin, freq = int(pin), float(freq)
        if self._dev is None or pin != self._pin:
            self._open(pin, freq)            # (re)claim the pin
        elif freq != self.freq:
            with self._lock:
                self.freq = freq
                try:
                    self._dev.frequency = freq
                except Exception:
                    pass

    def _tone_on(self, freq):
        with self._lock:
            if self._dev is not None:
                try:
                    self._dev.frequency = freq
                    self._dev.value = self.duty
                except Exception:
                    pass

    def _tone_off(self):
        with self._lock:
            if self._dev is not None:
                try:
                    self._dev.value = 0.0
                except Exception:
                    pass

    def _run(self):
        # Sleeps happen OUTSIDE the lock so reconfigure() never blocks on a tone.
        while not self._stop.is_set():
            try:
                pattern, freq = self._q.get(timeout=0.2)
            except queue.Empty:
                continue
            use_freq = float(freq) if freq else self.freq   # per-pattern override
            for on_s, off_s in pattern:
                if self._stop.is_set():
                    break
                if on_s > 0:
                    self._tone_on(use_freq)
                    time.sleep(on_s)
                    self._tone_off()
                if off_s > 0:
                    time.sleep(off_s)

    # ── api ──
    def play(self, pattern, freq=None):
        """Enqueue a pattern = list of (on_s, off_s), optionally at a specific
        frequency (Hz) instead of the default drive frequency. Dropped if the
        buzzer is disabled or the queue is full."""
        if self.ok and pattern:
            try:
                self._q.put_nowait((list(pattern), freq))
            except queue.Full:
                pass

    def close(self):
        self._stop.set()
        try:
            self._thread.join(timeout=1.0)
        except Exception:
            pass
        with self._lock:
            if self._dev is not None:
                try:
                    self._dev.value = 0.0
                    self._dev.close()
                except Exception:
                    pass


def _pattern(beeps, on_ms, gap_ms):
    """Build a (on_s, off_s)×beeps pattern from millisecond config values."""
    on_s = max(0.0, float(on_ms) / 1000.0)
    gap_s = max(0.0, float(gap_ms) / 1000.0)
    n = max(0, int(beeps))
    return [(on_s, gap_s)] * n


def test_sequence(cfg):
    """Every configured signal once, in order, as a list of (pattern, freq)
    segments — for the Settings 'Test signals' button. Separate segments so the
    lost signal can sound at its own frequency. Each is enqueued in turn, with a
    trailing gap so the groups are distinguishable."""
    cfg = cfg or {}

    def seg(beeps, on_ms, gap_ms, sep_s, freq=None):
        p = _pattern(beeps, on_ms, gap_ms)
        if p and sep_s:
            p[-1] = (p[-1][0], sep_s)          # widen the gap after the group
        return (p, freq)

    segs = [
        seg(cfg.get("newBeeps", 3),    cfg.get("newOnMs", 100),    cfg.get("newGapMs", 50), 0.7),
        seg(cfg.get("lostBeeps", 1),   cfg.get("lostOnMs", 1500),  200, 0.7, freq=cfg.get("lostFreqHz")),
        seg(cfg.get("phase1Beeps", 1), cfg.get("phase1OnMs", 500), 200, 0.5),
        seg(cfg.get("phase2Beeps", 1), cfg.get("phase2OnMs", 500), 200, 0.5),
        seg(cfg.get("phase3Beeps", 2), cfg.get("phase3OnMs", 50),  200, 0.5),
        seg(cfg.get("entryBeeps", 1),  cfg.get("entryOnMs", 5000), 200, 0.0),
    ]
    return [s for s in segs if s[0]]           # drop empty groups


class BeepScheduler:
    """Turns successive /api/state snapshots into buzzer events, all driven by
    the live `buzzer` config block (so the user tunes everything in Settings):

      * a new Real candidate appearing  → the "new" pattern
      * a candidate lost / its closest approach passing → the "lost" pattern
      * an approaching candidate closer than sepThresholdDeg → an accelerating
        countdown, one of three time-windowed phases (far / mid / near)
      * the transit entry itself → a single long "entry" blast (fires once)

    Pure logic: it only calls ``buz.play(...)``, so it is testable with a fake
    buzzer that records patterns.
    """

    def __init__(self, buz, cfg=None):
        self.buz = buz
        self.cfg = dict(cfg) if cfg else {}
        self.prev_keys = set()       # real-candidate keys seen last tick
        self.last_beep = {}          # key -> monotonic time of last countdown beep
        self.entry_fired = set()     # keys whose one-shot entry blast already fired
        self.announced = set()       # keys that got the one-shot "new candidate" beep
        self._primed = False         # suppress new/lost on the very first tick

    @staticmethod
    def _key(c):
        return "%s|%s" % (c.get("icao") or c.get("callsign") or "?", c.get("body") or "?")

    @staticmethod
    def _phase_for(eta_s, phases_asc):
        """Pick the tightest countdown window that still contains `eta_s`.
        `phases_asc` is sorted ascending by window start. Returns
        (everyS, beeps, onMs) or None when out of all windows / already past."""
        if eta_s < 0:
            return None
        for before_s, every_s, beeps, on_ms in phases_asc:
            if eta_s <= before_s:
                return (every_s, beeps, on_ms)
        return None

    def update(self, state, mono):
        """Process one snapshot at monotonic time `mono`."""
        cfg = self.cfg or {}
        now_ms = state.get("nowMs") or 0
        cands = state.get("candidates") or []
        cur = {self._key(c): c for c in cands}
        cur_keys = set(cur)

        # "New candidate" signal: fire once per candidate, but only once it is
        # within `newEtaMaxS` of closest approach — so a candidate many minutes
        # out doesn't beep. Works whether it appears already inside the window
        # or counts down into it. On the first tick we populate `announced`
        # silently (no startup burst).
        new_eta_max = cfg.get("newEtaMaxS", 120)
        for k, c in cur.items():
            at = c.get("closestApproachAtMs")
            if at is None or k in self.announced:
                continue
            eta = (at - now_ms) / 1000.0
            if 0 <= eta <= new_eta_max:
                if self._primed:
                    self.buz.play(_pattern(cfg.get("newBeeps", 3),
                                           cfg.get("newOnMs", 100), cfg.get("newGapMs", 50)))
                self.announced.add(k)

        # "Lost / past" signal: a previously-announced candidate vanished.
        # Played at its own frequency (default 1000 Hz) so it sounds distinct.
        lost = self.prev_keys - cur_keys
        if self._primed and any(k in self.announced for k in lost):
            self.buz.play(_pattern(cfg.get("lostBeeps", 1), cfg.get("lostOnMs", 1500), 200),
                          freq=cfg.get("lostFreqHz"))
        for k in lost:
            self.last_beep.pop(k, None)
            self.entry_fired.discard(k)
            self.announced.discard(k)
        self._primed = True

        # Accelerating countdown for close, approaching candidates.
        sep_th = cfg.get("sepThresholdDeg", 0.3)
        phases = sorted([
            (cfg.get("phase1BeforeS", 40), cfg.get("phase1EveryS", 10),
             cfg.get("phase1Beeps", 1), cfg.get("phase1OnMs", 500)),
            (cfg.get("phase2BeforeS", 15), cfg.get("phase2EveryS", 5),
             cfg.get("phase2Beeps", 1), cfg.get("phase2OnMs", 500)),
            (cfg.get("phase3BeforeS", 8), cfg.get("phase3EveryS", 2),
             cfg.get("phase3Beeps", 1), cfg.get("phase3OnMs", 500)),
        ])  # ascending by window start
        entry_before = cfg.get("entryBeforeS", 2)
        for k, c in cur.items():
            sep = c.get("closestApproachSepDeg")
            at = c.get("closestApproachAtMs")
            if sep is None or at is None or sep >= sep_th:
                continue

            # Entry blast: one long beep at the transit itself. `entersAtMs` is
            # when the path enters the disc (≈ closest for fast aircraft); fall
            # back to closest if the feed doesn't carry it. Fires once per key,
            # and takes over from the countdown for that contact.
            enters = c.get("entersAtMs")
            if enters is None:
                enters = at
            eta_entry = (enters - now_ms) / 1000.0
            if k in self.entry_fired:
                continue  # entry already signalled → no more beeps for this contact
            if -entry_before <= eta_entry <= entry_before:
                self.buz.play(_pattern(cfg.get("entryBeeps", 1), cfg.get("entryOnMs", 5000), 200))
                self.entry_fired.add(k)
                continue

            # Otherwise: the accelerating pre-transit countdown (by time-to-closest).
            eta_s = (at - now_ms) / 1000.0
            ph = self._phase_for(eta_s, phases)
            if ph is None:
                continue
            every_s, beeps, on_ms = ph
            # The poll loop bounds resolution: we can't beep faster than a tick.
            if mono - self.last_beep.get(k, -1e9) >= every_s - 0.25:
                self.buz.play(_pattern(beeps, on_ms, 200))
                self.last_beep[k] = mono

        self.prev_keys = cur_keys


def selftest(pin=13, freq=2700):
    """Standalone diagnostic: a DC test, a PWM tone, then a frequency sweep — so
    the user can confirm the buzzer works, tell active from passive, and find the
    loudest tone. Called by ``epaper_client.py --test-buzzer``."""
    if not _HAVE_GPIO:
        print("[buzzer] gpiozero/lgpio not available here — run this on the Pi.")
        return
    from gpiozero import DigitalOutputDevice  # local import: hardware-only
    print("[buzzer] pin GPIO%d" % pin)
    print("[buzzer] 1) steady DC for 1 s — an ACTIVE buzzer beeps; a PASSIVE one is ~silent/clicks")
    try:
        d = DigitalOutputDevice(pin)
        d.on(); time.sleep(1.0); d.off(); d.close()
    except Exception as e:
        print("[buzzer]   DC test failed: %s" % e)
    time.sleep(0.4)
    p = PWMOutputDevice(pin, frequency=freq, initial_value=0.0)
    print("[buzzer] 2) PWM tone at %d Hz for 1 s — a PASSIVE buzzer sings here" % freq)
    p.value = 0.5; time.sleep(1.0); p.value = 0.0
    time.sleep(0.3)
    print("[buzzer] 3) frequency sweep — note which is loudest, set it as Drive frequency:")
    for f in (1000, 1500, 2000, 2500, 2700, 3000, 3500, 4000, 5000):
        p.frequency = f
        print("[buzzer]    %d Hz" % f)
        p.value = 0.5; time.sleep(0.6); p.value = 0.0; time.sleep(0.2)
    p.close()
    print("[buzzer] done. Only step 1 → active buzzer. Steps 2/3 → passive (use Drive frequency).")
