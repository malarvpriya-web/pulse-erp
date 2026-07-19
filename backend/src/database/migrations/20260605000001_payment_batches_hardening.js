/**
 * 20260605000001_payment_batches_hardening.js
 *
 * Creates payment_batches / payment_batch_items if missing, then ensures all
 * required columns exist.  Uses SAVEPOINTs so any individual statement failure
 * does not abort the surrounding transaction (25P02 prevention).
 */

export async function up(knex) {

  // Each statement runs in its own savepoint so one failure can't abort the txn.
  const safe = async (label, sql, params) => {
    await knex.raw('SAVEPOINT pb_sp');
    try {
      await knex.raw(sql, params || []);
      await knex.raw('RELEASE SAVEPOINT pb_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT pb_sp');
      console.warn(`[payment_batches_hardening] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // ── Create tables if they were never created by an earlier migration ─────────
  await safe('create payment_batches', `
    CREATE TABLE IF NOT EXISTS payment_batches (
      id              SERIAL PRIMARY KEY,
      batch_number    VARCHAR(50) UNIQUE,
      status          VARCHAR(20) DEFAULT 'draft',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safe('create payment_batch_items', `
    CREATE TABLE IF NOT EXISTS payment_batch_items (
      id              SERIAL PRIMARY KEY,
      batch_id        INTEGER REFERENCES payment_batches(id) ON DELETE CASCADE,
      supplier_id     INTEGER,
      amount          NUMERIC(15,2) DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── payment_batches: add operational columns ─────────────────────────────────
  const pbCols = [
    [`pb company_id`,       `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS company_id       INTEGER REFERENCES companies(id) ON DELETE CASCADE`],
    [`pb batch_date`,       `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS batch_date       DATE DEFAULT CURRENT_DATE`],
    [`pb scheduled_date`,   `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS scheduled_date   DATE`],
    [`pb bank_account_id`,  `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS bank_account_id  INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL`],
    [`pb payment_mode`,     `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS payment_mode     VARCHAR(20) DEFAULT 'neft'`],
    [`pb payment_count`,    `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS payment_count    INTEGER DEFAULT 0`],
    [`pb bill_count`,       `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS bill_count       INTEGER DEFAULT 0`],
    [`pb notes`,            `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS notes            TEXT`],
    [`pb created_by`,       `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL`],
    [`pb approved_by`,      `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS approved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL`],
    [`pb approved_at`,      `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ`],
    [`pb processed_at`,     `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS processed_at     TIMESTAMPTZ`],
    [`pb rejected_by`,      `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS rejected_by      INTEGER REFERENCES users(id) ON DELETE SET NULL`],
    [`pb rejected_at`,      `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS rejected_at      TIMESTAMPTZ`],
    [`pb rejection_reason`, `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS rejection_reason TEXT`],
    [`pb neft_file_path`,   `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS neft_file_path   TEXT`],
    [`pb updated_at`,       `ALTER TABLE payment_batches ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT NOW()`],
  ];
  for (const [label, sql] of pbCols) await safe(label, sql);

  // ── payment_batch_items: add columns ────────────────────────────────────────
  const pbiCols = [
    [`pbi company_id`,       `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS company_id       INTEGER REFERENCES companies(id) ON DELETE CASCADE`],
    [`pbi bill_id`,          `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS bill_id          INTEGER REFERENCES bills(id) ON DELETE SET NULL`],
    [`pbi payment_method`,   `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS payment_method   VARCHAR(20) DEFAULT 'neft'`],
    [`pbi reference_number`, `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS reference_number VARCHAR(200)`],
    [`pbi notes`,            `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS notes            TEXT`],
    [`pbi status`,           `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS status           VARCHAR(20) DEFAULT 'pending'`],
    [`pbi utr`,              `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS utr              VARCHAR(100)`],
    [`pbi payment_id`,       `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS payment_id       INTEGER REFERENCES payments(id) ON DELETE SET NULL`],
    [`pbi supplier_name`,    `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS supplier_name    VARCHAR(300)`],
    [`pbi bill_ref`,         `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS bill_ref         VARCHAR(100)`],
    [`pbi updated_at`,       `ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT NOW()`],
  ];
  for (const [label, sql] of pbiCols) await safe(label, sql);

  // ── Indexes ──────────────────────────────────────────────────────────────────
  await safe('idx pb company status', `CREATE INDEX IF NOT EXISTS idx_payment_batches_company_status ON payment_batches(company_id, status)`);
  await safe('idx pb company date',   `CREATE INDEX IF NOT EXISTS idx_payment_batches_company_date   ON payment_batches(company_id, batch_date)`);
  await safe('idx pbi batch_id',      `CREATE INDEX IF NOT EXISTS idx_pbi_batch_id                   ON payment_batch_items(batch_id)`);

  console.log('[migration 20260605000001] payment_batches hardening complete.');
}

export async function down(knex) {
  const safe = async (sql) => {
    await knex.raw('SAVEPOINT pb_down_sp');
    try { await knex.raw(sql); await knex.raw('RELEASE SAVEPOINT pb_down_sp'); }
    catch { await knex.raw('ROLLBACK TO SAVEPOINT pb_down_sp'); }
  };
  await safe(`DROP INDEX IF EXISTS idx_payment_batches_company_status`);
  await safe(`DROP INDEX IF EXISTS idx_payment_batches_company_date`);
  await safe(`DROP INDEX IF EXISTS idx_pbi_batch_id`);
}
