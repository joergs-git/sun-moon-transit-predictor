// Sky-target observation plan ("Drehbuch") — the read-model that merges every
// satellite × sky-target pass into one time-sorted, confidence-rated timeline
// (M83). No new compute: it consumes the candidates predictSkyTargetTransits
// already produced and just ranks, rates and flags them.
//
// See tasks/dso-iss-path-prediction.md §7 (confidence) and §11 (timeline).

const MS_PER_DAY = 86_400_000;

/**
 * Confidence in a predicted pass, from the propagating TLE's age AT THE EVENT
 * (not now): a far-future event uses a TLE that will be many days stale by
 * then, so its cross-track position is uncertain to kilometres → arcminutes in
 * a narrow field. The daily TLE refresh shrinks this as the event nears, so a
 * a "🟠 rough" event 6 days out becomes "🟢 sure" closer in.
 *
 *   < 1 d → green · 1–3 d → amber · 3–6 d → orange · > 6 d → red
 *
 * The ISS is additionally capped: its ~monthly reboosts invalidate SGP4
 * abruptly (not just by linear drift), so an ISS event more than ~2 days out is
 * never rated better than amber regardless of TLE freshness.
 *
 * @param {string} tag satellite tag ('ISS' | 'HST' | 'CSS' | …)
 * @param {number|null} ageAtEventDays TLE age (days) at the event time
 * @returns {'green'|'amber'|'orange'|'red'|null}
 */
export function confidenceFor(tag, ageAtEventDays) {
  if (ageAtEventDays == null || !Number.isFinite(ageAtEventDays)) return null;
  const a = Math.abs(ageAtEventDays);
  let level = a < 1 ? 'green' : a < 3 ? 'amber' : a < 6 ? 'orange' : 'red';
  if (tag === 'ISS' && a >= 2 && level === 'green') level = 'amber';
  return level;
}

export const CONFIDENCE_RANK = { green: 3, amber: 2, orange: 1, red: 0 };

/**
 * Build a compact, sketch-ready geometry blob for a future sky-target pass, so
 * the Sky-plan row can be clicked to preview the crossing in the FOV before it
 * reaches the live lifecycle. Mirrors the server's `transitGeom` shape used by
 * the Sun/Moon next-transit rows: { bodyAt, aircraftAt, transitPath }, with the
 * satellite playing the aircraft role and the framed object the body role. The
 * dense per-pass path is DOWNSAMPLED to at most `maxPts` points — plenty to draw
 * the crossing line, but keeps the per-tick plan (in /api/state) small.
 *
 * @param {object} c A sky-target candidate from predictSkyTargetTransits.
 * @param {number} [maxPts] cap on path points (default 24)
 * @returns {{bodyAt:object, aircraftAt:object, bodyDiameterDeg:number|null, transitPath:Array}|null}
 */
export function skyGeom(c, maxPts = 24) {
  const sat = c?.satAtClosest;
  const tgt = c?.targetAtClosest;
  if (!sat || !tgt) return null;
  const path = Array.isArray(c.transitPath) ? c.transitPath : [];
  const step = Math.max(1, Math.ceil(path.length / maxPts));
  const transitPath = [];
  for (let i = 0; i < path.length; i += step) {
    const p = path[i];
    transitPath.push({
      tOffsetMs: p.tOffsetMs,
      aircraftAz: p.satAz, aircraftEl: p.satEl,
      bodyAz: p.targetAz, bodyEl: p.targetEl,
    });
  }
  return {
    bodyAt: { az: tgt.azimuthDeg, el: tgt.elevationDeg },
    aircraftAt: { az: sat.azimuthDeg, el: sat.elevationDeg, rangeM: sat.rangeM ?? null },
    bodyDiameterDeg: Number.isFinite(c.objectDiameterDeg) ? c.objectDiameterDeg : null,
    transitPath,
  };
}

/** True when `level` meets or exceeds `min` (e.g. atLeastConfidence('amber','green') === false). */
export function atLeastConfidence(level, min) {
  if (!level || !min) return false;
  return (CONFIDENCE_RANK[level] ?? -1) >= (CONFIDENCE_RANK[min] ?? 99);
}

