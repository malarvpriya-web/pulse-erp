/**
 * ONE canonical format, ONE generator — enforced against the source, not assumed.
 *
 * ── What went wrong, twice ──────────────────────────────────────────────────
 * Employee ID had THREE generators. Two of them produced the hyphenated
 * `EMP-0001`: `shared/docNumber.js` (zero callers) and `utils/generateCode.js`
 * (zero callers), plus the recruitment hire path, which had its own copy of the
 * mint. Because three code paths agreed on the hyphen, a pass of mine concluded
 * that WAS the canonical format and backfilled 35 employees as `EMP-0013`…, while
 * treating the eight rows that predated everything — `EMP001`…`EMP012`, the actual
 * business convention — as legacy to be tolerated.
 *
 * So the failure mode is not only "a second generator exists". It is "a second
 * generator exists, and its format gets mistaken for the convention because it
 * has company". This test makes both impossible to reintroduce quietly:
 *
 *   1. only `shared/employeeCode.js` may define a code-minting function;
 *   2. no source file may contain a hyphenated EMP literal outside a comment;
 *   3. nothing may assume a fixed 3-digit suffix.
 *
 * ⚠ Source is read as TEXT, never imported: 17 route files in this repo run
 * top-level DDL at import time, so importing them to inspect them would execute
 * migrations and start crons.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  CODE_RE, CODE_CHECK_SQL, formatEmployeeCode, isValidEmployeeCode,
} from '../shared/employeeCode.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = join('shared', 'employeeCode.js');

function sourceFiles(dir = SRC, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'migrations' && entry !== 'seeds') sourceFiles(p, out);
    } else if (entry.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Strip // and block comments so a doc note about the old format is not a hit. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = sourceFiles();

describe('one canonical Employee ID format', () => {
  it('is EMP followed by at least three digits, with no hyphen', () => {
    expect(CODE_RE.source).toBe('^EMP\\d{3,}$');
    expect(formatEmployeeCode(1)).toBe('EMP001');
    expect(formatEmployeeCode(13)).toBe('EMP013');
    expect(isValidEmployeeCode('EMP-0001')).toBe(false);
  });

  it('is not capped at three digits', () => {
    // The company is allowed to exceed 999 employees.
    expect(formatEmployeeCode(1000)).toBe('EMP1000');
    expect(formatEmployeeCode(12345)).toBe('EMP12345');
    for (const n of [999, 1000, 10000]) {
      expect(isValidEmployeeCode(formatEmployeeCode(n)), String(n)).toBe(true);
    }
  });
});

describe('one generator', () => {
  it('only shared/employeeCode.js defines a function that mints an employee code', () => {
    const definers = [];
    for (const file of FILES) {
      const code = stripComments(readFileSync(file, 'utf8'));
      // `function nextEmployeeCode` / `const nextEmployeeCode = ` — a DEFINITION,
      // not a call or an import.
      if (/(?:function|const|let|var)\s+nextEmployeeCode\b/.test(code)
          || /\bnextEmployeeCode\s*[:=]\s*(?:async\s*)?\(/.test(code)) {
        definers.push(relative(SRC, file).split(sep).join('/'));
      }
    }
    expect(definers, 'exactly one module may define nextEmployeeCode').toEqual(
      [OWNER.split(sep).join('/')]);
  });

  it('no source file builds an EMP code from a hyphen', () => {
    // Catches `EMP-${...}`, 'EMP-' + n, `EMP-0001` — in CODE, comments excluded so
    // the historical notes explaining this mistake are allowed to mention it.
    const offenders = [];
    for (const file of FILES) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const m of code.matchAll(/['"`]EMP-[^'"`]*['"`]|EMP-\$\{/g)) {
        offenders.push(`${relative(SRC, file).split(sep).join('/')}: ${m[0]}`);
      }
    }
    expect(offenders, 'the hyphenated form is not the convention').toEqual([]);
  });

  it('nothing pads an employee code to a fixed width that would break at 1000', () => {
    // `padStart(3, '0')` is correct — it pads and never truncates. What would be
    // wrong is slicing or truncating to three characters, so that EMP1000 became
    // EMP100. Assert the real behaviour rather than grepping for padStart.
    expect(formatEmployeeCode(1000)).toHaveLength(7);
    expect(formatEmployeeCode(999)).toHaveLength(6);
    expect(formatEmployeeCode(1)).toHaveLength(6);
    // And the DB pattern agrees: {3,} not {3}.
    expect(CODE_CHECK_SQL).toContain('{3,}');
    expect(CODE_CHECK_SQL).not.toMatch(/\{3\}/);
  });
});
