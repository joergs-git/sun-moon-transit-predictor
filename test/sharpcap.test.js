import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { SharpCapTrigger } from '../src/sharpcap.js';

// Fake net.createConnection() — returns an EventEmitter with .write/.end/.destroy.
// The test drives 'connect', captures what was written, replies via 'data',
// then closes via 'close'. Enough to exercise the full happy-path + error
// branches without a real socket.
function makeFakeNet({ replyLine, openError, dropConnection, sendDelay = 0 } = {}) {
  const created = [];
  const netImpl = {
    createConnection: () => {
      const sock = new EventEmitter();
      sock.writes = [];
      sock.write = (chunk) => { sock.writes.push(chunk); };
      sock.end = vi.fn();
      sock.destroy = vi.fn();
      sock.setEncoding = vi.fn();
      created.push(sock);
      setImmediate(() => {
        if (openError) { sock.emit('error', openError); return; }
        sock.emit('connect');
        if (dropConnection) {
          setImmediate(() => sock.emit('close'));
          return;
        }
        if (replyLine != null) {
          const send = () => {
            sock.emit('data', replyLine);
            sock.emit('close');
          };
          if (sendDelay) setTimeout(send, sendDelay); else setImmediate(send);
        }
      });
      return sock;
    },
  };
  return { netImpl, created };
}

function makeCandidate({ icao = 'abc123', body = 'Sun', closestInMs = 10_000,
                        elevationDeg = 45 } = {}) {
  const NOW = 1_700_000_000_000;
  return {
    icao,
    callsign: 'DLH1',
    body,
    closestApproachAtMs: NOW + closestInMs,
    closestApproachSepDeg: 0.1,
    aircraftAtClosest: { azimuthDeg: 180, elevationDeg, rangeM: 10_000 },
  };
}

