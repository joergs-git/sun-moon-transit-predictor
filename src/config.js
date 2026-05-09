import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DEFAULT_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'config',
  'observer.json',
);

/**
 * Load an Observer object from a JSON file. Defaults to config/observer.json
 * relative to the package root.
 *
 * @param {string} [path]
 * @returns {import('./geometry.js').Observer}
 */
export function loadObserver(path = DEFAULT_CONFIG_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const required = ['latitudeDeg', 'longitudeDeg', 'elevationM'];
  for (const key of required) {
    if (typeof raw[key] !== 'number') {
      throw new Error(`Observer config is missing required numeric field "${key}" (path: ${path})`);
    }
  }
  return raw;
}
