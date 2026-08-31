/**
 * purchase_requests — the columns the MRP auto-raise writes.
 *
 * Two MRP paths raise purchase requests automatically (`bom.routes.js` on an MRP
 * run, `execution.routes.js` on a material shortfall). Both write `item_id`,
 * `qty_requested`, `estimated_cost` and `raised_by`; the table has `quantity`
 * and `requested_by_employee_id`, and no item_id or estimated_cost at all — so
 * every auto-raised PR threw 42703 and MRP has never actually produced one.
 *
 * `item_id` and `estimated_cost` are added (a PR line legitimately points at an
 * inventory item and carries an expected value); `qty_requested` and
 * `raised_by` are renamed in the callers onto the columns that already exist.
 *
 * The two callers also disagreed about `raised_by`: bom.routes passed the string
 * 'MRP System' while execution.routes passed an employee id. Since the column is
 * an employee FK, a system-generated request now records NULL and says so in
 * `notes`, rather than pretending a person raised it.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE purchase_requests
      ADD COLUMN IF NOT EXISTS item_id integer REFERENCES inventory_items(id) ON DELETE SET NULL;
  `);
  await knex.raw(`ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS estimated_cost numeric(18,2);`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_purchase_requests_item
      ON purchase_requests (item_id) WHERE item_id IS NOT NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_purchase_requests_item;`);
  await knex.raw(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS estimated_cost;`);
  await knex.raw(`ALTER TABLE purchase_requests DROP COLUMN IF EXISTS item_id;`);
}
