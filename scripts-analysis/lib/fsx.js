/**
 * Manifest Analyzer — guarded filesystem writes.
 *
 * Every write in this toolkit funnels through here. The guard is the mechanism
 * that enforces the toolkit's core promise: output can only ever land inside
 * analysis/. A path escaping that root is a bug, so it throws rather than writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ANALYSIS, DIRS } from './config.js';

function assertInsideAnalysis(target) {
  const resolved = path.resolve(target);
  const root = path.resolve(ANALYSIS);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Manifest Analyzer refused a write outside analysis/: ${resolved}\n` +
      'This toolkit is read-only with respect to application source.'
    );
  }
  return resolved;
}

export function ensureDirs() {
  for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });
}

/** Write text to an absolute path inside analysis/. Returns the path written. */
export function write(target, content) {
  const resolved = assertInsideAnalysis(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');
  return resolved;
}

export const writeJson = (target, data) => write(target, `${JSON.stringify(data, null, 2)}\n`);

/** Read a file from anywhere, returning `fallback` instead of throwing. */
export function readSafe(target, fallback = '') {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return fallback;
  }
}

export function readJsonSafe(target, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return fallback;
  }
}

export const exists = (target) => fs.existsSync(target);

export const rel = (target) => path.relative(ANALYSIS, target).split(path.sep).join('/');
