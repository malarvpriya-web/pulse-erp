/**
 * Multi-currency capture for invoices/bills — closes the gap flagged in
 * MODULE_FEATURE_CONNECTION_MANUAL.md §24 Addendum 3: `forex.routes.js`'s
 * `/exposure` and `/revaluations` have always silently returned empty
 * because neither `invoices` nor `bills` ever captured a per-document
 * currency or exchange rate, so there was no foreign-currency data for
 * those queries to find even after the `supplier_bills`->`bills` table
 * name was fixed (Addendum 3).
 *
 * `exchange_rate` is the "booked rate" at document creation time —
 * forex.routes.js's revaluation logic already expects this exact column
 * name (`COALESCE(exchange_rate, 1) AS booked_rate`) and compares it
 * against the live `forex_rates` table to compute gain/loss, so the
 * column name here is not a free choice, it must match what that code
 * already reads.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(15,6) NOT NULL DEFAULT 1
  `);
  await knex.raw(`
    ALTER TABLE bills
      ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(15,6) NOT NULL DEFAULT 1
  `);
}

export async function down(knex) {
  await knex.raw('ALTER TABLE invoices DROP COLUMN IF EXISTS currency, DROP COLUMN IF EXISTS exchange_rate');
  await knex.raw('ALTER TABLE bills DROP COLUMN IF EXISTS currency, DROP COLUMN IF EXISTS exchange_rate');
}
