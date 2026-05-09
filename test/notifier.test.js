import { describe, expect, it } from 'vitest';
import { Notifier } from '../src/notifier.js';

class FakePushover {
  constructor() { this.calls = []; this.enabled = true; }
  async send(msg) { this.calls.push(msg); return { sent: true }; }
}

function makeCandidate({ icao = 'abc123', body = 'Sun', closestInMs = 90_000,
                        callsign = 'DLH123', sepDeg = 0.12, durationMs = 4000 } = {}) {
  return {
    icao,
    callsign,
    body,
    closestApproachAtMs: 1_000_000_000_000 + closestInMs,
    closestApproachSepDeg: sepDeg,
    entersAtMs: 1_000_000_000_000 + closestInMs - durationMs / 2,
    leavesAtMs: 1_000_000_000_000 + closestInMs + durationMs / 2,
    durationMs,
    aircraftAtClosest: { azimuthDeg: 180, elevationDeg: 60, rangeM: 12000 },
    bodyAtClosest: { azimuthDeg: 180, elevationDeg: 60, rangeM: 1.5e11 },
    aircraft: {
      icao,
      callsign,
      lat: 52.5,
      lon: 7.5,
      altMmsl: 10668,
      altSource: 'geometric',
      groundSpeedMs: 230,
      trackDeg: 90,
      verticalRateMs: 0,
      seenPosS: 0.5,
      receivedAtMs: 1_000_000_000_000,
    },
  };
}

describe('Notifier', () => {
  it('sends an early notification on first sighting', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    const cand = makeCandidate({ closestInMs: 90_000 });
    const events = await n.tick([cand], 1_000_000_000_000);
    expect(events.length).toBe(1);
    expect(events[0].stage).toBe('early');
    expect(px.calls.length).toBe(1);
    expect(px.calls[0].title).toMatch(/Sun candidate/);
  });

  it('does not double-send the early notification on subsequent ticks', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    const cand = makeCandidate({ closestInMs: 90_000 });
    await n.tick([cand], 1_000_000_000_000);
    await n.tick([cand], 1_000_000_000_000 + 2000);
    expect(px.calls.length).toBe(1);
  });

  it('emits the precise stage when closest-approach falls inside the window', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px, preciseWindowMs: 30_000 });
    const cand = makeCandidate({ closestInMs: 90_000 });
    await n.tick([cand], 1_000_000_000_000);                 // early
    const evts = await n.tick([cand], 1_000_000_000_000 + 70_000); // T-20s
    expect(evts.length).toBe(1);
    expect(evts[0].stage).toBe('precise');
    expect(px.calls.length).toBe(2);
    expect(px.calls[1].title).toMatch(/Sun TRANSIT/);
    expect(px.calls[1].priority).toBe(1);
  });

  it('does not double-send the precise notification', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    const cand = makeCandidate({ closestInMs: 90_000 });
    await n.tick([cand], 1_000_000_000_000);
    await n.tick([cand], 1_000_000_000_000 + 70_000);
    await n.tick([cand], 1_000_000_000_000 + 75_000);
    expect(px.calls.length).toBe(2);
  });

  it('treats Sun and Moon candidates for the same aircraft as separate streams', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    const sun = makeCandidate({ body: 'Sun' });
    const moon = makeCandidate({ body: 'Moon' });
    const events = await n.tick([sun, moon], 1_000_000_000_000);
    expect(events.length).toBe(2);
    expect(events.map(e => e.candidate.body).sort()).toEqual(['Moon', 'Sun']);
  });

  it('drops state for candidates last seen long ago', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px, forgetAfterMs: 1000 });
    const cand = makeCandidate({ closestInMs: 100 });
    await n.tick([cand], 1_000_000_000_000);
    expect(n.state.size).toBe(1);
    n.cleanup(1_000_000_000_000 + 5000);
    expect(n.state.size).toBe(0);
  });

  it('enriches the payload with route info when the lookup returns one', async () => {
    const px = new FakePushover();
    const route = {
      flight: 'LH123',
      airline: { name: 'Lufthansa' },
      origin: { iata: 'FRA' },
      destination: { iata: 'JFK' },
    };
    const n = new Notifier({ pushover: px, routeLookup: async () => route });
    const cand = makeCandidate();
    await n.tick([cand], 1_000_000_000_000);
    expect(px.calls[0].message).toMatch(/Lufthansa/);
    expect(px.calls[0].message).toMatch(/LH123/);
    expect(px.calls[0].message).toMatch(/FRA→JFK/);
  });

  it('still notifies when the route lookup throws', async () => {
    const px = new FakePushover();
    const n = new Notifier({
      pushover: px,
      routeLookup: async () => { throw new Error('boom'); },
    });
    const cand = makeCandidate();
    const events = await n.tick([cand], 1_000_000_000_000);
    expect(events[0].sent).toBe(true);
    expect(events[0].route).toBeNull();
  });
});
