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
    expect(px.calls[0].title).toMatch(/^Sun crosser - sep \d+\.\d+° /);
  });

  it('suppresses the Pushover for a body outside pushBodies but still records it', async () => {
    const px = new FakePushover();
    const recorded = [];
    const n = new Notifier({ pushover: px, pushBodies: ['Sun'], onEvent: (e) => recorded.push(e) });
    const moon = makeCandidate({ body: 'Moon', closestInMs: 90_000, level: 'candidate' });
    const events = await n.tick([moon], 1_000_000_000_000);
    // History record still happens (stats stay complete)…
    expect(recorded.some((e) => e.candidate.body === 'Moon')).toBe(true);
    // …but no phone buzz for the non-armed body.
    expect(px.calls.length).toBe(0);
    expect(events.length).toBe(0);
  });

  it('still pushes the allowed body when pushBodies is set', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px, pushBodies: ['Sun'] });
    const sun = makeCandidate({ body: 'Sun', closestInMs: 90_000, level: 'candidate' });
    await n.tick([sun], 1_000_000_000_000);
    expect(px.calls.length).toBe(1);
  });

  it('exempts the ISS from the pushBodies filter', async () => {
    const px = new FakePushover();
    const iss = { ...makeCandidate({ body: 'Moon', closestInMs: 90_000, level: 'candidate' }), isISS: true };
    const n = new Notifier({ pushover: px, pushBodies: ['Sun'] });
    await n.tick([iss], 1_000_000_000_000);
    expect(px.calls.length).toBe(1);
  });

  it('sends a radio notification first when first sighting is level=radio', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    // Below the new default 1° Pushover filter so the radio stage actually
    // dispatches. The wider-band suppression is exercised separately below.
    const cand = makeCandidate({ closestInMs: 90_000, level: 'radio', sepDeg: 0.8 });
    const events = await n.tick([cand], 1_000_000_000_000);
    expect(events[0].stage).toBe('radio');
    expect(px.calls[0].title).toMatch(/^Sun crosser - sep /);
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
    // No stage prefix any more — inside the imminent window the lead reads
    // "now"; priority:1 is what makes it stand out.
    expect(px.calls[1].title).toMatch(/^Sun crosser - sep \d+\.\d+° now$/);
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

  it('sends an ISS-flavoured Pushover for an ISS transit candidate', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    const iss = makeCandidate({
      icao: 'ISS', callsign: 'ISS (ZARYA)', body: 'Sun',
      sepDeg: 0.05, closestInMs: 6 * 3600_000, level: 'candidate',
    });
    iss.isISS = true;
    const events = await n.tick([iss], 1_000_000_000_000);
    expect(events.length).toBe(1);
    expect(px.calls.length).toBe(1);
    expect(px.calls[0].title).toMatch(/ISS .*transit/i);
    expect(px.calls[0].title).toMatch(/Sun/);
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
    // v0.15.2: the body is trimmed to flight + route (airline name dropped).
    expect(px.calls[0].message).toMatch(/LH123/);
    expect(px.calls[0].message).toMatch(/FRA→JFK/);
    expect(px.calls[0].message).not.toMatch(/Lufthansa/);
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

describe('Notifier — elevation gate (v0.15.0)', () => {
  const atEl = (el, extra = {}) => {
    const c = makeCandidate({ level: 'candidate', closestInMs: 90_000, ...extra });
    c.aircraftAtClosest = { ...c.aircraftAtClosest, elevationDeg: el };
    return c;
  };

  it('suppresses the Pushover below minElevationDeg but still records History', async () => {
    const px = new FakePushover();
    const recorded = [];
    const n = new Notifier({ pushover: px, minElevationDeg: 30,
      onEvent: (e) => recorded.push(e) });
    const events = await n.tick([atEl(20)], 1_000_000_000_000);
    expect(events.length).toBe(0);            // no Pushover dispatched
    expect(px.calls.length).toBe(0);
    expect(recorded.length).toBeGreaterThan(0); // History decoupled — still logged
    expect(recorded.some((e) => e.stage === 'candidate')).toBe(true);
  });

  it('sends when the target is at or above minElevationDeg', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px, minElevationDeg: 30 });
    const events = await n.tick([atEl(45)], 1_000_000_000_000);
    expect(events.length).toBe(1);
    expect(px.calls.length).toBe(1);
  });

  it('exempts the ISS from the elevation gate', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px, minElevationDeg: 30 });
    const iss = atEl(8);                       // well below the gate
    iss.isISS = true;
    const events = await n.tick([iss], 1_000_000_000_000);
    expect(events.length).toBe(1);             // ISS still notified
  });

  it('disables the gate when minElevationDeg is 0 (default)', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });  // default → 0 = off
    const events = await n.tick([atEl(5)], 1_000_000_000_000);
    expect(events.length).toBe(1);
  });
});

describe('Notifier — message format (v0.15.2)', () => {
  it('puts body+sep+lead in the title and only the rest in the body', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px, baseUrl: 'http://192.168.1.50:8081/' });
    const cand = makeCandidate({ body: 'Moon', sepDeg: 0.12, closestInMs: 7 * 60_000 });
    cand.aircraftAtClosest = { azimuthDeg: 180, elevationDeg: 52, rangeM: 18000 };
    await n.tick([cand], 1_000_000_000_000);
    const m = px.calls[0];
    expect(m.title).toBe('Moon crosser - sep 0.12° in 7 minutes');
    // Body carries only what is NOT in the title.
    expect(m.message).not.toMatch(/sep 0\.12/);
    expect(m.message).toMatch(/DLH123/);          // flight
    expect(m.message).toMatch(/km\/h/);           // speed
    expect(m.message).toMatch(/km/);              // distance
    expect(m.message).toMatch(/🟢 52° elevation/); // visibility traffic-light
    // The clickable link is the configured URL.
    expect(m.url).toBe('http://192.168.1.50:8081/');
    expect(m.urlTitle).toBe('Open predictor');
  });

  it('colours the visibility tag by the 30/45° bands and reads "now" when imminent', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px, imminentWindowMs: 30_000 });
    const cand = makeCandidate({ body: 'Sun', sepDeg: 0.2, closestInMs: 10_000 });
    cand.aircraftAtClosest = { azimuthDeg: 180, elevationDeg: 22, rangeM: 32000 };
    await n.tick([cand], 1_000_000_000_000);
    const m = px.calls[0];
    expect(m.title).toBe('Sun crosser - sep 0.20° now');
    expect(m.message).toMatch(/🔴 22° elevation \(poor\)/);
  });

  it('omits the link when no baseUrl is configured', async () => {
    const px = new FakePushover();
    const n = new Notifier({ pushover: px });
    await n.tick([makeCandidate()], 1_000_000_000_000);
    expect(px.calls[0].url).toBeUndefined();
  });
});
