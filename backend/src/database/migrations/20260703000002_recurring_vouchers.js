/**
 * 20260703000002_recurring_vouchers.js — Recurring voucher templates (Tally parity).
 * A template stores balanced journal lines + a schedule; /generate creates a draft
 * journal entry from the template and advances the next run date.
 */

export async function up(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS recurring_vouchers (
      id                   SERIAL PRIMARY KEY,
      company_id           INTEGER,
      name                 VARCHAR(200) NOT NULL,
      description          TEXT,
      frequency            VARCHAR(20) DEFAULT 'monthly',   -- weekly|monthly|quarterly|yearly
      next_run_date        DATE,
      last_generated_date  DATE,
      total_amount         NUMERIC(15,2) DEFAULT 0,
      lines                JSONB NOT NULL DEFAULT '[]',
      is_active            BOOLEAN DEFAULT true,
      created_by           INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_recurring_vouchers_company ON recurring_vouchers(company_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_recurring_vouchers_next    ON recurring_vouchers(next_run_date)`);
}

export async function down(db) {
  await db.query(`DROP TABLE IF EXISTS recurring_vouchers`);
}
