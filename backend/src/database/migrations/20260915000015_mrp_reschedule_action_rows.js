/**
 * Let MRP write the reschedule action messages its own columns were added for.
 *
 * `mrp_planned_orders` has carried `reschedule_action`, `reschedule_to_date`,
 * `reschedule_reason`, `supply_ref_type` and `supply_ref_id` since the SCA
 * spine work. Nothing ever wrote them, and nothing could: two CHECK constraints
 * restrict the table to order_type make|buy and status planned|firmed|
 * converted|ignored, so an action message against a purchase order that already
 * exists had nowhere to go. Reschedule messages lived only as exception text.
 *
 * That matters beyond tidiness. A reschedule message is the path by which a
 * MEASURED supplier delay reaches planning — the 2026-09-11 audit's finding
 * that supplier lateness was scored in vendor health and fed back into nothing.
 * As free text in an exception list it is a notification; as a row with
 * supply_ref_id on it, it is something a planner can filter, sort, bulk-action
 * and close.
 *
 * WHY THIS IS SAFE
 * ----------------
 * The new rows use status 'action', which no existing code selects:
 *   - convert-all filters `status = 'planned'`
 *   - single convert re-reads the row and refuses anything not 'planned'
 *   - CRP's planned-load query filters `status IN ('planned','firmed')`
 * so a reschedule message can never be mistaken for supply to raise. The
 * workbench filters them out of the planned-order list and shows them in their
 * own tab.
 *
 * The constraints are widened, not dropped: make|buy|reschedule and
 * planned|firmed|converted|ignored|action. Anything else is still refused.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE mrp_planned_orders DROP CONSTRAINT IF EXISTS chk_planned_type`);
  await knex.raw(`ALTER TABLE mrp_planned_orders DROP CONSTRAINT IF EXISTS chk_planned_status`);
  await knex.raw(`
    ALTER TABLE mrp_planned_orders
      ADD CONSTRAINT chk_planned_type
      CHECK (order_type::text = ANY (ARRAY['make','buy','reschedule']))`);
  await knex.raw(`
    ALTER TABLE mrp_planned_orders
      ADD CONSTRAINT chk_planned_status
      CHECK (status::text = ANY (ARRAY['planned','firmed','converted','ignored','action']))`);

  // 'reschedule_in' / 'reschedule_out' do not fit varchar(12); the engine uses
  // 'pull_in' / 'push_out' / 'cancel'. Widened anyway so the column cannot
  // silently truncate a future action word and take an MRP run down with a 500,
  // which is how this was found.
  await knex.raw(`ALTER TABLE mrp_planned_orders ALTER COLUMN reschedule_action TYPE VARCHAR(24)`);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_mrp_po_action
        ON mrp_planned_orders (run_id, status)
     WHERE status = 'action'`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_mrp_po_action`);
  await knex.raw(`DELETE FROM mrp_planned_orders WHERE status = 'action' OR order_type = 'reschedule'`);
  await knex.raw(`ALTER TABLE mrp_planned_orders DROP CONSTRAINT IF EXISTS chk_planned_type`);
  await knex.raw(`ALTER TABLE mrp_planned_orders DROP CONSTRAINT IF EXISTS chk_planned_status`);
  await knex.raw(`
    ALTER TABLE mrp_planned_orders
      ADD CONSTRAINT chk_planned_type CHECK (order_type::text = ANY (ARRAY['make','buy']))`);
  await knex.raw(`
    ALTER TABLE mrp_planned_orders
      ADD CONSTRAINT chk_planned_status
      CHECK (status::text = ANY (ARRAY['planned','firmed','converted','ignored']))`);
}
