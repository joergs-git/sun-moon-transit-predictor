// Aircraft operator-class classification + an optional pipeline filter.
// v0.48.0
//
// Goal: let the user restrict the WHOLE transit pipeline (candidates → display
// → SharpCap arming → Pushover) to a chosen set of aircraft classes — e.g.
// "only military" or "only general aviation". The classification uses ONLY the
// data dump1090 already gives us per aircraft (callsign, ADS-B emitter
// category, ICAO 24-bit address), so it needs no paid lookup and runs every
// tick for free.
//
// Classes:
//   'military'   — callsign matches a known military call-sign prefix, OR the
//                  ICAO address falls in a published military allocation block.
//   'ga'         — general aviation: an all-letter civil registration used as
//                  the callsign (e.g. 'DEABC' = D-EABC), or a light/small
//                  ADS-B emitter category (A1/A2) with no airline callsign.
//   'commercial' — scheduled airline flight: '<3-letter ICAO airline><flight>'
//                  (e.g. 'DLH2AB'), or a large/heavy emitter category (A3–A5).
//   'unknown'    — not enough signal yet (no callsign and no useful category).
//
// HEURISTIC BY NATURE. Military aircraft frequently fly with a civilian-style
// callsign, a tactical callsign, or none at all — those read as 'unknown' or
// 'ga'. GA aircraft with US-style registrations (N12345, digits) may read as
// 'commercial'. Over NW-Germany the dominant GA tail numbers are letter-only
// (D-E…, PH-…, OO-…) and the common military traffic uses GAF/NATO call-signs,
// so the heuristic works well for this site. Documented in the Settings UI.

/** The three "real" classes the filter can select, in display order. */
export const AIRCRAFT_CLASSES = ['military', 'ga', 'commercial'];

// Known military call-sign prefixes (ICAO telephony / commonly seen over
// central Europe). Matched case-insensitively against the start of the
// callsign. German military most often uses 'GAF' (German Air Force) — the
// user's site sees these regularly. Kept as a curated, extensible set rather
// than a giant table; add prefixes here as new traffic is identified.
const MIL_CALLSIGN_PREFIXES = [
  'GAF',          // German Air Force (Luftwaffe)
  'GAM',          // German military (army/navy air)
  'CFC',          // Canadian Forces
  'RRR',          // Royal Air Force (Ascot)
  'RCH',          // US Air Mobility Command (Reach)
  'RFR',          // (RAF variants)
  'NATO', 'NAF',  // NATO
  'CTM',          // French military (Cotam)
  'FAF',          // French Air Force
  'BAF',          // Belgian Air Force
  'IAM',          // Italian Air Force
  'NOW',          // Royal Netherlands AF
  'PLF',          // Polish Air Force
  'HUF',          // Hungarian
  'CEF', 'CZAF',  // Czech
  'SUI', 'SVF',   // (Swiss/various)
  'NVY', 'NAVY', 'ARMY',
];

// Published ICAO 24-bit military allocation blocks (a representative subset —
// the big, widely-cited ones). Each entry is [loInclusive, hiInclusive] over
// the 24-bit hex value. Used as a fallback when the callsign is absent or
// civilian-styled. Not exhaustive; extend as needed.
const MIL_HEX_RANGES = [
  [0xadf7c8, 0xafffff], // United States military
  [0x43c000, 0x43cfff], // United Kingdom military
];

/** True when the callsign looks like a scheduled airline flight number. */
function looksLikeAirlineFlight(cs) {
  // '<3 letters><digit><any alnum>' — the standard ICAO flight callsign, e.g.
  // DLH2AB, BAW117, RYR4ZK. The leading digit after exactly three letters is
  // the discriminator vs an all-letter registration.
  return /^[A-Z]{3}[0-9][0-9A-Z]*$/.test(cs);
}

/** True when the callsign looks like an all-letter civil registration. */
function looksLikeRegistration(cs) {
  // Tail numbers broadcast as a callsign drop the dash: 'D-EABC' → 'DEABC',
  // 'PH-XYZ' → 'PHXYZ'. Over central Europe these are letter-only, 4–7 chars.
  // (US N-numbers contain digits and are intentionally NOT matched here — they
  // are rare at this site and would collide with flight numbers.)
  return /^[A-Z]{4,7}$/.test(cs);
}

/**
 * Classify one aircraft into a broad operator class.
 *
 * @param {{callsign?: string|null, category?: string|null, icao?: string|null}} ac
 * @returns {'military'|'ga'|'commercial'|'unknown'}
 */
export function classifyAircraft(ac) {
  const cs = String(ac?.callsign ?? '').trim().toUpperCase();
  const cat = String(ac?.category ?? '').trim().toUpperCase();
  const hex = parseInt(String(ac?.icao ?? '').trim(), 16);

  // 1) Military — strongest intent signal first.
  if (cs && MIL_CALLSIGN_PREFIXES.some((p) => cs.startsWith(p))) return 'military';
  if (Number.isFinite(hex) && MIL_HEX_RANGES.some(([lo, hi]) => hex >= lo && hex <= hi)) {
    return 'military';
  }

  // 2) Scheduled airline flight number → commercial.
  if (cs && looksLikeAirlineFlight(cs)) return 'commercial';

  // 3) Light/small emitter category → general aviation.
  if (cat === 'A1' || cat === 'A2') return 'ga';

  // 4) All-letter registration callsign → general aviation.
  if (cs && looksLikeRegistration(cs)) return 'ga';

  // 5) Large/heavy emitter category with no airline callsign → still commercial
  //    (cargo/charter often broadcast a registration but fly a heavy jet).
  if (cat === 'A3' || cat === 'A4' || cat === 'A5') return 'commercial';

  // 6) Nothing usable yet.
  return 'unknown';
}

/**
 * Apply the operator-class filter to a list of aircraft.
 *
 * Each returned aircraft is tagged with `aircraftClass` (so the UI can show it)
 * regardless of whether filtering is active. When the filter is disabled, the
 * full list is returned (only tagged). When enabled, only aircraft whose class
 * is in `cfg.classes` survive — 'unknown' is excluded unless explicitly listed.
 *
 * @param {Array<object>} list   parsed aircraft (from adsb.js)
 * @param {{enabled?: boolean, classes?: string[]}} [cfg]
 * @returns {{ kept: Array<object>, total: number, dropped: number }}
 */
export function filterAircraft(list, cfg) {
  const arr = Array.isArray(list) ? list : [];
  // Always tag — cheap, and the class is useful in the UI even unfiltered.
  for (const ac of arr) ac.aircraftClass = classifyAircraft(ac);

  const enabled = cfg?.enabled === true;
  const allow = Array.isArray(cfg?.classes) ? cfg.classes : [];
  // Disabled, or "all classes selected" → no-op pass-through.
  if (!enabled || allow.length === 0) {
    return { kept: arr, total: arr.length, dropped: 0 };
  }
  const allowSet = new Set(allow);
  const kept = arr.filter((ac) => allowSet.has(ac.aircraftClass));
  return { kept, total: arr.length, dropped: arr.length - kept.length };
}
