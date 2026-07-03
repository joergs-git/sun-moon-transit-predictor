#!/usr/bin/env python3
"""
ser_transit.py — cross-platform Python post-processor for SharpCap .ser transit
captures.  Replaces the macOS-only AstroSharper confirm/measure step so it can be
spawned from the (Windows) SharpCap listener or run on the NAS/Pi.

What it does
------------
Reads a .ser capture, isolates the fast-moving object with a temporal-median
background + "transient map" (persistent sources — the tracked star or the solar
disc — cancel; a transient that lights each pixel in only ~1 frame survives),
finds it as a connected component, confirms it, and measures:
  * did the transit happen?  (bright ISS on a star field, or dark plane/ISS on the
    solar disc — auto-detected from the disc coverage)
  * frame range, entry/exit pixel, track length, speed, direction
  * closest approach to the target (Vega / Sun centre) -> separation
For the Sun the disc radius gives a plate scale, so separation is also in degrees
(solar diameter = 0.5334°).

Pure numpy + scipy + PIL.  Reads the .ser directly (this file) or a cached .npy
binned stack (for fast iteration, produced by cache_ser.py).

Usage:
  python3 ser_transit.py capture.ser [--bin N] [--out proof.png] [--json]
  python3 ser_transit.py cached.npy  --npy [--bin N] [--out proof.png] [--json]
"""
import struct, os, sys, argparse, json, math
import numpy as np
from scipy import ndimage

HEADER = 178
SOLAR_DIAMETER_DEG = 0.5334

# ---------------------------------------------------------------- SER reading
def ser_header(path):
    with open(path, "rb") as fh:
        h = fh.read(HEADER)
    luid, colorid, little, w, ht, depth, fc = struct.unpack("<7i", h[14:14+28])
    bpp = 1 if depth <= 8 else 2
    planes = 3 if colorid >= 100 else 1
    return dict(w=w, h=ht, frames=fc, planes=planes,
                framebytes=w*ht*bpp*planes,
                dtype=np.uint8 if bpp == 1 else ("<u2" if little else ">u2"))

