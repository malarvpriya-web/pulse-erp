/**
 * 20260522000001_production_company_scoping.js
 *
 * Adds company_id to the three production tables that lacked multi-tenant isolation:
 *   - production_orders
 *   - bom_headers
 *   - work_centres
 *
 * No backfill is performed — existing rows keep NULL company_id and will be
 * invisible to scoped queries, which is the safe default.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE production_orders
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_production_orders_company
      ON production_orders(company_id)
  `);

  await knex.raw(`
    ALTER TABLE bom_headers
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bom_headers_company
      ON bom_headers(company_id)
  `);

  await knex.raw(`
    ALTER TABLE work_centres
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_work_centres_company
      ON work_centres(company_id)
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_production_orders_company`);
  await knex.raw(`ALTER TABLE production_orders DROP COLUMN IF EXISTS company_id`);

  await knex.raw(`DROP INDEX IF EXISTS idx_bom_headers_company`);
  await knex.raw(`ALTER TABLE bom_headers DROP COLUMN IF EXISTS company_id`);

  await knex.raw(`DROP INDEX IF EXISTS idx_work_centres_company`);
  await knex.raw(`ALTER TABLE work_centres DROP COLUMN IF EXISTS company_id`);
}
