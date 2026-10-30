// Site timezone helpers (v0.60.2).
//
// Every prediction in this service is computed on UTC epoch milliseconds
// (geometry.js, sgp4.js, iss.js), so the operating-system timezone never
// changes a transit time or separation. It DOES decide every wall-clock string
// and hour bin the SERVER produces: Pushover plan alerts, the e-paper clock,
// `/api/hourstats` and the stats report's "best hours". All of those assume
// the Pi runs in the OBSERVATORY's zone. That assumption silently breaks when
// a card imaged in one country is shipped to another — Raspberry Pi Imager
// copies the zone of the machine it was flashed on, and nothing in the install
// used to check it. This module names the process zone so the UI can flag a
// browser/Pi mismatch and every server-side time string carries its zone.

/**
 * IANA name of the process timezone, e.g. "Europe/Lisbon". Fixed for the
 * process lifetime: Node reads TZ / /etc/localtime once at startup, so a
 * `timedatectl set-timezone` needs a service restart to take effect.
 */
export const SITE_TZ_NAME = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

/**
 * The process (= site) timezone with its current UTC offset.
 * @param {number} [nowMs]
 * @returns {{ name: string, offsetMin: number }} `offsetMin` is minutes EAST
 *   of UTC at `nowMs` (DST-aware): Europe/Lisbon in winter → 0, Europe/Berlin
 *   in winter → 60.
 */
export function siteTimezone(nowMs = Date.now()) {
  return { name: SITE_TZ_NAME, offsetMin: -new Date(nowMs).getTimezoneOffset() };
}

/**
 * Wall-clock string that always names its zone, e.g. "Thu 30 Oct, 14:05 WET".
 * Default zone is the process zone; pass `tz` explicitly for tests or when
 * formatting for a different place.
 * @param {number} ms
 * @param {string} [tz] IANA zone
 */
export function fmtSiteTime(ms, tz = SITE_TZ_NAME) {
  const d = new Date(ms);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
      timeZoneName: 'short',
    }).format(d);
  } catch {
    return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  }
}
