"""
Pillow renderer for the 4.2" e-paper panel (400×300, 1-bit black/white).
v0.31.19

render_state() turns an /api/state snapshot into a PIL Image. The layout is
deliberately monospace so columns self-align, and fixed into three paragraphs.
Throughout, captions stay tiny and the payload (ETA / SEP / elevation) is large:

  1. Header (two lines) — clock · date, then place · GPS; a compact Sky-now
     (Sun/Moon elevation) sits in the top-right corner
  2. Primary block — the nearest tracked plane in detail, ETA/SEP big + bold
     (left) + a large FOV frame (right)
  3. Bottom block  — RECENT learned transits (left: flight · how-long-ago · SEP)
     + the live tracked aircraft (right) with a (candidates / total live) counter

Affordances: a SEP trend arrow (▼ closing in / ▲ receding), an inverted
">> TRANSIT NOW <<" banner when a plane's separation drops inside the body
disc, Sun/Moon glyphs instead of letters, and a "! STALE Ns" marker when a
contact has lost its live ADS-B fix.

Planes come from the unified `lifecycle` list (the superset of everything the
panel tracks), ordered by IMMINENCE — the soonest upcoming closest-approach is
featured first, not the one with the smallest predicted separation. So the panel
shows traffic even when nothing currently qualifies as a Real candidate, and a
far-future prediction never buries an imminent pass.

This module never touches hardware; epaper_client.py owns the panel. That keeps
rendering testable on any machine via the client's --dry-run flag.
"""

import math
import os
import socket
import time
from urllib.parse import urlsplit, urlunsplit

from PIL import Image, ImageDraw, ImageFont

import fov

# Optional: a tiny QR code (data source URL) in the bottom-right corner. If the
# `qrcode` library isn't installed the panel simply omits it — never an error.
try:
    import qrcode
    _HAVE_QR = True
