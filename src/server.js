// Tiny HTTP server: JSON API + static frontend, no framework dependency.
// Runs on the Pi alongside dump1090-fa, serving the web UI.

import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { buildReport, formatText, formatCsv } from './stats.js';
import { fetchActiveTles, findBodyTransits } from './sattransit.js';

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

// Read-only SQL guard for /api/diag/sql (v0.46.0): a single SELECT/WITH
// statement only — no writes, no multiple statements, no PRAGMA/ATTACH. Belt
// and braces even on a LAN-only tool so a typo can never mutate the history DB.
function isReadOnlySql(sql) {
  // Strip SQL comments first — they're harmless (SQLite ignores them) but a
  // leading "-- note" would otherwise fail the "starts with SELECT" check. Done
  // on a copy used ONLY for the safety check; the original runs verbatim.
  const s = String(sql || '')
    .replace(/--[^\n]*/g, ' ')          // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // block comments
    .trim().replace(/;+\s*$/, '');      // strip trailing ';'
  if (!s || s.includes(';')) return false;                    // single statement only
  if (!/^(select|with)\b/i.test(s)) return false;             // must start SELECT/WITH
  // Reject any write/DDL/side-effect keyword as a standalone word, anywhere.
  return !/\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate)\b/i.test(s);
}

