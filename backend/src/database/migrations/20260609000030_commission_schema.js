export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_comm_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate/.test(err.message || '')) throw err;
    }
  };

  // ── commission_plans ──────────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS commission_plans (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id           INTEGER NOT NULL,
      name                 VARCHAR(255) NOT NULL,
      rep_id               INTEGER,
      rep_name             VARCHAR(255),
      plan_type            VARCHAR(30) DEFAULT 'percentage',
      base_rate_pct        NUMERIC(10,2) DEFAULT 0,
      tiered_slabs         JSONB DEFAULT '[]',
      applies_to           VARCHAR(50) DEFAULT 'all_products',
      product_ids          JSONB DEFAULT '[]',
      effective_from       DATE,
      effective_to         DATE,
      clawback_period_days INTEGER DEFAULT 30,
      is_active            BOOLEAN DEFAULT true,
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_commission_plans_company ON commission_plans(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_commission_plans_rep ON commission_plans(rep_id)`);

  // ── commission_entries ────────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS commission_entries (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id       INTEGER NOT NULL,
      plan_id          UUID REFERENCES commission_plans(id),
      rep_id           INTEGER,
      rep_name         VARCHAR(255),
      order_id         INTEGER,
      order_ref        VARCHAR(100),
      customer_name    VARCHAR(255),
      sale_amount      NUMERIC(14,2) DEFAULT 0,
      commission_rate  NUMERIC(5,2) DEFAULT 0,
      commission_amount NUMERIC(14,2) DEFAULT 0,
      earned_date      TIMESTAMPTZ DEFAULT NOW(),
      status           VARCHAR(20) DEFAULT 'pending',
      clawback_reason  TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_commission_entries_company ON commission_entries(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_commission_entries_rep ON commission_entries(rep_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_commission_entries_status ON commission_entries(company_id, status)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_commission_entries_year ON commission_entries(company_id, earned_date)`);

  // ── commission_payouts ────────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS commission_payouts (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id       INTEGER NOT NULL,
      rep_id           INTEGER,
      rep_name         VARCHAR(255),
      period_from      DATE,
      period_to        DATE,
      total_commission NUMERIC(14,2) DEFAULT 0,
      deductions       NUMERIC(14,2) DEFAULT 0,
      net_payout       NUMERIC(14,2) DEFAULT 0,
      status           VARCHAR(20) DEFAULT 'draft',
      payment_date     DATE,
      remarks          TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_commission_payouts_company ON commission_payouts(company_id)`);

  // ── Seed default plan for each existing company ───────────────────────────
  await safe(`
    INSERT INTO commission_plans (company_id, name, plan_type, base_rate_pct, applies_to, is_active)
    SELECT id, 'Standard Commission Plan', 'percentage', 5.00, 'all_products', true
    FROM companies
    ON CONFLICT DO NOTHING
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS commission_payouts');
  await knex.raw('DROP TABLE IF EXISTS commission_entries');
  await knex.raw('DROP TABLE IF EXISTS commission_plans');
}
