// Tiny HTTP server: JSON API + static frontend, no framework dependency.
// Runs on the Pi alongside dump1090-fa, serving the web UI.

import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function jsonResponse(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

async function serveStatic(req, res, webRoot) {
  const url = new URL(req.url, 'http://x');
  let path = decodeURIComponent(url.pathname);
  if (path === '/' || path === '') path = '/index.html';
  const root = resolve(webRoot);
  const safe = resolve(join(root, path));
  if (!safe.startsWith(root)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const buf = await fs.readFile(safe);
    res.writeHead(200, {
      'Content-Type': MIME[extname(safe).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  // Small JSON bodies only — the settings editor sends a few KB at most.
  // Bigger payloads are rejected outright to keep this tiny server safe from
  // memory-exhaustion shenanigans without pulling in a body-parser dep.
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectBody(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolveBody({});
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { rejectBody(e); }
    });
    req.on('error', rejectBody);
  });
}

/**
 * @param {{
 *   port: number,
 *   host?: string,
 *   getState: () => object,
 *   store: import('./store.js').HistoryStore,
 *   webRoot: string,
 *   getConfig?: () => object,
 *   updateConfig?: (patch: object) => Promise<{ ok: boolean, applied: object, warnings?: string[] }>,
 *   requestUpdate?: () => Promise<{ ok: boolean, pending?: boolean, message?: string }>,
 *   requestAcInfo?: (hex: string) => Promise<object|null>,
 * }} opts
 */
export function createHttpServer(opts) {
  const {
    port, host = '0.0.0.0', getState, store, webRoot,
    getConfig, updateConfig, requestUpdate, requestAcInfo,
  } = opts;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/api/state') {
        return jsonResponse(res, 200, getState());
      }
      if (url.pathname === '/api/config' && req.method === 'GET') {
        if (!getConfig) return jsonResponse(res, 404, { error: 'config api disabled' });
        return jsonResponse(res, 200, getConfig());
      }
      if (url.pathname === '/api/config' && req.method === 'POST') {
        if (!updateConfig) return jsonResponse(res, 404, { error: 'config api disabled' });
        let body;
        try { body = await readJsonBody(req); }
        catch (e) { return jsonResponse(res, 400, { error: `bad json: ${e.message}` }); }
        try {
          const result = await updateConfig(body);
          return jsonResponse(res, 200, result);
        } catch (e) {
          return jsonResponse(res, 400, { error: String(e?.message ?? e) });
        }
      }
      if (url.pathname === '/api/update' && req.method === 'POST') {
        // Click-to-update from the version badge. This endpoint deliberately
        // does NOT run git/systemctl itself — it only drops a trigger file
        // (see service.js → requestUpdate). A privileged systemd .path unit
        // observes that file and runs the existing stp-update.service with
        // the right permissions, so the unauthenticated LAN HTTP layer never
        // gains shell/sudo. requestJsonBody is required (so a cross-site
        // form/`fetch` without the JSON content-type can't drive-by trigger
        // it — that request would need a CORS preflight this server ignores).
        if (!requestUpdate) return jsonResponse(res, 404, { error: 'update api disabled' });
        let body;
        try { body = await readJsonBody(req); }
        catch (e) { return jsonResponse(res, 400, { error: `bad json: ${e.message}` }); }
        if (body?.confirm !== true) {
          return jsonResponse(res, 400, { error: 'confirmation required ({ "confirm": true })' });
        }
        try {
          const result = await requestUpdate();
          return jsonResponse(res, 200, result);
        } catch (e) {
          return jsonResponse(res, 500, { error: String(e?.message ?? e) });
        }
      }
      if (url.pathname === '/api/acinfo') {
        // Server-side AirNav proxy. The token stays here; the browser only
        // ever talks to this endpoint. Lazy: the UI calls it on a row
        // click / flight-number hover (each upstream call is billed).
        if (!requestAcInfo) return jsonResponse(res, 404, { error: 'acinfo api disabled' });
        const hex = (url.searchParams.get('hex') ?? '').trim().toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(hex)) {
          return jsonResponse(res, 400, { error: 'hex must be a 6-digit ICAO 24-bit code' });
        }
        try {
          const info = await requestAcInfo(hex);
          if (!info) {
            return jsonResponse(res, 404, { error: 'no aircraft info (AirNav disabled or unknown airframe)' });
          }
          return jsonResponse(res, 200, info);
        } catch (e) {
          return jsonResponse(res, 502, { error: String(e?.message ?? e) });
        }
      }
      if (url.pathname === '/api/history') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '100')));
        // Episode-consolidated history view (v0.7.8+): one row per real
        // transit, combining earliest-detection time with tightest-sep
        // snapshot. Replaces the prior radio/candidate/imminent triplet
        // that made recorded_at_ms appear to sit 30 s before transit
        // (that was the imminent row of a 3-row episode).
        const events = store.consolidatedHistory({ limit }).map((row) => {
          let payload = null;
          if (row.payload_json) {
            try { payload = JSON.parse(row.payload_json); } catch { /* drop */ }
          }
          const { payload_json, ...rest } = row;
          return { ...rest, payload };
        });
        return jsonResponse(res, 200, { events });
      }
      if (url.pathname === '/api/learning') {
        // Rolling alert-effectiveness stats. windowDays caps at 90 days to
        // bound the SQL scan; default 14 matches the predictor's window.
        const windowDays = Math.min(90, Math.max(1, Number(url.searchParams.get('windowDays') ?? '14')));
        const result = store.episodes({ windowMs: windowDays * 24 * 3600_000 });
        return jsonResponse(res, 200, {
          windowDays,
          aggregates: result.aggregates,
          recent: result.episodes.slice(0, 20),
        });
      }
      if (url.pathname === '/api/health') {
        return jsonResponse(res, 200, { ok: true, time: new Date().toISOString() });
      }
      return serveStatic(req, res, webRoot);
    } catch (e) {
      jsonResponse(res, 500, { error: String(e?.message ?? e) });
    }
  });

  return {
    start() {
      return new Promise((resolveListen) => {
        server.listen(port, host, () => {
          const a = server.address();
          resolveListen({ port: a.port, host: a.address });
        });
      });
    },
    stop() {
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
    address() { return server.address(); },
    server,
  };
}
