/**
 * payroll_runs.night_shift_days — the column the attendance sync writes.
 *
 * The month-end attendance sync counts night shifts and posts them to
 * `payroll_runs` so the night-shift allowance can be paid. The column has never
 * existed and the UPDATE is `.catch(() => {})`, so the count was computed and
 * then silently thrown away every run — night-shift allowance has never reached
 * payroll from this path.
 *
 * `payroll_attendance_summary` already carries a `night_shift_days`, but that is
 * the attendance-side summary; this is the payroll-side figure the payslip
 * calculation reads. Adding it rather than repointing keeps the two sides
 * independent, which is how every other attendance→payroll figure here works.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS night_shift_days integer NOT NULL DEFAULT 0;`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS night_shift_days;`);
}
