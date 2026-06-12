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

// SEP cell for the live "Real candidates" table. When the entry's best
// (= minimum ever seen) projected sep is meaningfully better than the
// current one — typically the case for a stale → 'faded' row whose
// prediction degraded over time — show the original best struck through
// next to the current value, e.g.  ~~0.68°~~ (2.00°).  This makes "this
// looked like a real close approach but fell apart" obvious at a glance,
// instead of a misleadingly wide stale number with no context.
const SEP_DIVERGED_DEG = 0.10;   // ignore sub-noise wobble (anything ≤ this stays single-value)
function sepCellLive(e) {
  const curr = e.closestApproachSepDeg;
  const best = e.bestSepDeg;
  if (!Number.isFinite(curr)) {
    return Number.isFinite(best) ? fmtSep(best) : '—';
  }
  if (Number.isFinite(best) && best + SEP_DIVERGED_DEG < curr) {
    return `<span class="sep-was" title="Best projected separation while the tracker was following this flight — closer than the current value, which has since drifted.">${fmtSep(best)}</span> <span class="sep-now" title="Current projected separation. The prediction has drifted away from the best (and into the 'faded' stale reason for an inactive row).">(${fmtSep(curr)})</span>`;
  }
  return fmtSep(curr);
}

// History counterpart to sepCellLive. The consolidated History view stores
// the BEST (= closest) projected sep in closest_sep_deg and — when the
// entry later went stale-faded — the final drifted value in last_sep_deg
// (v0.30.8). Same dual-value display as the live panel:
//   ~~0.68°~~  (2.00°)
// Preserves the existing strike-through-when-unconfirmed semantics: if the
// episode never reached an imminent stage, the whole cell is still struck
// through via .sep-unconfirmed, so a confirmed→faded mix can't happen by
// construction (a confirmed row IS the closest approach, no drift left).
function sepCellHistory(e) {
  const tightest = e.closest_sep_deg;
  const last = e.last_sep_deg;
  const wrap = (inner) => `<span class="${e.sepConfirmed ? 'sep-confirmed' : 'sep-unconfirmed'}" title="${e.sepConfirmed
    ? 'Sep at the real closest approach (imminent stage).'
    : 'PREDICTED sep only — no imminent confirmation; the flight diverged before the ETA, so this never actually happened.'}">${inner}</span>`;
  if (Number.isFinite(tightest) && Number.isFinite(last) && tightest + SEP_DIVERGED_DEG < last) {
    return wrap(`<span class="sep-was" title="Closest projected separation reached during the episode.">${fmtSep(tightest)}</span> <span class="sep-now" title="Final projected separation at the moment the lifecycle entry went stale-faded.">(${fmtSep(last)})</span>`);
  }
  return wrap(fmtSep(tightest));
}
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
// SharpCap-armed episodes from /api/state (set in pollState). Lets us put a
// ⚡ next to a row whose transit had a capture armed. In-memory on the server
// (resets on restart), so the bolt is a session indicator, not historical.
let sharpcapArmedLog = [];
const ARMED_TOL_MS = 120_000;   // match an episode within ±2 min of closest
function isArmed(icao, body, closestMs) {
  if (!icao || !Number.isFinite(closestMs) || !sharpcapArmedLog.length) return false;
  const hex = String(icao).toLowerCase();
  return sharpcapArmedLog.some((a) =>
    String(a.icao ?? '').toLowerCase() === hex
    && a.body === body
    && Math.abs((a.closestAtMs ?? 0) - closestMs) <= ARMED_TOL_MS);
}
// Small ⚡ appended inside the vis cell when a capture was armed for this row.
function armedBolt(armed) {
  return armed
    ? '<span class="armed-bolt" title="SharpCap capture armed for this transit this session.">⚡</span>'
    : '';
}

