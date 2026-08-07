/**
 * payment_allocations / receipt_allocations were referenced by
 * payment.repository.js's createAllocation() (both the payment-side and
 * receipt-side overloads) since the module was built, but neither table
 * was ever migrated into the live schema — confirmed via
 * information_schema (`EXISTS` false for both) and reproduced live: every
 * bill payment with an allocation (SupplierBills.jsx's "Pay" button,
 * PaymentBatch processing) 500s with `relation "payment_allocations"
 * does not exist` and rolls back the whole payment transaction, since the
 * insert isn't guarded like the forex.routes.js queries are. Same root
 * cause and same fix shape hits receipt_allocations on the AR side.
 * See MODULE_FEATURE_CONNECTION_MANUAL.md §24 Addendum 4.
 *
 * Column types follow the LIVE tables (payments.id / bills.id /
 * receipts.id / invoices.id are all `integer`), not the `uuid` a legacy
 * reference schema (backend/database/finance-schema.sql) assumed — that
 * file was never actually applied to this database and its types are
 * stale for this app's real key scheme.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payment_allocations (
      id               SERIAL PRIMARY KEY,
      payment_id       INT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      bill_id          INT REFERENCES bills(id),
      allocated_amount NUMERIC(15,2) NOT NULL,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_payment_alloc_payment ON payment_allocations(payment_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_payment_alloc_bill ON payment_allocations(bill_id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS receipt_allocations (
      id               SERIAL PRIMARY KEY,
      receipt_id       INT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
      invoice_id       INT NOT NULL REFERENCES invoices(id),
      allocated_amount NUMERIC(15,2) NOT NULL,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_receipt_alloc_receipt ON receipt_allocations(receipt_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_receipt_alloc_invoice ON receipt_allocations(invoice_id)`);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS payment_allocations CASCADE');
  await knex.raw('DROP TABLE IF EXISTS receipt_allocations CASCADE');
}
