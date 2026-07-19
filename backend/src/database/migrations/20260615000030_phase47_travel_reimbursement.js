/**
 * Phase 47 — Travel & Reimbursement Management
 *
 * New tables:
 *   1. travel_policy_rules   — per grade/role/dept expense limits
 *   2. visit_reports         — formal customer/site visit reports
 *   3. expense_claims        — full reimbursement workflow (5 levels)
 *   4. expense_claim_approvals — multi-level approval audit trail
 *   5. travel_cost_transactions — approved expense → project cost posting
 *
 * Alter travel_requests:
 *   — travel_type, site_id, sales_order_id, service_ticket_id
 */
export async function up(knex) {
  const raw = sql => knex.raw(sql);

  // ── 1. Enhance travel_requests ───────────────────────────────────────────────
  await raw(`ALTER TABLE travel_requests
    ADD COLUMN IF NOT EXISTS travel_type        VARCHAR(100),
    ADD COLUMN IF NOT EXISTS site_id            INTEGER,
    ADD COLUMN IF NOT EXISTS sales_order_id     INTEGER,
    ADD COLUMN IF NOT EXISTS service_ticket_id  INTEGER
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tr_travel_type      ON travel_requests(travel_type)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tr_service_ticket   ON travel_requests(service_ticket_id)`);

  // ── 2. travel_policy_rules ───────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS travel_policy_rules (
      id                     SERIAL PRIMARY KEY,
      rule_name              VARCHAR(200) NOT NULL,
      rule_type              VARCHAR(50)  NOT NULL DEFAULT 'grade',
      grade                  VARCHAR(100),
      role                   VARCHAR(100),
      department             VARCHAR(100),
      hotel_limit_per_day    NUMERIC(10,2) DEFAULT 0,
      meal_limit_per_day     NUMERIC(10,2) DEFAULT 0,
      travel_daily_allowance NUMERIC(10,2) DEFAULT 0,
      flight_eligible        BOOLEAN DEFAULT FALSE,
      train_class            VARCHAR(50)  DEFAULT 'Sleeper',
      local_conveyance_limit NUMERIC(10,2) DEFAULT 0,
      miscellaneous_limit    NUMERIC(10,2) DEFAULT 0,
      max_advance_amount     NUMERIC(10,2) DEFAULT 0,
      effective_from         DATE,
      effective_to           DATE,
      is_active              BOOLEAN DEFAULT TRUE,
      company_id             INTEGER,
      created_by             INTEGER,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tpr_company_id ON travel_policy_rules(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tpr_active     ON travel_policy_rules(is_active)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tpr_rule_type  ON travel_policy_rules(rule_type)`);

  // ── 3. visit_reports ─────────────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS visit_reports (
      id                   SERIAL PRIMARY KEY,
      report_number        VARCHAR(100) UNIQUE,
      travel_request_id    INTEGER,
      visit_type           VARCHAR(100),
      customer_id          INTEGER,
      customer_name        VARCHAR(200),
      project_id           INTEGER,
      project_number       VARCHAR(100),
      site_id              INTEGER,
      site_name            VARCHAR(200),
      opportunity_id       INTEGER,
      opportunity_ref      VARCHAR(100),
      service_ticket_id    INTEGER,
      visited_by           INTEGER NOT NULL,
      visit_date           DATE NOT NULL,
      purpose              TEXT,
      discussion_summary   TEXT,
      action_items         JSONB DEFAULT '[]'::jsonb,
      next_followup        DATE,
      next_followup_notes  TEXT,
      attachments          JSONB DEFAULT '[]'::jsonb,
      photos               JSONB DEFAULT '[]'::jsonb,
      gps_lat              NUMERIC(10,7),
      gps_lng              NUMERIC(10,7),
      location             VARCHAR(300),
      outcome              VARCHAR(200),
      status               VARCHAR(50) DEFAULT 'Draft',
      company_id           INTEGER,
      created_by           INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS customer_id INTEGER`);
  await raw(`ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS project_id INTEGER`);
  await raw(`ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS visited_by INTEGER`);
  await raw(`ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS visit_date DATE`);
  await raw(`ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await raw(`ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS travel_request_id INTEGER`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vr_customer_id    ON visit_reports(customer_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vr_project_id     ON visit_reports(project_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vr_visited_by     ON visit_reports(visited_by)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vr_visit_date     ON visit_reports(visit_date)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vr_company_id     ON visit_reports(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vr_travel_req     ON visit_reports(travel_request_id)`);

  // ── 4. expense_claims ────────────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS expense_claims (
      id                   SERIAL PRIMARY KEY,
      claim_number         VARCHAR(100) UNIQUE,
      travel_request_id    INTEGER,
      employee_id          INTEGER NOT NULL,
      employee_name        VARCHAR(200),
      department           VARCHAR(100),
      customer_id          INTEGER,
      customer_name        VARCHAR(200),
      project_id           INTEGER,
      project_number       VARCHAR(100),
      site_id              INTEGER,
      site_name            VARCHAR(200),
      opportunity_id       INTEGER,
      po_number            VARCHAR(100),
      cost_centre_id       INTEGER,
      expense_date         DATE,
      expense_type         VARCHAR(100),
      expense_category     VARCHAR(200),
      amount               NUMERIC(12,2) DEFAULT 0,
      gst_amount           NUMERIC(12,2) DEFAULT 0,
      total_amount         NUMERIC(12,2) DEFAULT 0,
      remarks              TEXT,
      bill_number          VARCHAR(100),
      bill_attachment      TEXT,
      google_drive_link    TEXT,
      vendor_name          VARCHAR(200),
      policy_limit         NUMERIC(12,2),
      over_policy          BOOLEAN DEFAULT FALSE,
      over_policy_reason   TEXT,
      cost_type            VARCHAR(100),
      gst_verified         BOOLEAN DEFAULT FALSE,
      bill_match_verified  BOOLEAN DEFAULT FALSE,
      duplicate_checked    BOOLEAN DEFAULT FALSE,
      policy_compliant     BOOLEAN DEFAULT TRUE,
      accounts_remarks     TEXT,
      status               VARCHAR(50) DEFAULT 'Draft',
      submitted_at         TIMESTAMPTZ,
      manager_approved_by  INTEGER,
      manager_approved_at  TIMESTAMPTZ,
      manager_remarks      TEXT,
      accounts_verified_by INTEGER,
      accounts_verified_at TIMESTAMPTZ,
      mgmt_approved_by     INTEGER,
      mgmt_approved_at     TIMESTAMPTZ,
      mgmt_remarks         TEXT,
      payment_date         DATE,
      payment_ref          VARCHAR(100),
      payment_mode         VARCHAR(50),
      paid_by              INTEGER,
      paid_at              TIMESTAMPTZ,
      company_id           INTEGER,
      created_by           INTEGER,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS project_id INTEGER`);
  await raw(`ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS customer_id INTEGER`);
  await raw(`ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Draft'`);
  await raw(`ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await raw(`ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS travel_request_id INTEGER`);
  await raw(`ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS expense_date DATE`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_ec_employee_id  ON expense_claims(employee_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_ec_project_id   ON expense_claims(project_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_ec_customer_id  ON expense_claims(customer_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_ec_status       ON expense_claims(status)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_ec_company_id   ON expense_claims(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_ec_travel_req   ON expense_claims(travel_request_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_ec_expense_date ON expense_claims(expense_date)`);

  // ── 5. expense_claim_approvals ───────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS expense_claim_approvals (
      id           SERIAL PRIMARY KEY,
      claim_id     INTEGER NOT NULL,
      level        SMALLINT NOT NULL,
      level_name   VARCHAR(100) NOT NULL,
      approver_id  INTEGER,
      status       VARCHAR(50) DEFAULT 'Pending',
      remarks      TEXT,
      actioned_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_eca_claim_id ON expense_claim_approvals(claim_id)`);

  // ── 6. travel_cost_transactions ──────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS travel_cost_transactions (
      id               SERIAL PRIMARY KEY,
      source_type      VARCHAR(50) DEFAULT 'expense_claim',
      source_id        INTEGER,
      cost_type        VARCHAR(100),
      customer_id      INTEGER,
      customer_name    VARCHAR(200),
      project_id       INTEGER,
      project_number   VARCHAR(100),
      site_name        VARCHAR(200),
      employee_id      INTEGER,
      employee_name    VARCHAR(200),
      travel_type      VARCHAR(100),
      amount           NUMERIC(12,2) DEFAULT 0,
      gst_amount       NUMERIC(12,2) DEFAULT 0,
      transaction_date DATE,
      posted_by        INTEGER,
      posted_at        TIMESTAMPTZ DEFAULT NOW(),
      company_id       INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`ALTER TABLE travel_cost_transactions ADD COLUMN IF NOT EXISTS project_id INTEGER`);
  await raw(`ALTER TABLE travel_cost_transactions ADD COLUMN IF NOT EXISTS customer_id INTEGER`);
  await raw(`ALTER TABLE travel_cost_transactions ADD COLUMN IF NOT EXISTS cost_type VARCHAR(100)`);
  await raw(`ALTER TABLE travel_cost_transactions ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await raw(`ALTER TABLE travel_cost_transactions ADD COLUMN IF NOT EXISTS transaction_date DATE`);
  await raw(`ALTER TABLE travel_cost_transactions ADD COLUMN IF NOT EXISTS employee_id INTEGER`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tct_project_id       ON travel_cost_transactions(project_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tct_customer_id      ON travel_cost_transactions(customer_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tct_cost_type        ON travel_cost_transactions(cost_type)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tct_company_id       ON travel_cost_transactions(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tct_transaction_date ON travel_cost_transactions(transaction_date)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tct_employee_id      ON travel_cost_transactions(employee_id)`);

  // ── Seed default policy rules ────────────────────────────────────────────────
  await raw(`
    INSERT INTO travel_policy_rules (rule_name, rule_type, grade, hotel_limit_per_day, meal_limit_per_day, travel_daily_allowance, flight_eligible, train_class, local_conveyance_limit, miscellaneous_limit, max_advance_amount, is_active)
    VALUES
      ('Junior Engineer Policy',    'grade', 'L1', 2000,  400, 300, FALSE, 'Sleeper', 500,  300, 10000, TRUE),
      ('Sales Engineer Policy',     'grade', 'L2', 3000,  500, 400, FALSE, 'AC-3',    800,  500, 15000, TRUE),
      ('Senior Engineer Policy',    'grade', 'L3', 3500,  600, 500, TRUE,  'AC-2',    1000, 750, 20000, TRUE),
      ('Manager Policy',            'grade', 'L4', 5000,  800, 600, TRUE,  'AC-1',    1500, 1000,30000, TRUE),
      ('Senior Manager Policy',     'grade', 'L5', 7000,  1000,750, TRUE,  'AC-1',    2000, 1500,50000, TRUE),
      ('Director / VP Policy',      'grade', 'L6', 0,     0,   0,   TRUE,  'Business',0,    0,   100000,TRUE)
    ON CONFLICT DO NOTHING
  `);
}

export async function down(knex) {
  const raw = sql => knex.raw(sql);
  await raw(`DROP TABLE IF EXISTS travel_cost_transactions`);
  await raw(`DROP TABLE IF EXISTS expense_claim_approvals`);
  await raw(`DROP TABLE IF EXISTS expense_claims`);
  await raw(`DROP TABLE IF EXISTS visit_reports`);
  await raw(`DROP TABLE IF EXISTS travel_policy_rules`);
}
