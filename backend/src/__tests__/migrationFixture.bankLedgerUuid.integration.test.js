/**
 * Migration fixture: 20261104000004_bank_ledger_uuid_links (PC-02b-0 B-03, manual §236).
 *
 * What the migration promises:
 *   - bank_accounts.chart_account_id / bank_transactions.journal_entry_id (integer)
 *     become uuid columns with FKs ON DELETE RESTRICT and indexes;
 *   - every legacy integer value is kept, exactly, in *_legacy_int (D1);
 *   - chart_account_id is back-filled ONLY from an approved payment mapping, and
 *     only with an active Asset / bank account of the company or the shared chart;
 *   - down() refuses while a uuid link exists, and otherwise restores the legacy
 *     columns under their original names with their exact values;
 *   - up() again after down() works; up() on an applied schema is a no-op.
 *
 * Runs in scratch databases (helpers/migrationFixtureDb.js) — the shared test
 * database is never altered here. Before-state: the shapes in baseline.sql, cut
 * to the columns that matter.
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
const migration = await import('../database/migrations/20261104000004_bank_ledger_uuid_links.js');

const ACCT_1002 = '00000000-0000-4000-8000-000000001002';   // shared Asset / bank
const ACCT_2001 = '00000000-0000-4000-8000-000000002001';   // shared Liability
const ACCT_OWN = '00000000-0000-4000-8000-00000000c002';    // company 2's own bank ledger
const JE_1 = '00000000-0000-4000-8000-0000000000e1';

async function beforeState(c) {
  await c.query(`
    CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY, code varchar(20) UNIQUE, name varchar(100), account_type varchar(30),
      sub_type varchar(30), is_active boolean DEFAULT true, deleted_at timestamptz, company_id integer);
    CREATE TABLE journal_entries (id uuid PRIMARY KEY, entry_number varchar(30), company_id integer, deleted_at timestamptz, reversal_of_id uuid);
    CREATE TABLE bank_accounts (id serial PRIMARY KEY, account_name varchar(100), company_id integer, chart_account_id integer,
      is_active boolean DEFAULT true, deleted_at timestamptz, updated_at timestamptz);
    CREATE TABLE bank_transactions (id serial PRIMARY KEY, bank_account_id integer REFERENCES bank_accounts(id) ON DELETE CASCADE,
      amount numeric(14,2), journal_entry_id integer);
    CREATE TABLE company_settings (company_id integer, module varchar(50), settings jsonb, UNIQUE (company_id, module));`);
  await c.query(`INSERT INTO chart_of_accounts (id, code, name, account_type, sub_type, company_id) VALUES
      ($1, '1002', 'Bank — Current Account', 'Asset', 'bank', NULL),
      ($2, '2001', 'Accounts Payable', 'Liability', 'payable', NULL),
      ($3, 'C2BANK', 'Company 2 own bank', 'Asset', 'bank', 2)`, [ACCT_1002, ACCT_2001, ACCT_OWN]);
  await c.query(`INSERT INTO journal_entries (id, entry_number, company_id) VALUES ($1, 'JE0001', 1)`, [JE_1]);
  // Legacy integers exactly as the seed left them (they reference nothing).
  await c.query(`INSERT INTO bank_accounts (id, account_name, company_id, chart_account_id) VALUES
      (22, 'SEED 1', 1, 1), (23, 'SEED 2', 1, 2), (24, 'SEED 3', 1, 3), (30, 'C2 main', 2, NULL), (31, 'C2 other', 2, 7)`);
  await c.query(`INSERT INTO bank_transactions (id, bank_account_id, amount, journal_entry_id) VALUES
      (21, 22, 125000, 1), (22, 23, 162500, 2), (23, 24, 200000, NULL)`);
}
const legacyCols = async (c) => (await c.query(
  `SELECT table_name || '.' || column_name AS k, data_type FROM information_schema.columns
    WHERE table_name IN ('bank_accounts','bank_transactions') AND column_name LIKE ANY (ARRAY['chart_account_id%','journal_entry_id%'])
    ORDER BY 1`)).rows;
const down = async (c) => {
  await c.query('BEGIN');
  try { await migration.down(makeKnexShim(c)); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; }
};

describe('20261104000004 bank_ledger_uuid_links', () => {
  it('converts both links to uuid FKs (RESTRICT) and keeps every legacy value exactly', async () => {
    await withFixtureDb('bkluuid', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(() => apply(migration));
      expect(await legacyCols(c)).toEqual([
        { k: 'bank_accounts.chart_account_id', data_type: 'uuid' },
        { k: 'bank_accounts.chart_account_id_legacy_int', data_type: 'integer' },
        { k: 'bank_transactions.journal_entry_id', data_type: 'uuid' },
        { k: 'bank_transactions.journal_entry_id_legacy_int', data_type: 'integer' },
      ]);
      expect((await c.query(`SELECT id, chart_account_id, chart_account_id_legacy_int FROM bank_accounts ORDER BY id`)).rows).toEqual([
        { id: 22, chart_account_id: null, chart_account_id_legacy_int: 1 },
        { id: 23, chart_account_id: null, chart_account_id_legacy_int: 2 },
        { id: 24, chart_account_id: null, chart_account_id_legacy_int: 3 },
        { id: 30, chart_account_id: null, chart_account_id_legacy_int: null },
        { id: 31, chart_account_id: null, chart_account_id_legacy_int: 7 },
      ]);
      expect((await c.query(`SELECT id, journal_entry_id, journal_entry_id_legacy_int FROM bank_transactions ORDER BY id`)).rows).toEqual([
        { id: 21, journal_entry_id: null, journal_entry_id_legacy_int: 1 },
        { id: 22, journal_entry_id: null, journal_entry_id_legacy_int: 2 },
        { id: 23, journal_entry_id: null, journal_entry_id_legacy_int: null },
      ]);
      const { rows: fks } = await c.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'f' AND conname LIKE '%_fkey' AND conname <> 'bank_transactions_bank_account_id_fkey' ORDER BY conname`);
      expect(fks).toEqual([
        { conname: 'bank_accounts_chart_account_id_fkey', def: 'FOREIGN KEY (chart_account_id) REFERENCES chart_of_accounts(id) ON DELETE RESTRICT' },
        { conname: 'bank_transactions_journal_entry_id_fkey', def: 'FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE RESTRICT' },
      ]);
      const { rows: idx } = await c.query(`SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_bank_accounts_chart_account_id','idx_bank_transactions_journal_entry_id') ORDER BY 1`);
      expect(idx.map(r => r.indexname)).toEqual(['idx_bank_accounts_chart_account_id', 'idx_bank_transactions_journal_entry_id']);
      // RESTRICT: a referenced ledger account or journal cannot be deleted
      await c.query(`UPDATE bank_accounts SET chart_account_id = $1 WHERE id = 30`, [ACCT_1002]);
      await c.query(`UPDATE bank_transactions SET journal_entry_id = $1 WHERE id = 21`, [JE_1]);
      await expect(c.query(`DELETE FROM chart_of_accounts WHERE id = $1`, [ACCT_1002])).rejects.toThrow(/violates RESTRICT setting of foreign key constraint "bank_accounts_chart_account_id_fkey"/);
      await expect(c.query(`DELETE FROM journal_entries WHERE id = $1`, [JE_1])).rejects.toThrow(/violates RESTRICT setting of foreign key constraint "bank_transactions_journal_entry_id_fkey"/);
      // and an id that is not a real account / journal is refused
      await expect(c.query(`UPDATE bank_accounts SET chart_account_id = gen_random_uuid() WHERE id = 31`)).rejects.toThrow(/violates foreign key/);
    });
  });

  it('back-fills only from an approved mapping, only with a valid account of the company or the shared chart', async () => {
    await withFixtureDb('bkluuid', async ({ client: c, apply }) => {
      await beforeState(c);
      await c.query(`INSERT INTO company_settings (company_id, module, settings) VALUES
          (1, 'payment_gl_mapping', $1::jsonb), (2, 'payment_gl_mapping', $2::jsonb)`, [
        JSON.stringify({ approved_by: 9, approved_at: '2026-11-04', bank_ledgers: { 22: '1002', 23: '2001', 30: '1002' } }),
        JSON.stringify({ approved_by: null, approved_at: null, bank_ledgers: { 31: 'C2BANK' } }),       // not approved
      ]);
      const out = await captureConsole(() => apply(migration));
      expect(out.log.join('\n')).toMatch(/linked 1 bank account\(s\) from approved payment mappings; kept unmapped legacy values: 4 bank account\(s\), 2 bank transaction\(s\)/);
      expect((await c.query(`SELECT id, chart_account_id FROM bank_accounts ORDER BY id`)).rows).toEqual([
        { id: 22, chart_account_id: ACCT_1002 },   // approved, shared Asset/bank
        { id: 23, chart_account_id: null },        // 2001 is a Liability — not a bank ledger
        { id: 24, chart_account_id: null },        // not mapped — legacy 3 is never guessed
        { id: 30, chart_account_id: null },        // company 1's mapping names company 2's account
        { id: 31, chart_account_id: null },        // company 2's mapping is not approved
      ]);
    });
  });

  it('down() refuses while a uuid link exists, and changes nothing', async () => {
    await withFixtureDb('bkluuid', async ({ client: c, apply }) => {
      await beforeState(c);
      await captureConsole(() => apply(migration));
      await c.query(`UPDATE bank_transactions SET journal_entry_id = $1 WHERE id = 22`, [JE_1]);
      await expect(down(c)).rejects.toThrow(/Refusing to roll back 20261104000004: 1 bank_transactions row\(s\) hold a journal_entry_id link/);
      expect((await legacyCols(c)).map(r => r.data_type)).toEqual(['uuid', 'integer', 'uuid', 'integer']);
      expect((await c.query(`SELECT journal_entry_id FROM bank_transactions WHERE id = 22`)).rows[0].journal_entry_id).toBe(JE_1);
      await c.query(`UPDATE bank_accounts SET chart_account_id = $1 WHERE id = 22`, [ACCT_1002]);
      await c.query(`UPDATE bank_transactions SET journal_entry_id = NULL WHERE id = 22`);
      await expect(down(c)).rejects.toThrow(/1 bank_accounts row\(s\) hold a chart_account_id link/);
    });
  });

  it('without links, down() restores the legacy columns exactly; up() again works; a second up() is a no-op', async () => {
    await withFixtureDb('bkluuid', async ({ client: c, apply }) => {
      await beforeState(c);
      const before = {
        accts: (await c.query(`SELECT id, chart_account_id FROM bank_accounts ORDER BY id`)).rows,
        txns: (await c.query(`SELECT id, journal_entry_id FROM bank_transactions ORDER BY id`)).rows,
      };
      await captureConsole(() => apply(migration));
      await down(c);
      expect(await legacyCols(c)).toEqual([
        { k: 'bank_accounts.chart_account_id', data_type: 'integer' },
        { k: 'bank_transactions.journal_entry_id', data_type: 'integer' },
      ]);
      expect((await c.query(`SELECT id, chart_account_id FROM bank_accounts ORDER BY id`)).rows).toEqual(before.accts);
      expect((await c.query(`SELECT id, journal_entry_id FROM bank_transactions ORDER BY id`)).rows).toEqual(before.txns);
      const { rows: fks } = await c.query(`SELECT conname FROM pg_constraint WHERE conname IN ('bank_accounts_chart_account_id_fkey','bank_transactions_journal_entry_id_fkey')`);
      expect(fks).toEqual([]);
      await captureConsole(() => apply(migration));
      expect((await legacyCols(c)).map(r => r.data_type)).toEqual(['uuid', 'integer', 'uuid', 'integer']);
      await captureConsole(() => apply(migration));               // already applied → no-op, no error
      expect((await c.query(`SELECT COUNT(*)::int AS n FROM bank_accounts WHERE chart_account_id_legacy_int IS NOT NULL`)).rows[0].n).toBe(4);
    });
  });
});
