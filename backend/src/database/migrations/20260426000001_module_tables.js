/**
 * 20260426000001_module_tables.js
 * Creates missing module tables and adds name column to employees.
 */
export async function up(knex) {
  // ── 1. Add computed `name` column to employees so all repos can JOIN e.name ──
  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS name TEXT
      GENERATED ALWAYS AS (TRIM(CONCAT(first_name, ' ', COALESCE(last_name, '')))) STORED
  `);

  // ── 2. Performance module ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS performance_goals (
      id               SERIAL PRIMARY KEY,
      employee_id      INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      review_period    VARCHAR(50),
      goal_title       VARCHAR(300) NOT NULL,
      goal_description TEXT,
      target_value     NUMERIC(12,2),
      achieved_value   NUMERIC(12,2) DEFAULT 0,
      weightage        NUMERIC(5,2) DEFAULT 100,
      status           VARCHAR(20) DEFAULT 'active',
      progress_pct     NUMERIC(5,2) DEFAULT 0,
      due_date         DATE,
      deleted_at       TIMESTAMP,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS review_cycles (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(200) NOT NULL,
      period      VARCHAR(50),
      start_date  DATE,
      end_date    DATE,
      status      VARCHAR(20) DEFAULT 'active',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS performance_reviews (
      id                SERIAL PRIMARY KEY,
      employee_id       INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      reviewer_id       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      review_cycle_id   INTEGER REFERENCES review_cycles(id) ON DELETE SET NULL,
      review_period     VARCHAR(50),
      status            VARCHAR(20) DEFAULT 'pending',
      overall_rating    NUMERIC(3,1),
      self_rating       NUMERIC(3,1),
      manager_rating    NUMERIC(3,1),
      comments          TEXT,
      self_comments     TEXT,
      goals_achieved    NUMERIC(5,2),
      kra_score         NUMERIC(5,2),
      behavioral_score  NUMERIC(5,2),
      deleted_at        TIMESTAMP,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 3. Recruitment module ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS job_requisitions (
      id                          SERIAL PRIMARY KEY,
      job_title                   VARCHAR(200) NOT NULL,
      department                  VARCHAR(100),
      employment_type             VARCHAR(50),
      number_of_positions         INTEGER DEFAULT 1,
      job_description             TEXT,
      skills_required             TEXT,
      experience_required         VARCHAR(100),
      location                    VARCHAR(200),
      salary_range                VARCHAR(100),
      requested_by                INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      status                      VARCHAR(30) DEFAULT 'draft',
      deleted_at                  TIMESTAMP,
      created_at                  TIMESTAMPTZ DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS job_openings (
      id                SERIAL PRIMARY KEY,
      requisition_id    INTEGER REFERENCES job_requisitions(id) ON DELETE SET NULL,
      job_title         VARCHAR(200) NOT NULL,
      department        VARCHAR(100),
      location          VARCHAR(200),
      employment_type   VARCHAR(50),
      experience_min    INTEGER DEFAULT 0,
      experience_max    INTEGER,
      salary_min        NUMERIC(12,2),
      salary_max        NUMERIC(12,2),
      description       TEXT,
      requirements      TEXT,
      benefits          TEXT,
      status            VARCHAR(20) DEFAULT 'open',
      posted_date       DATE DEFAULT CURRENT_DATE,
      closing_date      DATE,
      deleted_at        TIMESTAMP,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id                SERIAL PRIMARY KEY,
      opening_id        INTEGER REFERENCES job_openings(id) ON DELETE SET NULL,
      first_name        VARCHAR(100) NOT NULL,
      last_name         VARCHAR(100),
      email             VARCHAR(255),
      phone             VARCHAR(30),
      resume_url        TEXT,
      experience_years  NUMERIC(4,1),
      current_company   VARCHAR(200),
      candidate_role    VARCHAR(200),
      current_salary    NUMERIC(12,2),
      expected_salary   NUMERIC(12,2),
      location          VARCHAR(200),
      source            VARCHAR(50),
      stage             VARCHAR(50) DEFAULT 'applied',
      status            VARCHAR(30) DEFAULT 'active',
      notes             TEXT,
      deleted_at        TIMESTAMP,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 4. Attendance module ────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id                    SERIAL PRIMARY KEY,
      employee_id           INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      attendance_date       DATE NOT NULL,
      check_in_time         TIME,
      check_out_time        TIME,
      total_hours           NUMERIC(5,2),
      status                VARCHAR(20) DEFAULT 'present',
      late_minutes          INTEGER DEFAULT 0,
      early_leave_minutes   INTEGER DEFAULT 0,
      remarks               TEXT,
      deleted_at            TIMESTAMP,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(employee_id, attendance_date)
    );
  `);

  // ── 5. Timesheet module ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS timesheet_entries (
      id            SERIAL PRIMARY KEY,
      employee_id   INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      project_id    INTEGER,
      task_id       INTEGER,
      work_date     DATE NOT NULL,
      hours_worked  NUMERIC(5,2) NOT NULL DEFAULT 0,
      description   TEXT,
      is_billable   BOOLEAN DEFAULT true,
      status        VARCHAR(20) DEFAULT 'submitted',
      approved_by   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      deleted_at    TIMESTAMP,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 6. Org chart module ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS org_relationships (
      id              SERIAL PRIMARY KEY,
      employee_id     INTEGER REFERENCES employees(id) ON DELETE CASCADE UNIQUE,
      manager_id      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      department      VARCHAR(100),
      position_level  INTEGER DEFAULT 1,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 7. Documents module ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS document_templates (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(300) NOT NULL,
      description TEXT,
      category    VARCHAR(100),
      content     TEXT,
      variables   JSONB DEFAULT '[]',
      created_by  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      is_active   BOOLEAN DEFAULT true,
      deleted_at  TIMESTAMP,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS generated_documents (
      id            SERIAL PRIMARY KEY,
      template_id   INTEGER REFERENCES document_templates(id) ON DELETE SET NULL,
      employee_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      name          VARCHAR(300),
      content       TEXT,
      status        VARCHAR(20) DEFAULT 'draft',
      generated_by  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      file_url      TEXT,
      deleted_at    TIMESTAMP,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 8. Reports module ───────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS saved_reports (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(300) NOT NULL,
      report_type VARCHAR(100),
      filters     JSONB DEFAULT '{}',
      columns     JSONB DEFAULT '[]',
      created_by  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      is_shared   BOOLEAN DEFAULT false,
      last_run    TIMESTAMPTZ,
      deleted_at  TIMESTAMP,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 9. Marketing module ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id              SERIAL PRIMARY KEY,
      campaign_name   VARCHAR(300) NOT NULL,
      description     TEXT,
      campaign_type   VARCHAR(50),
      status          VARCHAR(20) DEFAULT 'draft',
      start_date      DATE,
      end_date        DATE,
      budget          NUMERIC(12,2) DEFAULT 0,
      spent           NUMERIC(12,2) DEFAULT 0,
      target_audience TEXT,
      channel         VARCHAR(50),
      leads_generated INTEGER DEFAULT 0,
      created_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      deleted_at      TIMESTAMP,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 10. Procurement module tables (match repository column names) ──────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS purchase_requests (
      id                          SERIAL PRIMARY KEY,
      request_number              VARCHAR(50) UNIQUE,
      requested_by_employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      department_id               INTEGER,
      request_date                DATE DEFAULT CURRENT_DATE,
      required_date               DATE,
      status                      VARCHAR(30) DEFAULT 'pending',
      total_amount                NUMERIC(14,2) DEFAULT 0,
      notes                       TEXT,
      deleted_at                  TIMESTAMP,
      created_at                  TIMESTAMPTZ DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS purchase_request_items (
      id              SERIAL PRIMARY KEY,
      pr_id           INTEGER REFERENCES purchase_requests(id) ON DELETE CASCADE,
      item_id         INTEGER,
      item_name       VARCHAR(300),
      quantity        NUMERIC(12,2) NOT NULL DEFAULT 1,
      expected_price  NUMERIC(12,2) DEFAULT 0,
      required_date   DATE,
      remarks         TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id                      SERIAL PRIMARY KEY,
      po_number               VARCHAR(50) UNIQUE,
      pr_id                   INTEGER REFERENCES purchase_requests(id) ON DELETE SET NULL,
      supplier_id             INTEGER,
      order_date              DATE DEFAULT CURRENT_DATE,
      expected_delivery_date  DATE,
      status                  VARCHAR(30) DEFAULT 'draft',
      subtotal                NUMERIC(14,2) DEFAULT 0,
      tax_amount              NUMERIC(14,2) DEFAULT 0,
      total_amount            NUMERIC(14,2) DEFAULT 0,
      terms_conditions        TEXT,
      notes                   TEXT,
      created_by              INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      deleted_at              TIMESTAMP,
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      updated_at              TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id              SERIAL PRIMARY KEY,
      po_id           INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
      item_id         INTEGER,
      quantity        NUMERIC(12,2) NOT NULL DEFAULT 1,
      rate            NUMERIC(12,2) DEFAULT 0,
      tax_rate        NUMERIC(5,2) DEFAULT 0,
      tax_amount      NUMERIC(12,2) DEFAULT 0,
      total_amount    NUMERIC(14,2) DEFAULT 0,
      received_qty    NUMERIC(12,2) DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id              SERIAL PRIMARY KEY,
      warehouse_name  VARCHAR(200) NOT NULL,
      warehouse_code  VARCHAR(50) UNIQUE,
      location        VARCHAR(300),
      manager_id      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      capacity        INTEGER,
      status          VARCHAR(20) DEFAULT 'active',
      deleted_at      TIMESTAMP,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS goods_receipt_notes (
      id              SERIAL PRIMARY KEY,
      grn_number      VARCHAR(50) UNIQUE,
      po_id           INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
      received_by     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      received_date   DATE DEFAULT CURRENT_DATE,
      warehouse_id    INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      status          VARCHAR(20) DEFAULT 'draft',
      notes           TEXT,
      deleted_at      TIMESTAMP,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS grn_items (
      id                  SERIAL PRIMARY KEY,
      grn_id              INTEGER REFERENCES goods_receipt_notes(id) ON DELETE CASCADE,
      po_item_id          INTEGER,
      item_id             INTEGER,
      quantity_received   NUMERIC(12,2) DEFAULT 0,
      quantity_rejected   NUMERIC(12,2) DEFAULT 0,
      rate                NUMERIC(12,2) DEFAULT 0,
      remarks             TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 10b. Finance extra tables ──────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id                SERIAL PRIMARY KEY,
      account_name      VARCHAR(200) NOT NULL,
      account_number    VARCHAR(50),
      bank_name         VARCHAR(200),
      branch            VARCHAR(200),
      ifsc_code         VARCHAR(20),
      account_type      VARCHAR(50) DEFAULT 'current',
      currency          VARCHAR(10) DEFAULT 'INR',
      opening_balance   NUMERIC(14,2) DEFAULT 0,
      current_balance   NUMERIC(14,2) DEFAULT 0,
      chart_account_id  INTEGER,
      is_active         BOOLEAN DEFAULT true,
      deleted_at        TIMESTAMP,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 11. Inventory extra tables ──────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id              SERIAL PRIMARY KEY,
      item_id         INTEGER,
      warehouse_id    INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      movement_type   VARCHAR(30),
      quantity        NUMERIC(12,2) NOT NULL,
      reference_type  VARCHAR(50),
      reference_id    INTEGER,
      notes           TEXT,
      created_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 12. Security / IP whitelist ─────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS security_events (
      id          SERIAL PRIMARY KEY,
      event_type  VARCHAR(100),
      severity    VARCHAR(20) DEFAULT 'info',
      user_id     INTEGER,
      ip_address  VARCHAR(50),
      path        VARCHAR(500),
      details     JSONB DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ip_whitelist (
      id          SERIAL PRIMARY KEY,
      ip_address  VARCHAR(50) UNIQUE NOT NULL,
      label       VARCHAR(200),
      active      BOOLEAN DEFAULT true,
      added_by    INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS active_sessions (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER,
      token_hash  VARCHAR(255),
      ip_address  VARCHAR(50),
      user_agent  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ
    );
  `);

  // ── 13. Approvals table ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id              SERIAL PRIMARY KEY,
      request_type    VARCHAR(100) NOT NULL,
      reference_id    INTEGER,
      reference_type  VARCHAR(100),
      title           VARCHAR(300),
      description     TEXT,
      requested_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      approver_id     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      status          VARCHAR(20) DEFAULT 'pending',
      approved_at     TIMESTAMPTZ,
      rejected_at     TIMESTAMPTZ,
      comments        TEXT,
      priority        VARCHAR(20) DEFAULT 'normal',
      due_date        DATE,
      deleted_at      TIMESTAMP,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── 14. Payroll extra tables ────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id              SERIAL PRIMARY KEY,
      period_label    VARCHAR(50),
      period_start    DATE,
      period_end      DATE,
      status          VARCHAR(20) DEFAULT 'draft',
      total_gross     NUMERIC(14,2) DEFAULT 0,
      total_deductions NUMERIC(14,2) DEFAULT 0,
      total_net       NUMERIC(14,2) DEFAULT 0,
      employee_count  INTEGER DEFAULT 0,
      processed_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      processed_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payslips (
      id              SERIAL PRIMARY KEY,
      payroll_run_id  INTEGER REFERENCES payroll_runs(id) ON DELETE CASCADE,
      employee_id     INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      gross_salary    NUMERIC(14,2) DEFAULT 0,
      total_deductions NUMERIC(14,2) DEFAULT 0,
      net_salary      NUMERIC(14,2) DEFAULT 0,
      components      JSONB DEFAULT '{}',
      status          VARCHAR(20) DEFAULT 'generated',
      emailed_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(payroll_run_id, employee_id)
    );
  `);
}

export async function down(knex) {
  // Intentionally empty — dropping these tables in production is too destructive
}
