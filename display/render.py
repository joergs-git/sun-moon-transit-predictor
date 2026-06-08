"""
Pillow renderer for the 4.2" e-paper panel (400×300, 1-bit black/white).
v0.31.0

render_state() turns an /api/state snapshot + the live `display` config into a
PIL Image. The layout is deliberately monospace so columns self-align. Two
modes:

  * Default (compactList=false): two lines per candidate (all fields legible)
    plus a Sky-now / FOV footer.
  * Compact (compactList=true):   one line per candidate, no footer — fits more
    rows on the same panel.

This module never touches hardware; epaper_client.py owns the panel. That keeps
rendering testable on any machine via the client's --dry-run flag.
"""

import os
import time

from PIL import Image, ImageDraw, ImageFont

import fov

# Panel geometry (landscape).
WIDTH = 400
HEIGHT = 300

# 1-bit palette: 0 = black ink, 255 = white background.
BLACK = 0
WHITE = 255

# Candidate font widths are budgeted around ~7.8 px/char at size 13 (DejaVu
# Sans Mono), which keeps the widest row inside WIDTH with margin.

# Font candidates, tried in order. DejaVu ships on Raspberry Pi OS; the macOS
# paths let the renderer run for --dry-run previews during development.
_MONO_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Monaco.ttf",
    "/Library/Fonts/Courier New.ttf",
]

_font_cache = {}


def _font(size):
    """Load a monospace TTF at the given size (cached), with PIL fallback."""
    if size in _font_cache:
        return _font_cache[size]
    font = None
    for path in _MONO_FONTS:
        if os.path.exists(path):
            try:
                font = ImageFont.truetype(path, size)
                break
            except Exception:
                continue
    if font is None:
        # Last resort — bitmap default (no scaling, no ° glyph, but never fails).
        font = ImageFont.load_default()
    _font_cache[size] = font
    return font


# ── Field formatting ───────────────────────────────────────────────────────

