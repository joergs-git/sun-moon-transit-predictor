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

function fmtAlt(m)        { return m  == null ? '—' : `${Math.round(m / 100) * 100} m`; }
function fmtSpeed(ms)     { return ms == null ? '—' : `${Math.round(ms * 3.6)} km/h`; }
function fmtDistance(m)   { return m  == null ? '—' : `${(m / 1000).toFixed(1)} km`; }
function fmtSep(d)        { return d  == null ? '—' : `${d.toFixed(2)}°`; }
function fmtDuration(ms)  { return ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`; }
function fmtRoute(o, d)   { return o && d ? `${o}→${d}` : (o || d || '—'); }
function fmtTime(ms)      { return new Date(ms).toLocaleTimeString(); }

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

const STATUS_LABELS = {
  planned:   { icon: '📅', label: 'planned' },
  radio:     { icon: '📡', label: 'radio' },
  candidate: { icon: '✈️', label: 'candidate' },
  imminent:  { icon: '🎯', label: 'imminent' },
  stale:     { icon: '❌', label: 'stale' },
};

function renderTracking(state) {
  const tbody = $('#tracking tbody');
  tbody.innerHTML = '';
  const rows = state.lifecycle ?? [];
  if (rows.length === 0) {
    tbody.innerHTML = '<tr class="empty"><td colspan="10">Tracking list empty.</td></tr>';
    return;
  }
  for (const e of rows) {
    const tr = document.createElement('tr');
    tr.className = `row-${e.status}`;
    const meta = STATUS_LABELS[e.status] ?? { icon: '', label: e.status };
    const eta = e.etaMs > 0 ? fmtCountdownLong(e.etaMs)
              : Math.abs(e.etaMs) < 60_000 ? 'now'
              : `−${fmtCountdownLong(-e.etaMs)}`;
    const ac = e.candidate?.aircraft;
    const route = e.route ?? e.candidate?.route;
    const rangeM = e.candidate?.aircraftAtClosest?.rangeM ?? null;
    tr.innerHTML = `
      <td><span class="status status-${e.status}" title="${meta.label}">${meta.icon} ${meta.label}</span></td>
      <td>${eta}</td>
      <td>${fmtTime(e.closestApproachAtMs)}</td>
      <td class="body-${e.body}">${e.body}</td>
      <td>${e.flight ?? e.callsign ?? '—'}</td>
      <td>${e.icao ? e.icao.toUpperCase() : '—'}</td>
      <td>${fmtRoute(route?.origin?.iata ?? route?.origin?.icao, route?.destination?.iata ?? route?.destination?.icao)}</td>
      <td>${fmtAlt(ac?.altMmsl)}</td>
      <td>${fmtSpeed(ac?.groundSpeedMs)}</td>
      <td>${fmtDistance(rangeM)}</td>
      <td>${e.closestApproachSepDeg !== null ? fmtSep(e.closestApproachSepDeg) : '—'}</td>
    `;
    tbody.appendChild(tr);
  }
}

function fmtCountdownLong(ms) {
  if (ms <= 0) return 'now';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `${h}h${m ? ` ${m}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function renderHistory(events) {
  const tbody = $('#history tbody');
  tbody.innerHTML = '';
  if (!events || events.length === 0) {
    tbody.innerHTML = '<tr class="empty"><td colspan="11">No history yet.</td></tr>';
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
      <td>${fmtDistance(e.range_m)}</td>
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
    renderTracking(state);
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
