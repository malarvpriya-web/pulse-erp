/**
 * Phase 46 Fix — Add company_id to procurement tables
 *
 * purchase_orders and vendors were the last procurement tables without
 * multi-tenant isolation. purchase_order_items inherits scope via join.
 */
export async function up(knex) {
  let sp = 0;
  const tryAlter = async (sql) => {
    const name = `sp_proc_cid_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (err.message && err.message.includes('does not exist')) {
        console.warn(`[proc-cid] Skipped — ${err.message.split('\n')[0]}`);
      } else {
        throw err;
      }
    }
  };

  await tryAlter(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE vendors         ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE rfqs            ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE grn             ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_po_company_id     ON purchase_orders(company_id)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_vendors_company_id ON vendors(company_id)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_grn_company_id    ON grn(company_id)`);
}

export async function down(knex) {
  await knex.schema.table('purchase_orders',   t => t.dropColumn('company_id')).catch(() => {});
  await knex.schema.table('vendors',           t => t.dropColumn('company_id')).catch(() => {});
  await knex.schema.table('rfqs',              t => t.dropColumn('company_id')).catch(() => {});
  await knex.schema.table('grn',               t => t.dropColumn('company_id')).catch(() => {});
  await knex.schema.table('purchase_requests', t => t.dropColumn('company_id')).catch(() => {});
}
