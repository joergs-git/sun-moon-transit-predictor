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
        { enabled: true, host: 'pc', preBufferS: 10, postBufferS: 10 },
        { netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      const res = await t.armForCandidate(armCand({ closestApproachAtMs: NOW + 20_000 }), NOW);
      expect(res.sent).toBe(true);
      const sent = JSON.parse(created[0].writes[0]);
      expect(sent.preRollS).toBeCloseTo(10, 3);   // 20 s out − 10 s pre-buffer
      expect(sent.durationS).toBeCloseTo(20, 3);
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

    it('dedupes within the window but releases the slot on a failed send', async () => {
      // First send fails (ok:false) → slot released → second send succeeds.
      const fail = makeFakeNet({ replyLine: '{"ok":false,"error":"busy"}\n' });
      const t = new SharpCapTrigger(
        { enabled: true, host: 'pc' },
        { netImpl: fail.netImpl, logger: { info: () => {}, warn: () => {}, error: () => {} } },
      );
      const r1 = await t.armForCandidate(armCand(), NOW);
      expect(r1.sent).toBe(false);            // failed → slot released
      // swap in a succeeding net and retry: not deduped because the slot was freed
      const ok = makeFakeNet({ replyLine: '{"ok":true}\n' });
      t.net = ok.netImpl;
      const r2 = await t.armForCandidate(armCand(), NOW + 2_000);
      expect(r2.sent).toBe(true);
      // a third immediate attempt IS deduped
      const r3 = await t.armForCandidate(armCand(), NOW + 3_000);
      expect(r3.reason).toBe('deduped');
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
