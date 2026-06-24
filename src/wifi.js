// Off-road WiFi onboarding for the Pi (v0.51.0).
//
// Goal: the device just works in the field with no terminal. NetworkManager
// autoconnects to any saved home WiFi; if none is in range a failover unit
// brings up a self-hosted access point (default SSID `sunmoontransits`) so the
// user can reach the web UI from a phone/iPad, pick a real network and join it
// — all from the browser.
//
// This module is split in two:
//   - PURE helpers (credentials, QR payload, nmcli parsing + arg building) with
//     ZERO side effects, so they are fully unit-tested off-Pi.
//   - Thin wrappers that exec `nmcli` for READ ops (scan/status — these work as
//     the unprivileged service user) and, for the privileged WRITE op (join a
//     network), write a small trigger file that a root-owned systemd .path unit
//     consumes. The unauthenticated LAN HTTP layer therefore never gains nmcli
//     or sudo — the exact model the click-to-update path already uses.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Password alphabet WITHOUT visually ambiguous characters (0/O, 1/l/I) so a
// short code printed on the e-paper is unmistakable to type on a phone.
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * A stable per-device serial: Raspberry Pi `/proc/cpuinfo` Serial → machine-id
 * → hostname → a constant. Used to derive a device-unique AP password that is
 * reproducible across reboots without persisting anything.
 * @param {{readFile?: (p:string)=>string}} [deps]
 */
export function readMachineSerial({ readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    const m = readFile('/proc/cpuinfo').match(/^Serial\s*:\s*([0-9a-fA-F]+)/m);
    if (m && m[1]) return m[1];
  } catch { /* not a Pi — fall through */ }
  try { const id = readFile('/etc/machine-id').trim(); if (id) return id; } catch { /* … */ }
  try { const h = readFile('/etc/hostname').trim(); if (h) return h; } catch { /* … */ }
  return 'stp-default';
}

/**
 * Device-unique AP credentials. The SSID defaults to a fixed friendly name; the
 * password is `length` readable characters derived deterministically from the
 * device serial — short, easy to type, identical every boot, printable on the
 * e-paper. WPA2 requires ≥ 8 characters, so that is the floor.
 *
 * @param {{serial?: string, ssid?: string, length?: number}} [o]
 * @returns {{ssid: string, password: string}}
 */
export function deriveApCredentials({ serial, ssid = 'sunmoontransits', length = 8 } = {}) {
  const n = Math.max(8, length | 0);
  const h = createHash('sha256').update(`stp-ap:${serial ?? ''}`).digest();
  let password = '';
  for (let i = 0; i < n; i++) password += PW_ALPHABET[h[i % h.length] % PW_ALPHABET.length];
  return { ssid, password };
}

/** Escape a value for a WIFI: QR payload — `\ ; , : "` are control characters. */
function escapeWifiValue(v) {
  return String(v ?? '').replace(/([\\;,:"])/g, '\\$1');
}

/**
 * Standard WiFi-provisioning QR payload. Scanning it with the iOS/Android camera
 * offers a one-tap "Join network", so the user never types the AP password.
 * @param {{ssid: string, password: string, hidden?: boolean}} o
 */
export function wifiQrPayload({ ssid, password, hidden = false }) {
  return `WIFI:T:WPA;S:${escapeWifiValue(ssid)};P:${escapeWifiValue(password)};H:${hidden ? 'true' : 'false'};;`;
}

// ---- nmcli argument builders (pure) ----------------------------------------

/** `nmcli` args to list nearby networks (terse, machine-parseable). */
export function scanArgs() {
  return ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list', '--rescan', 'auto'];
}

/** `nmcli` args for the per-device link state. */
export function statusArgs() {
  return ['-t', '-f', 'TYPE,STATE,CONNECTION', 'dev', 'status'];
}

/** Split one nmcli terse line, honouring its `\:` / `\\` field escaping. */
function splitTerse(line) {
  const fields = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
    if (c === ':') { fields.push(cur); cur = ''; continue; }
    cur += c;
  }
  fields.push(cur);
  return fields;
}

/**
 * Parse `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY dev wifi list` into a deduped,
 * signal-sorted network list. Hidden (empty-SSID) rows are dropped; the active
 * one floats to the top.
 * @param {string} stdout
 * @returns {Array<{ssid:string, active:boolean, signal:number|null, security:string, secured:boolean}>}
 */
export function parseWifiList(stdout) {
  const best = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    const [inUse, ssid, signal, security] = splitTerse(line);
    if (!ssid) continue;                                  // hidden network
    const sig = Number.isFinite(+signal) ? +signal : null;
    const secured = !!security && security !== '--';
    const rec = { ssid, active: inUse === '*', signal: sig, security: secured ? security : 'open', secured };
    const prev = best.get(ssid);
    if (!prev || rec.active || (rec.signal ?? -1) > (prev.signal ?? -1)) best.set(ssid, rec);
  }
  return [...best.values()].sort((a, b) => (Number(b.active) - Number(a.active))
    || ((b.signal ?? -1) - (a.signal ?? -1)));
}

/**
 * Parse `nmcli -t -f TYPE,STATE,CONNECTION dev status` into the WiFi link state.
 * The AP profile name (so we can tell "hosting the AP" from "joined a network").
 * @param {string} stdout
 * @param {{apProfile?: string}} [o]
 * @returns {{mode:'client'|'ap'|'offline'|'unknown', ssid:string|null}}
 */
export function parseWifiStatus(stdout, { apProfile = 'sunmoontransits' } = {}) {
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    const [type, state, connection] = splitTerse(line);
    if (type !== 'wifi') continue;
    if (state !== 'connected') return { mode: 'offline', ssid: null };
    const isAp = connection === apProfile || /(?:^|[-_])ap$/i.test(connection || '');
    return { mode: isAp ? 'ap' : 'client', ssid: connection || null };
  }
  return { mode: 'unknown', ssid: null };
}

// ---- exec wrappers (read-only) + trigger-file connect (write) ---------------

/** Promise wrapper around execFile, surfacing nmcli's stderr as the error. */
function run(bin, args, { execImpl = execFile, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    execImpl(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || '').trim() || err.message));
      resolve(String(stdout ?? ''));
    });
  });
}

/** Scan nearby networks (read-only; works as the unprivileged service user). */
export async function scanNetworks(opts = {}) {
  return parseWifiList(await run('nmcli', scanArgs(), opts));
}

/** Current WiFi link state (read-only). */
export async function getWifiStatus(opts = {}) {
  const apProfile = opts.apProfile;
  return parseWifiStatus(await run('nmcli', statusArgs(), opts), { apProfile });
}

/**
 * Request a join to `ssid`. The privileged stp-wifi.path unit observes the
 * trigger file and runs the actual `nmcli con add/up` as root, so the HTTP layer
 * never executes a privileged nmcli itself. The PSK is written 0600 and is never
 * logged or echoed back through the API.
 *
 * @param {{ssid:string, psk?:string, triggerPath:string,
 *   write?:Function, mkdir?:Function, now?:number}} o
 */
export function requestConnect({ ssid, psk, triggerPath, write = writeFileSync, mkdir = mkdirSync, now }) {
  if (!ssid || typeof ssid !== 'string') throw new Error('ssid required');
  if (!triggerPath) throw new Error('wifi trigger path not configured');
  mkdir(dirname(triggerPath), { recursive: true });
  const payload = JSON.stringify({ ssid, psk: psk ?? '', requestedAtMs: now ?? Date.now() });
  write(triggerPath, payload, { mode: 0o600 });
  return { ok: true, message: `join requested for "${ssid}"` };
}
