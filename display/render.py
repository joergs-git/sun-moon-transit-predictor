"""
Pillow renderer for the 4.2" e-paper panel (400×300, 1-bit black/white).
v0.31.2

render_state() turns an /api/state snapshot into a PIL Image. The layout is
deliberately monospace so columns self-align, and fixed into three paragraphs:

  1. Header line  — bold clock · date · place · GPS (left) / LIVE · CAND (right)
  2. Primary block — the #1 Real candidate in detail (left) + FOV frame (right)
  3. Bottom block  — Sky-now (left) + the next candidates, or the tracked
     aircraft when there are none, as a compact list (right)

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
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Monaco.ttf",
    "/Library/Fonts/Courier New.ttf",
]

# Bold faces, tried first when bold=True is requested (the clock in the header
# is bold). On the Pi the DejaVu bold TTF exists; the macOS fallbacks keep
# --dry-run previews working even if they resolve to a regular weight.
_MONO_FONTS_BOLD = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Monaco.ttf",
    "/Library/Fonts/Courier New Bold.ttf",
]

_font_cache = {}


def _font(size, bold=False):
    """Load a monospace TTF at the given size (cached), with PIL fallback."""
    key = (size, bool(bold))
    if key in _font_cache:
        return _font_cache[key]
    font = None
    for path in (_MONO_FONTS_BOLD if bold else _MONO_FONTS):
        if os.path.exists(path):
            try:
                font = ImageFont.truetype(path, size)
                break
            except Exception:
                continue
    if font is None:
        # Last resort — bitmap default (no scaling, no ° glyph, but never fails).
        font = ImageFont.load_default()
    _font_cache[key] = font
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


def _fmt_lat_compact(v):
    """Latitude without the ° glyph — saves width on the one-line header."""
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "?"
    return "%.2f%s" % (abs(v), "N" if v >= 0 else "S")


def _fmt_lon_compact(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return "?"
    return "%.2f%s" % (abs(v), "E" if v >= 0 else "W")


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

def _right(draw, x_right, y, text, font):
    """Right-align `text` so it ends at x_right."""
    w = draw.textlength(text, font=font)
    draw.text((x_right - w, y), text, font=font, fill=BLACK)


# Block boundaries (y) for the three-paragraph grid. The panel is 400×300.
_HDR_RULE = 27         # divider under the header line
_BLK2_RULE = 154       # divider between the candidate/FOV block and the bottom


def _header(draw, state):
    """Paragraph 1 — one line: bold clock · date · place · GPS (left), and
    LIVE / CAND counts (right). A single rule closes the band off."""
    obs = state.get("observer") or {}
    live = state.get("aircraftCount")
    if live is None:
        live = len(state.get("lifecycle") or [])
    cand = len(state.get("candidates") or [])

    lt = time.localtime()
    clock = time.strftime("%H:%M:%S", lt)
    date = time.strftime("%d.%m.%y", lt)

    # Bold clock anchors the line; everything else trails in a smaller face,
    # vertically centred against the clock so the row reads as one unit.
    fc = _font(18, bold=True)
    draw.text((4, 1), clock, font=fc, fill=BLACK)
    x_after_clock = 4 + draw.textlength(clock, font=fc) + 8

    # Right cluster first, so we know how much room the trail has.
    fs = _font(12)
    right = "LIVE %d  CAND %d" % (live, cand)
    right_w = draw.textlength(right, font=fs)
    right_x = WIDTH - 4 - right_w
    draw.text((right_x, 7), right, font=fs, fill=BLACK)

    # Left trail: date · place · GPS. GPS is rendered without the ° sign here to
    # save width on the single line. If the trail would collide with the right
    # cluster, drop the place name, then shrink the font a step — so a long site
    # name never pushes the counts off-panel.
    name = (obs.get("name") or "").strip()
    gps = "%s %s" % (_fmt_lat_compact(obs.get("latitudeDeg")),
                     _fmt_lon_compact(obs.get("longitudeDeg")))
    # Prefer keeping all three pieces (date · place · GPS), shrinking the font
    # down to 10 px before sacrificing the place name — so the place survives on
    # the Pi's narrow DejaVu mono even though it can't fit at the larger sizes.
    avail = right_x - 6 - x_after_clock
    for parts, size in (
        ((date, name, gps), 12),
        ((date, name, gps), 11),
        ((date, name, gps), 10),
        ((date, gps), 11),
        ((date, gps), 10),
    ):
        f = _font(size)
        trail = "  ".join(p for p in parts if p)
        if draw.textlength(trail, font=f) <= avail:
            break
    draw.text((x_after_clock, 8), trail, font=f, fill=BLACK)

    draw.line((0, _HDR_RULE, WIDTH, _HDR_RULE), fill=BLACK, width=1)


def _draw_fov(draw, state, view, box):
    """Draw the FOV frame (body disc + candidate marker) inside `box`."""
    bx0, by0, bx1, by1 = box
    draw.rectangle((bx0, by0, bx1, by1), outline=BLACK)
    if not view:
        return
    cx = (bx0 + bx1) / 2.0
    cy = (by0 + by1) / 2.0

    body = view["body"]
    b = (state.get("bodies") or {}).get(body) or {}
    body_az = _num(b.get("azimuthDeg"))
    body_el = _num(b.get("elevationDeg"))
    range_m = _num(b.get("rangeM"))
    optics = state.get("optics") or {}
    fov_w = fov.fov_deg(_num(optics.get("telescopeFocalMm")), _num(optics.get("sensorWmm")))
    if not fov_w:
        fov_w = 1.0  # ~1° default frame if optics missing
    px_per_deg = (bx1 - bx0) / fov_w

    # Body disc, centred.
    disc_deg = fov.body_disc_deg(body, range_m) if range_m else 0.5
    r = max(2.0, (disc_deg / 2.0) * px_per_deg)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=BLACK)

    # Candidate marker, offset from the disc centre, clamped into the frame.
    if body_az is not None and body_el is not None and view["az"] is not None and view["el_raw"] is not None:
        dx, dy = fov.offset_deg(body_az, body_el, view["az"], view["el_raw"])
        px, py = fov.deg_to_px(dx, dy, cx, cy, px_per_deg)
        px = min(max(px, bx0 + 2), bx1 - 2)
        py = min(max(py, by0 + 2), by1 - 2)
        draw.line((px - 4, py, px + 4, py), fill=BLACK, width=1)
        draw.line((px, py - 4, px, py + 4), fill=BLACK, width=1)


def _primary(draw, state, views):
    """Paragraph 2 — nearest real candidate's detail (left) + FOV frame (right)."""
    y0 = 32
    draw.text((4, y0), "REAL CANDIDATE", font=_font(11), fill=BLACK)

    # FOV frame on the right half.
    bx0, by0, bx1, by1 = 250, y0 + 16, WIDTH - 6, _BLK2_RULE - 4
    draw.text((bx0, y0), "FOV", font=_font(11), fill=BLACK)

    if not views:
        draw.text((10, y0 + 26), "— none right now —", font=_font(13), fill=BLACK)
        _draw_fov(draw, state, None, (bx0, by0, bx1, by1))
        return

    v = views[0]
    draw.text((4, y0 + 16), "%s  %s" % (v["cs"], v["body"]), font=_font(15, bold=True), fill=BLACK)
    f = _font(12)
    rows = [
        "ETA  %s" % v["eta"],
        "sep  %s  %s" % (v["sep"], v["el"]),
        "alt  %s" % v["alt"],
        "spd  %s" % v["spd"],
        "dist %s" % v["dist"],
    ]
    yy = y0 + 40
    for r in rows:
        draw.text((6, yy), r, font=f, fill=BLACK)
        yy += 16

    _draw_fov(draw, state, v, (bx0, by0, bx1, by1))


