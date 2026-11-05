/**
 * 20260929000002 — master-data governance.
 *
 * Three things the Master Data Setup screen needs and the schema could not
 * support, plus the workforce vocabulary the employee model was missing.
 *
 * ── 1. NORMALISED UNIQUENESS ────────────────────────────────────────────────
 * `master_departments_name_key` is `UNIQUE (name)` — EXACT CASE. So
 *
 *     Engineering    engineering    ENGINEERING    'Engineering '
 *
 * are four different departments as far as the database is concerned, and all
 * four insert cleanly. The picker then offers four spellings of one thing and
 * every report that groups by department splits them.
 *
 * `master_values` already got this right in 20260916000010
 * (`ux_master_values_type_company_value` on
 *  `(type, COALESCE(company_id,0), lower(btrim(value)))`). This brings the five
 * organisation masters up to the same rule — which is also the rule
 * `duplicateOf()` and `countUsage()` compare with, so index, validator and
 * usage count all normalise identically.
 *
 * ⚠ SCOPE DIFFERS BY TABLE AND IS PRESERVED EXACTLY.
 *   departments / designations / zones  have NO company_id column — they are
 *                                       genuinely shared. Unique on the name
 *                                       alone, as before.
 *   grades / bands                      are company-scoped. Unique per company,
 *                                       as before.
 * Widening or narrowing either would be a silent tenancy change.
 *
 * The de-duplication below runs FIRST because the index cannot be created while
 * variants exist. On this database there are none (checked: zero case-variant
 * groups in all five tables), so it is a no-op here — but it must be in the
 * migration, or the first deployment that does have one fails to boot.
 *
 * ── 2. AUDIT COLUMNS ────────────────────────────────────────────────────────
 * Every one of these tables had `created_at` and nothing else. "Who added
 * 'Enginering' and when did it change?" was unanswerable from the row. The
 * audit log carries the mutation (these routes mount behind
 * `auditMutations('master')`), but a screen listing 24 designations cannot join
 * to it per row.
 *
 * `created_by`/`updated_by` are `users.id`, NOT `employees.id`. Confusing the
 * two is a recurring bug here — `*_by` columns elsewhere in this schema point
 * at employees. These are set from `req.user.id`, which is a users row, so the
 * FK says so.
 *
 * ── 3. WORKFORCE VOCABULARY ─────────────────────────────────────────────────
 * Housekeeping, security, drivers and office assistants are company workers and
 * belong in `employees`, differentiated by department + designation +
 * employment type. The masters could not express that: there was no Facilities,
 * Security or Administration department and no Housekeeping/Guard/Driver/Office
 * Assistant designation, so the only way to file one was to type a value the
 * master did not hold.
 *
 * ⚠ This does NOT create a second workforce model. Agency-supplied labour
 * already has one — `contract_labour` (+ `contract_labour_attendance`), company
 * scoped, with contractor_company, PF/ESI coverage, safety certification and
 * contract expiry: the Contract Labour Act shape, and 4 live rows. A person on
 * an agency's payroll goes there. A person on the company's payroll goes in
 * `employees` whatever work they do.
 */

/** Departments a facilities/security/admin workforce needs. */
const DEPARTMENTS = ['Facilities', 'Security', 'Administration'];

/**
 * Designations for the same. 'Driver' and 'Office Assistant' sit under
 * Administration, the rest under Facilities/Security — but these masters carry
 * no parent, so the pairing is a matter of how the record is filled in, not a
 * constraint. Deliberately left flat rather than inventing a hierarchy the rest
 * of the app would not read.
 */
const DESIGNATIONS = [
  'Housekeeping Staff', 'Housekeeping Supervisor',
  'Security Guard', 'Security Supervisor',
  'Driver', 'Office Assistant', 'Facilities Executive', 'Maintenance Technician',
];

/** name-unique, no company_id. */
const SHARED = ['master_departments', 'master_zones', 'master_designations'];
/** (company_id, name)-unique. */
const SCOPED = ['master_grades', 'master_bands'];

