/**
 * analytics.schemaGuards.test.js — negative fixtures for the two schema gates.
 *
 * WHY THIS EXISTS
 * ---------------
 * `check-sql-references.mjs` and `check-status-vocabulary.mjs` are CI hard gates
 * for the Analytics & AI module. Both were green. Neither was trustworthy:
 *
 *  1. check-sql-references.mjs scanned 7 files. The module has 15 with SQL in
 *     them. Everything in the other 8 was unchecked, which is how
 *     `production_orders.completed_at` — a column that has never existed —
 *     survived in two live work-centre queries, reporting "0 orders in progress"
 *     while two orders sat in `planned`.
 *
 *  2. Its EXTRACT(unit FROM col) false-positive suppression contained a literal
 *     0x08 BACKSPACE byte where `\b` was intended, so the regex required a
 *     backspace character to match and never fired. Terminals render the byte by
 *     moving the cursor, so the line LOOKED correct in every editor and diff.
 *
 * A gate that only ever passes proves nothing. These tests inject a real defect
 * of each class and assert the checker fails with a non-zero exit. If someone
 * narrows the file list, breaks the parser, or downgrades an assertion, one of
 * these turns red.
 *
 * ISOLATION
 * ---------
 * The defect is injected into a COPY of the source tree, and the checker is
 * pointed at it with CHECK_SRC_ROOT. An earlier version edited the working tree
 * directly and crashed a sibling vitest worker: `statusSets.js` and
 * `analytics.routes.js` are imported by other test files, and rewriting one
 * mid-run left another worker reading a half-written file. The database is
 * still the real one — only the source location moves.
 *
 * Runner: Vitest | npx vitest run src/__tests__/analytics.schemaGuards.test.js
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');

/** Only the trees the checkers read. Copying node_modules would be absurd. */
const COPIED = ['src/analytics', 'src/modules', 'src/shared', 'src/config'];

let sandbox;

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-schema-guard-'));
  for (const rel of COPIED) {
    fs.cpSync(path.join(BACKEND, rel), path.join(sandbox, rel), { recursive: true });
  }
  // db.js reads ../../.env relative to itself; give the copy the same file so
  // the checker connects to the same database the working tree would.
  const env = path.join(BACKEND, '.env');
  if (fs.existsSync(env)) fs.copyFileSync(env, path.join(sandbox, '.env'));
});

afterAll(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Environment for the checker child process.
 *
 * `src/__tests__/setup.js` sets DB_PASSWORD to a sentinel so unit tests can
 * never touch a real database. The checkers deliberately let a real environment
 * variable beat `.env` (that is how CI supplies DATABASE_URL), so an inherited
 * sentinel would make every child fail with `auth_failed` — a red test that says
 * nothing about the schema. Stripping only the sentinel leaves a genuine
 * DB_PASSWORD or DATABASE_URL from the surrounding shell or CI intact.
 */
function checkerEnv(srcRoot) {
  const env = { ...process.env };
  if (env.DB_PASSWORD === 'test-db-password') delete env.DB_PASSWORD;
  delete env.NODE_ENV;   // the checkers are a dev/CI tool, not part of the test app
  if (srcRoot) env.CHECK_SRC_ROOT = srcRoot;
  else delete env.CHECK_SRC_ROOT;
  return env;
}

/** Run a checker; return { code, stdout }. Never throws on a non-zero exit. */
function runChecker(script, srcRoot, extraEnv = {}) {
  try {
    const stdout = execFileSync('node', [path.join('scripts', script)], {
      cwd: BACKEND, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...checkerEnv(srcRoot), ...extraEnv },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout ?? '') + (e.stderr ?? ''), stderr: e.stderr ?? '' };
  }
}

/** Inject `find` -> `replace` into the sandbox copy of `relPath`, run, restore. */
function withInjectedDefect(relPath, find, replace, fn) {
  const abs = path.join(sandbox, relPath);
  const original = fs.readFileSync(abs);
  const text = original.toString('utf8');
  // Sources in this repo are CRLF; anchors below are written LF for readability.
  const isCrlf = text.indexOf(String.fromCharCode(13, 10)) !== -1;
  const nl = (t) => (isCrlf ? t.split(String.fromCharCode(10)).join(String.fromCharCode(13, 10)) : t);
  const anchor = nl(find);
  expect(text.includes(anchor), `fixture anchor not found in ${relPath}: ${find}`).toBe(true);
  fs.writeFileSync(abs, text.replace(anchor, nl(replace)), 'utf8');
  try {
    return fn();
  } finally {
    fs.writeFileSync(abs, original);
  }
}

// These talk to Postgres and spawn a child process each; the default 5s is tight.
const OPTS = { timeout: 120_000 };

