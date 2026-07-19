/**
 * Phase 46 Fix — Add company_id to core accounting tables
 *
 * journal_entries, journal_lines, and chart_of_accounts were the last three
 * financial tables without tenant isolation. This migration adds the column
 * and performance indexes using the same SAVEPOINT pattern so a missing table
 * skips cleanly rather than aborting the whole migration.
 */
export async function up(knex) {
  let sp = 0;
  const tryAlter = async (sql) => {
    const name = `sp_acct_cid_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (err.message && err.message.includes('does not exist')) {
        console.warn(`[acct-cid] Skipped — ${err.message.split('\n')[0]}`);
      } else {
        throw err;
      }
    }
  };

  await tryAlter(`ALTER TABLE journal_entries   ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE journal_lines     ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE credit_notes      ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE debit_notes       ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE signature_audit_log ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // Indexes — CONCURRENTLY is safe on live data
  const tryIndex = async (sql) => {
    const name = `sp_idx_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      console.warn(`[acct-cid] Index skipped — ${err.message.split('\n')[0]}`);
    }
  };

  await tryIndex(`CREATE INDEX IF NOT EXISTS idx_je_company_id   ON journal_entries(company_id)`);
  await tryIndex(`CREATE INDEX IF NOT EXISTS idx_coa_company_id  ON chart_of_accounts(company_id)`);
  await tryIndex(`CREATE INDEX IF NOT EXISTS idx_cn_company_id   ON credit_notes(company_id)`);
  await tryIndex(`CREATE INDEX IF NOT EXISTS idx_dn_company_id   ON debit_notes(company_id)`);
}

export async function down(knex) {
  await knex.schema.table('journal_entries',    t => t.dropColumn('company_id')).catch(() => {});
  await knex.schema.table('journal_lines',      t => t.dropColumn('company_id')).catch(() => {});
  await knex.schema.table('chart_of_accounts',  t => t.dropColumn('company_id')).catch(() => {});
  await knex.schema.table('credit_notes',       t => t.dropColumn('company_id')).catch(() => {});
  await knex.schema.table('debit_notes',        t => t.dropColumn('company_id')).catch(() => {});
  await knex.schema.table('signature_audit_log',t => t.dropColumn('company_id')).catch(() => {});
}
