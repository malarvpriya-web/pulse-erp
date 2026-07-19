/**
 * 20260605000002_bank_accounts_hardening.js
 *
 * 1. Add account_number_last4 (masked display) to bank_accounts
 * 2. Add coa_account_id alias column (links to chart_of_accounts)
 * 3. Backfill account_number_last4 from existing rows
 * 4. Index: bank_accounts(company_id) for multi-tenant list performance
 * 5. Index: bank_accounts(company_id, is_active) for filtered lookups
 *
 * Uses SAVEPOINT per statement to prevent 25P02 transaction abort propagation.
 */

export async function up(knex) {
  const safe = async (label, sql, params) => {
    await knex.raw('SAVEPOINT ba_sp');
    try {
      await knex.raw(sql, params || []);
      await knex.raw('RELEASE SAVEPOINT ba_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT ba_sp');
      console.warn(`[bank_accounts_hardening] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  await safe('account_number_last4',
    `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_number_last4 VARCHAR(4)`);

  await safe('coa_account_id',
    `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS coa_account_id INTEGER REFERENCES chart_of_accounts(id) ON DELETE SET NULL`);

  await safe('backfill last4',
    `UPDATE bank_accounts
     SET account_number_last4 = RIGHT(REGEXP_REPLACE(account_number, '[^0-9]', '', 'g'), 4)
     WHERE account_number_last4 IS NULL
       AND account_number IS NOT NULL
       AND LENGTH(TRIM(account_number)) >= 4`);

  await safe('idx bank accounts company',
    `CREATE INDEX IF NOT EXISTS idx_bank_accounts_company ON bank_accounts(company_id)`);

  // Only add the partial index if deleted_at column exists on the table
  await safe('idx bank accounts company active',
    `CREATE INDEX IF NOT EXISTS idx_bank_accounts_company_active
       ON bank_accounts(company_id, is_active)
       WHERE deleted_at IS NULL`);
}

export async function down(knex) {
  const safe = async (sql) => {
    await knex.raw('SAVEPOINT ba_down_sp');
    try { await knex.raw(sql); await knex.raw('RELEASE SAVEPOINT ba_down_sp'); }
    catch { await knex.raw('ROLLBACK TO SAVEPOINT ba_down_sp'); }
  };
  await safe(`DROP INDEX IF EXISTS idx_bank_accounts_company_active`);
  await safe(`DROP INDEX IF EXISTS idx_bank_accounts_company`);
  await safe(`ALTER TABLE bank_accounts DROP COLUMN IF EXISTS coa_account_id`);
  await safe(`ALTER TABLE bank_accounts DROP COLUMN IF EXISTS account_number_last4`);
}
