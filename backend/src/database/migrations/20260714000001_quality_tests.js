/**
 * 20260714000001_quality_tests.js
 *
 * Material & production quality testing.
 *
 * Business need: when a material lands in Stores (via a GRN) it must be linked
 * to the Quality department, which decides HOW MANY quality tests to run against
 * it and records each result. The same test capability must exist at every level
 * of Production (each production_operation / routing step).
 *
 * Rather than force the fixed-step `inspection_checklists` model, this introduces
 * a flexible `quality_tests` table: N ad-hoc test rows per source. A source is
 * polymorphic — a GRN (material in stores) or a production_operation (any level
 * of production). Each row is a single testable parameter with a spec window and
 * an actual reading, so pass/fail can be auto-evaluated and an NCR auto-raised on
 * failure (reusing quality_settings.iqc_auto_ncr_on_fail).
 *
 * Also adds `quality_status` to goods_receipt_notes so Stores can show, at a
 * glance, whether received material is awaiting / passed / failed QC, and
 * `quality_status` to production_operations for the same at each production level.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS quality_tests (
      id                   SERIAL PRIMARY KEY,
      company_id           INTEGER,
      source_type          VARCHAR(40) NOT NULL,   -- 'grn' | 'production_operation' | 'production_order'
      source_id            INTEGER,                -- id within the source domain
      grn_id               INTEGER,
      production_order_id   INTEGER,
      operation_id         INTEGER,                -- production_operations.id (production level)
      item_id              INTEGER,                -- inventory_items.id
      item_name            TEXT,
      batch_number         VARCHAR(120),
      stage                VARCHAR(20) DEFAULT 'IQC',   -- IQC | IPQC | FQC | PDI
      test_name            TEXT NOT NULL,
      test_method          TEXT,
      parameter            TEXT,
      spec_min             NUMERIC,
      spec_max             NUMERIC,
      unit                 VARCHAR(40),
      expected_value       TEXT,                   -- for non-numeric / pass_fail tests
      actual_value         TEXT,
      result               VARCHAR(12) DEFAULT 'pending',  -- pending | pass | fail | na
      status               VARCHAR(12) DEFAULT 'open',     -- open | completed
      is_mandatory         BOOLEAN DEFAULT TRUE,
      assigned_to          INTEGER,                -- employees.id (quality dept)
      tested_by            INTEGER,
      tested_by_name       TEXT,
      tested_at            TIMESTAMPTZ,
      ncr_id               INTEGER,
      remarks              TEXT,
      created_by           INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_quality_tests_source
                    ON quality_tests (company_id, source_type, source_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_quality_tests_grn
                    ON quality_tests (grn_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_quality_tests_prod_order
                    ON quality_tests (production_order_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_quality_tests_operation
                    ON quality_tests (operation_id)`);

  // Overall QC state visible in Stores for each received material lot
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'goods_receipt_notes' AND column_name = 'quality_status') THEN
        ALTER TABLE goods_receipt_notes ADD COLUMN quality_status VARCHAR(20) DEFAULT 'not_required';
        -- not_required | pending | in_progress | passed | failed | waived
      END IF;
    END $$
  `);

  // Overall QC state per production level (operation)
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'production_operations' AND column_name = 'quality_status') THEN
        ALTER TABLE production_operations ADD COLUMN quality_status VARCHAR(20) DEFAULT 'not_required';
      END IF;
    END $$
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS quality_tests`);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP COLUMN IF EXISTS quality_status`);
  await knex.raw(`ALTER TABLE production_operations DROP COLUMN IF EXISTS quality_status`);
}
