/**
 * 20261119000001 — Attendance rules, reminders and the settings save fix
 * (§278.3, owner 2026-11-19).
 *
 * 1. attendance_policies.policy_type CHECK allowed only late / overtime / break
 *    / shift / field / factory, but Attendance Settings saves the field-staff
 *    clock-in window as policy_type 'clock_window' — so saving Settings failed
 *    with "violates check constraint attendance_policies_policy_type_check".
 *    'clock_window' and 'penalty' (late-coming penalty rules) are allowed now.
 * 2. Late-coming penalty rules (owner's list, editable in Settings → Late-coming
 *    penalties): every 3 late arrivals of more than 15 min in a month → half a
 *    day; late by more than 60 min → that day counts as a half day; leaving
 *    30 min early 3 times → half a day. Applied at Payroll Sync as extra LOP.
 * 3. payroll_attendance_summary.penalty_lop_days / penalty_detail — the penalty
 *    part of lop_days and which rule caused it, so payroll and the employee can
 *    see why.
 * 4. Regularization: an employee asks on the same day (regularization_window_days
 *    = 0), the reporting manager approves, then HR (regularization_needs_hr = true).
 * 5. Reminders: punch-in reminder N minutes before shift start, punch-out
 *    reminder at shift end, monthly team summary to managers — all switchable.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const PENALTY_RULES = [
  { id: 'r1', kind: 'late_count', count: 3, minutes: 15, deduct_days: 0.5, active: true },
  { id: 'r2', kind: 'late_each', count: 1, minutes: 60, deduct_days: 0.5, active: true },
  { id: 'r3', kind: 'early_count', count: 3, minutes: 30, deduct_days: 0.5, active: true },
];

export async function up(knex) {
  await knex.raw(`ALTER TABLE attendance_policies DROP CONSTRAINT IF EXISTS attendance_policies_policy_type_check`);
  await knex.raw(`
    ALTER TABLE attendance_policies ADD CONSTRAINT attendance_policies_policy_type_check
      CHECK (policy_type IN ('late', 'overtime', 'break', 'shift', 'field', 'factory', 'clock_window', 'penalty'))`);

  await knex.raw(`
    ALTER TABLE attendance_general_settings
      ADD COLUMN IF NOT EXISTS regularization_window_days INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS punch_reminder_enabled BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS punch_reminder_minutes INTEGER NOT NULL DEFAULT 15,
      ADD COLUMN IF NOT EXISTS punch_out_reminder_enabled BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS team_summary_enabled BOOLEAN NOT NULL DEFAULT true`);
  // Owner: manager approves, then HR.
  await knex.raw(`UPDATE attendance_general_settings SET regularization_needs_hr = true`);

  await knex.raw(`
    ALTER TABLE payroll_attendance_summary
      ADD COLUMN IF NOT EXISTS penalty_lop_days NUMERIC(5,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS penalty_detail JSONB`);

  // 6. Punctuality in performance: the attendance score and its figures are
  //    saved with the manager's review (shared/attendancePunctuality.js).
  await knex.raw(`
    ALTER TABLE performance_reviews
      ADD COLUMN IF NOT EXISTS attendance_score NUMERIC(3,1),
      ADD COLUMN IF NOT EXISTS attendance_summary JSONB`);

  // One reminder per employee per day per kind.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS attendance_reminders_sent (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      reminder_date DATE NOT NULL,
      kind VARCHAR(30) NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, reminder_date, kind)
    )`);

  // Seed the owner's rules for every company that has attendance settings.
  await knex.raw(`
    INSERT INTO attendance_policies (company_id, policy_type, name, rules, is_active)
    SELECT s.company_id, 'penalty', 'Late-coming penalties', $1::jsonb, true
      FROM attendance_general_settings s
     WHERE s.company_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM attendance_policies p
                        WHERE p.company_id = s.company_id AND p.policy_type = 'penalty')`,
  [JSON.stringify({ rules: PENALTY_RULES })]);
}

export async function down(knex) {
  await knex.raw(`DELETE FROM attendance_policies WHERE policy_type IN ('penalty', 'clock_window')`);
  await knex.raw(`ALTER TABLE attendance_policies DROP CONSTRAINT IF EXISTS attendance_policies_policy_type_check`);
  await knex.raw(`
    ALTER TABLE attendance_policies ADD CONSTRAINT attendance_policies_policy_type_check
      CHECK (policy_type IN ('late', 'overtime', 'break', 'shift', 'field', 'factory'))`);
  await knex.raw(`DROP TABLE IF EXISTS attendance_reminders_sent`);
  await knex.raw(`ALTER TABLE performance_reviews DROP COLUMN IF EXISTS attendance_score, DROP COLUMN IF EXISTS attendance_summary`);
  await knex.raw(`
    ALTER TABLE payroll_attendance_summary
      DROP COLUMN IF EXISTS penalty_lop_days, DROP COLUMN IF EXISTS penalty_detail`);
  await knex.raw(`
    ALTER TABLE attendance_general_settings
      DROP COLUMN IF EXISTS regularization_window_days, DROP COLUMN IF EXISTS punch_reminder_enabled,
      DROP COLUMN IF EXISTS punch_reminder_minutes, DROP COLUMN IF EXISTS punch_out_reminder_enabled,
      DROP COLUMN IF EXISTS team_summary_enabled`);
}
