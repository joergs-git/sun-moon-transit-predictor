// Diagnostics page (v0.46.0). Posts a single read-only SELECT to /api/diag/sql
// and renders the result table. Presets fill the SQL box with common queries —
// notably the "why did this aircraft fire but not transit?" drift check.

const $ = (s) => document.querySelector(s);
const sqlBox = $('#sql');
const msg = $('#msg');
const result = $('#result');

const PRESETS = {
  'Drift: specific aircraft':
    "-- projected (best) vs real (final) separation + time shift\n"
    + "SELECT lower(icao) icao, flight, body,\n"
    + "  round(best_sep_deg,3) best_proj, round(final_sep_deg,3) final_real,\n"
    + "  round(drift_deg,3) drift, round((actual_at_ms-predicted_at_ms)/1000.0,1) time_shift_s,\n"
    + "  datetime(recorded_at_ms/1000,'unixepoch') at_utc\n"
    + "FROM transit_postmortem\n"
    + "WHERE lower(icao)='4ca8e8' OR upper(flight)='AFP80'\n"
    + "ORDER BY recorded_at_ms DESC LIMIT 20",
  'False fires (armed but drifted wide)':
    "-- projected tight (<0.5°) but real outside the disc (>0.27°): the wasted fires\n"
    + "SELECT lower(icao) icao, body, round(best_sep_deg,3) best_proj,\n"
    + "  round(final_sep_deg,3) final_real, round(drift_deg,3) drift,\n"
    + "  datetime(recorded_at_ms/1000,'unixepoch') at_utc\n"
    + "FROM transit_postmortem\n"
    + "WHERE best_sep_deg < 0.5 AND final_sep_deg > 0.27\n"
    + "ORDER BY drift_deg DESC LIMIT 50",
  'Recent fired arms':
    "SELECT datetime(armed_at_ms/1000,'unixepoch') at_utc, rig, kind, body, icao,\n"
    + "  round(sep_deg,3) sep, round(elev_deg,1) elev, re_arm\n"
    + "FROM capture_arms ORDER BY armed_at_ms DESC LIMIT 50",
  'Transit history: aircraft':
    "SELECT datetime(recorded_at_ms/1000,'unixepoch') at_utc, stage, body, icao, flight,\n"
    + "  round(closest_sep_deg,3) sep, round(last_sep_deg,3) last_sep,\n"
    + "  round(altitude_m) alt_m, round(range_m/1000.0,1) range_km\n"
    + "FROM transit_history WHERE lower(icao)='4ca8e8'\n"
    + "ORDER BY recorded_at_ms DESC LIMIT 30",
  'Tables (schema)':
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
};

const presetsEl = $('#presets');
for (const [label, sql] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', () => { sqlBox.value = sql; run(); });
  presetsEl.appendChild(b);
}
sqlBox.value = PRESETS['Drift: specific aircraft'];   // ready to run

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderTable(body) {
  const { columns = [], rows = [], total, truncated } = body;
  if (!rows.length) { result.innerHTML = '<p class="hint" style="padding:10px">0 rows.</p>'; return; }
  const head = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const trs = rows.map((r) => `<tr>${columns.map((c) => `<td>${escapeHtml(r[c])}</td>`).join('')}</tr>`).join('');
  result.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${trs}</tbody></table>`;
  msg.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'}${truncated ? ` (capped from ${total})` : ''}.`;
  msg.className = '';
}

async function run() {
  msg.textContent = 'Running…';
  msg.className = '';
  try {
    const res = await fetch('/api/diag/sql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: sqlBox.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    renderTable(body);
  } catch (e) {
    result.innerHTML = '';
    msg.textContent = 'Error: ' + (e?.message ?? e);
    msg.className = 'err';
  }
}

$('#run').addEventListener('click', run);
sqlBox.addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); run(); }
});
run();   // auto-run the default drift query on load
