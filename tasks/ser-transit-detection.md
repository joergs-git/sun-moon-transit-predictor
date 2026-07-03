# Future TODO — automated `.ser` transit detection

**Status:** feasibility proven locally (2026-07-03), not yet in any pipeline.

## Goal
Post-capture, confirm & measure whether an ISS / aircraft transit actually
happened in a SharpCap `.ser` and tag the file (`_confirmed`, `_finalsepNNN`) —
the step AstroSharper does today. Must be **cross-platform**: AstroSharper is
macOS-only and cannot be spawned from the Windows SharpCap listener.

## Plan / order
1. **[AstroSharper repo — in progress]** Port the validated algorithm to **native
   Swift** (Accelerate/vDSP, no OpenCV). Handoff prompt + full Python reference:
   see `scripts/detect/` (README + `ser_transit.py`). Acceptance tests + expected
   results are in the README.
2. **[future]** Windows-post-capture variant: a separate real-CPython (numpy)
   watcher on the SharpCap PC, or reuse the Swift binary if run on a Mac in the
   loop. Deferred.
3. **[future]** Optionally a watcher on the NAS/Pi that processes transferred
   `.ser` files and renames them — decoupled from capture.

## Blocking open item
Reconcile the measured **separation** with our existing `finalsep` definition
(to Sun centre? predicted ADS-B point? limb?) and the plate-scale source
(disc-fit vs. known focal length). Test showed 0.228° vs the file's `finalsep065`
(0.65°). Resolve before enabling filename tagging.

## Reference
`scripts/detect/ser_transit.py` (validated), `scripts/detect/proofs/*.png`,
`scripts/detect/README.md`. Sample captures used: the Vega-ISS dual-rig pair and
the LUNT `sun_plane_…_finalsep065.ser`.
