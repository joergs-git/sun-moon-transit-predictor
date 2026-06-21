// Tests for the operator-class classifier + pipeline filter (v0.48.0).
import { describe, it, expect } from 'vitest';
import { classifyAircraft, filterAircraft, AIRCRAFT_CLASSES } from '../src/aircraftclass.js';

describe('classifyAircraft', () => {
  it('flags a German Air Force call-sign as military', () => {
    expect(classifyAircraft({ callsign: 'GAF123', icao: '3f0001' })).toBe('military');
  });

  it('flags a US military ICAO address block as military even without a call-sign', () => {
    expect(classifyAircraft({ callsign: '', icao: 'ae1234' })).toBe('military');
  });

  it('flags a UK military address block as military', () => {
    expect(classifyAircraft({ icao: '43c123' })).toBe('military');
  });

  it('reads a scheduled airline flight number as commercial', () => {
    expect(classifyAircraft({ callsign: 'DLH2AB', icao: '3c6444' })).toBe('commercial');
    expect(classifyAircraft({ callsign: 'BAW117', icao: '400000' })).toBe('commercial');
  });

  it('reads an all-letter registration call-sign as general aviation', () => {
    expect(classifyAircraft({ callsign: 'DEABC', icao: '3c0123' })).toBe('ga');
    expect(classifyAircraft({ callsign: 'PHXYZ', icao: '484abc' })).toBe('ga');
  });

  it('uses the light ADS-B emitter category for GA when no call-sign', () => {
    expect(classifyAircraft({ callsign: '', category: 'A1', icao: '3c0123' })).toBe('ga');
  });

  it('uses a heavy ADS-B category as commercial when the call-sign is uninformative', () => {
    expect(classifyAircraft({ callsign: '', category: 'A5', icao: '3c0123' })).toBe('commercial');
  });

  it('returns unknown when nothing is decodable yet', () => {
    expect(classifyAircraft({ callsign: '', category: '', icao: '' })).toBe('unknown');
    expect(classifyAircraft({})).toBe('unknown');
  });

  it('prefers the military call-sign over an airline-looking pattern', () => {
    // RCH4 looks vaguely flight-numbered but RCH is a US military prefix.
    expect(classifyAircraft({ callsign: 'RCH4', icao: 'ae9999' })).toBe('military');
  });
});

describe('filterAircraft', () => {
  const sample = () => ([
    { icao: 'ae0001', callsign: 'GAF777' },          // military
    { icao: '3c0001', callsign: 'DLH88' },            // commercial
    { icao: '3c0002', callsign: 'DEKLM' },            // ga
    { icao: '3c0003', callsign: '', category: '' },   // unknown
  ]);

  it('tags every aircraft with its class even when disabled', () => {
    const { kept, dropped } = filterAircraft(sample(), { enabled: false });
    expect(dropped).toBe(0);
    expect(kept.map((a) => a.aircraftClass)).toEqual(['military', 'commercial', 'ga', 'unknown']);
  });

  it('keeps only the selected classes when enabled', () => {
    const { kept, dropped, total } = filterAircraft(sample(), { enabled: true, classes: ['military'] });
    expect(total).toBe(4);
    expect(dropped).toBe(3);
    expect(kept).toHaveLength(1);
    expect(kept[0].callsign).toBe('GAF777');
  });

  it('excludes unknown when a specific class is selected', () => {
    const { kept } = filterAircraft(sample(), { enabled: true, classes: ['ga', 'commercial'] });
    expect(kept.map((a) => a.callsign).sort()).toEqual(['DEKLM', 'DLH88']);
  });

  it('treats an empty class list as no-op (pass through)', () => {
    const { kept, dropped } = filterAircraft(sample(), { enabled: true, classes: [] });
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(4);
  });

  it('exposes the three selectable classes', () => {
    expect(AIRCRAFT_CLASSES).toEqual(['military', 'ga', 'commercial']);
  });
});
