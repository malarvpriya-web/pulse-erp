/**
 * moduleGraphGuard.test.js — negative fixtures for check-module-graph.mjs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 2026-09-08 procurement commit was checked before it was made, by a script
 * that asked "does the imported FILE exist in this commit?". It said yes. The
 * commit still would not boot:
 *
 *     grn.service.js:7
 *     import { nextRtvNumber } from '../../../shared/docNumber.js';
 *     SyntaxError: ... does not provide an export named 'nextRtvNumber'
 *
 * `docNumber.js` was there. The export was not — it had been added in a change
 * left behind in the working tree. Three more gaps of the same shape sat behind
 * it, each found only by checking the commit out and running it.
 *
 * So the gate exists now. A gate that only ever passes proves nothing, which is
 * the lesson the sibling schemaGuards suite was written for, so these tests
 * inject a real defect of each class the checker claims to catch and assert it
 * fails with a non-zero exit. If someone narrows the scan, breaks the parser or
 * downgrades an assertion, one of these turns red.
 *
 * The third test is the one that keeps the gate USABLE rather than merely
 * strict. This codebase documents modules by writing their import line into a
 * JSDoc block, and the checker's first draft reported three phantom findings
 * from exactly that. A check that reports things that are fine is a check people
 * stop reading.
 *
 * ISOLATION
 * ---------
 * Defects are injected into a COPY of the tree and the checker is pointed at it
 * with CHECK_SRC_ROOT. The working tree is never edited: other vitest workers
 * import these same modules, and rewriting one mid-run leaves another worker
 * reading a half-written file.
 *
 * Runner: Vitest | npx vitest run src/__tests__/moduleGraphGuard.test.js
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');
const CHECKER = path.join(BACKEND, 'scripts', 'check-module-graph.mjs');

/** The trees the checker reads. node_modules is neither copied nor scanned. */
const COPIED = ['src', 'scripts', 'server.js'];

let sandbox;

/** Run the checker against a tree; returns { code, stdout }. */
function run(root) {
  const r = spawnSync(process.execPath, [CHECKER], {
    env: { ...process.env, CHECK_SRC_ROOT: root },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status, stdout: (r.stdout || '') + (r.stderr || '') };
}

/** A pristine copy of the tree, so each test starts from a green baseline. */
function freshSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-module-graph-'));
  for (const rel of COPIED) {
    const src = path.join(BACKEND, rel);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dir, rel), { recursive: true });
  }
  return dir;
}

beforeAll(() => { sandbox = freshSandbox(); }, 120_000);
afterAll(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('check-module-graph.mjs actually detects an incomplete tree', () => {
  const OPTS = { timeout: 120_000 };

  test('baseline is green against the sandbox copy', OPTS, () => {
    const { code, stdout } = run(sandbox);
    expect(stdout, stdout).toMatch(/PASS — every relative import resolves/);
    expect(code).toBe(0);
  });

  test('detects a named import whose export no longer exists', OPTS, () => {
    const dir = freshSandbox();
    try {
      // The literal defect that got past the file-level check: the file is
      // present and the export is not.
      const f = path.join(dir, 'src', 'shared', 'docNumber.js');
      const before = fs.readFileSync(f, 'utf8');
      expect(before, 'fixture drift: docNumber.js no longer exports nextRtvNumber')
        .toMatch(/export\s+async\s+function\s+nextRtvNumber/);
      // Drop only the `export` keyword: the file stays, the function stays, the
      // export goes. That is exactly the state the real commit was in.
      fs.writeFileSync(f, before.replace(
        /export\s+(async\s+function\s+nextRtvNumber)/, '$1'));

      const { code, stdout } = run(dir);
      expect(stdout, stdout).toMatch(/MISSING EXPORT/);
      expect(stdout, stdout).toMatch(/nextRtvNumber/);
      expect(code).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('detects an import of a file the tree does not contain', OPTS, () => {
    const dir = freshSandbox();
    try {
      // The shape a partial commit produces: a module left behind.
      fs.rmSync(path.join(dir, 'src', 'shared', 'gstRate.js'));
      const { code, stdout } = run(dir);
      expect(stdout, stdout).toMatch(/MISSING FILE/);
      expect(stdout, stdout).toMatch(/gstRate/);
      expect(code).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not report import syntax that appears inside a comment', OPTS, () => {
    const dir = freshSandbox();
    try {
      // Real shape, from auditLogger.js and chartOfAccounts.js: a doc block that
      // shows the reader how to import the module. The checker's first draft
      // scanned these as code and reported three findings in files whose imports
      // were entirely correct.
      const f = path.join(dir, 'src', 'shared', 'gstRate.js');
      fs.writeFileSync(f,
        '/**\n'
        + " *   import { thisNameDoesNotExist } from './definitely-not-here.js';\n"
        + ' *   const x = 1; // and a line comment mentioning ./also-not-here.js\n'
        + ' */\n'
        + "// import { alsoFake } from './nope.js';\n"
        + fs.readFileSync(f, 'utf8'));

      const { code, stdout } = run(dir);
      expect(stdout, stdout).not.toMatch(/definitely-not-here/);
      expect(stdout, stdout).not.toMatch(/also-not-here/);
      expect(stdout, stdout).not.toMatch(/nope\.js/);
      expect(stdout, stdout).toMatch(/PASS — every relative import resolves/);
      expect(code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