function visCell(elDeg, armed = false) {
  const bolt = armedBolt(armed);
  const v = visInfo(elDeg);
  if (!v) {
    return '<td class="td-icon vis-cell" title="elevation at closest approach unknown">'
      + `<span class="vis-dot vis-unknown">·</span>${bolt}</td>`;
  }
  const t = `${elDeg.toFixed(0)}° elevation — visibility ${v.word} `
    + `(red <${VIS_AMBER_DEG}° · amber ${VIS_AMBER_DEG}–${VIS_GREEN_DEG}° · green ≥${VIS_GREEN_DEG}°)`;
  return `<td class="td-icon vis-cell" title="${t}"><span class="vis-dot ${v.cls}">●</span>${bolt}</td>`;
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

// Known orbiting-satellite tags (config.iss.satellites). Their "icao" is this
// short tag, not a 6-hex airframe code. The predictor sets isISS=true on the
// live candidates, but History rows are reconstructed from stored fields that
// may lack the flag — so detection falls back to the tag. Keep in sync with
// src/service.js DEFAULT_CONFIG.iss.satellites (+ the implicit ISS).
const SAT_TAGS = new Set(['ISS', 'HST', 'CSS']);
const isSatRow = (e) => e?.isISS === true || SAT_TAGS.has(e?.icao);

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

// Sky-target plan confidence badge (mirrors src/skyplan.js confidenceFor).
const CONFIDENCE_BADGE = {
  green:  { dot: '🟢', label: 'sure',      tip: 'TLE fresh at the event (< 1 d) — reliable.' },
  amber:  { dot: '🟡', label: 'medium',    tip: 'TLE 1–3 d old at the event — refines as it nears.' },
  orange: { dot: '🟠', label: 'rough',     tip: 'TLE 3–6 d old at the event — placeholder, will sharpen.' },
  red:    { dot: '🔴', label: 'uncertain', tip: 'TLE > 6 d old at the event — very tentative.' },
};

// Active-target pulldown (M83): what the scope is pointed at. Shown only when
// the SharpCap trigger is enabled (it targets the capture). Options come from
// state.activeTargetOptions (Sun/Moon/Auto + objects with upcoming passes).
let activeTargetBusy = false;   // guard against re-rendering mid-change
function renderActiveTarget(state) {
  const bar = $('#active-target-bar');
  if (!bar) return;
  if (!state.sharpcap?.enabled) { bar.hidden = true; return; }
  bar.hidden = false;
  const sel = $('#active-target-select');
  const opts = Array.isArray(state.activeTargetOptions) ? state.activeTargetOptions : [];
  const cur = state.activeTarget ?? 'auto';
  // Rebuild options only when the set or selection changed (don't stomp an open
  // dropdown every 2 s).
  const sig = opts.map((o) => o.id).join(',') + '|' + cur;
  if (!activeTargetBusy && sel.dataset.sig !== sig) {
    sel.innerHTML = opts.map((o) => `<option value="${o.id}"${o.id === cur ? ' selected' : ''}>${o.label}</option>`).join('');
    sel.dataset.sig = sig;
  }
  // Next pass for the currently-selected sky object (if any).
  const nextEl = $('#active-target-next');
  if (nextEl) {
    const obj = opts.find((o) => o.id === cur && o.nextAtMs);
    nextEl.textContent = obj ? `next pass ${fmtDateTime(obj.nextAtMs)}` : '';
  }
}

async function setActiveTarget(target) {
  activeTargetBusy = true;
  try {
    const res = await fetch('/api/active-target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    pollState();   // reflect the new target immediately
  } catch (e) {
    console.warn('set active target failed:', e);
  } finally {
    activeTargetBusy = false;
  }
}

$('#active-target-select')?.addEventListener('change', (ev) => setActiveTarget(ev.target.value));
// ── Sky-target plan ("Drehbuch") ───────────────────────────────────────────
let lastSkyState = null;       // cached so the view toggle can re-render without a state refetch
let nextOppData = null;        // { rows, scanDays, computedAtMs } from the on-demand long scan
let nextOppLoading = false;

function appendSkyPlanRow(tbody, r) {
  const c = CONFIDENCE_BADGE[r.confidence] ?? { dot: '⚪', label: '—', tip: 'Confidence unknown (no TLE epoch).' };
  const typeLabel = r.kind === 'transit' ? 'transit' : 'field';
  const miss = r.missArcmin == null ? '—'
    : (r.missArcmin >= 60 ? `${(r.missArcmin / 60).toFixed(2)}°` : `${Math.round(r.missArcmin)}′`);
  const inField = r.timeInFieldMs ? `${(r.timeInFieldMs / 1000).toFixed(1)}s` : '—';
  const el = r.elevationDeg == null ? '—' : `${Math.round(r.elevationDeg)}°`;
  const conflict = r.conflictWithPrev
    ? ` <span class="skyplan-conflict" title="Only ${Math.round((r.conflictGapMs ?? 0) / 60000)} min after the previous event — one scope can't catch both.">⚠</span>`
    : '';
  const shadow = r.sunlit === false
    ? ' <span class="skyplan-shadow" title="Satellite in Earth\'s shadow at closest approach — not sunlit, so invisible.">🌑</span>'
    : '';
  const tr = document.createElement('tr');
  tr.className = `skyplan-row conf-${r.confidence ?? 'none'}${r.conflictWithPrev ? ' has-conflict' : ''}`;
  tr.innerHTML = `
    <td class="skyplan-when">${fmtDateTime(r.atMs)}${conflict}</td>
    <td class="skyplan-obj">${r.targetName ?? '—'}</td>
    <td class="skyplan-sat">🛰 ${r.satTag ?? '?'}${shadow}</td>
    <td class="skyplan-type type-${typeLabel}">${typeLabel}</td>
    <td>${el}</td>
    <td>${miss}</td>
    <td>${inField}</td>
    <td class="skyplan-conf" title="${c.tip}">${c.dot} ${c.label}</td>
  `;
  tbody.appendChild(tr);
}

// Render the sky-target plan. The panel shows whenever the feature is enabled
// (so the "next opportunity" toggle is reachable). Two views: the per-tick
// horizon plan, or the on-demand long scan (fetched only when ticked).
function renderSkyPlan(state) {
  lastSkyState = state;
  const section = $('#skyplan-section');
  if (!section) return;
  const meta = state.skyTargets;
  if (!meta?.enabled) { section.hidden = true; return; }
  section.hidden = false;
  const nextEver = $('#skyplan-nextever')?.checked;
  const sub = $('#skyplan-sub');
  const tbody = $('#skyplan tbody');

  if (nextEver) {
    if (nextOppLoading) {
      if (sub) sub.textContent = `computing… (${meta.nextOpportunityDays ?? 90} d scan)`;
      tbody.innerHTML = `<tr class="empty"><td colspan="8">Scanning the next ${meta.nextOpportunityDays ?? 90} days for the soonest pass per object — a few seconds…</td></tr>`;
      return;
    }
    const rows = nextOppData?.rows ?? [];
    const days = nextOppData?.scanDays ?? meta.nextOpportunityDays ?? 90;
    if (sub) sub.textContent = `soonest per object · scan ${days} d · ${rows.length} combo${rows.length === 1 ? '' : 's'}`;
    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = `<tr class="empty"><td colspan="8">No passes for any object in the next ${days} days at your location (southern-sky objects never rise here; short nights shrink the window).</td></tr>`;
      return;
    }
    for (const r of rows) appendSkyPlanRow(tbody, r);
    return;
  }

  const plan = Array.isArray(state.skyTargetPlan) ? state.skyTargetPlan : [];
  if (sub) sub.textContent = `${plan.length} pass${plan.length === 1 ? '' : 'es'} · next ${meta.planHorizonDays ?? 7} d · ${meta.objectCount ?? 0} targets`;
  tbody.innerHTML = '';
  if (!plan.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="8">No passes in the next ${meta.planHorizonDays ?? 7} days — tick “next opportunity” to scan ${meta.nextOpportunityDays ?? 90} days for when each object's chance first comes.</td></tr>`;
    return;
  }
  for (const r of plan) appendSkyPlanRow(tbody, r);
}

// On-demand long scan: ticking "next opportunity" fires it (default OFF on every
// reload, so it never runs unless asked). Server caches the result ~10 min.
async function fetchNextOpportunity() {
  nextOppLoading = true;
  if (lastSkyState) renderSkyPlan(lastSkyState);
  try {
    const res = await fetch('/api/sky-next-opportunity');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    nextOppData = body;
  } catch (e) {
    console.warn('next-opportunity scan failed:', e);
    nextOppData = { rows: [], scanDays: 0 };
  } finally {
    nextOppLoading = false;
    if (lastSkyState) renderSkyPlan(lastSkyState);
  }
}

$('#skyplan-nextever')?.addEventListener('change', (ev) => {
  if (ev.target.checked) {
    const fresh = nextOppData && (Date.now() - (nextOppData.computedAtMs ?? 0) < 5 * 60_000);
    if (fresh) { if (lastSkyState) renderSkyPlan(lastSkyState); }
    else fetchNextOpportunity();
  } else if (lastSkyState) {
    renderSkyPlan(lastSkyState);
  }
});

// Twilight aircraft × bright-planet appulses. Hidden unless enabled AND there's
// an upcoming event (the feature only computes during twilight anyway).
function renderAppulses(state) {
  const section = $('#appulse-section');
  if (!section) return;
  const list = Array.isArray(state.appulses) ? state.appulses : [];
  if (!state.appulseInfo?.enabled || !list.length) { section.hidden = true; return; }
  section.hidden = false;
  const sub = $('#appulse-sub');
  if (sub) {
    const sunEl = state.appulseInfo.sunElevDeg;
    sub.textContent = `${list.length} · twilight (Sun ${sunEl != null ? Math.round(sunEl) + '°' : '—'})`;
  }
  const tbody = $('#appulse tbody');
  tbody.innerHTML = '';
  for (const a of list) {
    const sep = a.sepDeg != null ? `${a.sepDeg.toFixed(2)}°` : '—';
    const el = a.aircraftElevationDeg != null ? `${Math.round(a.aircraftElevationDeg)}°` : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDateTime(a.atMs)}</td>
      <td>${a.flight ?? a.icao ?? '—'}</td>
      <td class="appulse-planet">🪐 ${a.planet ?? '—'}</td>
      <td>${sep}</td>
      <td>${el}</td>
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
// Concrete reason WHY a row went stale — set by the lifecycle. The plain
// "stale" badge hid this: a row could be stale because the transit is over
// (past-eta), because the receiver lost the squitter (lost-signal), or
// because the projection no longer threatens a transit (faded). Each tells
// a different story; the UI shows the reason next to the badge.
const STALE_REASON_LABELS = {
  'past-eta':    { short: 'past ETA',    tip: 'Predicted closest approach already passed; the transit window has gone (whether the flight actually crossed or not).' },
  'lost-signal': { short: 'lost signal', tip: 'No more squitters from this aircraft — transponder off, out of receiver range, or it left coverage.' },
  'no-fix':      { short: 'no fix',      tip: 'Still in dump1090 and the last projection was tight (< 0.5°), but the tracker needs groundSpeed + track in the fix to recompute and one of those dropped out for a few ticks. Re-emerges automatically when the fix is complete again — no action needed.' },
  'faded':       { short: 'faded',       tip: 'Still in dump1090 but the projected min-sep moved outside the panel band — won\'t transit.' },
};
// Hand-off Live → History. A row leaves the live-tracking ("Real candidates")
// panel once its predicted closest is more than this long in the past, and
// shows up in History only past the same threshold. Net effect: no double
// display, the row visibly migrates downward to History on its own. Kept short
// (1 min) so a long-gone candidate doesn't linger in the live view — it reverts
// to default ~1 min after the transit. The History hand-off uses the same
// cutoff, so there's no gap where a pass is in neither view.
const LIVE_GRACE_AFTER_ETA_MS = 60_000;

function renderTracking(state) {
  const tbody = $('#tracking tbody');
  tbody.innerHTML = '';
  const rows = state.lifecycle ?? [];
  lastLifecycle = rows;
  if (rows.length === 0) {
    // If BOTH bodies are below the effective observability floor the
    // tracker returns nothing no matter how much ADS-B traffic there is
    // — make that explicit so an empty panel isn't mistaken for a fault
    // (SkyAware will still be showing aircraft). Otherwise it's just
    // "no flight on the Sun/Moon line right now", which is the normal
    // idle state. The threshold is auto-widened per the lowest-enabled-
    // rig minElevationDeg (since v0.30.37), so quote it from state
    // rather than hardcoding 20° — otherwise a user who set Moon at 5°
    // would still see the misleading "< 20°" text.
    const bodies = state.bodies ?? {};
    const names = Object.keys(bodies);
    const anyObservable = names.some((n) => bodies[n]?.observable);
    if (names.length && !anyObservable) {
      const lo = names.join(' & ');
      const elev = Number.isFinite(state.observabilityMinElevDeg)
        ? state.observabilityMinElevDeg : 20;
      tbody.innerHTML =
        `<tr class="empty"><td colspan="12" class="no-bodies">`
        + `☀🌙 ${lo} below the observable limit (&lt; ${elev}° elevation).`
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
    // Hand-off to History: once the predicted closest is older than the
    // grace, the row moves out of the live panel and into History (which
    // applies the inverse filter). Future + within-grace rows stay here.
    if (Number.isFinite(e.etaMs) && -e.etaMs > LIVE_GRACE_AFTER_ETA_MS) continue;
    const tr = document.createElement('tr');
    const iss = isSatRow(e);
    tr.className = `row-${e.status} sketchable${liveRowQuality(e)}${iss ? ' row-iss' : ''}`;
    tr.dataset.source = 'live';
    tr.dataset.index = String(i);
    const baseMeta = STATUS_LABELS[e.status] ?? { icon: '', label: e.status };
    // ISS rows never show the ✈️ (candidate) glyph — that confuses users
    // into thinking it's an aircraft. Use the 🛰 satellite symbol for the
    // status icon regardless of stage; the label text still says the stage.
    const meta = iss ? { icon: '🛰', label: baseMeta.label } : baseMeta;
    // For stale rows, append the concrete reason from the lifecycle so the
    // user sees WHY (past ETA / lost signal / faded) instead of a blanket
    // "stale". Tooltip explains each.
    let statusLabel = meta.label;
    let statusTip = meta.label;
    if (e.status === 'stale' && e.staleReason && STALE_REASON_LABELS[e.staleReason]) {
      const r = STALE_REASON_LABELS[e.staleReason];
      statusLabel = `stale · ${r.short}`;
      statusTip = `Stale — ${r.tip}`;
    }
    const eta = e.etaMs > 0 ? fmtCountdownLong(e.etaMs)
              : Math.abs(e.etaMs) < 60_000 ? 'now'
              : `−${fmtCountdownLong(-e.etaMs)}`;
    const ac = e.candidate?.aircraft;
    const route = e.route ?? e.candidate?.route;
    const rangeM = e.candidate?.aircraftAtClosest?.rangeM ?? null;
    const bodyIcon = e.body === 'Sun' ? '☀' : '🌙';
    const elDeg = e.candidate?.aircraftAtClosest?.elevationDeg;
    tr.innerHTML = `
      ${visCell(elDeg, isArmed(e.icao, e.body, e.closestApproachAtMs))}
      <td class="body-${e.body} td-icon" title="${e.body}">${bodyIcon}</td>
      <td><span class="status status-${e.status}" title="${statusTip}">${meta.icon} ${statusLabel}</span></td>
      <td>${eta}</td>
      <td>${fmtTime(e.closestApproachAtMs)}</td>
      <td>${sepCellLive(e)}</td>
      <td>${fmtDistance(rangeM)}</td>
      <td>${iss ? '—' : fmtSpeed(ac?.groundSpeedMs)}</td>
      <td>${iss ? 'LEO' : fmtAlt(ac?.altMmsl)}</td>
      <td class="flight-cell" data-hex="${e.icao ?? ''}" data-cs="${e.callsign ?? e.flight ?? ''}">${iss ? ('🛰 ' + (e.icao ?? 'SAT')) : (e.flight ?? e.callsign ?? '—')}</td>
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
  const iss = isSatRow(e);
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
    ${visCell(elDeg, isArmed(e.icao, e.body, e.closest_at_ms))}
    <td class="body-${e.body} td-icon" title="${e.body}">${bodyIcon}</td>
    <td class="stage-${e.stage}">${fmtDateTime(e.closest_at_ms)}</td>
    <td>${fmtDateTime(e.recorded_at_ms)}</td>
    <td title="Lead time = ${leadMs} ms">${fmtLead(leadMs)}</td>
    <td>${sepCellHistory(e)}</td>
    <td class="stage-${e.stage}">${e.stage}</td>
    <td>${outcomeCell}</td>
    <td>${fmtDistance(e.range_m)}</td>
    <td title="${dtTooltip(dt)}">${fmtDiscTransit(dt)}</td>
    <td>${iss ? '—' : fmtSpeed(e.ground_speed_ms)}</td>
    <td>${iss ? 'LEO' : fmtAlt(e.altitude_m)}</td>
    <td class="flight-cell" data-hex="${e.icao ?? ''}" data-cs="${e.callsign ?? e.flight ?? ''}">${iss ? ('🛰 ' + (e.icao ?? 'SAT')) : (e.flight ?? e.callsign ?? '')}</td>
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

  // Live → History hand-off: skip events whose predicted closest is still
  // inside the grace window — they are owned by the live-tracking table.
  // This eliminates the "same flight in both tables" effect; a row visibly
  // migrates from Live down to History once it crosses the threshold.
  const handoffCutoff = Date.now() - LIVE_GRACE_AFTER_ETA_MS;
  const cutoff = recentCutoffMs();
  const recent = [];
  const older = [];
  lastHistory.forEach((e, i) => {
    const t = e.closest_at_ms ?? e.recorded_at_ms;
    if (Number.isFinite(t) && t > handoffCutoff) return;     // still in Live panel
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

  // Lifetime persistent block — only show when the server actually
  // delivered the data (older builds don't have stats.lifetime).
  renderDetectFunnelLifetime(stats.lifetime);
}

// Per-body × per-threshold cell: shows the absolute count plus two
// percentages — once against the broad "all ICAOs ever seen" denominator
// and once against the tighter "≥ 30° elevation" denominator. Both are
// useful: the first answers "how rare are transits among ANY contact",
// the second "how often does a properly-overhead plane actually transit".
function fmtFunnelCell(n, allN, highN) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const fmtPct = (denom) => denom > 0 ? `${((n / denom) * 100).toFixed(2)}%` : '—';
  return `<b>${n}</b> <span class="funnel-foot-frac">(${fmtPct(allN)} / ${fmtPct(highN)})</span>`;
}

// Prediction-accuracy + wind-drift panel (v0.30.24). Reads two state
// fields written by the service:
//   state.predictionStats   — bucketed p50/p95 of prediction error.
//   state.driftBias         — rolling 4 h mean wind/ATC residual.
// Both are "passive" — collected continuously, not yet auto-applied
// to extrapolate(). This panel just surfaces the numbers so the user
// can decide if/when to wire them in.
function renderPredStats(pred, drift) {
  // — Prediction error table —
  const fmtDeg = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}°` : '—');
  // Bar scale: 1° full-width. Anything bigger clamps to 100% and shows
  // ">" prefix on the value so the user knows the bar is saturated.
  const PE_BAR_MAX_DEG = 1.0;
  const setBar = (id, valDeg) => {
    const el = document.getElementById(id);
    if (!el) return;
    const w = Number.isFinite(valDeg)
      ? Math.min(100, Math.max(2, (valDeg / PE_BAR_MAX_DEG) * 100))
      : 0;
    el.style.width = `${w}%`;
  };
  const setBucket = (id, bucket) => {
    const pe = (k, v) => {
      const el = document.getElementById(`pe-${id}-${k}`);
      if (el) el.textContent = v;
    };
    if (!bucket || bucket.n === 0) {
      pe('p50', '—'); pe('p95', '—'); pe('n', '0');
      setBar(`pe-${id}-bar`, null);
      return;
    }
    pe('p50', fmtDeg(bucket.p50));
    pe('p95', fmtDeg(bucket.p95));
    // v0.30.38: append median elevation of contributing postmortems
    // so the user can tell whether a bucket is dominated by high-elev
    // cruise traffic (small drift) or low-elev approach traffic (big
    // drift). Same number, very different demographics.
    const elTxt = Number.isFinite(bucket.medianElevDeg)
      ? ` (el ${Math.round(bucket.medianElevDeg)}°)`
      : '';
    pe('n', `${bucket.n}${elTxt}`);
    setBar(`pe-${id}-bar`, bucket.p95);
  };
  const totalEl = document.getElementById('pe-total-n');
  if (totalEl) {
    const total = pred?.total ?? 0;
    const bucketSum = (pred?.buckets?.['>90s']?.n ?? 0)
                   + (pred?.buckets?.['30-60s']?.n ?? 0)
                   + (pred?.buckets?.['<10s']?.n ?? 0);
    // When postmortem rows exist but none has a sample near any of the
    // three checkpoint leads, the buckets stay empty. Flag it explicitly
    // so the user doesn't read 'n=5' and wonder why every row is "—".
    if (total > 0 && bucketSum === 0) {
      totalEl.textContent = `n=${total} · checkpoints empty (entries detected too late to hit 90/30/10 s windows)`;
    } else {
      totalEl.textContent = `n=${total}`;
    }
  }
  setBucket('90', pred?.buckets?.['>90s']);
  setBucket('30', pred?.buckets?.['30-60s']);
  setBucket('10', pred?.buckets?.['<10s']);
  const driftP50 = document.getElementById('pe-drift-p50');
  const driftP95 = document.getElementById('pe-drift-p95');
  if (driftP50) driftP50.textContent = fmtDeg(pred?.drift?.p50);
  if (driftP95) driftP95.textContent = fmtDeg(pred?.drift?.p95);

  // Stratified by elevation (v0.30.38). Shows the user that the bucket
  // demographics are vastly different between cruise (>=30° elev,
  // stable) and approach (<30° elev, drifty) populations.
  const setStrat = (tier, bucketKey, elId) => {
    const el = document.getElementById(elId);
    if (!el) return;
    const b = pred?.stratified?.[tier]?.[bucketKey];
    el.textContent = b && b.n > 0 ? `${fmtDeg(b.p50)} (n=${b.n})` : '—';
  };
  setStrat('high', '>90s',  'pe-hi-90');
  setStrat('high', '30-60s','pe-hi-30');
  setStrat('high', '<10s',  'pe-hi-10');
  setStrat('low',  '>90s',  'pe-lo-90');
  setStrat('low',  '30-60s','pe-lo-30');
  setStrat('low',  '<10s',  'pe-lo-10');

  // — Wind drift card —
  const statusEl = document.getElementById('pd-status');
  const arrowEl = document.getElementById('pd-arrow');
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  const fmtAgeMs = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 90) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m}m ago`;
    return `${(m / 60).toFixed(1)}h ago`;
  };
  if (!drift || drift.building) {
    if (statusEl) statusEl.textContent = `building… (${drift?.n ?? 0}/25)`;
    set('pd-mag', '—');
    set('pd-bearing', '—');
    set('pd-north', '—');
    set('pd-east', '—');
    set('pd-stdn', '—');
    set('pd-stde', '—');
    set('pd-n', String(drift?.n ?? 0));
    set('pd-age', '—');
    if (arrowEl) arrowEl.innerHTML = '';
    return;
  }
  // Arrow length scales 0-15 m/s → 0-32 px (radius - margin).
  const MAX_VIS_MS = 15;
  const magPx = Math.min(32, Math.max(4, (drift.magnitudeMs / MAX_VIS_MS) * 32));
  // SVG bearing convention: 0° = north (up = -y in SVG). Convert
  // bearingDeg to SVG angle: rotate the arrow head from up.
  const rad = (drift.bearingDeg * Math.PI) / 180;
  const tipX = 50 + magPx * Math.sin(rad);
  const tipY = 50 - magPx * Math.cos(rad);
  if (arrowEl) {
    arrowEl.innerHTML =
      `<line x1="50" y1="50" x2="${tipX.toFixed(1)}" y2="${tipY.toFixed(1)}" stroke="#6cb6ff" stroke-width="2"/>` +
      `<circle cx="${tipX.toFixed(1)}" cy="${tipY.toFixed(1)}" r="2.5" fill="#6cb6ff"/>` +
      `<circle cx="50" cy="50" r="2" fill="#6cb6ff"/>`;
  }
  // Signal-to-noise check (v0.30.39: now uses Standard Error of the mean,
  // not raw stddev — earlier code conflated within-population variance
  // with sampling-mean uncertainty). The correct question for "is the
  // bias real" is whether |mean| > k * SE, where SE = sigma / sqrt(n).
  // With a 4 h window collecting hundreds-thousands of samples, SE
  // shrinks fast and a small but consistent mean (e.g. 0.9 m/s east
  // wind) becomes statistically significant even when individual-aircraft
  // residuals scatter at sigma ~ 8 m/s.
  const n = drift.n ?? 0;
  const seN = n > 0 ? (drift.stdNorthMs ?? 0) / Math.sqrt(n) : Infinity;
  const seE = n > 0 ? (drift.stdEastMs  ?? 0) / Math.sqrt(n) : Infinity;
  const maxSe = Math.max(seN, seE);
  // 2-sigma = ~95% confidence. Use the larger axis SE so a
  // "borderline E but rock-solid N" pair still has to clear the bar.
  const sigZ = maxSe > 0 ? drift.magnitudeMs / maxSe : 0;
  const lowSignal = sigZ < 2.0;
  if (statusEl) {
    statusEl.textContent = lowSignal ? 'live · low signal' : 'live';
    statusEl.title = lowSignal
      ? `Mean drift (${drift.magnitudeMs.toFixed(1)} m/s) is within 2 standard errors of zero — not yet statistically distinguishable from "no wind". SE ≈ ${maxSe.toFixed(2)} m/s with n=${n}.`
      : `Mean drift is ${sigZ.toFixed(1)} standard errors above zero — statistically real (SE ≈ ${maxSe.toFixed(2)} m/s with n=${n}).`;
  }
  // Bearing label: numeric + compass octant.
  const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const oct = compass[Math.round((drift.bearingDeg % 360) / 45) % 8];
  set('pd-mag', drift.magnitudeMs.toFixed(1));
  set('pd-bearing', `${Math.round(drift.bearingDeg)}° ${oct}`);
  const signed = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(1) : '—');
  set('pd-north', `${signed(drift.meanNorthMs)} m/s`);
  set('pd-east', `${signed(drift.meanEastMs)} m/s`);
  set('pd-stdn', `${(drift.stdNorthMs ?? 0).toFixed(1)} m/s`);
  set('pd-stde', `${(drift.stdEastMs ?? 0).toFixed(1)} m/s`);
  set('pd-n', String(drift.n));
  set('pd-age', fmtAgeMs(drift.ageMs));
}

function renderDetectFunnelLifetime(life) {
  const block = $('#funnel-lifetime');
  if (!block) return;
  if (!life || !life.denominators) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  const allN  = life.denominators.allIcaos ?? 0;
  const highN = life.denominators.highElev ?? 0;
  $('#fv-life-all').textContent  = String(allN);
  $('#fv-life-high').textContent = String(highN);
  const sinceMs = life.denominators.highElevSinceMs;
  $('#fv-life-high-since').textContent = sinceMs
    ? `· tracking since ${new Date(sinceMs).toLocaleDateString()}`
    : '· no observations yet';
  const u05 = life.hits?.under05 ?? {};
  const u02 = life.hits?.under02 ?? {};
  $('#fv-life-sun-05').innerHTML  = fmtFunnelCell(u05.sun  ?? 0, allN, highN);
  $('#fv-life-sun-02').innerHTML  = fmtFunnelCell(u02.sun  ?? 0, allN, highN);
  $('#fv-life-moon-05').innerHTML = fmtFunnelCell(u05.moon ?? 0, allN, highN);
  $('#fv-life-moon-02').innerHTML = fmtFunnelCell(u02.moon ?? 0, allN, highN);
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
// Per-satellite next-pass table (ISS · Tiangong · HST): next naked-eye visible
// pass + next Sun/Moon disc transit, one column per satellite. Replaces the old
// ISS-only two-liner. Hidden until at least one satellite has a loaded TLE.
function renderSatellitePasses(state) {
  const el = $('#sat-passes');
  if (!el) return;
  const byTag = {};
  if (state.iss?.active) {
    byTag.ISS = { visiblePass: state.iss.visiblePass, nextTransit: state.iss.nextTransit };
  }
  for (const s of (state.satellites ?? [])) {
    if (s.active) byTag[s.tag] = { visiblePass: s.visiblePass, nextTransit: s.nextTransit };
  }
  // Column order requested by the user: ISS, Tiangong (CSS), HST.
  const order = [['ISS', 'ISS'], ['CSS', 'Tiangong'], ['HST', 'HST']].filter(([tag]) => byTag[tag]);
  if (!order.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;

  const visCell = (s) => {
    const p = s?.visiblePass;
    if (!p) return '<span class="sat-none">—</span>';
    return `${fmtWhenAbs(p.startMs)}<br><span class="sat-sub">${azToCompass(p.startAzDeg)}→${azToCompass(p.endAzDeg)} · max ${p.maxElevationDeg}° · ${p.durationS}s</span>`;
  };
  const transitCell = (s) => {
    const t = s?.nextTransit;
    if (!t) return '<span class="sat-none">—</span>';
    const icon = t.body === 'Sun' ? '☀' : '🌙';
    return `${icon} ${fmtWhenAbs(t.atMs)}<br><span class="sat-sub">sep ${fmtSep(t.sepDeg)}${t.tentative ? ' · tentative' : ''}</span>`;
  };

  const head = order.map(([, label]) => `<th>🛰 ${label}</th>`).join('');
  const visRow = order.map(([tag]) => `<td>${visCell(byTag[tag])}</td>`).join('');
  const transitRow = order.map(([tag]) => `<td>${transitCell(byTag[tag])}</td>`).join('');
  el.innerHTML = `
    <table class="sat-pass-table">
      <thead><tr><th></th>${head}</tr></thead>
      <tbody>
        <tr><th class="sat-row-label" title="Next naked-eye visible pass: satellite above 20°, sky dark (Sun below −6°), satellite sunlit. (Geometry only — HST is faint near the naked-eye limit.)">Next visible pass</th>${visRow}</tr>
        <tr><th class="sat-row-label" title="Next crossing of the Sun or Moon disc for this site. Offline SGP4 prediction; 'tentative' = beyond the trustworthy window, refines with each daily TLE.">Next ☀/🌙 transit</th>${transitRow}</tr>
      </tbody>
    </table>`;
}

// "Total live trackings" — single sorted-by-SEP table of EVERY aircraft in
// dump1090 range, with each one's current angular distance to the nearest
// observable body. v0.30.28: ALWAYS rendered at the top of the right
// column (previously toggle-hidden whenever the FOV preview had content,
// but with the FOV auto-pick now expanding to 2° that left almost no
// idle moments for the list to be visible). Fixed ~420 px viewport means
// the section beneath it (plan / side / airframe) sits at a predictable
// y-offset and the page below the top-row doesn't jump as traffic comes
// and goes; the table scrolls inside its own viewport when more than
// ~20 aircraft are in view.
function renderTotalLive(state) {
  const section = document.getElementById('total-live-section');
  if (!section) return;
  section.hidden = false;
  const rows = Array.isArray(state.totalLive) ? state.totalLive : [];
  const tbody = section.querySelector('tbody');
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No tracked aircraft in range right now</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => {
    const bodyIcon = r.body === 'sun' ? '☀' : r.body === 'moon' ? '☾' : '·';
    const route = r.route
      ? fmtRoute(r.route.origin?.iata ?? r.route.origin?.icao,
                 r.route.destination?.iata ?? r.route.destination?.icao)
      : '—';
    const flight = r.callsign ? r.callsign : '—';
    const bearing = Number.isFinite(r.trackDeg) ? `${Math.round(r.trackDeg)}°` : '—';
    return '<tr>'
      + `<td class="sep-cell">${fmtSep(r.sepDeg)}<span class="body-icon">${bodyIcon}</span></td>`
      + `<td class="flight-cell" data-hex="${r.icao ?? ''}" data-cs="${r.callsign ?? ''}">${flight}</td>`
      + `<td>${icaoCellInner(r.icao, false)}</td>`
      + `<td>${route}</td>`
      + `<td>${fmtDistance(r.rangeM)}</td>`
      + `<td>${fmtAlt(r.altMmsl)}</td>`
      + `<td>${Number.isFinite(r.groundSpeedMs) ? Math.round(r.groundSpeedMs * 3.6) : '—'}</td>`
      + `<td>${bearing}</td>`
      + '</tr>';
  }).join('');
}

async function pollState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error(res.status);
    const state = await res.json();
    // Refresh the armed-episode list BEFORE rendering the tables so the ⚡
    // markers reflect the latest tick.
    sharpcapArmedLog = Array.isArray(state.sharpcap?.armed) ? state.sharpcap.armed : [];
    renderSky(state);
    renderSatellitePasses(state);
    renderActiveTarget(state);
    renderSkyPlan(state);
    renderAppulses(state);
    renderTracking(state);
    renderTotalLive(state);
    renderDetectFunnel(state.detectStats);
    renderPredStats(state.predictionStats, state.driftBias);
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
    renderSharpcapStatus(state.sharpcap);
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
    // Graze rate: of all detected episodes, the share that produced a
    // CONFIRMED (imminent-stage) transit crossing each body's disc
    // (sep < grazeThresholdDeg, default 0.3°). Confirmed-only so it
    // reconciles with the lifetime body-hits table — faded predictions
    // that merely dipped tight no longer count.
    $('#learn-graze-sun').textContent  = fmtPct(a.sunGrazePct);
    $('#learn-graze-moon').textContent = fmtPct(a.moonGrazePct);
    $('#learn-graze-detail').textContent =
      `${(a.sunGrazes ?? 0) + (a.moonGrazes ?? 0)} confirmed / ${a.totalEpisodes ?? 0} detected · sep < ${
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

// Header SharpCap trigger readout next to the clock: armed body + how many
// captures it has armed this session. Hidden entirely when the trigger is
// off, so it never adds noise for users who don't run SharpCap.
function renderSharpcapStatus(sc) {
  const el = $('#sharpcap-status');
  if (!el) return;
  if (!sc || !sc.enabled) { el.hidden = true; return; }
  // body may be a single value or a union like "Sun+Moon" (multi-rig).
  const bodyIcon = (b) => (b === 'Sun' ? '☀' : b === 'Moon' ? '🌙' : '◐');
  const bodies = String(sc.body || '').split('+').filter(Boolean);
  const icons = bodies.map(bodyIcon).join('') || '◐';
  const n = sc.armedCount ?? 0;
  el.hidden = false;
  el.textContent = `🎥 ${icons} · ${n}×`;
  // Per-rig breakdown in the tooltip when multiple targets are configured.
  const rigs = Array.isArray(sc.targets) && sc.targets.length
    ? '\n' + sc.targets.map((t) => `· ${t.name}: ${t.body}`).join('\n')
    : '';
  el.title = `SharpCap capture trigger armed for ${sc.body || '—'}. `
    + `${n} capture${n === 1 ? '' : 's'} armed this session (resets on service restart).${rigs}`;
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

// Outer band for the FOV auto-pick fallback (v0.30.26). Anything inside
// this band is eligible; the picker still PREFERS sub-FOV_NEAR_DEG entries
// when one is in flight (see pickAutoEntry's tier-0 score).
const FOV_AUTO_FALLBACK_DEG = 2.0;
function isQualifyingLifecycle(entry) {
  // "close enough for an intersection" → angular separation strictly under
  // FOV_AUTO_FALLBACK_DEG, AND we actually have geometry to render. Stale
  // entries can still qualify so the user gets a last-known view of a
  // fly-by that already happened, as long as the geometry is intact.
  // v0.30.26: was FOV_NEAR_DEG (1°). Loosened so the FOV preview / chart
  // also surface entries in the broader panel band when nothing tighter
  // is in flight — pickAutoEntry's tight-band priority below makes sure a
  // <1° entry always wins out when both exist.
  if (!entry) return false;
  if (!Number.isFinite(entry.closestApproachSepDeg)) return false;
  if (entry.closestApproachSepDeg >= FOV_AUTO_FALLBACK_DEG) return false;
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
      // Tier 0: a <1° entry ALWAYS outranks a 1-2° fallback. The latter
      // exists only to keep the FOV preview occupied during quiet
      // moments, not to compete with a tight near-miss.
      e.closestApproachSepDeg < FOV_NEAR_DEG ? 1 : 0,
      // Existing priorities preserved below.
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
  // v0.30.41 layout: plan + side cells live in .top-left under the FOV
  // preview; the airframe card lives in .top-right under Total live
  // trackings + Detection funnel. Those anchor sections are always
  // visible, so we only toggle the three cells individually — neither
  // column ever fully hides.
  const mapHas = !!(fovMap && fovMap.innerHTML);
  const sideHas = !!(fovSide && fovSide.innerHTML);
  const acHas = !!(fovAcinfo && fovAcinfo.innerHTML);
  if (fovMap) fovMap.hidden = !mapHas;
  if (fovSide) fovSide.hidden = !sideHas;
  if (fovAcinfo) fovAcinfo.hidden = !acHas;
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
    // v0.30.22: when the pin points at a still-live lifecycle entry,
    // re-resolve its input from the LATEST state so growing fields
    // (predictionHistory, drifting closestApproachSepDeg, etc.) keep
    // updating in the FOV panel. The pin's frozen `input` is the
    // fallback for entries that no longer exist live (e.g. pinned
    // from History) — same behaviour as pre-v0.30.22.
    let pinInput = pin.input;
    if (pin.key && !pin.key.startsWith('history:') && Array.isArray(lastLifecycle)) {
      const fresh = lastLifecycle.find((e) => e.key === pin.key);
      if (fresh) {
        const refreshed = fromLifecycleEntry(fresh);
        if (refreshed) pinInput = refreshed;
      }
    }
    renderFovSketch(pinInput, { pinned: true, label: pin.label });
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
      `No close approach right now (sep &lt; ${FOV_AUTO_FALLBACK_DEG.toFixed(0)}°). ` +
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
// button cluttering the FOV preview pane.
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

// ---- SharpCap multi-rig editor ----------------------------------------------
// A dynamic list of capture rigs in the Settings panel. These inputs carry NO
// `name` attribute, so the generic form (de)serialiser skips them — they're
// handled explicitly in fillSettingsForm/submit and collected into
// sharpcap.targets[]. Empty list → single-rig mode (the Host/Body fields).
const scTargetsBox = $('#sharpcap-targets');
function scRigRow(rig = {}) {
  const row = document.createElement('div');
  row.className = 'sc-rig';
  const field = (cls, ph, type) => {
    const i = document.createElement('input');
    i.className = cls; i.placeholder = ph;
    if (type) { i.type = type; if (type === 'number') { i.step = 'any'; i.min = '0'; } }
    return i;
  };
  // Per-rig enabled checkbox — independent of the top-level "Enabled"
  // toggle (which only governs the main rig). Default checked when adding
  // a new row, since a rig you just added is presumably one you want on.
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.className = 'rig-enabled';
  enabled.title = 'Enable this rig. Independent of the main rig\'s Enabled toggle above.';
  const name = field('rig-name', 'name');
  const host = field('rig-host', 'host / IP');
  const port = field('rig-port', 'port', 'number'); port.min = '1'; port.max = '65535';
  const body = document.createElement('select');
  body.className = 'rig-body';
  body.innerHTML = '<option value="Sun">☀ Sun</option><option value="Moon">🌙 Moon</option>';
  const pre = field('rig-pre', 'pre s', 'number');
  const post = field('rig-post', 'post s', 'number');
  // Per-rig "observation radius" — projected sep below which a candidate is
  // armed on this rig. A long focal length wants a small radius (e.g. 0.3°);
  // a wide-field scope can use a bigger one (e.g. 2°). Empty → inherit the
  // base sharpcap.maxSepDeg. NOTE: tracker.looseThresholdDeg ("Panel band °"
  // above) must be ≥ the widest rig's radius — otherwise the tracker filters
  // those candidates out before they reach the rig.
  const sep = field('rig-sep', 'sep °', 'number'); sep.step = 'any';
  const test = document.createElement('button');
  test.type = 'button'; test.className = 'btn rig-test'; test.textContent = '🎥 Test 2s';
  test.title = 'Fire a 2 s test capture on this rig (no save needed; uses the saved token)';
  const tmsg = document.createElement('span');
  tmsg.className = 'field-hint rig-test-msg';
  test.addEventListener('click', () => sharpcapTest(host.value, port.value, tmsg, test));
  const rm = document.createElement('button');
  rm.type = 'button'; rm.className = 'btn rig-remove'; rm.textContent = '✕'; rm.title = 'Remove this rig';
  rm.addEventListener('click', () => row.remove());
  // Set values via properties (no innerHTML interpolation → no escaping issues).
  enabled.checked = rig.enabled !== false;        // default true on add
  name.value = rig.name ?? '';
  host.value = rig.host ?? '';
  port.value = rig.port ?? '';
  body.value = (Array.isArray(rig.bodies) ? rig.bodies[0] : rig.bodies) ?? 'Sun';
  pre.value = rig.preBufferS ?? '';
  post.value = rig.postBufferS ?? '';
  sep.value = rig.maxSepDeg ?? '';
  for (const el of [enabled, name, host, port, body, pre, post, sep, test, rm, tmsg]) row.appendChild(el);
  return row;
}
function fillSharpcapTargets(targets) {
  if (!scTargetsBox) return;
  scTargetsBox.innerHTML = '';
  for (const t of (Array.isArray(targets) ? targets : [])) scTargetsBox.appendChild(scRigRow(t));
}
function collectSharpcapTargets() {
  if (!scTargetsBox) return [];
  return [...scTargetsBox.querySelectorAll('.sc-rig')].map((row) => {
    const v = (sel) => row.querySelector(sel)?.value ?? '';
    const host = v('.rig-host').trim();
    if (!host) return null;            // skip blank rows
    const rig = { host, bodies: [v('.rig-body')] };
    // Per-rig enabled. Only serialise when explicitly OFF, so a normal
    // (checked) row stays minimal in service.json — default-true keeps
    // the file readable.
    const enabledEl = row.querySelector('.rig-enabled');
    if (enabledEl && !enabledEl.checked) rig.enabled = false;
    const name = v('.rig-name').trim(); if (name) rig.name = name;
    const port = v('.rig-port'); if (port !== '') rig.port = Number(port);
    const pre = v('.rig-pre');  if (pre !== '')  rig.preBufferS = Number(pre);
    const post = v('.rig-post'); if (post !== '') rig.postBufferS = Number(post);
    const sep = v('.rig-sep');  if (sep !== '')  rig.maxSepDeg = Number(sep);
    return rig;
  }).filter(Boolean);
}
if ($('#sharpcap-add-rig')) {
  $('#sharpcap-add-rig').addEventListener('click', () => scTargetsBox?.appendChild(scRigRow()));
}

// ── Sky-target catalogue editor (M83) ──────────────────────────────────────
// One editable row per object: enabled · id · name · RA(h) · Dec(°) · Ø(°) ·
// planet. Values are set via properties (not innerHTML) so object names with
// special characters (ω Centauri, η Carinae…) are safe.
function catalogRow(o = {}) {
  const row = document.createElement('div');
  row.className = 'catalog-row';
  const mk = (cls, type, ph) => {
    const i = document.createElement('input');
    i.className = cls; i.type = type; i.placeholder = ph;
    if (type === 'number') i.step = 'any';
    return i;
  };
  const en = mk('cat-enabled', 'checkbox', ''); en.checked = o.enabled !== false; en.title = 'Include in the scan';
  const id = mk('cat-id', 'text', 'm42'); id.value = o.id ?? '';
  const name = mk('cat-name', 'text', 'M42 Orion'); name.value = o.name ?? '';
  const ra = mk('cat-ra', 'number', '5.588'); ra.value = o.raHours ?? '';
  const dec = mk('cat-dec', 'number', '-5.39'); dec.value = o.decDeg ?? '';
  const diam = mk('cat-diam', 'number', ''); diam.value = o.diameterDeg ?? '';
  const body = mk('cat-body', 'text', 'Jupiter'); body.value = o.body ?? ''; body.title = 'Planet name instead of RA/Dec';
  const rm = document.createElement('button');
  rm.type = 'button'; rm.className = 'btn cat-remove'; rm.textContent = '✕'; rm.title = 'Remove';
  rm.addEventListener('click', () => row.remove());
  row.append(en, id, name, ra, dec, diam, body, rm);
  return row;
}

function fillCatalog(objects) {
  const box = $('#catalog-rows');
  if (!box) return;
  box.innerHTML = '';
  for (const o of (objects ?? [])) box.appendChild(catalogRow(o));
}

function collectCatalog() {
  const rows = Array.from(document.querySelectorAll('#catalog-rows .catalog-row'));
  const out = [];
  for (const r of rows) {
    const id = r.querySelector('.cat-id').value.trim();
    const name = r.querySelector('.cat-name').value.trim();
    if (!id && !name) continue;                       // skip a blank row
    const o = { id, name, enabled: r.querySelector('.cat-enabled').checked };
    const body = r.querySelector('.cat-body').value.trim();
    const ra = r.querySelector('.cat-ra').value;
    const dec = r.querySelector('.cat-dec').value;
    const diam = r.querySelector('.cat-diam').value;
    if (body) {
      o.body = body;
    } else {
      if (ra !== '') o.raHours = Number(ra);
      if (dec !== '') o.decDeg = Number(dec);
    }
    if (diam !== '') o.diameterDeg = Number(diam);
    out.push(o);
  }
  return out;
}

if ($('#catalog-add')) {
  $('#catalog-add').addEventListener('click', () => $('#catalog-rows')?.appendChild(catalogRow()));
}

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
    // The trigger body is stored as a one-element array (bodies) but shown as
    // a single-select; derive the selected value from bodies[0].
    if (el.name === 'sharpcap.body')  v = cfg.sharpcap?.bodies?.[0] ?? 'Sun';
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else if (v == null) el.value = '';
    else el.value = v;
  }
  // Dynamic multi-rig list (not part of the named-element loop).
  fillSharpcapTargets(cfg.sharpcap?.targets);
  fillCatalog(cfg.skyTargets?.objects);
}

async function openSettings() {
  settingsMsg.textContent = '';
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`/api/config ${res.status}`);
    const cfg = await res.json();
    fillSettingsForm(cfg);
    // Restore the last-used tab (falls back to General if unset/unknown).
    let saved = 'general';
    try { saved = localStorage.getItem(SETTINGS_TAB_KEY) || 'general'; } catch { /* ignore */ }
    activateSettingsTab(saved);
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
    // Single-select trigger body → the canonical one-element bodies array.
    if (el.name === 'sharpcap.body') {
      setNested(patch, 'sharpcap.bodies', [value]);
      continue;
    }
    setNested(patch, el.name, value);
  }
  // Multi-rig list → sharpcap.targets (empty array = single-rig mode).
  setNested(patch, 'sharpcap.targets', collectSharpcapTargets());
  setNested(patch, 'skyTargets.objects', collectCatalog());
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
    // If the server pinned the failure to a specific field, jump to its tab and
    // focus it — otherwise the error would point at a field on a hidden panel.
    const bad = settingsFieldForError(e.message);
    if (bad) {
      const tab = bad.closest('fieldset[data-tab]')?.dataset.tab;
      if (tab) activateSettingsTab(tab);
      bad.focus();
    }
  }
});