/**
 * Build the time-sorted observation plan from a flat list of sky-target
 * candidates (across all satellites × targets).
 *
 * @param {Array<object>} candidates from predictSkyTargetTransits
 * @param {{
 *   nowMs: number,
 *   tleEpochMsByTag?: Record<string, number>,
 *   planHorizonDays?: number,
 *   minElevationDeg?: number,
 *   reslewMinGapMin?: number,
 * }} opts
 * @returns {Array<object>} plan rows, soonest first
 */
export function buildSkyTargetPlan(candidates, opts = {}) {
  const {
    nowMs,
    tleEpochMsByTag = {},
    planHorizonDays = 7,
    minElevationDeg = 0,
    reslewMinGapMin = 5,
    firstPerCombo = false,        // keep only the SOONEST pass per satellite×object
  } = opts;
  const horizonMs = planHorizonDays * MS_PER_DAY;

  const rows = [];
  for (const c of candidates ?? []) {
    const atMs = c.closestApproachAtMs;
    if (!Number.isFinite(atMs)) continue;
    if (atMs < nowMs - 60_000) continue;                 // already past (small grace)
    if (atMs - nowMs > horizonMs) continue;              // beyond the plan horizon
    const sat = c.satAtClosest;
    const elevationDeg = sat?.elevationDeg ?? null;
    if (minElevationDeg && elevationDeg != null && elevationDeg < minElevationDeg) continue;

    // Epoch may be a fixed ms value (single TLE) or a function of the event
    // time (a segmented supplemental ephemeris resolves the nearest segment),
    // so the confidence reflects the age of the segment ACTUALLY used to
    // propagate this event — near-zero for a covered SUP-GP pass → green.
    const epochRaw = tleEpochMsByTag[c.satTag];
    const epochMs = typeof epochRaw === 'function' ? epochRaw(atMs) : epochRaw;
    const ageAtEventDays = Number.isFinite(epochMs) ? (atMs - epochMs) / MS_PER_DAY : null;

    rows.push({
      atMs,
      satTag: c.satTag,
      satName: c.satName,
      targetId: c.targetId,
      targetName: c.targetName,
      kind: c.kind,                                      // 'transit' | 'field'
      elevationDeg,
      azimuthDeg: sat?.azimuthDeg ?? null,
      // Sky position of the flying object at closest approach — J2000 (matches
      // the catalogue frame, so it can be pinned as a custom { raHours, decDeg }
      // target) plus of-date/JNow. Null when the satellite state was unavailable.
      satRaHours: sat?.raHours ?? null,
      satDecDeg: sat?.decDeg ?? null,
      satRaHoursOfDate: sat?.raHoursOfDate ?? null,
      satDecDegOfDate: sat?.decDegOfDate ?? null,
      // Lead-in / lead-out track positions (N min before/after closest); null
      // when below the horizon at that offset or the lead is disabled.
      satBefore: c.satBefore ?? null,
      satAfter: c.satAfter ?? null,
      sepDeg: c.closestApproachSepDeg,
      missArcmin: c.missArcmin,
      timeInFieldMs: c.timeInFieldMs,
      sunlit: c.sunlit,
      leadMs: atMs - nowMs,
      tleAgeAtEventDays: ageAtEventDays,
      confidence: confidenceFor(c.satTag, ageAtEventDays),
      // Sketch-ready geometry so a FUTURE sky-target pass is clickable in the
      // Sky plan → FOV preview, before it enters the live lifecycle. Compact
      // (downsampled path) to keep /api/state small.
      geom: skyGeom(c),
      objectDiameterDeg: c.objectDiameterDeg ?? null,
    });
  }

  rows.sort((a, b) => a.atMs - b.atMs);

  // "Next opportunity" view: keep only the soonest pass per satellite×object,
  // so you can see when each combo first comes into reach even if it is weeks
  // out (rows are sorted, so the first seen per key is the soonest).
  let out = rows;
  if (firstPerCombo) {
    const seen = new Set();
    out = rows.filter((r) => {
      const k = `${r.satTag}|${r.targetId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // Single-scope conflict: an event that starts within the re-slew + refocus
  // window of the previous one can't also be caught by the same telescope.
  const gapMs = reslewMinGapMin * 60_000;
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].atMs - out[i - 1].atMs < gapMs) {
      out[i].conflictWithPrev = true;
      out[i].conflictGapMs = out[i].atMs - out[i - 1].atMs;
    }
  }
  return out;
}
