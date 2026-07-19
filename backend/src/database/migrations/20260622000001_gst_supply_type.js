export async function up(knex) {
  const safe = async (sql) => {
    try {
      await knex.raw(`SAVEPOINT m`);
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT m`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT m`);
      if (!/already exists|does not exist/.test(err.message || '')) throw err;
    }
  };

  // supply_type: 'intra' = CGST+SGST (same state), 'inter' = IGST (different state)
  await safe(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS supply_type VARCHAR(10) DEFAULT 'intra' CHECK (supply_type IN ('intra','inter'))`);
  await safe(`ALTER TABLE quotations   ADD COLUMN IF NOT EXISTS supply_type VARCHAR(10) DEFAULT 'intra' CHECK (supply_type IN ('intra','inter'))`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_sales_orders_supply_type ON sales_orders(supply_type)`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS supply_type`);
  await knex.raw(`ALTER TABLE quotations   DROP COLUMN IF EXISTS supply_type`);
}
