export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_vm_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  // ── rfq_quotes: vendor responses to RFQs ─────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS rfq_quotes (
      id              SERIAL PRIMARY KEY,
      rfq_id          INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      vendor_id       INTEGER REFERENCES vendors(id),
      unit_price      NUMERIC(14,2),
      total_amount    NUMERIC(14,2),
      delivery_days   INTEGER,
      payment_terms   VARCHAR(100),
      notes           TEXT,
      is_winner       BOOLEAN DEFAULT false,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (rfq_id, vendor_id)
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_rfq_quotes_rfq ON rfq_quotes(rfq_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_rfq_quotes_vendor ON rfq_quotes(vendor_id)`);

  // ── vendor_ratings: quality/delivery/price scoring per PO ────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS vendor_ratings (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id),
      vendor_id       INTEGER NOT NULL REFERENCES vendors(id),
      po_id           INTEGER REFERENCES purchase_orders(id),
      quality_score   INTEGER CHECK (quality_score BETWEEN 1 AND 5),
      delivery_score  INTEGER CHECK (delivery_score BETWEEN 1 AND 5),
      price_score     INTEGER CHECK (price_score BETWEEN 1 AND 5),
      overall_score   NUMERIC(3,1),
      comments        TEXT,
      rated_by        INTEGER REFERENCES employees(id),
      rated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_vendor_ratings_vendor ON vendor_ratings(vendor_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_vendor_ratings_company ON vendor_ratings(company_id)`);

  // ── three_way_matches: PO ↔ GRN ↔ Vendor Invoice reconciliation ───────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS three_way_matches (
      id                    SERIAL PRIMARY KEY,
      company_id            INTEGER REFERENCES companies(id),
      po_id                 INTEGER NOT NULL REFERENCES purchase_orders(id),
      grn_id                INTEGER,
      vendor_invoice_no     VARCHAR(100),
      vendor_invoice_date   DATE,
      vendor_invoice_amount NUMERIC(14,2) DEFAULT 0,
      po_amount             NUMERIC(14,2) DEFAULT 0,
      grn_amount            NUMERIC(14,2) DEFAULT 0,
      match_status          VARCHAR(30) DEFAULT 'pending',
      discrepancy_reason    TEXT,
      approved_by           INTEGER REFERENCES employees(id),
      approved_at           TIMESTAMPTZ,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_twm_company ON three_way_matches(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_twm_po ON three_way_matches(po_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_twm_status ON three_way_matches(match_status)`);

  // ── Ensure vendors has rating columns (may be missing in older installs) ───────
  await safe(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS quality_rating  NUMERIC(3,1) DEFAULT 0`);
  await safe(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS delivery_rating NUMERIC(3,1) DEFAULT 0`);
  await safe(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS price_rating    NUMERIC(3,1) DEFAULT 0`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS three_way_matches CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS vendor_ratings CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS rfq_quotes CASCADE`);
}
