/**
 * 20260601000008_holidays_company_id.js
 *
 * Adds company_id to the holidays table for multi-tenant isolation.
 * Column is nullable so existing rows (global/seed holidays) remain visible
 * to all tenants via the NULL-fallback in query WHERE clauses.
 *
 * Uses knex.raw() — the shim provided by the migration runner.
 * Index is non-CONCURRENTLY because CONCURRENTLY cannot run inside a transaction.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE holidays ADD COLUMN IF NOT EXISTS company_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_holidays_company_date
      ON holidays(company_id, date);
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_holidays_company_date;
    ALTER TABLE holidays DROP COLUMN IF EXISTS company_id;
  `);
}
