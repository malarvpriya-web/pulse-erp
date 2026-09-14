/**
 * 20260904000005_audit_module_vocabulary.js
 *
 * One spelling per module in audit_logs.
 *
 * WHY
 * ---
 * `module_name` is the column every audit query groups by, and it had drifted
 * into several spellings of the same module plus a handful of rows that are not
 * module names at all:
 *
 *   CRM (136) / crm            Finance (2) / finance
 *   Announcements (18)         Commissioning (4)
 *   3 (6), 5, 6, 8, 9, 10, 12  — twelve rows whose module_name is a NUMBER
 *
 * The numeric ones came from a caller passing arguments positionally into
 * `logAudit`'s options-object signature, so an id landed in the module slot.
 * They date from 2026-07-04 to 07-07 and no current caller produces them;
 * AuditService now lowercases the name and warns loudly on a non-string, so the
 * shape cannot recur silently.
 *
 * `GROUP BY module_name` over mixed casing double-counts every affected module,
 * which is why an audit report could show CRM twice with different totals.
 *
 * The numeric rows are relabelled `unknown` rather than deleted: an audit log is
 * append-only evidence, and a row whose module cannot be determined is still a
 * record that something happened. Losing it to tidy a column would be the wrong
 * trade.
 */

export async function up(knex) {
  const { rows: before } = await knex.raw(
    `SELECT COUNT(DISTINCT module_name)::int AS distinct_names,
            COUNT(*) FILTER (WHERE module_name ~ '^[0-9]+$')::int AS numeric_rows,
            COUNT(*) FILTER (WHERE module_name <> LOWER(module_name))::int AS mixed_case_rows
       FROM audit_logs`
  );

  // Numeric module names carry no module information at all.
  await knex.raw(`
    UPDATE audit_logs SET module_name = 'unknown'
     WHERE module_name ~ '^[0-9]+$'
  `);

  // Everything else folds to lowercase, which is what AuditService now writes.
  await knex.raw(`
    UPDATE audit_logs SET module_name = LOWER(TRIM(module_name))
     WHERE module_name IS NOT NULL
       AND module_name <> LOWER(TRIM(module_name))
  `);

  await knex.raw(`
    UPDATE audit_logs SET module_name = 'unknown'
     WHERE module_name IS NULL OR TRIM(module_name) = ''
  `);

  const { rows: after } = await knex.raw(
    `SELECT COUNT(DISTINCT module_name)::int AS distinct_names FROM audit_logs`
  );

  console.log(
    `[audit_module_vocabulary] distinct module names ${before[0].distinct_names} -> ${after[0].distinct_names} ` +
    `(normalised ${before[0].mixed_case_rows} mixed-case, relabelled ${before[0].numeric_rows} numeric)`
  );

  // Reporting groups by this column; every audit screen filters on it.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_module_created
      ON audit_logs (module_name, created_at DESC)
  `);
}

export async function down(knex) {
  // Deliberately not reversible. The original casing carried no information —
  // `CRM` and `crm` were the same module written by two call sites — and the
  // numeric names were a bug. Restoring them would only reintroduce the
  // double-counting this migration exists to remove.
  await knex.raw(`DROP INDEX IF EXISTS idx_audit_logs_module_created`);
}
