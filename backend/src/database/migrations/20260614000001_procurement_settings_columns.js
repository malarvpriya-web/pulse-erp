export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_ps_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`
    CREATE TABLE IF NOT EXISTS procurement_settings (
      id                           SERIAL PRIMARY KEY,
      company_id                   INTEGER UNIQUE REFERENCES companies(id),
      default_payment_terms_days   INTEGER       DEFAULT 30,
      auto_approve_below           NUMERIC(14,2) DEFAULT 5000,
      grn_qty_tolerance_pct        NUMERIC(5,2)  DEFAULT 5,
      min_vendor_rating            NUMERIC(3,1)  DEFAULT 3,
      l1_approval_limit            NUMERIC(14,2) DEFAULT 25000,
      l2_approval_limit            NUMERIC(14,2) DEFAULT 100000,
      cfo_approval_above           NUMERIC(14,2) DEFAULT 500000,
      enforce_3way_match           BOOLEAN       DEFAULT false,
      block_payment_on_mismatch    BOOLEAN       DEFAULT false,
      allowable_price_variance_pct NUMERIC(5,2)  DEFAULT 3,
      pr_prefix                    VARCHAR(10)   DEFAULT 'PR',
      po_prefix                    VARCHAR(10)   DEFAULT 'PO',
      grn_prefix                   VARCHAR(10)   DEFAULT 'GRN',
      rfq_prefix                   VARCHAR(10)   DEFAULT 'RFQ',
      notify_po_approval           BOOLEAN       DEFAULT false,
      notify_grn_receipt           BOOLEAN       DEFAULT false,
      alert_vendor_rating_drop     BOOLEAN       DEFAULT false,
      alert_overdue_delivery       BOOLEAN       DEFAULT false,
      updated_at                   TIMESTAMPTZ   DEFAULT NOW()
    )
  `);

  // Safe ADD for any column missing in older installs
  const cols = [
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS default_payment_terms_days   INTEGER       DEFAULT 30`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS auto_approve_below           NUMERIC(14,2) DEFAULT 5000`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS grn_qty_tolerance_pct        NUMERIC(5,2)  DEFAULT 5`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS min_vendor_rating            NUMERIC(3,1)  DEFAULT 3`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS l1_approval_limit            NUMERIC(14,2) DEFAULT 25000`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS l2_approval_limit            NUMERIC(14,2) DEFAULT 100000`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS cfo_approval_above           NUMERIC(14,2) DEFAULT 500000`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS enforce_3way_match           BOOLEAN       DEFAULT false`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS block_payment_on_mismatch    BOOLEAN       DEFAULT false`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS allowable_price_variance_pct NUMERIC(5,2)  DEFAULT 3`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS pr_prefix                    VARCHAR(10)   DEFAULT 'PR'`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS po_prefix                    VARCHAR(10)   DEFAULT 'PO'`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS grn_prefix                   VARCHAR(10)   DEFAULT 'GRN'`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS rfq_prefix                   VARCHAR(10)   DEFAULT 'RFQ'`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS notify_po_approval           BOOLEAN       DEFAULT false`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS notify_grn_receipt           BOOLEAN       DEFAULT false`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS alert_vendor_rating_drop     BOOLEAN       DEFAULT false`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS alert_overdue_delivery       BOOLEAN       DEFAULT false`,
    `ALTER TABLE procurement_settings ADD COLUMN IF NOT EXISTS updated_at                   TIMESTAMPTZ   DEFAULT NOW()`,
  ];
  for (const sql of cols) await safe(sql);

  await safe(`CREATE INDEX IF NOT EXISTS idx_procurement_settings_company ON procurement_settings(company_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS procurement_settings CASCADE`);
}
