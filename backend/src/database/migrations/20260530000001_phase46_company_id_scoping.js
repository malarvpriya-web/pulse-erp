/**
 * Phase 46 — Multi-tenant company_id scoping
 *
 * Adds company_id to all financial, inventory, audit, and operational tables
 * that were missing tenant isolation. All columns are nullable — no backfill
 * needed for existing single-tenant data.
 *
 * Each ALTER TABLE runs through a SAVEPOINT so a missing table skips gracefully
 * rather than aborting the whole migration.
 */
export async function up(knex) {
  let sp = 0;
  const tryAlter = async (sql) => {
    const name = `sp46_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (err.message && err.message.includes('does not exist')) {
        console.warn(`[phase46] Skipped — ${err.message.split('\n')[0]}`);
      } else {
        throw err;
      }
    }
  };

  // ── Add company_id columns (one per statement so missing tables are skipped)
  await tryAlter(`ALTER TABLE invoices       ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE bills          ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE payments       ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE receipts       ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE parties        ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE bank_accounts  ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE audit_logs     ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE stock_ledger   ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE rm_issues      ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE warehouses     ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE assets_register        ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE maintenance_schedules  ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE maintenance_logs       ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // ── Indexes on new company_id columns ────────────────────────────────────────
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_invoices_company_status
       ON invoices(company_id, status, invoice_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_bills_company_status
       ON bills(company_id, status, bill_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_company_date
       ON payments(company_id, payment_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_receipts_company_date
       ON receipts(company_id, receipt_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_parties_company_type
       ON parties(company_id, party_type)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_company_date
       ON audit_logs(company_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_stock_ledger_company_item
       ON stock_ledger(company_id, item_id, warehouse_id)`,
    `CREATE INDEX IF NOT EXISTS idx_inventory_items_company
       ON inventory_items(company_id)`,
  ];

  for (const sql of indexes) {
    await tryAlter(sql);
  }
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_invoices_company_status;
    DROP INDEX IF EXISTS idx_bills_company_status;
    DROP INDEX IF EXISTS idx_payments_company_date;
    DROP INDEX IF EXISTS idx_receipts_company_date;
    DROP INDEX IF EXISTS idx_parties_company_type;
    DROP INDEX IF EXISTS idx_audit_logs_company_date;
    DROP INDEX IF EXISTS idx_stock_ledger_company_item;
    DROP INDEX IF EXISTS idx_inventory_items_company;
    ALTER TABLE invoices       DROP COLUMN IF EXISTS company_id;
    ALTER TABLE bills          DROP COLUMN IF EXISTS company_id;
    ALTER TABLE payments       DROP COLUMN IF EXISTS company_id;
    ALTER TABLE receipts       DROP COLUMN IF EXISTS company_id;
    ALTER TABLE parties        DROP COLUMN IF EXISTS company_id;
    ALTER TABLE bank_accounts  DROP COLUMN IF EXISTS company_id;
    ALTER TABLE expense_claims DROP COLUMN IF EXISTS company_id;
    ALTER TABLE audit_logs     DROP COLUMN IF EXISTS company_id;
    ALTER TABLE stock_ledger   DROP COLUMN IF EXISTS company_id;
    ALTER TABLE rm_issues      DROP COLUMN IF EXISTS company_id;
    ALTER TABLE warehouses     DROP COLUMN IF EXISTS company_id;
    ALTER TABLE assets_register       DROP COLUMN IF EXISTS company_id;
    ALTER TABLE maintenance_schedules DROP COLUMN IF EXISTS company_id;
    ALTER TABLE maintenance_logs      DROP COLUMN IF EXISTS company_id;
  `);
}
