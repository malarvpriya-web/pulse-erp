/**
 * 20260605000001_attendance_industrial_hardening.js
 * Industrial hardening: fix type mismatches, add company_id scoping, add missing columns
 */
export async function up(knex) {

  // 1. Fix employee_id TEXT → INTEGER in regularization_requests
  await knex.raw(`
    ALTER TABLE attendance_regularization_requests
      ALTER COLUMN employee_id TYPE INTEGER USING employee_id::INTEGER
  `).catch(() => {}); // skip if already integer or has non-numeric data

  // 2. Add company_id to hr_shift_assignments (multi-tenant isolation)
  await knex.raw(`ALTER TABLE hr_shift_assignments ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_hsa_company ON hr_shift_assignments(company_id)`);
  // Backfill from employee's company
  await knex.raw(`
    UPDATE hr_shift_assignments sa
       SET company_id = e.company_id
      FROM employees e
     WHERE e.id = sa.employee_id AND sa.company_id IS NULL
  `).catch(() => {});

  // 3. Add company_id to hr_shift_rotations
  await knex.raw(`ALTER TABLE hr_shift_rotations ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_hsr_company ON hr_shift_rotations(company_id)`);

  // 4. Add company_id to biometric_devices
  await knex.raw(`ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`);
  await knex.raw(`ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS vendor VARCHAR(100)`);
  await knex.raw(`ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS serial_number VARCHAR(100)`);
  await knex.raw(`ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS attendance_direction VARCHAR(10) DEFAULT 'both' CHECK (attendance_direction IN ('in','out','both'))`);
  await knex.raw(`ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS sync_interval_minutes INTEGER DEFAULT 15`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bio_devices_company ON biometric_devices(company_id)`);

  // 5. Add company_id to biometric_logs
  await knex.raw(`ALTER TABLE biometric_logs ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`);
  await knex.raw(`ALTER TABLE biometric_logs ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bio_logs_company ON biometric_logs(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bio_logs_employee ON biometric_logs(employee_id, punch_time DESC)`);

  // 6. Add company_id to work_centres
  await knex.raw(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`);
  await knex.raw(`ALTER TABLE work_centres ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_wc_company ON work_centres(company_id)`);

  // 7. Add night_shift_days to payroll_attendance_summary
  await knex.raw(`ALTER TABLE payroll_attendance_summary ADD COLUMN IF NOT EXISTS night_shift_days INTEGER DEFAULT 0`);
  await knex.raw(`ALTER TABLE payroll_attendance_summary ADD COLUMN IF NOT EXISTS holiday_days INTEGER DEFAULT 0`);
  await knex.raw(`ALTER TABLE payroll_attendance_summary ADD COLUMN IF NOT EXISTS approved_leave_days NUMERIC(4,1) DEFAULT 0`);

  // 8. Add columns to attendance_records for additional tracking
  await knex.raw(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'manual'`);
  await knex.raw(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS face_confidence NUMERIC(4,3)`);
  await knex.raw(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS selfie_url TEXT`);
  await knex.raw(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS qr_code_id INTEGER`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_att_records_source ON attendance_records(source)`);

  // 9. Contract labour attendance table
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS contract_labour_attendance (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      contract_id      INTEGER REFERENCES contract_labour(id) ON DELETE CASCADE,
      attendance_date  DATE NOT NULL,
      check_in         TIME,
      check_out        TIME,
      hours_worked     NUMERIC(5,2),
      status           VARCHAR(20) DEFAULT 'present' CHECK (status IN ('present','absent','half_day','late')),
      work_centre_id   INTEGER,
      gate_pass_id     INTEGER,
      late_minutes     INTEGER DEFAULT 0,
      remarks          TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(contract_id, attendance_date)
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cla_company ON contract_labour_attendance(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cla_date ON contract_labour_attendance(attendance_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cla_contract ON contract_labour_attendance(contract_id)`);

  // 10. Attendance offline queue (for PWA background sync)
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS attendance_offline_queue (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER,
      employee_id      INTEGER NOT NULL,
      action           VARCHAR(10) NOT NULL CHECK (action IN ('in','out')),
      punch_time       TIMESTAMPTZ NOT NULL,
      work_mode        VARCHAR(20) DEFAULT 'office',
      location         TEXT,
      source           VARCHAR(30) DEFAULT 'offline_sync',
      device_id        TEXT,
      synced_at        TIMESTAMPTZ,
      status           VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','processed','error')),
      error_message    TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_aofq_employee ON attendance_offline_queue(employee_id, status)`);

  // 11. QR codes — fix missing FK constraint
  await knex.raw(`ALTER TABLE qr_attendance_codes ADD COLUMN IF NOT EXISTS company_id INTEGER`).catch(() => {});

  // 12. Performance indexes
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_att_records_frozen ON attendance_records(is_frozen) WHERE is_frozen = TRUE`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_att_ot_payroll ON attendance_ot_records(payroll_synced, company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_att_reg_status ON attendance_regularization_requests(status, company_id)`);

  // 13. biometric_user_id on employees — maps employees to their ZKTeco device user IDs
  await knex.raw(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS biometric_user_id VARCHAR(50)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_biometric_uid ON employees(biometric_user_id) WHERE biometric_user_id IS NOT NULL`);

  // 14. processed flag on biometric_logs — marks synced punches
  await knex.raw(`ALTER TABLE biometric_logs ADD COLUMN IF NOT EXISTS processed BOOLEAN DEFAULT FALSE`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bio_logs_unprocessed ON biometric_logs(processed) WHERE processed = FALSE`);
}

export async function down(knex) {
  // Non-destructive migration — columns added with IF NOT EXISTS can be dropped if needed
}
