import { describe, expect, it } from 'vitest';
import {
  AIRCRAFT_TYPES,
  resolveAircraftType,
  designAgePhrase,
  klassLabel,
} from '../web/aircraft-types.js';

describe('resolveAircraftType', () => {
  it('resolves a well-known type designator', () => {
    const a320 = resolveAircraftType('A320');
    expect(a320).toBeTruthy();
    expect(a320.manufacturer).toBe('Airbus');
    expect(a320.wingspanM).toBeCloseTo(35.8, 1);
    expect(a320.klass).toBe('narrowbody');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveAircraftType('  b738 ')).toBe(AIRCRAFT_TYPES.B738);
  });

  it('folds a known variant alias onto its representative entry', () => {
    expect(resolveAircraftType('CR9')).toBe(AIRCRAFT_TYPES.CRJ9);
  });

  it('returns null for unknown / empty input (generic fallback path)', () => {
    expect(resolveAircraftType('ZZZZ')).toBeNull();
    expect(resolveAircraftType('')).toBeNull();
    expect(resolveAircraftType(null)).toBeNull();
    expect(resolveAircraftType(undefined)).toBeNull();
  });

  it('every table entry carries positive physical dimensions', () => {
    for (const [code, s] of Object.entries(AIRCRAFT_TYPES)) {
      expect(s.lengthM, code).toBeGreaterThan(0);
      expect(s.wingspanM, code).toBeGreaterThan(0);
      expect(s.mtowKg, code).toBeGreaterThan(0);
      expect(s.firstYear, code).toBeGreaterThan(1950);
    }
  });
});

describe('designAgePhrase', () => {
  it('reports an approximate type age relative to the reference year', () => {
    expect(designAgePhrase(1988, 2026)).toMatch(/1988/);
    expect(designAgePhrase(1988, 2026)).toMatch(/38 yr/);
  });

  it('handles a not-yet-or-just-introduced design gracefully', () => {
    expect(designAgePhrase(2026, 2026)).toMatch(/brand-new/);
    expect(designAgePhrase(NaN)).toBe('—');
  });
});

describe('klassLabel', () => {
  it('maps the class enum to a readable label', () => {
    expect(klassLabel('widebody')).toBe('wide-body airliner');
    expect(klassLabel('ga')).toBe('general aviation');
    expect(klassLabel('weird')).toBe('weird');
  });
});
