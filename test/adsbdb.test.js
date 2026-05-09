import { describe, expect, it } from 'vitest';
import { RouteLookup } from '../src/adsbdb.js';

const SUCCESS = {
  response: {
    flightroute: {
      callsign: 'DLH123',
      callsign_iata: 'LH123',
      callsign_icao: 'DLH123',
      airline: { name: 'Lufthansa', iata: 'LH', icao: 'DLH' },
      origin: { name: 'Frankfurt', iata_code: 'FRA', icao_code: 'EDDF' },
      destination: { name: 'New York JFK', iata_code: 'JFK', icao_code: 'KJFK' },
    },
  },
};

function fakeFetch(map) {
  let calls = 0;
  const fn = async (url) => {
    calls += 1;
    const handler = map[url];
    if (!handler) return { ok: false, status: 500, async json() { return {}; } };
    return handler();
  };
  fn.calls = () => calls;
  return fn;
}

describe('RouteLookup', () => {
  it('normalises a successful adsbdb response', async () => {
    const fetchImpl = fakeFetch({
      'https://api.adsbdb.com/v0/callsign/DLH123': () => ({
        ok: true,
        status: 200,
        async json() { return SUCCESS; },
      }),
    });
    const r = new RouteLookup({ fetchImpl });
    const route = await r.lookup('dlh123');
    expect(route).toEqual({
      flight: 'LH123',
      airline: { name: 'Lufthansa', iata: 'LH', icao: 'DLH' },
      origin: { name: 'Frankfurt', iata: 'FRA', icao: 'EDDF', country: undefined },
      destination: { name: 'New York JFK', iata: 'JFK', icao: 'KJFK', country: undefined },
    });
  });

  it('caches positive results across calls', async () => {
    const fetchImpl = fakeFetch({
      'https://api.adsbdb.com/v0/callsign/DLH123': () => ({
        ok: true, status: 200, async json() { return SUCCESS; },
      }),
    });
    const r = new RouteLookup({ fetchImpl });
    await r.lookup('DLH123');
    await r.lookup('DLH123');
    await r.lookup('dlh123');
    expect(fetchImpl.calls()).toBe(1);
  });

  it('caches 404 results so unknown callsigns are not hammered', async () => {
    const fetchImpl = fakeFetch({
      'https://api.adsbdb.com/v0/callsign/NOPE': () => ({
        ok: false, status: 404, async json() { return { response: 'unknown callsign' }; },
      }),
    });
    const r = new RouteLookup({ fetchImpl });
    expect(await r.lookup('NOPE')).toBeNull();
    expect(await r.lookup('NOPE')).toBeNull();
    expect(fetchImpl.calls()).toBe(1);
  });

  it('returns null on network errors', async () => {
    const fetchImpl = async () => { throw new Error('econnrefused'); };
    const r = new RouteLookup({ fetchImpl });
    expect(await r.lookup('TST123')).toBeNull();
  });

  it('expires cached entries after the configured TTL', async () => {
    let t = 1_000_000_000_000;
    const fetchImpl = fakeFetch({
      'https://api.adsbdb.com/v0/callsign/DLH123': () => ({
        ok: true, status: 200, async json() { return SUCCESS; },
      }),
    });
    const r = new RouteLookup({ fetchImpl, ttlMs: 100, now: () => t });
    await r.lookup('DLH123');
    t += 50;
    await r.lookup('DLH123'); // still cached
    expect(fetchImpl.calls()).toBe(1);
    t += 200;
    await r.lookup('DLH123');
    expect(fetchImpl.calls()).toBe(2);
  });

  it('returns null for empty/whitespace callsigns without hitting the network', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, async json() { return SUCCESS; } }; };
    const r = new RouteLookup({ fetchImpl });
    expect(await r.lookup('')).toBeNull();
    expect(await r.lookup('   ')).toBeNull();
    expect(calls).toBe(0);
  });
});