describe('SharpCapTrigger', () => {
  it('is disabled when config.enabled is false', () => {
    const t = new SharpCapTrigger({ enabled: false, host: 'pc' });
    expect(t.enabled).toBe(false);
    expect(t.shouldTrigger({ stage: 'imminent', candidate: makeCandidate() })).toEqual({
      ok: false, reason: 'disabled',
    });
  });

  it('is disabled when host is missing', () => {
    const t = new SharpCapTrigger({ enabled: true, host: '' });
    expect(t.enabled).toBe(false);
  });

  it('rejects non-matching stage', () => {
    const t = new SharpCapTrigger({ enabled: true, host: 'pc', triggerOnStage: 'imminent' });
    expect(t.shouldTrigger({ stage: 'radio', candidate: makeCandidate() })).toEqual({
      ok: false, reason: 'wrong-stage',
    });
  });

  it('filters by body', () => {
    const t = new SharpCapTrigger({ enabled: true, host: 'pc', bodies: ['Moon'] });
    expect(t.shouldTrigger({ stage: 'imminent', candidate: makeCandidate({ body: 'Sun' }) })).toEqual({
      ok: false, reason: 'body-filtered',
    });
  });

  it('filters by minimum elevation', () => {
    const t = new SharpCapTrigger({ enabled: true, host: 'pc', minElevationDeg: 30 });
    expect(t.shouldTrigger({ stage: 'imminent', candidate: makeCandidate({ elevationDeg: 10 }) })).toEqual({
      ok: false, reason: 'too-low',
    });
    expect(t.shouldTrigger({ stage: 'imminent', candidate: makeCandidate({ elevationDeg: 60 }) })).toEqual({
      ok: true,
    });
  });

  it('sends a payload framing closest approach with pre/post buffers', async () => {
    const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true,"captureId":"cap-1"}\n' });
    const t = new SharpCapTrigger(
      { enabled: true, host: 'pc', port: 9999, preBufferS: 5, postBufferS: 15 },
      { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    );
    const cand = makeCandidate({ closestInMs: 12_000 });
    const NOW = cand.closestApproachAtMs - 12_000;

    const res = await t.triggerFromEvent({ stage: 'imminent', candidate: cand }, NOW);

    expect(res.sent).toBe(true);
    expect(res.response.captureId).toBe('cap-1');
    expect(created.length).toBe(1);
    const sent = JSON.parse(created[0].writes[0]);
    // closestApproach is 12 s out, preBuffer 5 s → preRoll should be ~7 s
    expect(sent.preRollS).toBeCloseTo(7, 3);
    // duration = preBuffer + postBuffer
    expect(sent.durationS).toBeCloseTo(20, 3);
    expect(sent.label).toBe('abc123|Sun');
  });

  it('clamps pre-roll to zero when closest approach is already past or imminent', async () => {
    const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true,"captureId":"cap-2"}\n' });
    const t = new SharpCapTrigger(
      { enabled: true, host: 'pc', preBufferS: 5, postBufferS: 15 },
      { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    );
    const cand = makeCandidate({ closestInMs: 1_000 });
    const NOW = cand.closestApproachAtMs - 1_000;

    await t.triggerFromEvent({ stage: 'imminent', candidate: cand }, NOW);

    const sent = JSON.parse(created[0].writes[0]);
    expect(sent.preRollS).toBe(0);
  });

  it('includes the shared token when configured', async () => {
    const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true}\n' });
    const t = new SharpCapTrigger(
      { enabled: true, host: 'pc', token: 'sekret' },
      { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    );
    await t.triggerFromEvent({ stage: 'imminent', candidate: makeCandidate() }, Date.now());
    const sent = JSON.parse(created[0].writes[0]);
    expect(sent.token).toBe('sekret');
  });

  it('dedupes repeat triggers for the same (icao, body) within dedupMs', async () => {
    const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true}\n' });
    const t = new SharpCapTrigger(
      { enabled: true, host: 'pc', dedupMs: 60_000 },
      { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    );
    const cand = makeCandidate();
    const NOW = cand.closestApproachAtMs - 10_000;

    const r1 = await t.triggerFromEvent({ stage: 'imminent', candidate: cand }, NOW);
    const r2 = await t.triggerFromEvent({ stage: 'imminent', candidate: cand }, NOW + 5_000);

    expect(r1.sent).toBe(true);
    expect(r2.sent).toBe(false);
    expect(r2.reason).toBe('deduped');
    expect(created.length).toBe(1);
  });

  it('allows a re-trigger after dedupMs has elapsed', async () => {
    const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true}\n' });
    const t = new SharpCapTrigger(
      { enabled: true, host: 'pc', dedupMs: 60_000 },
      { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    );
    const cand = makeCandidate();
    const NOW = cand.closestApproachAtMs - 10_000;

    await t.triggerFromEvent({ stage: 'imminent', candidate: cand }, NOW);
    const r2 = await t.triggerFromEvent({ stage: 'imminent', candidate: cand }, NOW + 120_000);

    expect(r2.sent).toBe(true);
    expect(created.length).toBe(2);
  });

  it('returns sent:false with an error on connect failure (never throws)', async () => {
    const { netImpl } = makeFakeNet({ openError: new Error('ECONNREFUSED') });
    const t = new SharpCapTrigger(
      { enabled: true, host: 'pc' },
      { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    );
    const res = await t.triggerFromEvent({ stage: 'imminent', candidate: makeCandidate() }, Date.now());
    expect(res.sent).toBe(false);
    expect(res.error.message).toMatch(/ECONNREFUSED/);
  });

  it('returns sent:false when the listener replies with ok:false', async () => {
    const { netImpl } = makeFakeNet({ replyLine: '{"ok":false,"error":"busy"}\n' });
    const t = new SharpCapTrigger(
      { enabled: true, host: 'pc' },
      { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    );
    const res = await t.triggerFromEvent({ stage: 'imminent', candidate: makeCandidate() }, Date.now());
    expect(res.sent).toBe(false);
    expect(res.error.message).toBe('busy');
  });

  it('times out cleanly if the listener never replies', async () => {
    const { netImpl } = makeFakeNet({ /* replyLine omitted → no data, no close */ });
    const t = new SharpCapTrigger(
      { enabled: true, host: 'pc', connectTimeoutMs: 30 },
      { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    );
    const res = await t.triggerFromEvent({ stage: 'imminent', candidate: makeCandidate() }, Date.now());
    expect(res.sent).toBe(false);
    expect(res.error.message).toMatch(/timeout/);
  });

  describe('armForCandidate (tick-based "never miss" path)', () => {
    const NOW = 1_700_000_000_000;
    function armCand(over = {}) {
      return {
        icao: 'abc123', callsign: 'DLH1', body: 'Sun',
        closestApproachAtMs: NOW + 20_000,
        closestApproachSepDeg: 0.1,
        aircraftAtClosest: { azimuthDeg: 180, elevationDeg: 45, rangeM: 10_000 },
        ...over,
      };
    }

    it('arms a near candidate within the pre-roll window (one capture)', async () => {
      const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true,"captureId":"a-1"}\n' });
      const t = new SharpCapTrigger(
        // leadDriftFrac 0 isolates the base pre/post window (drift tested below)
        { enabled: true, host: 'pc', preBufferS: 10, postBufferS: 10, leadDriftFrac: 0 },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      const res = await t.armForCandidate(armCand({ closestApproachAtMs: NOW + 20_000 }), NOW);
      expect(res.sent).toBe(true);
      const sent = JSON.parse(created[0].writes[0]);
      expect(sent.preRollS).toBeCloseTo(10, 3);   // 20 s out − 10 s pre-buffer
      expect(sent.durationS).toBeCloseTo(20, 3);
    });

    it('widens the window by a lead-scaled drift margin when armed early', async () => {
      const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true}\n' });
      const t = new SharpCapTrigger(
        { enabled: true, host: 'pc', preBufferS: 10, postBufferS: 10, leadDriftFrac: 0.3, maxDriftS: 30 },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      // 50 s out → drift = min(50·0.3, 30) = 15 s.
      await t.armForCandidate(armCand({ closestApproachAtMs: NOW + 50_000 }), NOW);
      const sent = JSON.parse(created[0].writes[0]);
      expect(sent.preRollS).toBeCloseTo(25, 3);   // 50 − 10 − 15
      expect(sent.durationS).toBeCloseTo(50, 3);  // 10 + 10 + 2·15  → ±25 s window
    });

    it('caps the drift margin at maxDriftS', async () => {
      const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true}\n' });
      const t = new SharpCapTrigger(
        { enabled: true, host: 'pc', preBufferS: 10, postBufferS: 10, leadDriftFrac: 0.3, maxDriftS: 20 },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      // 90 s out → uncapped drift 27 s, capped to 20.
      await t.armForCandidate(armCand({ closestApproachAtMs: NOW + 90_000 }), NOW);
      const sent = JSON.parse(created[0].writes[0]);
      expect(sent.durationS).toBeCloseTo(60, 3);  // 10 + 10 + 2·20
    });

    it('records immediately (pre-roll 0) when the transit is seconds away', async () => {
      const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true}\n' });
      const t = new SharpCapTrigger(
        { enabled: true, host: 'pc', preBufferS: 10, postBufferS: 10 },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      await t.armForCandidate(armCand({ closestApproachAtMs: NOW + 3_000 }), NOW);
      expect(JSON.parse(created[0].writes[0]).preRollS).toBe(0);
    });

    it('waits (too-early) until the pre-roll fits the listener cap', async () => {
      const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true}\n' });
      const t = new SharpCapTrigger(
        { enabled: true, host: 'pc', preBufferS: 10, postBufferS: 10 },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      // 5 min out → preRoll would be ~290 s, far over the 85 s cap.
      const res = await t.armForCandidate(armCand({ closestApproachAtMs: NOW + 300_000 }), NOW);
      expect(res.sent).toBe(false);
      expect(res.reason).toBe('too-early');
      expect(created.length).toBe(0);
    });

    it('never lets buffers + drift exceed the listener safety cap', async () => {
      const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true}\n' });
      const t = new SharpCapTrigger(
        // 20/20 + full drift would be 130 s — must be clamped under maxCaptureS.
        { enabled: true, host: 'pc', preBufferS: 20, postBufferS: 20,
          leadDriftFrac: 0.5, maxDriftS: 45, maxCaptureS: 115 },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      await t.armForCandidate(armCand({ closestApproachAtMs: NOW + 90_000 }), NOW);
      const sent = JSON.parse(created[0].writes[0]);
      expect(sent.durationS).toBeLessThanOrEqual(115);
    });

    it('re-arms within the dedup window when the predicted time shifts > reArmShiftS', async () => {
      const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true}\n' });
      const t = new SharpCapTrigger(
        { enabled: true, host: 'pc', dedupMs: 60_000, reArmShiftS: 12, preBufferS: 10, postBufferS: 10 },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      const c1 = armCand({ closestApproachAtMs: NOW + 60_000 });
      const r1 = await t.armForCandidate(c1, NOW);
      expect(r1.sent).toBe(true);
      // 5 s shift → still deduped (no re-arm)
      const r2 = await t.armForCandidate(armCand({ closestApproachAtMs: NOW + 65_000 }), NOW + 2_000);
      expect(r2.sent).toBe(false);
      expect(r2.reason).toBe('deduped');
      // 31 s shift → re-arm
      const r3 = await t.armForCandidate(armCand({ closestApproachAtMs: NOW + 29_000 }), NOW + 4_000);
      expect(r3.sent).toBe(true);
      expect(r3.reArmed).toBe(true);
      expect(created.length).toBe(2);   // initial + one re-arm
    });

    it('skips a candidate wider than maxSepDeg', async () => {
      const t = new SharpCapTrigger({ enabled: true, host: 'pc', maxSepDeg: 0.5 });
      const res = await t.armForCandidate(armCand({ closestApproachSepDeg: 1.2 }), NOW);
      expect(res).toEqual({ sent: false, reason: 'too-wide' });
    });

    it('skips below the elevation gate', async () => {
      const t = new SharpCapTrigger({ enabled: true, host: 'pc', minElevationDeg: 30 });
      const res = await t.armForCandidate(
        armCand({ aircraftAtClosest: { elevationDeg: 12 } }), NOW);
      expect(res).toEqual({ sent: false, reason: 'too-low' });
    });

    it('keeps the dedup slot on a listener-level rejection (busy etc.) so we do NOT TCP-storm', async () => {
      // v0.30.3: when the listener REPLIED but with ok:false (busy /
      // unauth / over-limit / …), the listener received our payload and
      // gave a definitive answer. Releasing the dedup slot in that case
      // would fire again every tick for the entire ~minute the listener
      // is busy recording, which is exactly the storm we now suppress.
      const busy = makeFakeNet({ replyLine: '{"ok":false,"error":"busy"}\n' });
      const t = new SharpCapTrigger(
        { enabled: true, host: 'pc' },
        { netImpl: busy.netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      const r1 = await t.armForCandidate(armCand(), NOW);
      expect(r1.sent).toBe(false);
      expect(r1.response?.error).toBe('busy');
      // Same candidate, 2 s later — even if we swap in a SUCCEEDING net,
      // the dedup must hold so we don't keep retrying behind the busy.
      const ok = makeFakeNet({ replyLine: '{"ok":true}\n' });
      t.net = ok.netImpl;
      const r2 = await t.armForCandidate(armCand(), NOW + 2_000);
      expect(r2.reason).toBe('deduped');
    });

    it('releases the dedup slot on a NETWORK failure (no reply at all) so the next tick retries', async () => {
      // Connect timeout / socket closed / listener down → no JSON reply.
      // That's a transient hiccup, not a definitive "no" — release the
      // slot so the next eligible tick gets another shot. This preserves
      // the v0.24 "never miss" guarantee for the listener-restart case.
      const nodata = makeFakeNet({ dropConnection: true });
      const t = new SharpCapTrigger(
        { enabled: true, host: 'pc' },
        { netImpl: nodata.netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      const r1 = await t.armForCandidate(armCand(), NOW);
      expect(r1.sent).toBe(false);
      expect(r1.response).toBeUndefined();    // no JSON reply
      // Slot released → next attempt fires (swap to succeeding net).
      const ok = makeFakeNet({ replyLine: '{"ok":true}\n' });
      t.net = ok.netImpl;
      const r2 = await t.armForCandidate(armCand(), NOW + 2_000);
      expect(r2.sent).toBe(true);
    });
  });

  describe('testTrigger', () => {
    it('sends an immediate zero-pre-roll capture of the given duration', async () => {
      const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true,"captureId":"t-1"}\n' });
      const t = new SharpCapTrigger(
        { enabled: true, host: 'pc' },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      const res = await t.testTrigger(2);
      expect(res.sent).toBe(true);
      const sent = JSON.parse(created[0].writes[0]);
      expect(sent.label).toBe('manual-test');
      expect(sent.preRollS).toBe(0);
      expect(sent.durationS).toBe(2);
    });

    it('works even when the trigger is disabled (host is enough)', async () => {
      const { netImpl } = makeFakeNet({ replyLine: '{"ok":true}\n' });
      const t = new SharpCapTrigger(
        { enabled: false, host: 'pc' },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      const res = await t.testTrigger();
      expect(res.sent).toBe(true);
    });

    it('refuses when no host is configured', async () => {
      const t = new SharpCapTrigger({ enabled: true, host: '' });
      const res = await t.testTrigger();
      expect(res.sent).toBe(false);
      expect(res.reason).toBe('no-host');
    });

    it('defaults to a 2 s duration and includes the token', async () => {
      const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true}\n' });
      const t = new SharpCapTrigger(
        { enabled: true, host: 'pc', token: 'sekret' },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      await t.testTrigger();
      const sent = JSON.parse(created[0].writes[0]);
      expect(sent.durationS).toBe(2);
      expect(sent.token).toBe('sekret');
    });
  });
});

// ── Sky-target arming (M83) ────────────────────────────────────────────────
function makeSkyCandidate({ satTag = 'ISS', targetId = 'm42', closestInMs = 10_000,
                           elevationDeg = 45 } = {}) {
  const NOW = 1_700_000_000_000;
  return {
    satTag, satName: 'ISS', targetId, targetName: 'M42 Orion Nebula', kind: 'field',
    closestApproachAtMs: NOW + closestInMs,
    closestApproachSepDeg: 0.1,
    satAtClosest: { azimuthDeg: 120, elevationDeg, rangeM: 500_000 },
  };
}

describe('SharpCapTrigger.armForSkyTarget', () => {
  const NOW = 1_700_000_000_000;

  it('arms a sky-target pass and labels it in the satTag|sky:targetId namespace', async () => {
    const { netImpl, created } = makeFakeNet({ replyLine: '{"ok":true,"captureId":"sky-1"}\n' });
    const t = new SharpCapTrigger(
      { enabled: true, host: 'pc', preBufferS: 5, postBufferS: 15 },
      { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
    );
    const res = await t.armForSkyTarget(makeSkyCandidate({ closestInMs: 10_000 }), NOW);
    expect(res.sent).toBe(true);
    const sent = JSON.parse(created[0].writes[0]);
    expect(sent.label).toBe('ISS|sky:m42');
    expect(sent.meta.body).toBe('M42 Orion Nebula');
    expect(sent.meta.icao).toBe('ISS');
    expect(sent.meta.kind).toBe('field');
  });

  it('skips when the satellite is below the rig minimum elevation', async () => {
    const { netImpl } = makeFakeNet({ replyLine: '{"ok":true}\n' });
    const t = new SharpCapTrigger({ enabled: true, host: 'pc', minElevationDeg: 30 }, { netImpl });
    const res = await t.armForSkyTarget(makeSkyCandidate({ elevationDeg: 12 }), NOW);
    expect(res).toEqual({ sent: false, reason: 'too-low' });
  });

  it('dedups a second arm of the same satellite×target within dedupMs', async () => {
    const { netImpl } = makeFakeNet({ replyLine: '{"ok":true}\n' });
    const t = new SharpCapTrigger({ enabled: true, host: 'pc', dedupMs: 60_000 }, { netImpl });
    const r1 = await t.armForSkyTarget(makeSkyCandidate(), NOW);
    const r2 = await t.armForSkyTarget(makeSkyCandidate(), NOW + 5_000);
    expect(r1.sent).toBe(true);
    expect(r2).toEqual({ sent: false, reason: 'deduped' });
  });

  it('does NOT collide with an aircraft capture of the same body name', async () => {
    const { netImpl } = makeFakeNet({ replyLine: '{"ok":true}\n' });
    const t = new SharpCapTrigger({ enabled: true, host: 'pc', dedupMs: 60_000 }, { netImpl });
    // Aircraft over the Moon, then a satellite through a "Moon" sky-target —
    // different key namespaces, so both arm.
    const air = await t.armForCandidate(makeCandidate({ body: 'Moon', closestInMs: 8_000 }), NOW);
    const sky = await t.armForSkyTarget(makeSkyCandidate({ targetId: 'moon', closestInMs: 8_000 }), NOW);
    expect(air.sent).toBe(true);
    expect(sky.sent).toBe(true);
  });
});
