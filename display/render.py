"""
Pillow renderer for the 4.2" e-paper panel (400×300, 1-bit black/white).
v0.31.4

render_state() turns an /api/state snapshot into a PIL Image. The layout is
deliberately monospace so columns self-align, and fixed into three paragraphs
with large, legible body text (ETA / SEP are the headline figures):

  1. Header (two lines) — clock · date / LIVE · CAND, then place · GPS
  2. Primary block — the nearest tracked plane in detail, ETA/SEP big + bold
     (left) + a large FOV frame (right)
  3. Bottom block  — Sky-now (left) + the next tracked planes (right)

Planes come from the unified `lifecycle` list (the superset of everything the
panel tracks; Real candidates float to the top), so the panel shows traffic
even when nothing currently qualifies as a Real candidate.

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


def _route_str(route):
    """Format a route dict ({origin,destination}) as 'AAA→BBB' (IATA or ICAO)."""
    route = route or {}
    o = route.get("origin") or {}
    d = route.get("destination") or {}
    a = o.get("iata") or o.get("icao")
    b = d.get("iata") or d.get("icao")
    if a and b:
        return "%s→%s" % (a, b)
    return a or b or "—"


def _make_view(meta, cand, now_ms):
    """Flatten one tracked plane into display-ready strings (all metric).

    `meta` carries the identity/closest-approach summary (a lifecycle entry or
    a raw candidate); `cand` carries the raw tracker geometry (aircraftAtClosest
    az/el/range + the raw ADS-B aircraft for altitude/speed/track). The two can
    be the same object (candidates[]) or entry + entry.candidate (lifecycle).
    """
    cand = cand or {}
    ac = cand.get("aircraft") or {}            # raw ADS-B → alt / speed / track
    azel = cand.get("aircraftAtClosest") or {}  # topocentric az / el / range

    cs = (meta.get("callsign") or meta.get("flight") or meta.get("icao") or "?").strip()
    body = meta.get("body") or cand.get("body") or ""

    at = _num(meta.get("closestApproachAtMs"))
    if at is None:
        at = _num(cand.get("closestApproachAtMs"))
    sep = _num(meta.get("closestApproachSepDeg"))
    if sep is None:
        sep = _num(cand.get("closestApproachSepDeg"))

    el = _num(azel.get("elevationDeg"))
    az = _num(azel.get("azimuthDeg"))
    dist = _num(azel.get("rangeM"))
    alt = _num(ac.get("altMmsl"))         # altitude is on the ADS-B record…
    spd = _num(ac.get("groundSpeedMs"))   # …not on the az/el closest-point dict
    trk = _num(ac.get("trackDeg"))

    return {
        "cs": cs[:8],
        "body": body,
        "bsym": "S" if body == "Sun" else ("M" if body == "Moon" else "?"),
        "eta": _fmt_eta(at - now_ms) if at is not None else "--",
        "sep": "%.2f°" % sep if sep is not None else "--",
        "sep_num": sep,
        "el": "el%d°" % round(el) if el is not None else "el--",
        "alt": "%dm" % round(alt) if alt is not None else "--",
        "spd": "%dkm/h" % round(spd * 3.6) if spd is not None else "--",
        "dist": "%dkm" % round(dist / 1000.0) if dist is not None else "--",
        "brg": "%03d°" % round(trk) if trk is not None else "--",
        "route": _route_str(meta.get("route") or cand.get("route")),
        # raw numbers kept for the FOV preview
        "az": az,
        "el_raw": el,
        # candidate/imminent → a true "Real candidate"; radio/planned/stale → not
        "is_real": meta.get("status") in ("candidate", "imminent"),
    }


def _pool(state):
    """Unified list of tracked-plane views, nearest (smallest sep) first.

    The lifecycle list is the superset of everything the panel tracks — real
    candidates are simply the entries whose status reached candidate/imminent —
    so we build the panel's planes from it and never show an empty list while
    aircraft are still being tracked. Real candidates float to the top, then
    ties break by separation. Falls back to the raw candidates[] array only if
    lifecycle is somehow absent.
    """
    now_ms = _num(state.get("nowMs")) or (time.time() * 1000.0)

    lifecycle = state.get("lifecycle") or []
    if lifecycle:
        views = [_make_view(e, e.get("candidate"), now_ms) for e in lifecycle]
    else:
        views = [_make_view(c, c, now_ms) for c in (state.get("candidates") or [])]

    INF = float("inf")
    views.sort(key=lambda v: (0 if v["is_real"] else 1,
                              v["sep_num"] if v["sep_num"] is not None else INF))
    return views, now_ms


# ── Drawing ─────────────────────────────────────────────────────────────────

def _right(draw, x_right, y, text, font):
    """Right-align `text` so it ends at x_right."""
    w = draw.textlength(text, font=font)
    draw.text((x_right - w, y), text, font=font, fill=BLACK)


# Block boundaries (y) for the three-paragraph grid. The panel is 400×300.
# Generous bands so the body text can be large and legible from across a room.
# The header is two lines (clock/date/counts, then place/GPS) so everything
# stays at a readable size — nothing has to shrink to fit one line.
_HDR_RULE = 46          # divider under the two-line header
_BLK2_RULE = 178        # divider between the candidate/FOV block and the bottom


def _header(draw, state):
    """Paragraph 1 — two lines, all at a readable size:
      line 1: big bold clock · date (left)        · LIVE / CAND (right)
      line 2: place · GPS (left)
    """
    obs = state.get("observer") or {}
    live = state.get("aircraftCount")
    if live is None:
        live = len(state.get("lifecycle") or [])
    cand = len(state.get("candidates") or [])

    lt = time.localtime()
    clock = time.strftime("%H:%M:%S", lt)
    date = time.strftime("%d.%m.%y", lt)

    # ── Line 1: big bold clock, date, and the LIVE / CAND counts on the right ──
    fc = _font(20, bold=True)
    draw.text((4, 1), clock, font=fc, fill=BLACK)
    x = 4 + draw.textlength(clock, font=fc) + 12
    draw.text((x, 8), date, font=_font(14), fill=BLACK)
    _right(draw, WIDTH - 4, 8, "LIVE %d  CAND %d" % (live, cand), _font(14, bold=True))

    # ── Line 2: place + full GPS (with ° — there's room now) ──
    name = (obs.get("name") or "").strip()
    gps = "%s  %s" % (_fmt_lat(obs.get("latitudeDeg")), _fmt_lon(obs.get("longitudeDeg")))
    line2 = ("%s   %s" % (name, gps)) if name else gps
    draw.text((4, 27), line2, font=_font(14), fill=BLACK)

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

    # Body disc, centred. Filled so it reads as a clear solid Sun/Moon on e-ink.
    disc_deg = fov.body_disc_deg(body, range_m) if range_m else 0.5
    r = max(3.0, (disc_deg / 2.0) * px_per_deg)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=BLACK)

    # Candidate marker, offset from the disc centre, clamped into the frame.
    if body_az is not None and body_el is not None and view["az"] is not None and view["el_raw"] is not None:
        dx, dy = fov.offset_deg(body_az, body_el, view["az"], view["el_raw"])
        px, py = fov.deg_to_px(dx, dy, cx, cy, px_per_deg)
        px = min(max(px, bx0 + 3), bx1 - 3)
        py = min(max(py, by0 + 3), by1 - 3)
        # A small filled plane marker — a bold plus, thicker than before.
        draw.line((px - 6, py, px + 6, py), fill=BLACK, width=2)
        draw.line((px, py - 6, px, py + 6), fill=BLACK, width=2)


def _primary(draw, state, view):
    """Paragraph 2 — the nearest plane in detail (left) + a large FOV frame
    (right). ETA and SEP are the headline figures (big + bold); route, bearing,
    distance, altitude and speed print small underneath."""
    y0 = 50
    bx0, by0, bx1, by1 = 240, 58, WIDTH - 6, _BLK2_RULE - 6
    draw.text((bx0, y0), "FOV", font=_font(12), fill=BLACK)

    if not view:
        draw.text((4, y0), "NEAREST PLANE", font=_font(12), fill=BLACK)
        draw.text((6, y0 + 26), "— none right now —", font=_font(16), fill=BLACK)
        _draw_fov(draw, state, None, (bx0, by0, bx1, by1))
        return

    heading = "REAL CANDIDATE" if view["is_real"] else "NEAREST PLANE"
    draw.text((4, y0), heading, font=_font(12), fill=BLACK)

    # Callsign + body, bold.
    draw.text((4, y0 + 14), "%s %s" % (view["cs"], view["body"]),
              font=_font(19, bold=True), fill=BLACK)

    # Headline figures: ETA and SEP, big and bold, with small labels.
    fbig = _font(24, bold=True)
    flbl = _font(13)
    draw.text((4, 96), "ETA", font=flbl, fill=BLACK)
    draw.text((52, 91), view["eta"], font=fbig, fill=BLACK)
    draw.text((4, 124), "SEP", font=flbl, fill=BLACK)
    draw.text((52, 119), view["sep"], font=fbig, fill=BLACK)

    # Secondary fields, small: route + bearing, then distance / altitude / speed.
    fsm = _font(12)
    draw.text((4, 150), "%s  brg %s" % (view["route"], view["brg"]), font=fsm, fill=BLACK)
    draw.text((4, 164), "%s  %s  %s" % (view["dist"], view["alt"], view["spd"]), font=fsm, fill=BLACK)

    _draw_fov(draw, state, view, (bx0, by0, bx1, by1))


def _sky_and_list(draw, state, pool):
    """Paragraph 3 — Sky-now (left) + the next tracked planes (right), both in a
    larger, legible face. The list shows the planes after the detailed #1."""
    draw.line((0, _BLK2_RULE, WIDTH, _BLK2_RULE), fill=BLACK, width=1)
    top = _BLK2_RULE + 6

    # ── Left: SKY NOW ──
    draw.text((4, top), "SKY NOW", font=_font(12), fill=BLACK)
    fbody = _font(16)
    bodies = state.get("bodies") or {}
    ly = top + 18
    for name, sym in (("Sun", "Sun "), ("Moon", "Moon")):
        b = bodies.get(name) or {}
        az = _num(b.get("azimuthDeg"))
        el = _num(b.get("elevationDeg"))
        ok = "+" if b.get("observable") else "-"
        if az is None or el is None:
            txt = "%s --" % sym
        else:
            txt = "%s az%03d el%02d %s" % (sym, round(az), round(el), ok)
        draw.text((4, ly), txt, font=fbody, fill=BLACK)
        ly += 22

    # ── Right: the next tracked planes (after the detailed #1) ──
    rx = 196
    draw.text((rx, top), "NEXT PLANES", font=_font(12), fill=BLACK)
    rest = pool[1:4]
    frow = _font(14)
    ry = top + 18
    if not rest:
        draw.text((rx + 2, ry), "— none —", font=frow, fill=BLACK)
        return
    for i, v in enumerate(rest, 2):
        # number · callsign · body · ETA · SEP — kept compact to fit the column
        # at this size on both the Pi's DejaVu mono and wider preview fonts.
        row = "%d %-7s%s %6s %5s" % (i, v["cs"], v["bsym"], v["eta"], v["sep"])
        draw.text((rx, ry), row, font=frow, fill=BLACK)
        ry += 22


def render_state(state, display_cfg=None):
    """Render a full /api/state snapshot to a 1-bit PIL Image.

    Fixed three-paragraph grid (not configurable — `display_cfg` is accepted for
    call-site compatibility but unused):
      1) header line   — big clock · date · place · GPS / LIVE · CAND
      2) primary block — the nearest tracked plane in detail (ETA/SEP big) + FOV
      3) bottom block  — Sky-now + the next tracked planes
    The planes come from the unified `lifecycle` list (real candidates float to
    the top), so the panel shows traffic even when nothing is a Real candidate.
    """
    img = Image.new("1", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)

    pool, _now = _pool(state)

    _header(draw, state)
    _primary(draw, state, pool[0] if pool else None)
    _sky_and_list(draw, state, pool)
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
