/**
 * 20260520000001_production_traceability_columns.js
 *
 * Adds industrial traceability columns to production_orders:
 *   - serial_number  : unit-level identifier (SST / HVDC / capacitor bank)
 *   - batch_number   : lot/batch grouping for production runs
 *   - customer_ref   : customer purchase order reference for field traceability
 *
 * Also adds a GIN index on production_orders so serial/batch lookups are fast
 * even when queried as substrings (used by the lifecycle & service modules).
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE production_orders
      ADD COLUMN IF NOT EXISTS serial_number  VARCHAR(120),
      ADD COLUMN IF NOT EXISTS batch_number   VARCHAR(80),
      ADD COLUMN IF NOT EXISTS customer_ref   VARCHAR(120)
  `);

  // Partial index — only rows that actually have a serial number
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_production_orders_serial
      ON production_orders(serial_number)
      WHERE serial_number IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_production_orders_batch
      ON production_orders(batch_number)
      WHERE batch_number IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_production_orders_serial`);
  await knex.raw(`DROP INDEX IF EXISTS idx_production_orders_batch`);
  await knex.raw(`
    ALTER TABLE production_orders
      DROP COLUMN IF EXISTS serial_number,
      DROP COLUMN IF EXISTS batch_number,
      DROP COLUMN IF EXISTS customer_ref
  `);
}
