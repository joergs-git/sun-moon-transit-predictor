import {
  buildSketchSvg, buildMiniMapSvg, buildSideViewSvg, fromHistoryRow,
  fromLifecycleEntry, setOptics, SKETCH_GEOMETRY,
} from './sketch.js';
import { resolveAircraftType, designAgePhrase, klassLabel } from './aircraft-types.js';

// Adaptive /api/state cadence (v0.16.0): a relaxed 10 s while nothing is
// near, dropping to a 2 s "time-lapse" pace once the active transit's ETA
// is within ~3 min, held through the ±30 s window and a short tail, then
// back to idle. 2 s is the real data floor (the server polls dump1090 at
// ~2 s), so faster buys nothing; 10 s while idle is *less* load than the
// old fixed 2 s.
const POLL_IDLE_MS = 10_000;
const POLL_FAST_MS = 2_000;
const POLL_FAST_ETA_MS = 180_000;   // |ETA| < 3 min → fast
const POLL_FAST_TAIL_MS = 30_000;   // stay fast until 30 s past closest
const HISTORY_INTERVAL_MS = 15000;
const LEARNING_INTERVAL_MS = 60_000;
// History pager (v0.8.1, narrowed v0.21.1): page 0 = today only (was
// today + yesterday — list grew too long); older entries split into
// fixed-size pages. Fetch a wide window so older pages have rows without
// per-page API calls (server caps /api/history at 500).
const HISTORY_PAGE_SIZE = 50;
const HISTORY_FETCH_LIMIT = 500;

const $ = (sel) => document.querySelector(sel);

// Latest data the renderers saw — kept in module scope so click handlers can
// look up the full entry by row index without re-fetching. Cheaper than
// JSON-stringifying the entry onto a data-* attribute on every render tick.
let lastLifecycle = [];
let lastHistory = [];
let lastVersion = null;   // last server-reported version (for badge restore)
let lastObserver = null;  // {latitudeDeg,longitudeDeg} — for the mini-map
let historyPage = 0;   // 0 = today; ≥1 = older, HISTORY_PAGE_SIZE/page

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

// Live telescope focal length (mm), refreshed from /api/state every poll so
// the disc-crossing sensor speed reflects the current optical setup.
let currentFocalMm = 500;

// Approximate disc-transit kinematics for one history row.
//
// The object's angular rate across the sky is approximated as
//   ω ≈ v_ground / slant_range            [rad/s]
// (i.e. velocity treated as perpendicular to the line of sight near the
// near-overhead transit — deliberately approximate, per the request). From
// that, the time to sweep the FULL Sun/Moon disc is
//   t = disc_diameter° / ω°               [s]
// and the speed of the silhouette on the sensor is
//   v_sensor ≈ focal_mm · ω               [mm/s]   (small-angle)
// Returns null when speed/range are missing (older rows show "—").
function discTransit(row) {
  const v = row.ground_speed_ms;
  const r = row.range_m;
  if (!Number.isFinite(v) || !Number.isFinite(r) || r <= 0 || v <= 0) return null;
  const omegaRad = v / r;                          // rad/s
  const omegaDeg = omegaRad * 180 / Math.PI;       // °/s
  const discDeg = SKETCH_GEOMETRY.BODY_DIAMETER_DEG[row.body] ?? 0.53;
  const sec = discDeg / omegaDeg;                  // full-disc crossing time
  const mmPerSec = currentFocalMm * omegaRad;      // small-angle image speed
  return { sec, omegaDeg, mmPerSec, discDeg };
}
function fmtDiscTransit(dt) {
  if (!dt) return '—';
  return dt.sec >= 10 ? `${dt.sec.toFixed(0)} s` : `${dt.sec.toFixed(2)} s`;
}
function dtTooltip(dt) {
  if (!dt) return 'Disc-crossing time unavailable (no speed/range on this row).';
  return `Approx. time to sweep the full disc. `
    + `ω ${dt.omegaDeg.toFixed(2)}°/s · ${dt.mmPerSec.toFixed(1)} mm/s on sensor `
    + `@ ${Math.round(currentFocalMm)} mm · disc ${dt.discDeg.toFixed(2)}°. `
    + `Approximation: ω ≈ ground speed / slant range.`;
}
function fmtRoute(o, d)   { return o && d ? `${o}→${d}` : (o || d || '—'); }
function fmtTime(ms)      { return new Date(ms).toLocaleTimeString(); }

// Compact weekday + date + time for History rows where the user needs to
// tell entries across multiple days apart. Today's rows collapse to just
// the time so the column stays readable; older rows pick up the prefix.
// Weekday and date are forced to en-GB ("Wed 13 May") regardless of the
// browser locale so the column doesn't switch between languages — the
// rest of the UI is in English anyway.
const TODAY_KEY = () => new Date().toDateString();
function fmtDateTime(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  const time = d.toLocaleTimeString();
  if (d.toDateString() === TODAY_KEY()) return time;
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const dt = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  return `${wd} ${dt} ${time}`;
}

// Rows tighter than NEAR_HIT_DEG get a visual highlight in both Tracking
// and History — the user's "alles unter 0.5 sep ... farblich hervorgehoben".
const NEAR_HIT_DEG = 0.5;
function isNearHit(sepDeg) {
  return Number.isFinite(sepDeg) && sepDeg < NEAR_HIT_DEG;
}

// v0.15.0 visibility traffic-light — aircraft elevation above the horizon
// at closest approach. Below ~30° a target is barely usable (long hazy,
// turbulent slant path, horizon clouds); 30–45° workable; ≥45° ideal. Same
// 30° default as the Pushover gate (pushover.minElevationDeg).
const VIS_AMBER_DEG = 30;
const VIS_GREEN_DEG = 45;
// Real Sun/Moon disc-overlap proxy (matches store.js rangeStats onDisc).
const DISC_DEG = 0.27;

function visInfo(elDeg) {
  if (!Number.isFinite(elDeg)) return null;
  if (elDeg >= VIS_GREEN_DEG) return { cls: 'vis-green', word: 'ideal' };
  if (elDeg >= VIS_AMBER_DEG) return { cls: 'vis-amber', word: 'workable' };
  return { cls: 'vis-red', word: 'poor' };
}
// One leftmost <td> for both tables. Neutral dot when elevation is unknown
// (e.g. ISS visible-pass entries without an aircraftAtClosest sample).
function visCell(elDeg) {
  const v = visInfo(elDeg);
  if (!v) {
    return '<td class="td-icon vis-cell" title="elevation at closest approach unknown">'
      + '<span class="vis-dot vis-unknown">·</span></td>';
  }
  const t = `${elDeg.toFixed(0)}° elevation — visibility ${v.word} `
    + `(red <${VIS_AMBER_DEG}° · amber ${VIS_AMBER_DEG}–${VIS_GREEN_DEG}° · green ≥${VIS_GREEN_DEG}°)`;
  return `<td class="td-icon vis-cell" title="${t}"><span class="vis-dot ${v.cls}">●</span></td>`;
}

// Unified row highlight (v0.15.0). GREEN only = a *real* Sun/Moon disc
// overlap that actually happened; YELLOW = a near miss ("almost"); else
// neutral. Replaces the old magenta(Tracking)/green(History) near-hit split.
function historyRowQuality(e) {
  const sep = e.closest_sep_deg;
  if (e.outcome === 'confirmed' && e.sepConfirmed === true
      && Number.isFinite(sep) && sep < DISC_DEG) return ' q-green';
  if (isNearHit(sep)) return ' q-amber';
  return '';
}
function liveRowQuality(e) {
  const sep = e.closestApproachSepDeg;
  if (e.status === 'imminent' && Number.isFinite(sep) && sep < DISC_DEG) return ' q-green';
  if (isNearHit(sep)) return ' q-amber';
  return '';
}

// Inner HTML for the ICAO (airframe-hex) table cell. A valid 6-hex code is
// turned into a direct adsbexchange "globe" link — that site has global
// search + history/playback and keeps blocked airframes, so it resolves
// these brief long-range transits when AirNav/SkyAware can't (see the
// troubleshooting note). ISS → "orbit"; a missing / partially-decoded
// (non-6-hex) value is shown as plain text, no misleading link.
function icaoCellInner(icao, iss) {
  if (iss) return 'orbit';
  const raw = String(icao ?? '').trim();
  if (!raw) return '—';
  const up = raw.toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(up)) return up;            // e.g. weak-signal partial
  return `<a class="hex-link" href="https://globe.adsbexchange.com/?icao=${up.toLowerCase()}" `
    + `target="_blank" rel="noopener noreferrer" `
    + `title="Open airframe ${up} on adsbexchange globe — global search + history, keeps blocked aircraft">`
    + `${up}</a>`;
}

