export async function up(knex) {
  const tryAlter = async (sql) => {
    try { await knex.raw(sql); } catch { /* column/table already exists */ }
  };

  // Add missing columns to bank_accounts
  await tryAlter(`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_primary       BOOLEAN DEFAULT false`);
  await tryAlter(`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS od_limit         NUMERIC(15,2)`);
  await tryAlter(`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ`);
  await tryAlter(`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS opening_date     DATE`);
  await tryAlter(`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS swift_code       VARCHAR(20)`);
  await tryAlter(`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS micr_code        VARCHAR(20)`);

  // bank_transactions — ledger-level movements linked to journal entries
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id                  SERIAL PRIMARY KEY,
      bank_account_id     INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
      transaction_date    DATE NOT NULL,
      transaction_type    VARCHAR(10) NOT NULL CHECK (transaction_type IN ('Credit','Debit')),
      amount              NUMERIC(15,2) NOT NULL DEFAULT 0,
      balance_after       NUMERIC(15,2),
      reference_number    VARCHAR(100),
      description         TEXT,
      journal_entry_id    INTEGER,
      reconciled          BOOLEAN DEFAULT false,
      matched_stmt_id     INTEGER,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_bank_txns_account ON bank_transactions(bank_account_id)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_bank_txns_reconciled ON bank_transactions(bank_account_id, reconciled)`);

  // bank_statement_lines — imported from bank portal CSV/Excel
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bank_statement_lines (
      id              SERIAL PRIMARY KEY,
      bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
      stmt_date       DATE NOT NULL,
      description     TEXT,
      debit           NUMERIC(15,2) DEFAULT 0,
      credit          NUMERIC(15,2) DEFAULT 0,
      balance         NUMERIC(15,2),
      ref_number      VARCHAR(100),
      reconciled      BOOLEAN DEFAULT false,
      matched_txn_id  INTEGER REFERENCES bank_transactions(id),
      imported_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_stmt_lines_account ON bank_statement_lines(bank_account_id)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_stmt_lines_unreconciled ON bank_statement_lines(bank_account_id, reconciled)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS bank_statement_lines`);
  await knex.raw(`DROP TABLE IF EXISTS bank_transactions`);
  const tryDrop = async (sql) => {
    try { await knex.raw(sql); } catch { /* ignore */ }
  };
  await tryDrop(`ALTER TABLE bank_accounts DROP COLUMN IF EXISTS is_primary`);
  await tryDrop(`ALTER TABLE bank_accounts DROP COLUMN IF EXISTS od_limit`);
  await tryDrop(`ALTER TABLE bank_accounts DROP COLUMN IF EXISTS last_reconciled_at`);
  await tryDrop(`ALTER TABLE bank_accounts DROP COLUMN IF EXISTS opening_date`);
  await tryDrop(`ALTER TABLE bank_accounts DROP COLUMN IF EXISTS swift_code`);
  await tryDrop(`ALTER TABLE bank_accounts DROP COLUMN IF EXISTS micr_code`);
}
