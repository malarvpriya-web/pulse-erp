/**
 * 20260703000001_tcs_module.js — Tax Collected at Source (TCS, Section 206C)
 * Mirrors the TDS module: collectees master, collection register, Form 27D certificates.
 * TCS is collected by the SELLER from the BUYER (collectee) and filed via Form 27EQ.
 */

export async function up(db) {
  // ── Collectees master (buyers from whom TCS is collected) ────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS tcs_collectees (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER,
      party_id          UUID,
      party_name        VARCHAR(200) NOT NULL,
      pan               VARCHAR(20),
      collectee_type    VARCHAR(20)  DEFAULT 'company',
      section           VARCHAR(20),
      threshold_limit   NUMERIC(15,2) DEFAULT 5000000,
      rate_with_pan     NUMERIC(5,2)  DEFAULT 0.1,
      rate_without_pan  NUMERIC(5,2)  DEFAULT 1,
      is_active         BOOLEAN      DEFAULT true,
      created_at        TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tcs_collectees_company ON tcs_collectees(company_id)`);

  // ── Collection register ──────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS tcs_transactions (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER,
      collectee_id     INTEGER REFERENCES tcs_collectees(id),
      party_id         UUID,
      invoice_id       INTEGER,
      section          VARCHAR(20),
      receipt_date     DATE,
      receipt_amount   NUMERIC(15,2),
      tcs_rate         NUMERIC(5,2),
      tcs_amount       NUMERIC(15,2),
      surcharge        NUMERIC(15,2) DEFAULT 0,
      education_cess   NUMERIC(15,2) DEFAULT 0,
      total_tcs        NUMERIC(15,2),
      challan_number   VARCHAR(50),
      challan_date     DATE,
      bsr_code         VARCHAR(20),
      deposited        BOOLEAN      DEFAULT false,
      quarter          VARCHAR(5),
      financial_year   VARCHAR(12),
      created_at       TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tcs_txn_company   ON tcs_transactions(company_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tcs_txn_collectee ON tcs_transactions(collectee_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tcs_txn_fy        ON tcs_transactions(financial_year)`);

  // ── Form 27D certificate records ─────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS form27d_records (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER,
      collectee_id        INTEGER REFERENCES tcs_collectees(id),
      financial_year      VARCHAR(12),
      quarter             VARCHAR(5),
      certificate_number  VARCHAR(100),
      issued_date         DATE,
      total_receipt       NUMERIC(15,2),
      total_tcs           NUMERIC(15,2),
      status              VARCHAR(20) DEFAULT 'issued',
      certificate_data    JSONB,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_form27d_collectee ON form27d_records(collectee_id)`);
}

export async function down(db) {
  await db.query(`DROP TABLE IF EXISTS form27d_records`);
  await db.query(`DROP TABLE IF EXISTS tcs_transactions`);
  await db.query(`DROP TABLE IF EXISTS tcs_collectees`);
}
