/**
 * 20260916000002_serial_customer_uuid.js
 *
 * Corrects `serial_numbers.customer_id`, added as `integer` in
 * 20260915000019 — it has to be `uuid`.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * The packing path stamps the customer onto a shipped unit by reading it from
 * the sales order the pick list belongs to. `sales_orders.customer_id` is a
 * uuid; the new column was an integer, so the write failed outright:
 *
 *     COALESCE types uuid and integer cannot be matched
 *
 * This is the uuid-vs-integer key split that runs through the CRM side of this
 * schema and has bitten before — customer identity is a uuid on the sales and
 * party tables while most operational tables key on integers. Guessing the type
 * from its neighbours in `serial_numbers` (all integers) rather than from the
 * column it is populated FROM is what produced the mismatch.
 *
 * ── WHY A TYPE CHANGE IS SAFE HERE ──────────────────────────────────────────
 * The column was added yesterday, nothing has ever written to it (the write was
 * failing, which is how this was found), and it is confirmed 100% NULL below
 * before the type is altered. If a value were ever present this would have to be
 * a new column and a migration of the data, because USING a cast from integer to
 * uuid is not defined — the guard makes that condition explicit rather than
 * relying on it being remembered.
 */

export async function up(knex) {
  const { rows: [t] } = await knex.raw(`
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'serial_numbers' AND column_name = 'customer_id'`);
  if (!t || t.data_type === 'uuid') return;

  const { rows: [{ n }] } = await knex.raw(
    `SELECT COUNT(*)::int AS n FROM serial_numbers WHERE customer_id IS NOT NULL`);
  if (n > 0) {
    // Refuse rather than destroy. There is no defined cast from integer to
    // uuid, so any value here would have to be mapped deliberately.
    throw new Error(
      `serial_numbers.customer_id holds ${n} non-null integer value(s); it cannot be `
      + `converted to uuid automatically. Map those rows to customer uuids first.`);
  }

  await knex.raw(`ALTER TABLE serial_numbers DROP COLUMN IF EXISTS customer_id`);
  await knex.raw(`ALTER TABLE serial_numbers ADD COLUMN customer_id uuid`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_serial_customer
      ON serial_numbers (customer_id) WHERE customer_id IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE serial_numbers DROP COLUMN IF EXISTS customer_id`);
  await knex.raw(`ALTER TABLE serial_numbers ADD COLUMN customer_id integer`);
}
