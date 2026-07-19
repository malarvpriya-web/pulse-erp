export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_soh_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate/.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS company_id UUID`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS invoice_id UUID`);
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS invoiced_at TIMESTAMPTZ`);

  await safe(`
    CREATE INDEX IF NOT EXISTS idx_so_company_status
    ON sales_orders(company_id, order_status)
    WHERE deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_so_company_status`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS invoiced_at`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS invoice_id`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS cancel_reason`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS customer_name`);
}
