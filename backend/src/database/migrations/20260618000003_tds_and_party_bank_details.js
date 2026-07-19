export async function up(db) {
  // Add TDS columns to supplier_bills only if the table exists
  // (renamed to 'bills' in some installations — those already have these columns)
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'supplier_bills') THEN
        ALTER TABLE supplier_bills
          ADD COLUMN IF NOT EXISTS tds_section   VARCHAR(20),
          ADD COLUMN IF NOT EXISTS tds_rate      DECIMAL(5,2)  DEFAULT 0,
          ADD COLUMN IF NOT EXISTS tds_amount    DECIMAL(15,2) DEFAULT 0,
          ADD COLUMN IF NOT EXISTS net_payable   DECIMAL(15,2);

        UPDATE supplier_bills
        SET net_payable = total_amount - COALESCE(tds_amount, 0)
        WHERE net_payable IS NULL;
      END IF;
    END$$;
  `);

  // TDS transactions register (idempotent)
  await db.query(`
    CREATE TABLE IF NOT EXISTS tds_transactions (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER NOT NULL REFERENCES companies(id),
      bill_id          INTEGER,
      party_id         INTEGER REFERENCES parties(id),
      section          VARCHAR(20),
      rate             DECIMAL(5,2),
      gross_amount     DECIMAL(15,2),
      tds_amount       DECIMAL(15,2),
      deduction_date   DATE,
      challan_number   VARCHAR(50),
      remittance_date  DATE,
      created_at       TIMESTAMP DEFAULT NOW()
    );
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_tds_txn_company ON tds_transactions(company_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tds_txn_bill    ON tds_transactions(bill_id);`);

  await db.query(`
    ALTER TABLE parties
      ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) DEFAULT 'current';
  `);
}

export async function down(db) {
  await db.query(`DROP TABLE IF EXISTS tds_transactions;`);
  await db.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'supplier_bills') THEN
        ALTER TABLE supplier_bills
          DROP COLUMN IF EXISTS tds_section,
          DROP COLUMN IF EXISTS tds_rate,
          DROP COLUMN IF EXISTS tds_amount,
          DROP COLUMN IF EXISTS net_payable;
      END IF;
    END$$;
  `);
  await db.query(`ALTER TABLE parties DROP COLUMN IF EXISTS account_type;`);
}
