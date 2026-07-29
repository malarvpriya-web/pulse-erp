/**
 * Asset Lifecycle (Priority 1) — extends employee_asset_allocations beyond
 * Allocate/Return with Transfer, Maintenance (temporary out-of-service), and
 * Disposal, so the full Allocation -> Transfer -> Maintenance -> Return ->
 * Disposal chain has somewhere to write state. No new status enum constraint
 * exists on this table (checked baseline.sql), so the new status values
 * ('under_maintenance', 'disposed') are safe additions alongside the existing
 * free-text 'allocated'/'returned'.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE employee_asset_allocations
      ADD COLUMN IF NOT EXISTS transferred_from            INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS transferred_at              TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS maintenance_started_at       TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS maintenance_expected_return  DATE,
      ADD COLUMN IF NOT EXISTS maintenance_notes            TEXT,
      ADD COLUMN IF NOT EXISTS disposed_at                  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS disposal_reason              VARCHAR(255),
      ADD COLUMN IF NOT EXISTS disposed_by                  INTEGER REFERENCES employees(id) ON DELETE SET NULL
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE employee_asset_allocations
      DROP COLUMN IF EXISTS transferred_from,
      DROP COLUMN IF EXISTS transferred_at,
      DROP COLUMN IF EXISTS maintenance_started_at,
      DROP COLUMN IF EXISTS maintenance_expected_return,
      DROP COLUMN IF EXISTS maintenance_notes,
      DROP COLUMN IF EXISTS disposed_at,
      DROP COLUMN IF EXISTS disposal_reason,
      DROP COLUMN IF EXISTS disposed_by
  `);
}
