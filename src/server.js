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

/**
 * @param {{
 *   port: number,
 *   host?: string,
 *   getState: () => object,
 *   store: import('./store.js').HistoryStore,
 *   webRoot: string,
 * }} opts
 */
export function createHttpServer(opts) {
  const { port, host = '0.0.0.0', getState, store, webRoot } = opts;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/api/state') {
        return jsonResponse(res, 200, getState());
      }
      if (url.pathname === '/api/history') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '100')));
        return jsonResponse(res, 200, { events: store.recent({ limit }) });
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
