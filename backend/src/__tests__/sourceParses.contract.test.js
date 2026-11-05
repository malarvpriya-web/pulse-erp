/**
 * sourceParses.contract.test.js — every backend source file must PARSE.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A syntax error in this codebase is not reliably caught by the test suite,
 * because a file is only parsed when something imports it. 1026 source files;
 * the suites import a fraction of them directly. A route file, a cron, a service
 * or a migration that no test touches can sit broken until the server boots —
 * and this repo has already shipped exactly that:
 *
 *   - a BACKTICK INSIDE A SQL COMMENT, which terminates the enclosing JS
 *     template literal. Written as
 *         pool.query(`SELECT … -- why `quantity_remaining` is the quantity …`)
 *     it fails with "SyntaxError: missing ) after argument list" pointing at the
 *     `pool.query(` line, NOT at the comment — so it reads as a broken call
 *     rather than a broken string. (Recorded separately as a gotcha because the
 *     error message actively misdirects.)
 *   - a backtick in a SQL comment that stopped the server booting at all.
 *
 * Both are the same class: prose written inside SQL that is itself inside a
 * template literal. They are trivial to make, invisible on review, and their
 * error messages point somewhere else.
 *
 * ── WHY A PARSER AND NOT A LINTER RULE ──────────────────────────────────────
 * The defect is not a style violation — it is a file that cannot be parsed. The
 * cheapest complete check is therefore to parse every file, which also catches
 * every OTHER syntax error for free, including in files no test imports.
 *
 * ── WHY NOT `import()` EVERY FILE ───────────────────────────────────────────
 * Because importing executes. 17 route files in this repo run top-level async
 * IIFE DDL at import time, `jobs/leave.cron.js` calls `cron.schedule()` at module
 * scope, and several modules open pool connections. Importing all of them to
 * check syntax would run DDL and start crons inside the test suite. This parses
 * and never evaluates.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 * ~1s for 1026 files, in-process, no subprocess spawns. Deliberately not
 * `node --check`: that is one process spawn per file (~35s here), and
 * spawn-heavy suites have been a suspect in this repo's runner-crash
 * investigations.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BACKEND = path.resolve(HERE, '../..');

/** Directories to parse, relative to backend/. */
const ROOTS = ['src', 'scripts'];
/** Plus these individual files at the backend root. */
const EXTRA_FILES = ['server.js'];

const SKIP_DIRS = new Set(['node_modules', 'uploads', 'backups', 'logs']);

/**
 * The parser.
 *
 * `transformWithOxc` is what Vite now points at — `transformWithEsbuild` is
 * deprecated and, in this install, throws because esbuild is not a direct
 * dependency. esbuild and acorn are both absent from backend/node_modules, so
 * Vite's bundled oxc is the only in-process parser available here.
 *
 * ⚠ If a future Vite renames or removes this, the test FAILS rather than skips.
 * A guard that silently stops running is worse than no guard: it reports green
 * while checking nothing, which is the failure mode this whole file exists to
 * prevent one level down.
 */
let parse = null;

beforeAll(async () => {
  const vite = await import('vite');
  if (typeof vite.transformWithOxc === 'function') {
    parse = (code, id) => vite.transformWithOxc(code, id);
    return;
  }
  if (typeof vite.transformWithEsbuild === 'function') {
    parse = (code, id) => vite.transformWithEsbuild(code, id, { loader: 'js' });
    return;
  }
  // Left null on purpose — the first test asserts it is callable and says why.
});

function collect() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (/\.(js|mjs)$/.test(e.name)) {
        files.push(full);
      }
    }
  };
  for (const r of ROOTS) walk(path.join(BACKEND, r));
  for (const f of EXTRA_FILES) {
    const full = path.join(BACKEND, f);
    if (fs.existsSync(full)) files.push(full);
  }
  return files;
}

describe('backend source parses', () => {
  it('has a working parser — a guard that cannot run must fail, not skip', async () => {
    expect(
      parse,
      'No in-process JS parser is available. Vite no longer exposes transformWithOxc ' +
      'or transformWithEsbuild, and neither esbuild nor acorn is a backend dependency. ' +
      'Pick a parser and wire it up here — do not delete this test; it is the only ' +
      'thing that parses the ~1000 source files no suite imports.',
    ).toBeTypeOf('function');
  });

  it('actually rejects the defect it is guarding against', async () => {
    // ⚠ ANTI-VACUOUS CHECK. If the parser were a no-op, the sweep below would be
    // green over a codebase full of syntax errors. This is the exact shape that
    // broke this repo: a backtick inside a SQL comment inside a template literal.
    const backtickInSqlComment =
      'const q = pool.query(`SELECT 1 AS n -- why `col` matters\n`);';
    await expect(parse(backtickInSqlComment, 'backtick.js')).rejects.toThrow();

    // And a plainly broken file, so the check is not specific to one trick.
    await expect(parse('function ( {', 'broken.js')).rejects.toThrow();

    // Paired positive: valid code with SQL in a template literal must PASS, or
    // the test above would be satisfied by a parser that rejects everything.
    const ok = 'const q = pool.query(`SELECT 1 AS n -- why col matters\n`);';
    await expect(parse(ok, 'ok.js')).resolves.toBeTruthy();
  });

  it('finds the files it is supposed to be guarding', () => {
    // A broken glob would make the sweep vacuously green. The floor is well below
    // the current count (~1026) so ordinary growth or pruning does not trip it,
    // but a roots/extension mistake that collapses the list does.
    expect(collect().length).toBeGreaterThan(500);
  });

  it('parses every file under src/, scripts/ and server.js', async () => {
    const files = collect();
    const failures = [];

    for (const file of files) {
      let code;
      try {
        code = fs.readFileSync(file, 'utf8');
      } catch (e) {
        failures.push(`${path.relative(BACKEND, file)} — unreadable: ${e.message}`);
        continue;
      }
      try {
        await parse(code, file);
      } catch (e) {
        // One line per file. The parser's own message carries the position, which
        // is the part a maintainer needs — and, for the backtick case, the part
        // that misdirects, so the relative path matters more than the column.
        const first = String(e?.message ?? e).split('\n').slice(0, 3).join(' ').trim();
        failures.push(`${path.relative(BACKEND, file).replace(/\\/g, '/')} — ${first}`);
      }
    }

    // Named, not counted: the failure has to say WHICH file so it is actionable
    // without re-running anything.
    expect(failures, `source files that do not parse:\n  ${failures.join('\n  ')}`).toEqual([]);
  },
  /**
   * ⚠ EXPLICIT TIMEOUT, AND IT IS LOAD-BEARING. Parsing ~1026 files takes ~1s when
   * this file runs alone and comfortably over vitest's 5s DEFAULT when it runs
   * inside the full suite, where 4 workers are competing for the same cores. That
   * is not slowness to fix — it is real CPU work whose wall time depends on what
   * else is running.
   *
   * Caught exactly this way on the first full run: the failure read
   * "Test timed out in 5000ms", which names the test and says nothing about the
   * cause — the same misdirecting-error pattern this whole file exists to catch one
   * level down, and the symptom vitest.config.js's connection-budget note warns
   * about. 60s is ~20x the observed serial cost, so it fails only if something is
   * genuinely wrong rather than merely busy.
   */
  60_000);
});
