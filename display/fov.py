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


def compute_sensor_matrix(az_deg, el_deg, lat_deg, drift_west, mirror):
    """Python port of computeSensorMatrix() in web/sketch.js (v0.43.0).

    Returns a 2x2 transform {a,b,c,d} mapping a SKY-frame screen offset (x right,
    y DOWN) to the SENSOR frame, plus the sensor-frame compass directions, so the
    e-paper FOV can be drawn in the camera's real orientation. Returns None when
    not configured / data missing. Reuses the same celestial ENU vectors as the
    web sketch, so celestial West (= the drift direction) and North are already
    parallactic-correct and the view rotates with the Sun on an EQ mount.
    """
    DW = {"right": (1.0, 0.0), "left": (-1.0, 0.0),
          "up": (0.0, -1.0), "down": (0.0, 1.0)}.get(drift_west)
    if DW is None or None in (az_deg, el_deg, lat_deg):
        return None

    def dot(u, v):
        return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]

    def cross(u, v):
        return (u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0])

    def norm(v):
        n = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) or 1.0
        return (v[0] / n, v[1] / n, v[2] / n)

    A = math.radians(az_deg)
    h = math.radians(el_deg)
    phi = math.radians(lat_deg)
    O = (math.cos(h) * math.sin(A), math.cos(h) * math.cos(A), math.sin(h))
    P = (0.0, math.cos(phi), math.sin(phi))
    Rs = (math.cos(A), -math.sin(A), 0.0)
    Us = norm(cross(O, Rs))
    if Us[2] < 0:
        Us = (-Us[0], -Us[1], -Us[2])
    Et = norm(cross(P, O))
    Wt = (-Et[0], -Et[1], -Et[2])
    k = dot(P, O)
    Nt = norm((P[0] - k * O[0], P[1] - k * O[1], P[2] - k * O[2]))

    west_s = (dot(Wt, Rs), -dot(Wt, Us))
    north_s = (dot(Nt, Rs), -dot(Nt, Us))
    hs = west_s[0] * north_s[1] - west_s[1] * north_s[0]
    target = (-1.0 if mirror else 1.0) * hs
    DN = (-DW[1], DW[0]) if target > 0 else (DW[1], -DW[0])

    a = DW[0] * west_s[0] + DN[0] * north_s[0]
    c = DW[0] * west_s[1] + DN[0] * north_s[1]
    b = DW[1] * west_s[0] + DN[1] * north_s[0]
    d = DW[1] * west_s[1] + DN[1] * north_s[1]
    cardinals = {
        "W": DW, "E": (-DW[0], -DW[1]),
        "N": DN, "S": (-DN[0], -DN[1]),
    }
    return {"a": a, "b": b, "c": c, "d": d, "cardinals": cardinals}
