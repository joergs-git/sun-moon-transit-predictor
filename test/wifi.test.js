import { describe, expect, it } from 'vitest';
import {
  readMachineSerial,
  deriveApCredentials,
  wifiQrPayload,
  scanArgs,
  statusArgs,
  parseWifiList,
  parseWifiStatus,
  requestConnect,
} from '../src/wifi.js';

describe('AP credentials (v0.51.0)', () => {
  it('derives a stable, readable, device-unique password from the serial', () => {
    const a = deriveApCredentials({ serial: '10000000abcd1234' });
    const b = deriveApCredentials({ serial: '10000000abcd1234' });
    const c = deriveApCredentials({ serial: 'deadbeefdeadbeef' });
    expect(a).toEqual(b);                       // deterministic across reboots
    expect(a.password).not.toBe(c.password);    // device-unique
    expect(a.ssid).toBe('sunmoontransits');     // friendly default SSID
    expect(a.password).toHaveLength(8);         // WPA2 floor, short + simple
    expect(a.password).toMatch(/^[a-z2-9]+$/);  // no ambiguous 0/o/1/l/i
  });

  it('honours a custom SSID and length floor of 8', () => {
    const { ssid, password } = deriveApCredentials({ serial: 'x', ssid: 'fieldscope', length: 4 });
    expect(ssid).toBe('fieldscope');
    expect(password.length).toBeGreaterThanOrEqual(8);
  });

  it('reads the Pi serial, falling back to machine-id then hostname', () => {
    const pi = readMachineSerial({ readFile: (p) => p === '/proc/cpuinfo' ? 'foo\nSerial : 10000000abcd1234\n' : (() => { throw new Error('nope'); })() });
    expect(pi).toBe('10000000abcd1234');
    const mid = readMachineSerial({ readFile: (p) => { if (p === '/etc/machine-id') return 'abc123\n'; throw new Error('nope'); } });
    expect(mid).toBe('abc123');
    expect(readMachineSerial({ readFile: () => { throw new Error('nope'); } })).toBe('stp-default');
  });
});

describe('WiFi-join QR payload', () => {
  it('builds the standard WIFI: provisioning URI', () => {
    expect(wifiQrPayload({ ssid: 'sunmoontransits', password: 'k7m4p9rt' }))
      .toBe('WIFI:T:WPA;S:sunmoontransits;P:k7m4p9rt;H:false;;');
  });
  it('escapes the special characters \\ ; , : "', () => {
    const qr = wifiQrPayload({ ssid: 'my;net:work', password: 'a"b\\c,d' });
    expect(qr).toContain('S:my\\;net\\:work;');
    expect(qr).toContain('P:a\\"b\\\\c\\,d;');
  });
});

describe('nmcli parsing', () => {
  it('scanArgs / statusArgs request terse, machine-parseable output', () => {
    expect(scanArgs()).toContain('-t');
    expect(scanArgs()).toEqual(expect.arrayContaining(['dev', 'wifi', 'list']));
    expect(statusArgs()).toEqual(expect.arrayContaining(['dev', 'status']));
  });

  it('parses a wifi list: dedupes by SSID, sorts active-then-signal, maps security', () => {
    const out = [
      ' :HomeNet:42:WPA2',
      '*:HomeNet:75:WPA2',     // same SSID, stronger + active → wins
      ' :CafeOpen:60:',        // open network
      ' ::55:WPA2',           // hidden (empty SSID) → dropped
    ].join('\n');
    const list = parseWifiList(out);
    expect(list).toHaveLength(2);
    expect(list[0].ssid).toBe('HomeNet');     // active floats to top
    expect(list[0].active).toBe(true);
    expect(list[0].signal).toBe(75);
    expect(list[0].secured).toBe(true);
    const cafe = list.find((n) => n.ssid === 'CafeOpen');
    expect(cafe.secured).toBe(false);
    expect(cafe.security).toBe('open');
  });

  it('honours the \\: escape inside an SSID', () => {
    const list = parseWifiList(' :My\\:Net:50:WPA2');
    expect(list[0].ssid).toBe('My:Net');
  });

  it('classifies link state: ap vs client vs offline', () => {
    const ap = 'wifi:connected:sunmoontransits\nethernet:unavailable:';
    expect(parseWifiStatus(ap)).toEqual({ mode: 'ap', ssid: 'sunmoontransits' });
    const client = 'wifi:connected:HomeNet';
    expect(parseWifiStatus(client)).toEqual({ mode: 'client', ssid: 'HomeNet' });
    expect(parseWifiStatus('wifi:disconnected:')).toEqual({ mode: 'offline', ssid: null });
  });
});

describe('requestConnect (trigger-file, no privileged exec)', () => {
  it('writes an 0600 trigger file with the ssid + psk and never returns the psk', () => {
    let written = null;
    const res = requestConnect({
      ssid: 'HomeNet', psk: 'secret-pw', triggerPath: '/run/stp/wifi-connect.json',
      mkdir: () => {}, write: (path, data, opts) => { written = { path, data, opts }; }, now: 123,
    });
    expect(res.ok).toBe(true);
    expect(res.message).not.toContain('secret-pw');     // psk never echoed back
    expect(written.path).toBe('/run/stp/wifi-connect.json');
    expect(written.opts).toMatchObject({ mode: 0o600 });
    expect(JSON.parse(written.data)).toEqual({ ssid: 'HomeNet', psk: 'secret-pw', requestedAtMs: 123 });
  });

  it('throws without an ssid or a configured trigger path', () => {
    expect(() => requestConnect({ triggerPath: '/x', write: () => {}, mkdir: () => {} })).toThrow(/ssid/);
    expect(() => requestConnect({ ssid: 'X', write: () => {}, mkdir: () => {} })).toThrow(/trigger path/);
  });
});
