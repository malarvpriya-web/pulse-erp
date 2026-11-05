/**
 * Migration fixture: 20261104000005_payment_batch_files (PC-02b-0 B-04, manual §237).
 *
 * What the migration promises:
 *   - one released file per batch; FKs RESTRICT; hash, format and amount checks;
 *   - UPDATE, DELETE and TRUNCATE refused by the database; DELETE only inside a
 *     transaction that deliberately set pulse.allow_bank_file_purge;
 *   - existing batches are not touched;
 *   - down() refuses while any released file exists, otherwise removes the table
 *     and function; up() again works, and up() on an applied schema is a no-op.
 *
 * Runs in scratch databases (helpers/migrationFixtureDb.js) — the shared test
 * database is never altered here.
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
const { withFixtureDb, captureConsole } = await import('./helpers/migrationFixtureDb.js');
const { makeKnexShim } = await import('../config/migrations.js');
const migration = await import('../database/migrations/20261104000005_payment_batch_files.js');

const SHA = 'a'.repeat(64);

async function beforeState(c) {
  await c.query(`
    CREATE TABLE companies (id serial PRIMARY KEY);
    CREATE TABLE users (id serial PRIMARY KEY);
    CREATE TABLE payment_batches (id serial PRIMARY KEY, status varchar(30), neft_file_path text, company_id integer);
    INSERT INTO companies DEFAULT VALUES;
    INSERT INTO users DEFAULT VALUES;
    INSERT INTO payment_batches (id, status, neft_file_path, company_id) VALUES
      (22, 'active', '/uploads/seed/doc-7528.pdf', 1), (23, 'approved', NULL, 1);`);
}
const insertFile = (c, batchId = 23, over = {}) => c.query(
  `INSERT INTO payment_batch_files (batch_id, company_id, format, file_name, content, sha256, line_count, total_amount, beneficiaries, released_by)
   VALUES ($1, 1, $2, 'f.csv', 'x', $3, 1, 100, '[]', 1)`, [batchId, over.format ?? 'generic', over.sha ?? SHA]);
const refused = async (fn) => {
  try { await fn(); } catch (e) { return e; }
  throw new Error('expected the statement to be refused');
};
const down = async (c) => {
  await c.query('BEGIN');
  try { await migration.down(makeKnexShim(c)); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
};
const exists = async (c) => (await c.query(
  `SELECT to_regclass('public.payment_batch_files')::text AS t,
          (SELECT COUNT(*)::int FROM pg_proc WHERE proname = 'payment_batch_files_immutable') AS fn`)).rows[0];

describe('20261104000005 payment_batch_files', () => {
  it('creates the table without touching existing batches, and enforces its checks and FKs', async () => {
    await withFixtureDb('bkfile', async ({ client: c, apply }) => {
      await beforeState(c);
      const before = (await c.query(`SELECT * FROM payment_batches ORDER BY id`)).rows;
      await captureConsole(() => apply(migration));
      expect((await c.query(`SELECT * FROM payment_batches ORDER BY id`)).rows).toEqual(before);
      expect((await c.query(`SELECT COUNT(*)::int AS n FROM payment_batch_files`)).rows[0].n).toBe(0);

      await insertFile(c);
      expect((await refused(() => insertFile(c))).code).toBe('23505');                      // one per batch
      expect((await refused(() => insertFile(c, 22, { format: 'axis' }))).code).toBe('23514');
      expect((await refused(() => insertFile(c, 22, { sha: 'NOTAHASH'.padEnd(64, 'Z') }))).code).toBe('23514');
      expect((await refused(() => insertFile(c, 999))).code).toBe('23503');
      expect((await refused(() => c.query(`DELETE FROM payment_batches WHERE id = 23`))).code).toBe('23001');
      expect((await refused(() => c.query(`DELETE FROM users WHERE id = 1`))).code).toBe('23001');
    });
  }, 60000);

  it('refuses UPDATE, DELETE and TRUNCATE; DELETE passes only for a deliberate transaction-local purge', async () => {
    await withFixtureDb('bkfile', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(() => apply(migration));
      await insertFile(c);
      const row = async () => (await c.query(`SELECT * FROM payment_batch_files`)).rows;
      const original = await row();

      for (const sql of [
        `UPDATE payment_batch_files SET content = 'tampered' WHERE batch_id = 23`,
        `UPDATE payment_batch_files SET released_by = released_by WHERE batch_id = 23`,
        `DELETE FROM payment_batch_files WHERE batch_id = 23`,
      ]) {
        const e = await refused(() => c.query(sql));
        expect(e.message).toMatch(/immutable/);
      }
      expect(await row()).toEqual(original);

      // The statement-level trigger for the remaining destructive verb, read from
      // the catalog: this suite may not issue it (testCleanupScoping contract).
      const { rows: stmt } = await c.query(
        `SELECT p.proname FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid
          WHERE g.tgrelid = 'payment_batch_files'::regclass AND NOT g.tgisinternal AND (g.tgtype & 32) <> 0 AND (g.tgtype & 2) <> 0`);
      expect(stmt).toEqual([{ proname: 'payment_batch_files_immutable' }]);

      // The switch opens DELETE only, never UPDATE; the function checks TG_OP.
      await c.query('BEGIN');
      await c.query(`SET LOCAL pulse.allow_bank_file_purge = 'on'`);
      expect((await refused(() => c.query(`SAVEPOINT s; UPDATE payment_batch_files SET content = 'x' WHERE batch_id = 23`))).message).toMatch(/immutable/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      await c.query('ROLLBACK');

      // It ends with the transaction.
      await c.query('BEGIN');
      await c.query(`SET LOCAL pulse.allow_bank_file_purge = 'on'`);
      await c.query('COMMIT');
      expect((await refused(() => c.query(`DELETE FROM payment_batch_files WHERE batch_id = 23`))).message).toMatch(/immutable/);
      expect(await row()).toEqual(original);

      await c.query('BEGIN');
      await c.query(`SET LOCAL pulse.allow_bank_file_purge = 'on'`);
      await c.query(`DELETE FROM payment_batch_files WHERE batch_id = 23`);
      await c.query('COMMIT');
      expect(await row()).toEqual([]);
    });
  }, 60000);

  it('down refuses while a released file exists and changes nothing; otherwise removes all; up again; no-op re-run', async () => {
    await withFixtureDb('bkfile', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(() => apply(migration));
      await insertFile(c);

      await expect(down(c)).rejects.toThrow(/Refusing to roll back 20261104000005: 1 released/);
      expect(await exists(c)).toEqual({ t: 'payment_batch_files', fn: 1 });
      expect((await c.query(`SELECT COUNT(*)::int AS n FROM payment_batch_files`)).rows[0].n).toBe(1);

      await c.query('BEGIN');
      await c.query(`SET LOCAL pulse.allow_bank_file_purge = 'on'`);
      await c.query(`DELETE FROM payment_batch_files WHERE batch_id = 23`);
      await c.query('COMMIT');
      await down(c);
      expect(await exists(c)).toEqual({ t: null, fn: 0 });
      await down(c);                                            // tolerates a second run
      expect((await c.query(`SELECT COUNT(*)::int AS n FROM payment_batches`)).rows[0].n).toBe(2);

      await captureConsole(() => apply(migration));
      expect(await exists(c)).toEqual({ t: 'payment_batch_files', fn: 1 });
      await insertFile(c);
      await captureConsole(() => apply(migration));             // no-op over an applied schema
      expect((await c.query(`SELECT COUNT(*)::int AS n FROM payment_batch_files`)).rows[0].n).toBe(1);
      expect((await refused(() => c.query(`DELETE FROM payment_batch_files WHERE batch_id = 23`))).message).toMatch(/immutable/);
    });
  }, 60000);
});
