/**
 * 20260604000001_holidays_dedup_unique.js
 *
 * 1. Removes exact duplicate holidays (same company + date + name, case-insensitive),
 *    keeping the row with the lowest id in each group.
 *    Near-duplicates with different spellings (e.g. "New Year Day" vs "New Year's Day")
 *    are NOT touched here — those require a manual admin decision.
 *
 * 2. Adds a unique expression index on (COALESCE(company_id, 0), date, LOWER(name))
 *    so the application-layer duplicate check is also backed by a DB guarantee.
 *    COALESCE handles NULL company_id (global/seed holidays) correctly.
 */

export async function up(knex) {
  // ── Step 1: deduplicate ─────────────────────────────────────────────────────
  // Keep the lowest id per (company_id, date, name-ci) group.
  await knex.raw(`
    DELETE FROM holidays
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM   holidays
      GROUP  BY COALESCE(company_id, 0), date, LOWER(name)
    )
  `);

  // ── Step 2: unique expression index ────────────────────────────────────────
  // Plain (non-CONCURRENTLY) because we're inside a transaction and the table
  // is small. The LOWER() expression enforces case-insensitive uniqueness.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_unique_company_date_name
    ON holidays (COALESCE(company_id, 0), date, LOWER(name))
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_holidays_unique_company_date_name`);
}
