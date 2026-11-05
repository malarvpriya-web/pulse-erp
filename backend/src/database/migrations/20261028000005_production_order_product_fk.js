/**
 * 20261028000005 — production_orders.product_id is a real reference.
 *
 * product_id had no foreign key, so a product-level QC requirement
 * (qc_requirements, 20261028000002) leaned on a column nothing guaranteed.
 * Inspected before adding the constraint (dev database, 2026-10-28):
 *   - every writer fills it with an inventory_items id: MRP conversion from
 *     mrp_planned_orders.item_id, POST /production-orders from the request
 *     (now validated against the company's items), lifecycle bootstrap leaves
 *     it NULL;
 *   - 5 of 11 rows carry one; all 5 name an existing inventory item of the
 *     same company with the same name (418–421); 0 orphans.
 *
 * The constraint is added NOT VALID and then validated in a separate step, so
 * an orphan written between inspection and migration would make the migration
 * stop loudly rather than be deleted or reassigned. ON DELETE NO ACTION: an
 * item a production order names cannot be deleted from under it.
 *
 * Rollback: down() drops the constraint and the index.
 */
export async function up(knex) {
  const { rows: [orphans] } = await knex.raw(`
    SELECT COUNT(*)::int AS n FROM production_orders po
     WHERE po.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inventory_items ii WHERE ii.id = po.product_id)`);
  if (orphans.n > 0) {
    throw new Error(`production_orders has ${orphans.n} product_id value(s) naming no inventory item; resolve them before this migration (nothing was changed)`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_production_orders_product ON production_orders (product_id) WHERE product_id IS NOT NULL`);
  const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = 'production_orders_product_id_fkey'`);
  if (!rows.length) {
    await knex.raw(`
      ALTER TABLE production_orders
        ADD CONSTRAINT production_orders_product_id_fkey
        FOREIGN KEY (product_id) REFERENCES inventory_items(id) NOT VALID
    `);
  }
  await knex.raw(`ALTER TABLE production_orders VALIDATE CONSTRAINT production_orders_product_id_fkey`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE production_orders DROP CONSTRAINT IF EXISTS production_orders_product_id_fkey`);
  await knex.raw(`DROP INDEX IF EXISTS ix_production_orders_product`);
}
