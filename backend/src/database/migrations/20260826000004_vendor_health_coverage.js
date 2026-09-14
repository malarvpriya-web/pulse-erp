/**
 * Supplier Performance Index — record how much of each score is evidence-based.
 *
 * The composite is now renormalised over only the dimensions that have data
 * behind them (see vendorHealthEngine.computeVendorHealth). That makes the
 * number honest but it also makes two scores of 60 potentially very different
 * claims: one weighed all eight dimensions, the other weighed compliance and
 * financials alone. `coverage_pct` is the share of the total dimension weight
 * that voted, 0-100, so a reader can tell those apart.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE vendor_health_scores
      ADD COLUMN IF NOT EXISTS coverage_pct NUMERIC(5,1)
  `);
  await knex.raw(`
    ALTER TABLE vendor_health_scores
      ADD CONSTRAINT vendor_health_scores_coverage_range
      CHECK (coverage_pct IS NULL OR (coverage_pct >= 0 AND coverage_pct <= 100))
  `).catch(() => {});
  await knex.raw(`
    ALTER TABLE vendor_health_timeline
      ADD COLUMN IF NOT EXISTS coverage_pct NUMERIC(5,1)
  `).catch(() => {});
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE vendor_health_scores DROP CONSTRAINT IF EXISTS vendor_health_scores_coverage_range`).catch(() => {});
  await knex.raw(`ALTER TABLE vendor_health_scores  DROP COLUMN IF EXISTS coverage_pct`);
  await knex.raw(`ALTER TABLE vendor_health_timeline DROP COLUMN IF EXISTS coverage_pct`).catch(() => {});
}
