// AirNav On-Demand API v2 client (server-side only).
//
// Holds the bearer token and talks to https://api.airnavradar.com/v2 — the
// token NEVER reaches the browser (the web UI calls our /api/acinfo proxy).
// Every upstream response is billed in credits (`cost` field), and there is
// no free rate limit, so we cache aggressively (static aircraft data is
// stable for hours; live-flight data refreshes faster) and only call on an
// explicit user click. Any error / non-2xx / `success:false` degrades to
// null and is negative-cached briefly so a bad token can't drain credits.
//
// Contract (from the v2 OpenAPI):
//   GET  /aircraft?modeS=<hex>            → GetAircraftResponse.aircraft
//   POST /flights/live {modeSHexCodes:[]} → FlightsResponse.flights[0]
//   Auth: Authorization: Bearer <token>

const DEFAULT_BASE_URL = 'https://api.airnavradar.com/v2';

/** Curated subset of ApiAircraft for the FOV info box. */
function normalizeAircraft(a) {
  if (!a) return null;
  return {
    modeS: a.modeS ?? null,
    registration: a.registration ?? null,
    typeIcao: a.typeIcao ?? null,
    typeIata: a.typeIata ?? null,
    typeDescription: a.typeDescription ?? null,
    classDescription: a.classDescription ?? null,
    operator: a.companyName ?? null,
    operatorIcao: a.companyIcao ?? null,
    firstFlight: a.firstFlight ?? null,
    serialNumber: a.serialNumber ?? null,
    decommissioned: a.decommissioned === true,
    // Prefer a thumbnail (small, fast); fall back to a full photo.
    photo: (Array.isArray(a.thumbnails) && a.thumbnails[0])
      || (Array.isArray(a.photos) && a.photos[0]) || null,
  };
}

/** Curated subset of ApiFlight (live route + position). */
function normalizeFlight(f) {
  if (!f) return null;
  const airport = (icao, iata, name, city) =>
    (icao || iata || name) ? { icao: icao ?? null, iata: iata ?? null, name: name ?? null, city: city ?? null } : null;
  return {
    callsign: f.callsign ?? null,
    flight: f.flightNumberIata ?? f.flightNumberIcao ?? f.callsign ?? null,
    airline: f.airlineName ?? null,
    origin: airport(f.depAirportIcao, f.depAirportIata, f.depAirportName, f.depAirportCity),
    destination: airport(f.arrAirportIcao, f.arrAirportIata, f.arrAirportName, f.arrAirportCity),
    scheduledDeparture: f.scheduledDeparture ?? null,
    estimatedArrival: f.estimatedArrival ?? null,
    scheduledArrival: f.scheduledArrival ?? null,
    status: f.status ?? null,
    latitude: Number.isFinite(f.latitude) ? f.latitude : null,
    longitude: Number.isFinite(f.longitude) ? f.longitude : null,
    altitude: Number.isFinite(f.altitude) ? f.altitude : null,
    groundSpeed: Number.isFinite(f.groundSpeed) ? f.groundSpeed : null,
    heading: Number.isFinite(f.heading) ? f.heading : null,
  };
}

export class AirnavClient {
  /**
   * @param {{
   *   token: string, baseUrl?: string, fetchImpl?: typeof fetch,
   *   ttlMs?: number, liveTtlMs?: number, negativeTtlMs?: number,
   *   timeoutMs?: number, now?: () => number,
   * }} opts
   */
  constructor({
    token,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    ttlMs = 6 * 60 * 60 * 1000,        // static aircraft data: 6 h
    liveTtlMs = 60 * 1000,            // live flight: 60 s
    negativeTtlMs = 5 * 60 * 1000,    // failures: 5 min
    timeoutMs = 6000,
    now = () => Date.now(),
  } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.liveTtlMs = liveTtlMs;
    this.negativeTtlMs = negativeTtlMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    /** @type {Map<string,{ value:any, expiresAt:number }>} */
    this.cache = new Map();
  }

  _cacheGet(key) {
    const e = this.cache.get(key);
    if (e && e.expiresAt > this.now()) return e.value;
    return undefined;
  }

  _cacheSet(key, value, ttl) {
    this.cache.set(key, { value, expiresAt: this.now() + ttl });
  }

  async _request(path, { method = 'GET', body } = {}) {
    if (!this.token) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) return null;
      const json = await res.json();
      // API returns { success, comment, cost, ... } — treat success:false
      // as a soft miss (e.g. unknown aircraft) rather than throwing.
      if (json && json.success === false) return { ...json, _miss: true };
      return json;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Static airframe data for a Mode-S hex. Cached `ttlMs`. */
  async aircraftByHex(hex) {
    if (!hex) return null;
    const key = `ac:${String(hex).toLowerCase()}`;
    const hit = this._cacheGet(key);
    if (hit !== undefined) return hit;
    const json = await this._request(`/aircraft?modeS=${encodeURIComponent(hex)}`);
    const value = json && !json._miss ? normalizeAircraft(json.aircraft) : null;
    this._cacheSet(key, value, value ? this.ttlMs : this.negativeTtlMs);
    return value;
  }

  /** Live flight (route + position) for a Mode-S hex. Cached `liveTtlMs`. */
  async liveByHex(hex) {
    if (!hex) return null;
    const key = `live:${String(hex).toLowerCase()}`;
    const hit = this._cacheGet(key);
    if (hit !== undefined) return hit;
    const json = await this._request('/flights/live', {
      method: 'POST',
      body: { modeSHexCodes: [String(hex).toUpperCase()], incLastKnownPos: true },
    });
    const f = json && !json._miss && Array.isArray(json.flights) ? json.flights[0] : null;
    const value = normalizeFlight(f);
    this._cacheSet(key, value, value ? this.liveTtlMs : this.negativeTtlMs);
    return value;
  }

  /**
   * Combined lookup for the FOV info box: static airframe + live flight.
   * Both upstream calls are billed, so this is only invoked on an explicit
   * row click (see server.js /api/acinfo).
   */
  async lookup(hex) {
    const [aircraft, live] = await Promise.all([
      this.aircraftByHex(hex),
      this.liveByHex(hex),
    ]);
    if (!aircraft && !live) return null;
    return { hex: String(hex).toLowerCase(), aircraft, live };
  }
}
