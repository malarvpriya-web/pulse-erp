/**
 * unit.csvWriter.test.js
 *
 * The shared CSV writer, and a repo guard that stops the bug it fixes from
 * being copy-pasted back in.
 *
 * Every export in this app used to build its own line with
 *
 *     .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
 *
 * which escapes quotes and nothing else. A cell whose text begins with
 * = + - @ TAB or CR is EVALUATED when a spreadsheet opens the file, and quoting
 * does not prevent that — the parser strips the quotes first. The last case in
 * this file greps the source tree so the next person who writes that expression
 * gets a failing test rather than a shipped vulnerability.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, sep } from 'node:path';

import { csvCell, csvRow, toCsv, toCsvObjects, sendCsv } from '../shared/csv.js';

describe('csvCell — formula neutralisation', () => {
  it.each([
    ['=cmd|\'/c calc\'!A1',            'the DDE command payload'],
    ['=HYPERLINK("http://x","go")',    'the exfiltration payload'],
    ['+SUM(A1:A9)',                    'a leading plus'],
    ['@SUM(A1:A9)',                    'a leading at-sign'],
    ['-not a number',                  'a leading minus that is not a number'],
    ['\tlead tab',                     'a leading tab'],
    ['\rlead cr',                      'a leading carriage return'],
  ])('neutralises %j (%s)', (payload) => {
    const out = csvCell(payload);
    // Present as text, prefixed, and never opening with the trigger character.
    expect(out.startsWith('"\'')).toBe(true);
    expect(out.startsWith(`"${payload[0]}`)).toBe(false);
  });

  it('leaves genuine numbers alone so amounts still sum', () => {
    expect(csvCell(-4500)).toBe('"-4500"');
    expect(csvCell('-4500.25')).toBe('"-4500.25"');
    expect(csvCell('-.5')).toBe('"-.5"');
    expect(csvCell(0)).toBe('"0"');
  });

  it('treats a leading-plus phone number as text, which is what it is', () => {
    expect(csvCell('+919876543210')).toBe(`"'+919876543210"`);
  });

  it('escapes embedded quotes by doubling them', () => {
    expect(csvCell('ACME "Pvt" Ltd')).toBe('"ACME ""Pvt"" Ltd"');
  });

  it('renders null and undefined as empty', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(null, { minimal: true })).toBe('');
  });
});

describe('csvCell — quoting modes', () => {
  it('always-quotes by default', () => {
    expect(csvRow(['a', 'b'])).toBe('"a","b"');
  });

  it('minimal mode quotes only what must be quoted', () => {
    expect(csvCell('plain', { minimal: true })).toBe('plain');
    expect(csvCell('has,comma', { minimal: true })).toBe('"has,comma"');
    expect(csvCell('has"quote', { minimal: true })).toBe('"has""quote"');
    expect(csvCell('has\nnewline', { minimal: true })).toBe('"has\nnewline"');
  });

  it('neutralises formulas in minimal mode too', () => {
    expect(csvCell('=1+1', { minimal: true })).toBe(`'=1+1`);
  });
});

describe('toCsv / toCsvObjects', () => {
  it('accepts a literal header string, as most routes declare theirs', () => {
    expect(toCsv('A,B', [['1', '2']])).toBe('A,B\r\n"1","2"');
  });

  it('escapes an array header like any other row', () => {
    expect(toCsv(['A,x', 'B'], [])).toBe('"A,x","B"');
  });

  it('passes a pre-formatted string row through untouched', () => {
    expect(toCsv('A', ['# a comment line'])).toBe('A\r\n# a comment line');
  });

  it('derives columns from the first object row', () => {
    expect(toCsvObjects([{ a: 1, b: 2 }], { minimal: true })).toBe('a,b\r\n1,2');
  });

  it('honours an explicit column list, including a key the first row lacks', () => {
    const out = toCsvObjects([{ a: 1 }, { a: 2, b: 9 }], { columns: ['a', 'b'], minimal: true });
    expect(out).toBe('a,b\r\n1,\r\n2,9');
  });

  it('returns just the header for no rows, and nothing for no columns', () => {
    expect(toCsvObjects([], { columns: ['a'], minimal: true })).toBe('a');
    expect(toCsvObjects([])).toBe('');
  });
});

describe('sendCsv', () => {
  it('strips a filename stem that could forge a response header', () => {
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; }, send: () => {} };
    sendCsv(res, 'evil"\r\nX-Injected: 1', 'a,b');
    const cd = headers['Content-Disposition'];

    // No CR or LF survives, so no second header line can be forged...
    expect(cd).not.toMatch(/[\r\n]/);
    // ...and the only quotes left are the pair wrapping the filename.
    expect(cd.match(/"/g)).toHaveLength(2);
    expect(cd).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.csv"$/);
    expect(headers['Content-Type']).toBe('text/csv; charset=utf-8');
  });
});

describe('repo guard — nothing re-rolls its own CSV escaping', () => {
  const here    = dirname(fileURLToPath(import.meta.url));
  const srcRoot = resolve(here, '..');

  /**
   * The hand-rolled escape, in the shapes it actually appeared in: a
   * .replace(/"/g, '""') that is building a CSV cell. shared/csv.js is the one
   * legitimate home for it.
   *
   * systemHealth.routes.js is the one true exception and is listed by name: it
   * quotes a SQL IDENTIFIER (`"schema"."table"`) for a dynamic count query,
   * which is the same escape rule for an entirely different reason.
   *
   * database/migrations/ is skipped wholesale rather than allowlisted file by
   * file. A migration serves no CSV — it has no res, no Content-Disposition and
   * no caller that downloads anything — so the one reason a `.replace(/"/g,'""')`
   * can appear there is the systemHealth case above: quoting a SQL identifier
   * before interpolating it into DDL. Allowlisting each one by name was tried
   * implicitly and does not hold: migrations are append-only and written by
   * whoever is mid-task, so the guard went red on
   * 20260917000004_pct_family_seed_purge.js the day it landed, for
   * `const ident = (s) => `"${String(s).replace(/"/g, '""')}"`` — correct code.
   * A guard that a correct commit turns red teaches people to ignore the guard.
   */
  const ALLOWED = new Set([
    join('shared', 'csv.js'),
    join('modules', 'admin', 'systemHealth.routes.js'),
  ]);

  function* walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__' || name === 'migrations') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) yield* walk(full);
      else if (name.endsWith('.js')) yield full;
    }
  }

  it('no route or service builds its own CSV cell', () => {
    const offenders = [];
    for (const file of walk(srcRoot)) {
      const rel = relative(srcRoot, file);
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      if (/replace\(\/"\/g,\s*'""'\)/.test(text)) offenders.push(rel.split(sep).join('/'));
    }
    expect(
      offenders,
      `These files hand-roll CSV escaping instead of using shared/csv.js, which escapes `
      + `quotes but leaves a leading = + - @ to be evaluated by the spreadsheet that opens `
      + `the file:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });
});
