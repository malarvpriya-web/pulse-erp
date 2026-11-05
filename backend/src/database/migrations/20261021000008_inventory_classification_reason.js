/**
 * 20261021000008 — why an item has no ABC/XYZ class, and when it was last classified.
 *
 * The planning run evaluates every active item but can only classify by value
 * (ABC) and variability (XYZ) the ones with at least min_periods_for_stats
 * months of demand. The rest used to be skipped before anything was written, so
 * the item master kept whatever an earlier run had left there — or NULL — and
 * FSN was never written for them at all, which is why a never-issued part could
 * not show as Non-moving. The run now writes every item; these two columns let
 * the item master say what that write meant:
 *
 *   classification_reason  NULL when ABC/XYZ were computed. 'insufficient_history'
 *                          when the run evaluated the item and deliberately left
 *                          ABC/XYZ NULL. NULL classes with a NULL reason and a
 *                          NULL classified_at means "never evaluated".
 *   classified_at          when a planning run last wrote this item's
 *                          classification (ABC/XYZ/FSN). planning_params_computed_at
 *                          is NOT reused for this: it dates EOQ / safety stock /
 *                          reorder point, which an insufficient-history item does
 *                          not get, and moving it would make stale parameters
 *                          look fresh.
 *
 * Also on record: inventory_items.last_movement_date now holds the date of the
 * last qualifying ISSUE (the FSN basis), not the last ledger row of any kind.
 *
 * Both columns are nullable with no default and no backfill, so every existing
 * reader and writer is unaffected; the next run (nightly at 02:30 IST, or the
 * Recompute button) populates them.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS classification_reason TEXT,
      ADD COLUMN IF NOT EXISTS classified_at         TIMESTAMPTZ
  `);

  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_classification_reason_chk'`);
  if (!rows.length) {
    await knex.raw(`
      ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_classification_reason_chk
        CHECK (classification_reason IS NULL OR classification_reason IN ('insufficient_history'))
    `);
  }
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE inventory_items
      DROP CONSTRAINT IF EXISTS inventory_items_classification_reason_chk,
      DROP COLUMN IF EXISTS classification_reason,
      DROP COLUMN IF EXISTS classified_at
  `);
}