// Plain-text / CSV response with an optional download filename (v0.41.0).
function textResponse(res, status, text, contentType, downloadName) {
  const buf = Buffer.from(text);
  const headers = {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
  res.writeHead(status, headers);
  res.end(buf);
}

async function serveStatic(req, res, webRoot) {
  const url = new URL(req.url, 'http://x');
  let path = decodeURIComponent(url.pathname);
  if (path === '/' || path === '') path = '/index.html';
  const root = resolve(webRoot);
  const safe = resolve(join(root, path));
  // Separator-aware boundary: a naive startsWith(root) also accepts a
  // sibling directory whose name shares the prefix (webRoot /srv/site →
  // /srv/site-secret/leak.txt). WHATWG URL parsing usually collapses `..`,
  // but URL-encoded slashes (%2e%2e%2fsite-secret%2f…) survive it and land
  // the resolved path outside webRoot. Require an exact root match or a
  // prefix that ends with the platform path separator.
  if (safe !== root && !safe.startsWith(root + sep)) {
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
 *   requestSharpcapTest?: (opts: { durationS?: number, host?: string, port?: number }) => Promise<{ sent: boolean, response?: object, reason?: string, error?: any }>,
 * }} opts
 */
export function createHttpServer(opts) {
  const {
    port, host = '0.0.0.0', getState, store, webRoot,
    getConfig, updateConfig, requestUpdate, requestAcInfo, requestRoute,
    requestSharpcapTest, requestBuzzerTest, setActiveTarget, getNextOpportunity,
    requestWifiScan, requestWifiConnect, requestWifiStatus,
    requestMount, setMountArmed,
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
      if (url.pathname === '/api/route') {
        // Free callsign → route (adsbdb, no token, server-cached). Powers
        // the flight-number hover regardless of AirNav.
        if (!requestRoute) return jsonResponse(res, 404, { error: 'route api disabled' });
        const cs = (url.searchParams.get('cs') ?? '').trim().toUpperCase();
        if (!/^[A-Z0-9]{2,10}$/.test(cs)) {
          return jsonResponse(res, 400, { error: 'cs must be a 2–10 char callsign' });
        }
        try {
          const route = await requestRoute(cs);
          if (!route) return jsonResponse(res, 404, { error: 'no route for callsign' });
          return jsonResponse(res, 200, { callsign: cs, route });
        } catch (e) {
          return jsonResponse(res, 502, { error: String(e?.message ?? e) });
        }
      }
      if (url.pathname === '/api/acstats') {
        // Persistent "how often did it come by" tally over all detected
        // traffic. limit governs both the top lists and the TOP-10 chart.
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '20')));
        return jsonResponse(res, 200, {
          icao: store.topSightings({ kind: 'icao', limit }),
          flight: store.topSightings({ kind: 'flight', limit }),
          totals: store.sightingTotals(),
        });
      }
      if (url.pathname === '/api/rangestats') {
        // Retrospective: of the aircraft that ACTUALLY passed < sepDeg
        // (imminent-confirmed), how far away were they?
        const sepDeg = Math.min(5, Math.max(0.05, Number(url.searchParams.get('sepDeg') ?? '0.5')));
        const windowDays = Math.min(3650, Math.max(1, Number(url.searchParams.get('windowDays') ?? '3650')));
        return jsonResponse(res, 200,
          store.rangeStats({ sepBelowDeg: sepDeg, windowMs: windowDays * 24 * 3600_000 }));
      }
      if (url.pathname === '/api/usable') {
        // Real usable transit candidates: imminent-confirmed transits whose
        // aircraft was ≥ minElevationDeg above the horizon at closest
        // approach (default 30°, same as the Pushover gate). Powers the
        // second Aircraft-stats list.
        const minEl = Math.min(90, Math.max(0, Number(url.searchParams.get('minElevationDeg') ?? '30')));
        const windowDays = Math.min(3650, Math.max(1, Number(url.searchParams.get('windowDays') ?? '3650')));
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '20')));
        return jsonResponse(res, 200, store.usableCandidates({
          minElevationDeg: minEl, windowMs: windowDays * 24 * 3600_000, limit,
        }));
      }
      if (url.pathname === '/api/hourstats') {
        // "At which times of day do the usable hits happen?" — a 24-bin
        // hour-of-day histogram, split by Sun/Moon, over imminent-confirmed
        // transits that passed < sepDeg AND were ≥ minElevationDeg up
        // (same usable definition as /api/rangestats + /api/usable). Hours
        // are server-local (the Pi sits at the observatory).
        const sepDeg = Math.min(5, Math.max(0.05, Number(url.searchParams.get('sepDeg') ?? '0.5')));
        const minEl = Math.min(90, Math.max(0, Number(url.searchParams.get('minElevationDeg') ?? '30')));
        const windowDays = Math.min(3650, Math.max(1, Number(url.searchParams.get('windowDays') ?? '3650')));
        return jsonResponse(res, 200, store.hourStats({
          sepBelowDeg: sepDeg, minElevationDeg: minEl,
          windowMs: windowDays * 24 * 3600_000,
        }));
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
      if (url.pathname === '/api/sharpcap-test' && req.method === 'POST') {
        // Settings "Test trigger" → fire an immediate short capture on the
        // Windows SharpCap host. Requires a JSON body (so a cross-site form
        // can't drive-by trigger it without a CORS preflight this server
        // ignores). Optional host/port test the form values before saving.
        if (!requestSharpcapTest) return jsonResponse(res, 404, { error: 'sharpcap test api disabled' });
        let body;
        try { body = await readJsonBody(req); }
        catch (e) { return jsonResponse(res, 400, { error: `bad json: ${e.message}` }); }
        try {
          const result = await requestSharpcapTest({
            durationS: body?.durationS,
            host: body?.host,
            port: body?.port,
          });
          const status = result?.sent ? 200 : 502;
          return jsonResponse(res, status, {
            sent: Boolean(result?.sent),
            response: result?.response ?? null,
            reason: result?.reason ?? null,
            error: result?.error ? String(result.error?.message ?? result.error) : null,
          });
        } catch (e) {
          return jsonResponse(res, 500, { error: String(e?.message ?? e) });
        }
      }
      if (url.pathname === '/api/buzzer-test' && req.method === 'POST') {
        // Settings "Test signals" → nudge the Pi-side buzzer to play every
        // configured signal once. Requires a JSON body (same anti-drive-by
        // guard as /api/sharpcap-test). The actual beeps happen on the display
        // Pi within a few seconds, when its config poll sees the new test id.
        if (!requestBuzzerTest) return jsonResponse(res, 404, { error: 'buzzer test api disabled' });
        try { await readJsonBody(req); }
        catch (e) { return jsonResponse(res, 400, { error: `bad json: ${e.message}` }); }
        try {
          return jsonResponse(res, 200, requestBuzzerTest());
        } catch (e) {
          return jsonResponse(res, 500, { error: String(e?.message ?? e) });
        }
      }
      if (url.pathname === '/api/active-target' && req.method === 'POST') {
        // Set which sky object the scope is pointed at (M83). Body: { target }.
        if (!setActiveTarget) return jsonResponse(res, 404, { error: 'active-target api disabled' });
        let body;
        try { body = await readJsonBody(req); }
        catch (e) { return jsonResponse(res, 400, { error: `bad json: ${e.message}` }); }
        try {
          const result = setActiveTarget(body?.target);
          return jsonResponse(res, result.ok ? 200 : 400, result);
        } catch (e) {
          return jsonResponse(res, 500, { error: String(e?.message ?? e) });
        }
      }
      if (url.pathname === '/api/mount' && req.method === 'POST') {
        // Mount control (v0.55.0). Body: { action: 'slew'|'unpark'|'track'|
        // 'park'|'status'|'arm'|'disarm', targetId?, on? }. All safety gates are
        // enforced server-side. 404 unless config.sharpcap.mount.enabled.
        if (!requestMount) return jsonResponse(res, 404, { error: 'mount api disabled' });
        let body;
        try { body = await readJsonBody(req); }
        catch (e) { return jsonResponse(res, 400, { error: `bad json: ${e.message}` }); }
        const action = String(body?.action ?? '');
        try {
          if (action === 'arm' || action === 'disarm') {
            if (!setMountArmed) return jsonResponse(res, 404, { error: 'mount api disabled' });
            return jsonResponse(res, 200, { ok: true, ...setMountArmed(action === 'arm') });
          }
          const result = await requestMount(action, { targetId: body?.targetId, on: body?.on });
          return jsonResponse(res, result.ok ? 200 : 400, result);
        } catch (e) {
          return jsonResponse(res, 500, { error: String(e?.message ?? e) });
        }
      }
      // Off-road WiFi onboarding (v0.51.0). Scan + status are read-only nmcli
      // reads; connect only DROPS A TRIGGER FILE that the privileged stp-wifi
      // .path unit consumes — the HTTP layer never runs a privileged nmcli (same
      // trust boundary as /api/update).
      if (url.pathname === '/api/wifi/scan' && (req.method === 'POST' || req.method === 'GET')) {
        if (!requestWifiScan) return jsonResponse(res, 404, { error: 'wifi api disabled' });
        try {
          return jsonResponse(res, 200, { networks: await requestWifiScan() });
        } catch (e) {
          return jsonResponse(res, 500, { error: String(e?.message ?? e) });
        }
      }
      if (url.pathname === '/api/wifi/status' && req.method === 'GET') {
        if (!requestWifiStatus) return jsonResponse(res, 404, { error: 'wifi api disabled' });
        try {
          return jsonResponse(res, 200, await requestWifiStatus());
        } catch (e) {
          return jsonResponse(res, 500, { error: String(e?.message ?? e) });
        }
      }
      if (url.pathname === '/api/wifi/connect' && req.method === 'POST') {
        if (!requestWifiConnect) return jsonResponse(res, 404, { error: 'wifi api disabled' });
        let body;
        try { body = await readJsonBody(req); }
        catch (e) { return jsonResponse(res, 400, { error: `bad json: ${e.message}` }); }
        try {
          const result = await requestWifiConnect(body?.ssid, body?.psk ?? body?.password);
          return jsonResponse(res, result.ok ? 200 : 400, result);
        } catch (e) {
          return jsonResponse(res, 400, { error: String(e?.message ?? e) });
        }
      }
      if (url.pathname === '/api/sky-next-opportunity' && req.method === 'GET') {
        // On-demand long-horizon "next opportunity" scan (M83). Synchronous +
        // heavy (~8 s), so it runs only on this explicit request, not per tick.
        if (!getNextOpportunity) return jsonResponse(res, 404, { error: 'sky next-opportunity api disabled' });
        try {
          return jsonResponse(res, 200, getNextOpportunity());
        } catch (e) {
          return jsonResponse(res, 500, { error: String(e?.message ?? e) });
        }
      }

      // History statistics report (v0.41.0) — the same shared src/stats.js core
      // the CLI uses, served three ways so the browser can show + download it
      // without any SSH: JSON (UI render), .txt and .csv (downloads). On-demand
      // only (a few SELECTs + JS aggregation), never per tick.
      if (url.pathname.startsWith('/api/stats/report') && req.method === 'GET') {
        if (!store) return jsonResponse(res, 404, { error: 'stats api disabled (no store)' });
        try {
          // Pass the live sharpcap config so recommendations show the REAL
          // current values (a saved service.json keeps old values after a
          // default bump) and only surface actual deltas.
          const report = buildReport(store, { sharpcap: getConfig?.()?.sharpcap });
          if (url.pathname === '/api/stats/report.csv') {
            return textResponse(res, 200, formatCsv(report), 'text/csv; charset=utf-8', 'transit-stats.csv');
          }
          if (url.pathname === '/api/stats/report.txt') {
            // Strip the ANSI bold codes the CLI uses — a plain-text download.
            const txt = formatText(report).replace(/\x1b\[[0-9;]*m/g, '');
            return textResponse(res, 200, txt, 'text/plain; charset=utf-8', 'transit-stats.txt');
          }
          return jsonResponse(res, 200, report);
        } catch (e) {
          return jsonResponse(res, 500, { error: String(e?.message ?? e) });
        }
      }

      // Satellite Sun/Moon transit search (v0.47.1): "which satellite crossed
      // the disc at this time?" Fetches Celestrak (cached ~6 h) and propagates
      // the catalogue with the app's SGP4 — the browser path for the CLI finder.
      if (url.pathname === '/api/sat-transit' && req.method === 'GET') {
        const st = getState?.();
        const observer = st?.observer;
        if (!observer || !Number.isFinite(observer.latitudeDeg)) return jsonResponse(res, 404, { error: 'no observer location' });
        const q = url.searchParams;
        const whenMs = Number(q.get('ms')) || Date.now();
        const windowS = Math.min(60, Math.max(1, Number(q.get('window')) || 12));
        const sepDeg = Math.min(10, Math.max(0.1, Number(q.get('sep')) || 2));
        const body = q.get('body') === 'Moon' ? 'Moon' : 'Sun';
        const group = /^[a-z0-9_-]{1,30}$/i.test(q.get('group') || '') ? q.get('group') : 'active';
        try {
          const sats = await fetchActiveTles({ group });
          const result = findBodyTransits({ observer, sats, whenMs, windowS, sepDeg, body });
          return jsonResponse(res, 200, result);
        } catch (e) {
          return jsonResponse(res, 502, { error: String(e?.message ?? e) });
        }
      }

      // Local diagnostics (v0.46.0): a SELECT-only read window onto the history
      // DB, for the /diag page. OFF unless diag.enabled — a LAN debug tool with
      // no auth. SELECT/WITH only, single statement, result-capped; it can read
      // the (non-secret) history DB but never write to it.
      if (url.pathname === '/api/diag/sql' && req.method === 'POST') {
        if (!getConfig?.()?.diag?.enabled) return jsonResponse(res, 404, { error: 'diagnostics disabled — enable it in Settings (Diag)' });
        if (!store) return jsonResponse(res, 404, { error: 'no store' });
        let body;
        try { body = await readJsonBody(req); }
        catch (e) { return jsonResponse(res, 400, { error: `bad json: ${e.message}` }); }
        const sql = String(body?.sql ?? '');
        if (!isReadOnlySql(sql)) return jsonResponse(res, 400, { error: 'only a single read-only SELECT / WITH query is allowed' });
        try {
          const rows = store.db.prepare(sql).all();
          const LIMIT = 2000;
          const capped = rows.slice(0, LIMIT);
          const columns = capped.length ? Object.keys(capped[0]) : [];
          return jsonResponse(res, 200, { columns, rows: capped, total: rows.length, truncated: rows.length > LIMIT });
        } catch (e) {
          return jsonResponse(res, 400, { error: String(e?.message ?? e) });
        }
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
