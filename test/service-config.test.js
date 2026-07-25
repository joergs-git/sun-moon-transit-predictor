import { describe, expect, it } from 'vitest';
import { mergeConfig, DEFAULT_CONFIG } from '../src/service.js';

describe('mergeConfig', () => {
  it('deep-merges a partial user.wifi so the default triggerPath survives', () => {
    // Exactly what scripts/install-pi5.sh writes into service.json: a partial
    // wifi block with no triggerPath. A shallow `...user` would drop the
    // default triggerPath and the web-UI join then fails with
    // "wifi trigger path not configured" (regression guard).
    const cfg = mergeConfig({
      wifi: { enabled: true, apSsid: 'sunmoontransits', apPassword: 'secret' },
    });
    expect(cfg.wifi.triggerPath).toBe(DEFAULT_CONFIG.wifi.triggerPath);
    expect(cfg.wifi.statusPollMs).toBe(DEFAULT_CONFIG.wifi.statusPollMs);
    // …while the user's own values still win.
    expect(cfg.wifi.enabled).toBe(true);
    expect(cfg.wifi.apSsid).toBe('sunmoontransits');
    expect(cfg.wifi.apPassword).toBe('secret');
  });

  it('falls back to the full default wifi block when user omits it', () => {
    const cfg = mergeConfig({});
    expect(cfg.wifi).toEqual(DEFAULT_CONFIG.wifi);
  });

  it('deep-merges other nested blocks too (spot-check display + tracker)', () => {
    const cfg = mergeConfig({ display: { enabled: true }, tracker: {} });
    expect(cfg.display.enabled).toBe(true);
    expect(cfg.display.quickRefreshS).toBe(DEFAULT_CONFIG.display.quickRefreshS);
    expect(cfg.tracker).toEqual(DEFAULT_CONFIG.tracker);
  });

  it('carries the trust-scaled freshness knobs and keeps user overrides (v0.60.0)', () => {
    // Defaults present so an existing service.json without them still gets the
    // graduated gate (band-edge 120 s → dead-centre 300 s, centre at 0.1°).
    expect(DEFAULT_CONFIG.sharpcap.maxExtrapolationS).toBe(120);
    expect(DEFAULT_CONFIG.sharpcap.maxExtrapolationHardS).toBe(300);
    expect(DEFAULT_CONFIG.sharpcap.centerSepDeg).toBe(0.1);
    // A partial sharpcap block keeps the new defaults while the user's own value wins.
    const cfg = mergeConfig({ sharpcap: { maxExtrapolationHardS: 420 } });
    expect(cfg.sharpcap.maxExtrapolationHardS).toBe(420);
    expect(cfg.sharpcap.maxExtrapolationS).toBe(120);
    expect(cfg.sharpcap.centerSepDeg).toBe(0.1);
  });
});
