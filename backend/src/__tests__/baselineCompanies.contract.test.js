/**
 * A new database starts with the real company only (DB-01C3, manual §248).
 *
 * baseline-data.sql once carried five test tenants (names starting ZZ, ids in the 9999xx range), so
 * production would have started with them. Test suites create their own tenants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(here, '../..');
const read = (rel) => readFileSync(path.join(BACKEND, rel), 'utf8').replace(/\r\n/g, '\n');

const rowsOf = (sql) => {
  const block = sql.slice(sql.indexOf('INSERT INTO public.companies VALUES'));
  const rows = [];
  for (const line of block.split('\n').slice(1)) {
    if (!/^\s*\(/.test(line)) break;
    rows.push(line.trim());
  }
  return rows;
};

/** The script's own filter, lifted from source: running the script needs a database. */
function liftFilter() {
  const src = read('scripts/generate-baseline.js');
  const start = src.indexOf('const BASELINE_COMPANY_IDS');
  const end = src.indexOf('\nlet dataSql', start);
  expect(start, 'filter not found').toBeGreaterThan(-1);
  return new Function(`${src.slice(start, end)}\nreturn onlyBaselineCompanies;`)();
}

describe('baseline companies', () => {
  it('baseline-data.sql holds the real company and no test tenant', () => {
    const sql = read('src/database/baseline-data.sql');
    const rows = rowsOf(sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^\(1, 'Manifest Electra Private Limited'.*\);$/);
    expect(sql).not.toMatch(/\bZZ[A-Z]+\b/);
    expect(sql.slice(0, sql.indexOf('-- ── roles ──'))).not.toMatch(/\b99990\d\b/);
  });

  it('regenerating the baseline cannot bring them back', () => {
    const dump = [
      'INSERT INTO public.companies VALUES',
      "\t(1, 'Manifest', 'MANIFEST'),",
      "\t(123456, 'ZZPROC foreign tenant', 'ZZPRC'),",
      "\t(1356, 'Leaked test tenant', 'LEAK');",
      '',
      "SELECT pg_catalog.setval('public.companies_id_seq', 323, true);",
    ].join('\n');
    const out = liftFilter()(dump);
    expect(rowsOf(out)).toEqual(["(1, 'Manifest', 'MANIFEST');"]);
    expect(out).toContain('setval');
  });

  it('the filter refuses a source with no real company, rather than an empty baseline', () => {
    expect(() => liftFilter()("INSERT INTO public.companies VALUES\n\t(123456, 'ZZ', 'ZZ');")).toThrow(/expected 1 rows, found 0/);
  });

  it('the generator applies the filter to companies', () => {
    expect(read('scripts/generate-baseline.js')).toMatch(/table === 'companies' \? onlyBaselineCompanies\(cleaned\)/);
  });
});
