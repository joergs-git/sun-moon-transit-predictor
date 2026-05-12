import { buildSketchSvg, fromHistoryRow, fromLifecycleEntry, setOptics } from './sketch.js';

const STATE_INTERVAL_MS = 2000;
const HISTORY_INTERVAL_MS = 15000;

const $ = (sel) => document.querySelector(sel);

// Latest data the renderers saw — kept in module scope so click handlers can
// look up the full entry by row index without re-fetching. Cheaper than
// JSON-stringifying the entry onto a data-* attribute on every render tick.
let lastLifecycle = [];
let lastHistory = [];

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
  lastLifecycle = rows;
  if (rows.length === 0) {
    tbody.innerHTML = '<tr class="empty"><td colspan="10">Tracking list empty.</td></tr>';
    return;
  }
  for (const [i, e] of rows.entries()) {
    const tr = document.createElement('tr');
    tr.className = `row-${e.status} sketchable`;
    tr.dataset.source = 'live';
    tr.dataset.index = String(i);
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
  lastHistory = events ?? [];
  if (!events || events.length === 0) {
    tbody.innerHTML = '<tr class="empty"><td colspan="11">No history yet.</td></tr>';
    return;
  }
  for (const [i, e] of events.entries()) {
    const tr = document.createElement('tr');
    tr.className = 'sketchable';
    tr.dataset.source = 'history';
    tr.dataset.index = String(i);
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
    // Push live optics into the FOV sketch module so a Settings edit is
    // reflected the next time the user opens the popup, without a reload.
    if (state.optics) setOptics(state.optics);
    if (state.externalLinks) applyExternalLinks(state.externalLinks);
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

// Compose the dump1090 link target. If the server config overrides it, use
// that verbatim; otherwise derive http://<current-host>:8080/ so opening the
// UI from any LAN client lands on the right machine.
function applyExternalLinks(links) {
  const a = $('#dump1090-link');
  if (!a) return;
  const explicit = (links?.dump1090Url ?? '').trim();
  a.href = explicit || `${window.location.protocol}//${window.location.hostname}:8080/`;
}

async function pollHistory() {
  try {
    const res = await fetch('/api/history?limit=100');
    if (!res.ok) return;
    const { events } = await res.json();
    renderHistory(events);
  } catch { /* ignore */ }
}

// ---- FOV sketch popup --------------------------------------------------------
// Delegated click handler on document.body so it survives table re-renders
// without needing to re-attach listeners every poll tick.
const modal = $('#sketch-modal');
const modalBody = $('#sketch-body');

function openSketchFor(source, index) {
  const idx = Number(index);
  let input = null;
  if (source === 'live') {
    const entry = lastLifecycle[idx];
    input = entry ? fromLifecycleEntry(entry) : null;
  } else if (source === 'history') {
    const row = lastHistory[idx];
    input = row ? fromHistoryRow(row) : null;
  }
  if (!input) {
    modalBody.innerHTML =
      '<p class="sketch-empty">No geometry available for this row yet — wait for the next live update, ' +
      'or this entry pre-dates the FOV sketch feature.</p>';
  } else {
    modalBody.innerHTML = buildSketchSvg(input);
  }
  modal.hidden = false;
}

function closeSketch() {
  modal.hidden = true;
  modalBody.innerHTML = '';
}

document.body.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-close="1"]')) { closeSketch(); return; }
  const row = t.closest('tr.sketchable');
  if (row) openSketchFor(row.dataset.source, row.dataset.index);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !modal.hidden) closeSketch();
});

// ---- Settings panel ---------------------------------------------------------
// Loads /api/config, fills the form, lets the user edit and POSTs back. The
// server hot-reloads Pushover credentials, observer location and optics and
// writes through to the on-disk configs so the next restart keeps the new
// values.
const settingsModal = $('#settings-modal');
const settingsForm = $('#settings-form');
const settingsMsg = $('#settings-msg');

function setNested(obj, dottedKey, value) {
  const parts = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] ?? {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getNested(obj, dottedKey) {
  return dottedKey.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function fillSettingsForm(cfg) {
  // Each <input name="a.b.c"> maps to a path inside the config object.
  for (const el of settingsForm.elements) {
    if (!el.name) continue;
    let v = getNested(cfg, el.name);
    // Pushover token/user come back masked — show the mask so the user can
    // tell something is configured without exposing the secret.
    if (el.name === 'pushover.token') v = cfg.pushover?.tokenMasked ?? '';
    if (el.name === 'pushover.user')  v = cfg.pushover?.userMasked  ?? '';
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else if (v == null) el.value = '';
    else el.value = v;
  }
}

async function openSettings() {
  settingsMsg.textContent = '';
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`/api/config ${res.status}`);
    const cfg = await res.json();
    fillSettingsForm(cfg);
    settingsModal.hidden = false;
  } catch (e) {
    settingsMsg.textContent = `load failed: ${e.message ?? e}`;
    settingsMsg.className = 'settings-msg err';
    settingsModal.hidden = false;
  }
}

function closeSettings() {
  settingsModal.hidden = true;
}

settingsForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const patch = {};
  for (const el of settingsForm.elements) {
    if (!el.name) continue;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'number') {
      // Skip empty number fields — preserves the optional ones (temperature,
      // pressure) when the user leaves them blank.
      if (el.value === '') continue;
      value = Number(el.value);
      if (!Number.isFinite(value)) continue;
    } else {
      value = el.value;
      // Don't ship the masked placeholder back as the new secret. The server
      // also guards against this but stripping it here makes the intent clear.
      if ((el.name === 'pushover.token' || el.name === 'pushover.user')
          && typeof value === 'string' && value.startsWith('••••')) continue;
    }
    setNested(patch, el.name, value);
  }
  settingsMsg.textContent = 'saving…';
  settingsMsg.className = 'settings-msg';
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    settingsMsg.textContent = body.warnings?.length
      ? `saved · ${body.warnings.join('; ')}`
      : 'saved';
    settingsMsg.className = 'settings-msg ok';
    // Re-poll state immediately so the live UI picks up new optics / location.
    pollState();
  } catch (e) {
    settingsMsg.textContent = `save failed: ${e.message ?? e}`;
    settingsMsg.className = 'settings-msg err';
  }
});

$('#settings-btn').addEventListener('click', openSettings);
document.body.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-close-settings="1"]')) closeSettings();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !settingsModal.hidden) closeSettings();
});

// Pin the copyright year so it always matches the runtime — saves having to
// edit the HTML on every January 1st.
$('#copyright-year').textContent = String(new Date().getFullYear());
// Pre-populate the dump1090 link with a sensible default before /api/state
// answers, so the link works even during the initial loading window.
applyExternalLinks({});

pollState();
pollHistory();
setInterval(pollState, STATE_INTERVAL_MS);
setInterval(pollHistory, HISTORY_INTERVAL_MS);
