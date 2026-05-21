// Free adsbdb.com API client.
//   - `RouteLookup`     : callsign → route (airline + origin/destination)
//   - `AircraftLookup`  : Mode-S hex → static airframe (reg/type/operator/photo)
// Both classes carry their own in-memory TTL cache (positive + negative
// results) and degrade gracefully: any error or miss returns null and is
// cached briefly so we don't hammer the public API.

const DEFAULT_BASE_URL = 'https://api.adsbdb.com/v0/callsign/';
const DEFAULT_AIRCRAFT_BASE_URL = 'https://api.adsbdb.com/v0/aircraft/';
const DEFAULT_TTL_MS = 60 * 60 * 1000;        // 1 h
const DEFAULT_AIRCRAFT_TTL_MS = 6 * 60 * 60 * 1000; // 6 h (static data)
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

/**
 * Free Mode-S hex → static airframe lookup (adsbdb /v0/aircraft/<hex>).
 *
 * Returns a shape compatible with AirnavClient's normalizeAircraft so the
 * /api/acinfo proxy can use it as a drop-in fallback when AirNav is off /
 * out of credits — the frontend (web/app.js acinfoRows) doesn't have to
 * branch on the source.
 *
 * Note: adsbdb has no live-flight endpoint, so only the static `aircraft`
 * half of the AirNav payload is populated by this client — `live` stays
 * null. Routes for an active flight are still available separately via
 * RouteLookup (callsign-keyed).
 */
export class AircraftLookup {
  constructor({
    fetchImpl = fetch,
    baseUrl = DEFAULT_AIRCRAFT_BASE_URL,
    ttlMs = DEFAULT_AIRCRAFT_TTL_MS,
    negativeTtlMs = DEFAULT_NEGATIVE_TTL_MS,
    timeoutMs = 5000,
    now = () => Date.now(),
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.ttlMs = ttlMs;
    this.negativeTtlMs = negativeTtlMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    /** @type {Map<string, { value: object|null, expiresAt: number }>} */
    this.cache = new Map();
  }

  /**
   * @param {string} hex  6-digit ICAO Mode-S code.
   * @returns {Promise<object|null>}  normalizeAircraft-shaped object or null.
   */
  async lookup(hex) {
    if (!hex) return null;
    const key = String(hex).trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(key)) return null;
    const t = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > t) return cached.value;

    let value = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.baseUrl + encodeURIComponent(key), {
          signal: controller.signal,
        });
        if (res.status === 404) {
          value = null;
        } else if (!res.ok) {
          throw new Error(`adsbdb HTTP ${res.status}`);
        } else {
          const json = await res.json();
          value = normalizeAircraft(json?.response?.aircraft, key);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      value = null;
    }

    const ttl = value ? this.ttlMs : this.negativeTtlMs;
    this.cache.set(key, { value, expiresAt: t + ttl });
    return value;
  }
}

/**
 * Adapt the adsbdb /v0/aircraft payload to the AirnavClient normaliseAircraft
 * shape (so the /api/acinfo response — and the frontend rendering — stays
 * unchanged regardless of which source served it).
 *
 * Mapping notes:
 *   - typeDescription: adsbdb gives `manufacturer` + `type` separately. We
 *     compose "Boeing 737-800" for the spec table.
 *   - operatorIcao: adsbdb's `registered_owner_operator_flag_code` is the
 *     ICAO-ish airline code (e.g. "RYR" for Ryanair) and is exactly what
 *     AirNav puts in `companyIcao`.
 *   - photo: prefer the thumbnail (small, fast) and fall back to the full
 *     photo, mirroring AirnavClient.
 *   - Fields AirNav has but adsbdb doesn't (classDescription, typeIata,
 *     firstFlight, serialNumber, decommissioned) stay null — the frontend
 *     already conditionally renders each row only when present.
 */
function normalizeAircraft(a, modeSFallback) {
  if (!a) return null;
  const make = a.manufacturer ?? null;
  const type = a.type ?? null;
  const typeDescription = make && type ? `${make} ${type}` : (type ?? make ?? null);
  return {
    modeS: (a.mode_s ?? modeSFallback ?? '').toUpperCase() || null,
    registration: a.registration ?? null,
    typeIcao: a.icao_type ?? null,
    typeIata: null,
    typeDescription,
    classDescription: null,
    operator: a.registered_owner ?? null,
    operatorIcao: a.registered_owner_operator_flag_code ?? null,
    firstFlight: null,
    serialNumber: null,
    decommissioned: false,
    photo: a.url_photo_thumbnail ?? a.url_photo ?? null,
  };
}
