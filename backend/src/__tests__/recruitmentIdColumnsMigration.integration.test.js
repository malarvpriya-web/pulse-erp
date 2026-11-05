/**
 * recruitment.routes.js no longer alters schema on import; migration
 * 20261103000001 alters these columns only when they are not already INTEGER.
 * See MODULE_FEATURE_CONNECTION_MANUAL.md §223 / §224.
 *
 * Why it matters: the router used to run `ALTER TABLE interview_schedules
 * ALTER COLUMN candidate_id TYPE INTEGER …` (and two offer_letters siblings) on
 * every import. Against an already-integer column that still took ACCESS
 * EXCLUSIVE on interview_schedules and candidates, and deadlocked any
 * concurrent DELETE of employees or companies.
 *
 * Deliberately NO DDL here: this file runs in the parallel suite, and DDL on
 * these tables is exactly what caused the deadlocks. The legacy-type paths
 * (uuid / text columns) were verified with a guarded one-off script; see §224.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const migration = await import('../database/migrations/20261103000001_recruitment_id_columns_integer.js');

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('recruitment.routes.js import', () => {
  it('contains no ALTER TABLE — schema changes belong in migrations', () => {
    const src = stripComments(readFileSync(resolve(here, '../modules/recruitment/routes/recruitment.routes.js'), 'utf8'));
    expect(src).not.toMatch(/\bALTER\s+TABLE\b/i);
  });
});

describe('migration 20261103000001', () => {
  it('the three columns are INTEGER', async () => {
    const { rows } = await pool.query(
      `SELECT table_name || '.' || column_name AS c, data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name, column_name) IN (('interview_schedules','candidate_id'),
                                            ('offer_letters','candidate_id'),
                                            ('offer_letters','job_opening_id'))
        ORDER BY 1`);
    expect(rows).toEqual([
      { c: 'interview_schedules.candidate_id', data_type: 'integer' },
      { c: 'offer_letters.candidate_id', data_type: 'integer' },
      { c: 'offer_letters.job_opening_id', data_type: 'integer' },
    ]);
  });

  it('issues no ALTER when the columns are already INTEGER (re-run is lock-free)', async () => {
    const issued = [];
    const shim = { raw: (sql, b) => { issued.push(String(sql).trim()); return pool.query(sql, b || []); } };
    await migration.up(shim);
    expect(issued.filter((s) => /^ALTER\b/i.test(s))).toEqual([]);
    // Only catalogue reads: one information_schema lookup per column.
    expect(issued).toHaveLength(3);
    expect(issued.every((s) => /information_schema\.columns/.test(s))).toBe(true);
  });
});
