/**
 * `quotation_items` has never had the columns quotationsRepository.addItem()/
 * getItems() actually read and write (`item_description`, `rate`,
 * `tax_percentage`, `tax_amount`, `total`) -- confirmed live via
 * information_schema, not assumed. `POST /quotations/:id/items` has been
 * 500ing on every single real call: "column \"item_description\" of relation
 * \"quotation_items\" does not exist".
 *
 * Root cause: `20260609000001_quotations_company_scoping.js` (June 9) tried
 * to add these columns, but `quotation_items` wasn't created until
 * `20260620000002_missing_tables_and_columns.js` (June 20) -- a migration-
 * ordering inversion. The June 9 migration wraps every ALTER in a savepoint
 * with try/catch + console.warn (to survive drift across environments), so
 * the "relation does not exist" error was silently swallowed and logged
 * instead of failing the migration -- it shows as cleanly "applied" in the
 * ledger despite every quotation_items statement inside it having no-op'd.
 *
 * Same fix pattern as `20260729000002_sales_orders_dispatch_columns_drift_fix.js`:
 * ADD COLUMN IF NOT EXISTS is safe and idempotent regardless of what the
 * ledger believes already ran, so this just closes the gap directly rather
 * than editing migration history.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE quotation_items
      ADD COLUMN IF NOT EXISTS item_description VARCHAR(500),
      ADD COLUMN IF NOT EXISTS rate             NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_percentage    NUMERIC(5,2)  DEFAULT 18,
      ADD COLUMN IF NOT EXISTS tax_amount        NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total             NUMERIC(12,2) DEFAULT 0
  `);
  // Same backfill the June 9 migration intended for any pre-existing rows.
  await knex.raw(`
    UPDATE quotation_items
    SET item_description = description
    WHERE item_description IS NULL AND description IS NOT NULL
  `);
  await knex.raw(`
    UPDATE quotation_items
    SET rate = unit_price
    WHERE rate = 0 AND unit_price > 0
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE quotation_items
      DROP COLUMN IF EXISTS item_description,
      DROP COLUMN IF EXISTS rate,
      DROP COLUMN IF EXISTS tax_percentage,
      DROP COLUMN IF EXISTS tax_amount,
      DROP COLUMN IF EXISTS total
  `);
}
