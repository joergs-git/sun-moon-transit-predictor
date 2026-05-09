// Callsign → route lookup via the free adsbdb.com API.
// Includes a small in-memory TTL cache (positive + negative results) and
// degrades gracefully: any error or missing route returns null and is cached
// briefly so we don't hammer the API.

const DEFAULT_BASE_URL = 'https://api.adsbdb.com/v0/callsign/';
const DEFAULT_TTL_MS = 60 * 60 * 1000;        // 1 h
const DEFAULT_NEGATIVE_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * @typedef {Object} Route
 * @property {string} flight
 * @property {{ name?: string, iata?: string, icao?: string }} [airline]
 * @property {{ name?: string, iata?: string, icao?: string, country?: string }} [origin]
 * @property {{ name?: string, iata?: string, icao?: string, country?: string }} [destination]
 */

function normalize(payload) {
  const fr = payload?.response?.flightroute;
  if (!fr) return null;
  const airport = (a) => a ? {
    name: a.name,
    iata: a.iata_code ?? a.iata,
    icao: a.icao_code ?? a.icao,
    country: a.country_name ?? a.country,
  } : undefined;
  return {
    flight: fr.callsign_iata || fr.callsign_icao || fr.callsign,
    airline: fr.airline ? {
      name: fr.airline.name,
      iata: fr.airline.iata,
      icao: fr.airline.icao,
    } : undefined,
    origin: airport(fr.origin),
    destination: airport(fr.destination),
  };
}

export class RouteLookup {
  constructor({
    fetchImpl = fetch,
    baseUrl = DEFAULT_BASE_URL,
    ttlMs = DEFAULT_TTL_MS,
    negativeTtlMs = DEFAULT_NEGATIVE_TTL_MS,
    timeoutMs = 4000,
    now = () => Date.now(),
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.ttlMs = ttlMs;
    this.negativeTtlMs = negativeTtlMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    /** @type {Map<string, { route: Route|null, expiresAt: number }>} */
    this.cache = new Map();
  }

  /**
   * @param {string} callsign
   * @returns {Promise<Route|null>}
   */
  async lookup(callsign) {
    if (!callsign) return null;
    const key = String(callsign).trim().toUpperCase();
    if (!key) return null;
    const t = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > t) return cached.route;

    let route = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.baseUrl + encodeURIComponent(key), {
          signal: controller.signal,
        });
        if (res.status === 404) {
          route = null;
        } else if (!res.ok) {
          throw new Error(`adsbdb HTTP ${res.status}`);
        } else {
          const json = await res.json();
          route = normalize(json);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      route = null;
    }

    const ttl = route ? this.ttlMs : this.negativeTtlMs;
    this.cache.set(key, { route, expiresAt: t + ttl });
    return route;
  }
}
