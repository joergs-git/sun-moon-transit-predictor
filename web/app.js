const STATE_INTERVAL_MS = 2000;
const HISTORY_INTERVAL_MS = 15000;

const $ = (sel) => document.querySelector(sel);

function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function fmtAlt(m) { return m == null ? '—' : `${Math.round(m * 3.28084 / 100) * 100}ft`; }
function fmtSpeed(ms) { return ms == null ? '—' : `${Math.round(ms / 0.514444)}kt`; }
function fmtSep(d) { return d == null ? '—' : `${d.toFixed(2)}°`; }
function fmtDuration(ms) { return ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`; }
function fmtRoute(o, d) { return o && d ? `${o}→${d}` : (o || d || '—'); }
function fmtTime(ms) { return new Date(ms).toLocaleTimeString(); }

function renderSky(state) {
  const tbody = $('#sky tbody');
  tbody.innerHTML = '';
  if (!state.bodies) return;
  for (const [name, body] of Object.entries(state.bodies)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="body-${name}">${name}</td>
      <td>${body.azimuthDeg.toFixed(1)}°</td>
      <td>${body.elevationDeg.toFixed(1)}°</td>
      <td>${body.observable ? '✓' : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderCandidates(state) {
  const tbody = $('#candidates tbody');
  tbody.innerHTML = '';
  const cands = state.candidates ?? [];
  if (cands.length === 0) {
    tbody.innerHTML = '<tr class="empty"><td colspan="9">No candidates within 60 s.</td></tr>';
    return;
  }
  for (const c of cands) {
    const ac = c.aircraft;
    const eta = fmtCountdown(c.closestApproachAtMs - state.nowMs);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${eta}</td>
      <td class="body-${c.body}">${c.body}</td>
      <td>${c.route?.flight ?? c.callsign ?? ''}</td>
      <td>${c.icao.toUpperCase()}</td>
      <td>${fmtRoute(c.route?.origin?.iata ?? c.route?.origin?.icao, c.route?.destination?.iata ?? c.route?.destination?.icao)}</td>
      <td>${fmtAlt(ac.altMmsl)}</td>
      <td>${fmtSpeed(ac.groundSpeedMs)}</td>
      <td>${fmtSep(c.closestApproachSepDeg)}</td>
      <td>${fmtDuration(c.durationMs)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function fmtSpreadMs(ms) {
  if (ms == null) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `±${m}m`;
  const h = Math.floor(m / 60);
  return `±${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

function fmtCountdownLong(ms) {
  if (ms <= 0) return 'now';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `${h}h${m ? ` ${m}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function renderExpected(state) {
  const tbody = document.querySelector('#expected tbody');
  tbody.innerHTML = '';
  const rows = state.expected ?? [];
  if (rows.length === 0) {
    tbody.innerHTML = '<tr class="empty"><td colspan="7">Watchlist empty (need ≥2 distinct-day hits).</td></tr>';
    return;
  }
  for (const e of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtCountdownLong(e.etaMs)}</td>
      <td>${fmtTime(e.expectedAtMs)}</td>
      <td class="body-${e.body}">${e.body}</td>
      <td>${e.flight}</td>
      <td>${e.observations}</td>
      <td>${e.distinctDays}</td>
      <td>${fmtSpreadMs(e.stdevMs)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderHistory(events) {
  const tbody = $('#history tbody');
  tbody.innerHTML = '';
  if (!events || events.length === 0) {
    tbody.innerHTML = '<tr class="empty"><td colspan="10">No history yet.</td></tr>';
    return;
  }
  for (const e of events) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="stage-${e.stage}">${fmtTime(e.closest_at_ms)}</td>
      <td>${fmtTime(e.recorded_at_ms)}</td>
      <td class="stage-${e.stage}">${e.stage}</td>
      <td class="body-${e.body}">${e.body}</td>
      <td>${e.flight ?? e.callsign ?? ''}</td>
      <td>${e.icao.toUpperCase()}</td>
      <td>${fmtRoute(e.origin, e.destination)}</td>
      <td>${fmtAlt(e.altitude_m)}</td>
      <td>${fmtSpeed(e.ground_speed_ms)}</td>
      <td>${fmtSep(e.closest_sep_deg)}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function pollState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(res.status);
    const state = await res.json();
    renderSky(state);
    renderCandidates(state);
    renderExpected(state);
    const status = $('#status');
    const age = Math.round((Date.now() - state.lastUpdateMs) / 1000);
    status.textContent = `live · ${age}s ago · ${state.aircraftCount ?? 0} aircraft`;
    status.className = age > 10 ? 'status stale' : 'status live';
    if (state.observer) {
      $('#observer').textContent =
        `Observer ${state.observer.name ?? ''} ` +
        `(${state.observer.latitudeDeg.toFixed(4)}°, ${state.observer.longitudeDeg.toFixed(4)}°, ` +
        `${state.observer.elevationM} m)`;
    }
  } catch (e) {
    const status = $('#status');
    status.textContent = `disconnected: ${e.message ?? e}`;
    status.className = 'status stale';
  }
}

async function pollHistory() {
  try {
    const res = await fetch('/api/history?limit=100');
    if (!res.ok) return;
    const { events } = await res.json();
    renderHistory(events);
  } catch { /* ignore */ }
}

pollState();
pollHistory();
setInterval(pollState, STATE_INTERVAL_MS);
setInterval(pollHistory, HISTORY_INTERVAL_MS);
