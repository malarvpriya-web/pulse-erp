/**
 * `inspection_reports` was created (20260505000001) without `grn_id` or
 * `company_id`, and no later migration ever added them -- but
 * quality.routes.js's POST /inspect has always INSERTed both:
 *   INSERT INTO inspection_reports (..., grn_id, ..., company_id, ...)
 * which throws `column "grn_id" of relation "inspection_reports" does not
 * exist` unconditionally, for every caller. Confirmed live: this is not a
 * caller-shape issue, the columns are simply missing. That makes every
 * inspection creation from InspectionCenter.jsx / QualityManagement.jsx a
 * guaranteed 500, and (per the same route) blocks the auto-hold-on-fail path
 * that depends on the row actually being created.
 *
 * Both columns are clearly intentional, not leftover cruft: `grn_id` is read
 * back in GET /inspect's filters and in the vendor-QC join in this same file
 * (`LEFT JOIN inspection_reports ir ON ir.grn_id=g.id`), and `company_id`
 * follows the same scoping convention as every sibling quality table
 * (quality_tests, ncr_reports, quality_settings all have it).
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS grn_id INTEGER REFERENCES goods_receipt_notes(id) ON DELETE SET NULL`);
  await knex.raw(`ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_inspection_reports_grn ON inspection_reports(grn_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_inspection_reports_company ON inspection_reports(company_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_inspection_reports_company`);
  await knex.raw(`DROP INDEX IF EXISTS idx_inspection_reports_grn`);
  await knex.raw(`ALTER TABLE inspection_reports DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`ALTER TABLE inspection_reports DROP COLUMN IF EXISTS grn_id`);
}
