export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_fulfilment_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist/.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS delivered_at  TIMESTAMPTZ`);

  await safe(`
    CREATE TABLE IF NOT EXISTS customer_credit_settings (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id        INTEGER NOT NULL,
      account_id        INTEGER NOT NULL,
      credit_limit      NUMERIC(14,2) DEFAULT 0,
      credit_terms_days INTEGER DEFAULT 30,
      is_blocked        BOOLEAN DEFAULT false,
      block_reason      TEXT,
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, account_id)
    )
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_ccs_company_account ON customer_credit_settings(company_id, account_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS customer_credit_settings`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS dispatched_at`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS delivered_at`);
}
