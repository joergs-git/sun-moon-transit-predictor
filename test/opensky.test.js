import { describe, expect, it } from 'vitest';
import { arrivalsAt, departuresAt, flightToObservation } from '../src/opensky.js';

const SAMPLE = [
  {
    icao24: '3c6589',
    firstSeen: 1762834800,
    lastSeen: 1762839700,
    callsign: 'DLH4PV  ',
    estDepartureAirport: 'EDDF',
    estArrivalAirport: 'EHAM',
  },
  {
    icao24: '4ca7b1',
    firstSeen: 1762837000,
    lastSeen: 1762841200,
    callsign: '   ',
    estDepartureAirport: 'EDDF',
    estArrivalAirport: 'EDDM',
  },
];

describe('arrivalsAt / departuresAt', () => {
  it('parses and trims callsigns, drops empty ones', async () => {
    const calls = [];
    const fakeFetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, async json() { return SAMPLE; } };
    };
    const flights = await arrivalsAt('EDDF', 1762834800, 1762921200, { fetchImpl: fakeFetch });
    expect(calls[0]).toMatch(/flights\/arrival\?airport=EDDF&begin=1762834800&end=1762921200/);
    expect(flights.length).toBe(1);
    expect(flights[0].callsign).toBe('DLH4PV');
    expect(flights[0].icao24).toBe('3c6589');
  });

  it('returns [] on 404 (empty window)', async () => {
    const fakeFetch = async () => ({ ok: false, status: 404, async json() { return null; } });
    const flights = await arrivalsAt('EDDF', 1, 1000, { fetchImpl: fakeFetch });
    expect(flights).toEqual([]);
  });

  it('throws on non-2xx, non-404 status', async () => {
    const fakeFetch = async () => ({ ok: false, status: 503, async json() { return {}; } });
    await expect(departuresAt('EDDF', 1, 1000, { fetchImpl: fakeFetch }))
      .rejects.toThrow(/HTTP 503/);
  });

  it('rejects windows wider than one day', async () => {
    const fakeFetch = async () => ({ ok: true, status: 200, async json() { return []; } });
    await expect(arrivalsAt('EDDF', 0, 86401, { fetchImpl: fakeFetch }))
      .rejects.toThrow(/window too wide/);
  });
});

describe('flightToObservation', () => {
  const flight = {
    icao24: '3c6589',
    firstSeen: 1762834800,    // 2025-11-11 09:00:00 UTC
    lastSeen: 1762839700,     // 2025-11-11 10:21:40 UTC
    callsign: 'LH123',
    estDepartureAirport: 'EDDF',
    estArrivalAirport: 'EHAM',
  };

  it('uses lastSeen for arrivals', () => {
    const o = flightToObservation(flight, 'arrival', () => 'Sun');
    expect(o.timestampMs).toBe(1762839700_000);
    expect(o.flight).toBe('LH123');
    expect(o.body).toBe('Sun');
  });

  it('uses firstSeen for departures', () => {
    const o = flightToObservation(flight, 'departure', () => 'Moon');
    expect(o.timestampMs).toBe(1762834800_000);
    expect(o.body).toBe('Moon');
  });

  it('returns null when assignBody yields null', () => {
    expect(flightToObservation(flight, 'arrival', () => null)).toBeNull();
  });

  it('returns null when callsign is missing', () => {
    expect(flightToObservation({ ...flight, callsign: null }, 'arrival', () => 'Sun')).toBeNull();
  });
});
