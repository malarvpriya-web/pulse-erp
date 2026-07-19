/**
 * 20260605000010_debit_note_items_fix.js
 *
 * Creates the debit_note_items table (omitted from the original credit_debit_notes migration).
 * Adds performance indexes on debit_notes for the list query.
 * Uses SAVEPOINT per statement to prevent 25P02 transaction abort propagation.
 */

export async function up(knex) {
  const safe = async (label, sql, params) => {
    await knex.raw('SAVEPOINT dn_sp');
    try {
      await knex.raw(sql, params || []);
      await knex.raw('RELEASE SAVEPOINT dn_sp');
    } catch (e) {
      await knex.raw('ROLLBACK TO SAVEPOINT dn_sp');
      console.warn(`[debit_note_items_fix] skip (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  await safe('create debit_note_items', `
    CREATE TABLE IF NOT EXISTS debit_note_items (
      id               SERIAL PRIMARY KEY,
      debit_note_id    INTEGER NOT NULL REFERENCES debit_notes(id) ON DELETE CASCADE,
      original_item_id INTEGER,
      description      TEXT,
      hsn_code         VARCHAR(8),
      quantity         NUMERIC(10,2) DEFAULT 1,
      unit_price       NUMERIC(15,2) DEFAULT 0,
      taxable_value    NUMERIC(15,2) DEFAULT 0,
      gst_rate         NUMERIC(5,2)  DEFAULT 0,
      cgst_amount      NUMERIC(15,2) DEFAULT 0,
      sgst_amount      NUMERIC(15,2) DEFAULT 0,
      igst_amount      NUMERIC(15,2) DEFAULT 0,
      created_at       TIMESTAMPTZ   DEFAULT NOW()
    )
  `);

  await safe('idx dn items note_id',
    `CREATE INDEX IF NOT EXISTS idx_dn_items_note_id ON debit_note_items(debit_note_id)`);

  await safe('idx dn company date',
    `CREATE INDEX IF NOT EXISTS idx_dn_company_date
       ON debit_notes(company_id, debit_note_date DESC)
       WHERE deleted_at IS NULL`);

  await safe('idx dn company status',
    `CREATE INDEX IF NOT EXISTS idx_dn_company_status
       ON debit_notes(company_id, status)
       WHERE deleted_at IS NULL`);

  console.log('[migration 20260605000010] debit_note_items table + indexes created.');
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS debit_note_items CASCADE').catch(() => {});
  await knex.raw('DROP INDEX IF EXISTS idx_dn_items_note_id').catch(() => {});
  await knex.raw('DROP INDEX IF EXISTS idx_dn_company_date').catch(() => {});
  await knex.raw('DROP INDEX IF EXISTS idx_dn_company_status').catch(() => {});
}
