/**
 * 20260605000001_bills_tds_columns.js
 *
 * Adds TDS (Tax Deducted at Source) deduction fields to the bills table.
 * Required for India compliance — suppliers must have TDS deducted at source
 * before payment is released.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE bills
      ADD COLUMN IF NOT EXISTS tds_section VARCHAR(20),
      ADD COLUMN IF NOT EXISTS tds_rate    NUMERIC(5,2)  DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tds_amount  NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS net_payable NUMERIC(15,2)
  `);

  // Backfill net_payable for existing rows
  await knex.raw(`
    UPDATE bills
    SET net_payable = total_amount - COALESCE(tds_amount, 0)
    WHERE net_payable IS NULL
  `);

  // Index for TDS reporting queries
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bills_tds_section
      ON bills(tds_section, company_id)
      WHERE tds_section IS NOT NULL AND deleted_at IS NULL
  `).catch(e => console.warn('[migration] TDS index warning:', e.message));
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_bills_tds_section`).catch(() => {});
  await knex.raw(`
    ALTER TABLE bills
      DROP COLUMN IF EXISTS tds_section,
      DROP COLUMN IF EXISTS tds_rate,
      DROP COLUMN IF EXISTS tds_amount,
      DROP COLUMN IF EXISTS net_payable
  `);
}
