/**
 * The four supplier KPIs that were named but never measured.
 *
 * 20260910000006/7 closed the two broken arrows in the supplier loop. This adds
 * the KPIs the loop is supposed to produce and that nothing in this database
 * computed:
 *
 *   fill_rate_pct            Quantity ordered vs quantity received, off the LINES.
 *                            The only fill rate in the codebase was
 *                            sales.routes.js:1432 — the SELL side. Procurement had
 *                            `po.status = 'partial'`, a count of orders flagged
 *                            partial that says nothing about how short they were:
 *                            a supplier shipping 40% of every line and one
 *                            shipping 99% scored identically.
 *
 *   lead_time_adherence_pct  Actual lead time against the PROMISED one, ±3 days.
 *                            Distinct from OTD, which is binary. `lead_time_days`
 *                            on the vendor master was an input assumption that
 *                            nothing ever compared against reality — and since it
 *                            is also OTD's fallback due date, a wrong lead time
 *                            silently flattered the supplier it described.
 *
 *   ppv_pct                  Actual paid vs inventory_items.standard_cost,
 *                            quantity-weighted. The existing `priceVariancePct`
 *                            compares a supplier's recent prices to its OWN
 *                            earlier prices, so one that has always been 30% over
 *                            standard looked perfectly stable. PPV is the measure
 *                            that can say a supplier is expensive rather than
 *                            merely inconsistent.
 *
 *   response_days /          Quote turnaround (rfqs.created_at -> rfq_quotes)
 *   response_source          and NCR response (ncr_reports -> first capa_actions).
 *                            The support dimension was a slider over a hard-coded
 *                            24-hour default that nothing measured; every supplier
 *                            without a hand-typed score got the same 70.
 *
 * ALL FOUR ARE NULLABLE AND MEAN IT. Unmeasured stores NULL, never 0 — a 0% fill
 * rate is the worst possible reading of "nobody has ordered from them yet", and
 * this codebase has been bitten by exactly that before
 * (project_supplier_performance_index). `response_source` records whether the
 * responsiveness figure was measured from transactions, taken from the stored
 * scorecard slider, or absent.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE vendor_health_scores ADD COLUMN IF NOT EXISTS fill_rate_pct           NUMERIC(5,2)`);
  await knex.raw(`ALTER TABLE vendor_health_scores ADD COLUMN IF NOT EXISTS lead_time_adherence_pct NUMERIC(5,2)`);
  await knex.raw(`ALTER TABLE vendor_health_scores ADD COLUMN IF NOT EXISTS avg_lead_time_variance_days NUMERIC(6,1)`);
  await knex.raw(`ALTER TABLE vendor_health_scores ADD COLUMN IF NOT EXISTS ppv_pct                 NUMERIC(7,2)`);
  await knex.raw(`ALTER TABLE vendor_health_scores ADD COLUMN IF NOT EXISTS response_days           NUMERIC(6,1)`);
  await knex.raw(`ALTER TABLE vendor_health_scores ADD COLUMN IF NOT EXISTS response_source         VARCHAR(12)`);

  // Nothing to backfill: no prior run computed any of these, and inventing a
  // value is the failure mode this whole pass exists to remove. The next
  // recalculation fills in whatever the transactions actually support.
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE vendor_health_scores DROP COLUMN IF EXISTS response_source`);
  await knex.raw(`ALTER TABLE vendor_health_scores DROP COLUMN IF EXISTS response_days`);
  await knex.raw(`ALTER TABLE vendor_health_scores DROP COLUMN IF EXISTS ppv_pct`);
  await knex.raw(`ALTER TABLE vendor_health_scores DROP COLUMN IF EXISTS avg_lead_time_variance_days`);
  await knex.raw(`ALTER TABLE vendor_health_scores DROP COLUMN IF EXISTS lead_time_adherence_pct`);
  await knex.raw(`ALTER TABLE vendor_health_scores DROP COLUMN IF EXISTS fill_rate_pct`);
}
