import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { promises as fsp, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createHttpServer } from '../src/server.js';
import { HistoryStore } from '../src/store.js';
import { fetchActiveTles } from '../src/sattransit.js';

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

  it('serves /api/stats/report as JSON with meta + recommendations (v0.41.0)', async () => {
    const res = await fetch(`${baseUrl}/api/stats/report`);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.meta).toBeTruthy();
    // recommendations only surface real deltas vs the live config, so on an
    // empty store at shipped defaults the list can legitimately be empty.
    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(body.corridor).toBeTruthy();
    expect('yield' in body).toBe(true);
    expect(body.timing).toBeTruthy();
    expect(Array.isArray(body.timing.byHour)).toBe(true);
    expect(Array.isArray(body.timing.byElevation)).toBe(true);
  });

  it('serves the stats report as a downloadable CSV and TXT', async () => {
    const csv = await fetch(`${baseUrl}/api/stats/report.csv`);
    expect(csv.ok).toBe(true);
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(csv.headers.get('content-disposition')).toMatch(/attachment/);
    expect(await csv.text()).toMatch(/^category,key,value,unit/);
    const txt = await fetch(`${baseUrl}/api/stats/report.txt`);
    expect(txt.ok).toBe(true);
    expect(txt.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await txt.text()).not.toMatch(/\x1b\[/);   // ANSI stripped
  });

  it('serves /api/sat-transit (cached catalogue, no live fetch) (v0.47.1)', async () => {
    // Seed the TLE cache via a mock fetchImpl so the endpoint does no network.
    const tle = 'ISS (ZARYA)\n1 25544U 98067A   24123.54791667  .00016717  00000-0  30074-3 0  9994\n2 25544  51.6402 211.1063 0004604  47.1827  85.0114 15.49814641450000\n';
    await fetchActiveTles({ group: 'active', fetchImpl: async () => ({ ok: true, status: 200, text: async () => tle }) });
    const ms = Date.UTC(2024, 4, 2, 13, 0, 0);
    const res = await fetch(`${baseUrl}/api/sat-transit?ms=${ms}&window=4&sep=180&group=active`);
    expect(res.ok).toBe(true);
    const b = await res.json();
    expect(b.body).toBe('Sun');
    expect(b.scanned).toBe(1);
    expect(Number.isFinite(b.bodyAt.elevationDeg)).toBe(true);
    expect(Array.isArray(b.hits)).toBe(true);
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

  it('serves /api/hourstats (zeroed 24-bin shape, params honoured)', async () => {
    const res = await fetch(`${baseUrl}/api/hourstats?sepDeg=0.3&minElevationDeg=45`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.sepBelowDeg).toBe(0.3);
    expect(body.minElevationDeg).toBe(45);
    expect(body.n).toBe(0);
    expect(body.perBody.Sun.length).toBe(24);
    expect(body.perBody.Moon.length).toBe(24);
    expect(body.total).toEqual(new Array(24).fill(0));
    expect(body.peak).toEqual({ Sun: null, Moon: null, all: null });
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

describe('HTTP server — /api/diag/sql (v0.46.0)', () => {
  let srv; let url; let diagOn;

  beforeAll(async () => {
    diagOn = true;
    store.recordArm({ armedAtMs: 1, rig: 'r', kind: 'aircraft', body: 'Sun', icao: 'abc123', sepDeg: 0.3, elevDeg: 25 });
    srv = createHttpServer({
      port: 0, host: '127.0.0.1', getState: () => fakeState, store,
      webRoot: resolve(ROOT, 'web'), getConfig: () => ({ diag: { enabled: diagOn } }),
    });
    const { port } = await srv.start();
    url = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { if (srv) await srv.stop(); });

  const q = (sql) => fetch(`${url}/api/diag/sql`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }),
  });

  it('runs a read-only SELECT and returns columns + rows', async () => {
    const res = await q('SELECT icao, sep_deg FROM capture_arms');
    expect(res.ok).toBe(true);
    const b = await res.json();
    expect(b.columns).toEqual(['icao', 'sep_deg']);
    expect(b.rows[0].icao).toBe('abc123');
  });

  it('allows a leading SQL comment before SELECT', async () => {
    const res = await q('-- drift check\nSELECT icao FROM capture_arms');
    expect(res.ok).toBe(true);
    expect((await res.json()).rows[0].icao).toBe('abc123');
  });

  it('rejects writes, DDL and multiple statements', async () => {
    for (const sql of ['DELETE FROM capture_arms', 'DROP TABLE capture_arms',
      'UPDATE capture_arms SET sep_deg=0', 'SELECT 1; DROP TABLE capture_arms',
      'PRAGMA table_info(capture_arms)', '/* x */ DELETE FROM capture_arms']) {
      expect((await q(sql)).status).toBe(400);
    }
  });

  it('404s when diagnostics are disabled', async () => {
    diagOn = false;
    expect((await q('SELECT 1')).status).toBe(404);
    diagOn = true;
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

describe('HTTP server — /api/acinfo (AirNav proxy)', () => {
  let srv;
  let url;
  let seen;

  beforeAll(async () => {
    seen = [];
    srv = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      getState: () => fakeState,
      store,
      webRoot: resolve(ROOT, 'web'),
      requestAcInfo: async (hex) => {
        seen.push(hex);
        return hex === 'abc123' ? { hex, aircraft: { registration: 'D-TEST' }, live: null } : null;
      },
    });
    const { port } = await srv.start();
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => { if (srv) await srv.stop(); });

  it('400s an invalid hex and never calls the proxy', async () => {
    const res = await fetch(`${url}/api/acinfo?hex=ISS`);
    expect(res.status).toBe(400);
    expect(seen.length).toBe(0);
  });

  it('200s with the curated info for a known hex', async () => {
    const res = await fetch(`${url}/api/acinfo?hex=ABC123`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.aircraft.registration).toBe('D-TEST');
    expect(seen).toContain('abc123');
  });

  it('404s when the proxy returns null (unknown / disabled)', async () => {
    const res = await fetch(`${url}/api/acinfo?hex=ffffff`);
    expect(res.status).toBe(404);
  });
});

describe('HTTP server — /api/acinfo disabled', () => {
  it('404s when requestAcInfo is not wired', async () => {
    const res = await fetch(`${baseUrl}/api/acinfo?hex=abc123`);
    expect(res.status).toBe(404);
  });
});

describe('HTTP server — /api/route (free callsign → route)', () => {
  let srv;
  let url;

  beforeAll(async () => {
    srv = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      getState: () => fakeState,
      store,
      webRoot: resolve(ROOT, 'web'),
      requestRoute: async (cs) => (cs === 'DLH400'
        ? { flight: 'LH400', airline: { name: 'Lufthansa' }, origin: { iata: 'FRA' }, destination: { iata: 'JFK' } }
        : null),
    });
    const { port } = await srv.start();
    url = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { if (srv) await srv.stop(); });

  it('400s a bad callsign', async () => {
    const res = await fetch(`${url}/api/route?cs=%20`);
    expect(res.status).toBe(400);
  });
  it('200s a known callsign with the normalised route', async () => {
    const res = await fetch(`${url}/api/route?cs=dlh400`);
    expect(res.ok).toBe(true);
    const b = await res.json();
    expect(b.callsign).toBe('DLH400');
    expect(b.route.airline.name).toBe('Lufthansa');
  });
  it('404s an unknown callsign', async () => {
    const res = await fetch(`${url}/api/route?cs=ZZZ999`);
    expect(res.status).toBe(404);
  });
  it('404s when requestRoute is not wired', async () => {
    const res = await fetch(`${baseUrl}/api/route?cs=DLH400`);
    expect(res.status).toBe(404);
  });
});

describe('static file path traversal', () => {
  // webRoot = <tmp>/site ; a sibling <tmp>/site-secret/leak.txt shares the
  // "site" prefix, so a naive startsWith(webRoot) check would serve it. The
  // request uses URL-encoded slashes (%2e%2e%2f…) sent via the raw http
  // module so it survives normalisation that fetch() would otherwise apply.
  let srv;
  let url;
  let tmp;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'stp-static-'));
    const site = join(tmp, 'site');
    const secret = join(tmp, 'site-secret');
    await fsp.mkdir(site, { recursive: true });
    await fsp.mkdir(secret, { recursive: true });
    await fsp.writeFile(join(site, 'index.html'), '<h1>public</h1>');
    await fsp.writeFile(join(secret, 'leak.txt'), 'TOP-SECRET');
    srv = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      getState: () => fakeState,
      store,
      webRoot: site,
    });
    const { port } = await srv.start();
    url = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    if (srv) await srv.stop();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // Raw GET that does NOT normalise the path (fetch would collapse the dots).
  function rawGet(rawPath) {
    return new Promise((res, rej) => {
      const u = new URL(url);
      const req = httpRequest(
        { host: u.hostname, port: u.port, path: rawPath, method: 'GET' },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', rej);
      req.end();
    });
  }

  it('serves a normal file inside webRoot', async () => {
    const r = await rawGet('/index.html');
    expect(r.status).toBe(200);
    expect(r.body).toContain('public');
  });

  it('403s an encoded-slash traversal into a prefix-sibling dir', async () => {
    const r = await rawGet('/%2e%2e%2fsite-secret%2fleak.txt');
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('TOP-SECRET');
  });
});
