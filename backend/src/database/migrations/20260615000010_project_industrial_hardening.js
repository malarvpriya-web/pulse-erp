/**
 * Project Module Industrial Hardening Migration
 * Fixes: project_risks formal table, project_cost_summary formal table,
 *        timesheet project_id FK, project_issues table, FAT tracker,
 *        SAT tracker, warranty table, project_members consolidation,
 *        tasks table Gantt columns, project columns reconciliation.
 */
export async function up(knex) {
  // ── 1. Reconcile projects table columns ──────────────────────────────────────
  await knex.raw(`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type        VARCHAR(50)    DEFAULT 'EPC';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS billing_type        VARCHAR(30)    DEFAULT 'fixed';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS priority            VARCHAR(20)    DEFAULT 'medium';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS color               VARCHAR(20)    DEFAULT '#6366f1';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS progress_percentage NUMERIC(5,2)   DEFAULT 0;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget              NUMERIC(15,2)  DEFAULT 0;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_amount       NUMERIC(15,2)  DEFAULT 0;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_name         VARCHAR(255);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS customer_name       VARCHAR(255);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS manager_name        VARCHAR(255);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_manager_id  INTEGER;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS department_id       INTEGER;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS sales_order_ref     VARCHAR(100);
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS actual_cost         NUMERIC(15,2)  DEFAULT 0;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_spent        NUMERIC(15,2)  DEFAULT 0;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS wbs_structure       JSONB          DEFAULT '[]';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS warranty_end_date   DATE;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS warranty_months     INTEGER        DEFAULT 12;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS lessons_learned     TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS baseline_start_date DATE;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS baseline_end_date   DATE;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS baseline_budget     NUMERIC(15,2)  DEFAULT 0;
  `);

  // ── 2. Gantt columns to tasks table ─────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date      DATE;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS end_date        DATE;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress        INTEGER       DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dependencies    INTEGER[]     DEFAULT '{}';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_milestone    BOOLEAN       DEFAULT FALSE;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS color           VARCHAR(20);
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type       VARCHAR(30)   DEFAULT 'task';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id  INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS wbs_level       INTEGER       DEFAULT 1;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS wbs_number      VARCHAR(30);
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(8,2)  DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS actual_hours    NUMERIC(8,2)  DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS billable_hours  NUMERIC(8,2)  DEFAULT 0;
  `);

  // ── 3. project_cost_summary (create or add missing EVM columns) ──────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS project_cost_summary (
      id                       SERIAL PRIMARY KEY,
      project_id               INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      labour_cost              NUMERIC(15,2) DEFAULT 0,
      material_cost            NUMERIC(15,2) DEFAULT 0,
      expense_cost             NUMERIC(15,2) DEFAULT 0,
      travel_cost              NUMERIC(15,2) DEFAULT 0,
      manufacturing_cost       NUMERIC(15,2) DEFAULT 0,
      subcontractor_cost       NUMERIC(15,2) DEFAULT 0,
      total_cost               NUMERIC(15,2) DEFAULT 0,
      revenue                  NUMERIC(15,2) DEFAULT 0,
      profit                   NUMERIC(15,2) DEFAULT 0,
      margin_pct               NUMERIC(6,2)  DEFAULT 0,
      planned_value            NUMERIC(15,2) DEFAULT 0,
      earned_value             NUMERIC(15,2) DEFAULT 0,
      actual_cost_evm          NUMERIC(15,2) DEFAULT 0,
      cost_performance_index   NUMERIC(5,3)  DEFAULT 1,
      schedule_performance_index NUMERIC(5,3) DEFAULT 1,
      last_calculated_at       TIMESTAMPTZ   DEFAULT NOW(),
      created_at               TIMESTAMPTZ   DEFAULT NOW(),
      updated_at               TIMESTAMPTZ   DEFAULT NOW()
    );
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS travel_cost              NUMERIC(15,2) DEFAULT 0;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS manufacturing_cost       NUMERIC(15,2) DEFAULT 0;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS subcontractor_cost       NUMERIC(15,2) DEFAULT 0;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS revenue                  NUMERIC(15,2) DEFAULT 0;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS profit                   NUMERIC(15,2) DEFAULT 0;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS margin_pct               NUMERIC(6,2)  DEFAULT 0;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS planned_value            NUMERIC(15,2) DEFAULT 0;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS earned_value             NUMERIC(15,2) DEFAULT 0;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS actual_cost_evm          NUMERIC(15,2) DEFAULT 0;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS cost_performance_index   NUMERIC(5,3)  DEFAULT 1;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS schedule_performance_index NUMERIC(5,3) DEFAULT 1;
    ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS last_calculated_at       TIMESTAMPTZ   DEFAULT NOW();
  `);

  // ── 4. project_risks table ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS project_risks (
      id                SERIAL PRIMARY KEY,
      project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      risk_code         VARCHAR(20),
      title             VARCHAR(300) NOT NULL,
      description       TEXT,
      category          VARCHAR(50)  DEFAULT 'technical',
      probability       VARCHAR(20)  DEFAULT 'medium',
      impact            VARCHAR(20)  DEFAULT 'medium',
      risk_score        INTEGER      DEFAULT 0,
      status            VARCHAR(20)  DEFAULT 'open',
      mitigation_plan   TEXT,
      contingency_plan  TEXT,
      owner_id          INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      review_date       DATE,
      closed_date       DATE,
      created_at        TIMESTAMPTZ  DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_risks_project ON project_risks(project_id);
    ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS company_id       INTEGER;
    ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS risk_code        VARCHAR(20);
    ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS description      TEXT;
    ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS contingency_plan TEXT;
    ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS review_date      DATE;
    ALTER TABLE project_risks ADD COLUMN IF NOT EXISTS closed_date      DATE;
  `);

  // ── 5. project_issues table ──────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS project_issues (
      id              SERIAL PRIMARY KEY,
      project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      company_id      INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      issue_code      VARCHAR(30),
      title           VARCHAR(300) NOT NULL,
      description     TEXT,
      issue_type      VARCHAR(50)  DEFAULT 'general',
      severity        VARCHAR(20)  DEFAULT 'medium',
      priority        VARCHAR(20)  DEFAULT 'medium',
      status          VARCHAR(30)  DEFAULT 'open',
      raised_by       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      assigned_to     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      task_id         INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      due_date        DATE,
      resolved_date   DATE,
      resolution      TEXT,
      root_cause      TEXT,
      is_blocker      BOOLEAN      DEFAULT FALSE,
      ncr_raised      BOOLEAN      DEFAULT FALSE,
      ncr_reference   VARCHAR(50),
      created_at      TIMESTAMPTZ  DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_issues_project ON project_issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_issues_company ON project_issues(company_id);
    CREATE INDEX IF NOT EXISTS idx_project_issues_status  ON project_issues(status);
  `);

  // ── 6. fat_trackers table ────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS fat_trackers (
      id                    SERIAL PRIMARY KEY,
      project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      company_id            INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      production_order_id   INTEGER,
      fat_number            VARCHAR(50),
      serial_number         VARCHAR(100),
      product_name          VARCHAR(255),
      scheduled_date        DATE,
      actual_date           DATE,
      status                VARCHAR(30)  DEFAULT 'scheduled',
      test_location         VARCHAR(255),
      client_witness        VARCHAR(255),
      engineer_name         VARCHAR(255),
      test_parameters       JSONB        DEFAULT '[]',
      punch_points          JSONB        DEFAULT '[]',
      remarks               TEXT,
      failure_description   TEXT,
      retest_date           DATE,
      certificate_number    VARCHAR(100),
      certificate_date      DATE,
      created_by            INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at            TIMESTAMPTZ  DEFAULT NOW(),
      updated_at            TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fat_project        ON fat_trackers(project_id);
    CREATE INDEX IF NOT EXISTS idx_fat_trackers_status ON fat_trackers(status);
  `);

  // ── 7. sat_trackers table ────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sat_trackers (
      id                           SERIAL PRIMARY KEY,
      project_id                   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      company_id                   INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      commissioning_report_id      INTEGER,
      sat_number                   VARCHAR(50),
      serial_number                VARCHAR(100),
      product_name                 VARCHAR(255),
      site_name                    VARCHAR(255),
      site_address                 VARCHAR(500),
      scheduled_date               DATE,
      actual_date                  DATE,
      status                       VARCHAR(30)  DEFAULT 'scheduled',
      client_representative        VARCHAR(255),
      client_witness_designation   VARCHAR(255),
      engineer_name                VARCHAR(255),
      test_parameters              JSONB        DEFAULT '[]',
      punch_points                 JSONB        DEFAULT '[]',
      remarks                      TEXT,
      failure_description          TEXT,
      retest_date                  DATE,
      certificate_number           VARCHAR(100),
      certificate_date             DATE,
      client_signed_off            BOOLEAN      DEFAULT FALSE,
      client_signoff_date          DATE,
      created_by                   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at                   TIMESTAMPTZ  DEFAULT NOW(),
      updated_at                   TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sat_project         ON sat_trackers(project_id);
    CREATE INDEX IF NOT EXISTS idx_sat_trackers_status ON sat_trackers(status);
  `);

  // ── 8. project_warranties table ──────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS project_warranties (
      id                  SERIAL PRIMARY KEY,
      project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      company_id          INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      serial_number       VARCHAR(100),
      product_name        VARCHAR(255),
      commissioning_date  DATE,
      warranty_start_date DATE,
      warranty_end_date   DATE,
      warranty_months     INTEGER     DEFAULT 12,
      warranty_type       VARCHAR(50) DEFAULT 'standard',
      status              VARCHAR(30) DEFAULT 'active',
      warranty_terms      TEXT,
      exclusions          TEXT,
      amc_contract_id     INTEGER,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_warranty_project        ON project_warranties(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_warranties_status ON project_warranties(status);
  `);

  // ── 9. timesheet_entries: project FK + billable_amount ───────────────────────
  await knex.raw(`
    ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL;
    ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS billable_amount  NUMERIC(12,2) DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_timesheet_entries_project ON timesheet_entries(project_id);
  `);

  // ── 10. project_members: billing/cost rates ──────────────────────────────────
  await knex.raw(`
    ALTER TABLE project_members ADD COLUMN IF NOT EXISTS billing_rate     NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE project_members ADD COLUMN IF NOT EXISTS cost_rate        NUMERIC(10,2) DEFAULT 0;
    ALTER TABLE project_members ADD COLUMN IF NOT EXISTS is_billable      BOOLEAN       DEFAULT TRUE;
    ALTER TABLE project_members ADD COLUMN IF NOT EXISTS hours_allocated  NUMERIC(8,2)  DEFAULT 0;
    ALTER TABLE project_members ADD COLUMN IF NOT EXISTS hours_consumed   NUMERIC(8,2)  DEFAULT 0;
    ALTER TABLE project_members ADD COLUMN IF NOT EXISTS skill_level      VARCHAR(30);
  `);

  // ── 11. amc_contracts: project linkage + renewal fields ──────────────────────
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='amc_contracts') THEN
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS project_id      INTEGER;
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS company_id      INTEGER;
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS product_name    VARCHAR(255);
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS serial_number   VARCHAR(100);
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS renewal_date    DATE;
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS auto_renew      BOOLEAN       DEFAULT FALSE;
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS renewal_amount  NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS scope_of_work   TEXT;
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS exclusions       TEXT;
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS renewal_count   INTEGER       DEFAULT 0;
      END IF;
    END $$;
  `);

  // ── 12. project_documents table ──────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS project_documents (
      id              SERIAL PRIMARY KEY,
      project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      company_id      INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      document_name   VARCHAR(255) NOT NULL,
      document_type   VARCHAR(50)  DEFAULT 'general',
      document_number VARCHAR(100),
      revision        VARCHAR(20),
      file_url        VARCHAR(1000),
      file_name       VARCHAR(255),
      mime_type       VARCHAR(100),
      file_size       BIGINT       DEFAULT 0,
      uploaded_by     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      status          VARCHAR(30)  DEFAULT 'current',
      description     TEXT,
      created_at      TIMESTAMPTZ  DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_documents_project ON project_documents(project_id);
  `);

  // ── 13. project_budget_lines table ───────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS project_budget_lines (
      id               SERIAL PRIMARY KEY,
      project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      company_id       INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      wbs_code         VARCHAR(30),
      category         VARCHAR(50)  NOT NULL,
      description      VARCHAR(255),
      budgeted_amount  NUMERIC(15,2) DEFAULT 0,
      actual_amount    NUMERIC(15,2) DEFAULT 0,
      committed_amount NUMERIC(15,2) DEFAULT 0,
      variance         NUMERIC(15,2) DEFAULT 0,
      sequence         INTEGER       DEFAULT 0,
      created_at       TIMESTAMPTZ   DEFAULT NOW(),
      updated_at       TIMESTAMPTZ   DEFAULT NOW()
    );
  `);

  // ── 14. project_scurve_data table ────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS project_scurve_data (
      id               SERIAL PRIMARY KEY,
      project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      period           VARCHAR(10),
      planned_cost     NUMERIC(15,2) DEFAULT 0,
      actual_cost      NUMERIC(15,2) DEFAULT 0,
      planned_progress NUMERIC(5,2)  DEFAULT 0,
      actual_progress  NUMERIC(5,2)  DEFAULT 0,
      earned_value     NUMERIC(15,2) DEFAULT 0,
      created_at       TIMESTAMPTZ   DEFAULT NOW(),
      updated_at       TIMESTAMPTZ   DEFAULT NOW(),
      UNIQUE(project_id, period)
    );
  `);

  // ── 15. commissioning_reports: project_id FK ─────────────────────────────────
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='commissioning_reports') THEN
        ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS project_id INTEGER;
      END IF;
    END $$;
  `);

  // ── 16. sales_invoices: project + milestone FK (if table exists) ─────────────
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='sales_invoices') THEN
        ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL;
        ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS milestone_id INTEGER REFERENCES project_milestones(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);

  // ── 17. Performance indexes ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_start_date ON tasks(start_date);
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS project_scurve_data CASCADE;
    DROP TABLE IF EXISTS project_budget_lines CASCADE;
    DROP TABLE IF EXISTS project_documents CASCADE;
    DROP TABLE IF EXISTS project_warranties CASCADE;
    DROP TABLE IF EXISTS sat_trackers CASCADE;
    DROP TABLE IF EXISTS fat_trackers CASCADE;
    DROP TABLE IF EXISTS project_issues CASCADE;
  `);
}