describe('check-sql-references.mjs actually detects defects', () => {
  // The checker now sweeps every SQL-bearing file under src/ rather than a
  // hand-maintained 15-file allowlist, and ratchets against
  // scripts/sql-reference-baseline.json: pre-existing findings are carried as
  // known debt, anything NEW fails the build. "Green" therefore means "no new
  // broken references", not "no broken references anywhere".
  test('baseline is green against the working tree', OPTS, () => {
    const { code, stdout } = runChecker('check-sql-references.mjs');
    expect(stdout, stdout).toMatch(/PASS — no new broken references/);
    expect(code).toBe(0);
  });

  test('baseline is green against the sandbox copy', OPTS, () => {
    // Proves CHECK_SRC_ROOT resolves the same files, so a later FAIL is caused
    // by the injected defect and not by the redirection itself.
    const { code, stdout } = runChecker('check-sql-references.mjs', sandbox);
    expect(stdout, stdout).toMatch(/PASS — no new broken references/);
    expect(code).toBe(0);
  });

  test('a scan that discovers no files fails instead of reporting PASS', OPTS, () => {
    // A checker guarding nothing must not look identical to a checker guarding
    // everything — that is how the stale allowlist stayed green for months.
    const { code, stdout, stderr } = runChecker('check-sql-references.mjs', undefined, {
      SCAN_ONLY: 'zz/no/such/path',
    });
    expect(`${stdout}${stderr}`).toMatch(/discovered no files/);
    expect(code).toBe(1);
  });

  test('detects a column that does not exist', OPTS, () => {
    withInjectedDefect(
      'src/analytics/routes/analytics.routes.js',
      '             e.department AS dept,',
      '             e.employee_full_name AS zz_injected,\n             e.department AS dept,',
      () => {
        const { code, stdout } = runChecker('check-sql-references.mjs', sandbox);
        expect(stdout).toMatch(/MISSING COLUMN\s+.*employees\.employee_full_name/);
        expect(code).toBe(1);
      },
    );
  });

  test('detects a table that does not exist', OPTS, () => {
    withInjectedDefect(
      'src/analytics/routes/analytics.routes.js',
      '      JOIN performance_reviews pr ON pr.employee_id = e.id',
      '      JOIN recruitment_costs rc ON rc.employee_id = e.id\n      JOIN performance_reviews pr ON pr.employee_id = e.id',
      () => {
        const { code, stdout } = runChecker('check-sql-references.mjs', sandbox);
        expect(stdout).toMatch(/MISSING TABLE\s+.*recruitment_costs/);
        expect(code).toBe(1);
      },
    );
  });

  test('covers the files that were outside the original 7-file scan', OPTS, () => {
    // manufacturing.routes.js was unscanned, which is exactly why
    // production_orders.completed_at survived there. A defect planted here must
    // now be caught, or the coverage fix has been reverted.
    withInjectedDefect(
      'src/analytics/routes/manufacturing.routes.js',
      '        FROM production_orders\n',
      '        FROM production_orders_zz_injected\n',
      () => {
        const { code, stdout } = runChecker('check-sql-references.mjs', sandbox);
        expect(stdout).toMatch(/MISSING TABLE\s+.*manufacturing\.routes\.js.*production_orders_zz_injected/);
        expect(code).toBe(1);
      },
    );
  });

  test('EXTRACT(unit FROM alias.col) is not reported as a missing table', OPTS, () => {
    // The suppression for this was dead for the life of the checker (0x08 byte).
    // Asserting the specific shape rather than the aggregate keeps a re-broken
    // regex attributable.
    const { stdout } = runChecker('check-sql-references.mjs');
    expect(stdout).not.toMatch(/MISSING TABLE\s+\S+\s+(te|la)\b/);
  });

  test('the checker source contains no control characters', OPTS, () => {
    // The backspace byte rendered as a correct-looking line in every editor.
    // Only a byte-level assertion can catch that class of corruption.
    for (const script of ['check-sql-references.mjs', 'check-status-vocabulary.mjs']) {
      const bytes = fs.readFileSync(path.join(BACKEND, 'scripts', script));
      const bad = [...new Set(bytes)].filter(
        (c) => c < 0x09 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f),
      );
      expect(bad.map((c) => '0x' + c.toString(16)), script).toEqual([]);
    }
  });
});

describe('check-status-vocabulary.mjs actually detects defects', () => {
  test('baseline is green', OPTS, () => {
    const { code, stdout } = runChecker('check-status-vocabulary.mjs');
    expect(stdout, stdout).toMatch(/PASS — every status value is covered by statusSets\.js/);
    expect(code).toBe(0);
  });

  test('every state column is swept for case drift', OPTS, () => {
    // The sweep is what makes the drift check real. If it silently swept zero
    // columns — a renamed information_schema predicate, a permission change —
    // it would report "ok" forever, which is the failure mode this asserts on:
    // a gate that cannot fail looks exactly like a gate that passes.
    const { stdout } = runChecker('check-status-vocabulary.mjs');
    const swept = /Case drift .*— (\d+) column\(s\) swept/.exec(stdout);
    expect(swept, stdout).not.toBeNull();
    expect(Number(swept[1])).toBeGreaterThan(50);
    expect(stdout).toMatch(/every state is stored under a single spelling/);
  });

  test('detects a status value dropped from a vocabulary set', OPTS, () => {
    // Dropping 'notice' is the original defect: employees.status holds 'Notice',
    // and its absence from EMPLOYEE_ACTIVE silently removed those people from
    // headcount, department, gender and salary aggregates.
    withInjectedDefect(
      'src/shared/statusSets.js',
      "export const EMPLOYEE_ACTIVE  = ['active', 'probation', 'notice', 'confirmed'];",
      "export const EMPLOYEE_ACTIVE  = ['active', 'probation', 'confirmed'];",
      () => {
        const { code, stdout } = runChecker('check-status-vocabulary.mjs', sandbox);
        expect(stdout.toLowerCase()).toMatch(/notice/);
        expect(code).toBe(1);
      },
    );
  });
});
