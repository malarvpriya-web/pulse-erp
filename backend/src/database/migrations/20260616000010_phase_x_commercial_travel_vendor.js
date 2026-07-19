/**
 * Phase X — Commercial, Travel & Vendor Ecosystem
 *
 * 1.  travel_requests: customer/project/site/opportunity/PO/project-number fields
 * 2.  travel_request_approvals: multi-level approval tracking
 * 3.  travel_expense_items: GST amount, Google Drive link, bill upload, category expansion
 * 4.  customer_visits table (site/customer/service/commissioning visits)
 * 5.  customer_visit_action_items table
 * 6.  vendor_registrations: self-registration portal with approval workflow
 * 7.  vendor_scorecards: quarterly scorecard with 6 dimensions
 * 8.  project_cost_lines: every cost linked to customer/project/PO/site/cost_centre
 * 9.  sales_targets: team + regional target columns
 * 10. sales_funnel_snapshots: monthly funnel stage counts for conversion analytics
 * 11. CEO dashboard perf indexes
 */
export async function up(knex) {
  const raw = sql => knex.raw(sql);

  // ── 1. travel_requests: commercial fields ────────────────────────────────────
  await raw(`ALTER TABLE travel_requests
    ADD COLUMN IF NOT EXISTS customer_id       INTEGER,
    ADD COLUMN IF NOT EXISTS customer_name     VARCHAR(200),
    ADD COLUMN IF NOT EXISTS project_id        INTEGER,
    ADD COLUMN IF NOT EXISTS project_number    VARCHAR(100),
    ADD COLUMN IF NOT EXISTS site_name         VARCHAR(200),
    ADD COLUMN IF NOT EXISTS opportunity_id    INTEGER,
    ADD COLUMN IF NOT EXISTS opportunity_ref   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS po_number         VARCHAR(100),
    ADD COLUMN IF NOT EXISTS approval_level    SMALLINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS approved_by_rm    INTEGER,
    ADD COLUMN IF NOT EXISTS approved_by_dh    INTEGER,
    ADD COLUMN IF NOT EXISTS approved_by_mgmt  INTEGER,
    ADD COLUMN IF NOT EXISTS finance_posted    BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS payment_date      DATE,
    ADD COLUMN IF NOT EXISTS payment_ref       VARCHAR(100),
    ADD COLUMN IF NOT EXISTS company_id        INTEGER
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tr_customer_id   ON travel_requests(customer_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tr_project_id    ON travel_requests(project_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tr_company_id    ON travel_requests(company_id)`);

  // ── 2. travel_request_approvals ─────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS travel_request_approvals (
      id               SERIAL PRIMARY KEY,
      travel_request_id INTEGER NOT NULL,
      level            SMALLINT NOT NULL,
      level_name       VARCHAR(100) NOT NULL,
      approver_id      INTEGER,
      status           VARCHAR(50) DEFAULT 'Pending',
      remarks          TEXT,
      actioned_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tra_request_id ON travel_request_approvals(travel_request_id)`);

  // ── 3. travel_expense_items: commercial + GST + Drive link ───────────────────
  await raw(`ALTER TABLE travel_expense_items
    ADD COLUMN IF NOT EXISTS customer_id      INTEGER,
    ADD COLUMN IF NOT EXISTS customer_name    VARCHAR(200),
    ADD COLUMN IF NOT EXISTS project_id       INTEGER,
    ADD COLUMN IF NOT EXISTS project_number   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS site_name        VARCHAR(200),
    ADD COLUMN IF NOT EXISTS opportunity_id   INTEGER,
    ADD COLUMN IF NOT EXISTS po_number        VARCHAR(100),
    ADD COLUMN IF NOT EXISTS gst_amount       NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_amount     NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS bill_upload_path TEXT,
    ADD COLUMN IF NOT EXISTS google_drive_link TEXT,
    ADD COLUMN IF NOT EXISTS reimbursement_status VARCHAR(50) DEFAULT 'Pending',
    ADD COLUMN IF NOT EXISTS company_id       INTEGER
  `);

  // ── 4. customer_visits ───────────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS customer_visits (
      id               SERIAL PRIMARY KEY,
      visit_type       VARCHAR(100) DEFAULT 'Customer Visit',
      customer_id      INTEGER,
      customer_name    VARCHAR(200),
      project_id       INTEGER,
      project_number   VARCHAR(100),
      site_name        VARCHAR(200),
      opportunity_id   INTEGER,
      opportunity_ref  VARCHAR(100),
      visited_by       INTEGER NOT NULL,
      visit_date       DATE NOT NULL,
      purpose          TEXT,
      discussion_notes TEXT,
      location         VARCHAR(300),
      gps_lat          NUMERIC(10,7),
      gps_lng          NUMERIC(10,7),
      photos_drive_link TEXT,
      visit_report     TEXT,
      next_followup_date DATE,
      next_followup_notes TEXT,
      status           VARCHAR(50) DEFAULT 'Draft',
      company_id       INTEGER,
      created_by       INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_cv_customer_id  ON customer_visits(customer_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_cv_project_id   ON customer_visits(project_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_cv_visited_by   ON customer_visits(visited_by)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_cv_visit_date   ON customer_visits(visit_date)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_cv_company_id   ON customer_visits(company_id)`);

  // ── 5. customer_visit_action_items ──────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS customer_visit_action_items (
      id               SERIAL PRIMARY KEY,
      visit_id         INTEGER NOT NULL REFERENCES customer_visits(id) ON DELETE CASCADE,
      action           TEXT NOT NULL,
      owner            VARCHAR(200),
      due_date         DATE,
      status           VARCHAR(50) DEFAULT 'Open',
      completed_at     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_cvai_visit_id ON customer_visit_action_items(visit_id)`);

  // ── 6. vendor_registrations (self-service portal) ───────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_registrations (
      id                SERIAL PRIMARY KEY,
      vendor_name       VARCHAR(200) NOT NULL,
      vendor_type       VARCHAR(100),
      products_services TEXT,
      gstin             VARCHAR(20),
      pan               VARCHAR(12),
      msme_status       BOOLEAN DEFAULT FALSE,
      udyam_number      VARCHAR(50),
      bank_name         VARCHAR(150),
      account_number    VARCHAR(30),
      ifsc              VARCHAR(15),
      address           TEXT,
      city              VARCHAR(100),
      state             VARCHAR(100),
      pincode           VARCHAR(10),
      contact_person    VARCHAR(200),
      email             VARCHAR(200),
      phone             VARCHAR(20),
      website           VARCHAR(300),
      iso_certificates  TEXT,
      quality_docs_link TEXT,
      nda_signed        BOOLEAN DEFAULT FALSE,
      technical_capability TEXT,
      annual_turnover   NUMERIC(15,2),
      num_employees     INTEGER,
      year_established  INTEGER,
      status            VARCHAR(50) DEFAULT 'Submitted',
      scm_reviewed_by   INTEGER,
      scm_reviewed_at   TIMESTAMPTZ,
      scm_remarks       TEXT,
      quality_reviewed_by   INTEGER,
      quality_reviewed_at   TIMESTAMPTZ,
      quality_remarks   TEXT,
      finance_reviewed_by   INTEGER,
      finance_reviewed_at   TIMESTAMPTZ,
      finance_remarks   TEXT,
      mgmt_approved_by  INTEGER,
      mgmt_approved_at  TIMESTAMPTZ,
      mgmt_remarks      TEXT,
      vendor_id         INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      company_id        INTEGER,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vr_status     ON vendor_registrations(status)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vr_company_id ON vendor_registrations(company_id)`);

  // ── 7. vendor_scorecards ─────────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_scorecards (
      id               SERIAL PRIMARY KEY,
      vendor_id        INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      period_year      SMALLINT NOT NULL,
      period_quarter   SMALLINT NOT NULL,
      quality_score    NUMERIC(5,2) DEFAULT 0,
      delivery_score   NUMERIC(5,2) DEFAULT 0,
      cost_score       NUMERIC(5,2) DEFAULT 0,
      support_score    NUMERIC(5,2) DEFAULT 0,
      compliance_score NUMERIC(5,2) DEFAULT 0,
      documentation_score NUMERIC(5,2) DEFAULT 0,
      overall_score    NUMERIC(5,2) DEFAULT 0,
      risk_rating      VARCHAR(20) DEFAULT 'Medium',
      remarks          TEXT,
      evaluated_by     INTEGER,
      company_id       INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (vendor_id, period_year, period_quarter)
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vs_vendor_id  ON vendor_scorecards(vendor_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vs_company_id ON vendor_scorecards(company_id)`);

  // ── 8. project_cost_lines (every cost linked to business dimensions) ─────────
  await raw(`
    CREATE TABLE IF NOT EXISTS project_cost_lines (
      id               SERIAL PRIMARY KEY,
      cost_type        VARCHAR(100) NOT NULL,
      description      TEXT,
      customer_id      INTEGER,
      customer_name    VARCHAR(200),
      project_id       INTEGER,
      project_number   VARCHAR(100),
      po_number        VARCHAR(100),
      site_name        VARCHAR(200),
      cost_centre_id   INTEGER,
      amount           NUMERIC(15,2) NOT NULL DEFAULT 0,
      currency         VARCHAR(10) DEFAULT 'INR',
      cost_date        DATE,
      reference_type   VARCHAR(100),
      reference_id     INTEGER,
      approved_by      INTEGER,
      company_id       INTEGER,
      created_by       INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_pcl_project_id    ON project_cost_lines(project_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_pcl_customer_id   ON project_cost_lines(customer_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_pcl_cost_type     ON project_cost_lines(cost_type)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_pcl_company_id    ON project_cost_lines(company_id)`);

  // ── 9. sales_targets: add team/regional columns ──────────────────────────────
  await raw(`ALTER TABLE sales_targets
    ADD COLUMN IF NOT EXISTS target_type   VARCHAR(50) DEFAULT 'individual',
    ADD COLUMN IF NOT EXISTS team_name     VARCHAR(200),
    ADD COLUMN IF NOT EXISTS region        VARCHAR(200),
    ADD COLUMN IF NOT EXISTS enquiry_target   NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lead_target      NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS order_target     NUMERIC(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS commission_rate  NUMERIC(5,2)  DEFAULT 0,
    ADD COLUMN IF NOT EXISTS commission_earned NUMERIC(15,2) DEFAULT 0
  `);

  // ── 10. sales_funnel_snapshots (monthly conversion analytics) ────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS sales_funnel_snapshots (
      id              SERIAL PRIMARY KEY,
      snapshot_month  DATE NOT NULL,
      salesperson_id  INTEGER,
      enquiries       INTEGER DEFAULT 0,
      leads           INTEGER DEFAULT 0,
      opportunities   INTEGER DEFAULT 0,
      quotations      INTEGER DEFAULT 0,
      orders          INTEGER DEFAULT 0,
      revenue         NUMERIC(15,2) DEFAULT 0,
      company_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (snapshot_month, salesperson_id, company_id)
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_sfs_month      ON sales_funnel_snapshots(snapshot_month)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_sfs_company_id ON sales_funnel_snapshots(company_id)`);
}

export async function down(knex) {
  const raw = sql => knex.raw(sql);
  await raw(`DROP TABLE IF EXISTS sales_funnel_snapshots`);
  await raw(`DROP TABLE IF EXISTS project_cost_lines`);
  await raw(`DROP TABLE IF EXISTS vendor_scorecards`);
  await raw(`DROP TABLE IF EXISTS vendor_registrations`);
  await raw(`DROP TABLE IF EXISTS customer_visit_action_items`);
  await raw(`DROP TABLE IF EXISTS customer_visits`);
  await raw(`DROP TABLE IF EXISTS travel_request_approvals`);
}
