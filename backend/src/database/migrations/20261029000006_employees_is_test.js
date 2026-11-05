/**
 * 20261029000006 — employees.is_test: an explicit, approved test-record flag.
 * See MODULE_FEATURE_CONNECTION_MANUAL.md §209 (Phase 2).
 *
 * The employees table had no authoritative way to tell a test record from a
 * real person: status, names and scores are not evidence, and the seed manifest
 * created no employees. The flag is set only for employees the user names
 * explicitly (2026-10-29: EMP005 and EMP006 in Manifest), by a guarded data
 * step — never here, because ids differ between databases.
 *
 * Effect is deliberately narrow: Succession reads (grids, counts, reports,
 * exports) leave flagged employees out and Succession writes refuse to add them.
 * Every other module ignores the column. It is not in the employee update
 * allowlists, so it cannot be set through the employee API.
 *
 * Same shape as payroll_runs.is_test (20261020000001). ADD COLUMN with a
 * constant default is metadata-only: no row is rewritten.
 * Rollback: down() drops the column only while no employee is flagged, and
 * refuses otherwise rather than silently un-flag anyone.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false`);
}

export async function down(knex) {
  const { rows: [r] } = await knex.raw(`SELECT COUNT(*)::int AS n FROM employees WHERE is_test`);
  if (r.n > 0) throw new Error(`${r.n} employee(s) are flagged is_test; clear them deliberately before dropping the column.`);
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS is_test`);
}