def load_stack(path, is_npy, binf):
    """Return (stack float32 (F,h,w), frame_indices, binf)."""
    if is_npy:
        stk = np.load(path).astype(np.float32)
        idx = np.load(path + ".idx.npy") if os.path.exists(path + ".idx.npy") \
              else np.arange(stk.shape[0])
        return stk, idx, binf
    hdr = ser_header(path)
    b = binf
    H, W = (hdr["h"]//b)*b, (hdr["w"]//b)*b
    idx = np.arange(hdr["frames"])
    out = np.empty((len(idx), H//b, W//b), np.float32)
    with open(path, "rb") as fh:
        for k, i in enumerate(idx):
            fh.seek(HEADER + i*hdr["framebytes"])
            raw = np.frombuffer(fh.read(hdr["framebytes"]), dtype=hdr["dtype"])
            img = raw.reshape(hdr["h"], hdr["w"]).astype(np.float32)[:H, :W]
            out[k] = img.reshape(H//b, b, W//b, b).mean(axis=(1, 3))
    return out, idx, b

# ---------------------------------------------------------------- helpers
def per_pixel_std(sig, rows=64):
    """Per-pixel temporal std over axis 0, in row bands to bound memory."""
    F, H, W = sig.shape
    s = np.empty((H, W), np.float32)
    for r in range(0, H, rows):
        s[r:r+rows] = sig[:, r:r+rows, :].std(axis=0)
    return s

# ---------------------------------------------------------------- detection
def ransac_track(pts, tol=3.0, iters=200):
    """pts: (N,4) [f,x,y,z].  Find the largest set on a straight, monotonic-time
    line (constant velocity).  Returns inlier mask + fit, or None."""
    if len(pts) < 3:
        return None
    f, x, y = pts[:,0], pts[:,1], pts[:,2]
    best = None
    N = len(pts)
    # deterministic candidate pairs: strongest points first (no RNG — reproducible)
    order = np.argsort(-pts[:,3])
    cand = order[:min(N, 40)]
    for ii in range(len(cand)):
        for jj in range(ii+1, len(cand)):
            i, j = cand[ii], cand[jj]
            if f[i] == f[j]:
                continue
            # line param by frame: x=ax*f+bx, y=ay*f+by through the two points
            ax = (x[j]-x[i])/(f[j]-f[i]); bx = x[i]-ax*f[i]
            ay = (y[j]-y[i])/(f[j]-f[i]); by = y[i]-ay*f[i]
            if math.hypot(ax, ay) < 0.05:               # must actually move
                continue
            px, py = ax*f+bx, ay*f+by
            inl = np.hypot(x-px, y-py) < tol
            if best is None or inl.sum() > best[0]:
                best = (int(inl.sum()), inl, (ax,bx,ay,by))
    if best is None or best[0] < 3:
        return None
    n, inl, (ax,bx,ay,by) = best
    fi, xi, yi = f[inl], x[inl], y[inl]
    A = np.vstack([fi, np.ones_like(fi)]).T
    ax, bx = np.linalg.lstsq(A, xi, rcond=None)[0]
    ay, by = np.linalg.lstsq(A, yi, rcond=None)[0]
    px, py = A@[ax,bx], A@[ay,by]
    ss = np.sum((xi-px)**2+(yi-py)**2)
    st = np.sum((xi-xi.mean())**2+(yi-yi.mean())**2)+1e-9
    return dict(inl=inl, ax=ax, bx=bx, ay=ay, by=by, n=int(n), r2=float(1-ss/st))

def detect(path, is_npy=False, binf=1, out=None):
    stk, idx, b = load_stack(path, is_npy, binf)
    F, H, W = stk.shape
    bg = np.median(stk, axis=0)

    disc = bg > max(8.0, 0.12 * bg.max())
    disc_frac = disc.mean()
    is_sun = disc_frac > 0.08

    if is_sun:
        sig = (bg[None] - stk)                          # dark silhouette -> positive
        valid = ndimage.binary_erosion(disc, iterations=2)   # drop the very edge
        target = ndimage.center_of_mass(disc)
        radius_px = math.sqrt(disc.sum() / math.pi)
        deg_per_px = SOLAR_DIAMETER_DEG / (2 * radius_px)
    else:
        sig = (stk - bg[None])                          # bright ISS
        valid = np.ones((H, W), bool)
        ty, tx = np.unravel_index(np.argmax(bg), bg.shape)
        target = (float(ty), float(tx))
        deg_per_px = None

    # mask the sensor border — amp glow / readout banding / edge rows create
    # bright moving artifacts (esp. rolling-shutter row 0) that mimic a track
    mgn = max(3, int(0.02 * min(H, W)))
    border = np.ones((H, W), bool)
    border[mgn:-mgn, mgn:-mgn] = False
    valid = valid & ~border

    # --- sigma image: normalise each frame's residual by that pixel's temporal
    # std.  Shimmering limb / hot / variable pixels have large std -> suppressed.
    pstd = per_pixel_std(sig)
    inv = np.zeros_like(pstd); m = pstd > 1e-3
    inv[m] = 1.0 / pstd[m]
    inv[~valid] = 0

    # --- per-frame peak of the sigma image, and a max-z transient map for proof
    Zpk = np.full(F, 0.0); Xp = np.zeros(F, int); Yp = np.zeros(F, int)
    maxz = np.zeros((H, W), np.float32)
    for t in range(F):
        z = sig[t] * inv                                # sigma units
        np.maximum(maxz, z, out=maxz)
        j = z.argmax(); Zpk[t] = z.flat[j]
        Yp[t], Xp[t] = divmod(j, W)

    ZTHR = 6.0
    cand = np.where(Zpk > ZTHR)[0]
    # drop persistent locations (a fixed hot/bright pixel picked every frame = not
    # a transit).  Bin positions; any cell chosen in >6% of frames is persistent.
    pts = []
    if len(cand):
        gx = (Xp[cand]//4); gy = (Yp[cand]//4)
        from collections import Counter
        cnt = Counter(zip(gx.tolist(), gy.tolist()))
        persist = {k for k, c in cnt.items() if c > max(4, 0.06*F)}
        for i in cand:
            if (Xp[i]//4, Yp[i]//4) in persist:
                continue
            pts.append((float(idx[i]), float(Xp[i]), float(Yp[i]), float(Zpk[i])))
    pts = np.array(pts) if pts else np.zeros((0,4))

    res = dict(mode="sun" if is_sun else "starfield", frames=int(F),
               disc_frac=round(float(disc_frac),3), z_threshold=ZTHR,
               peak_z=round(float(maxz.max()),1), n_candidates=int(len(pts)))

    trk = ransac_track(pts) if len(pts) >= 3 else None
    # a real transit is temporally CONTIGUOUS (consecutive frames); reject a line
    # fitted through noise points scattered across the whole capture.
    if trk:
        fin = np.sort(pts[trk["inl"], 0])
        span = fin[-1] - fin[0]
        density = trk["n"] / (span + 1)
        if density < 0.25 and trk["n"] < 8:
            trk = None

    if trk:                                             # multi-frame moving track
        inl = trk["inl"]; P = pts[inl]
        order = np.argsort(P[:,0]); P = P[order]
        f0, f1 = int(P[0,0]), int(P[-1,0])
        ax, bx, ay, by = trk["ax"], trk["bx"], trk["ay"], trk["by"]
        x0, y0 = ax*P[0,0]+bx, ay*P[0,0]+by
        x1, y1 = ax*P[-1,0]+bx, ay*P[-1,0]+by
        speed = math.hypot(ax, ay)*b
        length = math.hypot(x1-x0, y1-y0)*b
        # closest approach of the fitted line to the target centre
        sep_px = point_to_seg((target[1],target[0]), (x0,y0), (x1,y1))*b
        moving = True
        track_draw = [(int(p[0]), p[1], p[2]) for p in P]
        res.update(detected=True, moving=True, n_active=int(trk["n"]),
                   active_frames=[f0, f1], entry_px=[int(x0*b),int(y0*b)],
                   exit_px=[int(x1*b),int(y1*b)], track_len_px=round(length,1),
                   speed_px_per_frame=round(speed,1),
                   direction_deg=round(math.degrees(math.atan2(ay,ax)),1),
                   straightness_r2=round(trk["r2"],3), separation_px=round(sep_px,1))
    elif len(pts) >= 1:
        # single/short transient (e.g. ISS bright for ~1 frame): confirm as a
        # resolved non-persistent blob above z-threshold
        best = pts[np.argmax(pts[:,3])]
        sep_px = math.hypot(best[1]-target[1], best[2]-target[0])*b
        track_draw = [(int(best[0]), best[1], best[2])]
        res.update(detected=True, moving=False, n_active=1,
                   active_frames=[int(best[0])],
                   entry_px=[int(best[1]*b),int(best[2]*b)],
                   peak_z_at_object=round(float(best[3]),1),
                   separation_px=round(sep_px,1))
    else:
        track_draw = []
        res.update(detected=False)

    if deg_per_px and "separation_px" in res:
        res["separation_deg"] = round(res["separation_px"]*deg_per_px, 3)
        res["plate_scale_arcsec_px"] = round(deg_per_px*3600, 2)

    _proof(maxz, [(f,x,y,0) for (f,x,y) in track_draw], target, target, out, b)
    return res

def point_to_seg(p, a, c):
    p=np.array(p,float); a=np.array(a,float); c=np.array(c,float)
    ac=c-a; L=ac@ac
    if L < 1e-9: return float(np.hypot(*(p-a)))
    t=max(0,min(1,(p-a)@ac/L))
    return float(np.hypot(*(p-(a+t*ac))))

def _proof(T, track, obj_target, target, out, b):
    if not out:
        return
    try:
        from PIL import Image, ImageDraw
        m = np.clip(T, 0, np.percentile(T, 99.98))
        m = (m/(m.max()+1e-6)*255).astype(np.uint8)
        im = Image.fromarray(m).convert("RGB"); d = ImageDraw.Draw(im)
        if target is not None:
            ty, tx = target
            d.line([(tx-8, ty), (tx+8, ty)], fill=(0,128,255)); d.line([(tx, ty-8),(tx, ty+8)], fill=(0,128,255))
        for (f, x, y, s) in (track or []):
            d.ellipse([x-4, y-4, x+4, y+4], outline=(0,255,0))
        if track and len(track) >= 2:
            d.line([(track[0][1], track[0][2]), (track[-1][1], track[-1][2])], fill=(255,0,0), width=1)
        im.save(out)
    except Exception as e:
        print(f"(proof failed: {e})", file=sys.stderr)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--npy", action="store_true", help="input is a cached .npy stack")
    ap.add_argument("--bin", type=int, default=1)
    ap.add_argument("--out", default=None)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    r = detect(a.file, a.npy, a.bin, a.out)
    if a.json:
        print(json.dumps(r, indent=2))
    else:
        print(f"mode={r['mode']}  detected={r.get('detected')}  moving={r.get('moving')}")
        for k in ("n_candidates","n_active","active_frames","entry_px","exit_px",
                  "track_len_px","speed_px_per_frame","straightness_r2","direction_deg",
                  "peak_z_at_object","separation_px","separation_deg",
                  "plate_scale_arcsec_px","z_threshold","peak_z"):
            if k in r and r[k] is not None:
                v = r[k]
                if isinstance(v, list) and len(v) > 12: v = f"{v[0]}..{v[-1]} ({len(v)})"
                print(f"  {k:22s}: {v}")
