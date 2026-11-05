/**
 * sharedPoolLifecycle.contract.test.js — no suite may close the shared pool.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * `src/config/db.js` exports ONE pool per vitest worker, and vitest packs many
 * test FILES into each worker (4 workers, pinned in vitest.config.js as half of
 * a connection budget). A file that calls `pool.end()` in afterAll therefore
 * does not close "its" pool — it closes the pool belonging to every other file
 * scheduled after it in that worker.
 *
 * The failure never names the cause. The suites that lose their connection
 * report `Connection terminated unexpectedly`, or their tests are reported
 * SKIPPED, in files nobody edited. Which files are affected depends on how
 * vitest packed them, so it moves between runs: the same seven files here gave
 * `3 failed | 20 skipped` and then `59 passed` on consecutive runs with no edit
 * in between. That is indistinguishable from environmental flake, and it is how
 * 19 files came to carry the call before anyone noticed.
 *
 * Nothing has to close it. The pool dies with the worker process, and
 * `src/__tests__/setup.js` deliberately has no global teardown.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SELF = 'sharedPoolLifecycle.contract.test.js';

// Comments are not calls — this file discusses `pool.end()` at length, and so
// do the teardowns that explain why they no longer call it.
function stripComments(src) {
  let out = '', i = 0, quote = null;
  while (i < src.length) {
    const c = src[i], next = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

describe('shared pg pool lifecycle', () => {
  it('is closed by no test file', () => {
    const offenders = fs.readdirSync(DIR)
      .filter(f => f.endsWith('.js') && f !== SELF)
      .filter(f => /\bpool\s*\.\s*end\s*\(/.test(stripComments(fs.readFileSync(path.join(DIR, f), 'utf8'))));

    expect(offenders, [
      'These suites close the pool that the rest of their vitest worker is still using:',
      ...offenders.map(f => `  ${f}`),
      'Delete the call — the pool dies with the worker.',
    ].join('\n')).toEqual([]);
  });
});
