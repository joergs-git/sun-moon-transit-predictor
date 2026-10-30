// Site timezone helpers (v0.60.2) — the Pi's zone must be named, never implied.
import { describe, expect, it } from 'vitest';
import { SITE_TZ_NAME, fmtSiteTime, siteTimezone } from '../src/timezone.js';

// 2026-01-15 12:00:00 UTC — deep winter, no DST anywhere in Europe.
const WINTER_NOON_UTC = Date.UTC(2026, 0, 15, 12, 0, 0);
// 2026-07-15 12:00:00 UTC — summer time in force.
const SUMMER_NOON_UTC = Date.UTC(2026, 6, 15, 12, 0, 0);

describe('siteTimezone', () => {
  it('reports a non-empty IANA zone name and a finite offset', () => {
    const tz = siteTimezone();
    expect(typeof tz.name).toBe('string');
    expect(tz.name.length).toBeGreaterThan(0);
    expect(tz.name).toBe(SITE_TZ_NAME);
    expect(Number.isFinite(tz.offsetMin)).toBe(true);
    // Offsets are whole minutes in [-12 h, +14 h].
    expect(Math.abs(tz.offsetMin)).toBeLessThanOrEqual(14 * 60);
  });

  it('offsetMin is minutes EAST of UTC (sign matches the process zone)', () => {
    // getTimezoneOffset() is minutes WEST; the helper flips it so a +1 h
    // zone reads +60. Cross-check against Date's own value.
    const now = Date.now();
    expect(siteTimezone(now).offsetMin).toBe(-new Date(now).getTimezoneOffset());
  });
});

describe('fmtSiteTime', () => {
  it('formats in the requested zone and names it (Portugal vs Germany differ by 1 h)', () => {
    const lisbon = fmtSiteTime(WINTER_NOON_UTC, 'Europe/Lisbon');
    const berlin = fmtSiteTime(WINTER_NOON_UTC, 'Europe/Berlin');
    expect(lisbon).toMatch(/12:00/);
    expect(lisbon).toMatch(/WET|GMT/);
    expect(berlin).toMatch(/13:00/);
    expect(berlin).toMatch(/CET|GMT\+1/);
    // Both carry day + month so a plan alert days ahead is unambiguous.
    expect(lisbon).toMatch(/Thu 15 Jan/);
  });

  it('is DST-aware (summer: WEST / CEST)', () => {
    expect(fmtSiteTime(SUMMER_NOON_UTC, 'Europe/Lisbon')).toMatch(/13:00/);
    expect(fmtSiteTime(SUMMER_NOON_UTC, 'Europe/Berlin')).toMatch(/14:00/);
  });

  it('falls back to an explicit UTC string for an unknown zone', () => {
    expect(fmtSiteTime(WINTER_NOON_UTC, 'Not/AZone')).toBe('2026-01-15 12:00 UTC');
  });

  it('defaults to the process zone', () => {
    expect(fmtSiteTime(WINTER_NOON_UTC)).toBe(fmtSiteTime(WINTER_NOON_UTC, SITE_TZ_NAME));
  });
});
