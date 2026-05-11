#!/usr/bin/env node
// One-shot Pushover sanity check. Loads config/service.json (or the path in
// $STP_CONFIG), reuses the production PushoverClient, and sends a single
// low-priority message. Verifies token, user key, network and TLS in one
// shot. Exits 0 on success, 1 on disabled / missing config / failure.
//
//   node scripts/test-push.js
//   node scripts/test-push.js "custom message"

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PushoverClient } from '../src/pushover.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = process.env.STP_CONFIG ?? resolve(ROOT, 'config', 'service.json');

if (!existsSync(cfgPath)) {
  console.error(`config not found: ${cfgPath}`);
  console.error('run scripts/install-pi5.sh, or copy config/service.example.json first.');
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const client = new PushoverClient(cfg.pushover ?? {});

if (!client.enabled) {
  console.error('pushover: disabled (missing token/user or enabled=false in service.json)');
  process.exit(1);
}

const message = process.argv.slice(2).join(' ') || 'sun-moon-transit-predictor: test push';

try {
  const res = await client.send({ title: 'STP test', message, priority: 0 });
  console.log(`pushover: sent (status=${res.response?.status}, request=${res.response?.request})`);
} catch (e) {
  console.error('pushover: failed —', e.message);
  if (e.response) console.error(JSON.stringify(e.response, null, 2));
  process.exit(1);
}
