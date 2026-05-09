import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createHttpServer } from '../src/server.js';
import { HistoryStore } from '../src/store.js';

function rawGet(port, path) {
  return new Promise((resolveP, rejectP) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolveP({ status: res.statusCode, body }));
    });
    req.on('error', rejectP);
    req.end();
  });
}

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

  it('rejects encoded traversal into a sibling directory that shares the prefix', async () => {
    // Setup: a webRoot at .../site and a sibling .../site-secret/leak.txt.
    // Naive `safe.startsWith(root)` would treat
    // .../site-secret/leak.txt as inside .../site (no separator boundary
    // check). The fixed server must reject this.
    const base = mkdtempSync(join(tmpdir(), 'stp-traversal-'));
    const isoWebRoot = join(base, 'site');
    const sibling = join(base, 'site-secret');
    mkdirSync(isoWebRoot, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(isoWebRoot, 'index.html'), '<html>ok</html>');
    writeFileSync(join(sibling, 'leak.txt'), 'TOPSECRET');

    const localStore = new HistoryStore(':memory:');
    const localServer = createHttpServer({
      port: 0, host: '127.0.0.1',
      getState: () => fakeState, store: localStore, webRoot: isoWebRoot,
    });
    const { port } = await localServer.start();
    try {
      // The slashes in the traversal are themselves URL-encoded so the
      // WHATWG URL parser does not collapse the '..' segment. After
      // decodeURIComponent the path becomes literal "/../site-secret/leak.txt"
      // and resolves under <root>-secret. The fixed prefix check rejects it.
      const r = await rawGet(port, '/%2e%2e%2fsite-secret%2fleak.txt');
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('TOPSECRET');
    } finally {
      await localServer.stop();
      localStore.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
