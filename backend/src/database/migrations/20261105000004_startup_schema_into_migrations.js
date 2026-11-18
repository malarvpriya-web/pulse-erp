/**
 * 20261105000004 — DB-01C3: the schema statements route files ran at startup.
 * MODULE_FEATURE_CONNECTION_MANUAL.md §248.
 *
 * Route files used to run these every time they were imported, swallowing any error.
 * An application role that may not change the schema cannot run them, so they move
 * here, in the order the files held them, and the route files no longer run DDL.
 *
 * On a database built from the current baseline, or already booted on recent code,
 * this adds no schema: measured with schema-compare before the blocks were removed.
 * It exists for a database that is behind, which would otherwise lose whatever the
 * removed blocks would have added on its next boot.
 *
 * An error now stops the migration instead of being logged and forgotten.
 *
 * Three travel backfills and the system_wizard row move too, so they run once.
 * They used to run on every boot.
 *
 * down() does nothing. These statements overlap what older migrations and baseline.sql
 * created, so nothing here can tell which objects it alone added.
 */
const STATEMENTS = [
  // src/announcements/announcement.service.js
  `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS priority  VARCHAR(10)  DEFAULT 'medium';
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS category  VARCHAR(50)  DEFAULT 'General';
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_by INTEGER;
  ALTER TABLE announcements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`,

  // src/auth/auth.routes.js
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS logout_at TIMESTAMPTZ;`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb;`,
  `CREATE TABLE IF NOT EXISTS auth_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id) ON DELETE SET NULL,
    event       VARCHAR(32) NOT NULL,
    ip          VARCHAR(64),
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_auth_audit_user
    ON auth_audit_log(user_id, created_at DESC);`,
  `CREATE TABLE IF NOT EXISTS auth_rate_limit (
    ip           VARCHAR(64) PRIMARY KEY,
    count        INT         NOT NULL DEFAULT 0,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,

  // src/modules/admin/branchManagement.routes.js
  `ALTER TABLE branches
    ADD COLUMN IF NOT EXISTS branch_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS address     TEXT,
    ADD COLUMN IF NOT EXISTS state       VARCHAR(100),
    ADD COLUMN IF NOT EXISTS phone       VARCHAR(20),
    ADD COLUMN IF NOT EXISTS email       VARCHAR(255)`,

  // src/modules/admin/companyProfile.routes.js
  `ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS gstin      VARCHAR(15),
    ADD COLUMN IF NOT EXISTS pan        VARCHAR(10),
    ADD COLUMN IF NOT EXISTS tan        VARCHAR(10),
    ADD COLUMN IF NOT EXISTS cin        VARCHAR(21),
    ADD COLUMN IF NOT EXISTS logo_url   TEXT,
    ADD COLUMN IF NOT EXISTS phone      VARCHAR(20),
    ADD COLUMN IF NOT EXISTS email      VARCHAR(255),
    ADD COLUMN IF NOT EXISTS website    VARCHAR(255),
    ADD COLUMN IF NOT EXISTS pincode    VARCHAR(10)`,

  // src/modules/attendance/routes/attendance.routes.js
  `ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS ot_eligible        BOOLEAN        DEFAULT TRUE;
  ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS weekly_off         JSONB          DEFAULT '["Sat","Sun"]';
  ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS capacity           INTEGER        DEFAULT 0;
  ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS is_night_shift     BOOLEAN        DEFAULT FALSE;
  ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS break_duration     INTEGER        DEFAULT 30;
  ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS company_id         INTEGER;
  ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS deleted_at         TIMESTAMPTZ;
  ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS half_day_hours     NUMERIC(4,2)   DEFAULT 4;
  ALTER TABLE hr_shifts ADD COLUMN IF NOT EXISTS role_grace_minutes JSONB          DEFAULT '{}';
  ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS selfie_url TEXT;
  ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS geo_settings        JSONB DEFAULT '{}';
  ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS device_settings     JSONB DEFAULT '{}';
  ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS report_settings     JSONB DEFAULT '{}';
  ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS workcentre_settings JSONB DEFAULT '{}';
  ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS work_start_time     TIME DEFAULT '09:00';
  ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS work_end_time       TIME DEFAULT '18:00';
  ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS break_duration      INTEGER DEFAULT 60;
  ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS min_working_hours   NUMERIC(4,2) DEFAULT 9.0;
  ALTER TABLE attendance_general_settings ADD COLUMN IF NOT EXISTS weekend_days        JSONB DEFAULT '["saturday","sunday"]';
  ALTER TABLE payroll_attendance_summary ADD COLUMN IF NOT EXISTS wfh_days   INTEGER     NOT NULL DEFAULT 0;
  ALTER TABLE payroll_attendance_summary ADD COLUMN IF NOT EXISTS half_days  INTEGER     NOT NULL DEFAULT 0;
  ALTER TABLE payroll_attendance_summary ADD COLUMN IF NOT EXISTS leave_days NUMERIC(5,1) NOT NULL DEFAULT 0;
  ALTER TABLE hr_shift_rotations ADD COLUMN IF NOT EXISTS week_3_shift_id INTEGER REFERENCES hr_shifts(id);
  ALTER TABLE hr_shift_rotations ADD COLUMN IF NOT EXISTS week_4_shift_id INTEGER REFERENCES hr_shifts(id);
  ALTER TABLE compensatory_off ADD COLUMN IF NOT EXISTS auto_granted BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE TABLE IF NOT EXISTS attendance_approval_delegations (
    id           SERIAL PRIMARY KEY,
    company_id   INTEGER,
    delegator_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    delegate_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    from_date    DATE NOT NULL,
    to_date      DATE NOT NULL,
    delegation_type TEXT NOT NULL DEFAULT 'all',
    reason       TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_by   INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (delegator_id, from_date, to_date)
  );`,
  `CREATE TABLE IF NOT EXISTS attendance_face_settings (
    id          SERIAL PRIMARY KEY,
    company_id  INTEGER,
    settings    JSONB NOT NULL DEFAULT '{}',
    updated_by  INTEGER,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id)
  )`,
  `CREATE TABLE IF NOT EXISTS payroll_attendance_summary (
    id           SERIAL PRIMARY KEY,
    company_id   INTEGER,
    employee_id  INTEGER NOT NULL,
    month        INTEGER NOT NULL,
    year         INTEGER NOT NULL,
    working_days INTEGER NOT NULL DEFAULT 0,
    present_days INTEGER NOT NULL DEFAULT 0,
    absent_days  INTEGER NOT NULL DEFAULT 0,
    late_count   INTEGER NOT NULL DEFAULT 0,
    ot_hours     NUMERIC(8,2) NOT NULL DEFAULT 0,
    lop_days     NUMERIC(5,1) NOT NULL DEFAULT 0,
    wfh_days     INTEGER NOT NULL DEFAULT 0,
    half_days    INTEGER NOT NULL DEFAULT 0,
    leave_days   NUMERIC(5,1) NOT NULL DEFAULT 0,
    synced_by    INTEGER,
    synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(employee_id, month, year)
  )`,
  `CREATE TABLE IF NOT EXISTS face_templates (
    id          SERIAL PRIMARY KEY,
    company_id  INTEGER NOT NULL DEFAULT 0,
    employee_id INTEGER NOT NULL,
    enrolled_by INTEGER,
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    notes       TEXT,
    UNIQUE (company_id, employee_id)
  )`,
  `ALTER TABLE face_templates ADD COLUMN IF NOT EXISTS descriptor JSONB`,
  `CREATE TABLE IF NOT EXISTS face_locked_accounts (
    id           SERIAL PRIMARY KEY,
    company_id   INTEGER NOT NULL DEFAULT 0,
    employee_id  INTEGER NOT NULL,
    fail_count   INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_attempt TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (company_id, employee_id)
  )`,
  `CREATE TABLE IF NOT EXISTS attendance_workflow_config (
    id              SERIAL PRIMARY KEY,
    company_id      INTEGER,
    workflow_type   VARCHAR(60) NOT NULL,
    levels          JSONB NOT NULL DEFAULT '[]',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by      INTEGER,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, workflow_type)
  )`,
  `CREATE TABLE IF NOT EXISTS attendance_general_settings (
    id                SERIAL PRIMARY KEY,
    company_id        INTEGER UNIQUE,
    working_days      JSONB   DEFAULT '["monday","tuesday","wednesday","thursday","friday"]',
    timezone          VARCHAR(80) DEFAULT 'Asia/Kolkata',
    attendance_mode   VARCHAR(30) DEFAULT 'manual',
    auto_checkout     BOOLEAN DEFAULT FALSE,
    auto_checkout_time TIME DEFAULT '21:00',
    half_day_hours    NUMERIC(4,2) DEFAULT 4.5,
    full_day_hours    NUMERIC(4,2) DEFAULT 9.0,
    updated_by        INTEGER,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS attendance_late_warnings (
    id            SERIAL PRIMARY KEY,
    company_id    INTEGER,
    employee_id   INTEGER NOT NULL,
    employee_name VARCHAR(200),
    department    VARCHAR(100),
    issued_by     INTEGER,
    month         VARCHAR(7),
    late_count    INTEGER,
    warning_text  TEXT,
    status        VARCHAR(20) NOT NULL DEFAULT 'issued',
    acknowledged_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_late_warnings_emp_month
    ON attendance_late_warnings (employee_id, month);`,
  `CREATE TABLE IF NOT EXISTS shift_change_requests (
    id                  SERIAL PRIMARY KEY,
    company_id          INTEGER,
    employee_id         INTEGER NOT NULL,
    request_date        DATE NOT NULL,
    current_shift_id    INTEGER,
    requested_shift_id  INTEGER NOT NULL,
    reason              TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    reviewed_by         INTEGER,
    review_remarks      TEXT,
    reviewed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // src/modules/engineering/testHistorian.routes.js
  `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS compliance_class TEXT DEFAULT 'class_a'`,
  `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS bom_header_id INT`,
  `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS bom_revision INT`,
  `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS report_generated_at TIMESTAMPTZ`,
  `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS report_hash TEXT`,

  // src/modules/finance/routes/extended.routes.js
  `ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS current_balance NUMERIC(14,2) DEFAULT 0;
  ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;
  ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS company_id INTEGER;`,

  // src/modules/finance/routes/finance.routes.js
  `CREATE SEQUENCE IF NOT EXISTS seq_jv START 1 INCREMENT BY 1 NO CYCLE`,

  // src/modules/hr/biometric.routes.js
  `ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS company_id           INTEGER;
  ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS vendor               TEXT;
  ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS serial_number        TEXT;
  ALTER TABLE biometric_devices ADD COLUMN IF NOT EXISTS attendance_direction TEXT DEFAULT 'both';
  ALTER TABLE gate_passes        ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE visitors           ADD COLUMN IF NOT EXISTS company_id INTEGER;`,

  // src/modules/hr/hr.routes.js
  `ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS version VARCHAR(20) DEFAULT 'v1.0';
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS effective_date DATE;
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS review_date DATE;
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS drive_url TEXT;
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS requires_acknowledgement BOOLEAN DEFAULT false;
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS applicable_to VARCHAR(50) DEFAULT 'all';
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
  ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
  ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS download_count INTEGER DEFAULT 0;
  ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS visible_to VARCHAR(50) NOT NULL DEFAULT 'all';
  ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS file_type VARCHAR(20);
  CREATE TABLE IF NOT EXISTS hr_policy_acknowledgements (
    id SERIAL PRIMARY KEY,
    policy_id INTEGER NOT NULL REFERENCES hr_policies(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL,
    acknowledged_at TIMESTAMPTZ DEFAULT NOW(),
    ip_address INET,
    UNIQUE(policy_id, employee_id)
  );
  ALTER TABLE hr_policy_acknowledgements ADD COLUMN IF NOT EXISTS ip_address INET;
  ALTER TABLE employees ADD COLUMN IF NOT EXISTS default_shift_id INTEGER REFERENCES hr_shifts(id) ON DELETE SET NULL;`,

  // src/modules/hr/hr.routes.js
  `CREATE TABLE IF NOT EXISTS hr_shift_date_overrides (
    id            SERIAL PRIMARY KEY,
    employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    shift_id      INTEGER NOT NULL REFERENCES hr_shifts(id) ON DELETE CASCADE,
    override_date DATE NOT NULL,
    reason        TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    company_id    INTEGER,
    created_by    INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, override_date)
  );
  CREATE INDEX IF NOT EXISTS idx_hr_shift_date_overrides_emp_date
    ON hr_shift_date_overrides(employee_id, override_date);`,

  // src/modules/inventory/routes/advancedInventory.routes.js
  `ALTER TABLE stock_alerts ADD COLUMN IF NOT EXISTS resolved_by INTEGER`,

  // src/modules/master/master.routes.js
  `CREATE TABLE IF NOT EXISTS master_departments (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(100) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS master_zones (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(100) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS master_designations (
    id        SERIAL PRIMARY KEY,
    name      VARCHAR(100) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS master_uom (
    id           SERIAL PRIMARY KEY,
    code         VARCHAR(20)  NOT NULL UNIQUE,
    name         VARCHAR(100) NOT NULL,
    category     VARCHAR(50)  NOT NULL DEFAULT 'General',
    is_active    BOOLEAN      NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS master_hsn_sac (
    id           SERIAL PRIMARY KEY,
    code         VARCHAR(20)  NOT NULL UNIQUE,
    description  VARCHAR(255) NOT NULL,
    gst_rate     NUMERIC(5,2) NOT NULL DEFAULT 0,
    type         VARCHAR(3)   NOT NULL DEFAULT 'HSN' CHECK (type IN ('HSN','SAC')),
    is_active    BOOLEAN      NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS master_grades (
    id         SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id),
    name       VARCHAR(50) NOT NULL,
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, name)
  );
  CREATE TABLE IF NOT EXISTS master_bands (
    id         SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id),
    name       VARCHAR(50) NOT NULL,
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, name)
  );`,

  // src/modules/operations/lifecycle.routes.js
  `ALTER TABLE lifecycle_instances     ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE commissioning_reports   ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE amc_contracts           ADD COLUMN IF NOT EXISTS company_id INTEGER;`,

  // src/modules/projects/routes/projectCostEngine.routes.js
  `CREATE TABLE IF NOT EXISTS cost_centers (
    id            SERIAL PRIMARY KEY,
    company_id    INTEGER,
    code          VARCHAR(30) NOT NULL,
    name          VARCHAR(120) NOT NULL,
    department    VARCHAR(100),
    department_id INTEGER,
    parent_id     INTEGER,
    description   TEXT,
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS project_cost_transactions (
    id                SERIAL PRIMARY KEY,
    company_id        INTEGER,
    customer_id       INTEGER,
    customer_name     VARCHAR(255),
    project_id        INTEGER,
    project_code      VARCHAR(50),
    site_id           INTEGER,
    site_name         VARCHAR(255),
    sales_order_id    INTEGER,
    po_number         VARCHAR(100),
    cost_center_id    INTEGER,
    cost_type         VARCHAR(40) NOT NULL,
    reference_module  VARCHAR(60),
    reference_id      INTEGER,
    reference_code    VARCHAR(100),
    amount            NUMERIC(15,2) NOT NULL DEFAULT 0,
    currency          CHAR(3) DEFAULT 'INR',
    transaction_date  DATE NOT NULL DEFAULT CURRENT_DATE,
    description       TEXT,
    remarks           TEXT,
    is_unallocated    BOOLEAN DEFAULT FALSE,
    unallocated_reason TEXT,
    created_by        INTEGER,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS project_revenue_summary (
    id                    SERIAL PRIMARY KEY,
    company_id            INTEGER,
    project_id            INTEGER UNIQUE,
    quotation_value       NUMERIC(15,2) DEFAULT 0,
    order_value           NUMERIC(15,2) DEFAULT 0,
    invoice_value         NUMERIC(15,2) DEFAULT 0,
    collection_value      NUMERIC(15,2) DEFAULT 0,
    retention_value       NUMERIC(15,2) DEFAULT 0,
    pending_collection    NUMERIC(15,2) DEFAULT 0,
    advance_received      NUMERIC(15,2) DEFAULT 0,
    last_invoice_date     DATE,
    last_collection_date  DATE,
    updated_at            TIMESTAMPTZ DEFAULT NOW()
  )`,
  `ALTER TABLE project_cost_summary
    ADD COLUMN IF NOT EXISTS sales_travel_cost      NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS app_engineering_cost   NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS engineering_cost       NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS procurement_cost       NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS inventory_cost         NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS production_cost        NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fat_cost               NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS transport_cost         NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS amc_cost               NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS other_cost             NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS gross_margin_pct       NUMERIC(8,2)  DEFAULT 0,
    ADD COLUMN IF NOT EXISTS net_margin_pct         NUMERIC(8,2)  DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cost_variance          NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS budget_variance        NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS collection_pct         NUMERIC(8,2)  DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_revenue          NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS amc_revenue            NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS procurement_overhead   NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS manufacturing_cost     NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS expense_cost           NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS subcontractor_cost     NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS travel_cost            NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS margin_pct             NUMERIC(8,2)  DEFAULT 0,
    ADD COLUMN IF NOT EXISTS planned_value          NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS earned_value           NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS actual_cost_evm        NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cost_performance_index NUMERIC(8,3)  DEFAULT 1,
    ADD COLUMN IF NOT EXISTS schedule_performance_index NUMERIC(8,3) DEFAULT 1,
    ADD COLUMN IF NOT EXISTS last_calculated_at     TIMESTAMPTZ`,

  // src/modules/projects/routes/projects.routes.js
  `ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS billing_milestone BOOLEAN DEFAULT FALSE;
  ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS amount            NUMERIC(15,2) DEFAULT 0;
  ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS owner_id          INTEGER REFERENCES employees(id) ON DELETE SET NULL;
  ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS completed_date    DATE;
  ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS invoice_id        INTEGER;
  ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS invoice_created   BOOLEAN DEFAULT FALSE;`,

  // src/modules/quality/disturbance.routes.js
  `CREATE TABLE IF NOT EXISTS disturbance_events (
    id               SERIAL PRIMARY KEY,
    company_id       INT,
    equipment_id     INT,
    event_type       TEXT NOT NULL,
    severity         TEXT NOT NULL DEFAULT 'warning',
    site_name        TEXT,
    measured_value   NUMERIC,
    threshold_value  NUMERIC,
    unit             TEXT,
    duration_ms      INT,
    waveform_ref     TEXT,
    event_ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by       INT,
    created_by_name  TEXT,
    resolved_at      TIMESTAMPTZ,
    resolved_by_name TEXT,
    notes            TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_dist_evt_ts  ON disturbance_events(event_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_dist_evt_typ ON disturbance_events(event_type, severity);
  CREATE INDEX IF NOT EXISTS idx_dist_evt_co  ON disturbance_events(company_id);`,

  // src/modules/recruitment/routes/recruitment.routes.js
  `CREATE TABLE IF NOT EXISTS interview_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id INTEGER,
    interview_date DATE NOT NULL DEFAULT CURRENT_DATE,
    interview_time TIME,
    interview_mode VARCHAR(20),
    meeting_link VARCHAR(500),
    interviewer_id INTEGER,
    status VARCHAR(20) DEFAULT 'scheduled',
    notes TEXT,
    company_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS offer_letters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id INTEGER,
    job_opening_id INTEGER,
    offered_salary DECIMAL(15,2) DEFAULT 0,
    joining_date DATE DEFAULT CURRENT_DATE,
    offer_status VARCHAR(20) DEFAULT 'draft',
    offer_sent_date DATE,
    response_date DATE,
    notes TEXT,
    company_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
  );`,

  // src/modules/sales/routes/sales.routes.js
  `CREATE TABLE IF NOT EXISTS sales_documents (
    id SERIAL PRIMARY KEY,
    company_id INTEGER,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) DEFAULT 'Other',
    customer_name VARCHAR(255),
    file_url TEXT,
    file_size INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // src/modules/sales/routes/sales.routes.js
  `CREATE TABLE IF NOT EXISTS sales_territories (
    id              SERIAL PRIMARY KEY,
    company_id      INTEGER,
    name            TEXT NOT NULL,
    region          TEXT,
    assigned_to     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    target_revenue  NUMERIC(15,2) DEFAULT 0,
    status          TEXT DEFAULT 'active',
    created_at      TIMESTAMPTZ DEFAULT NOW()
  );`,

  // src/modules/sales/routes/sales.routes.js
  `CREATE TABLE IF NOT EXISTS sales_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id INTEGER NOT NULL,
    title VARCHAR(255) NOT NULL,
    type VARCHAR(30) DEFAULT 'meeting',
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ,
    all_day BOOLEAN DEFAULT false,
    -- INTEGER, not UUID: users.id, accounts.id and opportunities.id are all
    -- integer-keyed. Declared uuid, this bootstrap made every insert fail
    -- with 22P02 the moment owner_id was stamped from req.user.userId.
    -- See migration 20260827000001_sales_events_actor_ids_to_integer.
    owner_id INTEGER,
    account_id INTEGER,
    opportunity_id INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // src/modules/sales/routes/sales.routes.js
  `ALTER TABLE sales_territories ADD COLUMN IF NOT EXISTS states JSONB DEFAULT '[]'`,

  // src/modules/sales/routes/sales.routes.js
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id INTEGER NOT NULL,
    customer_id INTEGER,
    customer_name VARCHAR(255),
    plan_name VARCHAR(255) NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'INR',
    billing_cycle VARCHAR(20) DEFAULT 'monthly',
    status VARCHAR(20) DEFAULT 'active',
    start_date DATE NOT NULL,
    next_billing_date DATE,
    end_date DATE,
    auto_renew BOOLEAN DEFAULT true,
    owner_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // src/modules/sales/routes/sales.routes.js
  `CREATE TABLE IF NOT EXISTS competitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    website VARCHAR(255),
    strengths TEXT,
    weaknesses TEXT,
    win_rate NUMERIC(5,2),
    notes TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // src/modules/sales/routes/sales.routes.js
  `CREATE TABLE IF NOT EXISTS sales_settings (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL UNIQUE,
    default_currency VARCHAR(10) DEFAULT 'INR',
    quotation_validity_days INTEGER DEFAULT 30,
    order_prefix VARCHAR(10) DEFAULT 'SO',
    quotation_prefix VARCHAR(10) DEFAULT 'QUO',
    default_tax_rate NUMERIC(5,2) DEFAULT 18,
    default_place_of_supply VARCHAR(100) DEFAULT 'Karnataka',
    auto_invoice_on_delivery BOOLEAN DEFAULT false,
    require_approval_above NUMERIC(14,2),
    fiscal_year_start INTEGER DEFAULT 4,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // src/modules/servicedesk/routes/servicedesk.routes.js
  `CREATE TABLE IF NOT EXISTS service_engineers (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT,
    phone      TEXT,
    skills     TEXT,
    zone       TEXT,
    status     TEXT DEFAULT 'Active',
    company_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS field_visits (
    id            SERIAL PRIMARY KEY,
    customer_name TEXT NOT NULL,
    address       TEXT,
    visit_date    DATE NOT NULL,
    visit_time    TEXT,
    engineer_name TEXT,
    purpose       TEXT,
    ticket_id     TEXT,
    status        TEXT DEFAULT 'Scheduled',
    notes         TEXT,
    company_id    INTEGER,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS service_contracts (
    id                 SERIAL PRIMARY KEY,
    customer_name      TEXT NOT NULL,
    contract_type      TEXT DEFAULT 'AMC',
    start_date         DATE NOT NULL,
    end_date           DATE NOT NULL,
    value              NUMERIC DEFAULT 0,
    sla_response_hrs   INTEGER DEFAULT 4,
    sla_resolution_hrs INTEGER DEFAULT 24,
    status             TEXT DEFAULT 'Active',
    notes              TEXT,
    company_id         INTEGER,
    created_at         TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS sla_policies (
    id                   SERIAL PRIMARY KEY,
    name                 TEXT NOT NULL,
    priority             TEXT NOT NULL,
    first_response_hours NUMERIC NOT NULL DEFAULT 4,
    resolution_hours     NUMERIC NOT NULL DEFAULT 24,
    escalation_hours     NUMERIC DEFAULT 8,
    business_hours_only  BOOLEAN DEFAULT true,
    company_id           INTEGER,
    created_at           TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS auto_assignment_rules (
    id                SERIAL PRIMARY KEY,
    name              TEXT NOT NULL,
    priority          INTEGER DEFAULT 10,
    conditions        JSONB DEFAULT '[]',
    assign_to_team    TEXT,
    assign_to_user_id INTEGER,
    round_robin_group TEXT,
    is_active         BOOLEAN DEFAULT true,
    company_id        INTEGER,
    created_at        TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS csat_responses (
    id              SERIAL PRIMARY KEY,
    ticket_id       INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL,
    ticket_subject  TEXT,
    rating          INTEGER CHECK(rating >= 1 AND rating <= 5),
    product_rating  INTEGER CHECK(product_rating  BETWEEN 1 AND 5),
    engineer_rating INTEGER CHECK(engineer_rating BETWEEN 1 AND 5),
    visited_on_time BOOLEAN,
    resolved        BOOLEAN,
    customer_name   TEXT,
    complaint_id    INTEGER,
    feedback        TEXT,
    agent_name      TEXT,
    company_id      INTEGER,
    responded_at    TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS service_master (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT,
    description TEXT,
    price       NUMERIC DEFAULT 0,
    is_active   BOOLEAN DEFAULT true,
    company_id  INTEGER,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS service_sites (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    customer_id   INTEGER,
    customer_name TEXT,
    address       TEXT NOT NULL,
    city          TEXT,
    state         TEXT,
    pincode       TEXT,
    contact_name  TEXT,
    contact_phone TEXT,
    site_type     TEXT DEFAULT 'Office',
    status        TEXT DEFAULT 'Active',
    company_id    INTEGER,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS delivery_notes (
    id              SERIAL PRIMARY KEY,
    dn_number       TEXT UNIQUE,
    ticket_id       INTEGER,
    customer_name   TEXT NOT NULL,
    delivery_date   DATE NOT NULL,
    delivered_by    TEXT,
    items_delivered TEXT,
    status          TEXT DEFAULT 'Pending',
    notes           TEXT,
    company_id      INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  );`,
  `ALTER TABLE service_engineers     ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE service_engineers     ADD COLUMN IF NOT EXISTS employee_id INTEGER;
  ALTER TABLE field_visits          ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE service_contracts     ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE sla_policies          ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE auto_assignment_rules ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE csat_responses        ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE service_master        ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE service_sites         ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE delivery_notes        ADD COLUMN IF NOT EXISTS company_id INTEGER;`,
  `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'fk_csat_responses_ticket'
    ) THEN
      UPDATE csat_responses SET ticket_id = NULL
       WHERE ticket_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM support_tickets t WHERE t.id = csat_responses.ticket_id);
      ALTER TABLE csat_responses
        ADD CONSTRAINT fk_csat_responses_ticket
        FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE SET NULL;
    END IF;
  END $$;`,

  // src/modules/servicedesk/routes/servicedesk.routes.js
  `CREATE TABLE IF NOT EXISTS service_knowledge_base (
    id           SERIAL PRIMARY KEY,
    company_id   INTEGER,
    title        TEXT NOT NULL,
    content      TEXT,
    category     TEXT DEFAULT 'General',
    tags         TEXT[],
    author_id    INTEGER,
    views        INTEGER DEFAULT 0,
    helpful_yes  INTEGER DEFAULT 0,
    helpful_no   INTEGER DEFAULT 0,
    is_published BOOLEAN DEFAULT TRUE,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  )`,

  // src/modules/talent/talent.routes.js
  `CREATE TABLE IF NOT EXISTS talent_pools (
    id           SERIAL PRIMARY KEY,
    pool_name    VARCHAR(200) NOT NULL,
    description  TEXT,
    skill_focus  VARCHAR(200),
    source       VARCHAR(100),
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS recruitment_agencies (
    id              SERIAL PRIMARY KEY,
    agency_name     VARCHAR(200) NOT NULL,
    contact_name    VARCHAR(200),
    email           VARCHAR(200),
    phone           VARCHAR(50),
    specialization  VARCHAR(200),
    commission_pct  NUMERIC(5,2) DEFAULT 0,
    city            VARCHAR(100),
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS interview_questions (
    id               SERIAL PRIMARY KEY,
    question         TEXT NOT NULL,
    category         VARCHAR(100) DEFAULT 'General',
    difficulty       VARCHAR(50)  DEFAULT 'Medium',
    expected_answer  TEXT,
    tags             TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
  )`,
  `ALTER TABLE recruitment_agencies
    ADD COLUMN IF NOT EXISTS company_id      INTEGER REFERENCES companies(id),
    ADD COLUMN IF NOT EXISTS contact_person  VARCHAR(255),
    ADD COLUMN IF NOT EXISTS website         VARCHAR(255),
    ADD COLUMN IF NOT EXISTS fee_percentage  NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS specializations JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS payment_terms   TEXT,
    ADD COLUMN IF NOT EXISTS agreement_start DATE,
    ADD COLUMN IF NOT EXISTS agreement_end   DATE,
    ADD COLUMN IF NOT EXISTS is_active       BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW()`,
  `ALTER TABLE interview_questions
    ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id),
    ADD COLUMN IF NOT EXISTS job_role   VARCHAR(255),
    ADD COLUMN IF NOT EXISTS is_active  BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS tags_jsonb JSONB DEFAULT '[]'`,
  `CREATE TABLE IF NOT EXISTS talent_pool_members (
    pool_id      INTEGER     NOT NULL,
    candidate_id INTEGER     NOT NULL,
    added_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY  (pool_id, candidate_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tpm_pool      ON talent_pool_members(pool_id);
  CREATE INDEX IF NOT EXISTS idx_tpm_candidate ON talent_pool_members(candidate_id)`,
  `ALTER TABLE talent_pool_members ADD COLUMN IF NOT EXISTS notes    TEXT;
  ALTER TABLE talent_pool_members ADD COLUMN IF NOT EXISTS added_by INTEGER REFERENCES employees(id) ON DELETE SET NULL`,
  `ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS company_id  INTEGER  REFERENCES companies(id) ON DELETE CASCADE;
  ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS skills       JSONB    DEFAULT '[]';
  ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS department   VARCHAR(100);
  ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS is_active    BOOLEAN  DEFAULT true;
  ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS created_by   INTEGER  REFERENCES employees(id) ON DELETE SET NULL;
  ALTER TABLE talent_pools ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW()`,
  `ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS source_agency_id INTEGER
      REFERENCES recruitment_agencies(id) ON DELETE SET NULL`,

  // src/modules/travel/travel-reimbursement.routes.js
  `ALTER TABLE expense_claims
    ADD COLUMN IF NOT EXISTS advance_adjusted NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS net_payable      NUMERIC(12,2)`,

  // src/modules/travel/travel.routes.js
  `ALTER TABLE travel_requests
    ADD COLUMN IF NOT EXISTS employee_name    VARCHAR(150),
    ADD COLUMN IF NOT EXISTS department       VARCHAR(100),
    ADD COLUMN IF NOT EXISTS mode             VARCHAR(50),
    ADD COLUMN IF NOT EXISTS hotel_required   BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS advance_required BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS notes            TEXT,
    ADD COLUMN IF NOT EXISTS company_id       INTEGER,
    ADD COLUMN IF NOT EXISTS customer_name    VARCHAR(200),
    ADD COLUMN IF NOT EXISTS project_number   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS request_number   VARCHAR(50)`,
  `UPDATE travel_requests
    SET request_number = 'TR-' || LPAD(id::text, 3, '0')
    WHERE request_number IS NULL`,
  `CREATE TABLE IF NOT EXISTS travel_advances (
    id                  SERIAL PRIMARY KEY,
    employee_id         INTEGER,
    company_id          INTEGER,
    amount              NUMERIC(12,2) DEFAULT 0,
    purpose             TEXT,
    required_by         DATE,
    travel_request_id   INTEGER,
    settled_amount      NUMERIC(12,2),
    status              VARCHAR(50)  DEFAULT 'Pending',
    created_by          INTEGER,
    created_at          TIMESTAMPTZ  DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  DEFAULT NOW()
  )`,
  `ALTER TABLE travel_advances
    ADD COLUMN IF NOT EXISTS company_id        INTEGER,
    ADD COLUMN IF NOT EXISTS required_by       DATE,
    ADD COLUMN IF NOT EXISTS travel_request_id INTEGER,
    ADD COLUMN IF NOT EXISTS settled_amount    NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS document_link     TEXT,
    ADD COLUMN IF NOT EXISTS finance_comments  TEXT,
    ADD COLUMN IF NOT EXISTS finance_by        INTEGER,
    ADD COLUMN IF NOT EXISTS finance_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS manager_comments  TEXT,
    ADD COLUMN IF NOT EXISTS manager_by        INTEGER,
    ADD COLUMN IF NOT EXISTS manager_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resubmission_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS payment_ref       VARCHAR(100),
    ADD COLUMN IF NOT EXISTS payment_date      DATE,
    ADD COLUMN IF NOT EXISTS disbursed_by      INTEGER,
    ADD COLUMN IF NOT EXISTS disbursed_at      TIMESTAMPTZ`,
  `UPDATE travel_advances SET status='Pending Finance' WHERE status='Pending'`,
  `CREATE TABLE IF NOT EXISTS travel_bookings (
    id                SERIAL PRIMARY KEY,
    travel_request_id INTEGER,
    booking_type      VARCHAR(100),
    booking_ref       VARCHAR(100),
    details           TEXT,
    amount            NUMERIC(12,2) DEFAULT 0,
    status            VARCHAR(50)  DEFAULT 'Pending',
    created_by        INTEGER,
    created_at        TIMESTAMPTZ  DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  DEFAULT NOW()
  )`,
  `ALTER TABLE travel_bookings
    ADD COLUMN IF NOT EXISTS destination   VARCHAR(200),
    ADD COLUMN IF NOT EXISTS mode          VARCHAR(50),
    ADD COLUMN IF NOT EXISTS from_date     DATE,
    ADD COLUMN IF NOT EXISTS to_date       DATE,
    ADD COLUMN IF NOT EXISTS employee_name VARCHAR(150),
    ADD COLUMN IF NOT EXISTS airline_train VARCHAR(100),
    ADD COLUMN IF NOT EXISTS notes         TEXT,
    ADD COLUMN IF NOT EXISTS company_id    INTEGER`,
  `INSERT INTO travel_bookings
    (travel_request_id, destination, from_date, to_date, mode,
     employee_name, status, company_id, created_by)
  SELECT tr.id, tr.destination, tr.from_date, tr.to_date, tr.mode,
         tr.employee_name, 'pending_booking', tr.company_id, tr.created_by
  FROM travel_requests tr
  WHERE tr.status = 'Approved'
    AND tr.id NOT IN (
      SELECT travel_request_id FROM travel_bookings WHERE travel_request_id IS NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS travel_expense_items (
    id                    SERIAL PRIMARY KEY,
    company_id            INTEGER,
    category              VARCHAR(100),
    amount                NUMERIC(12,2) DEFAULT 0,
    gst_amount            NUMERIC(12,2) DEFAULT 0,
    total_amount          NUMERIC(12,2),
    expense_date          DATE,
    description           TEXT,
    receipt_ref           VARCHAR(200),
    google_drive_link     TEXT,
    bill_upload_path      TEXT,
    customer_id           INTEGER,
    customer_name         VARCHAR(200),
    project_id            INTEGER,
    project_number        VARCHAR(100),
    site_name             VARCHAR(200),
    opportunity_id        INTEGER,
    opportunity_ref       VARCHAR(100),
    po_number             VARCHAR(100),
    travel_request_id     INTEGER,
    status                VARCHAR(50)  DEFAULT 'Draft',
    reimbursement_status  VARCHAR(50)  DEFAULT 'Pending',
    created_by            INTEGER,
    created_at            TIMESTAMPTZ  DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  DEFAULT NOW()
  )`,
  `ALTER TABLE travel_expense_items
    ADD COLUMN IF NOT EXISTS company_id           INTEGER,
    ADD COLUMN IF NOT EXISTS gst_amount           NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_amount         NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS google_drive_link    TEXT,
    ADD COLUMN IF NOT EXISTS bill_upload_path     TEXT,
    ADD COLUMN IF NOT EXISTS customer_id          INTEGER,
    ADD COLUMN IF NOT EXISTS customer_name        VARCHAR(200),
    ADD COLUMN IF NOT EXISTS project_id           INTEGER,
    ADD COLUMN IF NOT EXISTS project_number       VARCHAR(100),
    ADD COLUMN IF NOT EXISTS site_name            VARCHAR(200),
    ADD COLUMN IF NOT EXISTS opportunity_id       INTEGER,
    ADD COLUMN IF NOT EXISTS opportunity_ref      VARCHAR(100),
    ADD COLUMN IF NOT EXISTS po_number            VARCHAR(100),
    ADD COLUMN IF NOT EXISTS reimbursement_status VARCHAR(50) DEFAULT 'Pending'`,

  // src/modules/wizard/wizard.routes.js
  `CREATE TABLE IF NOT EXISTS system_wizard (
    id           INTEGER PRIMARY KEY DEFAULT 1,
    dismissed    BOOLEAN NOT NULL DEFAULT false,
    dismissed_at TIMESTAMPTZ,
    completed    BOOLEAN NOT NULL DEFAULT false,
    completed_at TIMESTAMPTZ,
    current_step INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT system_wizard_single_row CHECK (id = 1)
  );
  INSERT INTO system_wizard (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`,
  `ALTER TABLE system_wizard ADD COLUMN IF NOT EXISTS current_step INTEGER NOT NULL DEFAULT 0`,
];

export async function up(knex) {
  for (const sql of STATEMENTS) await knex.raw(sql);
}

export async function down() {}
