/**
 * 20260929000003 — employment-type and zone normalisation.
 *
 * ⚠ THIS MIGRATION TOUCHES LIVE EMPLOYEE DATA. Every change below is either a
 * no-information-loss normalisation or a backfill of a column that is NULL on
 * every row, and each one is listed with its exact row count as measured on
 * 2026-09-29. Anything that could lose information is deliberately NOT done
 * here and is reported for HR instead.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 1. `employees.employment_type` — two normalisations, one left alone
 * ══════════════════════════════════════════════════════════════════════════
 * Measured on company 1 (35 rows):
 *
 *     NULL          25   not recorded
 *     ''             4   not recorded, stored as an empty string
 *     'Permanent'    3   canonical (in the master)
 *     'Probation'    1   canonical (in the master)
 *     'Full Time'    1   canonical (in the master)
 *     'full_time'    1   NOT in the master  <-- the recruitment-era spelling
 *
 * DONE — `''` → NULL (4 rows).
 *   Empty string and NULL both mean "not recorded", but only one of them
 *   survives a truthiness check. `'' ` is exactly what an untouched picker
 *   POSTs, and it is why four employees read as having an employment type in
 *   any `IS NOT NULL` query and as blank on screen. No information is lost:
 *   the empty string carried none.
 *
 * DONE — `'full_time'` → `'Full Time'` (1 row).
 *   The column was written by TWO vocabularies — this page's HR list and
 *   recruitment's snake_case one (see modules/master/vocabularies.js). They are
 *   the same employment type spelled two ways, and only 'Full Time' is in the
 *   master, so the other row is a value no picker can offer back: opening that
 *   employee shows an out-of-list value, and any report grouping by employment
 *   type splits one category in two. The mapping is unambiguous.
 *
 * NOT DONE — the master value `'Test'` (company 1, id 1853).
 *   It is obvious debris and NO employee uses it, so deactivating it is safe
 *   and reversible. It is still somebody's master data and this is not a
 *   migration's decision: it is one click in Administration -> Master Data
 *   ("Delete" — the row shows `unused`, so it hard-deletes cleanly). Reported,
 *   not touched.
 *
 * NOT DONE — filling in the 25 NULL / 4 blanked employment types.
 *   There is no safe source for them. Guessing 'Permanent' for 29 people is
 *   inventing HR data, and the Incomplete badge on All Employees is the right
 *   place for it to surface.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 2. `master_zones` — five seeding artefacts, and the real zones missing
 * ══════════════════════════════════════════════════════════════════════════
 * The zone master held FIVE rows and all five are debris from an empty-table
 * seeding pass (2026-08-20T16:01:03, five rows in three milliseconds):
 *
 *     'SEED Master Zones 1-SEED07002' … 'SEED Master Zones 5-SEED07010'
 *
 * Meanwhile the zones employees actually carry — 'North' (2) and 'HO' (2) —
 * were NOT in the master at all.
 *
 * This is not cosmetic. `holidays.zone_id` is a real FK with a real consumer:
 * the Holiday Calendar assigns a holiday to a zone and deliberately filters out
 * the id-less employee-derived rows, "they are not real master zones and cannot
 * be stored as holidays.zone_id". So the zone picker on that screen offered
 * five meaningless SEED names and could not offer North or HO.
 *
 * DONE — deactivate the 5 SEED rows. Deactivated, not deleted: nothing
 *   references them (0 employees, 0 holidays — checked), but deactivation is
 *   reversible and this migration should not be the thing that destroys a row
 *   somebody might recognise.
 *
 * DONE — promote 'North' and 'HO' into the master, so they are real zones with
 *   ids that the Holiday Calendar can use and Master Data can manage.
 *
 * DONE — backfill `employees.zone_id` from the matching master row.
 *   `zone_id` was NULL on all 46 employees while the text column carried the
 *   value: the column and the FK existed and nothing had ever written them —
 *   the same "empty column with zero writers" that `branch_id` turned out to
 *   be. A backfill cannot overwrite anything, because there is nothing there.
 *
 * ⚠ The `zone` TEXT column is KEPT and stays authoritative for display, exactly
 * as `location` does beside `branch_id`. Dropping it is a separate change that
 * needs every reader migrated first; see WORKFORCE_MODEL.md / the report. From
 * now on the API writes BOTH and derives the text from the chosen master row,
 * so the two cannot drift.
 */

export async function up(knex) {
  // ── 1. employment_type ────────────────────────────────────────────────────
  const blanked = await knex.raw(
    `UPDATE employees SET employment_type = NULL
      WHERE employment_type IS NOT NULL AND BTRIM(employment_type) = ''
      RETURNING id`);
  console.log(`  [20260929000003] employment_type '' -> NULL: ${blanked.rows.length} row(s)`);

  // Mapped against the master, not hard-coded: if a deployment has already
  // renamed 'Full Time' the UPDATE simply finds no target and does nothing,
  // rather than writing a value that master does not hold.
  const mapped = await knex.raw(
    `UPDATE employees e SET employment_type = m.value
       FROM master_values m
      WHERE m.type = 'EMPLOYMENT_TYPE' AND m.is_active
        AND LOWER(REPLACE(BTRIM(m.value), ' ', '_')) = LOWER(REPLACE(BTRIM(e.employment_type), ' ', '_'))
        AND e.employment_type IS DISTINCT FROM m.value
      RETURNING e.id, e.employment_type`);
  console.log(`  [20260929000003] employment_type snake_case -> canonical: ${mapped.rows.length} row(s)`);

  // ── 2. zones ──────────────────────────────────────────────────────────────
  // Only rows that look like the seeder's output AND are referenced by nothing.
  const seeded = await knex.raw(
    `UPDATE master_zones SET is_active = false
      WHERE name ~ '^SEED .*-SEED[0-9]+$'
        AND NOT EXISTS (SELECT 1 FROM employees  e WHERE e.zone_id  = master_zones.id)
        AND NOT EXISTS (SELECT 1 FROM holidays   h WHERE h.zone_id  = master_zones.id)
      RETURNING id, name`);
  console.log(`  [20260929000003] SEED zones deactivated: ${seeded.rows.length} row(s)`);

  // Promote the zones employees really carry.
  // ⚠ ON CONFLICT names the NORMALISED partial index from 20260929000002, not
  // the old exact-case constraint, which that migration dropped.
  await knex.raw(
    `INSERT INTO master_zones (name, is_active)
     SELECT DISTINCT BTRIM(zone), true FROM employees
      WHERE NULLIF(BTRIM(COALESCE(zone, '')), '') IS NOT NULL
     ON CONFLICT (LOWER(BTRIM(name))) WHERE is_active DO NOTHING`);

  const linked = await knex.raw(
    `UPDATE employees e SET zone_id = z.id
       FROM master_zones z
      WHERE z.is_active
        AND LOWER(BTRIM(z.name)) = LOWER(BTRIM(COALESCE(e.zone, '')))
        AND e.zone_id IS NULL
      RETURNING e.id`);
  console.log(`  [20260929000003] employees.zone_id backfilled: ${linked.rows.length} row(s)`);
}

export async function down() {
  // Deliberately EMPTY.
  //
  // Every change above is a normalisation towards the canonical value. Undoing
  // them means writing 'full_time' back over 'Full Time' and blanking a
  // correctly-linked zone_id — i.e. restoring defects. A rollback of this
  // migration should leave the data correct.
  //
  // The SEED zone rows are deactivated, not deleted, so an operator who wants
  // them back can reactivate them in Administration -> Master Data.
}
