/**
 * Phase 46 Fix — QR Attendance tables
 *
 * qr_attendance_codes: one QR code per shift/site/date — scannable by employees.
 * qr_attendance_scans: each scan record (employee scans to mark attendance).
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS qr_attendance_codes (
      id           SERIAL PRIMARY KEY,
      code_token   VARCHAR(64) UNIQUE NOT NULL,
      location     VARCHAR(255),
      shift_id     INTEGER,
      valid_from   TIMESTAMPTZ NOT NULL,
      valid_until  TIMESTAMPTZ NOT NULL,
      scan_type    VARCHAR(20) NOT NULL DEFAULT 'in' CHECK (scan_type IN ('in','out','both')),
      is_active    BOOLEAN DEFAULT TRUE,
      created_by   INTEGER,
      company_id   INTEGER,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS qr_attendance_scans (
      id             SERIAL PRIMARY KEY,
      qr_code_id     INTEGER NOT NULL REFERENCES qr_attendance_codes(id),
      employee_id    INTEGER NOT NULL,
      scan_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      scan_type      VARCHAR(10) NOT NULL DEFAULT 'in' CHECK (scan_type IN ('in','out')),
      latitude       NUMERIC(9,6),
      longitude      NUMERIC(9,6),
      device_info    TEXT,
      status         VARCHAR(20) DEFAULT 'valid' CHECK (status IN ('valid','expired','duplicate','out_of_range')),
      company_id     INTEGER,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_qr_scans_emp  ON qr_attendance_scans(employee_id, scan_time DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_qr_scans_code ON qr_attendance_scans(qr_code_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_qr_codes_cid  ON qr_attendance_codes(company_id, valid_until DESC)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS qr_attendance_scans CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS qr_attendance_codes CASCADE`);
}