def _list_section(state, primary_views):
    """The right-hand list for paragraph 3.

    With real candidates present, list the ones *after* the detailed #1 (so the
    nearest never repeats); numbering continues from 2. With no candidates at
    all, fall back to the tracked aircraft from `lifecycle` (the only
    aircraft-keyed list in /api/state), numbered from 1.
    Returns (views, heading, start_index).
    """
    if state.get("candidates"):
        return primary_views[1:4], "NEXT CANDIDATES", 2
    return _aircraft_views(state, 3), "AIRCRAFT", 1


def _aircraft_views(state, limit):
    """Flatten the soonest `limit` non-stale lifecycle entries to list rows."""
    now_ms = _num(state.get("nowMs")) or (time.time() * 1000.0)

    def at(e):
        v = _num(e.get("closestApproachAtMs"))
        return v if v is not None else float("inf")

    entries = [e for e in (state.get("lifecycle") or [])
               if e.get("status") != "stale" and (at(e) - now_ms) > -60_000]
    entries.sort(key=at)

    out = []
    for e in entries[:limit]:
        cs = (e.get("callsign") or e.get("flight") or e.get("icao") or "?").strip()
        body = e.get("body") or ""
        sep = _num(e.get("closestApproachSepDeg"))
        out.append({
            "cs": cs[:7],
            "bsym": "S" if body == "Sun" else ("M" if body == "Moon" else "?"),
            "eta": _fmt_eta(at(e) - now_ms) if at(e) != float("inf") else "--",
            "sep": "%.2f°" % sep if sep is not None else "--",
        })
    return out


