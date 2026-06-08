"""
FOV geometry helpers — a small Python port of the math in web/sketch.js so the
e-paper FOV preview frames a transit the same way the browser does.
v0.31.0
"""

import math

# Physical disc diameters (m). Used to turn the body range (from /api/state) into
# an on-sky angular size, identical in spirit to sketch.js's angSize().
SUN_DIAMETER_M = 1.3927e9
MOON_DIAMETER_M = 3.4748e6


def fov_deg(focal_mm, sensor_mm):
    """Full field-of-view angle (deg) for a focal length + sensor dimension.

    Mirrors fovDeg() in web/sketch.js: 2·atan(sensor/2 / focal).
    """
    if not focal_mm or not sensor_mm:
        return 0.0
    return math.degrees(2 * math.atan((sensor_mm / 2.0) / focal_mm))


def ang_size_deg(diameter_m, range_m):
    """Angular size (deg) of an object of given diameter at given range.

    Mirrors angSize() in web/sketch.js: atan2(meters, range).
    """
    if not range_m:
        return 0.0
    return math.degrees(math.atan2(diameter_m, range_m))


def body_disc_deg(body, range_m):
    """Angular diameter (deg) of the Sun/Moon disc at the given range."""
    if body == "Sun":
        return ang_size_deg(SUN_DIAMETER_M, range_m)
    if body == "Moon":
        return ang_size_deg(MOON_DIAMETER_M, range_m)
    return 0.5  # sane default if an unknown body ever appears


def deg_to_px(dx_deg, dy_deg, cx, cy, px_per_deg):
    """
    Project a (dAz·cosEl, dEl) offset in degrees to pixel coords inside a FOV
    rectangle centred at (cx, cy). x grows to the right; elevation grows upward,
    so y is subtracted (PIL's y axis points down). Mirrors degToPx() in
    web/sketch.js.
    """
    return (cx + dx_deg * px_per_deg, cy - dy_deg * px_per_deg)


def offset_deg(body_az, body_el, obj_az, obj_el):
    """
    (dAz·cosEl, dEl) angular offset of an object relative to a body centre, in
    degrees. The azimuth delta is cos(el)-scaled so it reads as true on-sky
    angle near the pole — same convention as the FOV box in sketch.js.
    """
    d_el = obj_el - body_el
    d_az = obj_az - body_az
    # Normalise azimuth wrap-around to [-180, 180].
    while d_az > 180:
        d_az -= 360
    while d_az < -180:
        d_az += 360
    d_az_scaled = d_az * math.cos(math.radians(body_el))
    return (d_az_scaled, d_el)