def _fmt_lat(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "?"
    return "%.2f°%s" % (abs(v), "N" if v >= 0 else "S")


def _fmt_lon(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "?"
    return "%.2f°%s" % (abs(v), "E" if v >= 0 else "W")


def _fmt_eta(ms_to_closest):
    """T-minus string from milliseconds-to-closest-approach (T+ if past)."""
    if ms_to_closest is None:
        return "--"
    s = int(round(ms_to_closest / 1000.0))
    sign = "T-" if s >= 0 else "T+"
    s = abs(s)
    core = "%ds" % s if s < 60 else "%d:%02d" % (s // 60, s % 60)
    return sign + core


def _num(v):
    """Coerce to float or return None (covers missing/null state fields)."""
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _candidate_view(c, now_ms):
    """Flatten one /api/state candidate into display-ready strings (metric)."""
    ac = c.get("aircraftAtClosest") or {}
    cs = (c.get("callsign") or c.get("flight") or c.get("icao") or "?").strip()

    at_ms = _num(c.get("closestApproachAtMs"))
    eta = _fmt_eta((at_ms - now_ms)) if at_ms is not None else "--"

    sep = _num(c.get("closestApproachSepDeg"))
    sep_s = "%.2f°" % sep if sep is not None else "--"

    el = _num(c.get("closestApproachElDeg"))
    if el is None:
        el = _num(ac.get("elevationDeg"))
    el_s = "el%d°" % round(el) if el is not None else "el--"

    alt = _num(ac.get("altMmsl"))
    alt_s = "%dm" % round(alt) if alt is not None else "--"

    spd = _num(ac.get("groundSpeedMs"))
    spd_s = "%dkm/h" % round(spd * 3.6) if spd is not None else "--"

    dist = _num(ac.get("rangeM"))
    dist_s = "%dkm" % round(dist / 1000.0) if dist is not None else "--"

    body = c.get("body") or ""
    return {
        "cs": cs[:7],
        "body": body,
        "bsym": "S" if body == "Sun" else ("M" if body == "Moon" else "?"),
        "eta": eta,
        "sep": sep_s,
        "el": el_s,
        "alt": alt_s,
        "spd": spd_s,
        "dist": dist_s,
        # raw numbers kept for the FOV preview
        "az": _num(c.get("closestApproachAzDeg")) or _num(ac.get("azimuthDeg")),
        "el_raw": el,
    }


def _sorted_candidates(state, limit):
    """The soonest `limit` real candidates, sorted by ETA, recent past dropped."""
    now_ms = _num(state.get("nowMs")) or (time.time() * 1000.0)
    cands = state.get("candidates") or []
    # Keep upcoming + just-passed (within 60 s) so a transit at the moment of
    # closest approach doesn't blink out of the list.
    def at(c):
        v = _num(c.get("closestApproachAtMs"))
        return v if v is not None else float("inf")
    fresh = [c for c in cands if (at(c) - now_ms) > -60_000]
    fresh.sort(key=at)
    return [_candidate_view(c, now_ms) for c in fresh[:limit]], now_ms


# ── Drawing ─────────────────────────────────────────────────────────────────

def _header(draw, state):
    """Top two lines: clock + LIVE count, date + CAND count, observer coords."""
    obs = state.get("observer") or {}
    live = state.get("aircraftCount")
    if live is None:
        live = len(state.get("totalLive") or [])
    cand = len(state.get("candidates") or [])

    # Local wall clock — the panel is a clock first and foremost.
    lt = time.localtime()
    clock = time.strftime("%H:%M:%S", lt)
    date = time.strftime("%a %d.%m.%Y", lt)

    draw.text((4, 0), clock, font=_font(20), fill=BLACK)
    _right(draw, WIDTH - 4, 3, "LIVE %d" % live, _font(15))

    draw.text((4, 26), date, font=_font(13), fill=BLACK)
    _right(draw, WIDTH - 4, 26, "CAND %d" % cand, _font(13))

    name = (obs.get("name") or "").strip()
    coords = "%s  %s" % (_fmt_lat(obs.get("latitudeDeg")), _fmt_lon(obs.get("longitudeDeg")))
    line = ("%s  %s" % (name, coords)).strip() if name else coords
    draw.text((4, 43), line[:46], font=_font(12), fill=BLACK)

    draw.line((0, 60, WIDTH, 60), fill=BLACK, width=1)


def _right(draw, x_right, y, text, font):
    """Right-align `text` so it ends at x_right."""
    w = draw.textlength(text, font=font)
    draw.text((x_right - w, y), text, font=font, fill=BLACK)


def _candidate_list(draw, views, compact):
    """Render the Real-candidates list; returns the y where it ends."""
    draw.text((4, 64), "REAL CANDIDATES", font=_font(12), fill=BLACK)
    y = 80
    if not views:
        draw.text((10, y), "— none right now —", font=_font(13), fill=BLACK)
        return y + 18

    if compact:
        f = _font(13)
        for i, v in enumerate(views, 1):
            row = "%d %-7s%s %6s %6s %6s %7s %5s" % (
                i, v["cs"], v["bsym"], v["eta"], v["sep"], v["alt"], v["spd"], v["dist"],
            )
            draw.text((4, y), row, font=f, fill=BLACK)
            y += 18
        return y

    fa = _font(13)
    fb = _font(12)
    for i, v in enumerate(views, 1):
        row_a = "%d %-7s %-4s %7s %6s %5s" % (i, v["cs"], v["body"], v["eta"], v["sep"], v["el"])
        row_b = "    %7s  %8s  %6s" % (v["alt"], v["spd"], v["dist"])
        draw.text((4, y), row_a, font=fa, fill=BLACK)
        draw.text((4, y + 15), row_b, font=fb, fill=BLACK)
        y += 31
    return y


def _footer(draw, state, views):
    """Bottom band: Sky-now (left) + FOV preview of candidate #1 (right)."""
    top = 212
    draw.line((0, top - 4, WIDTH, top - 4), fill=BLACK, width=1)

    # ── Sky now (left half) ──
    bodies = state.get("bodies") or {}
    f = _font(12)
    yy = top
    draw.text((4, yy - 2), "SKY NOW", font=_font(11), fill=BLACK)
    yy += 14
    for name, sym in (("Sun", "Sun "), ("Moon", "Moon")):
        b = bodies.get(name) or {}
        az = _num(b.get("azimuthDeg"))
        el = _num(b.get("elevationDeg"))
        ok = "+" if b.get("observable") else "-"
        if az is None or el is None:
            txt = "%s  --" % sym
        else:
            txt = "%s az%03d el%02d %s" % (sym, round(az), round(el), ok)
        draw.text((4, yy), txt, font=f, fill=BLACK)
        yy += 16

    # ── FOV preview (right half) ──
    bx0, by0, bx1, by1 = 210, top + 12, WIDTH - 6, HEIGHT - 6
    draw.text((bx0, top - 2), "FOV", font=_font(11), fill=BLACK)
    draw.rectangle((bx0, by0, bx1, by1), outline=BLACK)
    cx = (bx0 + bx1) / 2.0
    cy = (by0 + by1) / 2.0

    if not views:
        return
    v = views[0]
    body = v["body"]
    b = bodies.get(body) or {}
    body_az = _num(b.get("azimuthDeg"))
    body_el = _num(b.get("elevationDeg"))
    range_m = _num(b.get("rangeM"))
    optics = state.get("optics") or {}
    fov_w = fov.fov_deg(_num(optics.get("telescopeFocalMm")), _num(optics.get("sensorWmm")))
    if not fov_w:
        fov_w = 1.0  # ~1° default frame if optics missing
    box_w = bx1 - bx0
    px_per_deg = box_w / fov_w

    # Body disc, centred.
    disc_deg = fov.body_disc_deg(body, range_m) if range_m else 0.5
    r = max(2.0, (disc_deg / 2.0) * px_per_deg)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=BLACK)

    # Candidate marker, offset from the disc centre.
    if body_az is not None and body_el is not None and v["az"] is not None and v["el_raw"] is not None:
        dx, dy = fov.offset_deg(body_az, body_el, v["az"], v["el_raw"])
        px, py = fov.deg_to_px(dx, dy, cx, cy, px_per_deg)
        # Clamp inside the box so a far candidate still shows at the edge.
        px = min(max(px, bx0 + 2), bx1 - 2)
        py = min(max(py, by0 + 2), by1 - 2)
        draw.line((px - 4, py, px + 4, py), fill=BLACK, width=1)
        draw.line((px, py - 4, px, py + 4), fill=BLACK, width=1)


def render_state(state, display_cfg):
    """Render a full /api/state snapshot to a 1-bit PIL Image."""
    img = Image.new("1", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)

    compact = bool(display_cfg.get("compactList"))
    count = int(display_cfg.get("candidateCount") or 3)
    count = max(1, min(6, count))

    _header(draw, state)
    views, _now = _sorted_candidates(state, count)
    _candidate_list(draw, views, compact)
    if not compact:
        _footer(draw, state, views)
    return img


def render_offline(source_url, reason=""):
    """Render the 'data source unreachable' screen."""
    img = Image.new("1", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)
    clock = time.strftime("%H:%M:%S")
    msg = "SERVER OFFLINE"
    f = _font(28)
    w = draw.textlength(msg, font=f)
    draw.text(((WIDTH - w) / 2, 90), msg, font=f, fill=BLACK)
    sub = source_url
    fs = _font(13)
    ws = draw.textlength(sub, font=fs)
    draw.text(((WIDTH - ws) / 2, 140), sub, font=fs, fill=BLACK)
    draw.text((4, HEIGHT - 22), "last try %s" % clock, font=_font(12), fill=BLACK)
    if reason:
        draw.text((4, HEIGHT - 40), reason[:48], font=_font(11), fill=BLACK)
    return img


def render_disabled():
    """Render a minimal 'display off' screen (drawn once, then idle)."""
    img = Image.new("1", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)
    msg = "display disabled"
    f = _font(18)
    w = draw.textlength(msg, font=f)
    draw.text(((WIDTH - w) / 2, 130), msg, font=f, fill=BLACK)
    sub = "enable in web Settings > E-paper display"
    fs = _font(11)
    ws = draw.textlength(sub, font=fs)
    draw.text(((WIDTH - ws) / 2, 158), sub, font=fs, fill=BLACK)
    return img