// Stats bar label (v0.20.1). Returns an <a> that
//   - links to adsbexchange globe (ICAO hex or callsign — same lookup the
//     History/Live tables use, so users get history/playback for the very
//     airframe or flight they clicked in the stats panel)
//   - keeps .flight-cell + data-hex / data-cs so the existing hover popover
//     (AirNav photo / adsbdb route) still fires
//   - degrades to a plain <span> when the value isn't a usable hex/callsign
//     (e.g. a partial code) so we never link to junk.
function statsLabelLink(key, kind, tooltip) {
  const raw = String(key ?? '').trim();
  if (!raw) return '<span class="acstats-label">—</span>';
  const up = raw.toUpperCase();
  const tip = tooltip ? ` ${tooltip}` : '';
  if (kind === 'icao' && /^[0-9A-F]{6}$/.test(up)) {
    const lo = up.toLowerCase();
    return `<a class="acstats-label flight-cell hex-link" `
      + `href="https://globe.adsbexchange.com/?icao=${lo}" `
      + `target="_blank" rel="noopener noreferrer" data-hex="${lo}" `
      + `title="ICAO ${up} → adsbexchange globe (history/playback). Hover for the airframe (AirNav).${tip}">`
      + `${up}</a>`;
  }
  if (kind === 'flight' && /^[A-Z0-9]{2,10}$/.test(up)) {
    return `<a class="acstats-label flight-cell hex-link" `
      + `href="https://globe.adsbexchange.com/?callsign=${encodeURIComponent(up)}" `
      + `target="_blank" rel="noopener noreferrer" data-cs="${up}" `
      + `title="Callsign ${up} → adsbexchange globe (by callsign). Hover for the route (adsbdb, free).${tip}">`
      + `${up}</a>`;
  }
  // Unusable key — render the value with the popover hooks but no link.
  const attr = kind === 'icao' ? `data-hex="${up.toLowerCase()}"` : `data-cs="${up}"`;
  return `<span class="acstats-label flight-cell" ${attr} title="${tip.trim()}">${up}</span>`;
}

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
    // If BOTH bodies are below the 20° observability floor the tracker
    // returns nothing no matter how much ADS-B traffic there is — make that
    // explicit so an empty panel isn't mistaken for a fault (SkyAware will
    // still be showing aircraft). Otherwise it's just "no flight on the
    // Sun/Moon line right now", which is the normal idle state.
    const bodies = state.bodies ?? {};
    const names = Object.keys(bodies);
    const anyObservable = names.some((n) => bodies[n]?.observable);
    if (names.length && !anyObservable) {
      const lo = names.join(' & ');
      tbody.innerHTML =
        `<tr class="empty"><td colspan="12" class="no-bodies">`
        + `☀🌙 ${lo} below the observable limit (&lt; 20° elevation).`
        + `<br>No transit candidates can occur until one rises — ADS-B traffic`
        + ` elsewhere is expected and not tracked.</td></tr>`;
    } else {
      tbody.innerHTML =
        '<tr class="empty"><td colspan="12">Tracking list empty — no aircraft'
        + ' currently projected onto the Sun/Moon line.</td></tr>';
    }
    return;
  }
  for (const [i, e] of rows.entries()) {
    const tr = document.createElement('tr');
    const iss = e.isISS === true || e.icao === 'ISS';
    tr.className = `row-${e.status} sketchable${liveRowQuality(e)}${iss ? ' row-iss' : ''}`;
    tr.dataset.source = 'live';
    tr.dataset.index = String(i);
    const baseMeta = STATUS_LABELS[e.status] ?? { icon: '', label: e.status };
    // ISS rows never show the ✈️ (candidate) glyph — that confuses users
    // into thinking it's an aircraft. Use the 🛰 satellite symbol for the
    // status icon regardless of stage; the label text still says the stage.
    const meta = iss ? { icon: '🛰', label: baseMeta.label } : baseMeta;
    const eta = e.etaMs > 0 ? fmtCountdownLong(e.etaMs)
              : Math.abs(e.etaMs) < 60_000 ? 'now'
              : `−${fmtCountdownLong(-e.etaMs)}`;
    const ac = e.candidate?.aircraft;
    const route = e.route ?? e.candidate?.route;
    const rangeM = e.candidate?.aircraftAtClosest?.rangeM ?? null;
    const bodyIcon = e.body === 'Sun' ? '☀' : '🌙';
    const elDeg = e.candidate?.aircraftAtClosest?.elevationDeg;
    tr.innerHTML = `
      ${visCell(elDeg)}
      <td class="body-${e.body} td-icon" title="${e.body}">${bodyIcon}</td>
      <td><span class="status status-${e.status}" title="${meta.label}">${meta.icon} ${meta.label}</span></td>
      <td>${eta}</td>
      <td>${fmtTime(e.closestApproachAtMs)}</td>
      <td>${e.closestApproachSepDeg !== null ? fmtSep(e.closestApproachSepDeg) : '—'}</td>
      <td>${fmtDistance(rangeM)}</td>
      <td>${iss ? '—' : fmtSpeed(ac?.groundSpeedMs)}</td>
      <td>${iss ? 'LEO' : fmtAlt(ac?.altMmsl)}</td>
      <td class="flight-cell" data-hex="${e.icao ?? ''}" data-cs="${e.callsign ?? e.flight ?? ''}">${iss ? '🛰 ISS' : (e.flight ?? e.callsign ?? '—')}</td>
      <td>${icaoCellInner(e.icao, iss)}</td>
      <td>${iss ? '—' : fmtRoute(route?.origin?.iata ?? route?.origin?.icao, route?.destination?.iata ?? route?.destination?.icao)}</td>
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

const OUTCOME_LABELS = {
  confirmed: { icon: '✅', label: 'confirmed', title: 'Reached the imminent ±30 s window — the close approach actually happened. The sep is from that real closest approach.' },
  predicted: { icon: '⚠️', label: 'predicted', title: 'A tight pass was PREDICTED but never reached the imminent confirmation — the flight diverged / left the band before the ETA (this is the "stale in Live tracking" case). The sep shown is the prediction, struck through, not what actually happened.' },
  faded:     { icon: '➖', label: 'faded',     title: 'Only the early radio stage fired — never tightened to a candidate.' },
};

// Lead time = how much advance warning the pipeline gave (transit − first
// recorded). Big lead is what the user wants; small lead means the radio /
// candidate stages only fired late in the approach.
function fmtLead(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h}h${r ? ` ${r}m` : ''}`;
}

