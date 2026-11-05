/**
 * 20260915000012_inventory_kpi_thresholds.js
 *
 * Inventory audit — finding 30 (dashboard KPIs).
 *
 * The audit found eight KPIs absent from the inventory dashboard, among them
 * excess inventory and obsolete/slow-moving stock. Both are threshold
 * judgements: "excess" means nothing until somebody says how many days of cover
 * is too many, and that number is a policy argument, not a constant.
 *
 * Finding 4 was the same mistake one table over — the ABC bands were function
 * defaults nobody could change — so putting a hard-coded `> 180 days` in the
 * KPI service would have been the identical defect committed knowingly. It
 * lives beside the ordering cost, holding rate, service level and ABC/XYZ/FSN
 * bands that already govern planning, because it is the same kind of number and
 * the same people argue about it.
 *
 * WHY 180 IS THE DEFAULT
 * Half a year of cover is the conventional first cut, and it sits deliberately
 * clear of fsn_nonmoving_days (180 days since the last MOVEMENT). The two ask
 * different questions and must not be read as one: an item can turn over
 * briskly and still be over-stocked, and an item can be non-moving while
 * holding barely any stock at all. Overlapping the two thresholds would let a
 * reader assume the KPIs double-count, and they do not.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE inventory_planning_settings
      ADD COLUMN IF NOT EXISTS excess_cover_days integer NOT NULL DEFAULT 180
  `);

  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'ips_excess_cover_days_positive'`);
  if (!rows.length) {
    await knex.raw(`
      ALTER TABLE inventory_planning_settings
        ADD CONSTRAINT ips_excess_cover_days_positive CHECK (excess_cover_days > 0)`);
  }
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE inventory_planning_settings
      DROP CONSTRAINT IF EXISTS ips_excess_cover_days_positive,
      DROP COLUMN IF EXISTS excess_cover_days
  `);
}
