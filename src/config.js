import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG_PATH = resolve(ROOT, 'config', 'observer.json');
const EXAMPLE_CONFIG_PATH = resolve(ROOT, 'config', 'observer.example.json');

/**
 * Load an Observer object from a JSON file. Defaults to config/observer.json
 * relative to the package root. observer.json is per-site and gitignored so
 * `git pull` cannot overwrite it; if it is missing, point the user at the
 * example template + the installer.
 *
 * @param {string} [path]
 * @returns {import('./geometry.js').Observer}
 */
export function loadObserver(path = DEFAULT_CONFIG_PATH) {
  if (!existsSync(path)) {
    const hint = existsSync(EXAMPLE_CONFIG_PATH)
      ? `Copy config/observer.example.json → ${path} and edit it, or run scripts/install-pi5.sh.`
      : `Create ${path} with at least latitudeDeg, longitudeDeg and elevationM.`;
    throw new Error(`Observer config not found at ${path}.\n${hint}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const required = ['latitudeDeg', 'longitudeDeg', 'elevationM'];
  for (const key of required) {
    if (typeof raw[key] !== 'number') {
      throw new Error(`Observer config is missing required numeric field "${key}" (path: ${path})`);
    }
  }
  return raw;
}
