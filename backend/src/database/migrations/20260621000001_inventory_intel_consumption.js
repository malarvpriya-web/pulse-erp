/**
 * 20260621000001_inventory_intel_consumption.js
 *
 * 1. preferred_vendor_id on inventory_items — links a default vendor for reorder alerts
 * 2. project_id on inventory_allocations — enables "By Project" grouping in MaterialConsumption
 */

export async function up(knex) {
  // preferred_vendor_id on inventory_items
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS preferred_vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_inv_items_preferred_vendor
      ON inventory_items(preferred_vendor_id)
      WHERE preferred_vendor_id IS NOT NULL
  `);

  // project_id on inventory_allocations (material consumption tracking by project)
  await knex.raw(`
    ALTER TABLE inventory_allocations
      ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_inv_alloc_project
      ON inventory_allocations(project_id)
      WHERE project_id IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_inv_alloc_project`);
  await knex.raw(`ALTER TABLE inventory_allocations DROP COLUMN IF EXISTS project_id`);
  await knex.raw(`DROP INDEX IF EXISTS idx_inv_items_preferred_vendor`);
  await knex.raw(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS preferred_vendor_id`);
}
