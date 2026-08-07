/**
 * `bill_items` never existed in the live schema — found while live-testing
 * the invoice/bill currency capture feature (this same migration set):
 * `POST /finance/bills` with even one line item hard-500'd
 * (`relation "bill_items" does not exist`), and `bill.service.js`'s
 * `createBill` runs the item insert inside the same transaction as the
 * bill header, so the whole bill creation rolled back. `SupplierBills.jsx`'s
 * form always sends at least one item (`items: [emptyItem()]`), so this
 * was not an edge case — creating any supplier bill through the real UI
 * has been completely broken. `invoice_items` is the live sibling table
 * and was used as the shape reference, trimmed to the columns
 * `bill.repository.js`'s `createItem()` actually writes
 * (`bill_id, description, quantity, unit_price, tax_rate, amount`).
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bill_items (
      id          SERIAL PRIMARY KEY,
      bill_id     INT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity    NUMERIC(10,2) NOT NULL DEFAULT 1,
      unit_price  NUMERIC(15,2) NOT NULL,
      tax_rate    NUMERIC(5,2) DEFAULT 0,
      amount      NUMERIC(15,2) NOT NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id)`);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS bill_items CASCADE');
}
