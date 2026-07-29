/**
 * Unified Warranty Engine (Priority 3) — three previously disconnected
 * warranty sources (`customer_equipment.warranty_status`, `project_warranties`,
 * `warranty_registrations`) converge on `warranty_registrations` (+ its
 * existing `warranty_claims` child table), the most feature-complete of the
 * three (has a claims workflow, coverage flags, and links to
 * asset_id/sales_order_id/lifecycle_instance_id already).
 *
 * All three source tables were confirmed EMPTY in the live database before
 * this migration — zero data-migration/backfill risk. `project_warranties`
 * is left in place (not dropped) since dropping a table is a one-way door
 * and isn't needed to fix the gap; application code simply stops writing to
 * it (see projects.routes.js).
 *
 * New columns let one row serve every consumer the audit named:
 *  - project_id / commissioning_workflow_id / equipment_id: link the same
 *    warranty row back to Projects, Commissioning, and Customer
 *    Equipment/Portal — previously each of those had its OWN table.
 *  - amc_contract_id: lets AMC Management surface the linked warranty.
 *  - commissioning_date, manufacturer_warranty_months, extended_warranty_months,
 *    coverage_description: fields the Projects warranty UI already expects
 *    (WarrantyManagement.jsx) that project_warranties never actually had a
 *    matching column for in one case (coverage_description — its PUT handler
 *    referenced a column that didn't exist, a live 500-on-edit bug fixed as
 *    part of this migration by giving it a real home).
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE warranty_registrations
      ADD COLUMN IF NOT EXISTS project_id                    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS commissioning_workflow_id      INTEGER REFERENCES commissioning_workflows(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS equipment_id                   INTEGER REFERENCES customer_equipment(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS amc_contract_id                INTEGER REFERENCES amc_contracts(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS commissioning_date             DATE,
      ADD COLUMN IF NOT EXISTS manufacturer_warranty_months   INTEGER,
      ADD COLUMN IF NOT EXISTS extended_warranty_months       INTEGER,
      ADD COLUMN IF NOT EXISTS coverage_description           TEXT
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_warranty_registrations_project      ON warranty_registrations(project_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_warranty_registrations_equipment    ON warranty_registrations(equipment_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_warranty_registrations_commiss_wf   ON warranty_registrations(commissioning_workflow_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_warranty_registrations_amc_contract ON warranty_registrations(amc_contract_id)`);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE warranty_registrations
      DROP COLUMN IF EXISTS project_id,
      DROP COLUMN IF EXISTS commissioning_workflow_id,
      DROP COLUMN IF EXISTS equipment_id,
      DROP COLUMN IF EXISTS amc_contract_id,
      DROP COLUMN IF EXISTS commissioning_date,
      DROP COLUMN IF EXISTS manufacturer_warranty_months,
      DROP COLUMN IF EXISTS extended_warranty_months,
      DROP COLUMN IF EXISTS coverage_description
  `);
}
