/**
 * 20260505000001_extract_inline_ddl.js
 *
 * Consolidates all CREATE TABLE / ALTER TABLE statements that were previously
 * scattered across 30+ route and service files into a single, tracked migration.
 *
 * After this migration runs, the initTables() / INIT() calls in route files
 * become no-ops (CREATE TABLE IF NOT EXISTS) and can be removed safely.
 *
 * Domains covered (in FK-dependency order):
 *   Auth/Security · Master · Notifications · HR (all sub-modules) · Payroll ·
 *   Finance · CRM · Sales · Vendor/Procurement · Production/BOM · Engineering ·
 *   Warehouse · Quality · Maintenance · Logistics · Projects · Workflow · Integrations
 */

export async function up(knex) {

  // ── AUTH & SECURITY ─────────────────────────────────────────────────────────

  await knex.raw(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS failed_attempts INTEGER   DEFAULT 0,
      ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMP DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS last_login      TIMESTAMP DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS google_id       VARCHAR(255)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id
      ON users (google_id) WHERE google_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS password_reset_otps (
      id         SERIAL     PRIMARY KEY,
      user_id    INTEGER    REFERENCES users(id) ON DELETE CASCADE,
      otp        VARCHAR(6) NOT NULL,
      expires_at TIMESTAMP  NOT NULL,
      used       BOOLEAN    DEFAULT FALSE,
      created_at TIMESTAMP  DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS security_events (
      id         SERIAL PRIMARY KEY,
      event_type VARCHAR(80),
      severity   VARCHAR(20) DEFAULT 'info',
      user_id    INT,
      ip_address VARCHAR(45),
      user_agent TEXT,
      path       VARCHAR(300),
      detail     JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ip_whitelist (
      id         SERIAL PRIMARY KEY,
      ip_address VARCHAR(45) UNIQUE,
      label      VARCHAR(100),
      added_by   INT,
      active     BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS revoked_tokens (
      id         SERIAL PRIMARY KEY,
      user_id    INT,
      revoked_at TIMESTAMPTZ DEFAULT NOW(),
      revoked_by INT,
      reason     TEXT
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS audit_trail (
      id              SERIAL PRIMARY KEY,
      user_id         INT,
      method          VARCHAR(10),
      path            VARCHAR(300),
      request_body    JSONB,
      response_status INT,
      ip_address      VARCHAR(45),
      user_agent      TEXT,
      duration_ms     INT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── MASTER DATA ─────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS master_departments (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL UNIQUE,
      is_active  BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS master_zones (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL UNIQUE,
      is_active  BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS master_designations (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(255) NOT NULL UNIQUE,
      is_active  BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── NOTIFICATIONS ────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS notifications (
      id                SERIAL PRIMARY KEY,
      user_id           INT,
      title             VARCHAR(300),
      message           TEXT,
      module_name       VARCHAR(100),
      reference_id      INT,
      notification_type VARCHAR(50) DEFAULT 'info',
      is_read           BOOLEAN DEFAULT false,
      read_at           TIMESTAMPTZ,
      deleted_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── HR — CORE ────────────────────────────────────────────────────────────────

  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS exit_date   DATE,
      ADD COLUMN IF NOT EXISTS exit_reason TEXT
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS hr_shifts (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      start_time    TEXT NOT NULL,
      end_time      TEXT NOT NULL,
      grace_minutes INT         DEFAULT 15,
      color         TEXT        DEFAULT '#6366f1',
      departments   JSONB       DEFAULT '[]',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS exit_requests (
      id                SERIAL PRIMARY KEY,
      employee_id       INTEGER REFERENCES employees(id),
      reason            TEXT,
      last_working_date DATE,
      notice_period     INTEGER,
      status            VARCHAR(30)  DEFAULT 'pending',
      remarks           TEXT,
      separation_type   VARCHAR(20)  DEFAULT 'resignation',
      fnf_status        VARCHAR(20)  DEFAULT 'draft',
      net_payable       NUMERIC(14,2),
      interview_done    BOOLEAN      DEFAULT FALSE,
      created_at        TIMESTAMPTZ  DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await knex.raw(`
    ALTER TABLE exit_requests
      ADD COLUMN IF NOT EXISTS separation_type VARCHAR(20) DEFAULT 'resignation',
      ADD COLUMN IF NOT EXISTS fnf_status      VARCHAR(20) DEFAULT 'draft',
      ADD COLUMN IF NOT EXISTS net_payable     NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS interview_done  BOOLEAN DEFAULT FALSE
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS probation_notifications (
      id                 SERIAL PRIMARY KEY,
      employee_id        INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      notified_to        VARCHAR(255),
      notified_role      VARCHAR(100),
      notification_type  VARCHAR(100) DEFAULT 'approval',
      module_name        VARCHAR(100) DEFAULT 'Probation',
      remarks            TEXT,
      decision           VARCHAR(50),
      performance_rating INTEGER,
      comments           TEXT,
      status             VARCHAR(50)  DEFAULT 'pending',
      decided_at         TIMESTAMP,
      created_at         TIMESTAMP    DEFAULT NOW()
    )
  `);
  await knex.raw(`
    ALTER TABLE probation_notifications
      ADD COLUMN IF NOT EXISTS notification_type VARCHAR(100) DEFAULT 'approval',
      ADD COLUMN IF NOT EXISTS module_name       VARCHAR(100) DEFAULT 'Probation',
      ADD COLUMN IF NOT EXISTS remarks           TEXT,
      ADD COLUMN IF NOT EXISTS status            VARCHAR(50)  DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS decided_at        TIMESTAMP
  `);

  // ── HR — SELF-SERVICE ────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS it_declarations (
      id               SERIAL PRIMARY KEY,
      employee_id      INTEGER NOT NULL,
      financial_year   VARCHAR(10) NOT NULL,
      declaration_type VARCHAR(20) NOT NULL,
      amount           NUMERIC(12,2) NOT NULL,
      description      TEXT,
      proof_url        TEXT,
      status           VARCHAR(20) DEFAULT 'submitted',
      reviewed_by      INTEGER,
      reviewed_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_documents (
      id            SERIAL PRIMARY KEY,
      employee_id   INTEGER NOT NULL,
      document_type VARCHAR(100) NOT NULL,
      document_name VARCHAR(300) NOT NULL,
      file_url      TEXT,
      file_size     INTEGER,
      uploaded_at   TIMESTAMPTZ DEFAULT NOW(),
      verified      BOOLEAN DEFAULT false,
      verified_by   INTEGER,
      verified_at   TIMESTAMPTZ
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS reimbursement_claims (
      id              SERIAL PRIMARY KEY,
      employee_id     INTEGER NOT NULL,
      claim_type      VARCHAR(50) NOT NULL,
      amount          NUMERIC(10,2) NOT NULL,
      description     TEXT,
      receipt_url     TEXT,
      claim_date      DATE DEFAULT CURRENT_DATE,
      status          VARCHAR(20) DEFAULT 'draft',
      approved_amount NUMERIC(10,2),
      remarks         TEXT,
      approved_by     INTEGER,
      approved_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── HR — TRAINING & SKILLS ────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS training_programs (
      id                   SERIAL PRIMARY KEY,
      title                VARCHAR(300) NOT NULL,
      description          TEXT,
      category             VARCHAR(100),
      trainer              VARCHAR(200),
      mode                 VARCHAR(20) DEFAULT 'offline',
      duration_hours       NUMERIC(6,2) DEFAULT 8,
      cost_per_participant NUMERIC(10,2) DEFAULT 0,
      max_participants     INTEGER DEFAULT 30,
      scheduled_date       DATE,
      status               VARCHAR(20) DEFAULT 'planned',
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS training_enrollments (
      id              SERIAL PRIMARY KEY,
      program_id      INTEGER REFERENCES training_programs(id) ON DELETE CASCADE,
      employee_id     INTEGER NOT NULL,
      status          VARCHAR(20) DEFAULT 'enrolled',
      completion_date DATE,
      score           NUMERIC(5,2),
      certificate_url TEXT,
      feedback_rating INTEGER CHECK(feedback_rating BETWEEN 1 AND 5),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(program_id, employee_id)
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS skill_matrix (
      id                 SERIAL PRIMARY KEY,
      employee_id        INTEGER NOT NULL,
      skill_name         VARCHAR(200) NOT NULL,
      category           VARCHAR(100),
      proficiency_level  INTEGER DEFAULT 1 CHECK(proficiency_level BETWEEN 1 AND 5),
      certified          BOOLEAN DEFAULT false,
      certification_name VARCHAR(200),
      expiry_date        DATE,
      last_assessed      DATE DEFAULT CURRENT_DATE,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── HR — SUCCESSION ───────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS talent_assessments (
      id                SERIAL PRIMARY KEY,
      employee_id       INTEGER NOT NULL,
      assessed_by       INTEGER,
      assessment_date   DATE DEFAULT CURRENT_DATE,
      performance_score INTEGER DEFAULT 3 CHECK(performance_score BETWEEN 1 AND 5),
      potential_score   INTEGER DEFAULT 3 CHECK(potential_score BETWEEN 1 AND 5),
      flight_risk       VARCHAR(20) DEFAULT 'low',
      readiness         VARCHAR(20) DEFAULT '1-2-years',
      notes             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_id)
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS critical_roles (
      id                    SERIAL PRIMARY KEY,
      role_title            VARCHAR(300) NOT NULL,
      department            VARCHAR(100),
      current_holder_id     INTEGER,
      risk_level            VARCHAR(20) DEFAULT 'medium',
      reason                TEXT,
      succession_candidates JSONB DEFAULT '[]',
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS succession_plans (
      id                    SERIAL PRIMARY KEY,
      critical_role_id      INTEGER REFERENCES critical_roles(id) ON DELETE CASCADE,
      candidate_employee_id INTEGER NOT NULL,
      rank                  INTEGER DEFAULT 1,
      readiness_level       VARCHAR(20) DEFAULT '1-2-years',
      development_actions   JSONB DEFAULT '[]',
      last_reviewed         DATE DEFAULT CURRENT_DATE,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(critical_role_id, candidate_employee_id)
    )
  `);

  // ── HR — BIOMETRIC & ACCESS ───────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS biometric_devices (
      id          SERIAL PRIMARY KEY,
      device_name VARCHAR(200) NOT NULL,
      device_type VARCHAR(100) DEFAULT 'fingerprint',
      location    VARCHAR(200),
      ip_address  VARCHAR(50),
      port        INTEGER DEFAULT 4370,
      status      VARCHAR(20) DEFAULT 'offline',
      last_sync   TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS biometric_logs (
      id          SERIAL PRIMARY KEY,
      employee_id INTEGER,
      device_id   INTEGER REFERENCES biometric_devices(id) ON DELETE SET NULL,
      punch_time  TIMESTAMPTZ NOT NULL,
      punch_type  VARCHAR(10) DEFAULT 'in',
      raw_data    JSONB DEFAULT '{}',
      processed   BOOLEAN DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS gate_passes (
      id           SERIAL PRIMARY KEY,
      employee_id  INTEGER,
      visitor_name VARCHAR(200),
      purpose      TEXT,
      valid_from   TIMESTAMPTZ,
      valid_to     TIMESTAMPTZ,
      approved_by  INTEGER,
      status       VARCHAR(20) DEFAULT 'pending',
      pass_number  VARCHAR(50),
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS visitors (
      id               SERIAL PRIMARY KEY,
      name             VARCHAR(200) NOT NULL,
      company          VARCHAR(200),
      phone            VARCHAR(20),
      email            VARCHAR(200),
      host_employee_id INTEGER,
      check_in_time    TIMESTAMPTZ DEFAULT NOW(),
      check_out_time   TIMESTAMPTZ,
      purpose          TEXT,
      id_type          VARCHAR(50),
      id_number        VARCHAR(100),
      photo_url        TEXT,
      badge_printed    BOOLEAN DEFAULT false,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── HR — EXIT ─────────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS exit_interviews (
      id                SERIAL PRIMARY KEY,
      exit_request_id   INTEGER REFERENCES exit_requests(id) ON DELETE CASCADE,
      employee_id       INTEGER,
      interviewer_id    INTEGER,
      reason_category   VARCHAR(50),
      reason_detail     TEXT,
      would_rejoin      VARCHAR(10),
      rating_management SMALLINT,
      rating_culture    SMALLINT,
      rating_work       SMALLINT,
      rating_growth     SMALLINT,
      overall_rating    SMALLINT,
      status            VARCHAR(20) DEFAULT 'completed',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS exit_clearance (
      id                    SERIAL PRIMARY KEY,
      employee_id           INTEGER UNIQUE,
      it_assets_returned    BOOLEAN DEFAULT FALSE,
      access_revoked        BOOLEAN DEFAULT FALSE,
      documents_collected   BOOLEAN DEFAULT FALSE,
      exit_interview_done   BOOLEAN DEFAULT FALSE,
      noc_it                BOOLEAN DEFAULT FALSE,
      noc_admin             BOOLEAN DEFAULT FALSE,
      noc_finance           BOOLEAN DEFAULT FALSE,
      noc_hr                BOOLEAN DEFAULT FALSE,
      noc_manager           BOOLEAN DEFAULT FALSE,
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── PAYROLL ───────────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS salary_structures (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(200) NOT NULL,
      description TEXT,
      is_default  BOOLEAN DEFAULT false,
      components  JSONB DEFAULT '[]',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_salary_assignments (
      id                SERIAL PRIMARY KEY,
      employee_id       INTEGER NOT NULL,
      structure_id      INTEGER REFERENCES salary_structures(id) ON DELETE SET NULL,
      effective_from    DATE NOT NULL DEFAULT CURRENT_DATE,
      basic_salary      NUMERIC(12,2) NOT NULL DEFAULT 30000,
      special_allowance NUMERIC(12,2) DEFAULT 0,
      other_components  JSONB DEFAULT '{}',
      loan_deduction    NUMERIC(12,2) DEFAULT 0,
      advance_deduction NUMERIC(12,2) DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_loans (
      id                  SERIAL PRIMARY KEY,
      employee_id         INTEGER NOT NULL,
      loan_type           VARCHAR(30) DEFAULT 'loan',
      principal_amount    NUMERIC(12,2) NOT NULL,
      emi_amount          NUMERIC(12,2) NOT NULL,
      outstanding_balance NUMERIC(12,2) NOT NULL,
      start_date          DATE NOT NULL,
      reason              TEXT,
      status              VARCHAR(20) DEFAULT 'active',
      emi_schedule        JSONB DEFAULT '[]',
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_slips (
      id          SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      month       INTEGER NOT NULL,
      year        INTEGER NOT NULL,
      slip_data   JSONB NOT NULL,
      net_pay     NUMERIC(12,2),
      gross       NUMERIC(12,2),
      status      VARCHAR(20) DEFAULT 'generated',
      emailed_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_id, month, year)
    )
  `);

  // ── FINANCE — FIXED ASSETS ────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS fixed_assets (
      id                       SERIAL PRIMARY KEY,
      asset_code               VARCHAR(30) UNIQUE NOT NULL,
      name                     VARCHAR(200) NOT NULL,
      category                 VARCHAR(100),
      location                 VARCHAR(100),
      department               VARCHAR(100),
      purchase_date            DATE,
      purchase_cost            NUMERIC(14,2) NOT NULL,
      salvage_value            NUMERIC(14,2) DEFAULT 0,
      useful_life_years        NUMERIC(6,2),
      depreciation_method      VARCHAR(10) DEFAULT 'SLM',
      wdv_rate                 NUMERIC(6,2),
      current_book_value       NUMERIC(14,2),
      accumulated_depreciation NUMERIC(14,2) DEFAULT 0,
      status                   VARCHAR(20) DEFAULT 'active',
      vendor                   VARCHAR(100),
      invoice_number           VARCHAR(50),
      serial_number            VARCHAR(100),
      warranty_expiry          DATE,
      insurance_expiry         DATE,
      barcode                  VARCHAR(50),
      notes                    TEXT,
      created_at               TIMESTAMPTZ DEFAULT NOW(),
      updated_at               TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS asset_depreciation_log (
      id                  SERIAL PRIMARY KEY,
      asset_id            INTEGER REFERENCES fixed_assets(id) ON DELETE CASCADE,
      financial_year      VARCHAR(10),
      opening_value       NUMERIC(14,2),
      depreciation_amount NUMERIC(14,2),
      closing_value       NUMERIC(14,2),
      method              VARCHAR(10),
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── FINANCE — TDS ─────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS tds_deductees (
      id               SERIAL PRIMARY KEY,
      party_id         INT,
      party_name       VARCHAR(200) NOT NULL,
      pan              VARCHAR(15),
      deductee_type    VARCHAR(20) DEFAULT 'company'
                         CHECK (deductee_type IN ('individual','company','huf','firm')),
      section          VARCHAR(20),
      threshold_limit  NUMERIC(15,2) DEFAULT 30000,
      rate_with_pan    NUMERIC(5,2)  DEFAULT 10,
      rate_without_pan NUMERIC(5,2)  DEFAULT 20,
      is_active        BOOLEAN DEFAULT true,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS tds_transactions (
      id             SERIAL PRIMARY KEY,
      deductee_id    INT REFERENCES tds_deductees(id),
      party_id       INT,
      section        VARCHAR(20),
      payment_date   DATE NOT NULL,
      payment_amount NUMERIC(15,2),
      tds_rate       NUMERIC(5,2),
      tds_amount     NUMERIC(15,2),
      surcharge      NUMERIC(15,2) DEFAULT 0,
      education_cess NUMERIC(15,2) DEFAULT 0,
      total_tds      NUMERIC(15,2),
      challan_number VARCHAR(50),
      challan_date   DATE,
      bsr_code       VARCHAR(20),
      deposited      BOOLEAN DEFAULT false,
      quarter        VARCHAR(5),
      financial_year VARCHAR(10),
      bill_id        INT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS form16a_records (
      id                 SERIAL PRIMARY KEY,
      deductee_id        INT REFERENCES tds_deductees(id),
      financial_year     VARCHAR(10),
      quarter            VARCHAR(5),
      certificate_number VARCHAR(50),
      issued_date        DATE,
      total_payment      NUMERIC(15,2),
      total_tds          NUMERIC(15,2),
      status             VARCHAR(20) DEFAULT 'draft',
      certificate_data   JSONB,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── FINANCE — BUDGET ──────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS budgets (
      id             SERIAL PRIMARY KEY,
      name           VARCHAR(200) NOT NULL,
      financial_year VARCHAR(10) NOT NULL,
      department     VARCHAR(100),
      budget_type    VARCHAR(30) DEFAULT 'annual',
      total_amount   NUMERIC(15,2) NOT NULL,
      status         VARCHAR(20) DEFAULT 'draft',
      approved_by    INT,
      approved_at    TIMESTAMPTZ,
      notes          TEXT,
      created_by     INT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS budget_line_items (
      id            SERIAL PRIMARY KEY,
      budget_id     INT REFERENCES budgets(id) ON DELETE CASCADE,
      category      VARCHAR(100) NOT NULL,
      sub_category  VARCHAR(100),
      account_code  VARCHAR(20),
      description   TEXT,
      q1_amount     NUMERIC(15,2) DEFAULT 0,
      q2_amount     NUMERIC(15,2) DEFAULT 0,
      q3_amount     NUMERIC(15,2) DEFAULT 0,
      q4_amount     NUMERIC(15,2) DEFAULT 0,
      annual_amount NUMERIC(15,2) GENERATED ALWAYS AS
                      (q1_amount + q2_amount + q3_amount + q4_amount) STORED,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS budget_actuals (
      id               SERIAL PRIMARY KEY,
      budget_id        INT REFERENCES budgets(id),
      line_item_id     INT REFERENCES budget_line_items(id),
      department       VARCHAR(100),
      category         VARCHAR(100),
      actual_amount    NUMERIC(15,2),
      transaction_date DATE,
      reference_type   VARCHAR(30),
      reference_id     INT,
      description      TEXT,
      month            INT,
      year             INT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS budget_alerts (
      id            SERIAL PRIMARY KEY,
      budget_id     INT REFERENCES budgets(id),
      line_item_id  INT,
      department    VARCHAR(100),
      alert_type    VARCHAR(50) DEFAULT 'threshold',
      threshold_pct NUMERIC(5,2) DEFAULT 80,
      is_active     BOOLEAN DEFAULT true,
      last_fired_at TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── FINANCE — GST ─────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS gst_invoices (
      id             SERIAL PRIMARY KEY,
      invoice_id     INT REFERENCES invoices(id),
      invoice_number VARCHAR(50),
      invoice_date   DATE,
      party_id       INT,
      party_name     VARCHAR(200),
      party_gstin    VARCHAR(15),
      party_state    VARCHAR(50),
      company_state  VARCHAR(50),
      supply_type    VARCHAR(20) DEFAULT 'B2B',
      taxable_value  NUMERIC(15,2),
      igst           NUMERIC(15,2) DEFAULT 0,
      cgst           NUMERIC(15,2) DEFAULT 0,
      sgst           NUMERIC(15,2) DEFAULT 0,
      cess           NUMERIC(15,2) DEFAULT 0,
      total_gst      NUMERIC(15,2),
      total_amount   NUMERIC(15,2),
      filing_period  VARCHAR(10),
      gstr1_filed    BOOLEAN DEFAULT FALSE,
      gstr3b_filed   BOOLEAN DEFAULT FALSE,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS gst_purchase_invoices (
      id              SERIAL PRIMARY KEY,
      bill_id         INT,
      invoice_number  VARCHAR(50),
      invoice_date    DATE,
      supplier_id     INT,
      supplier_name   VARCHAR(200),
      supplier_gstin  VARCHAR(15),
      supplier_state  VARCHAR(50),
      taxable_value   NUMERIC(15,2),
      igst            NUMERIC(15,2) DEFAULT 0,
      cgst            NUMERIC(15,2) DEFAULT 0,
      sgst            NUMERIC(15,2) DEFAULT 0,
      itc_eligible    BOOLEAN DEFAULT TRUE,
      filing_period   VARCHAR(10),
      gstr2a_matched  BOOLEAN DEFAULT FALSE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sales_order_id INT`);

  // ── CRM ───────────────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS crm_email_accounts (
      id                 SERIAL PRIMARY KEY,
      name               VARCHAR(100),
      email              VARCHAR(255),
      provider           VARCHAR(20) CHECK (provider IN ('gmail','outlook','smtp')),
      smtp_host          VARCHAR(255),
      smtp_port          INT,
      imap_host          VARCHAR(255),
      imap_port          INT,
      username           VARCHAR(255),
      encrypted_password TEXT,
      is_active          BOOLEAN DEFAULT true,
      last_sync          TIMESTAMPTZ
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS crm_emails (
      id         SERIAL PRIMARY KEY,
      account_id INT REFERENCES crm_email_accounts(id),
      lead_id    INT,
      contact_id INT,
      direction  VARCHAR(10) CHECK (direction IN ('inbound','outbound')),
      subject    TEXT,
      body_html  TEXT,
      body_text  TEXT,
      from_email VARCHAR(255),
      to_emails  JSONB,
      cc_emails  JSONB,
      opened_at  TIMESTAMPTZ,
      clicked_at TIMESTAMPTZ,
      status     VARCHAR(20) DEFAULT 'sent',
      sent_at    TIMESTAMPTZ,
      message_id VARCHAR(512)
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(255),
      category      VARCHAR(100),
      stage_trigger VARCHAR(100),
      subject       TEXT,
      body_html     TEXT,
      variables     JSONB,
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS email_sequences (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(255),
      trigger_stage VARCHAR(100),
      is_active     BOOLEAN DEFAULT true,
      steps         JSONB,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS email_sequence_steps (
      id          SERIAL PRIMARY KEY,
      sequence_id INT REFERENCES email_sequences(id) ON DELETE CASCADE,
      delay_days  INT DEFAULT 1,
      subject     VARCHAR(300),
      body        TEXT,
      step_order  INT DEFAULT 1
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sequence_enrollments (
      id           SERIAL PRIMARY KEY,
      sequence_id  INT,
      lead_id      INT,
      enrolled_at  TIMESTAMPTZ DEFAULT NOW(),
      current_step INT DEFAULT 0,
      status       VARCHAR(20) DEFAULT 'active',
      next_send_at TIMESTAMPTZ
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      probability INT DEFAULT 0,
      color       VARCHAR(20) DEFAULT '#94a3b8',
      order_index INT DEFAULT 0,
      lead_count  INT DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS scoring_rules (
      id            SERIAL PRIMARY KEY,
      criteria_name VARCHAR(100),
      criteria_key  VARCHAR(50),
      options       JSONB DEFAULT '[]',
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS assignment_rules (
      id              SERIAL PRIMARY KEY,
      rule_name       VARCHAR(200),
      condition_type  VARCHAR(50),
      condition_value TEXT,
      assigned_to     VARCHAR(200),
      priority        INT DEFAULT 10,
      is_active       BOOLEAN DEFAULT true,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS crm_deals (
      id          SERIAL PRIMARY KEY,
      lead_name   VARCHAR(200),
      stage       VARCHAR(100),
      deal_value  NUMERIC(14,2),
      outcome     VARCHAR(20),
      loss_reason TEXT,
      closed_at   TIMESTAMPTZ,
      cycle_days  INT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS nps_responses (
      id            SERIAL PRIMARY KEY,
      customer_id   INT,
      customer_name VARCHAR(255),
      score         INT CHECK (score >= 0 AND score <= 10),
      comment       TEXT,
      survey_date   DATE DEFAULT CURRENT_DATE,
      category      VARCHAR(20)
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id              SERIAL PRIMARY KEY,
      customer_id     INT,
      subject         TEXT,
      priority        VARCHAR(20) DEFAULT 'medium',
      status          VARCHAR(20) DEFAULT 'open',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      resolved_at     TIMESTAMPTZ,
      resolution_days INT
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS customer_payments (
      id           SERIAL PRIMARY KEY,
      party_id     INT,
      invoice_id   INT,
      amount       NUMERIC(15,2),
      mode         VARCHAR(50),
      reference    VARCHAR(100),
      payment_date DATE DEFAULT CURRENT_DATE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── SALES ─────────────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS credit_limits (
      id                  SERIAL PRIMARY KEY,
      customer_id         INT,
      customer_name       VARCHAR(255),
      credit_limit        NUMERIC(15,2) DEFAULT 0,
      current_outstanding NUMERIC(15,2) DEFAULT 0,
      credit_terms_days   INT DEFAULT 30,
      credit_hold         BOOLEAN DEFAULT false,
      hold_reason         TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS price_lists (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(255),
      currency      VARCHAR(10) DEFAULT 'INR',
      applicable_to VARCHAR(30) DEFAULT 'all',
      customer_ids  JSONB DEFAULT '[]',
      valid_from    DATE,
      valid_to      DATE,
      is_default    BOOLEAN DEFAULT false,
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS price_list_items (
      id             SERIAL PRIMARY KEY,
      price_list_id  INT REFERENCES price_lists(id) ON DELETE CASCADE,
      item_id        VARCHAR(100),
      item_name      VARCHAR(255),
      base_price     NUMERIC(15,2),
      min_price      NUMERIC(15,2),
      original_price NUMERIC(15,2),
      uom            VARCHAR(50) DEFAULT 'Nos'
    )
  `);
  await knex.raw(`ALTER TABLE price_list_items ADD COLUMN IF NOT EXISTS original_price NUMERIC(15,2)`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS discount_rules (
      id                     SERIAL PRIMARY KEY,
      name                   VARCHAR(255),
      type                   VARCHAR(20) DEFAULT 'percentage',
      applies_to             VARCHAR(30) DEFAULT 'all',
      min_order_value        NUMERIC(15,2) DEFAULT 0,
      min_quantity           INT DEFAULT 1,
      discount_value         NUMERIC(10,2),
      tiered_slabs           JSONB DEFAULT '[]',
      valid_from             DATE,
      valid_to               DATE,
      requires_approval      BOOLEAN DEFAULT false,
      approval_threshold_pct NUMERIC(5,2) DEFAULT 10,
      is_active              BOOLEAN DEFAULT true,
      created_at             TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS discount_approvals (
      id                     SERIAL PRIMARY KEY,
      discount_rule_id       INT,
      lead_id                INT,
      order_id               INT,
      order_value            NUMERIC(15,2) DEFAULT 0,
      requested_discount_pct NUMERIC(5,2),
      requested_by           VARCHAR(100),
      approved_by            VARCHAR(100),
      status                 VARCHAR(20) DEFAULT 'pending',
      reason                 TEXT,
      requested_at           TIMESTAMPTZ DEFAULT NOW(),
      approved_at            TIMESTAMPTZ
    )
  `);
  await knex.raw(`ALTER TABLE discount_approvals ADD COLUMN IF NOT EXISTS order_value NUMERIC(15,2) DEFAULT 0`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS promotions (
      id             SERIAL PRIMARY KEY,
      name           VARCHAR(255),
      type           VARCHAR(20),
      conditions     JSONB DEFAULT '{}',
      discount_value NUMERIC(10,2),
      valid_from     DATE,
      valid_to       DATE,
      usage_count    INT DEFAULT 0,
      max_usage      INT DEFAULT 1000,
      is_active      BOOLEAN DEFAULT true,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS price_change_log (
      id            SERIAL PRIMARY KEY,
      price_list_id INT REFERENCES price_lists(id) ON DELETE CASCADE,
      item_id       VARCHAR(100),
      item_name     VARCHAR(255),
      old_price     NUMERIC(15,2),
      new_price     NUMERIC(15,2),
      changed_by    VARCHAR(100),
      changed_at    TIMESTAMPTZ DEFAULT NOW(),
      reason        TEXT
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commission_plans (
      id                   SERIAL PRIMARY KEY,
      name                 VARCHAR(255),
      rep_id               INT,
      rep_name             VARCHAR(255),
      plan_type            VARCHAR(20) DEFAULT 'percentage',
      base_rate_pct        NUMERIC(5,2),
      tiered_slabs         JSONB DEFAULT '[]',
      applies_to           VARCHAR(30) DEFAULT 'all_products',
      product_ids          JSONB DEFAULT '[]',
      effective_from       DATE,
      effective_to         DATE,
      clawback_period_days INT DEFAULT 30,
      is_active            BOOLEAN DEFAULT true,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commission_entries (
      id                SERIAL PRIMARY KEY,
      plan_id           INT REFERENCES commission_plans(id),
      rep_id            INT,
      rep_name          VARCHAR(255),
      order_id          INT,
      invoice_id        INT,
      order_ref         VARCHAR(100),
      customer_name     VARCHAR(255),
      sale_amount       NUMERIC(15,2),
      commission_rate   NUMERIC(5,2),
      commission_amount NUMERIC(15,2),
      status            VARCHAR(20) DEFAULT 'pending',
      earned_date       DATE DEFAULT CURRENT_DATE,
      paid_date         DATE,
      clawback_reason   TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commission_payouts (
      id               SERIAL PRIMARY KEY,
      rep_id           INT,
      rep_name         VARCHAR(255),
      period_from      DATE,
      period_to        DATE,
      total_commission NUMERIC(15,2),
      deductions       NUMERIC(15,2) DEFAULT 0,
      net_payout       NUMERIC(15,2),
      status           VARCHAR(20) DEFAULT 'draft',
      payment_date     DATE,
      remarks          TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── PROCUREMENT / VENDOR ──────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS vendors (
      id              SERIAL PRIMARY KEY,
      vendor_name     VARCHAR(200) NOT NULL,
      category        VARCHAR(100),
      gstin           VARCHAR(20),
      pan             VARCHAR(15),
      bank_name       VARCHAR(100),
      account_number  VARCHAR(30),
      ifsc            VARCHAR(15),
      contact_person  VARCHAR(100),
      email           VARCHAR(150),
      phone           VARCHAR(20),
      city            VARCHAR(100),
      state           VARCHAR(100),
      address         TEXT,
      quality_rating  NUMERIC(3,1) DEFAULT 0,
      delivery_rating NUMERIC(3,1) DEFAULT 0,
      price_rating    NUMERIC(3,1) DEFAULT 0,
      status          VARCHAR(20) DEFAULT 'active',
      total_orders    INT DEFAULT 0,
      on_time_pct     NUMERIC(5,1) DEFAULT 0,
      defect_rate     NUMERIC(5,2) DEFAULT 0,
      last_order      DATE,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rfqs (
      id               SERIAL PRIMARY KEY,
      rfq_number       VARCHAR(50) UNIQUE NOT NULL,
      pr_id            VARCHAR(50),
      item_description TEXT,
      quantity         NUMERIC(10,2),
      unit             VARCHAR(20),
      required_by      DATE,
      vendor_ids       JSONB DEFAULT '[]',
      status           VARCHAR(20) DEFAULT 'draft',
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS price_history (
      id               SERIAL PRIMARY KEY,
      vendor_id        INT REFERENCES vendors(id) ON DELETE CASCADE,
      vendor_name_text VARCHAR(200),
      item_id          INT,
      item_name_text   VARCHAR(300),
      unit_price       NUMERIC(12,2) NOT NULL,
      price_date       DATE NOT NULL DEFAULT CURRENT_DATE,
      source           VARCHAR(50) DEFAULT 'manual',
      notes            TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ph_vendor_date ON price_history(vendor_id, price_date)`);

  // ── PRODUCTION / BOM ──────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bom_headers (
      id           SERIAL PRIMARY KEY,
      product_id   INTEGER,
      product_name VARCHAR(200) NOT NULL,
      version      INTEGER DEFAULT 1,
      status       VARCHAR(20) DEFAULT 'draft',
      notes        TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS work_centres (
      id                     SERIAL PRIMARY KEY,
      name                   VARCHAR(100) NOT NULL,
      capacity_hours_per_day NUMERIC(6,2) DEFAULT 8,
      cost_per_hour          NUMERIC(10,2) DEFAULT 0,
      department             VARCHAR(100),
      status                 VARCHAR(20) DEFAULT 'active',
      created_at             TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS purchase_requests (
      id             SERIAL PRIMARY KEY,
      item_name      VARCHAR(200),
      item_id        INTEGER,
      qty_requested  NUMERIC(12,4),
      unit           VARCHAR(20),
      estimated_cost NUMERIC(12,2),
      status         VARCHAR(20) DEFAULT 'draft',
      priority       VARCHAR(20) DEFAULT 'normal',
      raised_by      VARCHAR(100) DEFAULT 'MRP System',
      notes          TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bom_lines (
      id             SERIAL PRIMARY KEY,
      bom_id         INTEGER REFERENCES bom_headers(id) ON DELETE CASCADE,
      component_id   INTEGER,
      component_name VARCHAR(200) NOT NULL,
      qty            NUMERIC(12,4) NOT NULL DEFAULT 1,
      unit           VARCHAR(20) DEFAULT 'pcs',
      unit_cost      NUMERIC(12,2) DEFAULT 0,
      level          INTEGER DEFAULT 1,
      parent_line_id INTEGER REFERENCES bom_lines(id) ON DELETE CASCADE,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS routing_steps (
      id             SERIAL PRIMARY KEY,
      bom_id         INTEGER REFERENCES bom_headers(id) ON DELETE CASCADE,
      step_no        INTEGER NOT NULL,
      operation      VARCHAR(200),
      work_centre_id INTEGER REFERENCES work_centres(id),
      std_time_hrs   NUMERIC(8,4) DEFAULT 0,
      description    TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── ENGINEERING / R&D ─────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS eng_rd_projects (
      id             SERIAL PRIMARY KEY,
      code           VARCHAR(30) UNIQUE,
      name           VARCHAR(255) NOT NULL,
      description    TEXT,
      category       VARCHAR(80),
      status         VARCHAR(40) NOT NULL DEFAULT 'concept',
      priority       VARCHAR(20) DEFAULT 'medium',
      manager_name   VARCHAR(120),
      team_members   TEXT,
      budget         NUMERIC(14,2),
      spent          NUMERIC(14,2) DEFAULT 0,
      start_date     DATE,
      target_date    DATE,
      completed_date DATE,
      tags           TEXT,
      created_by     INTEGER,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      deleted_at     TIMESTAMPTZ
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS eng_design_phases (
      id             SERIAL PRIMARY KEY,
      project_id     INTEGER NOT NULL REFERENCES eng_rd_projects(id) ON DELETE CASCADE,
      phase_name     VARCHAR(80) NOT NULL,
      phase_order    INTEGER DEFAULT 0,
      status         VARCHAR(40) DEFAULT 'pending',
      description    TEXT,
      deliverables   TEXT,
      start_date     DATE,
      end_date       DATE,
      completed_date DATE,
      assigned_to    VARCHAR(120),
      notes          TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS eng_prototypes (
      id          SERIAL PRIMARY KEY,
      project_id  INTEGER NOT NULL REFERENCES eng_rd_projects(id) ON DELETE CASCADE,
      iteration   INTEGER NOT NULL DEFAULT 1,
      title       VARCHAR(200),
      status      VARCHAR(40) DEFAULT 'building',
      specs       TEXT,
      materials   TEXT,
      build_cost  NUMERIC(14,2),
      build_date  DATE,
      test_date   DATE,
      test_result VARCHAR(20),
      test_notes  TEXT,
      assigned_to VARCHAR(120),
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS eng_test_plans (
      id                  SERIAL PRIMARY KEY,
      project_id          INTEGER NOT NULL REFERENCES eng_rd_projects(id) ON DELETE CASCADE,
      prototype_id        INTEGER REFERENCES eng_prototypes(id) ON DELETE SET NULL,
      title               VARCHAR(255) NOT NULL,
      description         TEXT,
      test_type           VARCHAR(80),
      acceptance_criteria TEXT,
      status              VARCHAR(40) DEFAULT 'draft',
      result              VARCHAR(20),
      executed_by         VARCHAR(120),
      planned_date        DATE,
      executed_date       DATE,
      findings            TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── WAREHOUSE ─────────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      address    TEXT,
      type       VARCHAR(20) DEFAULT 'main',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS warehouse_zones (
      id           SERIAL PRIMARY KEY,
      warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE CASCADE,
      name         VARCHAR(100) NOT NULL,
      zone_type    VARCHAR(20) DEFAULT 'storage',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bin_locations (
      id            SERIAL PRIMARY KEY,
      zone_id       INTEGER REFERENCES warehouse_zones(id) ON DELETE CASCADE,
      bin_code      VARCHAR(30) NOT NULL,
      row_no        VARCHAR(10),
      shelf         VARCHAR(10),
      level         VARCHAR(10),
      max_weight_kg NUMERIC(10,2) DEFAULT 500,
      current_items JSONB DEFAULT '[]',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS pick_lists (
      id              SERIAL PRIMARY KEY,
      sales_order_id  INTEGER,
      sales_order_ref VARCHAR(50),
      status          VARCHAR(20) DEFAULT 'pending',
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS pick_list_lines (
      id              SERIAL PRIMARY KEY,
      pick_list_id    INTEGER REFERENCES pick_lists(id) ON DELETE CASCADE,
      item_id         INTEGER,
      item_name       VARCHAR(200),
      bin_location_id INTEGER REFERENCES bin_locations(id),
      bin_code        VARCHAR(30),
      required_qty    NUMERIC(12,4),
      picked_qty      NUMERIC(12,4) DEFAULT 0,
      status          VARCHAR(20) DEFAULT 'pending'
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS cycle_count_headers (
      id             SERIAL PRIMARY KEY,
      warehouse_id   INTEGER REFERENCES warehouses(id),
      zone_id        INTEGER REFERENCES warehouse_zones(id),
      scheduled_date DATE,
      status         VARCHAR(20) DEFAULT 'scheduled',
      counted_by     VARCHAR(100),
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS cycle_count_lines (
      id              SERIAL PRIMARY KEY,
      header_id       INTEGER REFERENCES cycle_count_headers(id) ON DELETE CASCADE,
      item_id         INTEGER,
      item_name       VARCHAR(200),
      bin_location_id INTEGER REFERENCES bin_locations(id),
      bin_code        VARCHAR(30),
      system_qty      NUMERIC(12,4),
      counted_qty     NUMERIC(12,4),
      variance        NUMERIC(12,4),
      status          VARCHAR(20) DEFAULT 'pending'
    )
  `);

  // ── QUALITY ───────────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inspection_checklists (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(200) NOT NULL,
      type       VARCHAR(30) DEFAULT 'inward',
      items      JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inspection_reports (
      id             SERIAL PRIMARY KEY,
      checklist_id   INTEGER REFERENCES inspection_checklists(id),
      reference_type VARCHAR(30),
      reference_id   INTEGER,
      inspector_id   INTEGER,
      inspector_name VARCHAR(100),
      status         VARCHAR(20) DEFAULT 'pending',
      results        JSONB DEFAULT '{}',
      remarks        TEXT,
      inspected_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ncr_reports (
      id             SERIAL PRIMARY KEY,
      title          VARCHAR(200) NOT NULL,
      description    TEXT,
      ncr_number     VARCHAR(30),
      detected_at    TIMESTAMPTZ DEFAULT NOW(),
      detected_by    VARCHAR(100),
      reference_type VARCHAR(30),
      reference_id   INTEGER,
      severity       VARCHAR(20) DEFAULT 'minor',
      status         VARCHAR(30) DEFAULT 'open',
      root_cause     TEXT,
      disposition    VARCHAR(30),
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS capa_actions (
      id                   SERIAL PRIMARY KEY,
      ncr_id               INTEGER REFERENCES ncr_reports(id) ON DELETE CASCADE,
      action_type          VARCHAR(20) DEFAULT 'corrective',
      description          TEXT,
      assigned_to          VARCHAR(100),
      due_date             DATE,
      status               VARCHAR(20) DEFAULT 'open',
      completion_date      DATE,
      effectiveness_rating INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── MAINTENANCE ───────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS assets_register (
      id              SERIAL PRIMARY KEY,
      asset_code      VARCHAR(30) UNIQUE NOT NULL,
      name            VARCHAR(200) NOT NULL,
      category        VARCHAR(100),
      location        VARCHAR(100),
      department      VARCHAR(100),
      purchase_date   DATE,
      purchase_cost   NUMERIC(14,2),
      current_value   NUMERIC(14,2),
      status          VARCHAR(20) DEFAULT 'active',
      manufacturer    VARCHAR(100),
      model           VARCHAR(100),
      serial_number   VARCHAR(100),
      warranty_expiry DATE,
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS maintenance_schedules (
      id               SERIAL PRIMARY KEY,
      asset_id         INTEGER REFERENCES assets_register(id) ON DELETE CASCADE,
      maintenance_type VARCHAR(30) DEFAULT 'preventive',
      frequency_days   INTEGER DEFAULT 90,
      last_done_date   DATE,
      next_due_date    DATE,
      assigned_to      VARCHAR(100),
      checklist_items  JSONB DEFAULT '[]',
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS maintenance_logs (
      id           SERIAL PRIMARY KEY,
      asset_id     INTEGER REFERENCES assets_register(id) ON DELETE CASCADE,
      schedule_id  INTEGER REFERENCES maintenance_schedules(id),
      log_type     VARCHAR(30) DEFAULT 'preventive',
      description  TEXT,
      done_by      VARCHAR(100),
      start_time   TIMESTAMPTZ,
      end_time     TIMESTAMPTZ,
      downtime_hrs NUMERIC(8,2),
      parts_used   JSONB DEFAULT '[]',
      cost         NUMERIC(12,2) DEFAULT 0,
      status       VARCHAR(20) DEFAULT 'open',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS spare_parts (
      id                SERIAL PRIMARY KEY,
      part_code         VARCHAR(30) UNIQUE,
      name              VARCHAR(200) NOT NULL,
      compatible_assets JSONB DEFAULT '[]',
      stock_qty         NUMERIC(10,2) DEFAULT 0,
      reorder_level     NUMERIC(10,2) DEFAULT 5,
      unit_cost         NUMERIC(12,2) DEFAULT 0,
      unit              VARCHAR(20) DEFAULT 'pcs',
      location          VARCHAR(100),
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── LOGISTICS ─────────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS shipments (
      id                SERIAL PRIMARY KEY,
      reference_type    VARCHAR(30),
      reference_id      INTEGER,
      courier_partner   VARCHAR(100),
      tracking_number   VARCHAR(100),
      status            VARCHAR(30) DEFAULT 'booked',
      dispatch_date     DATE,
      expected_delivery DATE,
      actual_delivery   DATE,
      weight_kg         NUMERIC(8,3),
      dimensions        VARCHAR(50),
      freight_cost      NUMERIC(12,2),
      pod_image_url     TEXT,
      from_address      TEXT,
      to_address        TEXT,
      notes             TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS eway_bills (
      id                SERIAL PRIMARY KEY,
      shipment_id       INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
      eway_bill_number  VARCHAR(20),
      generated_at      TIMESTAMPTZ DEFAULT NOW(),
      valid_until       TIMESTAMPTZ,
      from_gstin        VARCHAR(20),
      to_gstin          VARCHAR(20),
      vehicle_number    VARCHAR(20),
      distance_km       INTEGER,
      goods_description TEXT,
      taxable_value     NUMERIC(14,2),
      status            VARCHAR(20) DEFAULT 'active'
    )
  `);

  // ── PROJECTS / GANTT ──────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      id           SERIAL PRIMARY KEY,
      project      VARCHAR(200),
      name         VARCHAR(300) NOT NULL,
      start_date   DATE NOT NULL,
      end_date     DATE NOT NULL,
      assignee     VARCHAR(150),
      status       VARCHAR(30) DEFAULT 'on-track',
      progress     INT DEFAULT 0,
      dependencies INT[] DEFAULT '{}',
      is_milestone BOOLEAN DEFAULT FALSE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── ADMIN / WORKFLOW / APPROVALS / INTELLIGENCE ───────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS workflow_rules (
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(200) NOT NULL,
      description       TEXT,
      trigger_module    VARCHAR(100),
      trigger_event     VARCHAR(100),
      conditions        JSONB DEFAULT '[]',
      actions           JSONB DEFAULT '[]',
      approval_chain    JSONB DEFAULT '[]',
      is_active         BOOLEAN DEFAULT TRUE,
      last_triggered_at TIMESTAMPTZ,
      trigger_count     INT DEFAULT 0,
      created_by        VARCHAR(150),
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS approvals (
      id             SERIAL PRIMARY KEY,
      module_name    VARCHAR(100),
      reference_id   INTEGER,
      reference_type VARCHAR(100),
      title          VARCHAR(255),
      description    TEXT,
      requested_by   INTEGER,
      requester_name VARCHAR(255),
      approver_id    INTEGER,
      status         VARCHAR(50)  DEFAULT 'Pending',
      comments       TEXT,
      request_date   TIMESTAMP DEFAULT NOW(),
      decision_date  TIMESTAMP,
      created_at     TIMESTAMP DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_approvals_approver ON approvals(approver_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_approvals_status   ON approvals(status)`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rules_master (
      id             SERIAL PRIMARY KEY,
      module_name    VARCHAR(100),
      rule_name      VARCHAR(200) NOT NULL,
      description    TEXT,
      condition_json JSONB DEFAULT '{}',
      action_json    JSONB DEFAULT '{}',
      priority       INT DEFAULT 10,
      is_active      BOOLEAN DEFAULT TRUE,
      created_by     INT,
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS workflow_master (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(200) NOT NULL,
      module      VARCHAR(100),
      description TEXT,
      is_active   BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS workflow_steps (
      id          SERIAL PRIMARY KEY,
      workflow_id INT,
      step_name   VARCHAR(200),
      sequence    INT DEFAULT 0,
      step_type   VARCHAR(50),
      config      JSONB DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── INTEGRATIONS ──────────────────────────────────────────────────────────────

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS whatsapp_log (
      id            SERIAL PRIMARY KEY,
      to_number     VARCHAR(20),
      template_name VARCHAR(100),
      status        VARCHAR(20) DEFAULT 'sent',
      response_json JSONB,
      sent_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payments (
      id               SERIAL PRIMARY KEY,
      invoice_id       INT,
      order_id         VARCHAR(100) UNIQUE,
      payment_id       VARCHAR(100),
      amount           NUMERIC(15,2),
      currency         VARCHAR(10) DEFAULT 'INR',
      status           VARCHAR(30) DEFAULT 'created',
      description      TEXT,
      gateway_response JSONB,
      paid_at          TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS tally_ledgers (
      id              SERIAL PRIMARY KEY,
      name            VARCHAR(200) UNIQUE,
      group_name      VARCHAR(200),
      opening_balance NUMERIC(15,2) DEFAULT 0,
      synced_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS tally_sync_log (
      id             SERIAL PRIMARY KEY,
      sync_type      VARCHAR(60),
      status         VARCHAR(30),
      records_synced INT DEFAULT 0,
      errors         INT DEFAULT 0,
      detail         JSONB,
      started_at     TIMESTAMPTZ DEFAULT NOW(),
      completed_at   TIMESTAMPTZ
    )
  `);

  // ── DOCUMENTS ─────────────────────────────────────────────────────────────────

  await knex.raw(`ALTER TABLE document_signings ADD COLUMN IF NOT EXISTS signing_url TEXT`);
}

export async function down(knex) {
  const tables = [
    // Deep dependencies first
    'cycle_count_lines', 'pick_list_lines', 'bin_locations', 'cycle_count_headers',
    'warehouse_zones', 'warehouses',
    'eng_test_plans', 'eng_prototypes', 'eng_design_phases', 'eng_rd_projects',
    'routing_steps', 'bom_lines', 'purchase_requests', 'work_centres', 'bom_headers',
    'capa_actions', 'ncr_reports', 'inspection_reports', 'inspection_checklists',
    'maintenance_logs', 'maintenance_schedules', 'spare_parts', 'assets_register',
    'eway_bills', 'shipments',
    'exit_interviews', 'exit_clearance', 'exit_requests',
    'succession_plans', 'critical_roles', 'talent_assessments',
    'biometric_logs', 'gate_passes', 'visitors', 'biometric_devices',
    'training_enrollments', 'skill_matrix', 'training_programs',
    'reimbursement_claims', 'employee_documents', 'it_declarations',
    'probation_notifications',
    'employee_salary_assignments', 'payroll_slips', 'payroll_loans', 'salary_structures',
    'asset_depreciation_log', 'fixed_assets',
    'form16a_records', 'tds_transactions', 'tds_deductees',
    'budget_alerts', 'budget_actuals', 'budget_line_items', 'budgets',
    'gst_invoices', 'gst_purchase_invoices',
    'commission_entries', 'commission_payouts', 'commission_plans',
    'price_change_log', 'discount_approvals', 'promotions', 'discount_rules',
    'price_list_items', 'price_lists',
    'credit_limits',
    'price_history', 'rfqs', 'vendors',
    'crm_emails', 'crm_email_accounts',
    'email_sequence_steps', 'sequence_enrollments', 'email_sequences',
    'email_templates',
    'crm_deals', 'assignment_rules', 'scoring_rules', 'pipeline_stages',
    'nps_responses', 'support_tickets', 'customer_payments',
    'workflow_steps', 'workflow_master', 'workflow_rules', 'rules_master',
    'approvals',
    'project_tasks',
    'tally_sync_log', 'tally_ledgers', 'payments', 'whatsapp_log',
    'notifications',
    'master_designations', 'master_zones', 'master_departments',
    'audit_trail', 'revoked_tokens', 'ip_whitelist', 'security_events',
    'password_reset_otps',
    'hr_shifts',
  ];

  for (const t of tables) {
    await knex.raw(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
}
