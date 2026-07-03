# SER transit detector — validated reference (for later use)

Reference implementation + proof that a **cross-platform** post-capture step can
confirm & measure a transit directly from a SharpCap `.ser` file — no macOS-only
AstroSharper, no OpenCV. Kept here for a **future todo**: the detection is planned
to land first as **native Swift inside the macOS AstroSharper app**
(github.com/joergs-git/AstroSharper), and later (future) as a Windows-post-capture
step. This folder is the source-of-truth spec + a working Python reference to port.

> Status: **feasibility proven locally, not wired into the predictor pipeline.**
> These are standalone tools / reference material only.

## Files
- `ser_transit.py` — the validated detector (pure numpy + scipy + PIL). Reads a
  `.ser` directly, or a cached `.npy` binned stack (`--npy`).
- `cache_ser.py` — reads a `.ser` once, block-reduces every frame and saves a
  float16 stack `.npy` (for fast algorithm iteration without re-reading GBs).
- `proofs/` — debug images from the validated runs (max-σ map, green = object,
  red = fitted track, blue cross = target).

## How it works
1. Bin each frame (block-mean, factor 4 for the big star-field sensors, 3 for the
   solar sensor). Raw Bayer needs no debayer — binning averages it to luminance.
2. `bg` = per-pixel temporal **median** → removes the tracked target (Vega / the
   solar disc), static stars and hot pixels.
3. **Mode:** `disc = bg > max(8, 0.12·bg.max())`; disc coverage >8% ⇒ **Sun**
   (dark silhouette, `sig = bg−frame`) else **star field** (bright ISS, `sig =
   frame−bg`).
4. **σ-image:** divide each frame's residual by that pixel's temporal std. This
   suppresses the shimmering Hα limb and hot pixels and — crucially — avoids a
   MAD/σ estimate that collapses to 0 on quantized 8-bit data.
5. Per-frame argmax of the σ-image → candidates above **6σ**; drop persistent
   locations (a fixed pixel picked in >6% of frames is not a transit); mask the
   sensor border (amp-glow / rolling-shutter row-0 fakes a track).
6. **RANSAC** a constant-velocity line (param by frame), 3-px tol, then a
   **contiguity gate** (`inliers/(span+1) ≥ 0.25` or `inliers ≥ 8`) so a line
   through scattered noise is rejected. Survives ⇒ moving transit. Else the
   strongest non-persistent 6σ blob ⇒ single-frame transit (e.g. ISS bright for
   ~1 frame).
7. Separation = closest approach of the track to the target; on the Sun the disc
   radius gives a plate scale ⇒ degrees (solar diameter 0.5334°).

## Validated results (2026-07-03)
Run end-to-end on real captures; each verified visually (see `proofs/`):

| Capture | Sensor | Result |
|---|---|---|
| ISS mono | 4784×4790 MONO8, 210 fr | ✅ ISS single blob, **frame 46 ≈ (768,288)px** (solar panels visible) |
| ISS color | 6248×4176 RGGB8, 343 fr | ✅ moving streak **frames ~91→97**, ~279 px/frame, R²≈1.0 |
| Sun plane | 1936×1216 MONO8, 5870 fr | ✅ silhouette **frames ~1380→1539**, ~5.4 px/frame, ~0.23° from disc centre |

Timing: ~8 s for the 4.8 GB mono file, ~160 s for the 13.8 GB sun file (one read+bin).

## Usage
```bash
python3 ser_transit.py capture.ser --bin 4 --json --out proof.png
# fast iteration on a cached stack:
python3 cache_ser.py capture.ser 4 cached.npy
python3 ser_transit.py cached.npy --npy --bin 4 --json
```

## SER format
178-byte header, then frame pixels, then optional `FrameCount × int64` timestamps.
LE int32 at byte offsets: 14 LuID, 18 ColorID, 22 LittleEndian, 26 Width,
30 Height, 34 PixelDepth(bits), 38 FrameCount. `bytesPerPixel = depth≤8?1:2`;
`planes = ColorID≥100?3:1`; frame `i` at `178 + i·W·H·bytesPerPixel·planes`.
ColorID: 0=MONO, 8–11=Bayer, 100/101=RGB/BGR.

## Open item before production
Measured Sun separation (closest approach to **disc centre**) = 0.228°, but the
test file is tagged `finalsep065` (0.65°). Reconcile how `finalsep` is defined
(to Sun centre / predicted ADS-B point / limb?) and the plate-scale source
(disc-fit vs. known focal length) before wiring up filename tagging.
