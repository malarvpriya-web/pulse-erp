/**
 * 20260618000001_pulse_erp_full_fix.js
 *
 * Step 2 master fix migration:
 *   P1 – Company profile (Karnataka GSTIN 29, pincode, place_of_supply)
 *   P2 – company_id on remaining Engineering tables (eng_rd_projects family + bom_lines)
 *   P3 – Missing columns on candidates, sales_orders, inventory_items,
 *         rm_issues (material consumption), leads, contacts, accounts
 *   P4 – New tables: interviews, job_offers, onboarding_records, onboarding_tasks,
 *         crm_activities column enhancements, warehouse_bins
 *   P5 – Unique partial indexes on leads + contacts email
 *
 * Every statement uses SAVEPOINT so a pre-existing column/table/index never
 * aborts the whole transaction.
 *
 * Naming corrections vs. Step-2 prompt:
 *   engineering_projects → eng_rd_projects
 *   design_phases        → eng_design_phases
 *   prototypes           → eng_prototypes
 *   test_plans           → eng_test_plans
 *   bill_of_materials    → bom_headers  (already has company_id — skipped)
 *   bom_components       → bom_lines
 *   power_quality_logs   → does not exist — skipped
 *   production_materials → does not exist — skipped
 *   material_consumption → VIEW; real table is rm_issues
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (label, sql) => {
    const name = `sp_fix_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      const msg = err.message || '';
      if (!/already exists|does not exist|duplicate column|multiple primary|duplicate key/i.test(msg)) throw err;
      console.warn(`[pulse_erp_full_fix] skip (${label}): ${msg.split('\n')[0]}`);
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // PRIORITY 1 — Fix Company Profile (Karnataka GSTIN)
  // ═══════════════════════════════════════════════════════════════════

  await safe('companies add pincode',
    `ALTER TABLE companies ADD COLUMN IF NOT EXISTS pincode VARCHAR(10)`);

  await safe('companies add place_of_supply',
    `ALTER TABLE companies ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(100)`);

  // Drop constraint so we can write a valid Karnataka GSTIN (29…)
  await safe('drop gstin constraint',
    `ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_gstin_format`);

  await safe('update company profile', `
    UPDATE companies
    SET
      gstin           = '29AABCM1234A1Z5',
      state           = 'Karnataka',
      state_code      = '29',
      city            = 'Bangalore',
      pincode         = '560001',
      address         = '123 MG Road, Bangalore, Karnataka 560001',
      place_of_supply = 'Karnataka',
      updated_at      = NOW()
    WHERE name = 'Manifest Technologies'
  `);

  // Restore format constraint
  await safe('restore gstin constraint', `
    ALTER TABLE companies
      ADD CONSTRAINT chk_companies_gstin_format
        CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
  `);

  // ═══════════════════════════════════════════════════════════════════
  // PRIORITY 2 — Add company_id to Engineering tables
  //   bom_headers, production_orders, work_centres already scoped.
  // ═══════════════════════════════════════════════════════════════════

  const engTables = [
    'eng_rd_projects',   // root engineering project table
    'eng_design_phases', // child of eng_rd_projects
    'eng_prototypes',    // child of eng_rd_projects
    'eng_test_plans',    // child of eng_rd_projects
    'bom_lines',         // BOM component rows (bom_headers already scoped)
  ];

  for (const t of engTables) {
    await safe(`${t} add company_id`, `
      ALTER TABLE ${t}
        ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL
    `);
    await safe(`${t} backfill company_id`, `
      UPDATE ${t}
      SET company_id = (SELECT id FROM companies WHERE name = 'Manifest Technologies' LIMIT 1)
      WHERE company_id IS NULL
    `);
    await safe(`idx_${t}_company`,
      `CREATE INDEX IF NOT EXISTS idx_${t}_company ON ${t}(company_id)`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PRIORITY 3 — Missing columns on existing tables
  // ═══════════════════════════════════════════════════════════════════

  // ── candidates ──────────────────────────────────────────────────────
  // resume/talent columns already added by 20260605000020 + 20260610000001
  await safe('candidates agency_id',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS agency_id INTEGER`);
  await safe('candidates offer_id',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS offer_id INTEGER`);
  await safe('candidates l1_outcome',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS l1_outcome VARCHAR(30)`);
  await safe('candidates l2_outcome',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS l2_outcome VARCHAR(30)`);
  await safe('candidates l1_interviewer_id',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS l1_interviewer_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await safe('candidates l2_interviewer_id',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS l2_interviewer_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await safe('candidates overall_rating',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS overall_rating NUMERIC(3,1)`);
  await safe('candidates status',
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'`);

  // ── sales_orders: campaign link ──────────────────────────────────────
  await safe('sales_orders campaign_id',
    `ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS campaign_id INTEGER`);

  // ── inventory_items ───────────────────────────────────────────────────
  await safe('inventory_items preferred_vendor_id',
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS preferred_vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL`);
  await safe('inventory_items holding_cost_pct',
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS holding_cost_pct NUMERIC(5,2) DEFAULT 0`);
  await safe('inventory_items is_batch_tracked',
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_batch_tracked BOOLEAN DEFAULT false`);
  await safe('inventory_items hsn_code',
    `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(20)`);

  // ── rm_issues: project traceability (material_consumption is a VIEW) ──
  await safe('rm_issues project_id',
    `ALTER TABLE rm_issues ADD COLUMN IF NOT EXISTS project_id INTEGER`);

  // ── leads: owner_id (already in seed schema — safe no-op) ────────────
  await safe('leads owner_id',
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`);

  // ── contacts: designation + is_primary (already in seed — safe no-op) ─
  await safe('contacts designation',
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS designation VARCHAR(255)`);
  await safe('contacts is_primary',
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT false`);

  // ── contacts: company_id for multi-tenant scoping ────────────────────
  await safe('contacts company_id',
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);

  // ── accounts: generic name alias alongside account_name ──────────────
  await safe('accounts name',
    `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS name VARCHAR(255)`);
  await safe('accounts name backfill',
    `UPDATE accounts SET name = account_name WHERE name IS NULL AND account_name IS NOT NULL`);

  // ── job_openings: GDrive fields (already done in 20260605000020 — safe) ─
  await safe('job_openings gdrive_folder_id',
    `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS gdrive_folder_id VARCHAR(255)`);
  await safe('job_openings gdrive_folder_structure',
    `ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS gdrive_folder_structure JSONB`);

  // ═══════════════════════════════════════════════════════════════════
  // PRIORITY 4 — Create missing tables
  // ═══════════════════════════════════════════════════════════════════

  // ── interviews ────────────────────────────────────────────────────────
  await safe('create interviews', `
    CREATE TABLE IF NOT EXISTS interviews (
      id                   SERIAL PRIMARY KEY,
      company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      candidate_id         INTEGER NOT NULL,
      job_opening_id       INTEGER,
      interview_level      INTEGER NOT NULL DEFAULT 1,
      interview_type       VARCHAR(50) DEFAULT 'in_person',
      interviewer_id       INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      assigned_by          INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      scheduled_date       DATE,
      scheduled_time       TIME,
      duration_minutes     INTEGER DEFAULT 60,
      meeting_link         VARCHAR(500),
      location             VARCHAR(255),
      status               VARCHAR(30) DEFAULT 'scheduled',
      outcome              VARCHAR(30),
      rating               INTEGER CHECK (rating BETWEEN 1 AND 5),
      feedback             TEXT,
      rejection_reason     TEXT,
      strengths            TEXT,
      areas_of_improvement TEXT,
      completed_at         TIMESTAMPTZ,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe('idx interviews company',
    `CREATE INDEX IF NOT EXISTS idx_interviews_company ON interviews(company_id, status)`);
  await safe('idx interviews candidate',
    `CREATE INDEX IF NOT EXISTS idx_interviews_candidate ON interviews(candidate_id)`);

  // ── job_offers ────────────────────────────────────────────────────────
  await safe('create job_offers', `
    CREATE TABLE IF NOT EXISTS job_offers (
      id                        SERIAL PRIMARY KEY,
      company_id                INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      offer_no                  VARCHAR(30) UNIQUE,
      candidate_id              INTEGER NOT NULL,
      job_opening_id            INTEGER,
      designation               VARCHAR(255) NOT NULL,
      department_id             INTEGER,
      joining_date              DATE,
      offer_expiry_date         DATE NOT NULL,
      employment_type           VARCHAR(50) DEFAULT 'full_time',
      ctc_annual                NUMERIC(14,2) NOT NULL,
      basic_monthly             NUMERIC(12,2),
      hra_monthly               NUMERIC(12,2),
      special_allowance_monthly NUMERIC(12,2),
      status                    VARCHAR(30) DEFAULT 'draft',
      offer_letter_gdrive_id    VARCHAR(255),
      offer_letter_url          TEXT,
      created_by                INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at                TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe('idx job_offers company',
    `CREATE INDEX IF NOT EXISTS idx_job_offers_company ON job_offers(company_id, status)`);
  await safe('idx job_offers candidate',
    `CREATE INDEX IF NOT EXISTS idx_job_offers_candidate ON job_offers(candidate_id)`);

  // ── onboarding_records ────────────────────────────────────────────────
  await safe('create onboarding_records', `
    CREATE TABLE IF NOT EXISTS onboarding_records (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      candidate_id   INTEGER,
      joining_date   DATE NOT NULL,
      status         VARCHAR(30) DEFAULT 'pending',
      completion_pct INTEGER DEFAULT 0,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe('idx onboarding_records company',
    `CREATE INDEX IF NOT EXISTS idx_onboarding_records_company ON onboarding_records(company_id)`);
  await safe('idx onboarding_records employee',
    `CREATE INDEX IF NOT EXISTS idx_onboarding_records_employee ON onboarding_records(employee_id)`);

  // ── onboarding_tasks ──────────────────────────────────────────────────
  await safe('create onboarding_tasks', `
    CREATE TABLE IF NOT EXISTS onboarding_tasks (
      id                   SERIAL PRIMARY KEY,
      onboarding_record_id INTEGER NOT NULL REFERENCES onboarding_records(id) ON DELETE CASCADE,
      company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title                VARCHAR(255) NOT NULL,
      category             VARCHAR(100),
      assigned_to          INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      due_date             DATE,
      status               VARCHAR(30) DEFAULT 'pending',
      completed_by         INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      completed_at         TIMESTAMPTZ,
      notes                TEXT,
      is_mandatory         BOOLEAN DEFAULT true,
      sort_order           INTEGER DEFAULT 0
    )
  `);
  await safe('idx onboarding_tasks record',
    `CREATE INDEX IF NOT EXISTS idx_onboarding_tasks_record ON onboarding_tasks(onboarding_record_id)`);

  // ── crm_activities: add missing multi-tenant columns ──────────────────
  await safe('crm_activities company_id',
    `ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE`);
  await safe('crm_activities account_id',
    `ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS account_id INTEGER`);
  await safe('crm_activities contact_id',
    `ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS contact_id INTEGER`);
  await safe('crm_activities type alias',
    `ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS type VARCHAR(50)`);
  await safe('crm_activities logged_by',
    `ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS logged_by INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await safe('idx crm_activities company',
    `CREATE INDEX IF NOT EXISTS idx_crm_activities_company ON crm_activities(company_id)`);

  // ── warehouse_bins ────────────────────────────────────────────────────
  await safe('create warehouse_bins', `
    CREATE TABLE IF NOT EXISTS warehouse_bins (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      warehouse_id INTEGER NOT NULL,
      row_code     VARCHAR(10) NOT NULL,
      shelf_code   VARCHAR(10) NOT NULL,
      bin_code     VARCHAR(20) NOT NULL,
      capacity     NUMERIC(10,3),
      current_qty  NUMERIC(10,3) DEFAULT 0,
      item_id      INTEGER,
      status       VARCHAR(20) DEFAULT 'empty',
      UNIQUE(company_id, warehouse_id, bin_code)
    )
  `);
  await safe('idx warehouse_bins company',
    `CREATE INDEX IF NOT EXISTS idx_warehouse_bins_company ON warehouse_bins(company_id, warehouse_id)`);

  // ═══════════════════════════════════════════════════════════════════
  // PRIORITY 5 — Unique indexes to prevent duplicates
  // ═══════════════════════════════════════════════════════════════════

  await safe('leads company email unique', `
    CREATE UNIQUE INDEX IF NOT EXISTS leads_company_email_unique
      ON leads(company_id, email)
      WHERE email IS NOT NULL AND email != ''
  `);

  await safe('contacts company email unique', `
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_email_unique
      ON contacts(company_id, email)
      WHERE email IS NOT NULL AND email != ''
  `);

  console.log('[migration 20260618000001] pulse_erp_full_fix applied.');
}

export async function down(knex) {
  // Destructive — left intentionally empty. Restore from a pre-migration backup.
}