except Exception:
    qrcode = None
    _HAVE_QR = False

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
    """Countdown to closest approach. Short forms near the moment, coarse forms
    far out so a distant ISS pass reads sensibly:
      '-45s' · '-3:21' (m:ss) · '-4h3m' · '-7d4h' (sign: − ahead, + past).
    """
    if ms_to_closest is None:
        return "--"
    s = int(round(ms_to_closest / 1000.0))
    sign = "-" if s >= 0 else "+"
    s = abs(s)
    if s < 60:
        core = "%ds" % s
    elif s < 3600:
        core = "%d:%02d" % (s // 60, s % 60)
    elif s < 86400:
        core = "%dh%dm" % (s // 3600, (s % 3600) // 60)
    else:
        core = "%dd%dh" % (s // 86400, (s % 86400) // 3600)
    return sign + core


def _fmt_ago(ms_since):
    """'How long ago' from milliseconds-since: 'now' / '5m' / '2h' / '3d'."""
    if ms_since is None:
        return "--"
    s = int(ms_since / 1000.0)
    if s < 60:
        return "now"
    if s < 3600:
        return "%dm" % (s // 60)
    if s < 86400:
        return "%dh" % (s // 3600)
    return "%dd" % (s // 86400)


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
    bzel = cand.get("bodyAtClosest") or {}      # the body's az / el AT closest

    # Prefer the route flight number (IATA, e.g. SK65D) so the panel shows the
    # SAME identifier as the web FLIGHT column, not the raw ICAO callsign (SAS65D).
    cs = (meta.get("flight") or meta.get("callsign") or meta.get("icao") or "?").strip()
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

    # Trend: closest approach still ahead → closing in (sep shrinking); past → receding.
    approaching = at is not None and (at - now_ms) >= 0
    # Freshness: a stale lifecycle entry has no recent live ADS-B match.
    status = meta.get("status")
    lu = _num(meta.get("lastUpdateMs"))
    age_s = (now_ms - lu) / 1000.0 if lu else None

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
        # raw numbers kept for the FOV preview + transit/trend logic
        "az": az,
        "el_raw": el,
        # the body's own az/el at the moment of closest approach — the correct
        # reference for the FOV offset (NOT the body's current position, which
        # has moved since the prediction was made).
        "body_az_c": _num(bzel.get("azimuthDeg")),
        "body_el_c": _num(bzel.get("elevationDeg")),
        # sparse samples of the crossing (each carries its own aircraft+body
        # az/el at tOffsetMs relative to closest), for the FOV path + markers.
        "path": cand.get("transitPath") or [],
        "has_eta": at is not None,
        "approaching": approaching,
        "_eta_s": (at - now_ms) / 1000.0 if at is not None else None,
        # candidate/imminent → a true "Real candidate"; radio/planned/stale → not
        "is_real": status in ("candidate", "imminent"),
        "stale": status == "stale",
        "coasting": bool(meta.get("coasting")),
        "age_s": age_s,
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

    # Revert to default once a transit is well past: drop contacts whose closest
    # approach is more than 60 s in the past, so a long-gone candidate doesn't
    # keep dominating the detail block / list. Approaching + just-passed stay.
    views = [v for v in views if v["_eta_s"] is None or v["_eta_s"] >= -60.0]

    # Sort: REAL candidates (status candidate/imminent — they will actually pass
    # close) first, then by IMMINENCE (soonest upcoming, then just-passed). This
    # features the real transit candidate over a stale near-miss that merely has
    # a sooner ETA, and matches the web's FOV pick. Separation only breaks ties.
    INF = float("inf")

    def _imminence(v):
        eta = v["_eta_s"]
        if eta is None:
            return (2, 0.0)
        return (0, eta) if eta >= 0 else (1, -eta)

    views.sort(key=lambda v: (0 if v["is_real"] else 1, _imminence(v),
                              v["sep_num"] if v["sep_num"] is not None else INF))
    return views, now_ms


# ── Drawing ─────────────────────────────────────────────────────────────────

def _right(draw, x_right, y, text, font):
    """Right-align `text` so it ends at x_right."""
    w = draw.textlength(text, font=font)
    draw.text((x_right - w, y), text, font=font, fill=BLACK)


def _lv(draw, x, y, label, value, vsize, lsize=10, gap=3, pad=12):
    """Draw a small `label` followed by a big bold `value` (the principle: tiny
    captions, double-size payload). `y` is the top of the value; the label is
    bottom-aligned to it. Returns the x just past the value (+ padding)."""
    fl = _font(lsize)
    fv = _font(vsize, bold=True)
    if label:
        draw.text((x, y + (vsize - lsize)), label, font=fl, fill=BLACK)
        x += draw.textlength(label, font=fl) + gap
    draw.text((x, y), value, font=fv, fill=BLACK)
    return x + draw.textlength(value, font=fv) + pad


# 8 unit directions for the Sun's rays (kept literal — no math import needed).
_RAYS = ((1, 0), (-1, 0), (0, 1), (0, -1),
         (0.7, 0.7), (0.7, -0.7), (-0.7, 0.7), (-0.7, -0.7))


def _draw_body(draw, cx, cy, r, body, ink=BLACK, bg=WHITE):
    """Draw a small 1-bit body glyph: a rayed disc for the Sun, a crescent for
    the Moon. Clearer at a glance than an 'S' / 'M' letter."""
    if body == "Moon":
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ink)
        # Carve the crescent with a bg-coloured disc offset to the right.
        o = r * 0.8
        draw.ellipse((cx - r + o, cy - r - 1, cx + r + o, cy + r + 1), fill=bg)
    else:  # Sun (and any unknown body)
        for dx, dy in _RAYS:
            draw.line((cx + dx * (r + 1), cy + dy * (r + 1),
                       cx + dx * (r + 4), cy + dy * (r + 4)), fill=ink, width=1)
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ink)


def _tri(draw, x, y, w, h, up):
    """Small filled triangle (apex up or down) in the bbox (x, y, w, h).
    Used as a SEP trend arrow: down = closing in, up = receding."""
    if up:
        pts = [(x + w / 2.0, y), (x, y + h), (x + w, y + h)]
    else:
        pts = [(x, y), (x + w, y), (x + w / 2.0, y + h)]
    draw.polygon(pts, fill=BLACK)


# Block boundaries (y) for the three-paragraph grid. The panel is 400×300.
# Generous bands so the body text can be large and legible from across a room.
# The header is two lines (clock/date/counts, then place/GPS) so everything
# stays at a readable size — nothing has to shrink to fit one line.
_HDR_RULE = 46          # divider under the two-line header
_BLK2_RULE = 178        # divider between the candidate/FOV block and the bottom


def _header(draw, state):
    """Paragraph 1 — two lines plus a compact Sky-now in the top-right corner:
      line 1: big bold clock · date          ☀ <el> (right)
      line 2: place · GPS                     ☾ <el> (right)
    """
    obs = state.get("observer") or {}

    lt = time.localtime()
    clock = time.strftime("%H:%M:%S", lt)
    date = time.strftime("%d.%m.%y", lt)

    # ── Sky-now in the top-right corner: Sun on line 1, Moon on line 2, small ──
    bodies = state.get("bodies") or {}
    fsky = _font(13)
    for name, y in (("Sun", 3), ("Moon", 27)):
        b = bodies.get(name) or {}
        el = _num(b.get("elevationDeg"))
        txt = "%d°" % round(el) if el is not None else "--"
        w = draw.textlength(txt, font=fsky)
        draw.text((WIDTH - 4 - w, y + 2), txt, font=fsky, fill=BLACK)
        _draw_body(draw, WIDTH - 4 - w - 13, y + 9, 6, name)

    # ── Line 1: big bold clock + date ──
    fc = _font(20, bold=True)
    draw.text((4, 1), clock, font=fc, fill=BLACK)
    x = 4 + draw.textlength(clock, font=fc) + 12
    draw.text((x, 8), date, font=_font(14), fill=BLACK)

    # ── Line 2: place + full GPS (with ° — there's room now) ──
    name = (obs.get("name") or "").strip()
    gps = "%s  %s" % (_fmt_lat(obs.get("latitudeDeg")), _fmt_lon(obs.get("longitudeDeg")))
    line2 = ("%s   %s" % (name, gps)) if name else gps
    draw.text((4, 27), line2, font=_font(14), fill=BLACK)

    draw.line((0, _HDR_RULE, WIDTH, _HDR_RULE), fill=BLACK, width=1)


def _dashed_line(draw, p0, p1, dash=4, gap=3):
    """Dashed segment between two points (Pillow has no native dashes). Works at
    any angle, so it draws the edges of a rotated FOV box."""
    x0, y0 = p0
    x1, y1 = p1
    seg = math.hypot(x1 - x0, y1 - y0)
    if seg <= 0:
        return
    ux, uy = (x1 - x0) / seg, (y1 - y0) / seg
    pos = 0.0
    while pos < seg:
        a = pos
        bb = min(pos + dash, seg)
        draw.line((x0 + ux * a, y0 + uy * a, x0 + ux * bb, y0 + uy * bb), fill=BLACK, width=1)
        pos += dash + gap


def _draw_fov_box(draw, cx, cy, w, h, m, box):
    """Dashed sensor-FOV box centred at (cx, cy), w×h px. Rotated to the camera
    orientation (with W/R/T edge labels) when a sensor matrix is given, else the
    plain axis-aligned rectangle. Port of fovBoxSvg() in web/sketch.js — the
    e-paper has no Sky/Sensor toggle, so this is how the real orientation is
    shown, identical to the web FOV."""
    bx0, by0, bx1, by1 = box
    hw, hh = w / 2.0, h / 2.0
    if not m:
        for p0, p1 in (((cx - hw, cy - hh), (cx + hw, cy - hh)),
                       ((cx + hw, cy - hh), (cx + hw, cy + hh)),
                       ((cx + hw, cy + hh), (cx - hw, cy + hh)),
                       ((cx - hw, cy + hh), (cx - hw, cy - hh))):
            _dashed_line(draw, p0, p1)
        return

    def inv(sx, sy):
        # Mᵀ: sensor-frame coord → sky frame. +x = image right, −y = image top.
        return (cx + m["a"] * sx + m["b"] * sy, cy + m["c"] * sx + m["d"] * sy)

    corners = [inv(-hw, -hh), inv(hw, -hh), inv(hw, hh), inv(-hw, hh)]
    for i in range(4):
        _dashed_line(draw, corners[i], corners[(i + 1) % 4])

    f = _font(9)

    def _label(sx, sy, ch):
        px, py = inv(sx, sy)
        px = min(max(px - 2, bx0 + 1), bx1 - 8)     # clamp inside the panel cell
        py = min(max(py - 5, by0 + 1), by1 - 11)
        draw.text((px, py), ch, font=f, fill=BLACK)

    dw = m["cardinals"]["W"]
    _label(dw[0] * hw, dw[1] * hh, "W")             # West / drift edge
    _label(hw * 1.12, 0, "R")                       # image right edge
    _label(0, -hh * 1.18, "T")                      # image top edge


def _draw_fov(draw, state, view, box):
    """Draw the FOV frame (body disc + dashed sensor box + crossing marker).
    The sensor box is drawn ROTATED to the camera's real orientation when a
    drift-test calibration is set (optics.driftWest), with W/R/T edge labels —
    same as the web FOV, no toggle."""
    bx0, by0, bx1, by1 = box
    draw.rectangle((bx0, by0, bx1, by1), outline=BLACK)
    if not view:
        return
    cx = (bx0 + bx1) / 2.0
    cy = (by0 + by1) / 2.0

    body = view["body"]
    b = (state.get("bodies") or {}).get(body) or {}
    # Reference the body's position AT CLOSEST APPROACH (when the prediction says
    # the plane is nearest), not its current position — otherwise the marker is
    # offset by however far the body has moved since, and a 0.2° pass shows at the
    # frame edge. Fall back to the current position if the closest sample is absent.
    body_az = view["body_az_c"] if view["body_az_c"] is not None else _num(b.get("azimuthDeg"))
    body_el = view["body_el_c"] if view["body_el_c"] is not None else _num(b.get("elevationDeg"))
    range_m = _num(b.get("rangeM"))
    optics = state.get("optics") or {}

    # Disc-centred scale (matches the web FOV): the disc fills ~0.4 of the widget
    # so the sensor box — which may be larger or smaller — floats inside with room
    # for the rotated outline + labels.
    disc_deg = fov.body_disc_deg(body, range_m) if range_m else 0.5
    widget_min = min(bx1 - bx0, by1 - by0)
    px_per_deg = (widget_min * 0.40) / disc_deg

    # Body disc, centred.
    r = max(3.0, (disc_deg / 2.0) * px_per_deg)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=BLACK)

    # Sensor FOV box, rotated to the camera orientation (v0.43.0).
    fov_w_deg = fov.fov_deg(_num(optics.get("telescopeFocalMm")), _num(optics.get("sensorWmm")))
    fov_h_deg = fov.fov_deg(_num(optics.get("telescopeFocalMm")), _num(optics.get("sensorHmm")))
    if fov_w_deg and fov_h_deg:
        lat = _num((state.get("observer") or {}).get("latitudeDeg"))
        sensor_m = fov.compute_sensor_matrix(
            body_az, body_el, lat, optics.get("driftWest"), bool(optics.get("mirror")))
        _draw_fov_box(draw, cx, cy, fov_w_deg * px_per_deg, fov_h_deg * px_per_deg,
                      sensor_m, (bx0, by0, bx1, by1))

    def _pt(b_az, b_el, a_az, a_el):
        """Pixel for an aircraft az/el relative to a body az/el (sky frame, clamped)."""
        dx, dy = fov.offset_deg(b_az, b_el, a_az, a_el)
        px, py = cx + dx * px_per_deg, cy - dy * px_per_deg
        return (min(max(px, bx0 + 2), bx1 - 2), min(max(py, by0 + 2), by1 - 2))

    def _cross(px, py, arm, w):
        draw.line((px - arm, py, px + arm, py), fill=BLACK, width=w)
        draw.line((px, py - arm, px, py + arm), fill=BLACK, width=w)

    # Crossing path: each sample carries its own aircraft + body az/el at a time
    # offset from closest. Plot the aircraft relative to the body (disc centred)
    # → the line shows where it crosses. Mark the CLOSEST point (small cross) and
    # the CURRENT position (big cross), like the web FOV.
    path = view.get("path") or []
    pts = []
    for s in path:
        b_az = _num(s.get("bodyAz")); b_el = _num(s.get("bodyEl"))
        a_az = _num(s.get("aircraftAz")); a_el = _num(s.get("aircraftEl"))
        if None in (b_az, b_el, a_az, a_el):
            continue
        pts.append((_num(s.get("tOffsetMs")) or 0.0, _pt(b_az, b_el, a_az, a_el)))
    if len(pts) >= 2:
        draw.line([p for _t, p in pts], fill=BLACK, width=1)            # trajectory

    # Closest point (tOffsetMs ≈ 0) — small cross. Prefer the path; fall back to
    # the aircraftAtClosest vs bodyAtClosest offset.
    if pts:
        _t, cpt = min(pts, key=lambda tp: abs(tp[0]))
        _cross(cpt[0], cpt[1], 5, 1)
    elif body_az is not None and body_el is not None and view["az"] is not None and view["el_raw"] is not None:
        cpt = _pt(body_az, body_el, view["az"], view["el_raw"])
        _cross(cpt[0], cpt[1], 6, 2)

    # Current position (the sample nearest now = tOffset ≈ now − closest) — big
    # bold cross, so you can see where the plane is right now vs the crossing.
    eta_s = view.get("_eta_s")
    if pts and eta_s is not None:
        cur_off = -eta_s * 1000.0
        _t, npt = min(pts, key=lambda tp: abs(tp[0] - cur_off))
        _cross(npt[0], npt[1], 8, 2)


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

    # Transit test: the plane silhouette overlaps the disc when the separation
    # drops below the body's angular radius — the moment everything builds to.
    body = view["body"]
    b = (state.get("bodies") or {}).get(body) or {}
    range_m = _num(b.get("rangeM"))
    radius = (fov.body_disc_deg(body, range_m) if range_m else 0.5) / 2.0
    sep_num = view["sep_num"]
    transit = sep_num is not None and sep_num <= radius

    # Heading row — an inverted banner during an actual transit, else the plane
    # class plus a stale / coasting freshness marker on the right.
    if transit:
        draw.rectangle((2, y0 - 2, 234, y0 + 15), fill=BLACK)
        draw.text((10, y0), ">> TRANSIT NOW <<", font=_font(13, bold=True), fill=WHITE)
    else:
        heading = "REAL CANDIDATE" if view["is_real"] else "NEAREST PLANE"
        draw.text((4, y0), heading, font=_font(12), fill=BLACK)
        if view["stale"]:
            s = "! STALE %ds" % int(view["age_s"]) if view["age_s"] is not None else "! STALE"
            _right(draw, 234, y0, s, _font(11))
        elif view["coasting"]:
            _right(draw, 234, y0, "~ coasting", _font(11))

    # Callsign + a Sun/Moon glyph.
    cs_font = _font(19, bold=True)
    cs_y = y0 + 16
    draw.text((4, cs_y), view["cs"], font=cs_font, fill=BLACK)
    gx = 4 + draw.textlength(view["cs"], font=cs_font) + 14
    _draw_body(draw, gx, cs_y + 10, 8, body)

    # Headline figures: ETA and SEP, big + bold, tiny captions.
    _lv(draw, 4, 91, "ETA", view["eta"], 24, 13, gap=4, pad=10)
    x = _lv(draw, 4, 119, "SEP", view["sep"], 24, 13, gap=4, pad=6)
    # SEP trend arrow: down = closing in (approaching), up = receding.
    if view["has_eta"] and sep_num is not None:
        _tri(draw, x, 125, 13, 15, up=not view["approaching"])

    # Secondary fields, small: route + bearing, then distance / altitude / speed.
    fsm = _font(12)
    draw.text((4, 150), "%s  brg %s" % (view["route"], view["brg"]), font=fsm, fill=BLACK)
    draw.text((4, 164), "%s  %s  %s" % (view["dist"], view["alt"], view["spd"]), font=fsm, fill=BLACK)

    _draw_fov(draw, state, view, (bx0, by0, bx1, by1))


def _sky_and_list(draw, state, pool):
    """Paragraph 3 — RECENT learned transits (left, narrow) + the live tracked
    aircraft (right, wide). The aircraft heading carries a (candidates / total
    live) counter. Sky-now elevation now lives in the header's top-right."""
    draw.line((0, _BLK2_RULE, WIDTH, _BLK2_RULE), fill=BLACK, width=1)
    top = _BLK2_RULE + 5

    # ── Left: RECENT — the last few real (candidate/imminent) transits that were
    # recorded, with how long ago + the achieved separation. ──
    draw.text((4, top), "RECENT", font=_font(11), fill=BLACK)
    # TLE freshness marker (v0.52.0): ISS/satellite SGP4 accuracy degrades with
    # TLE age (~1-3 km/day cross-track), so surface it right by the satellite
    # transit block instead of leaving it silent. Compact "TLE N.Nd" when fresh;
    # bold "! TLE Nd" once it crosses ~3 days — the point where transit timing
    # noticeably drifts and a refresh is due. Sits between RECENT and the
    # AIRCRAFT header (rx=138), so it never collides.
    iss = state.get("iss") or {}
    tle_age = _num(iss.get("tleAgeDays"))
    if iss.get("active") and tle_age is not None:
        stale = tle_age >= 3.0
        a_txt = ("! TLE %.0fd" % tle_age) if stale else ("TLE %.1fd" % tle_age)
        a_x = 4 + draw.textlength("RECENT", font=_font(11)) + 8
        draw.text((a_x, top), a_txt, font=_font(11, bold=stale), fill=BLACK)
    recents = state.get("recentTransits") or []
    now_ms = _num(state.get("nowMs")) or (time.time() * 1000.0)
    ry = top + 17
    if not recents:
        draw.text((4, ry), "— none yet —", font=_font(12), fill=BLACK)
    else:
        f = _font(11)
        for r in recents[:4]:
            cs = (r.get("callsign") or r.get("icao") or "?")[:6]
            body = r.get("body") or ""
            sep = _num(r.get("sepDeg"))
            at = _num(r.get("closestAtMs"))
            ago = _fmt_ago(now_ms - at) if at is not None else "--"
            sep_s = "%.2f°" % sep if sep is not None else "--"
            _draw_body(draw, 8, ry + 6, 4, body)
            row = "%-6s %3s %s" % (cs, ago, sep_s)
            draw.text((16, ry), row, font=f, fill=BLACK)
            ry += 18

    # ── Right: AIRCRAFT (near-body tracked / total live), wide + large ──
    live = state.get("aircraftCount")
    if live is None:
        live = len(state.get("lifecycle") or [])
    # Count the planes actually being tracked near a body (the pool we display),
    # not the raw per-tick `state.candidates` (tight + often empty) — so the
    # number matches what's on screen.
    near = len(pool)

    rx = 138
    fhd = _font(11)
    draw.text((rx, top), "AIRCRAFT", font=fhd, fill=BLACK)
    hx = rx + draw.textlength("AIRCRAFT ", font=fhd)
    draw.text((hx, top - 1), "(%d/%d)" % (near, live), font=_font(13, bold=True), fill=BLACK)

    rest = pool[1:4]
    ry = top + 16
    if not rest:
        draw.text((rx + 2, ry + 4), "— none nearby —", font=_font(14), fill=BLACK)
        return
    for v in rest:
        x = rx
        if v["stale"]:
            draw.text((x, ry + 2), "!", font=_font(14, bold=True), fill=BLACK)
            x += 9
        # Sun/Moon glyph, then callsign + big labelled SEP / ETA payloads.
        _draw_body(draw, x + 5, ry + 9, 5, v["body"])
        x += 14
        draw.text((x, ry + 2), v["cs"], font=_font(13), fill=BLACK)
        x += draw.textlength(v["cs"], font=_font(13)) + 7
        x = _lv(draw, x, ry, "SEP", v["sep"], 16, 10, gap=3, pad=4)
        if v["has_eta"] and v["sep_num"] is not None:
            _tri(draw, x, ry + 3, 8, 10, up=not v["approaching"])
            x += 11
        x = _lv(draw, x, ry, "ETA", v["eta"], 16, 10, gap=3, pad=6)
        ry += 24


_lan_ip_cache = None


def _lan_ip():
    """This machine's primary outbound LAN IP (cached). The UDP 'connect' sends
    no packets — it just asks the routing table which local address would be
    used, so it works offline as long as a default route exists. None on failure."""
    global _lan_ip_cache
    if _lan_ip_cache:
        return _lan_ip_cache
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        if ip and not ip.startswith("127."):
            _lan_ip_cache = ip
            return ip
    except Exception:
        pass
    finally:
        if s is not None:
            try:
                s.close()
            except Exception:
                pass
    return None


def _qr_url(url):
    """The URL to encode in the QR. A loopback source (the panel reading its OWN
    Pi) is useless from a phone, so swap the host for this Pi's real LAN IP —
    keeping the scheme/port/path — so the QR opens the local Pi's web UI. Returns
    None if the host is loopback and no LAN IP could be found."""
    if not url:
        return None
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host in ("localhost", "::1") or host.startswith("127."):
        ip = _lan_ip()
        if not ip:
            return None
        netloc = "%s:%d" % (ip, parts.port) if parts.port else ip
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    return url


def _draw_ap_banner(draw, ap):
    """Bottom-left banner shown while the Pi hosts its off-road onboarding AP
    (v0.51.0): the WiFi name + password to join. The QR to its right encodes the
    same WIFI: payload, so a phone can join with one tap instead of typing."""
    ssid = ap.get("ssid") or ""
    pw = ap.get("password") or ""
    by0 = HEIGHT - 40
    bx1 = WIDTH - 40                 # stop short of the bottom-right QR
    draw.rectangle((0, by0, bx1, HEIGHT - 1), fill=WHITE)
    draw.rectangle((0, by0, bx1, HEIGHT - 1), outline=BLACK, width=1)
    draw.text((3, by0 + 2), "WIFI AP — join to set up", font=_font(11, bold=True), fill=BLACK)
    draw.text((3, by0 + 15), "SSID: %s" % ssid, font=_font(12, bold=True), fill=BLACK)
    draw.text((3, by0 + 27), "Pass: %s   (scan QR →)" % pw, font=_font(12, bold=True), fill=BLACK)


def _draw_qr(draw, data, is_wifi=False):
    """Draw a tiny QR in the very bottom-right corner — by default the data-source
    URL (so a phone opens the web UI), or, when `is_wifi`, a WIFI: join payload
    passed through verbatim (one-tap join of the onboarding AP).

    As small as the data allows — one panel pixel per QR module. A white quiet
    zone is painted behind it so a phone can read it off the e-paper. No-op if the
    qrcode lib is missing or no usable data could be derived."""
    if not _HAVE_QR:
        return
    if not is_wifi:
        data = _qr_url(data)
    if not data:
        return
    try:
        qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_L,
                           box_size=1, border=0)
        qr.add_data(data)
        qr.make(fit=True)
        m = qr.get_matrix()
    except Exception:
        return
    n = len(m)
    if not n:
        return
    quiet = 3                       # white quiet-zone pixels around the code
    x1, y1 = WIDTH - 2, HEIGHT - 2  # bottom-right anchor
    x0, y0 = x1 - n, y1 - n         # 1 px / module
    draw.rectangle((x0 - quiet, y0 - quiet, x1 + quiet, y1 + quiet), fill=WHITE)
    for r in range(n):
        row = m[r]
        for c in range(n):
            if row[c]:
                draw.point((x0 + c, y0 + r), fill=BLACK)


def render_state(state, display_cfg=None, source_url=None):
    """Render a full /api/state snapshot to a 1-bit PIL Image.

    Fixed three-paragraph grid (not configurable — `display_cfg` is accepted for
    call-site compatibility but unused):
      1) header line   — big clock · date · place · GPS / LIVE · CAND
      2) primary block — the nearest tracked plane in detail (ETA/SEP big) + FOV
      3) bottom block  — Sky-now + the next tracked planes
    `source_url` (the host this panel polls) is encoded as a tiny QR in the
    bottom-right corner so you can open that web UI on a phone.
    """
    img = Image.new("1", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)

    pool, _now = _pool(state)

    _header(draw, state)
    _primary(draw, state, pool[0] if pool else None)
    _sky_and_list(draw, state, pool)
    # Off-road AP mode (v0.51.0): when the Pi hosts its onboarding access point,
    # overlay the join banner + a WiFi-join QR instead of the web-URL QR.
    ap = state.get("wifiAp") or {}
    if ap.get("active") and ap.get("qr"):
        _draw_ap_banner(draw, ap)
        _draw_qr(draw, ap["qr"], is_wifi=True)
    else:
        _draw_qr(draw, source_url)
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


def render_disabled(config_url=None):
    """Render a minimal 'display off' screen (drawn once, then idle).

    The `enabled` flag is read from config_url (STP_CONFIG_URL), NOT from the
    data source — a common multi-Pi footgun is pointing STP_CONFIG_URL at the
    main tracker Pi (which has no panel, so display.enabled=false) instead of
    localhost. Showing the config host here makes that misconfiguration obvious
    from the panel itself: if it reads "config: http://<main-pi>:8081" the fix
    is to point STP_CONFIG_URL back at 127.0.0.1 and set the Data-source URL in
    Settings instead (v0.52.2)."""
    img = Image.new("1", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)
    msg = "display disabled"
    f = _font(18)
    w = draw.textlength(msg, font=f)
    draw.text(((WIDTH - w) / 2, 122), msg, font=f, fill=BLACK)
    sub = "enable in web Settings > E-paper display"
    fs = _font(11)
    ws = draw.textlength(sub, font=fs)
    draw.text(((WIDTH - ws) / 2, 150), sub, font=fs, fill=BLACK)
    # Which host the enabled flag was read from — the key diagnostic when the
    # panel is "disabled" despite the local service having it enabled.
    if config_url:
        src = "config: %s" % config_url
        wsrc = draw.textlength(src, font=fs)
        draw.text(((WIDTH - wsrc) / 2, 168), src, font=fs, fill=BLACK)
    return img
