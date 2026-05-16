import { describe, expect, it } from 'vitest';
import { Notifier } from '../src/notifier.js';

class FakePushover {
  constructor() { this.calls = []; this.enabled = true; }
  async send(msg) { this.calls.push(msg); return { sent: true }; }
}

function makeCandidate({ icao = 'abc123', body = 'Sun', closestInMs = 90_000,
                        callsign = 'DLH123', sepDeg = 0.12, durationMs = 4000,
                        level = 'candidate' } = {}) {
  return {
    icao,
    callsign,
    body,
    level,
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
  it('sends a candidate notification on first sighting at level=candidate', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    const cand = makeCandidate({ closestInMs: 90_000, level: 'candidate' });
    const events = await n.tick([cand], 1_000_000_000_000);
    expect(events.length).toBe(1);
    expect(events[0].stage).toBe('candidate');
    expect(px.calls.length).toBe(1);
    expect(px.calls[0].title).toMatch(/Sun candidate/);
  });

  it('sends a radio notification first when first sighting is level=radio', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    // Below the new default 1° Pushover filter so the radio stage actually
    // dispatches. The wider-band suppression is exercised separately below.
    const cand = makeCandidate({ closestInMs: 90_000, level: 'radio', sepDeg: 0.8 });
    const events = await n.tick([cand], 1_000_000_000_000);
    expect(events[0].stage).toBe('radio');
    expect(px.calls[0].title).toMatch(/Sun approach/);
  });

  it('suppresses radio Pushovers wider than radioThresholdDeg', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });                  // default 1.0
    // 2.1° is inside the tracker's looseThresholdDeg (5°) so the lifecycle
    // panel still sees it, but the Pushover should NOT fire.
    const cand = makeCandidate({ closestInMs: 90_000, level: 'radio', sepDeg: 2.1 });
    const events = await n.tick([cand], 1_000_000_000_000);
    expect(events.length).toBe(0);
    expect(px.calls.length).toBe(0);
  });

  it('records the radio stage to history even when the Pushover is suppressed (H)', async () => {
    const px = new FakePushover();
    const recorded = [];
    const n = new Notifier({
      pushover: px,                                   // default 1° phone band
      onEvent: (evt) => recorded.push(evt),
    });
    // 1.6° → inside the 2° panel band but past the 1° phone band: the phone
    // must stay silent, but History must still get the radio row so the
    // lead-time (Transit − Recorded) reflects the true early detection.
    const cand = makeCandidate({ closestInMs: 600_000, level: 'radio', sepDeg: 1.6 });
    const events = await n.tick([cand], 1_000_000_000_000);
    expect(events.length).toBe(0);          // no Pushover dispatched
    expect(px.calls.length).toBe(0);
    expect(recorded.length).toBe(1);        // but history recorded it
    expect(recorded[0].stage).toBe('radio');
    expect(recorded[0].recordedOnly).toBe(true);
  });

  it('does not double-record a stage across ticks', async () => {
    const px = new FakePushover();
    const recorded = [];
    const n = new Notifier({ pushover: px, onEvent: (e) => recorded.push(e) });
    const cand = makeCandidate({ closestInMs: 600_000, level: 'radio', sepDeg: 1.6 });
    await n.tick([cand], 1_000_000_000_000);
    await n.tick([cand], 1_000_000_000_000 + 2000);
    await n.tick([cand], 1_000_000_000_000 + 4000);
    expect(recorded.filter(e => e.stage === 'radio').length).toBe(1);
  });

  it('still fires radio when the user widens radioThresholdDeg', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px, radioThresholdDeg: 5.0 });
    const cand = makeCandidate({ closestInMs: 90_000, level: 'radio', sepDeg: 2.1 });
    const events = await n.tick([cand], 1_000_000_000_000);
    expect(events[0].stage).toBe('radio');
    expect(px.calls.length).toBe(1);
  });

  it('does not double-send the candidate notification on subsequent ticks', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    const cand = makeCandidate({ closestInMs: 90_000 });
    await n.tick([cand], 1_000_000_000_000);
    await n.tick([cand], 1_000_000_000_000 + 2000);
    expect(px.calls.length).toBe(1);
  });

  it('emits the imminent stage when closest-approach falls inside the window', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px, imminentWindowMs: 30_000 });
    const cand = makeCandidate({ closestInMs: 90_000 });
    await n.tick([cand], 1_000_000_000_000);                  // candidate
    const evts = await n.tick([cand], 1_000_000_000_000 + 70_000); // T-20s → imminent
    expect(evts.length).toBe(1);
    expect(evts[0].stage).toBe('imminent');
    expect(px.calls.length).toBe(2);
    expect(px.calls[1].title).toMatch(/Sun TRANSIT/);
    expect(px.calls[1].priority).toBe(1);
  });

  it('does not double-send the imminent notification', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    const cand = makeCandidate({ closestInMs: 90_000 });
    await n.tick([cand], 1_000_000_000_000);
    await n.tick([cand], 1_000_000_000_000 + 70_000);
    await n.tick([cand], 1_000_000_000_000 + 75_000);
    expect(px.calls.length).toBe(2);
  });

  it('skips earlier stages when minStage is set', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px, minStage: 'candidate' });
    // First a radio-level sighting → must be filtered
    const radio = makeCandidate({ closestInMs: 90_000, level: 'radio', sepDeg: 2.5 });
    await n.tick([radio], 1_000_000_000_000);
    expect(px.calls.length).toBe(0);
    // Then escalate to candidate-level → must fire (and not retroactively send radio)
    const cand = { ...radio, level: 'candidate', closestApproachSepDeg: 0.15 };
    const evts = await n.tick([cand], 1_000_000_000_000 + 2000);
    expect(evts.length).toBe(1);
    expect(evts[0].stage).toBe('candidate');
    expect(px.calls.length).toBe(1);
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
