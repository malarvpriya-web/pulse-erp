/**
 * 20260704000003_production_operations_is_inspection.js
 *
 * Adds the `is_inspection` flag to production_operations.
 *
 * The execution routes (execution.routes.js) already write and read this column:
 *   - Order create clones routing steps into production_operations INCLUDING is_inspection
 *   - Operation START checks the previous step's is_inspection to gate inspection steps
 *   - Operation COMPLETE raises an auto-NCR when scrap occurs on an inspection step
 *
 * The column was only ever added to routing_steps, never to production_operations,
 * so every start/create hit "column ... is_inspection does not exist" (500), which
 * surfaced on the Shop Floor page as load/save errors.
 *
 * Backfills existing rows from the linked routing step so historical inspection
 * steps keep their gating behaviour.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE production_operations
      ADD COLUMN IF NOT EXISTS is_inspection BOOLEAN DEFAULT FALSE
  `);

  // Backfill from the originating routing step where one is linked
  await knex.raw(`
    UPDATE production_operations op
    SET is_inspection = rs.is_inspection
    FROM routing_steps rs
    WHERE op.routing_step_id = rs.id
      AND rs.is_inspection IS NOT NULL
      AND op.is_inspection IS DISTINCT FROM rs.is_inspection
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE production_operations
      DROP COLUMN IF EXISTS is_inspection
  `);
}