// ── Settings tabs (v0.33.0) ────────────────────────────────────────────────
// Pure VIEW grouping over the single #settings-form (see tasks/settings-tabs-ui
// .md). Every field keeps its name= and stays in the form, so save/validation/
// hot-reload are untouched — the switcher only shows/hides fieldsets by their
// data-tab. Default tab = General; the last-used tab is remembered.
const settingsTablist = settingsForm.querySelector('.settings-tablist');
const settingsTabs = Array.from(settingsForm.querySelectorAll('.settings-tab'));
const settingsPanels = Array.from(settingsForm.querySelectorAll('fieldset[data-tab]'));
const SETTINGS_TAB_KEY = 'stp.settingsTab';

function activateSettingsTab(name, { focusTab = false } = {}) {
  if (!settingsTabs.some((t) => t.dataset.tab === name)) name = 'general';
  for (const tab of settingsTabs) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;               // roving tabindex
    if (on && focusTab) tab.focus();
  }
  for (const fs of settingsPanels) fs.hidden = fs.dataset.tab !== name;
  try { localStorage.setItem(SETTINGS_TAB_KEY, name); } catch { /* private mode */ }
}

settingsTablist?.addEventListener('click', (ev) => {
  const tab = ev.target.closest('.settings-tab');
  if (tab) activateSettingsTab(tab.dataset.tab);
});
// Keyboard: ←/→ (and ↑/↓) move between tabs, Home/End jump to ends — the
// standard tablist interaction so the dialog stays keyboard-navigable.
settingsTablist?.addEventListener('keydown', (ev) => {
  const idx = settingsTabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  if (idx < 0) return;
  let next = null;
  if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (idx + 1) % settingsTabs.length;
  else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (idx - 1 + settingsTabs.length) % settingsTabs.length;
  else if (ev.key === 'Home') next = 0;
  else if (ev.key === 'End') next = settingsTabs.length - 1;
  if (next == null) return;
  ev.preventDefault();
  activateSettingsTab(settingsTabs[next].dataset.tab, { focusTab: true });
});

