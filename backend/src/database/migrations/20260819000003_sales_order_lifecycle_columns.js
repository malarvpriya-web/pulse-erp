/**
 * Sales order lifecycle columns.
 *
 * Surfaced by the INSERT/UPDATE-target pass added to
 * scripts/check-sql-references.mjs during the CRM remediation (2026-08-19). The
 * checker previously validated only qualified `alias.col` references, so these
 * unqualified UPDATE targets were invisible to it — and both write paths had
 * been throwing 42703 at runtime:
 *
 *   • POST /sales/orders/:id/invoice  → sales_orders.invoiced_at, .invoice_id
 *   • POST /sales/orders/:id/cancel   → sales_orders.cancel_reason
 *
 * Invoicing and cancelling a sales order are the two transitions that close the
 * Lead → … → Invoice chain the CRM audit traced, so leaving them broken would
 * have left that chain severed at its last hop no matter what CRM did.
 *
 * `invoice_id` is intentionally NOT declared as a foreign key here: the invoicing
 * route writes whatever id its own invoice-creation step returns, and pinning a
 * constraint to `invoices` without first auditing that path could reject legitimate
 * writes. It is indexed instead.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS invoiced_at   timestamptz;`);
  await knex.raw(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS invoice_id    integer;`);
  await knex.raw(`ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS cancel_reason text;`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sales_orders_invoice
      ON sales_orders (invoice_id) WHERE invoice_id IS NOT NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_sales_orders_invoice;`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS cancel_reason;`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS invoice_id;`);
  await knex.raw(`ALTER TABLE sales_orders DROP COLUMN IF EXISTS invoiced_at;`);
}
