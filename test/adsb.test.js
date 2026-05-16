import { describe, expect, it } from 'vitest';
import { fetchAircraft, parseAircraftJson } from '../src/adsb.js';

const SAMPLE = {
  now: 1750000000.5,
  aircraft: [
    {
      hex: 'ABC123',
      flight: 'DLH123  ',
      lat: 52.5,
      lon: 7.5,
      alt_geom: 35100,
      alt_baro: 35000,
      gs: 450,
      track: 89.5,
      geom_rate: -64,
      seen_pos: 0.7,
      t: 'A359',
      r: 'D-AIXA',
      desc: 'AIRBUS A-350-900',
      category: 'A5',
    },
    {
      hex: 'NOPOSITION',
      flight: '       ',
      alt_baro: 30000,
      seen_pos: 0,
    },
    {
      hex: 'STALE',
      flight: 'OLD123',
      lat: 52.0,
      lon: 7.0,
      alt_baro: 30000,
      seen_pos: 60,
    },
    {
      hex: 'BAROONLY',
      flight: 'BAR456',
      lat: 53.0,
      lon: 7.2,
      alt_baro: 20000,
      gs: 380,
      track: 270,
      seen_pos: 1.0,
    },
    {
      hex: 'GROUND',
      flight: 'GND789',
      lat: 51.0,
      lon: 7.0,
      alt_baro: 'ground',
      seen_pos: 0,
    },
  ],
};

describe('parseAircraftJson', () => {
  it('normalises a typical aircraft entry to SI units', () => {
    const list = parseAircraftJson(SAMPLE);
    const dlh = list.find(a => a.icao === 'abc123');
    expect(dlh).toBeDefined();
    expect(dlh.callsign).toBe('DLH123');
    expect(dlh.altSource).toBe('geometric');
    expect(dlh.altMmsl).toBeCloseTo(35100 * 0.3048, 3);
    expect(dlh.groundSpeedMs).toBeCloseTo(450 * 0.514444, 3);
    expect(dlh.trackDeg).toBe(89.5);
    expect(dlh.verticalRateMs).toBeCloseTo(-64 * 0.00508, 3);
    expect(dlh.receivedAtMs).toBe(1750000000500 - 700);
  });

  it('captures optional airframe enrichment (type / registration) when present', () => {
    const list = parseAircraftJson(SAMPLE);
    const dlh = list.find(a => a.icao === 'abc123');
    expect(dlh.typeCode).toBe('A359');
    expect(dlh.registration).toBe('D-AIXA');
    expect(dlh.typeDesc).toBe('AIRBUS A-350-900');
    expect(dlh.category).toBe('A5');
  });

  it('leaves airframe enrichment null when the feed omits it', () => {
    const list = parseAircraftJson(SAMPLE);
    const baro = list.find(a => a.icao === 'baroonly');
    expect(baro.typeCode).toBeNull();
    expect(baro.registration).toBeNull();
    expect(baro.typeDesc).toBeNull();
    expect(baro.category).toBeNull();
  });

  it('drops aircraft without position', () => {
    const list = parseAircraftJson(SAMPLE);
    expect(list.find(a => a.icao === 'noposition')).toBeUndefined();
  });

  it('drops stale positions', () => {
    const list = parseAircraftJson(SAMPLE);
    expect(list.find(a => a.icao === 'stale')).toBeUndefined();
  });

  it('drops ground / non-numeric altitude entries when no alt_geom is present', () => {
    const list = parseAircraftJson(SAMPLE);
    expect(list.find(a => a.icao === 'ground')).toBeUndefined();
  });

  it('falls back to barometric altitude when geometric is missing', () => {
    const list = parseAircraftJson(SAMPLE);
    const baro = list.find(a => a.icao === 'baroonly');
    expect(baro).toBeDefined();
    expect(baro.altSource).toBe('barometric');
    expect(baro.altMmsl).toBeCloseTo(20000 * 0.3048, 3);
  });

  it('returns empty array on bad payload', () => {
    expect(parseAircraftJson(null)).toEqual([]);
    expect(parseAircraftJson({})).toEqual([]);
    expect(parseAircraftJson({ aircraft: 'nope' })).toEqual([]);
  });
});

describe('fetchAircraft', () => {
  it('uses the supplied fetch impl and parses the body', async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() { return SAMPLE; },
      };
    };
    const list = await fetchAircraft('http://pi/data/aircraft.json', { fetchImpl: fakeFetch });
    expect(calls[0].url).toBe('http://pi/data/aircraft.json');
    expect(list.length).toBeGreaterThan(0);
  });

  it('throws on non-2xx response', async () => {
    const fakeFetch = async () => ({ ok: false, status: 503, async json() { return {}; } });
    await expect(fetchAircraft('http://pi/data/aircraft.json', { fetchImpl: fakeFetch }))
      .rejects.toThrow(/HTTP 503/);
  });
});
