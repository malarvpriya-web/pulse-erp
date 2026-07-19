/**
 * Phase 49C — Vendor Registration Portal
 *
 * Extends existing vendors + vendor_registrations tables.
 * Creates: vendor_contacts, vendor_documents, vendor_bank_details,
 *          vendor_drive_folders, vendor_risk_assessments,
 *          vendor_ncr, vendor_capa
 */
export async function up(knex) {
  const raw = sql => knex.raw(sql);

  // ── 1. Extend vendors table ──────────────────────────────────────────────────
  await raw(`
    ALTER TABLE vendors
      ADD COLUMN IF NOT EXISTS vendor_code        VARCHAR(30),
      ADD COLUMN IF NOT EXISTS vendor_type        VARCHAR(100),
      ADD COLUMN IF NOT EXISTS vendor_category    VARCHAR(100),
      ADD COLUMN IF NOT EXISTS udyam_number       VARCHAR(50),
      ADD COLUMN IF NOT EXISTS msme_status        BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS iec                VARCHAR(15),
      ADD COLUMN IF NOT EXISTS cin                VARCHAR(25),
      ADD COLUMN IF NOT EXISTS website            VARCHAR(300),
      ADD COLUMN IF NOT EXISTS country            VARCHAR(100) DEFAULT 'India',
      ADD COLUMN IF NOT EXISTS postal_code        VARCHAR(10),
      ADD COLUMN IF NOT EXISTS year_established   INTEGER,
      ADD COLUMN IF NOT EXISTS employee_count     INTEGER,
      ADD COLUMN IF NOT EXISTS annual_turnover    NUMERIC(18,2),
      ADD COLUMN IF NOT EXISTS factory_locations  JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS office_locations   JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS vendor_folder_id   VARCHAR(200),
      ADD COLUMN IF NOT EXISTS vendor_folder_url  TEXT,
      ADD COLUMN IF NOT EXISTS approved_by        INTEGER,
      ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS classification     VARCHAR(30) DEFAULT 'Approved',
      ADD COLUMN IF NOT EXISTS scm_score          NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS quality_score      NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS finance_score      NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS risk_score         NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS risk_rating        VARCHAR(20) DEFAULT 'Medium',
      ADD COLUMN IF NOT EXISTS is_critical_supplier  BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_single_source      BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_long_lead           BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS registration_id    INTEGER,
      ADD COLUMN IF NOT EXISTS deleted_at         TIMESTAMPTZ
  `);
  await raw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_vendor_code ON vendors(vendor_code) WHERE vendor_code IS NOT NULL`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vendors_classification ON vendors(classification)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vendors_risk_rating    ON vendors(risk_rating)`);

  // ── 2. Extend vendor_registrations ──────────────────────────────────────────
  await raw(`
    ALTER TABLE vendor_registrations
      ADD COLUMN IF NOT EXISTS iec              VARCHAR(15),
      ADD COLUMN IF NOT EXISTS cin              VARCHAR(25),
      ADD COLUMN IF NOT EXISTS country          VARCHAR(100) DEFAULT 'India',
      ADD COLUMN IF NOT EXISTS employee_count   INTEGER,
      ADD COLUMN IF NOT EXISTS factory_locations JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS office_locations  JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS contact_details   JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS password_hash     VARCHAR(255),
      ADD COLUMN IF NOT EXISTS email_verified    BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS mobile_verified   BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS email_otp         VARCHAR(10),
      ADD COLUMN IF NOT EXISTS email_otp_expires TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS mobile_otp        VARCHAR(10),
      ADD COLUMN IF NOT EXISTS mobile_otp_expires TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS drive_folder_id   VARCHAR(200),
      ADD COLUMN IF NOT EXISTS drive_folder_url  TEXT,
      ADD COLUMN IF NOT EXISTS scm_score         NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS scm_quality_score NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS finance_score     NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS risk_score        NUMERIC(5,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS rejection_reason  TEXT
  `);

  // ── 3. vendor_contacts ───────────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_contacts (
      id              SERIAL PRIMARY KEY,
      vendor_id       INTEGER NOT NULL,
      contact_type    VARCHAR(50) NOT NULL DEFAULT 'Commercial',
      name            VARCHAR(200) NOT NULL,
      designation     VARCHAR(200),
      phone           VARCHAR(20),
      mobile          VARCHAR(20),
      email           VARCHAR(200),
      is_primary      BOOLEAN DEFAULT FALSE,
      company_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vc_vendor_id   ON vendor_contacts(vendor_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vc_company_id  ON vendor_contacts(company_id)`);

  // ── 4. vendor_documents ──────────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_documents (
      id              SERIAL PRIMARY KEY,
      vendor_id       INTEGER,
      registration_id INTEGER,
      doc_type        VARCHAR(100) NOT NULL,
      file_name       VARCHAR(300),
      file_path       TEXT,
      drive_file_id   VARCHAR(200),
      drive_file_url  TEXT,
      drive_folder_id VARCHAR(200),
      expiry_date     DATE,
      status          VARCHAR(30) DEFAULT 'Active',
      verified        BOOLEAN DEFAULT FALSE,
      verified_by     INTEGER,
      verified_at     TIMESTAMPTZ,
      remarks         TEXT,
      company_id      INTEGER,
      uploaded_by     INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vd_vendor_id       ON vendor_documents(vendor_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vd_registration_id ON vendor_documents(registration_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vd_doc_type        ON vendor_documents(doc_type)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vd_company_id      ON vendor_documents(company_id)`);

  // ── 5. vendor_bank_details ───────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_bank_details (
      id              SERIAL PRIMARY KEY,
      vendor_id       INTEGER,
      registration_id INTEGER,
      bank_name       VARCHAR(200) NOT NULL,
      account_number  VARCHAR(30) NOT NULL,
      ifsc            VARCHAR(15) NOT NULL,
      branch          VARCHAR(200),
      account_type    VARCHAR(50) DEFAULT 'Current',
      cancelled_cheque_path TEXT,
      cancelled_cheque_drive_id VARCHAR(200),
      finance_verified   BOOLEAN DEFAULT FALSE,
      finance_verified_by INTEGER,
      finance_verified_at TIMESTAMPTZ,
      is_primary      BOOLEAN DEFAULT TRUE,
      company_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vbd_vendor_id ON vendor_bank_details(vendor_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vbd_company_id ON vendor_bank_details(company_id)`);

  // ── 6. vendor_drive_folders ──────────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_drive_folders (
      id              SERIAL PRIMARY KEY,
      vendor_id       INTEGER,
      registration_id INTEGER,
      vendor_name     VARCHAR(200),
      root_folder_id  VARCHAR(200),
      root_folder_url TEXT,
      folder_map      JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (vendor_id),
      UNIQUE (registration_id)
    )
  `);

  // ── 7. vendor_risk_assessments ───────────────────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_risk_assessments (
      id                  SERIAL PRIMARY KEY,
      vendor_id           INTEGER NOT NULL,
      assessment_date     DATE NOT NULL DEFAULT CURRENT_DATE,
      financial_risk      NUMERIC(5,2) DEFAULT 0,
      quality_risk        NUMERIC(5,2) DEFAULT 0,
      delivery_risk       NUMERIC(5,2) DEFAULT 0,
      compliance_risk     NUMERIC(5,2) DEFAULT 0,
      dependency_risk     NUMERIC(5,2) DEFAULT 0,
      overall_risk_score  NUMERIC(5,2) DEFAULT 0,
      risk_rating         VARCHAR(20) DEFAULT 'Medium',
      ncr_count_12m       INTEGER DEFAULT 0,
      late_delivery_pct   NUMERIC(5,2) DEFAULT 0,
      spend_concentration NUMERIC(5,2) DEFAULT 0,
      notes               TEXT,
      assessed_by         INTEGER,
      company_id          INTEGER,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vra_vendor_id  ON vendor_risk_assessments(vendor_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vra_company_id ON vendor_risk_assessments(company_id)`);

  // ── 8. vendor_ncr (Non-Conformance Reports) ──────────────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_ncr (
      id              SERIAL PRIMARY KEY,
      ncr_number      VARCHAR(30) UNIQUE NOT NULL,
      vendor_id       INTEGER NOT NULL,
      grn_id          INTEGER,
      po_id           INTEGER,
      ncr_date        DATE NOT NULL DEFAULT CURRENT_DATE,
      defect_type     VARCHAR(100),
      description     TEXT NOT NULL,
      quantity_rejected NUMERIC(12,2),
      severity        VARCHAR(20) DEFAULT 'Minor',
      status          VARCHAR(30) DEFAULT 'Open',
      root_cause      TEXT,
      disposition     VARCHAR(50),
      closed_at       TIMESTAMPTZ,
      closed_by       INTEGER,
      score_impact    NUMERIC(5,2) DEFAULT 0,
      drive_folder_id VARCHAR(200),
      company_id      INTEGER,
      raised_by       INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vncr_vendor_id  ON vendor_ncr(vendor_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vncr_status     ON vendor_ncr(status)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vncr_company_id ON vendor_ncr(company_id)`);

  // ── 9. vendor_capa (Corrective & Preventive Action) ─────────────────────────
  await raw(`
    CREATE TABLE IF NOT EXISTS vendor_capa (
      id              SERIAL PRIMARY KEY,
      capa_number     VARCHAR(30) UNIQUE NOT NULL,
      ncr_id          INTEGER REFERENCES vendor_ncr(id) ON DELETE SET NULL,
      vendor_id       INTEGER NOT NULL,
      capa_type       VARCHAR(20) DEFAULT 'Corrective',
      issue_date      DATE NOT NULL DEFAULT CURRENT_DATE,
      due_date        DATE,
      description     TEXT NOT NULL,
      root_cause      TEXT,
      action_plan     TEXT,
      verification_method TEXT,
      status          VARCHAR(30) DEFAULT 'Open',
      effectiveness_rating SMALLINT,
      closed_at       TIMESTAMPTZ,
      closed_by       INTEGER,
      drive_folder_id VARCHAR(200),
      company_id      INTEGER,
      created_by      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vcapa_vendor_id  ON vendor_capa(vendor_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vcapa_ncr_id     ON vendor_capa(ncr_id)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vcapa_status     ON vendor_capa(status)`);
  await raw(`CREATE INDEX IF NOT EXISTS idx_vcapa_company_id ON vendor_capa(company_id)`);
}

export async function down(knex) {
  const raw = sql => knex.raw(sql);
  await raw(`DROP TABLE IF EXISTS vendor_capa`);
  await raw(`DROP TABLE IF EXISTS vendor_ncr`);
  await raw(`DROP TABLE IF EXISTS vendor_risk_assessments`);
  await raw(`DROP TABLE IF EXISTS vendor_drive_folders`);
  await raw(`DROP TABLE IF EXISTS vendor_bank_details`);
  await raw(`DROP TABLE IF EXISTS vendor_documents`);
  await raw(`DROP TABLE IF EXISTS vendor_contacts`);
}
