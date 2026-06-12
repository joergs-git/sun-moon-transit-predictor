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
    const elevationDeg = c.satAtClosest?.elevationDeg ?? null;
    if (minElevationDeg && elevationDeg != null && elevationDeg < minElevationDeg) continue;

    const epochMs = tleEpochMsByTag[c.satTag];
    const ageAtEventDays = Number.isFinite(epochMs) ? (atMs - epochMs) / MS_PER_DAY : null;

    rows.push({
      atMs,
      satTag: c.satTag,
      satName: c.satName,
      targetId: c.targetId,
      targetName: c.targetName,
      kind: c.kind,                                      // 'transit' | 'field'
      elevationDeg,
      sepDeg: c.closestApproachSepDeg,
      missArcmin: c.missArcmin,
      timeInFieldMs: c.timeInFieldMs,
      sunlit: c.sunlit,
      leadMs: atMs - nowMs,
      tleAgeAtEventDays: ageAtEventDays,
      confidence: confidenceFor(c.satTag, ageAtEventDays),
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