// Find the form element a server validation error refers to, by matching any
// known field name mentioned in the (string) error message — so we can jump to
// the right tab and focus it instead of leaving the error pointing at a hidden
// panel. Returns null when no field name is recognised.
function settingsFieldForError(errStr) {
  const s = String(errStr ?? '');
  let best = null;
  for (const el of settingsForm.elements) {
    // Prefer the longest matching name (e.g. "pushover.minElevationDeg" over a
    // hypothetical "pushover") to land on the most specific field.
    if (el.name && s.includes(el.name) && (!best || el.name.length > best.name.length)) best = el;
  }
  return best;
}

// Initial consistent state (modal is hidden, but keep the DOM coherent).
activateSettingsTab('general');

$('#settings-btn').addEventListener('click', openSettings);

// SharpCap "Test trigger" — fires an immediate 2 s capture against the given
// host/port (so you can test before saving). The saved token, if any, is
// applied server-side. Shared by the single-rig button and each rig's own
// Test button.
async function sharpcapTest(host, portRaw, msgEl, btnEl) {
  const port = (portRaw === '' || portRaw == null) ? undefined : Number(portRaw);
  if (msgEl) { msgEl.textContent = 'triggering…'; msgEl.className = 'field-hint'; }
  if (btnEl) btnEl.disabled = true;
  try {
    const res = await fetch('/api/sharpcap-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationS: 2, host: (host || '').trim() || undefined, port }),
    });
    const body = await res.json();
    if (!res.ok || !body.sent) throw new Error(body.error ?? body.reason ?? `HTTP ${res.status}`);
    if (msgEl) { msgEl.textContent = `OK — ${body.response?.captureId ?? 'capture started'}`; msgEl.className = 'field-hint ok'; }
  } catch (e) {
    if (msgEl) { msgEl.textContent = `failed: ${e.message ?? e}`; msgEl.className = 'field-hint err'; }
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

const sharpcapTestBtn = $('#sharpcap-test-btn');
const sharpcapTestMsg = $('#sharpcap-test-msg');
if (sharpcapTestBtn) {
  sharpcapTestBtn.addEventListener('click', () => sharpcapTest(
    settingsForm.elements['sharpcap.host']?.value ?? '',
    settingsForm.elements['sharpcap.port']?.value ?? '',
    sharpcapTestMsg, sharpcapTestBtn,
  ));
}

// Buzzer "Test signals": nudge the Pi to play every configured signal once.
// The beeps happen on the display Pi when its config poll sees the new id, so
// the response only confirms the nudge was accepted.
const buzzerTestBtn = $('#buzzer-test-btn');
const buzzerTestMsg = $('#buzzer-test-msg');
if (buzzerTestBtn) {
  buzzerTestBtn.addEventListener('click', async () => {
    buzzerTestBtn.disabled = true;
    if (buzzerTestMsg) { buzzerTestMsg.textContent = 'sending…'; buzzerTestMsg.className = 'field-hint'; }
    try {
      const res = await fetch('/api/buzzer-test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (buzzerTestMsg) {
        buzzerTestMsg.textContent = body.enabled
          ? 'Sent — the Pi will play the sequence shortly.'
          : 'Sent, but audio is disabled — enable it to hear the test.';
        buzzerTestMsg.className = body.enabled ? 'field-hint ok' : 'field-hint err';
      }
    } catch (e) {
      if (buzzerTestMsg) { buzzerTestMsg.textContent = `failed: ${e.message ?? e}`; buzzerTestMsg.className = 'field-hint err'; }
    } finally {
      setTimeout(() => { buzzerTestBtn.disabled = false; }, 1200);
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
