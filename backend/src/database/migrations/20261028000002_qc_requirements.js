/**
 * 20261028000002 — which inspections an order or a product requires before dispatch.
 *
 * Phase 3F. The dispatch gate (pickListWorkflow.finalInspectionBlockers) blocks
 * on failed and incomplete records, but an order with no inspection records
 * at all passes: which inspections apply to which product or order was never
 * defined anywhere. This table is where engineering defines it. Nothing is
 * seeded — until a requirement is configured, an order is reported as
 * qc_plan 'not_configured' and is not blocked for missing inspections.
 *
 *   item_id         a product: applies to every order that carries it
 *   sales_order_id  one order
 *   inspection      'FAT' (a test_runs row, stage FAT) or 'quality_test'
 *   test_name       for quality_test, the test required (NULL = any test)
 *   active          false once retired (kept for the audit trail)
 *
 * A configured requirement is met only by a PASSED record on a non-cancelled
 * production order of the sales order — and, for a product requirement, a
 * production order naming that product (production_orders.product_id; that
 * column has no foreign key, so a product requirement with no such production
 * order stays unmet rather than being assumed). Never by absence.
 *
 * Additive: one new table. Rollback: down() drops it.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS qc_requirements (
      id              serial PRIMARY KEY,
      company_id      integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      item_id         integer REFERENCES inventory_items(id) ON DELETE CASCADE,
      sales_order_id  integer REFERENCES sales_orders(id) ON DELETE CASCADE,
      inspection      varchar(20) NOT NULL CHECK (inspection IN ('FAT', 'quality_test')),
      test_name       text,
      notes           text,
      active          boolean NOT NULL DEFAULT true,
      created_by      integer,
      created_at      timestamptz NOT NULL DEFAULT NOW(),
      retired_by      integer,
      retired_at      timestamptz,
      CONSTRAINT qc_requirements_scope CHECK ((item_id IS NULL) <> (sales_order_id IS NULL)),
      CONSTRAINT qc_requirements_test_name CHECK (inspection = 'quality_test' OR test_name IS NULL)
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_qc_requirements_live
      ON qc_requirements (company_id, COALESCE(item_id, 0), COALESCE(sales_order_id, 0), inspection, LOWER(COALESCE(test_name, '')))
      WHERE active
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_qc_requirements_order ON qc_requirements (sales_order_id) WHERE sales_order_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_qc_requirements_item ON qc_requirements (item_id) WHERE item_id IS NOT NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS qc_requirements`);
}
