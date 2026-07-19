/**
 * 20260522000001_bom_company_scoping.js
 *
 * Adds company_id to bom_headers and work_centres for multi-tenant isolation.
 * All ALTERs use IF NOT EXISTS — safe on existing data.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE bom_headers
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_bom_headers_company ON bom_headers(company_id);
  `);

  await knex.raw(`
    ALTER TABLE work_centres
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_work_centres_company ON work_centres(company_id);
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_bom_headers_company`);
  await knex.raw(`ALTER TABLE bom_headers DROP COLUMN IF EXISTS company_id`);

  await knex.raw(`DROP INDEX IF EXISTS idx_work_centres_company`);
  await knex.raw(`ALTER TABLE work_centres DROP COLUMN IF EXISTS company_id`);
}
