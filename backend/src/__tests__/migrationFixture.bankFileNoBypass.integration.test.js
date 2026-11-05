/**
 * Migration fixture: 20261104000006_bank_file_immutability_no_bypass (PC-02b-0
 * B-04, manual §238), and the privilege boundary of
 * scripts/db/bank-file-least-privilege.mjs under a REAL non-superuser login.
 *
 * What is promised:
 *   - the old session setting no longer opens anything;
 *   - down() refuses while a released file exists, otherwise restores 20261104000005
 *     exactly; up() again removes the bypass again;
 *   - an ordinary application role can SELECT and INSERT, and nothing else: no
 *     UPDATE or DELETE, no way to skip, disable or replace the trigger, and no way
 *     to give itself the rights;
 *   - the tool refuses a superuser application role.
 *
 * Scratch databases only (helpers/migrationFixtureDb.js). The login roles are
 * cluster-wide, so they are uniquely named and dropped here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { withFixtureDb, captureConsole } = await import('./helpers/migrationFixtureDb.js');
const { makeKnexShim } = await import('../config/migrations.js');
const m5 = await import('../database/migrations/20261104000005_payment_batch_files.js');
const m6 = await import('../database/migrations/20261104000006_bank_file_immutability_no_bypass.js');
const { applyBankFileLeastPrivilege } = await import('../../scripts/db/bank-file-least-privilege.mjs');

async function beforeState(c) {
  await c.query(`
    CREATE TABLE companies (id serial PRIMARY KEY);
    CREATE TABLE users (id serial PRIMARY KEY);
    CREATE TABLE payment_batches (id serial PRIMARY KEY, status varchar(30), company_id integer);
    INSERT INTO companies DEFAULT VALUES;
    INSERT INTO users DEFAULT VALUES;
    INSERT INTO payment_batches (id, status, company_id) VALUES (22, 'approved', 1), (23, 'approved', 1);`);
}
const insertSql = `INSERT INTO payment_batch_files (batch_id, company_id, format, file_name, content, sha256, line_count, total_amount, beneficiaries, released_by)
   VALUES ($1, 1, 'generic', 'f.csv', 'x', repeat('a', 64), 1, 100, '[]', 1) RETURNING id`;
const refused = async (fn) => {
  try { await fn(); } catch (e) { return e; }
  throw new Error('expected the statement to be refused');
};
const down = async (migration, c) => {
  await c.query('BEGIN');
  try { await migration.down(makeKnexShim(c)); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
};
const fnSource = async (c) => (await c.query(`SELECT prosrc FROM pg_proc WHERE proname = 'payment_batch_files_immutable'`)).rows[0]?.prosrc;
const count = async (c) => (await c.query(`SELECT COUNT(*)::int AS n FROM payment_batch_files`)).rows[0].n;

describe('20261104000006 bank_file_immutability_no_bypass', () => {
  it('the old setting opened DELETE before the migration, and opens nothing after it', async () => {
    await withFixtureDb('bkfnb', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(() => apply(m5));
      await c.query(insertSql, [23]);

      // Before: the defect this migration closes.
      await c.query('BEGIN');
      await c.query(`SET LOCAL pulse.allow_bank_file_purge = 'on'`);
      expect((await c.query(`DELETE FROM payment_batch_files WHERE batch_id = 23`)).rowCount).toBe(1);
      await c.query('ROLLBACK');

      const original = (await c.query(`SELECT * FROM payment_batch_files`)).rows;
      await captureConsole(() => apply(m6));
      expect(await fnSource(c)).not.toMatch(/allow_bank_file_purge|current_setting/);

      for (const scope of ['SET LOCAL', 'SET']) {
        await c.query('BEGIN');
        await c.query(`${scope} pulse.allow_bank_file_purge = 'on'`);
        for (const sql of [`UPDATE payment_batch_files SET content = 't' WHERE batch_id = 23`, `DELETE FROM payment_batch_files WHERE batch_id = 23`]) {
          await c.query('SAVEPOINT s');
          expect((await refused(() => c.query(sql))).message).toMatch(/immutable/);
          await c.query('ROLLBACK TO SAVEPOINT s');
        }
        await c.query('ROLLBACK');
      }
      expect((await c.query(`SELECT * FROM payment_batch_files`)).rows).toEqual(original);

      // Both triggers still point at the function, including the statement-level one.
      const { rows: triggers } = await c.query(
        `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'payment_batch_files'::regclass AND NOT tgisinternal ORDER BY 1`);
      expect(triggers).toEqual([
        { tgname: 'payment_batch_files_no_change', tgenabled: 'O' },
        { tgname: 'payment_batch_files_no_truncate', tgenabled: 'O' },
      ]);
    });
  }, 60000);

  it('down refuses while a file exists and changes nothing; with none it restores 000005; up removes the bypass again', async () => {
    await withFixtureDb('bkfnb', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(() => apply(m5));
      const before = await fnSource(c);
      await captureConsole(() => apply(m6));
      const after = await fnSource(c);
      await c.query(insertSql, [23]);

      await expect(down(m6, c)).rejects.toThrow(/Refusing to roll back 20261104000006: 1 released/);
      expect(await fnSource(c)).toBe(after);
      expect(await count(c)).toBe(1);

      // Scratch database, superuser, the only remaining way to remove a row.
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = 'replica'`);
      await c.query(`DELETE FROM payment_batch_files WHERE batch_id = 23`);
      await c.query('COMMIT');

      await down(m6, c);
      expect(await fnSource(c)).toBe(before);
      await captureConsole(() => apply(m6));
      expect(await fnSource(c)).toBe(after);
      await captureConsole(() => apply(m6));                    // no-op over an applied schema
      expect(await fnSource(c)).toBe(after);
    });
  }, 60000);
});

describe('scripts/db/bank-file-least-privilege under a real non-superuser login', () => {
  it('leaves the application role SELECT and INSERT only, with no way round the trigger', async () => {
    await withFixtureDb('bkfnb', async ({ client: c, apply }) => {
      const tag = randomBytes(5).toString('hex');
      const appRole = `pulse_e2e_app_${tag}`;
      const ownerRole = `pulse_e2e_owner_${tag}`;
      const password = randomBytes(18).toString('hex');
      await beforeState(c);
      await captureConsole(() => apply(m5));
      await captureConsole(() => apply(m6));
      await c.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      let app;
      try {
        // The application owns everything else, as it would after a role move.
        for (const t of ['companies', 'users', 'payment_batches']) await c.query(`ALTER TABLE ${t} OWNER TO ${appRole}`);
        await c.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);

        const privileges = await applyBankFileLeastPrivilege(c, appRole, ownerRole);
        expect(privileges).toMatchObject({ can_select: true, can_insert: true, can_update: false, can_delete: false, can_truncate: false, can_trigger: false, table_owner: ownerRole });

        const { host, port, database } = c.connectionParameters;
        app = new pg.Client({ host, port, database, user: appRole, password, ssl: false });
        await app.connect();
        const { rows: [who] } = await app.query(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS sup`);
        expect(who).toEqual({ u: appRole, sup: false });

        // Normal work: release (INSERT ... RETURNING) and read, FKs enforced, and
        // the application can still not delete a batch from under its file.
        const { rows: [file] } = await app.query(insertSql, [23]);
        expect(file.id).toBeGreaterThan(0);
        expect((await app.query(`SELECT content FROM payment_batch_files WHERE batch_id = 23`)).rows).toEqual([{ content: 'x' }]);
        expect((await refused(() => app.query(insertSql, [999]))).code).toBe('23503');
        expect((await refused(() => app.query(insertSql, [23]))).code).toBe('23505');
        expect((await refused(() => app.query(`DELETE FROM payment_batches WHERE id = 23`))).code).toBe('23001');

        const denied = async (sql) => expect((await refused(() => app.query(sql))).code).toBe('42501');
        const update = `UPDATE payment_batch_files SET content = 't' WHERE batch_id = 23`;
        const del = `DELETE FROM payment_batch_files WHERE batch_id = 23`;
        await denied(update);
        await denied(del);

        // The old setting can still be SET by anyone, and now means nothing.
        await app.query(`SET pulse.allow_bank_file_purge = 'on'`);
        await denied(update);
        await denied(del);
        await app.query(`RESET pulse.allow_bank_file_purge`);

        // No way round the trigger or the privileges.
        await denied(`SET session_replication_role = 'replica'`);
        await denied(`ALTER TABLE payment_batch_files DISABLE TRIGGER payment_batch_files_no_change`);
        await denied(`ALTER TABLE payment_batch_files DISABLE TRIGGER ALL`);
        await denied(`DROP TRIGGER payment_batch_files_no_change ON payment_batch_files`);
        await denied(`CREATE OR REPLACE FUNCTION payment_batch_files_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$`);
        // A role with no grant option gets a warning, not an error, and nothing is granted.
        await app.query(`GRANT UPDATE, DELETE ON payment_batch_files TO ${appRole}`);
        const { rows: [granted] } = await c.query(
          `SELECT has_table_privilege($1, 'payment_batch_files', 'UPDATE') AS u, has_table_privilege($1, 'payment_batch_files', 'DELETE') AS d`, [appRole]);
        expect(granted).toEqual({ u: false, d: false });
        await denied(update);
        await denied(`ALTER TABLE payment_batch_files OWNER TO ${appRole}`);
        await denied(`SET ROLE ${ownerRole}`);
        await denied(`SET SESSION AUTHORIZATION postgres`);

        // What the login could not do, it did not do.
        expect((await c.query(`SELECT content FROM payment_batch_files WHERE batch_id = 23`)).rows).toEqual([{ content: 'x' }]);
        expect((await c.query(`SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgrelid = 'payment_batch_files'::regclass AND NOT tgisinternal AND tgenabled = 'O'`)).rows[0].n).toBe(2);
      } finally {
        if (app) await app.end().catch(() => {});
        for (const role of [appRole, ownerRole]) {
          const { rows: [r] } = await c.query(`SELECT 1 AS ok FROM pg_roles WHERE rolname = $1`, [role]);
          if (r) {
            await c.query(`REASSIGN OWNED BY ${role} TO CURRENT_USER`);
            await c.query(`DROP OWNED BY ${role}`);
            await c.query(`DROP ROLE ${role}`);
          }
        }
      }
    });
  }, 60000);

  it('refuses a superuser, CREATEROLE or unknown application role, and changes nothing', async () => {
    await withFixtureDb('bkfnb', async ({ client: c, apply }) => {
      const tag = randomBytes(5).toString('hex');
      const creator = `pulse_e2e_creator_${tag}`;
      const ownerRole = `pulse_e2e_owner_${tag}`;
      await beforeState(c);
      await captureConsole(() => apply(m5));
      await captureConsole(() => apply(m6));
      const { rows: [{ me }] } = await c.query(`SELECT current_user AS me`);
      const owner = async () => (await c.query(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'payment_batch_files'::regclass`)).rows[0].o;
      await c.query(`CREATE ROLE ${creator} NOLOGIN CREATEROLE`);
      try {
        await expect(applyBankFileLeastPrivilege(c, me, ownerRole)).rejects.toThrow(/superuser, CREATEROLE or BYPASSRLS/);
        await expect(applyBankFileLeastPrivilege(c, creator, ownerRole)).rejects.toThrow(/superuser, CREATEROLE or BYPASSRLS/);
        await expect(applyBankFileLeastPrivilege(c, `pulse_e2e_none_${tag}`, ownerRole)).rejects.toThrow(/does not exist/);
        expect(await owner()).toBe(me);
        expect((await c.query(`SELECT COUNT(*)::int AS n FROM pg_roles WHERE rolname = $1`, [ownerRole])).rows[0].n).toBe(0);
      } finally {
        await c.query(`DROP ROLE IF EXISTS ${creator}`);
      }
    });
  }, 60000);
});
