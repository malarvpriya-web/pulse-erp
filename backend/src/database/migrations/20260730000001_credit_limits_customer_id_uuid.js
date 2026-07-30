/**
 * `credit_limits.customer_id` is a legacy INTEGER column that was never
 * migrated to match `parties.id` (uuid) -- every other customer-identity
 * column in Sales/Finance uses the uuid. Confirmed live: every quotation-to-
 * sales-order conversion gate in sales.routes.js (`accept-and-convert`,
 * `convert-to-order`, `orders/from-quotation`) does
 * `SELECT ... FROM credit_limits WHERE customer_id = $1` passing a real
 * `quotation.customer_id` uuid -- this throws "invalid input syntax for type
 * integer" unconditionally, for ANY quotation with a real customer attached,
 * regardless of whether credit_limits has any rows. Every prior audit pass
 * that claimed this gate was "fixed and working" only ever re-read the query
 * shape; nobody ran it live against a quotation with a real customer_id.
 * `finance/routes/extended.routes.js`'s own GET /credit-limits already joins
 * `cl.customer_id = p.id` against `parties`, confirming uuid was always the
 * intended type -- it was just never applied to the column.
 *
 * Safe as a direct type change, not an additive bridge column: table has 0
 * live rows (confirmed via COUNT(*) before writing this), and neither
 * POST /sales/credit-limits nor POST /sales/credit-check has any frontend
 * caller anywhere in the app (grepped) -- this table has been fully
 * unreachable from any real screen since it was built.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE credit_limits
      ALTER COLUMN customer_id TYPE uuid USING NULL::uuid,
      ADD CONSTRAINT credit_limits_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES parties(id)
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE credit_limits
      DROP CONSTRAINT IF EXISTS credit_limits_customer_id_fkey,
      ALTER COLUMN customer_id TYPE integer USING NULL::integer
  `);
}
