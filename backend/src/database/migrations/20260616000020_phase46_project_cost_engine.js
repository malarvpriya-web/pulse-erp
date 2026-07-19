/**
 * Phase 46 — Project Cost & Profitability Engine
 * Creates: project_cost_transactions, project_revenue_summary, cost_centers
 * Alters:  project_cost_summary (full 16-bucket cost breakdown)
 */
export async function up(knex) {
  // ── 1. cost_centers master table ───────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS cost_centers (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      code            VARCHAR(30) NOT NULL,
      name            VARCHAR(120) NOT NULL,
      department      VARCHAR(100),
      department_id   INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      parent_id       INTEGER REFERENCES cost_centers(id) ON DELETE SET NULL,
      description     TEXT,
      is_active       BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, code)
    )
  `);

  // ── 2. project_cost_transactions — the unified cost ledger ─────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS project_cost_transactions (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      customer_id       INTEGER,
      customer_name     VARCHAR(255),
      project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      project_code      VARCHAR(50),
      site_id           INTEGER,
      site_name         VARCHAR(255),
      sales_order_id    INTEGER,
      po_number         VARCHAR(100),
      cost_center_id    INTEGER REFERENCES cost_centers(id) ON DELETE SET NULL,
      cost_type         VARCHAR(40) NOT NULL CHECK (cost_type IN (
                          'SALES_TRAVEL','APPLICATION_ENGINEERING','ENGINEERING',
                          'PROCUREMENT','MATERIAL','INVENTORY','PRODUCTION',
                          'LABOUR','QUALITY','FAT','TRANSPORT','INSTALLATION',
                          'COMMISSIONING','SERVICE','AMC','OTHER'
                        )),
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
      created_by        INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── 3. project_revenue_summary — revenue tracker per project ───────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS project_revenue_summary (
      id                    SERIAL PRIMARY KEY,
      company_id            INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      project_id            INTEGER REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
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
    )
  `);

  // ── 4. Extend project_cost_summary with all 16 cost buckets ───────────────
  await knex.raw(`
    ALTER TABLE project_cost_summary
      ADD COLUMN IF NOT EXISTS sales_travel_cost      NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS app_engineering_cost   NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS engineering_cost       NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS procurement_cost       NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS material_cost          NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS inventory_cost         NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS production_cost        NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS labour_cost            NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS quality_cost           NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS fat_cost               NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS transport_cost         NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS installation_cost      NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS commissioning_cost     NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS service_cost           NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS amc_cost               NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS other_cost             NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_cost             NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_revenue          NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS revenue                NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS profit                 NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS gross_margin_pct       NUMERIC(8,2)  DEFAULT 0,
      ADD COLUMN IF NOT EXISTS net_margin_pct         NUMERIC(8,2)  DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cost_variance          NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS budget_variance        NUMERIC(15,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS collection_pct         NUMERIC(8,2)  DEFAULT 0,
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
      ADD COLUMN IF NOT EXISTS last_calculated_at     TIMESTAMPTZ
  `);

  // ── 5. Indexes ──────────────────────────────────────────────────────────────
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_pct_company       ON project_cost_transactions(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_pct_project       ON project_cost_transactions(project_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_pct_customer      ON project_cost_transactions(customer_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_pct_cost_type     ON project_cost_transactions(cost_type)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_pct_date          ON project_cost_transactions(transaction_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_pct_unallocated   ON project_cost_transactions(is_unallocated) WHERE is_unallocated = TRUE`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_prs_project       ON project_revenue_summary(project_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cc_company        ON cost_centers(company_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS project_cost_transactions CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS project_revenue_summary CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS cost_centers CASCADE`);
}
