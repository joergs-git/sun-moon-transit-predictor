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
});
