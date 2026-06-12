import { describe, it, expect } from 'vitest';

import {
  satrecFromTleText, pickAlertEvents, alreadyNotified,
  actionToken, verifyActionToken, fmtLocal, formatAlert,
  BODY_ELEVATION_FLOOR_DEG, SATELLITES,
} from '../alerts/lib.js';

// The same valid, well-formed ISS element set used by test/iss.test.js —
// TLEs are fixed-column, so a hand-typed one silently parses into a wrong
// orbit. Values don't matter here, column-correct parseability does.
const ISS_TLE = `ISS (ZARYA)
1 25544U 98067A   24123.54791667  .00016717  00000-0  30074-3 0  9994
2 25544  51.6402 211.1063 0004604  47.1827  85.0114 15.49814641450000`;

const HOUR = 3600_000;

function cand(over = {}) {
  return {
    icao: 'ISS',
    callsign: 'ISS (ZARYA)',
    body: 'Sun',
    level: 'candidate',
    closestApproachAtMs: 0,
    closestApproachSepDeg: 0.1,
    durationMs: 800,
    aircraftAtClosest: { azimuthDeg: 180, elevationDeg: 45, rangeM: 500_000 },
    ...over,
  };
}

describe('satrecFromTleText', () => {
  it('parses a 3-line TLE', () => {
    const satrec = satrecFromTleText(ISS_TLE);
    expect(satrec).toBeTruthy();
    expect(satrec.jdsatepoch).toBeGreaterThan(2_400_000);
  });

  it('returns null on garbage instead of throwing', () => {
    expect(satrecFromTleText('not a tle')).toBeNull();
    expect(satrecFromTleText('')).toBeNull();
    expect(satrecFromTleText(undefined)).toBeNull();
  });
});

describe('pickAlertEvents', () => {
  const nowMs = 1_700_000_000_000;
  const base = { nowMs, leadMinMs: 6 * HOUR, leadMaxMs: 48 * HOUR };

  it('keeps an on-disc event inside the lead window', () => {
    const ev = cand({ closestApproachAtMs: nowMs + 30 * HOUR });
    expect(pickAlertEvents([ev], base)).toHaveLength(1);
  });

  it('drops radio-level (graze) events', () => {
    const ev = cand({ level: 'radio', closestApproachAtMs: nowMs + 30 * HOUR });
    expect(pickAlertEvents([ev], base)).toHaveLength(0);
  });

  it('drops events outside the lead window (too soon / too far)', () => {
    const soon = cand({ closestApproachAtMs: nowMs + 2 * HOUR });
    const far = cand({ closestApproachAtMs: nowMs + 60 * HOUR });
    expect(pickAlertEvents([soon, far], base)).toHaveLength(0);
  });

  it('drops events below the elevation minimum and clamps to the 20° floor', () => {
    const low = cand({
      closestApproachAtMs: nowMs + 30 * HOUR,
      aircraftAtClosest: { azimuthDeg: 0, elevationDeg: 15, rangeM: 1 },
    });
    // Asking for 5° cannot undercut the engine's 20° body floor.
    expect(pickAlertEvents([low], { ...base, minElevationDeg: 5 })).toHaveLength(0);
    expect(BODY_ELEVATION_FLOOR_DEG).toBe(20);
  });

  it('honours the per-user body opt-in', () => {
    const moon = cand({ body: 'Moon', closestApproachAtMs: nowMs + 30 * HOUR });
    expect(pickAlertEvents([moon], { ...base, bodies: ['Sun'] })).toHaveLength(0);
    expect(pickAlertEvents([moon], { ...base, bodies: ['Sun', 'Moon'] })).toHaveLength(1);
  });
});

describe('alreadyNotified (fuzzy dedup)', () => {
  const t = 1_700_000_000_000;
  const ev = cand({ closestApproachAtMs: t });

  it('matches the same event even when the predicted time drifted', () => {
    const rows = [{ sat: 'ISS', body: 'Sun', event_at_ms: t + 10 * 60_000 }];
    expect(alreadyNotified(rows, ev)).toBe(true);
  });

  it('does not match a different satellite, body or a distant time', () => {
    expect(alreadyNotified([{ sat: 'CSS', body: 'Sun', event_at_ms: t }], ev)).toBe(false);
    expect(alreadyNotified([{ sat: 'ISS', body: 'Moon', event_at_ms: t }], ev)).toBe(false);
    expect(alreadyNotified([{ sat: 'ISS', body: 'Sun', event_at_ms: t + 2 * HOUR }], ev)).toBe(false);
  });
});

describe('action tokens', () => {
  const secret = 'test-secret';
  const id = '3f1c2d4e-aaaa-bbbb-cccc-1234567890ab';

  it('round-trips', () => {
    expect(verifyActionToken(actionToken(id, secret), secret)).toBe(id);
  });

  it('rejects tampering, wrong secret and junk', () => {
    const tok = actionToken(id, secret);
    expect(verifyActionToken(tok.slice(0, -1) + '0', secret)).toBeNull();
    expect(verifyActionToken(tok.replace(id, 'other-id'), secret)).toBeNull();
    expect(verifyActionToken(tok, 'wrong')).toBeNull();
    expect(verifyActionToken('garbage', secret)).toBeNull();
    expect(verifyActionToken(null, secret)).toBeNull();
  });
});

describe('formatAlert / fmtLocal', () => {
  it('renders timezone-local time and the unsubscribe link', () => {
    const ev = cand({ closestApproachAtMs: Date.UTC(2026, 5, 14, 12, 2, 31) });
    const { title, message } = formatAlert(ev, { tz: 'Europe/Berlin' },
      { unsubscribeUrl: 'https://x.test/unsubscribe?token=abc' });
    expect(title).toContain('ISS');
    expect(title).toContain('Sun');
    expect(message).toContain('14:02:31');           // 12:02:31 UTC = 14:02 CEST
    expect(message).toContain('6.0′');               // 0.1° = 6 arcmin
    expect(message).toContain('https://x.test/unsubscribe?token=abc');
  });

  it('falls back to UTC on a bad timezone', () => {
    expect(fmtLocal(Date.UTC(2026, 0, 1), 'Not/AZone')).toContain('UTC');
  });
});

describe('SATELLITES', () => {
  it('matches the catalogue list in scripts/refresh-tle.js', () => {
    expect(SATELLITES.map((s) => s.catnr).sort()).toEqual([20580, 25544, 48274]);
  });
});
