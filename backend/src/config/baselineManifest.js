/**
 * The migrations the committed baseline snapshot claims to embody.
 *
 * Read lazily and cached: this runs inside the warning path on every migrate
 * and every /api/health call, and the file does not change while the process
 * lives. A missing or malformed manifest yields an empty set — the caller then
 * falls through to its name-based rules, which is the pre-existing behaviour,
 * so a broken manifest degrades the explanation rather than the run.
 *
 * Importing this opens no connection, so the deploy scripts can use it too.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../database/baseline-manifest.json');

let cache = null;
export function baselineManifestNames() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    cache = new Set(Array.isArray(raw?.migrations) ? raw.migrations : []);
  } catch {
    cache = new Set();
  }
  return cache;
}
