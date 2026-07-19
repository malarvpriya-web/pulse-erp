/**
 * 20260521000001_attendance_scoping.js
 *
 * Fixes three schema issues in the Attendance module:
 *
 * 1. Extracts attendance_regularization_requests DDL from the route handler
 *    (was an inline CREATE TABLE IF NOT EXISTS inside POST /attendance/regularize).
 *
 * 2. Adds company_id to attendance_records for multi-tenant scoping and
 *    back-fills it from the parent employees row.
 *
 * 3. Adds work_mode and check_in_location to attendance_records so the clock-in
 *    route no longer needs a try/catch column-existence fallback.
 */

export async function up(knex) {

  // ── 1. Regularization requests table ────────────────────────────────────────
  // The route handler previously ran CREATE TABLE IF NOT EXISTS on every POST
  // request. Idempotent here so existing deployments (table already created by
  // the inline DDL) are unaffected.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS attendance_regularization_requests (
      id          SERIAL      PRIMARY KEY,
      employee_id TEXT        NOT NULL,
      date        DATE        NOT NULL,
      check_in    TIME,
      check_out   TIME,
      reason      TEXT        NOT NULL,
      status      VARCHAR(20) DEFAULT 'pending',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add company_id whether the table was just created or already existed.
  await knex.raw(`
    ALTER TABLE attendance_regularization_requests
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_att_reg_employee
      ON attendance_regularization_requests(employee_id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_att_reg_company
      ON attendance_regularization_requests(company_id)
  `);

  // ── 2. attendance_records — new scope + clock-in columns ────────────────────
  await knex.raw(`
    ALTER TABLE attendance_records
      ADD COLUMN IF NOT EXISTS company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS work_mode         VARCHAR(20) DEFAULT 'office',
      ADD COLUMN IF NOT EXISTS check_in_location TEXT
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_att_records_company
      ON attendance_records(company_id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_att_records_date
      ON attendance_records(attendance_date)
  `);

  // ── 3. Back-fill company_id for all existing attendance records ──────────────
  // Uses the employee FK to inherit the company — safe to run repeatedly (IS NULL guard).
  await knex.raw(`
    UPDATE attendance_records ar
       SET company_id = e.company_id
      FROM employees e
     WHERE ar.employee_id = e.id
       AND ar.company_id  IS NULL
       AND e.company_id   IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS attendance_regularization_requests CASCADE`);
  await knex.raw(`
    ALTER TABLE attendance_records
      DROP COLUMN IF EXISTS company_id,
      DROP COLUMN IF EXISTS work_mode,
      DROP COLUMN IF EXISTS check_in_location
  `);
}
