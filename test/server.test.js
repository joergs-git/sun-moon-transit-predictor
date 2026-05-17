import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHttpServer } from '../src/server.js';
import { HistoryStore } from '../src/store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let httpServer;
let baseUrl;
let store;

const fakeState = {
  observer: { name: 'Rheine', latitudeDeg: 52.28, longitudeDeg: 7.44, elevationM: 50 },
  nowMs: 1_000_000_000_000,
  lastUpdateMs: 1_000_000_000_000,
  bodies: { Sun: { azimuthDeg: 180, elevationDeg: 30, rangeM: null, observable: true } },
  candidates: [],
  aircraftCount: 0,
};

beforeAll(async () => {
  store = new HistoryStore(':memory:');
  httpServer = createHttpServer({
    port: 0,
    host: '127.0.0.1',
    getState: () => fakeState,
    store,
    webRoot: resolve(ROOT, 'web'),
  });
  const { port } = await httpServer.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (httpServer) await httpServer.stop();
  if (store) store.close();
});

describe('HTTP server', () => {
  it('serves /api/state with the current snapshot', async () => {
    const res = await fetch(`${baseUrl}/api/state`);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.observer.name).toBe('Rheine');
    expect(body.bodies.Sun.observable).toBe(true);
  });

  it('serves /api/health', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('serves /api/history (initially empty)', async () => {
    const res = await fetch(`${baseUrl}/api/history`);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(0);
  });

  it('serves the static index.html on /', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/Sun-Moon Transit Predictor/);
  });

  it('rejects path traversal attempts with 403/404', async () => {
    const res = await fetch(`${baseUrl}/../package.json`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist.txt`);
    expect(res.status).toBe(404);
  });

  it('/api/update is 404 when requestUpdate is not wired', async () => {
    const res = await fetch(`${baseUrl}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe('HTTP server — /api/update gating', () => {
  let srv;
  let url;
  let calls;

  beforeAll(async () => {
    calls = 0;
    srv = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      getState: () => fakeState,
      store,
      webRoot: resolve(ROOT, 'web'),
      requestUpdate: async () => { calls += 1; return { ok: true, pending: false, message: 'queued' }; },
    });
    const { port } = await srv.start();
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => { if (srv) await srv.stop(); });

  it('rejects an unconfirmed request and does not trigger', async () => {
    const res = await fetch(`${url}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  it('triggers exactly once on a confirmed request', async () => {
    const res = await fetch(`${url}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('ignores a GET (POST-only endpoint)', async () => {
    const res = await fetch(`${url}/api/update`);
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });
});
