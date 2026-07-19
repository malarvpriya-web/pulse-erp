/**
 * CRM Accounts hardening — add missing columns so the accounts module works
 * correctly with company_id scoping, soft-delete, account_type, and a
 * normalized `name` column (aliased from account_name).
 */
export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_crmhrd_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column/i.test(err.message || '')) throw err;
    }
  };

  // ── accounts ─────────────────────────────────────────────────────────────────
  await safe(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS name VARCHAR(300)`);
  await safe(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await safe(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_type VARCHAR(50) DEFAULT 'Customer'`);
  await safe(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await safe(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500)`);
  await safe(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Active'`);

  // Backfill name from account_name where name is still null
  await knex.raw(`UPDATE accounts SET name = account_name WHERE name IS NULL AND account_name IS NOT NULL`);

  // ── contacts ──────────────────────────────────────────────────────────────────
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);

  // ── opportunities ─────────────────────────────────────────────────────────────
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id)`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // ── indexes ───────────────────────────────────────────────────────────────────
  await safe(`CREATE INDEX IF NOT EXISTS idx_accounts_company      ON accounts(company_id)        WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_accounts_type         ON accounts(company_id, account_type) WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_contacts_account      ON contacts(account_id)         WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_opportunities_account ON opportunities(account_id)    WHERE deleted_at IS NULL`);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_opportunities_account;
    DROP INDEX IF EXISTS idx_contacts_account;
    DROP INDEX IF EXISTS idx_accounts_type;
    DROP INDEX IF EXISTS idx_accounts_company;
    ALTER TABLE accounts DROP COLUMN IF EXISTS status;
    ALTER TABLE accounts DROP COLUMN IF EXISTS logo_url;
    ALTER TABLE accounts DROP COLUMN IF EXISTS deleted_at;
    ALTER TABLE accounts DROP COLUMN IF EXISTS account_type;
    ALTER TABLE accounts DROP COLUMN IF EXISTS company_id;
    ALTER TABLE accounts DROP COLUMN IF EXISTS name;
    ALTER TABLE contacts DROP COLUMN IF EXISTS deleted_at;
    ALTER TABLE contacts DROP COLUMN IF EXISTS company_id;
  `);
}
