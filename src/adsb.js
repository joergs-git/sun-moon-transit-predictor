// ADS-B fetcher: pulls dump1090-fa style aircraft.json and normalises fields
// to SI units. Heavy filtering happens here so the tracker only sees aircraft
// that have a usable position fix.

const FT_PER_M = 1 / 0.3048;
const KT_TO_MS = 0.514444;
const FTPM_TO_MS = 0.00508;
const MAX_POSITION_AGE_S = 30;

/**
 * @typedef {Object} Aircraft
 * @property {string}        icao
 * @property {string|null}   callsign
 * @property {number}        lat
 * @property {number}        lon
 * @property {number}        altMmsl
 * @property {'geometric'|'barometric'} altSource
 * @property {number|null}   groundSpeedMs
 * @property {number|null}   trackDeg
 * @property {number}        verticalRateMs
 * @property {number}        seenPosS
 * @property {number}        receivedAtMs   - wall-clock ms when sample was taken
 */

function ftToMeters(ft) {
  return ft / FT_PER_M;
}

function normalizeAircraft(raw, baseTimestampMs) {
  if (typeof raw.lat !== 'number' || typeof raw.lon !== 'number') return null;

  const altGeomFt = typeof raw.alt_geom === 'number' ? raw.alt_geom : null;
  const altBaroFt = typeof raw.alt_baro === 'number' ? raw.alt_baro : null;
  if (altGeomFt === null && altBaroFt === null) return null;

  const altMmsl = altGeomFt !== null ? ftToMeters(altGeomFt) : ftToMeters(altBaroFt);
  const altSource = altGeomFt !== null ? 'geometric' : 'barometric';

  const seenPosS = typeof raw.seen_pos === 'number' ? raw.seen_pos : 0;
  if (seenPosS > MAX_POSITION_AGE_S) return null;

  const callsign = typeof raw.flight === 'string' ? raw.flight.trim() || null : null;
  const groundSpeedMs = typeof raw.gs === 'number' ? raw.gs * KT_TO_MS : null;
  const trackDeg = typeof raw.track === 'number' ? raw.track : null;
  const vertRateFtpm = typeof raw.geom_rate === 'number'
    ? raw.geom_rate
    : typeof raw.baro_rate === 'number' ? raw.baro_rate : 0;

  return {
    icao: String(raw.hex).toLowerCase(),
    callsign,
    lat: raw.lat,
    lon: raw.lon,
    altMmsl,
    altSource,
    groundSpeedMs,
    trackDeg,
    verticalRateMs: vertRateFtpm * FTPM_TO_MS,
    seenPosS,
    receivedAtMs: baseTimestampMs - Math.round(seenPosS * 1000),
  };
}

/**
 * Parse a dump1090-fa aircraft.json payload.
 * @param {object} payload
 * @returns {Aircraft[]}
 */
export function parseAircraftJson(payload) {
  if (!payload || !Array.isArray(payload.aircraft)) return [];
  const baseMs = typeof payload.now === 'number' ? payload.now * 1000 : Date.now();
  /** @type {Aircraft[]} */
  const result = [];
  for (const raw of payload.aircraft) {
    const a = normalizeAircraft(raw, baseMs);
    if (a) result.push(a);
  }
  return result;
}

/**
 * Fetch aircraft.json over HTTP and return normalised aircraft.
 * @param {string} url
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Aircraft[]>}
 */
export async function fetchAircraft(url, opts = {}) {
  const { timeoutMs = 4000, fetchImpl = fetch } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`aircraft.json HTTP ${res.status}`);
    const payload = await res.json();
    return parseAircraftJson(payload);
  } finally {
    clearTimeout(timer);
  }
}
