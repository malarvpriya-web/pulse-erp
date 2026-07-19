/**
 * 20260527000002_phase32_enterprise_attendance.js
 *
 * Phase 32 — Enterprise Attendance + Workforce Operations Platform
 *
 * Creates:
 *   attendance_policies           — configurable late/OT/break/shift policy rules per company
 *   attendance_audit_logs         — immutable audit trail for all attendance mutations
 *   attendance_ot_records         — overtime records with approval workflow
 *   attendance_break_records      — intra-day break tracking
 *   attendance_geo_rules          — geofencing rules per company/branch
 *   work_centre_attendance        — manufacturing work-centre level attendance
 *   contract_labour               — contract worker tracking
 *
 * Alters:
 *   attendance_records            — ot_hours, payroll_synced, payroll_month/year
 *   attendance_regularization_requests — 2-level approval chain (manager + HR)
 */

export async function up(knex) {

  // ── 1. Attendance Policies ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS attendance_policies (
      id          SERIAL PRIMARY KEY,
      company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      policy_type VARCHAR(30) NOT NULL CHECK (policy_type IN ('late','overtime','break','shift','field','factory')),
      name        VARCHAR(100) NOT NULL,
      rules       JSONB NOT NULL DEFAULT '{}',
      is_active   BOOLEAN DEFAULT true,
      created_by  INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_att_pol_company ON attendance_policies(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_att_pol_type ON attendance_policies(policy_type)`);

  // Seed default late policy per company (uses company_id = NULL as global default)
  await knex.raw(`
    INSERT INTO attendance_policies (company_id, policy_type, name, rules, is_active)
    VALUES
      (NULL, 'late', 'Default Late Policy',
        '{"grace_minutes":10,"half_late_minutes":30,"late_mark_minutes":60,"auto_deduct":false,"repeated_late_penalty":3,"penalty_type":"half_day"}',
        true),
      (NULL, 'overtime', 'Default OT Policy',
        '{"min_ot_minutes":30,"weekday_multiplier":1.5,"weekend_multiplier":2,"holiday_multiplier":2,"max_ot_hours":4,"requires_approval":true}',
        true),
      (NULL, 'break', 'Default Break Policy',
        '{"lunch_minutes":30,"tea_minutes":15,"max_breaks":2,"track_unauthorized":true}',
        true)
    ON CONFLICT DO NOTHING
  `);

  // ── 2. Attendance Audit Logs (immutable — no UPDATE/DELETE allowed) ──────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS attendance_audit_logs (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      employee_id   INTEGER,
      action        VARCHAR(50) NOT NULL,
      before_data   JSONB,
      after_data    JSONB,
      performed_by  INTEGER,
      ip_address    VARCHAR(45),
      device_info   TEXT,
      reason        TEXT,
      performed_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_aal_company   ON attendance_audit_logs(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_aal_employee  ON attendance_audit_logs(employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_aal_performed ON attendance_audit_logs(performed_at DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_aal_action    ON attendance_audit_logs(action)`);

  // ── 3. Overtime Records ──────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS attendance_ot_records (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      employee_id    INTEGER NOT NULL,
      attendance_date DATE NOT NULL,
      ot_hours       DECIMAL(5,2) NOT NULL DEFAULT 0,
      ot_type        VARCHAR(20) DEFAULT 'weekday'
                       CHECK (ot_type IN ('weekday','weekend','holiday','night')),
      multiplier     DECIMAL(4,2) DEFAULT 1.5,
      reason         TEXT,
      status         VARCHAR(20) DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','auto_approved')),
      approved_by    INTEGER,
      approved_at    TIMESTAMPTZ,
      rejection_remarks TEXT,
      payroll_month  INTEGER,
      payroll_year   INTEGER,
      payroll_synced BOOLEAN DEFAULT false,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_id, attendance_date)
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ot_company    ON attendance_ot_records(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ot_employee   ON attendance_ot_records(employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ot_status     ON attendance_ot_records(status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ot_date       ON attendance_ot_records(attendance_date)`);

  // ── 4. Break Records ────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS attendance_break_records (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      employee_id      INTEGER NOT NULL,
      attendance_date  DATE NOT NULL,
      break_type       VARCHAR(20) DEFAULT 'lunch'
                         CHECK (break_type IN ('lunch','tea','personal','unauthorized')),
      break_start      TIME NOT NULL,
      break_end        TIME,
      duration_minutes INTEGER,
      is_active        BOOLEAN DEFAULT true,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_brk_employee ON attendance_break_records(employee_id, attendance_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_brk_company  ON attendance_break_records(company_id)`);

  // ── 5. Geo-fencing Rules ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS attendance_geo_rules (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      name           VARCHAR(100) NOT NULL,
      location_name  VARCHAR(200),
      lat            DECIMAL(10,7) NOT NULL,
      lng            DECIMAL(10,7) NOT NULL,
      radius_meters  INTEGER DEFAULT 200,
      rule_type      VARCHAR(20) DEFAULT 'office'
                       CHECK (rule_type IN ('office','factory','customer','field')),
      is_mandatory   BOOLEAN DEFAULT false,
      is_active      BOOLEAN DEFAULT true,
      created_by     INTEGER,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_geo_company ON attendance_geo_rules(company_id)`);

  // ── 6. Work-Centre Attendance (Manufacturing) ────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS work_centre_attendance (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      employee_id        INTEGER NOT NULL,
      work_centre_id     INTEGER,
      work_centre_name   VARCHAR(100),
      production_order_id INTEGER,
      shift_id           INTEGER REFERENCES hr_shifts(id) ON DELETE SET NULL,
      attendance_date    DATE NOT NULL,
      check_in           TIME,
      check_out          TIME,
      hours_worked       DECIMAL(5,2),
      units_produced     INTEGER DEFAULT 0,
      remarks            TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_wca_employee ON work_centre_attendance(employee_id, attendance_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_wca_company  ON work_centre_attendance(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_wca_wc       ON work_centre_attendance(work_centre_id)`);

  // ── 7. Contract Labour ───────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS contract_labour (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      contractor_company VARCHAR(200),
      employee_name      VARCHAR(100) NOT NULL,
      employee_code      VARCHAR(50),
      designation        VARCHAR(100),
      shift_id           INTEGER REFERENCES hr_shifts(id) ON DELETE SET NULL,
      contract_start     DATE,
      contract_expiry    DATE,
      safety_certified   BOOLEAN DEFAULT false,
      compliance_ok      BOOLEAN DEFAULT true,
      is_active          BOOLEAN DEFAULT true,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cl_company ON contract_labour(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cl_expiry  ON contract_labour(contract_expiry)`);

  // ── 8. Alter attendance_records — add OT + payroll sync columns ─────────────
  await knex.raw(`
    ALTER TABLE attendance_records
      ADD COLUMN IF NOT EXISTS ot_hours       DECIMAL(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS payroll_synced BOOLEAN      DEFAULT false,
      ADD COLUMN IF NOT EXISTS payroll_month  INTEGER,
      ADD COLUMN IF NOT EXISTS payroll_year   INTEGER,
      ADD COLUMN IF NOT EXISTS is_frozen      BOOLEAN      DEFAULT false,
      ADD COLUMN IF NOT EXISTS approved_by    INTEGER
  `);

  // ── 9. Alter attendance_regularization_requests — 2-level approval chain ─────
  await knex.raw(`
    ALTER TABLE attendance_regularization_requests
      ADD COLUMN IF NOT EXISTS manager_id         INTEGER,
      ADD COLUMN IF NOT EXISTS manager_remarks    TEXT,
      ADD COLUMN IF NOT EXISTS manager_actioned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS hr_id              INTEGER,
      ADD COLUMN IF NOT EXISTS hr_remarks         TEXT,
      ADD COLUMN IF NOT EXISTS hr_actioned_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS proof_url          TEXT,
      ADD COLUMN IF NOT EXISTS approval_level     VARCHAR(20) DEFAULT 'manager'
  `);

  // Update existing pending requests to use correct approval_level
  await knex.raw(`
    UPDATE attendance_regularization_requests
       SET approval_level = 'manager'
     WHERE status = 'pending' AND approval_level IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS contract_labour CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS work_centre_attendance CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS attendance_geo_rules CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS attendance_break_records CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS attendance_ot_records CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS attendance_audit_logs CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS attendance_policies CASCADE`);
  await knex.raw(`
    ALTER TABLE attendance_records
      DROP COLUMN IF EXISTS ot_hours,
      DROP COLUMN IF EXISTS payroll_synced,
      DROP COLUMN IF EXISTS payroll_month,
      DROP COLUMN IF EXISTS payroll_year,
      DROP COLUMN IF EXISTS is_frozen,
      DROP COLUMN IF EXISTS approved_by
  `);
  await knex.raw(`
    ALTER TABLE attendance_regularization_requests
      DROP COLUMN IF EXISTS manager_id,
      DROP COLUMN IF EXISTS manager_remarks,
      DROP COLUMN IF EXISTS manager_actioned_at,
      DROP COLUMN IF EXISTS hr_id,
      DROP COLUMN IF EXISTS hr_remarks,
      DROP COLUMN IF EXISTS hr_actioned_at,
      DROP COLUMN IF EXISTS proof_url,
      DROP COLUMN IF EXISTS approval_level
  `);
}
