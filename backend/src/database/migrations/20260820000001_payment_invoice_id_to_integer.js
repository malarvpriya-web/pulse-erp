/**
 * payment_transactions.invoice_id / payment_gateway_orders.invoice_id — uuid → integer.
 *
 * Both columns were declared `uuid`, but `invoices.id` is an `integer` and no
 * uuid-keyed invoice table exists anywhere in the schema. The consequence is
 * that neither table could ever be joined to an invoice: /api/payments/history
 * failed with `operator does not exist: integer = uuid` and
 * /api/payments/unpaid-invoices with `operator does not exist: uuid = integer`.
 * The whole payment-gateway feature was structurally unable to link a payment
 * to the invoice it paid.
 *
 * There was never any production data behind it — both tables held 0 rows — so
 * the columns are retyped and given the foreign key they always implied. The
 * guard below refuses to run if anything real has since been written, because a
 * uuid cannot be mapped onto an integer invoice id without losing the link.
 */

const TABLES = ['payment_transactions', 'payment_gateway_orders'];

export async function up(knex) {
  for (const table of TABLES) {
    const { rows } = await knex.raw(
      `SELECT COUNT(*)::int AS n FROM ${table} WHERE invoice_id IS NOT NULL`
    );
    if ((rows[0]?.n ?? 0) > 0) {
      throw new Error(
        `${table} has ${rows[0].n} row(s) with a uuid invoice_id that cannot be ` +
        `mapped to invoices.id (integer). Clear or re-key them before migrating.`
      );
    }
  }

  for (const table of TABLES) {
    await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_invoice_id_fkey;`);
    await knex.raw(`
      ALTER TABLE ${table}
        ALTER COLUMN invoice_id TYPE integer USING NULL;
    `);
    await knex.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_invoice_id_fkey
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
    `);
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_${table}_invoice_id ON ${table}(invoice_id);`);
  }
}

export async function down(knex) {
  for (const table of TABLES) {
    await knex.raw(`DROP INDEX IF EXISTS idx_${table}_invoice_id;`);
    await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_invoice_id_fkey;`);
    await knex.raw(`
      ALTER TABLE ${table}
        ALTER COLUMN invoice_id TYPE uuid USING NULL;
    `);
  }
}
