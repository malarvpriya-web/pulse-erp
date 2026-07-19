/**
 * 20260605000001_leave_policy_attributes.js
 *
 * Adds enterprise policy attributes to leave_types, a leave_policies table,
 * a compensatory_off table, and a leave_encashments table.
 *
 * Also seeds all missing statutory leave types required for India compliance.
 */

export async function up(knex) {

  // ── 1. Policy attributes on leave_types ─────────────────────────────────────
  await knex.raw(`
    ALTER TABLE leave_types
      ADD COLUMN IF NOT EXISTS carry_forward_allowed      BOOLEAN  NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS max_carry_forward_days     INTEGER           DEFAULT 0,
      ADD COLUMN IF NOT EXISTS carry_forward_expiry_months INTEGER          DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS accrual_type               VARCHAR(20) NOT NULL DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS accrual_days_per_month     NUMERIC(4,2)      DEFAULT 0,
      ADD COLUMN IF NOT EXISTS allow_negative_balance      BOOLEAN  NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS requires_attachment         BOOLEAN  NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS requires_medical_cert_days  INTEGER           DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS min_notice_days             INTEGER  NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS max_consecutive_days        INTEGER           DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS allow_half_day              BOOLEAN  NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS is_encashable               BOOLEAN  NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS max_encash_days_per_year    INTEGER           DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS gender_restriction          VARCHAR(10)       DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS allowed_in_probation        BOOLEAN  NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS is_paid                     BOOLEAN  NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS is_lop_type                 BOOLEAN  NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS is_comp_off_type            BOOLEAN  NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS sandwich_rule               BOOLEAN  NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS include_holidays            BOOLEAN  NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS include_weekends            BOOLEAN  NOT NULL DEFAULT false;

    COMMENT ON COLUMN leave_types.accrual_type IS 'manual | monthly | quarterly | yearly | joining_date';
    COMMENT ON COLUMN leave_types.gender_restriction IS 'M = male only, F = female only, NULL = no restriction';
  `);

  // ── 2. Update existing seed types with correct attributes ───────────────────
  await knex.raw(`
    UPDATE leave_types SET
      carry_forward_allowed = true, max_carry_forward_days = 30,
      accrual_type = 'monthly', accrual_days_per_month = 1.5,
      is_encashable = true, max_encash_days_per_year = 10,
      min_notice_days = 1, max_consecutive_days = 30, is_paid = true
    WHERE LOWER(leave_name) IN ('annual leave','earned leave','privilege leave')
      AND deleted_at IS NULL;

    UPDATE leave_types SET
      requires_attachment = true, requires_medical_cert_days = 3,
      min_notice_days = 0, is_paid = true, allowed_in_probation = true
    WHERE LOWER(leave_name) = 'sick leave' AND deleted_at IS NULL;

    UPDATE leave_types SET
      min_notice_days = 1, max_consecutive_days = 3, is_paid = true
    WHERE LOWER(leave_name) = 'casual leave' AND deleted_at IS NULL;

    UPDATE leave_types SET
      gender_restriction = 'F', min_notice_days = 30,
      is_paid = true, max_consecutive_days = 180,
      allowed_in_probation = false
    WHERE LOWER(leave_name) = 'maternity leave' AND deleted_at IS NULL;

    UPDATE leave_types SET
      gender_restriction = 'M', min_notice_days = 7,
      is_paid = true, max_consecutive_days = 15,
      allowed_in_probation = false
    WHERE LOWER(leave_name) = 'paternity leave' AND deleted_at IS NULL;

    UPDATE leave_types SET
      is_comp_off_type = true, carry_forward_allowed = true,
      carry_forward_expiry_months = 3, max_carry_forward_days = 6,
      min_notice_days = 0, is_paid = true
    WHERE LOWER(leave_name) IN ('compensatory leave','compensatory off','comp off')
      AND deleted_at IS NULL;
  `);

  // ── 3. Seed missing statutory leave types ───────────────────────────────────
  await knex.raw(`
    INSERT INTO leave_types
      (leave_name, leave_code, annual_quota, description,
       carry_forward_allowed, max_carry_forward_days, accrual_type, accrual_days_per_month,
       is_encashable, max_encash_days_per_year, min_notice_days, max_consecutive_days,
       allow_half_day, is_paid, is_lop_type, allowed_in_probation,
       requires_attachment, requires_medical_cert_days)
    VALUES
      ('Earned Leave',        'EL',        12, 'Earned leave — accrued monthly per Factories Act',
       true,  30, 'monthly', 1.0, true, 15, 1, 30, true, true, false, false, false, null),
      ('Privilege Leave',     'PL',        15, 'Privilege leave — for senior employees',
       true,  45, 'monthly', 1.25, true, 15, 1, 30, true, true, false, false, false, null),
      ('Bereavement Leave',   'BVL',        3, 'Leave for death of immediate family member',
       false,  0, 'manual',  0,    false, null, 0, 7,  false, true, false, true, false, null),
      ('Marriage Leave',      'MRG',        3, 'Leave for own marriage — once in service',
       false,  0, 'manual',  0,    false, null, 7, 7,  false, true, false, false, false, null),
      ('Loss of Pay',         'LOP',        0, 'Unpaid leave — balance may go negative',
       false,  0, 'manual',  0,    false, null, 0, null, true, false, true, true, false, null),
      ('On Duty',             'OD',         0, 'Employee on official duty / client site visit',
       false,  0, 'manual',  0,    false, null, 0, null, false, true, false, true, false, null),
      ('Training Leave',      'TRN',        5, 'Approved training or skill development leave',
       false,  0, 'manual',  0,    false, null, 3, 30, false, true, false, true, false, null),
      ('Plant Shutdown',      'SHUTDOWN',   0, 'Forced leave during plant maintenance shutdown',
       false,  0, 'manual',  0,    false, null, 0, 30, false, true, false, true, false, null),
      ('Work From Home',      'WFH',        0, 'Work from home — does not deduct leave balance',
       false,  0, 'manual',  0,    false, null, 0, null, false, true, false, true, false, null),
      ('Optional Holiday',    'OH',         2, 'Optional restricted holiday — employee choice',
       false,  0, 'manual',  0,    false, null, 1, 1,  false, true, false, true, false, null),
      ('Sabbatical',          'SAB',        0, 'Long-term leave of absence for senior employees',
       false,  0, 'manual',  0,    false, null, 30, 365, false, true, false, false, false, null),
      ('Safety Training',     'SAFETY',     2, 'Mandatory safety training leave',
       false,  0, 'manual',  0,    false, null, 1, 5, false, true, false, true, false, null),
      ('Study Leave',         'STUDY',      5, 'Leave for examination or academic purpose',
       false,  0, 'manual',  0,    false, null, 7, 30, false, true, false, false, true, null)
    ON CONFLICT DO NOTHING;
  `);

  // Update LOP type flag
  await knex.raw(`
    UPDATE leave_types SET is_lop_type = true, is_paid = false, allow_negative_balance = true
    WHERE LOWER(leave_name) IN ('loss of pay','unpaid leave','lop') AND deleted_at IS NULL;
  `);

  // ── 4. leave_policies table ─────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS leave_policies (
      id                        SERIAL        PRIMARY KEY,
      company_id                INTEGER       REFERENCES companies(id) ON DELETE CASCADE,
      leave_type_id             INTEGER       REFERENCES leave_types(id) ON DELETE CASCADE,
      policy_name               VARCHAR(100),
      accrual_type              VARCHAR(20)   NOT NULL DEFAULT 'manual',
      accrual_days_per_month    NUMERIC(4,2)  DEFAULT 0,
      accrual_start             VARCHAR(20)   DEFAULT 'joining_date',
      probation_allowed         BOOLEAN       NOT NULL DEFAULT true,
      notice_period_allowed     BOOLEAN       NOT NULL DEFAULT false,
      min_notice_days           INTEGER       NOT NULL DEFAULT 0,
      max_consecutive_days      INTEGER,
      sandwich_rule             BOOLEAN       NOT NULL DEFAULT false,
      include_weekends          BOOLEAN       NOT NULL DEFAULT false,
      include_holidays          BOOLEAN       NOT NULL DEFAULT false,
      carry_forward_allowed     BOOLEAN       NOT NULL DEFAULT false,
      max_carry_forward_days    INTEGER       DEFAULT 0,
      carry_forward_expiry_months INTEGER,
      allow_negative_balance    BOOLEAN       NOT NULL DEFAULT false,
      requires_attachment       BOOLEAN       NOT NULL DEFAULT false,
      requires_medical_cert_days INTEGER,
      gender_restriction        VARCHAR(10),
      department_restriction    TEXT[],
      is_active                 BOOLEAN       NOT NULL DEFAULT true,
      created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, leave_type_id)
    );
    CREATE INDEX IF NOT EXISTS idx_leave_policies_company ON leave_policies(company_id);
  `);

  // ── 5. compensatory_off table ────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS compensatory_off (
      id              SERIAL        PRIMARY KEY,
      employee_id     INTEGER       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      work_date       DATE          NOT NULL,
      hours_worked    NUMERIC(4,2)  DEFAULT 8,
      holiday_id      INTEGER       REFERENCES holidays(id),
      reason          TEXT,
      status          VARCHAR(20)   NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending','approved','rejected','used')),
      approved_by     INTEGER       REFERENCES employees(id),
      approved_at     TIMESTAMPTZ,
      comments        TEXT,
      expires_on      DATE,
      credited        BOOLEAN       NOT NULL DEFAULT false,
      company_id      INTEGER       REFERENCES companies(id),
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_comp_off_employee    ON compensatory_off(employee_id);
    CREATE INDEX IF NOT EXISTS idx_comp_off_status      ON compensatory_off(status);
    CREATE INDEX IF NOT EXISTS idx_comp_off_company     ON compensatory_off(company_id);
    CREATE INDEX IF NOT EXISTS idx_comp_off_expires     ON compensatory_off(expires_on);
  `);

  // ── 6. leave_encashments table ───────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS leave_encashments (
      id                SERIAL        PRIMARY KEY,
      employee_id       INTEGER       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      leave_type_id     INTEGER       NOT NULL REFERENCES leave_types(id),
      year              INTEGER       NOT NULL,
      days_encashed     NUMERIC(6,2)  NOT NULL,
      rate_per_day      NUMERIC(12,2) NOT NULL DEFAULT 0,
      gross_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
      tds_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
      net_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
      encashment_month  INTEGER,
      encashment_year   INTEGER,
      payroll_run_id    INTEGER,
      status            VARCHAR(20)   NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending','approved','paid','cancelled')),
      approved_by       INTEGER       REFERENCES employees(id),
      approved_at       TIMESTAMPTZ,
      reason            TEXT,
      company_id        INTEGER       REFERENCES companies(id),
      created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_encashment_employee ON leave_encashments(employee_id);
    CREATE INDEX IF NOT EXISTS idx_encashment_company  ON leave_encashments(company_id);
    CREATE INDEX IF NOT EXISTS idx_encashment_status   ON leave_encashments(status);
  `);

  // ── 7. Add encashed_days to leave_balances ───────────────────────────────────
  await knex.raw(`
    ALTER TABLE leave_balances
      ADD COLUMN IF NOT EXISTS encashed_days      NUMERIC(6,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS carried_forward_days NUMERIC(6,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS opening_balance    NUMERIC(6,2) DEFAULT 0;
  `);

  // ── 8. Add half_day + is_lop + clubbing_flag columns to leave_applications ──
  await knex.raw(`
    ALTER TABLE leave_applications
      ADD COLUMN IF NOT EXISTS half_day          BOOLEAN   NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS half_day_session  VARCHAR(10) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS is_lop            BOOLEAN   NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS clubbing_flag     BOOLEAN   NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS withdrawal_reason TEXT;
  `);

  // ── 9. Performance indexes ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_leave_applications_status      ON leave_applications(status);
    CREATE INDEX IF NOT EXISTS idx_leave_applications_employee    ON leave_applications(employee_id);
    CREATE INDEX IF NOT EXISTS idx_leave_applications_dates       ON leave_applications(start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_leave_applications_manager     ON leave_applications(manager_id, manager_status);
    CREATE INDEX IF NOT EXISTS idx_leave_balances_year            ON leave_balances(year);
    CREATE INDEX IF NOT EXISTS idx_leave_types_active             ON leave_types(is_active) WHERE deleted_at IS NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS leave_encashments   CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS compensatory_off    CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS leave_policies      CASCADE`);
  await knex.raw(`
    ALTER TABLE leave_applications
      DROP COLUMN IF EXISTS half_day,
      DROP COLUMN IF EXISTS half_day_session,
      DROP COLUMN IF EXISTS is_lop,
      DROP COLUMN IF EXISTS clubbing_flag,
      DROP COLUMN IF EXISTS withdrawal_reason;
  `);
  await knex.raw(`
    ALTER TABLE leave_balances
      DROP COLUMN IF EXISTS encashed_days,
      DROP COLUMN IF EXISTS carried_forward_days,
      DROP COLUMN IF EXISTS opening_balance;
  `);
  await knex.raw(`
    ALTER TABLE leave_types
      DROP COLUMN IF EXISTS carry_forward_allowed,
      DROP COLUMN IF EXISTS max_carry_forward_days,
      DROP COLUMN IF EXISTS carry_forward_expiry_months,
      DROP COLUMN IF EXISTS accrual_type,
      DROP COLUMN IF EXISTS accrual_days_per_month,
      DROP COLUMN IF EXISTS allow_negative_balance,
      DROP COLUMN IF EXISTS requires_attachment,
      DROP COLUMN IF EXISTS requires_medical_cert_days,
      DROP COLUMN IF EXISTS min_notice_days,
      DROP COLUMN IF EXISTS max_consecutive_days,
      DROP COLUMN IF EXISTS allow_half_day,
      DROP COLUMN IF EXISTS is_encashable,
      DROP COLUMN IF EXISTS max_encash_days_per_year,
      DROP COLUMN IF EXISTS gender_restriction,
      DROP COLUMN IF EXISTS allowed_in_probation,
      DROP COLUMN IF EXISTS is_paid,
      DROP COLUMN IF EXISTS is_lop_type,
      DROP COLUMN IF EXISTS is_comp_off_type,
      DROP COLUMN IF EXISTS sandwich_rule,
      DROP COLUMN IF EXISTS include_holidays,
      DROP COLUMN IF EXISTS include_weekends;
  `);
}
