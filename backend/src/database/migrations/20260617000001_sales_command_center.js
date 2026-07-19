export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_scc_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|multiple primary/i.test(err.message || '')) throw err;
    }
  };

  // ── Enhance sales_targets with order/margin/team/region targets ──────────────
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS target_orders    INTEGER DEFAULT 0`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS target_margin    NUMERIC(15,2) DEFAULT 0`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS achieved_orders  INTEGER DEFAULT 0`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS achieved_margin  NUMERIC(15,2) DEFAULT 0`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS department_id    INTEGER`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS target_type      VARCHAR(20) DEFAULT 'individual'`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS team_name        VARCHAR(255)`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS region           VARCHAR(255)`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS business_unit    VARCHAR(255)`);
  await safe(`ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS commission_rate  NUMERIC(5,2) DEFAULT 0`);

  // ── Add product_line + customer category to opportunities ────────────────────
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS product_line      VARCHAR(100)`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS customer_category VARCHAR(100)`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS competitor        VARCHAR(255)`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS lost_reason       TEXT`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS region            VARCHAR(255)`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS business_unit     VARCHAR(255)`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS margin_amount     NUMERIC(15,2) DEFAULT 0`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS margin_pct        NUMERIC(5,2) DEFAULT 0`);
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS sales_cycle_days  INTEGER`);

  // ── Add product_line to quotations ───────────────────────────────────────────
  await safe(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS product_line     VARCHAR(100)`);
  await safe(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS business_unit    VARCHAR(255)`);
  await safe(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS region           VARCHAR(255)`);
  await safe(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS margin_amount    NUMERIC(15,2) DEFAULT 0`);
  await safe(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS margin_pct       NUMERIC(5,2) DEFAULT 0`);
  await safe(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS salesperson_id   INTEGER`);

  // ── Add product_line to sales_orders ─────────────────────────────────────────
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS product_line     VARCHAR(100)`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS business_unit    VARCHAR(255)`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS region           VARCHAR(255)`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS margin_amount    NUMERIC(15,2) DEFAULT 0`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS margin_pct       NUMERIC(5,2) DEFAULT 0`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS salesperson_id   INTEGER`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS salesperson_name VARCHAR(255)`);

  // ── Commission rules table ────────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS sales_commission_rules (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER,
      name            VARCHAR(255) NOT NULL,
      rule_type       VARCHAR(50) DEFAULT 'revenue',
      base_type       VARCHAR(50) DEFAULT 'revenue',
      threshold_min   NUMERIC(15,2) DEFAULT 0,
      threshold_max   NUMERIC(15,2),
      rate_pct        NUMERIC(5,2) DEFAULT 0,
      is_active       BOOLEAN DEFAULT true,
      applies_to      VARCHAR(50) DEFAULT 'all',
      created_by      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Sales alerts table ────────────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS sales_alerts (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER,
      alert_type      VARCHAR(100) NOT NULL,
      severity        VARCHAR(20) DEFAULT 'warning',
      title           VARCHAR(255),
      message         TEXT,
      entity_type     VARCHAR(100),
      entity_id       INTEGER,
      entity_name     VARCHAR(255),
      assigned_to     INTEGER,
      is_read         BOOLEAN DEFAULT false,
      is_dismissed    BOOLEAN DEFAULT false,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Performance indexes ───────────────────────────────────────────────────────
  await safe(`CREATE INDEX IF NOT EXISTS idx_opp_product_line     ON opportunities(product_line) WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_opp_stage_company    ON opportunities(stage, company_id) WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_so_product_line      ON sales_orders(product_line) WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_so_salesperson_id    ON sales_orders(salesperson_id) WHERE deleted_at IS NULL`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_st_type_company      ON sales_targets(target_type, company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_sales_alerts_company ON sales_alerts(company_id, is_dismissed)`);
}

export async function down(knex) {}