def _sky_and_list(draw, state, views):
    """Paragraph 3 — Sky-now (left) + next-candidates / aircraft list (right)."""
    draw.line((0, _BLK2_RULE, WIDTH, _BLK2_RULE), fill=BLACK, width=1)
    top = _BLK2_RULE + 6
    f = _font(12)

    # ── Left: SKY NOW ──
    draw.text((4, top), "SKY NOW", font=_font(11), fill=BLACK)
    bodies = state.get("bodies") or {}
    ly = top + 16
    for name, sym in (("Sun", "Sun "), ("Moon", "Moon")):
        b = bodies.get(name) or {}
        az = _num(b.get("azimuthDeg"))
        el = _num(b.get("elevationDeg"))
        ok = "+" if b.get("observable") else "-"
        if az is None or el is None:
            txt = "%s --" % sym
        else:
            txt = "%s az%03d el%02d %s" % (sym, round(az), round(el), ok)
        draw.text((4, ly), txt, font=f, fill=BLACK)
        ly += 16

    # ── Right: next candidates, or aircraft when there are none ──
    rx = 206
    list_views, heading, start = _list_section(state, views)
    draw.text((rx, top), heading, font=_font(11), fill=BLACK)
    ry = top + 16
    if not list_views:
        draw.text((rx + 4, ry), "— none —", font=f, fill=BLACK)
        return
    for i, v in enumerate(list_views, start):
        row = "%d %-7s%s %6s %6s" % (i, v["cs"], v["bsym"], v["eta"], v["sep"])
        draw.text((rx, ry), row, font=f, fill=BLACK)
        ry += 16


def render_state(state, display_cfg=None):
    """Render a full /api/state snapshot to a 1-bit PIL Image.

    Fixed three-paragraph grid — the layout is not configurable (it always shows
    the #1 candidate in detail plus up to three more in the bottom list), so
    `display_cfg` is accepted for call-site compatibility but unused:
      1) header line   — clock · date · place · GPS / LIVE · CAND
      2) primary block — nearest candidate detail + FOV frame
      3) bottom block  — Sky-now + next-candidates (or aircraft) list
    """
    img = Image.new("1", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)

    # #1 gets the detailed block; up to three more fill the bottom list.
    views, _now = _sorted_candidates(state, 4)

    _header(draw, state)
    _primary(draw, state, views)
    _sky_and_list(draw, state, views)
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
