// OpenSky Network REST client.
//
// Used by the optional schedule augmentation: a nightly cron pulls historical
// arrivals + departures at airports near the observer, and feeds those events
// into the predictor as additional observations. This catches recurring
// flights even on days when our own ADS-B receiver missed them (offline,
// shadowed, low signal) and gives the watchlist faster "warm-up" than the
// 14-day local window alone provides.
//
// API docs: https://openskynetwork.github.io/opensky-api/rest.html
// Anonymous quota is generous (4000 req/day); a free OAuth2 client raises it
// further. We default to anonymous because the scope here is one nightly run
// per airport, well under any plausible limit.

const DEFAULT_BASE_URL = 'https://opensky-network.org/api';
const ONE_DAY_S = 24 * 3600;

/**
 * @typedef {Object} OpenSkyFlight
 * @property {string|null} icao24
 * @property {number}      firstSeen        - unix seconds (departure detect)
 * @property {number}      lastSeen         - unix seconds (arrival detect)
 * @property {string|null} callsign         - ADS-B reported, trimmed
 * @property {string|null} estDepartureAirport
 * @property {string|null} estArrivalAirport
 */

function normalize(raw) {
  return {
    icao24: typeof raw.icao24 === 'string' ? raw.icao24.toLowerCase() : null,
    firstSeen: Number(raw.firstSeen),
    lastSeen: Number(raw.lastSeen),
    callsign: typeof raw.callsign === 'string' ? raw.callsign.trim() || null : null,
    estDepartureAirport: raw.estDepartureAirport ?? null,
    estArrivalAirport: raw.estArrivalAirport ?? null,
  };
}

/**
 * Fetch arrivals at a given ICAO airport between two unix-seconds bounds.
 * Returns [] on 404 / "no data for this window" rather than throwing.
 *
 * @param {string} icaoAirport - ICAO code, e.g. 'EDDF'
 * @param {number} beginSec
 * @param {number} endSec      - must be within ONE_DAY_S of beginSec (API constraint)
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number,
 *           headers?: Record<string, string> }} [opts]
 * @returns {Promise<OpenSkyFlight[]>}
 */
export async function arrivalsAt(icaoAirport, beginSec, endSec, opts = {}) {
  return fetchOpenSky('arrival', icaoAirport, beginSec, endSec, opts);
}

/**
 * Fetch departures at a given ICAO airport between two unix-seconds bounds.
 *
 * @param {string} icaoAirport
 * @param {number} beginSec
 * @param {number} endSec
 * @param {object} [opts]
 * @returns {Promise<OpenSkyFlight[]>}
 */
export async function departuresAt(icaoAirport, beginSec, endSec, opts = {}) {
  return fetchOpenSky('departure', icaoAirport, beginSec, endSec, opts);
}

async function fetchOpenSky(kind, icaoAirport, beginSec, endSec, opts = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    timeoutMs = 15_000,
    headers = {},
  } = opts;

  if (endSec - beginSec > ONE_DAY_S) {
    throw new Error(`OpenSky window too wide (${endSec - beginSec}s > ${ONE_DAY_S}s)`);
  }

  const url = `${baseUrl}/flights/${kind}?airport=${encodeURIComponent(icaoAirport)}`
            + `&begin=${beginSec}&end=${endSec}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers });
    if (res.status === 404) return [];   // OpenSky returns 404 for empty windows
    if (!res.ok) throw new Error(`OpenSky ${kind} HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.map(normalize).filter(f => f.callsign);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert an OpenSkyFlight into a predictor observation, using the most
 * relevant timestamp (`lastSeen` for arrivals — when the aircraft cleared the
 * destination; `firstSeen` for departures). The body is `Sun` or `Moon`
 * depending on whether the timestamp falls in daylight or darkness, which the
 * caller decides via its `assignBody` callback (we don't compute Sun/Moon
 * positions in this module — that stays in `geometry.js`).
 *
 * @param {OpenSkyFlight} flight
 * @param {'arrival'|'departure'} kind
 * @param {(timestampMs: number) => 'Sun'|'Moon'|null} assignBody
 * @returns {{ flight: string, body: 'Sun'|'Moon', timestampMs: number }|null}
 */
export function flightToObservation(flight, kind, assignBody) {
  if (!flight.callsign) return null;
  const ts = (kind === 'arrival' ? flight.lastSeen : flight.firstSeen) * 1000;
  const body = assignBody(ts);
  if (!body) return null;
  return { flight: flight.callsign, body, timestampMs: ts };
}
