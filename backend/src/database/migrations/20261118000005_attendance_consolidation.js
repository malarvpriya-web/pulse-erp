/**
 * 20261118000005 — Attendance consolidation (§278, owner 2026-11-18).
 *
 * 1. attendance_general_settings: ONE row per company plus at most ONE global
 *    row. The unique index on company_id treats NULLs as distinct, so every
 *    save from a global-scope login inserted another global row; two
 *    contradicting global rows existed (Mon–Fri vs Mon–Sat). The extra global
 *    row is removed and a partial unique index stops it recurring.
 *    The company row the settings screen created today carried the column
 *    default break of 60 min (the screen never saved the break), which made a
 *    full day 8.5 h + 60 min = 9.5 h on site against the owner's recorded
 *    policy of 8 h work + 30 min lunch (§198). Set back to 8 h + 30 min.
 * 2. working_days and weekend_days are kept in step: weekend = the days that
 *    are not working days.
 * 3. New switches: ot_enabled / comp_off_enabled (OFF — "keep an option, we
 *    are not using it now"), regularization_monthly_limit (3),
 *    regularization_needs_hr (false = the reporting manager decides).
 * 4. shift_change_requests.change_type: 'day' (date override) or 'permanent'.
 * 5. Dead tables dropped: `attendance` (the pre-2026 table — only the
 *    personal-data export read it) and the QR punch tables (QR Attendance
 *    removed by the owner). Rows were backed up to
 *    _backups/attendance_2026-11-18/ before this ran.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE attendance_general_settings
      ADD COLUMN IF NOT EXISTS ot_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS comp_off_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS regularization_monthly_limit INTEGER NOT NULL DEFAULT 3,
      ADD COLUMN IF NOT EXISTS regularization_needs_hr BOOLEAN NOT NULL DEFAULT false`);

  // Keep the oldest global row; remove the other global rows.
  await knex.raw(`
    DELETE FROM attendance_general_settings g
     WHERE g.company_id IS NULL
       AND g.id <> (SELECT MIN(id) FROM attendance_general_settings WHERE company_id IS NULL)`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_general_settings_one_global
      ON attendance_general_settings ((company_id IS NULL)) WHERE company_id IS NULL`);

  // Company 1 (Manifest): the owner's policy, 8 h work + 30 min lunch.
  await knex.raw(`
    UPDATE attendance_general_settings
       SET full_day_hours = 8.0, break_duration = 30, updated_at = NOW()
     WHERE company_id = 1 AND full_day_hours = 8.5 AND break_duration = 60`);

  // weekend_days = the complement of working_days, on every row.
  await knex.raw(`
    UPDATE attendance_general_settings s
       SET weekend_days = COALESCE((
             SELECT jsonb_agg(d ORDER BY array_position($1::text[], d))
               FROM unnest($1::text[]) d
              WHERE NOT (s.working_days @> to_jsonb(d))
           ), '[]'::jsonb)
     WHERE jsonb_typeof(s.working_days) = 'array' AND jsonb_array_length(s.working_days) > 0`, [DAYS]);

  // Shift change: one day (a date override) or from that date on (the
  // employee's shift assignment). Approval used to replace the assignment
  // for every request, so a one-day swap changed the shift for good.
  await knex.raw(`
    ALTER TABLE shift_change_requests
      ADD COLUMN IF NOT EXISTS change_type VARCHAR(10) NOT NULL DEFAULT 'day'`);
  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE shift_change_requests ADD CONSTRAINT shift_change_requests_change_type_chk
        CHECK (change_type IN ('day', 'permanent'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  await knex.raw(`DROP TABLE IF EXISTS qr_attendance_scans`);
  await knex.raw(`DROP TABLE IF EXISTS qr_attendance_codes`);
  await knex.raw(`DROP TABLE IF EXISTS attendance`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS attendance_general_settings_one_global`);
  await knex.raw(`
    ALTER TABLE attendance_general_settings
      DROP COLUMN IF EXISTS ot_enabled,
      DROP COLUMN IF EXISTS comp_off_enabled,
      DROP COLUMN IF EXISTS regularization_monthly_limit,
      DROP COLUMN IF EXISTS regularization_needs_hr`);
  await knex.raw(`ALTER TABLE shift_change_requests DROP COLUMN IF EXISTS change_type`);
  // The dropped tables are not recreated: their rows are in
  // _backups/attendance_2026-11-18/ (attendance.json, qr_attendance_*.json).
}
