import { describe, expect, it } from 'vitest';
import { AirnavClient } from '../src/airnav.js';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}
const ok = (body) => ({ ok: true, status: 200, async json() { return body; } });

const AIRCRAFT = {
  success: true, cost: 1, aircraft: {
    modeS: '3C6444', registration: 'D-AIXA', typeIcao: 'A359',
    typeDescription: 'Airbus A350-900', classDescription: 'wide-body',
    companyName: 'Lufthansa', companyIcao: 'DLH', firstFlight: '2016-12-19',
    serialNumber: '74', photos: ['https://x/p.jpg'], thumbnails: ['https://x/t.jpg'],
    decommissioned: false,
  },
};
const LIVE = {
  success: true, cost: 1, flights: [{
    callsign: 'DLH400', flightNumberIata: 'LH400', airlineName: 'Lufthansa',
    depAirportIcao: 'EDDF', depAirportIata: 'FRA', depAirportName: 'Frankfurt', depAirportCity: 'Frankfurt',
    arrAirportIcao: 'KJFK', arrAirportIata: 'JFK', arrAirportName: 'JFK', arrAirportCity: 'New York',
    scheduledDeparture: '2024-05-01T10:00:00Z', estimatedArrival: '2024-05-01T18:30:00Z',
    status: 'EN_ROUTE', latitude: 51.2, longitude: 7.1, altitude: 36000,
    groundSpeed: 470, heading: 285,
  }],
};

describe('AirnavClient', () => {
  it('maps /aircraft and sends a bearer token', async () => {
    const ff = fakeFetch(() => ok(AIRCRAFT));
    const c = new AirnavClient({ token: 'SECRET', fetchImpl: ff });
    const a = await c.aircraftByHex('3c6444');
    expect(ff.calls[0].url).toBe('https://api.airnavradar.com/v2/aircraft?modeS=3c6444');
    expect(ff.calls[0].init.headers.Authorization).toBe('Bearer SECRET');
    expect(a.registration).toBe('D-AIXA');
    expect(a.operator).toBe('Lufthansa');
    expect(a.typeDescription).toBe('Airbus A350-900');
    expect(a.serialNumber).toBe('74');
    expect(a.photo).toBe('https://x/t.jpg');   // thumbnail preferred
  });

  it('POSTs /flights/live with the hex and maps the route', async () => {
    const ff = fakeFetch((url, init) => {
      expect(url).toBe('https://api.airnavradar.com/v2/flights/live');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ modeSHexCodes: ['3C6444'], incLastKnownPos: true });
      return ok(LIVE);
    });
    const c = new AirnavClient({ token: 'T', fetchImpl: ff });
    const f = await c.liveByHex('3c6444');
    expect(f.flight).toBe('LH400');
    expect(f.origin.iata).toBe('FRA');
    expect(f.destination.city).toBe('New York');
    expect(f.status).toBe('EN_ROUTE');
    expect(f.latitude).toBe(51.2);
  });

  it('caches within the TTL (one upstream call for repeated lookups)', async () => {
    const ff = fakeFetch(() => ok(AIRCRAFT));
    const c = new AirnavClient({ token: 'T', fetchImpl: ff });
    await c.aircraftByHex('abc123');
    await c.aircraftByHex('abc123');
    expect(ff.calls.length).toBe(1);
  });

  it('degrades to null on non-2xx, network error and success:false', async () => {
    const c1 = new AirnavClient({ token: 'T', fetchImpl: fakeFetch(() => ({ ok: false, status: 500, async json() { return {}; } })) });
    expect(await c1.aircraftByHex('aaa111')).toBeNull();
    const c2 = new AirnavClient({ token: 'T', fetchImpl: fakeFetch(() => { throw new Error('net'); }) });
    expect(await c2.aircraftByHex('aaa111')).toBeNull();
    const c3 = new AirnavClient({ token: 'T', fetchImpl: fakeFetch(() => ok({ success: false, comment: 'unknown' })) });
    expect(await c3.aircraftByHex('aaa111')).toBeNull();
  });

  it('returns null with no token (never calls the API)', async () => {
    const ff = fakeFetch(() => ok(AIRCRAFT));
    const c = new AirnavClient({ token: '', fetchImpl: ff });
    expect(await c.aircraftByHex('abc123')).toBeNull();
    expect(ff.calls.length).toBe(0);
  });

  it('lookup() combines aircraft + live, null only when both miss', async () => {
    const ff = fakeFetch((url) => ok(url.includes('/flights/live') ? LIVE : AIRCRAFT));
    const c = new AirnavClient({ token: 'T', fetchImpl: ff });
    const r = await c.lookup('3c6444');
    expect(r.aircraft.registration).toBe('D-AIXA');
    expect(r.live.flight).toBe('LH400');

    const ff2 = fakeFetch(() => ok({ success: false }));
    const c2 = new AirnavClient({ token: 'T', fetchImpl: ff2 });
    expect(await c2.lookup('3c6444')).toBeNull();
  });
});
