/**
 * Carry the OTD basis onto the stored scorecard, so the two places that publish
 * a supplier's on-time rate cannot disagree.
 *
 * 20260910000006 taught the delivery scorer to say whether the due dates it
 * measured against were promised by the supplier ('quoted'/'agreed') or derived
 * by us from vendors.lead_time_days, and stopped vendors.on_time_pct being
 * published off a derived one.
 *
 * `vendor_health_scores.otd_pct` was left alone, and that split the truth in
 * two: the vendor master said "no measured on-time rate" while the scorecard
 * table beside it still said 100%. The heatmap, the CEO roll-up and the trend
 * chart all read the second one, and none of them had any way to know the
 * number came from a date nobody committed to.
 *
 * `otd_pct` is now gated identically to vendors.on_time_pct, and the basis
 * travels with it so a reader can qualify what it is looking at rather than
 * having to infer it. NULL in the trend series is already this codebase's
 * "unmeasured" — recharts draws a gap, not a cliff to the axis that reads as a
 * collapse (see project_supplier_performance_index).
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE vendor_health_scores ADD COLUMN IF NOT EXISTS otd_basis VARCHAR(12)`);
  await knex.raw(`ALTER TABLE vendor_health_scores ADD COLUMN IF NOT EXISTS promised_coverage_pct NUMERIC(5,1)`);

  // Existing rows were all scored before a basis existed, and every purchase
  // order in this database predates expected_delivery_basis. Their stored
  // otd_pct is therefore measured against a derived date by definition: clear it
  // and mark it, rather than leaving a figure the new rules would not publish.
  // The next recalculation restates anything that has since earned a real one.
  await knex.raw(`
    UPDATE vendor_health_scores vhs
       SET otd_pct               = NULL,
           otd_basis             = CASE WHEN vhs.otd_pct IS NULL THEN 'none' ELSE 'implied' END,
           promised_coverage_pct = 0
     WHERE vhs.otd_basis IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM purchase_orders po
          WHERE po.supplier_id = vhs.vendor_id
            AND po.expected_delivery_date IS NOT NULL
            AND COALESCE(po.expected_delivery_basis, 'agreed') IN ('quoted', 'agreed')
       )
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE vendor_health_scores DROP COLUMN IF EXISTS promised_coverage_pct`);
  await knex.raw(`ALTER TABLE vendor_health_scores DROP COLUMN IF EXISTS otd_basis`);
}