export async function up(knex) {
  // ── 1a. Collapse existing case/whitespace variants ────────────────────────
  // Keep the LOWEST id — the earliest row, which is the one other data is most
  // likely to have been entered against. The losers are DEACTIVATED, never
  // deleted: a variant that employees still carry must keep rendering on their
  // records, and MasterSelect offers a stored-but-unlisted value back as its
  // own option. Deleting them would also break the index's own precondition
  // differently on every deployment.
  for (const t of SHARED) {
    await knex.raw(`
      UPDATE ${t} SET is_active = false
       WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY LOWER(BTRIM(name)) ORDER BY is_active DESC, id
                  ) AS rn
             FROM ${t}
         ) d WHERE d.rn > 1
       )`);
  }
  for (const t of SCOPED) {
    await knex.raw(`
      UPDATE ${t} SET is_active = false
       WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(company_id, 0), LOWER(BTRIM(name))
                    ORDER BY is_active DESC, id
                  ) AS rn
             FROM ${t}
         ) d WHERE d.rn > 1
       )`);
  }

  // ⚠ A deactivated duplicate still occupies the normalised key, so the index
  // has to be PARTIAL on is_active — otherwise the de-duplication above cannot
  // satisfy the index it exists to enable. That also means a retired value can
  // be re-created, which is the right behaviour: retiring "Sales & Marketing"
  // should not reserve the name forever.
  for (const t of SHARED) {
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_${t}_name_norm
         ON ${t} (LOWER(BTRIM(name))) WHERE is_active`);
  }
  for (const t of SCOPED) {
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_${t}_company_name_norm
         ON ${t} (COALESCE(company_id, 0), LOWER(BTRIM(name))) WHERE is_active`);
  }

  // The old exact-case indexes are now strictly weaker than the new ones AND
  // actively wrong: `master_departments_name_key` would refuse to let a retired
  // 'Sales & Marketing' be re-created, which the partial index above allows on
  // purpose. Dropped rather than left to fight it.
  await knex.raw(`ALTER TABLE master_departments  DROP CONSTRAINT IF EXISTS master_departments_name_key`);
  await knex.raw(`ALTER TABLE master_designations DROP CONSTRAINT IF EXISTS master_designations_name_key`);
  await knex.raw(`ALTER TABLE master_zones        DROP CONSTRAINT IF EXISTS master_zones_name_key`);
  await knex.raw(`ALTER TABLE master_grades       DROP CONSTRAINT IF EXISTS master_grades_company_id_name_key`);
  await knex.raw(`ALTER TABLE master_bands        DROP CONSTRAINT IF EXISTS master_bands_company_id_name_key`);

  // ── 2. Audit columns ──────────────────────────────────────────────────────
  for (const t of [...SHARED, ...SCOPED, 'master_values']) {
    await knex.raw(`
      ALTER TABLE ${t}
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
  }

  // ── 3. Workforce vocabulary ───────────────────────────────────────────────
  // ON CONFLICT DO NOTHING against the NEW normalised index, so re-running is a
  // no-op and a tenant that already typed 'facilities' keeps their row.
  for (const name of DEPARTMENTS) {
    await knex.raw(
      `INSERT INTO master_departments (name, is_active) VALUES ($1, true)
       ON CONFLICT (LOWER(BTRIM(name))) WHERE is_active DO NOTHING`, [name]);
  }
  for (const name of DESIGNATIONS) {
    await knex.raw(
      `INSERT INTO master_designations (name, is_active) VALUES ($1, true)
       ON CONFLICT (LOWER(BTRIM(name))) WHERE is_active DO NOTHING`, [name]);
  }
}

export async function down(knex) {
  for (const t of SHARED) {
    await knex.raw(`DROP INDEX IF EXISTS ux_${t}_name_norm`);
  }
  for (const t of SCOPED) {
    await knex.raw(`DROP INDEX IF EXISTS ux_${t}_company_name_norm`);
  }
  // The audit columns and the seeded vocabulary are deliberately NOT dropped.
  // Dropping a column discards data irreversibly (and cascade-drops any index
  // on it), and a seeded department may by then have employees filed under it —
  // a rollback of a governance migration is not a reason to lose either.
}

export const SEEDED = { DEPARTMENTS, DESIGNATIONS };