// Midnight at the start of *today* (local) — the inclusive lower bound
// for what counts as "today" on history page 1. Was "today + yesterday"
// pre-v0.21.1; trimmed to today only so the on-screen list stays short.
function recentCutoffMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Build one history row. `absIdx` is the index into `lastHistory` (NOT the
// paginated slice) so the click→pin handler keeps resolving correctly.
function historyTr(e, absIdx) {
  const tr = document.createElement('tr');
  const iss = e.icao === 'ISS';
  tr.className = `sketchable${historyRowQuality(e)}${iss ? ' row-iss' : ''}`;
  tr.dataset.source = 'history';
  tr.dataset.index = String(absIdx);
  const oc = e.outcome ? OUTCOME_LABELS[e.outcome] : null;
  const outcomeCell = oc
    ? `<span class="outcome outcome-${e.outcome}" title="${oc.title}">${oc.icon} ${oc.label}</span>`
    : '<span class="outcome outcome-none" title="Episode not yet classified — still in flight, or the window has no companion stages to compare against.">—</span>';
  // leadTimeMs is set by the server's consolidated view; fall back to
  // computing it ourselves so a partial response still renders cleanly.
  const leadMs = Number.isFinite(e.leadTimeMs)
    ? e.leadTimeMs
    : (e.closest_at_ms - e.recorded_at_ms);
  const dt = discTransit(e);
  const bodyIcon = e.body === 'Sun' ? '☀' : '🌙';
  const elDeg = e.payload?.candidate?.aircraftAtClosest?.elevationDeg;
  tr.innerHTML = `
    ${visCell(elDeg)}
    <td class="body-${e.body} td-icon" title="${e.body}">${bodyIcon}</td>
    <td class="stage-${e.stage}">${fmtDateTime(e.closest_at_ms)}</td>
    <td>${fmtDateTime(e.recorded_at_ms)}</td>
    <td title="Lead time = ${leadMs} ms">${fmtLead(leadMs)}</td>
    <td><span class="${e.sepConfirmed ? 'sep-confirmed' : 'sep-unconfirmed'}" title="${e.sepConfirmed
      ? 'Sep at the real closest approach (imminent stage).'
      : 'PREDICTED sep only — no imminent confirmation; the flight diverged before the ETA, so this never actually happened.'}">${fmtSep(e.closest_sep_deg)}</span></td>
    <td class="stage-${e.stage}">${e.stage}</td>
    <td>${outcomeCell}</td>
    <td>${fmtDistance(e.range_m)}</td>
    <td title="${dtTooltip(dt)}">${fmtDiscTransit(dt)}</td>
    <td>${iss ? '—' : fmtSpeed(e.ground_speed_ms)}</td>
    <td>${iss ? 'LEO' : fmtAlt(e.altitude_m)}</td>
    <td class="flight-cell" data-hex="${e.icao ?? ''}" data-cs="${e.callsign ?? e.flight ?? ''}">${iss ? '🛰 ISS' : (e.flight ?? e.callsign ?? '')}</td>
    <td>${icaoCellInner(e.icao, iss)}</td>
    <td>${iss ? '—' : fmtRoute(e.origin, e.destination)}</td>
  `;
  return tr;
}

// Paginated render. Page 0 shows everything from today (local midnight on);
// older episodes are chunked into HISTORY_PAGE_SIZE pages. Pure client-side over
// the rows already fetched — navigating pages never hits the API, and the
// 15 s poll keeps the current page (clamped if the data shrank).
function renderHistory(events) {
  const tbody = $('#history tbody');
  const pager = $('#history-pager');
  tbody.innerHTML = '';
  lastHistory = events ?? [];
  if (!lastHistory.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="15">No history yet.</td></tr>';
    if (pager) pager.hidden = true;
    return;
  }

  const cutoff = recentCutoffMs();
  const recent = [];
  const older = [];
  lastHistory.forEach((e, i) => {
    const t = e.closest_at_ms ?? e.recorded_at_ms;
    (Number.isFinite(t) && t >= cutoff ? recent : older).push([i, e]);
  });

  const olderPages = Math.ceil(older.length / HISTORY_PAGE_SIZE);
  const totalPages = 1 + olderPages;            // page 0 always exists
  historyPage = Math.min(Math.max(0, historyPage), totalPages - 1);

  let slice;
  let label;
  if (historyPage === 0) {
    slice = recent;
    label = 'today';
  } else {
    const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
    slice = older.slice(start, start + HISTORY_PAGE_SIZE);
    label = 'older';
  }

  if (slice.length === 0) {
    tbody.innerHTML =
      '<tr class="empty"><td colspan="15">Nothing recorded today yet — use “Older ▶”.</td></tr>';
  } else {
    for (const [absIdx, e] of slice) tbody.appendChild(historyTr(e, absIdx));
  }

  if (pager) {
    if (totalPages <= 1) {
      pager.hidden = true;
    } else {
      pager.hidden = false;
      $('#hp-info').textContent = `${historyPage + 1} / ${totalPages} · ${label}`;
      $('#hp-newer').disabled = historyPage === 0;
      $('#hp-older').disabled = historyPage >= totalPages - 1;
    }
  }
}

function gotoHistoryPage(delta) {
  historyPage += delta;
  renderHistory(lastHistory);   // re-render in place; no refetch
  highlightPinnedRow();         // repaint wipes the pinned marker
}

// Detection funnel bar chart (v0.8.0). Three bars, all scaled to the total
// so the eye reads the drop-off "everything seen → projected near the line →
// actually grazed". Counts are session-cumulative (the card title says so).
function renderDetectFunnel(stats) {
  const box = $('#detect-funnel');
  if (!box || !stats) return;
  const total = stats.totalUnique ?? 0;
  const pct = (n) => (total > 0 ? Math.min(100, Math.max(2, Math.round((n / total) * 100))) : 0);
  $('#fb-total').style.width = total > 0 ? '100%' : '0%';
  $('#fb-live').style.width  = `${pct(stats.liveCount ?? 0)}%`;
  $('#fb-band').style.width  = `${pct(stats.inBand ?? 0)}%`;
  $('#fb-near').style.width  = `${pct(stats.near ?? 0)}%`;
  $('#fb-vnear').style.width = `${pct(stats.veryNear ?? 0)}%`;
  $('#fv-total').textContent = String(total);
  $('#fv-live').textContent  = String(stats.liveCount ?? 0);
  $('#fv-band').textContent  = String(stats.inBand ?? 0);
  $('#fv-near').textContent  = String(stats.near ?? 0);
  $('#fv-vnear').textContent = String(stats.veryNear ?? 0);
  // Label the middle bar with the live panel band (defaults 2°, but the
  // user can widen/narrow it in Settings).
  const band = Number.isFinite(stats.bandDeg) ? stats.bandDeg : 2;
  $('#fl-band').innerHTML = `&lt; ${band}°`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function azToCompass(deg) {
  return COMPASS[Math.round(((deg % 360) / 45)) % 8];
}

// "When", with an absolute date for anything past today/tomorrow so a pass
// or transit weeks out is unambiguous ("in 24d · Wed 18 Jun 21:43").
function fmtWhenAbs(ms) {
  const inMs = ms - Date.now();
  if (inMs <= 0) return 'now';
  return `in ${fmtCountdownLong(inMs)} · ${fmtDateTime(ms)}`;
}

// Two ISS lines under the Sky-now table: the next naked-eye visible pass
// and the next Sun/Moon disc transit — both shown even if weeks away.
// The whole block hides only when the ISS feature is inactive (no TLE).
function renderIssPass(iss) {
  const el = $('#iss-pass');
  if (!el) return;
  if (!iss?.active) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;

  const p = iss.visiblePass;
  const visLine = p
    ? `🛰 <b>Next visible ISS pass</b> ${fmtWhenAbs(p.startMs)}: `
      + `${fmtTime(p.startMs)} (${azToCompass(p.startAzDeg)}) → `
      + `${fmtTime(p.endMs)} (${azToCompass(p.endAzDeg)}) · `
      + `max ${p.maxElevationDeg}° · ${p.durationS}s`
    : '🛰 <b>Next visible ISS pass</b>: none predicted in the scan window.';

  const t = iss.nextTransit;
  const tLine = t
    ? `☀🌙 <b>Next ISS ${t.body} transit</b> ${fmtWhenAbs(t.atMs)} · `
      + `sep ${fmtSep(t.sepDeg)}`
      + (t.tentative
        ? ` <span class="iss-tentative">— tentative (&gt; ${iss.notifyWithinDays ?? 3} d out:`
          + ` refines with each daily TLE; no alert until closer)</span>`
        : '')
    : `☀🌙 <b>Next ISS Sun/Moon transit</b>: none in the next `
      + `${iss.horizonDays ?? '—'} days (raise <code>iss.horizonMs</code> to look further).`;

  el.innerHTML = `<div>${visLine}</div><div class="iss-pass-2">${tLine}</div>`;
  el.title = 'Visible pass = ISS above 20°, sky dark (Sun below −6°), '
    + 'station sunlit. Transit = ISS crossing the Sun/Moon disc for this '
    + 'site. Both are offline SGP4 predictions; refresh with the TLE.';
}

async function pollState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(res.status);
    const state = await res.json();
    renderSky(state);
    renderIssPass(state.iss);
    renderTracking(state);
    renderDetectFunnel(state.detectStats);
    // Push live optics into the FOV sketch module so a Settings edit is
    // reflected on the next render of the inline preview pane.
    if (state.optics) {
      setOptics(state.optics);
      if (Number.isFinite(state.optics.telescopeFocalMm)) {
        currentFocalMm = state.optics.telescopeFocalMm;
      }
    }
    // The preview pane needs the latest lifecycle on every tick — both to
    // pick a fresh auto entry and to refresh the pinned row's highlight.
    refreshFovPane();
    const status = $('#status');
    const age = Math.round((Date.now() - state.lastUpdateMs) / 1000);
    status.textContent = `live · ${age}s ago · ${state.aircraftCount ?? 0} aircraft`;
    status.className = age > 10 ? 'status stale' : 'status live';
    if (state.version) lastVersion = state.version;
    // renderUpdateStatus authoritatively owns the badge for every state
    // (incl. restoring the version on idle/stuck). Old servers without the
    // diagnostic: just show the version.
    if (state.update) renderUpdateStatus(state.update);
    else setBadgeVersion();
    if (state.observer) {
      lastObserver = state.observer;
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

// dump1090-fa always serves its status page on :8080 of the same host that
// runs this service, so the header link is simply derived from the current
// host — no config, no override (that knob was removed in v0.15.2; the
// configurable URL is now the Pushover notification link instead).
function applyDump1090Link() {
  const a = $('#dump1090-link');
  if (!a) return;
  a.href = `${window.location.protocol}//${window.location.hostname}:8080/`;
}

async function pollHistory() {
  try {
    const res = await fetch(`/api/history?limit=${HISTORY_FETCH_LIMIT}`);
    if (!res.ok) return;
    const { events } = await res.json();
    renderHistory(events);
    // History repaint wipes the pinned-row marker class — re-apply.
    highlightPinnedRow();
  } catch { /* ignore */ }
}

// Alert-learning panel: lightweight rolling stats. Polled on a slow cadence
// (default 60 s) because episodes change at the rate of new Pushovers — i.e.
// rarely. The window matches the predictor's daysBack default of 14.
function fmtPct(n) { return n == null ? '—' : `${n.toFixed(0)}%`; }

// Persistent aircraft-sightings stats: TOP-20 horizontal bars per kind.
// ICAO labels are hover-enabled (.flight-cell + data-hex) so the AirNav
// popover resolves the hex to a real aircraft + photo; callsign labels
// carry an explanatory tooltip (no hex → can't resolve to AirNav).
const ACSTATS_TOP = 20;
function renderAcstatsBars(elId, rows, kind) {
  const box = $(elId);
  if (!box) return;
  const top = (rows ?? []).slice(0, ACSTATS_TOP);
  if (top.length === 0) {
    box.innerHTML = '<div class="acstats-empty">No traffic recorded yet.</div>';
    return;
  }
  const max = top[0].visits || 1;
  box.innerHTML = top.map((r) => {
    const pct = Math.max(3, Math.round((r.visits / max) * 100));
    const seen = `${r.visits} visit${r.visits === 1 ? '' : 's'} · first ${fmtDateTime(r.firstSeenMs)} · last ${fmtDateTime(r.lastSeenMs)}`;
    const labelEl = statsLabelLink(r.key || '?', kind, seen);
    return `<div class="acstats-row" title="${seen}">`
      + labelEl
      + `<span class="acstats-track"><span class="acstats-bar" style="width:${pct}%"></span></span>`
      + `<span class="acstats-val">${r.visits}</span></div>`;
  }).join('');
}

async function pollAcstats() {
  try {
    const res = await fetch(`/api/acstats?limit=${ACSTATS_TOP}`);
    if (!res.ok) return;
    const d = await res.json();
    renderAcstatsBars('#acstats-icao', d.icao, 'icao');
    renderAcstatsBars('#acstats-flight', d.flight, 'flight');
    const t = d.totals ?? {};
    const fmtT = (x) => `${x?.distinctKeys ?? 0} unique · ${x?.totalVisits ?? 0} visits`;
    const a = $('#acstats-icao-tot');
    const b = $('#acstats-flight-tot');
    if (a) a.textContent = fmtT(t.icao);
    if (b) b.textContent = fmtT(t.flight);
  } catch { /* ignore */ }
}

// Second Aircraft-stats list: REAL usable transit candidates — aircraft
// that actually transited (imminent-confirmed) while ≥ the elevation gate
// (default 30°), so they were high enough to be worth a telescope. Reuses
// the acstats bar markup + the flight-cell hover (AirNav / free route).
function renderUsableBars(elId, rows, kind) {
  const box = $(elId);
  if (!box) return;
  const top = (rows ?? []).slice(0, ACSTATS_TOP);
  if (top.length === 0) {
    box.innerHTML = '<div class="acstats-empty">No usable transits recorded yet '
      + '(none confirmed above the elevation gate).</div>';
    return;
  }
  const max = top[0].visits || 1;
  box.innerHTML = top.map((r) => {
    const pct = Math.max(3, Math.round((r.visits / max) * 100));
    const el = Number.isFinite(r.bestElevationDeg) ? `${r.bestElevationDeg.toFixed(0)}°` : '—';
    const sp = Number.isFinite(r.minSepDeg) ? fmtSep(r.minSepDeg) : '—';
    const seen = `${r.visits} usable transit${r.visits === 1 ? '' : 's'} · `
      + `best elevation ${el} · tightest sep ${sp}`;
    const labelEl = statsLabelLink(r.key || '?', kind, seen);
    return `<div class="acstats-row" title="${seen}">`
      + labelEl
      + `<span class="acstats-track"><span class="acstats-bar" style="width:${pct}%"></span></span>`
      + `<span class="acstats-val">${r.visits}</span></div>`;
  }).join('');
}

async function pollUsable() {
  try {
    const res = await fetch(`/api/usable?minElevationDeg=${VIS_AMBER_DEG}&limit=${ACSTATS_TOP}`);
    if (!res.ok) return;
    const d = await res.json();
    renderUsableBars('#usable-icao', d.byIcao, 'icao');
    renderUsableBars('#usable-flight', d.byFlight, 'flight');
    const el = $('#usable-tot');
    if (el) {
      el.textContent = `${d.n ?? 0} usable transit${(d.n ?? 0) === 1 ? '' : 's'} `
        + `· elevation ≥ ${d.minElevationDeg ?? VIS_AMBER_DEG}°`;
    }
  } catch { /* ignore */ }
}

// Retrospective range stats: how far were the aircraft that actually
// passed < sepDeg. Distances in km; histogram reuses the acstats bars.
function kmOf(m) { return m == null ? '—' : `${(m / 1000).toFixed(1)} km`; }
async function pollRangestats() {
  try {
    const res = await fetch('/api/rangestats?sepDeg=0.5');
    if (!res.ok) return;
    const d = await res.json();
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#rs-sep', `${(d.sepBelowDeg ?? 0.5)}°`);
    set('#rs-n', String(d.n ?? 0));
    set('#rs-median', kmOf(d.medianM));
    set('#rs-max', kmOf(d.maxM));
    set('#rs-min', kmOf(d.minM));
    set('#rs-p90', kmOf(d.p90M));
    set('#rs-ondisc', String(d.onDisc ?? 0));
    const box = $('#rs-hist');
    if (box) {
      const h = d.histogram ?? [];
      if (!h.length || !d.n) {
        box.innerHTML = '<div class="acstats-empty">No imminent-confirmed &lt; 0.5° passes recorded yet.</div>';
      } else {
        const max = Math.max(...h.map(b => b.count), 1);
        box.innerHTML = h.map((b) => {
          const pct = b.count ? Math.max(3, Math.round((b.count / max) * 100)) : 0;
          const label = `${(b.fromM / 1000).toFixed(0)}–${(b.toM / 1000).toFixed(0)} km`;
          return `<div class="acstats-row" title="${b.count} pass(es) at ${label}">`
            + `<span class="acstats-label">${label}</span>`
            + `<span class="acstats-track"><span class="acstats-bar" style="width:${pct}%"></span></span>`
            + `<span class="acstats-val">${b.count}</span></div>`;
        }).join('');
      }
    }
  } catch { /* ignore */ }
}

// Best-hours stat: a 24-bin hour-of-day histogram of the usable hits
// (imminent-confirmed, sep < 0.5°, elevation ≥ the gate), split per body
// in observatory-local time. Reuses the acstats horizontal-bar markup; the
// peak hour for the column is emphasised so the best window pops out.
function renderHourBars(elId, counts, peak) {
  const box = $(elId);
  if (!box) return;
  const arr = Array.isArray(counts) ? counts : [];
  const sum = arr.reduce((a, b) => a + b, 0);
  if (!sum) {
    box.innerHTML = '<div class="acstats-empty">No usable hits recorded yet '
      + 'for this body.</div>';
    return;
  }
  const max = Math.max(...arr, 1);
  box.innerHTML = arr.map((c, h) => {
    const pct = c ? Math.max(3, Math.round((c / max) * 100)) : 0;
    const label = `${String(h).padStart(2, '0')}h`;
    const isPeak = peak && peak.count > 0 && peak.hour === h;
    const cls = `acstats-row${isPeak ? ' acstats-row-peak' : ''}`;
    const tip = `${c} usable hit${c === 1 ? '' : 's'} at ${label}${isPeak ? ' · peak' : ''}`;
    return `<div class="${cls}" title="${tip}">`
      + `<span class="acstats-label">${label}</span>`
      + `<span class="acstats-track"><span class="acstats-bar" style="width:${pct}%"></span></span>`
      + `<span class="acstats-val">${c}</span></div>`;
  }).join('');
}

function fmtPeakHour(p) {
  if (!p || !p.count) return '—';
  return `${String(p.hour).padStart(2, '0')}h`;
}

async function pollHourstats() {
  try {
    const res = await fetch(`/api/hourstats?sepDeg=0.5&minElevationDeg=${VIS_AMBER_DEG}`);
    if (!res.ok) return;
    const d = await res.json();
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#hs-sep', `${d.sepBelowDeg ?? 0.5}°`);
    set('#hs-el', `${d.minElevationDeg ?? VIS_AMBER_DEG}°`);
    set('#hs-n', String(d.n ?? 0));
    const peak = d.peak ?? {};
    set('#hs-peak-sun', fmtPeakHour(peak.Sun));
    set('#hs-peak-moon', fmtPeakHour(peak.Moon));
    set('#hs-peak-all', fmtPeakHour(peak.all));
    const sunC = d.perBody?.Sun ?? [];
    const moonC = d.perBody?.Moon ?? [];
    const sunSum = sunC.reduce((a, b) => a + b, 0);
    const moonSum = moonC.reduce((a, b) => a + b, 0);
    set('#hs-sun-tot', `${sunSum} hit${sunSum === 1 ? '' : 's'}`);
    set('#hs-moon-tot', `${moonSum} hit${moonSum === 1 ? '' : 's'}`);
    renderHourBars('#hs-sun', sunC, peak.Sun);
    renderHourBars('#hs-moon', moonC, peak.Moon);
  } catch { /* ignore */ }
}

async function pollLearning() {
  try {
    const res = await fetch('/api/learning?windowDays=14');
    if (!res.ok) return;
    const { aggregates: a, windowDays } = await res.json();
    // Graze rate: of all detected aircraft, the share that actually
    // crossed each body's disc (sep < grazeThresholdDeg, default 0.3°).
    $('#learn-graze-sun').textContent  = fmtPct(a.sunGrazePct);
    $('#learn-graze-moon').textContent = fmtPct(a.moonGrazePct);
    $('#learn-graze-detail').textContent =
      `${(a.sunGrazes ?? 0) + (a.moonGrazes ?? 0)} / ${a.totalEpisodes ?? 0} detected · sep < ${
        a.grazeThresholdDeg != null ? a.grazeThresholdDeg.toFixed(2) : '0.30'
      }°`;

    const hit = $('#learn-hit');
    hit.querySelector('.learn-num').textContent = fmtPct(a.hitRatePct);
    hit.querySelector('.learn-detail').textContent =
      `${a.radioGraduated} / ${a.radioFired} radios`;

    const sur = $('#learn-surprise');
    sur.querySelector('.learn-num').textContent = fmtPct(a.surpriseRatePct);
    sur.querySelector('.learn-detail').textContent =
      `${a.surprises} / ${a.candidateOrImminent} transits`;

    const ep = $('#learn-episodes');
    ep.querySelector('.learn-num').textContent = String(a.totalEpisodes);
    ep.querySelector('.learn-detail').textContent = `in last ${windowDays} days`;
  } catch { /* ignore */ }
}

// Local wall-clock readout in the header. Self-correcting (re-reads
// Date.now() every tick) so a sleeping tab doesn't drift.
function tickClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleTimeString();
}

// ---- FOV preview pane --------------------------------------------------------
// Single-slot panel in the sky row. The pane decides what to show on every
// state poll:
//   * Auto mode: pick the newest live lifecycle entry whose minimum
//     separation is under FOV_NEAR_DEG and that carries usable geometry.
//     "Newest" = highest firstSeenMs.
//   * Pinned mode: the user clicked a row → that row stays on screen until
//     a live candidate with a *later* firstSeenMs (and sep < FOV_NEAR_DEG)
//     comes in, at which point the pin is released and auto resumes.
// Replacing the row click handler keeps the table interaction familiar but
// removes the modal entirely.
const FOV_NEAR_DEG = 1.0;

const fovBody = $('#fov-body');
const fovMode = $('#fov-mode');
const fovHint = $('#fov-hint');

/** @type {{ key: string, firstSeenMs: number, input: object, label: string } | null} */
let pin = null;

function entryHasGeometry(entry) {
  const c = entry?.candidate;
  return Boolean(c?.aircraftAtClosest && c?.bodyAtClosest);
}

function isQualifyingLifecycle(entry) {
  // "close enough for an intersection" → angular separation strictly under
  // FOV_NEAR_DEG, AND we actually have geometry to render. Stale entries
  // can still qualify so the user gets a last-known view of a fly-by that
  // already happened, as long as the geometry is intact.
  if (!entry) return false;
  if (!Number.isFinite(entry.closestApproachSepDeg)) return false;
  if (entry.closestApproachSepDeg >= FOV_NEAR_DEG) return false;
  return entryHasGeometry(entry);
}

// Visibility band of an entry (3=green ≥45°, 2=amber 30–45°, 1=red, 0=?) —
// same thresholds as the row dot / side view / notify gate.
function visScore(entry) {
  const el = entry?.candidate?.aircraftAtClosest?.elevationDeg;
  if (!Number.isFinite(el)) return 0;
  if (el >= 45) return 3;
  if (el >= 30) return 2;
  return 1;
}

// Lexicographic compare of two numeric score tuples (higher wins).
function cmpScore(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function pickAutoEntry(lifecycle) {
  // "Best" candidate = most worth pointing a scope at right now (v0.16.0,
  // user-chosen priority): imminent first, then best visibility band, then
  // tightest separation, tiebreak nearest |ETA|. Replaces the old
  // "newest firstSeenMs" rule.
  let best = null;
  let bestScore = null;
  for (const e of lifecycle) {
    if (!isQualifyingLifecycle(e)) continue;
    const score = [
      e.status === 'imminent' ? 1 : 0,
      visScore(e),
      -(Number.isFinite(e.closestApproachSepDeg) ? e.closestApproachSepDeg : 99),
      -(Number.isFinite(e.etaMs) ? Math.abs(e.etaMs) : 9e15),
    ];
    if (!best || cmpScore(score, bestScore) > 0) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

function renderFovEmpty(message) {
  fovBody.innerHTML = `<p class="fov-placeholder">${message}</p>`;
  fovMode.textContent = 'auto';
  fovMode.classList.remove('pinned');
  fovMode.title = 'auto = newest live candidate with sep < 1°. No candidate currently qualifies.';
}

function renderFovSketch(input, { pinned, label }) {
  // Stamp the current time on every render so buildSketchSvg can place the
  // moving "now" marker along the predicted path — the time-lapse feel.
  // obsLat feeds the parallactic celestial N/E rose.
  fovBody.innerHTML = buildSketchSvg({
    ...input, nowMs: Date.now(), obsLat: lastObserver?.latitudeDeg ?? null,
  });
  fovMode.textContent = pinned ? 'pinned' : 'auto';
  fovMode.classList.toggle('pinned', pinned);
  fovMode.title = pinned
    ? `pinned to ${label} — click another row to switch, or wait for a newer candidate (sep < 1°) to take over.`
    : `auto: ${label}. Click any row to pin a specific entry.`;
}

function highlightPinnedRow() {
  // The pinned row gets a colored bar on the left — drawn after each render
  // because the table is rebuilt on every poll tick.
  for (const tr of document.querySelectorAll('tr.fov-pinned')) tr.classList.remove('fov-pinned');
  if (!pin) return;
  // Live lifecycle rows match by lifecycle key — stable across ticks.
  for (const tr of document.querySelectorAll('tr.sketchable[data-source="live"]')) {
    const idx = Number(tr.dataset.index);
    if (lastLifecycle[idx]?.key === pin.key) { tr.classList.add('fov-pinned'); return; }
  }
  // History rows fall back to (icao, closest_at_ms) — both columns are
  // already on the row's underlying record.
  if (pin.key.startsWith('history:')) {
    for (const tr of document.querySelectorAll('tr.sketchable[data-source="history"]')) {
      const idx = Number(tr.dataset.index);
      const row = lastHistory[idx];
      if (!row) continue;
      if (`history:${row.icao}|${row.body}|${row.closest_at_ms}` === pin.key) {
        tr.classList.add('fov-pinned');
        return;
      }
    }
  }
}

function describeEntry(entry) {
  const flight = entry.flight ?? entry.callsign ?? entry.icao ?? '—';
  const sep = Number.isFinite(entry.closestApproachSepDeg)
    ? `${(entry.closestApproachSepDeg * 60).toFixed(1)}'`
    : '—';
  return `${entry.body} · ${flight} · sep ${sep}`;
}

// ---- Airframe spec block (E) ------------------------------------------------
// The ADS-B `t`/`r`/`desc` fields ride along on candidate.aircraft (live) or
// payload.candidate.aircraft (history). We only need the identifying bits;
// web/aircraft-types.js turns the ICAO type code into nominal dimensions
// offline (no network, no photos).
function acGeo(a, isISS) {
  // Aircraft lat/lon/track for the offline mini-map. Not meaningful for the
  // ISS (orbital) — the map is suppressed there.
  if (isISS || !a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return {};
  return {
    lat: a.lat, lon: a.lon,
    trackDeg: Number.isFinite(a.trackDeg) ? a.trackDeg : null,
  };
}
function acMetaFromLifecycle(entry) {
  const a = entry?.candidate?.aircraft;
  if (!a) return null;
  const route = entry.route ?? entry.candidate?.route ?? null;
  return {
    typeCode: a.typeCode ?? null, registration: a.registration ?? null,
    typeDesc: a.typeDesc ?? null, icao: entry.icao ?? a.icao ?? null,
    rangeM: entry?.candidate?.aircraftAtClosest?.rangeM ?? null,
    elevationDeg: entry?.candidate?.aircraftAtClosest?.elevationDeg ?? null,
    isISS: entry.isISS === true || entry.icao === 'ISS',
    flight: entry.flight ?? entry.callsign ?? route?.flight ?? null,
    origin: route?.origin?.iata ?? route?.origin?.icao ?? null,
    destination: route?.destination?.iata ?? route?.destination?.icao ?? null,
    ...acGeo(a, entry.isISS === true || entry.icao === 'ISS'),
  };
}
function acMetaFromHistory(row) {
  const a = row?.payload?.candidate?.aircraft;
  const iss = row?.icao === 'ISS';
  const route = row?.payload?.candidate?.route ?? null;
  return {
    typeCode: a?.typeCode ?? null, registration: a?.registration ?? null,
    typeDesc: a?.typeDesc ?? null, icao: row?.icao ?? a?.icao ?? null,
    rangeM: row?.payload?.candidate?.aircraftAtClosest?.rangeM ?? row?.range_m ?? null,
    elevationDeg: row?.payload?.candidate?.aircraftAtClosest?.elevationDeg ?? null,
    isISS: iss,
    flight: row?.flight ?? row?.callsign ?? route?.flight ?? null,
    origin: row?.origin ?? route?.origin?.iata ?? route?.origin?.icao ?? null,
    destination: row?.destination ?? route?.destination?.iata ?? route?.destination?.icao ?? null,
    ...acGeo(a, iss),
  };
}

const fovSpecs = $('#fov-specs');
const fovMap = $('#fov-map');
const fovSide = $('#fov-side');

// Offline plan-view mini-map under the FOV. Shown when we have the
// observer + the aircraft's lat/lon (live row, or a recorded History
// payload). Hidden for the ISS or when geometry is missing.
function renderFovMap(meta) {
  if (!fovMap && !fovSide) return;
  const label = meta?.registration ?? meta?.icao ?? '';
  // Plan view needs the observer + the aircraft's lat/lon.
  const mapOk = meta && !meta.isISS && lastObserver
    && Number.isFinite(meta.lat) && Number.isFinite(meta.lon)
    && Number.isFinite(lastObserver.latitudeDeg)
    && Number.isFinite(lastObserver.longitudeDeg);
  if (fovMap) {
    fovMap.innerHTML = mapOk ? buildMiniMapSvg({
      obsLat: lastObserver.latitudeDeg,
      obsLon: lastObserver.longitudeDeg,
      acLat: meta.lat,
      acLon: meta.lon,
      trackDeg: meta.trackDeg ?? null,
      rangeM: meta.rangeM ?? null,
      label,
    }) : '';
  }
  // Side view only needs elevation + slant range (no lat/lon), so it can
  // show even when the plan view can't. buildSideViewSvg returns '' when
  // those are missing (e.g. ISS) → the half collapses via syncFovAux.
  if (fovSide) {
    fovSide.innerHTML = (meta && !meta.isISS) ? buildSideViewSvg({
      elevationDeg: meta.elevationDeg ?? null,
      rangeM: meta.rangeM ?? null,
    }) : '';
  }
  syncFovAux();
}

// ---- AirNav on-demand info (lazy, click + hover, shared session cache) ----
// Each upstream call is billed, so we cache per hex for the whole session;
// click (FOV box) and hover (popover) share this cache, and a failed/empty
// result is dropped after 60 s so a later try (e.g. token just added) works.
const acInfoCache = new Map(); // hex → Promise<info|null>
function fetchAcInfo(hex) {
  const k = String(hex || '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(k)) return Promise.resolve(null);
  if (acInfoCache.has(k)) return acInfoCache.get(k);
  const p = fetch(`/api/acinfo?hex=${k}`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
  acInfoCache.set(k, p);
  p.then((v) => { if (!v) setTimeout(() => acInfoCache.delete(k), 60_000); });
  return p;
}

// Free callsign → route (adsbdb via our /api/route proxy). No token, no
// credits, cached for the session; powers the flight-number hover even
// when AirNav is disabled.
const routeCache = new Map();
function fetchRoute(cs) {
  const k = String(cs || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(k)) return Promise.resolve(null);
  if (routeCache.has(k)) return routeCache.get(k);
  const p = fetch(`/api/route?cs=${encodeURIComponent(k)}`)
    .then(r => (r.ok ? r.json() : null))
    .then(d => d?.route ?? null)
    .catch(() => null);
  routeCache.set(k, p);
  p.then((v) => { if (!v) setTimeout(() => routeCache.delete(k), 60_000); });
  return p;
}

const fovAcinfo = $('#fov-acinfo');

function airportStr(x) {
  if (!x) return null;
  const code = x.iata || x.icao || x.name || '?';
  return x.city ? `${code} (${x.city})` : code;
}
function acinfoRows(info) {
  const a = info.aircraft;
  const f = info.live;
  const rows = [];
  if (a) {
    if (a.registration) rows.push(specRow('Reg', a.registration));
    const model = [a.typeDescription, a.typeIcao ? `(${a.typeIcao})` : '']
      .filter(Boolean).join(' ');
    if (model) rows.push(specRow('Type', model));
    if (a.classDescription) rows.push(specRow('Class', a.classDescription));
    if (a.operator) rows.push(specRow('Operator', a.operator));
    if (a.serialNumber) rows.push(specRow('MSN', a.serialNumber));
    if (a.firstFlight) rows.push(specRow('First flight', a.firstFlight));
    if (a.decommissioned) rows.push(specRow('Note', 'decommissioned'));
  }
  if (f) {
    if (f.flight || f.callsign) rows.push(specRow('Flight', f.flight || f.callsign));
    if (f.airline) rows.push(specRow('Airline', f.airline));
    const route = [airportStr(f.origin), airportStr(f.destination)].filter(Boolean).join(' → ');
    if (route) rows.push(specRow('Route', route));
    if (f.scheduledDeparture) rows.push(specRow('Sched dep', f.scheduledDeparture));
    if (f.estimatedArrival) rows.push(specRow('Est arr', f.estimatedArrival));
    if (f.status) rows.push(specRow('Status', f.status));
  }
  return rows.join('');
}
function acPhotoImg(info) {
  const url = info?.aircraft?.photo;
  return url
    ? `<img class="ac-photo" src="${url}" alt="aircraft" loading="lazy" referrerpolicy="no-referrer">`
    : '';
}
function acinfoHtml(info) {
  // Right column of the combined box: photo on top, data below it (the
  // data area scrolls if long so the column stays flush with the map).
  // Source label (v0.21.0): the /api/acinfo proxy tags every response
  // with `source: 'airnav' | 'adsbdb'` so the user can tell which feed
  // is showing — AirNav is the paid, richer source; adsbdb is the free
  // fallback (no token, no live route, smaller photo set).
  const src = info?.source === 'adsbdb'
    ? { head: 'adsbdb', klass: 'free', foot: 'adsbdb.com (free) · static airframe + photo · cached this session. AirNav inactive or out of credits.' }
    : { head: 'AirNav', klass: 'on-demand', foot: 'AirNav On-Demand API · billed per call · cached this session.' };
  return `<div class="spec-head">${src.head}<span class="spec-klass">${src.klass}</span></div>`
    + acPhotoImg(info)
    + `<div class="acinfo-data">${acinfoRows(info)}</div>`
    + `<div class="spec-foot">${src.foot}</div>`;
}
// The combined box is visible only while a column has content; an empty
// column collapses so the other takes the full width (e.g. auto-FOV =
// map only, no AirNav until you click).
function syncFovAux() {
  const box = $('#fov-aux');
  if (!box) return;
  // #fov-aux is now purely the two geometry maps (plan + side). The AirNav
  // box lives in #fov-top beside the transit sketch and collapses on its
  // own via the .fov-top > [hidden] rule.
  const mapHas = !!(fovMap && fovMap.innerHTML);
  const sideHas = !!(fovSide && fovSide.innerHTML);
  const acHas = !!(fovAcinfo && fovAcinfo.innerHTML);
  if (fovMap) fovMap.hidden = !mapHas;
  if (fovSide) fovSide.hidden = !sideHas;
  if (fovAcinfo) fovAcinfo.hidden = !acHas;
  box.hidden = !(mapHas || sideHas);
}
async function renderFovAcinfo(meta) {
  if (!fovAcinfo) return;
  const hex = String(meta?.icao ?? '').toLowerCase();
  if (!meta || meta.isISS || !/^[0-9a-f]{6}$/.test(hex)) {
    fovAcinfo.innerHTML = ''; fovAcinfo.dataset.hex = ''; syncFovAux();
    return;
  }
  // refreshFovPane runs every 2 s — if this aircraft is already shown, do
  // nothing (no flicker, no re-render; the fetch is cached anyway).
  if (fovAcinfo.dataset.hex === hex) return;
  fovAcinfo.dataset.hex = hex;
  fovAcinfo.innerHTML = '<div class="spec-head">Airframe<span class="spec-klass">loading…</span></div>';
  syncFovAux();
  const info = await fetchAcInfo(hex);
  // A newer pin may have replaced this one while we awaited — bail if so.
  if (!pin || String(pin.acMeta?.icao ?? '').toLowerCase() !== hex) return;
  if (!info) {
    fovAcinfo.innerHTML = ''; fovAcinfo.dataset.hex = '';
  } else {
    fovAcinfo.innerHTML = acinfoHtml(info);
  }
  syncFovAux();
}

function specRow(label, value) {
  return `<div class="spec-row"><span class="spec-k">${label}</span>`
       + `<span class="spec-v">${value}</span></div>`;
}

// Render the spec panel for whatever airframe is currently shown in the FOV.
// Three cases: known type (full specs), unknown type but we at least have a
// type/registration string (show that + "not in offline DB"), or nothing
// identifying at all (hide the panel entirely).
function renderFovSpecs(meta) {
  if (!fovSpecs) return;
  const spec = resolveAircraftType(meta?.typeCode);
  if (spec) {
    const seats = spec.seats == null ? 'n/a (non-pax)' : `~${spec.seats}`;
    fovSpecs.innerHTML =
      `<div class="spec-head">${spec.manufacturer} ${spec.model}`
        + `<span class="spec-klass">${klassLabel(spec.klass)}</span></div>`
      + specRow('Type', `${meta.typeCode}${meta.registration ? ` · ${meta.registration}` : ''}`)
      + specRow('Length', `${spec.lengthM.toFixed(1)} m`)
      + specRow('Wingspan', `${spec.wingspanM.toFixed(1)} m`)
      + specRow('MTOW', `${Math.round(spec.mtowKg / 1000)} t`)
      + specRow('Seating', seats)
      + specRow('Vintage', designAgePhrase(spec.firstYear))
      + `<div class="spec-foot">Silhouette in the frame is scaled to this airframe's real span/length.</div>`;
    fovSpecs.hidden = false;
    return;
  }
  const tc = meta?.typeCode;
  const reg = meta?.registration;
  if (tc || reg) {
    fovSpecs.innerHTML =
      `<div class="spec-head">${tc ?? 'Unknown type'}`
        + `${reg ? `<span class="spec-klass">${reg}</span>` : ''}</div>`
      + (meta.typeDesc ? specRow('Desc', meta.typeDesc) : '')
      + `<div class="spec-foot">Type not in the offline spec DB — generic silhouette used.</div>`;
    fovSpecs.hidden = false;
    return;
  }
  // Nothing identifying (feed without aircraft-DB enrichment) → no panel.
  fovSpecs.hidden = true;
  fovSpecs.innerHTML = '';
}

function refreshFovPane() {
  const auto = pickAutoEntry(lastLifecycle);

  // Pin invalidation: a *newer* qualifying live candidate displaces the
  // pin. "Newer" is judged by firstSeenMs > the firstSeenMs we captured
  // when the user clicked. Equal timestamps do NOT displace (so an
  // auto-picked entry that was already there before the click stays
  // out of the way).
  if (pin && auto && (auto.firstSeenMs ?? 0) > pin.firstSeenMs) {
    pin = null;
  }

  if (pin) {
    renderFovSketch(pin.input, { pinned: true, label: pin.label });
    renderFovSpecs(pin.acMeta);
    renderFovMap(pin.acMeta);
    renderFovAcinfo(pin.acMeta);   // AirNav: only on an explicit click/pin
  } else if (auto) {
    renderFovSketch(fromLifecycleEntry(auto),
      { pinned: false, label: describeEntry(auto) });
    const m = acMetaFromLifecycle(auto);
    renderFovSpecs(m);
    renderFovMap(m);
    renderFovAcinfo(null);         // never auto-fetch (billed per call)
  } else {
    renderFovEmpty(
      `No close approach right now (sep &lt; ${FOV_NEAR_DEG.toFixed(0)}°). ` +
      'Click any tracking or history row to pin a specific transit here.',
    );
    renderFovSpecs(null);
    renderFovMap(null);
    renderFovAcinfo(null);
  }
  highlightPinnedRow();
}

function pinFromRow(source, index) {
  const idx = Number(index);
  if (source === 'live') {
    const entry = lastLifecycle[idx];
    const input = entry ? fromLifecycleEntry(entry) : null;
    if (!input) return;
    pin = { key: entry.key, firstSeenMs: Date.now(), input,
            label: describeEntry(entry), acMeta: acMetaFromLifecycle(entry) };
  } else if (source === 'history') {
    const row = lastHistory[idx];
    const input = row ? fromHistoryRow(row) : null;
    if (!input) return;
    // History pin key is synthetic so the pin invalidator can't collide it
    // with any live lifecycle entry — history rows never get displaced by
    // an older live tick that happens to share an ICAO.
    const key = `history:${row.icao}|${row.body}|${row.closest_at_ms}`;
    pin = {
      key,
      firstSeenMs: Date.now(),
      input,
      label: `${row.body} · ${row.flight ?? row.callsign ?? row.icao} (history)`,
      acMeta: acMetaFromHistory(row),
    };
  }
  refreshFovPane();
}

document.body.addEventListener('click', (ev) => {
  const row = ev.target.closest('tr.sketchable');
  if (!row) return;
  // A link inside a row (the ICAO → adsbexchange hex link) is navigation,
  // not a pin gesture — let it open without also pinning + scrolling away.
  if (ev.target.closest('a')) return;
  pinFromRow(row.dataset.source, row.dataset.index);
  // Jump the viewport up to the FOV pane so the user actually sees the
  // illustration they just pinned — without this the click on a History
  // row at the bottom of the page only repaints something off-screen.
  // Skip when the section is already comfortably visible to avoid
  // scrolling around when the user is already looking at the pane.
  const fov = $('#fov-section');
  if (fov) {
    const rect = fov.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
});
// ---- Flight-number hover → ad-hoc AirNav photo + route popover ----------
// Dwell ~450 ms on a flight cell, then fetch (shared/cached with the FOV
// box). ISS / unknown hex never triggers it. Cancels on mouse-out / scroll.
const acPop = $('#ac-popover');
let acHoverTimer = null;
function hideAcPop() {
  if (acHoverTimer) { clearTimeout(acHoverTimer); acHoverTimer = null; }
  if (acPop) { acPop.hidden = true; acPop.innerHTML = ''; }
}
function placeAcPop(x, y) {
  acPop.hidden = false;
  const r = acPop.getBoundingClientRect();
  const pad = 12;
  let left = x + 16;
  let top = y + 16;
  if (left + r.width + pad > window.innerWidth) left = x - r.width - 16;
  if (top + r.height + pad > window.innerHeight) top = y - r.height - 16;
  acPop.style.left = `${Math.max(pad, left)}px`;
  acPop.style.top = `${Math.max(pad, top)}px`;
}
function acPopHtml(info) {
  const f = info.live;
  const a = info.aircraft;
  const title = (f && (f.flight || f.callsign)) || (a && a.registration) || 'aircraft';
  const sub = [a && (a.typeDescription || a.typeIcao), f && f.airline].filter(Boolean).join(' · ');
  const route = f ? [airportStr(f.origin), airportStr(f.destination)].filter(Boolean).join(' → ') : '';
  return (a && a.photo
    ? `<img class="ac-photo" src="${a.photo}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '')
    + `<div class="acpop-title">${title}</div>`
    + (sub ? `<div class="acpop-sub">${sub}</div>` : '')
    + (route ? `<div class="acpop-sub">${route}${f && f.status ? ` · ${f.status}` : ''}</div>` : '');
}
// Free-route popover (adsbdb) — used for callsign-only targets and as the
// fallback when AirNav has no data / is disabled.
function routePopHtml(route, cs) {
  const title = route.flight || cs;
  const airline = route.airline?.name || '';
  const r = [airportStr(route.origin), airportStr(route.destination)].filter(Boolean).join(' → ');
  return `<div class="acpop-title">${title}</div>`
    + (airline ? `<div class="acpop-sub">${airline}</div>` : '')
    + (r ? `<div class="acpop-sub">${r}</div>` : '<div class="acpop-sub">route unknown</div>')
    + '<div class="acpop-sub" style="opacity:.6">via adsbdb (free)</div>';
}
document.body.addEventListener('mouseover', (ev) => {
  const cell = ev.target.closest && ev.target.closest('.flight-cell');
  if (!cell || !acPop) return;
  const hex = (cell.dataset.hex || '').toLowerCase();
  const cs = (cell.dataset.cs || '').toUpperCase();
  const hasHex = /^[0-9a-f]{6}$/.test(hex);   // ISS / blank → not a hex
  const hasCs = /^[A-Z0-9]{2,10}$/.test(cs);
  if (!hasHex && !hasCs) return;
  const x = ev.clientX;
  const y = ev.clientY;
  if (acHoverTimer) clearTimeout(acHoverTimer);
  acHoverTimer = setTimeout(async () => {
    let html = null;
    if (hasHex) {                              // AirNav (photo + airframe)
      const info = await fetchAcInfo(hex);
      if (info) html = acPopHtml(info);
    }
    if (!html && hasCs) {                       // free route fallback
      const route = await fetchRoute(cs);
      if (route) html = routePopHtml(route, cs);
    }
    if (!html || !cell.matches(':hover')) return;
    acPop.innerHTML = html;
    placeAcPop(x, y);
  }, 450);
});
document.body.addEventListener('mouseout', (ev) => {
  if (ev.target.closest && ev.target.closest('.flight-cell')) hideAcPop();
});
window.addEventListener('scroll', hideAcPop, true);

// Esc unpins, restoring auto mode — discoverable shortcut without a UI
// button cluttering the sky-row pane.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') hideAcPop();
  if (ev.key === 'Escape' && pin) { pin = null; refreshFovPane(); }
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
    if (el.name === 'airnav.token')   v = cfg.airnav?.tokenMasked   ?? '';
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
      if ((el.name === 'pushover.token' || el.name === 'pushover.user'
           || el.name === 'airnav.token')
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

// SharpCap "Test trigger" — fires an immediate 2 s capture using the host/port
// currently in the form (so you can test before saving). The saved token, if
// any, is applied server-side.
const sharpcapTestBtn = $('#sharpcap-test-btn');
const sharpcapTestMsg = $('#sharpcap-test-msg');
if (sharpcapTestBtn) {
  sharpcapTestBtn.addEventListener('click', async () => {
    const host = settingsForm.elements['sharpcap.host']?.value?.trim() ?? '';
    const portRaw = settingsForm.elements['sharpcap.port']?.value ?? '';
    const port = portRaw === '' ? undefined : Number(portRaw);
    sharpcapTestMsg.textContent = 'triggering…';
    sharpcapTestMsg.className = 'field-hint';
    sharpcapTestBtn.disabled = true;
    try {
      const res = await fetch('/api/sharpcap-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationS: 2, host: host || undefined, port }),
      });
      const body = await res.json();
      if (!res.ok || !body.sent) {
        throw new Error(body.error ?? body.reason ?? `HTTP ${res.status}`);
      }
      sharpcapTestMsg.textContent = `OK — ${body.response?.captureId ?? 'capture started'}`;
      sharpcapTestMsg.className = 'field-hint ok';
    } catch (e) {
      sharpcapTestMsg.textContent = `failed: ${e.message ?? e}`;
      sharpcapTestMsg.className = 'field-hint err';
    } finally {
      sharpcapTestBtn.disabled = false;
    }
  });
}
// History pager: "Newer" steps towards today (page 0), "Older" further back.
$('#hp-newer').addEventListener('click', () => gotoHistoryPage(-1));
$('#hp-older').addEventListener('click', () => gotoHistoryPage(+1));

// Click-to-update from the version badge. Confirmed POST → the server only
// drops a trigger file; a privileged systemd .path unit runs the actual
// git pull + restart. The page will briefly disconnect when the service
// restarts — that is expected and the status line already reflects it.
function setUpdateMsg(text, kind) {
  const el = $('#update-msg');
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; el.className = 'update-msg'; return; }
  el.hidden = false;
  el.textContent = text;
  el.className = `update-msg${kind ? ` ${kind}` : ''}`;
}

let updateInFlight = false;
let clientErrorUntil = 0;   // keep a failed-click error visible briefly
async function triggerUpdate() {
  if (updateInFlight) return;
  const badge = $('#app-version');
  const ok = window.confirm(
    'Pull the latest version from origin/main and restart the service?\n\n'
    + 'The page reconnects automatically once the service is back. Local '
    + 'config (observer / service.json) is preserved. NOTE: the actual '
    + 'pull+restart is performed by the background updater on the Pi '
    + '(systemd stp-update.path) — this only requests it.',
  );
  if (!ok) return;
  updateInFlight = true;
  badge.classList.add('updating');
  badge.textContent = 'updating…';
  setUpdateMsg('Requesting update…', '');
  try {
    const res = await fetch('/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const body = await res.json().catch(() => ({}));
    // The endpoint returns HTTP 200 even for a logical failure (ok:false) —
    // surface that instead of pretending it worked (the old silent bug).
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    if (body.ok === false) throw new Error(body.message ?? 'update request rejected');
    // Trigger written. From here pollState() reads state.update and tells
    // the truth: pending → consumed (restart imminent) → or "stuck" if no
    // background updater is consuming it (then the badge is reset there).
    setUpdateMsg(body.message ?? 'Update requested — waiting for the updater…', '');
  } catch (e) {
    badge.classList.remove('updating');
    badge.textContent = `v${lastVersion ?? '—'}`;
    setUpdateMsg(`Update could not be started: ${e.message ?? e}`, 'err');
    updateInFlight = false;
    // Keep this client-side error visible for a bit; otherwise the next
    // poll's 'idle' would wipe it within 2 s.
    clientErrorUntil = Date.now() + 10_000;
  }
}

// Reflect the server-side click-to-update diagnostic. Honest states:
//   pending  — trigger written, giving the systemd watcher a moment
//   consumed — updater picked it up; the service will restart now
//   stuck    — nothing consumed the trigger → the stp-update.path unit is
//              not installed/enabled (Linux/Pi only). Tell the user the fix.
//   idle     — nothing in progress (also the post-no-op / post-timeout
//              state); badge MUST return to the version here.
//
// Authoritative: the server's state.update drives the badge so a browser
// refresh always shows a sane state (the old bug: badge stuck on
// "updating…" forever, even after refresh, because nothing cleared it).
function setBadgeVersion() {
  const badge = $('#app-version');
  badge.classList.remove('updating');
  badge.textContent = `v${lastVersion ?? '—'}`;
}
function renderUpdateStatus(upd) {
  if (!upd) return;
  const badge = $('#app-version');
  if (upd.status === 'pending') {
    updateInFlight = true;
    badge.classList.add('updating');
    badge.textContent = 'updating…';
    setUpdateMsg(`Update requested ${Math.round(upd.ageMs / 1000)}s ago — waiting for the background updater…`, '');
  } else if (upd.status === 'consumed') {
    updateInFlight = true;
    badge.classList.add('updating');
    badge.textContent = 'updating…';
    setUpdateMsg('Updater picked up the request — pulling & restarting if there are changes…', 'ok');
  } else if (upd.status === 'stuck') {
    updateInFlight = false;            // not going to happen → release the UI
    setBadgeVersion();
    setUpdateMsg(
      'No background updater consumed the request within 12 s. The systemd '
      + '"stp-update.path" unit is not installed/enabled on this host '
      + '(it is Linux/Pi only). One-time fix on the Pi: '
      + 'cd ~/sun-moon-transit-predictor && bash scripts/install-pi5.sh',
      'err',
    );
  } else {
    // idle — nothing pending (fresh, post-restart, no-op, or timed-out).
    updateInFlight = false;
    setBadgeVersion();
    // Don't wipe a just-shown client-side error (failed POST / rejected).
    if (Date.now() >= clientErrorUntil) setUpdateMsg('');
  }
}
$('#app-version').addEventListener('click', triggerUpdate);
$('#app-version').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); triggerUpdate(); }
});
document.body.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-close-settings="1"]')) closeSettings();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !settingsModal.hidden) closeSettings();
});

// Pin the copyright year so it always matches the runtime — saves having to
// edit the HTML on every January 1st.
$('#copyright-year').textContent = String(new Date().getFullYear());
// Set the dump1090 link from the current host (no server round-trip needed).
applyDump1090Link();

// Seed the preview pane with the placeholder copy so it isn't blank during
// the brief window before the first /api/state response.
refreshFovPane();

// Wall-clock tick: render immediately then every second.
tickClock();
setInterval(tickClock, 1000);

// Fast cadence while any qualifying (or the pinned) transit is within the
// ETA window and not long past — that's when the plan/side views and the
// time-lapse marker should update like an animation.
function wantFastPoll() {
  for (const e of (lastLifecycle ?? [])) {
    const relevant = isQualifyingLifecycle(e) || (pin && e.key === pin.key);
    if (!relevant || !Number.isFinite(e.etaMs)) continue;
    if (e.etaMs <= POLL_FAST_ETA_MS && e.etaMs > -POLL_FAST_TAIL_MS) return true;
  }
  return false;
}
let pollTimer = null;
function scheduleNextPoll() {
  const delay = wantFastPoll() ? POLL_FAST_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(async () => {
    try { await pollState(); } finally { scheduleNextPoll(); }
  }, delay);
}

pollState();
pollHistory();
pollLearning();
pollAcstats();
pollUsable();
pollRangestats();
pollHourstats();
scheduleNextPoll();
setInterval(pollHistory, HISTORY_INTERVAL_MS);
setInterval(pollLearning, LEARNING_INTERVAL_MS);
setInterval(pollAcstats, LEARNING_INTERVAL_MS);
setInterval(pollUsable, LEARNING_INTERVAL_MS);
setInterval(pollRangestats, LEARNING_INTERVAL_MS);
setInterval(pollHourstats, LEARNING_INTERVAL_MS);
