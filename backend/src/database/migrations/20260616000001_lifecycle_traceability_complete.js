/**
 * Lifecycle Traceability Complete — fixes all P0/P1/P2 audit gaps
 * All ALTER TABLE blocks guarded with DO $$ existence checks.
 */
export async function up(knex) {
  const raw = sql => knex.raw(sql);

  // ── 1. purchase_orders: project linkage ─────────────────────────────────────
  await raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='purchase_orders') THEN
        ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS project_id     INTEGER;
        ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS sales_order_id INTEGER;
        CREATE INDEX IF NOT EXISTS idx_po_project_id     ON purchase_orders(project_id);
        CREATE INDEX IF NOT EXISTS idx_po_sales_order_id ON purchase_orders(sales_order_id);
      END IF;
    END $$;
  `);

  // ── 2. support_tickets: project linkage + cost capture ──────────────────────
  await raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='support_tickets') THEN
        ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS project_id   INTEGER;
        ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS service_cost NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS parts_cost   NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS labour_hours NUMERIC(8,2)  DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_tickets_project_id ON support_tickets(project_id);
      END IF;
    END $$;
  `);

  // ── 3. project_cost_summary: add missing cost/revenue columns ────────────────
  await raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='project_cost_summary') THEN
        ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS service_cost         NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS quality_cost         NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS installation_cost    NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS commissioning_cost   NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS procurement_overhead NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS amc_revenue          NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE project_cost_summary ADD COLUMN IF NOT EXISTS total_revenue        NUMERIC(15,2) DEFAULT 0;
      END IF;
    END $$;
  `);

  // ── 4. technical_proposals ───────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS technical_proposals (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER,
      opportunity_id   INTEGER,
      account_id       INTEGER,
      proposal_number  VARCHAR(50) UNIQUE,
      title            VARCHAR(500) NOT NULL,
      status           VARCHAR(30)  NOT NULL DEFAULT 'draft',
      revision         INTEGER      NOT NULL DEFAULT 1,
      original_id      INTEGER,
      prepared_by      INTEGER,
      reviewed_by      INTEGER,
      approved_by      INTEGER,
      submitted_date   DATE,
      approved_date    DATE,
      validity_days    INTEGER DEFAULT 30,
      scope_of_work    TEXT,
      technical_specs  JSONB NOT NULL DEFAULT '{}',
      deliverables     JSONB NOT NULL DEFAULT '[]',
      exclusions       TEXT,
      assumptions      TEXT,
      drive_file_id    TEXT,
      drive_link       TEXT,
      notes            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at       TIMESTAMPTZ
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tech_prop_opportunity ON technical_proposals(opportunity_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tech_prop_company     ON technical_proposals(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_tech_prop_status      ON technical_proposals(status)`);

  // ── 5a. commercial_proposals ─────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS commercial_proposals (
      id                    SERIAL PRIMARY KEY,
      company_id            INTEGER,
      opportunity_id        INTEGER,
      technical_proposal_id INTEGER REFERENCES technical_proposals(id) ON DELETE SET NULL,
      account_id            INTEGER,
      proposal_number       VARCHAR(50) UNIQUE,
      title                 VARCHAR(500) NOT NULL,
      status                VARCHAR(30)  NOT NULL DEFAULT 'draft',
      revision              INTEGER      NOT NULL DEFAULT 1,
      original_id           INTEGER,
      prepared_by           INTEGER,
      reviewed_by           INTEGER,
      approved_by           INTEGER,
      submitted_date        DATE,
      approved_date         DATE,
      validity_date         DATE,
      currency              VARCHAR(10) NOT NULL DEFAULT 'INR',
      equipment_cost        NUMERIC(15,2) DEFAULT 0,
      installation_cost     NUMERIC(15,2) DEFAULT 0,
      civil_cost            NUMERIC(15,2) DEFAULT 0,
      commissioning_cost    NUMERIC(15,2) DEFAULT 0,
      amc_cost              NUMERIC(15,2) DEFAULT 0,
      contingency_pct       NUMERIC(5,2)  DEFAULT 0,
      tax_percentage        NUMERIC(5,2)  DEFAULT 18,
      subtotal              NUMERIC(15,2) DEFAULT 0,
      tax_amount            NUMERIC(15,2) DEFAULT 0,
      total_amount          NUMERIC(15,2) DEFAULT 0,
      payment_terms         TEXT,
      delivery_weeks        INTEGER,
      warranty_months       INTEGER DEFAULT 12,
      incoterms             VARCHAR(20),
      drive_file_id         TEXT,
      drive_link            TEXT,
      notes                 TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at            TIMESTAMPTZ
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_comm_prop_opportunity ON commercial_proposals(opportunity_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_comm_prop_tech        ON commercial_proposals(technical_proposal_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_comm_prop_company     ON commercial_proposals(company_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_comm_prop_status      ON commercial_proposals(status)`);

  // ── 5b. commercial_proposal_items ────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS commercial_proposal_items (
      id                     SERIAL PRIMARY KEY,
      commercial_proposal_id INTEGER NOT NULL REFERENCES commercial_proposals(id) ON DELETE CASCADE,
      line_no                INTEGER DEFAULT 1,
      item_code              VARCHAR(100),
      description            TEXT NOT NULL,
      quantity               NUMERIC(12,3) DEFAULT 1,
      unit                   VARCHAR(30)   DEFAULT 'nos',
      rate                   NUMERIC(15,2) DEFAULT 0,
      discount_pct           NUMERIC(5,2)  DEFAULT 0,
      tax_pct                NUMERIC(5,2)  DEFAULT 18,
      amount                 NUMERIC(15,2) DEFAULT 0,
      hsn_code               VARCHAR(20),
      created_at             TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_cp_items_proposal ON commercial_proposal_items(commercial_proposal_id)`);

  // ── 6. lifecycle_instances: project_id ──────────────────────────────────────
  await raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='lifecycle_instances') THEN
        ALTER TABLE lifecycle_instances ADD COLUMN IF NOT EXISTS project_id INTEGER;
        CREATE INDEX IF NOT EXISTS idx_lifecycle_project_id ON lifecycle_instances(project_id);
      END IF;
    END $$;
  `);

  // ── 7. commissioning_reports: cost capture columns ───────────────────────────
  await raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='commissioning_reports') THEN
        ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS commissioning_cost NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS travel_cost        NUMERIC(15,2) DEFAULT 0;
        ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS parts_used         JSONB DEFAULT '[]';
        ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS drive_file_id      TEXT;
        ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS drive_link         TEXT;
      END IF;
    END $$;
  `);

  // ── 8. amc_contracts: project_id linkage ────────────────────────────────────
  await raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='amc_contracts') THEN
        ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS project_id INTEGER;
        CREATE INDEX IF NOT EXISTS idx_amc_project_id ON amc_contracts(project_id);
      END IF;
    END $$;
  `);

  // ── 9. customer_drive_folders: already created by earlier migration ──────────
  await raw(`
    CREATE TABLE IF NOT EXISTS customer_drive_folders (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER,
      customer_name   VARCHAR(500) NOT NULL,
      doc_type        VARCHAR(100) NOT NULL,
      drive_folder_id TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, customer_name, doc_type)
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_cdf_lookup ON customer_drive_folders(company_id, customer_name)`);

  // ── 10. opportunities: proposal tracking columns ────────────────────────────
  await raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='opportunities') THEN
        ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS tech_proposal_id INTEGER;
        ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS comm_proposal_id INTEGER;
        ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS quotation_id     INTEGER;
        CREATE INDEX IF NOT EXISTS idx_opp_tech_prop ON opportunities(tech_proposal_id);
        CREATE INDEX IF NOT EXISTS idx_opp_comm_prop ON opportunities(comm_proposal_id);
        CREATE INDEX IF NOT EXISTS idx_opp_quotation ON opportunities(quotation_id);
      END IF;
    END $$;
  `);

  // ── 11–12. fat_trackers / sat_trackers: Drive columns ───────────────────────
  await raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='fat_trackers') THEN
        ALTER TABLE fat_trackers ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
        ALTER TABLE fat_trackers ADD COLUMN IF NOT EXISTS drive_link    TEXT;
      END IF;
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='sat_trackers') THEN
        ALTER TABLE sat_trackers ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
        ALTER TABLE sat_trackers ADD COLUMN IF NOT EXISTS drive_link    TEXT;
      END IF;
    END $$;
  `);

  // ── 13. quotations: Drive columns ───────────────────────────────────────────
  await raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='quotations') THEN
        ALTER TABLE quotations ADD COLUMN IF NOT EXISTS drive_file_id  TEXT;
        ALTER TABLE quotations ADD COLUMN IF NOT EXISTS drive_link      TEXT;
        ALTER TABLE quotations ADD COLUMN IF NOT EXISTS drive_folder_id TEXT;
      END IF;
    END $$;
  `);

  // ── 14. Performance indexes ──────────────────────────────────────────────────
  await raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='purchase_orders') THEN
        CREATE INDEX IF NOT EXISTS idx_po_company_project ON purchase_orders(company_id, project_id);
      END IF;
      IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='support_tickets') THEN
        CREATE INDEX IF NOT EXISTS idx_tickets_company_prj ON support_tickets(company_id, project_id);
      END IF;
    END $$;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial_proposal_items CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS commercial_proposals CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS technical_proposals CASCADE`);
}
