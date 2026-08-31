/**
 * 20260811000002_work_centre_labour_rate.js
 *
 * production_order_costs has always had std_labor_cost/actual_labor_cost/
 * std_overhead_cost/actual_overhead_cost columns (20260615000002), but nothing
 * has ever populated them — cost rollup only ever totals material + machine
 * cost (MANUFACTURING_COSTING_AUDIT.md GAP-5). Adds the one missing rate input
 * needed to compute labour cost the same way machine cost already is: a
 * per-work-centre hourly labour rate, mirroring the existing cost_per_hour
 * (machine) column. Overhead is absorbed as a company-wide percentage of
 * prime cost, stored in company_settings (module='production',
 * settings.overhead_absorption_pct) rather than a new table — same pattern
 * already used there for delay thresholds and allow_partial_issue.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE work_centres
      ADD COLUMN IF NOT EXISTS labour_rate_per_hour NUMERIC(10,2) DEFAULT 0
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE work_centres
      DROP COLUMN IF EXISTS labour_rate_per_hour
  `);
}
