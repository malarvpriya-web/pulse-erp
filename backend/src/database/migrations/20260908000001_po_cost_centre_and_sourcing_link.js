/**
 * Three columns the procurement module needed and did not have.
 *
 * 1. purchase_orders.cost_center_id
 *    A purchase order could be charged to a PROJECT and to nothing else. There
 *    was no cost-centre column anywhere in procurement — not in the schema, not
 *    in a route, not on a screen — so spend that belongs to a department rather
 *    than a project had no home. `cost_centers` has been populated all along.
 *    Header level, matching how project_id already works: one cost centre per
 *    order. A line-level split is a bigger change and every consumer of the PO
 *    total would have to learn to divide it.
 *
 * 2. purchase_orders.sourcing_strategy_id / followed_sourcing_strategy
 *    The sourcing board records a category's quadrant and the method chosen for
 *    it, freezes the facts it was decided against, and drives the approved
 *    vendor list and the price book. Nothing in the BUYING workflow referenced
 *    any of it, so a buyer could award straight past a recorded strategy and
 *    nothing noticed — the decision and the record of the decision never met.
 *
 *    These two columns are what makes them meet: which strategy was in force
 *    when the order was raised, and whether the order followed it.
 *
 *    ⚠ "followed" has a deliberately narrow meaning, because a broad one would
 *    be invention. A strategy names a METHOD ('function_spec', 'demand
 *    pooling') — there is no mechanical reading of an order that says whether a
 *    method was applied. What IS determinable is whether the vendor chosen is
 *    one the strategy's own selection approved: `approved_vendor_list` is
 *    written by selectPreferredVendor as part of recording the strategy. So
 *    `followed_sourcing_strategy` means "awarded to a vendor this category's
 *    strategy approved", and NULL means the question does not apply — no
 *    strategy on file, or no catalogued item to attribute one through. It is
 *    never guessed.
 *
 * 3. inventory_batches.company_id
 *    A batch is usable stock and had no tenant of its own; its company could
 *    only be inferred through the item or the warehouse it points at. That made
 *    every read of the table implicitly cross-tenant unless the caller
 *    remembered to join a parent. Backfilled from the item, then the warehouse,
 *    then the receipt's company — all three are assertions the schema already
 *    enforces, not guesses — and left NULL where none of them resolves.
 */

export async function up(knex) {
  // ── 1. cost centre on a purchase order ─────────────────────────────────────
  await knex.raw(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cost_center_id INTEGER`);
  await knex.raw(`ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_cost_center_id_fkey`);
  await knex.raw(`
    ALTER TABLE purchase_orders
      ADD CONSTRAINT purchase_orders_cost_center_id_fkey
      FOREIGN KEY (cost_center_id) REFERENCES cost_centers(id) ON DELETE SET NULL
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_po_cost_center ON purchase_orders(cost_center_id)`);

  // ── 2. the sourcing decision that was in force ─────────────────────────────
  await knex.raw(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS sourcing_strategy_id INTEGER`);
  await knex.raw(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS followed_sourcing_strategy BOOLEAN`);
  await knex.raw(`ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_sourcing_strategy_id_fkey`);
  await knex.raw(`
    ALTER TABLE purchase_orders
      ADD CONSTRAINT purchase_orders_sourcing_strategy_id_fkey
      FOREIGN KEY (sourcing_strategy_id) REFERENCES sourcing_category_strategies(id) ON DELETE SET NULL
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_po_sourcing_strategy ON purchase_orders(sourcing_strategy_id)`);

  // ── 3. a batch belongs to a company ────────────────────────────────────────
  await knex.raw(`ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await knex.raw(`ALTER TABLE inventory_batches DROP CONSTRAINT IF EXISTS inventory_batches_company_id_fkey`);
  await knex.raw(`
    ALTER TABLE inventory_batches
      ADD CONSTRAINT inventory_batches_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
  `);

  const { rows: byItem } = await knex.raw(`
    UPDATE inventory_batches b SET company_id = i.company_id
      FROM inventory_items i
     WHERE b.company_id IS NULL AND b.item_id = i.id AND i.company_id IS NOT NULL
    RETURNING b.id`);
  const { rows: byWarehouse } = await knex.raw(`
    UPDATE inventory_batches b SET company_id = w.company_id
      FROM warehouses w
     WHERE b.company_id IS NULL AND b.warehouse_id = w.id AND w.company_id IS NOT NULL
    RETURNING b.id`);
  const { rows: byGrn } = await knex.raw(`
    UPDATE inventory_batches b SET company_id = g.company_id
      FROM goods_receipt_notes g
     WHERE b.company_id IS NULL AND b.grn_id = g.id AND g.company_id IS NOT NULL
    RETURNING b.id`);
  const { rows: [orphan] } = await knex.raw(
    `SELECT COUNT(*)::int AS n FROM inventory_batches WHERE company_id IS NULL`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_inventory_batches_company ON inventory_batches(company_id)`);

  console.log(
    `[20260908000001] purchase_orders.cost_center_id, .sourcing_strategy_id and ` +
    `.followed_sourcing_strategy added; inventory_batches.company_id added and backfilled ` +
    `(${byItem.length} via item, ${byWarehouse.length} via warehouse, ${byGrn.length} via receipt, ` +
    `${orphan.n} left unattributed).`
  );
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_inventory_batches_company`);
  await knex.raw(`ALTER TABLE inventory_batches DROP CONSTRAINT IF EXISTS inventory_batches_company_id_fkey`);
  await knex.raw(`ALTER TABLE inventory_batches DROP COLUMN IF EXISTS company_id`);
  await knex.raw(`DROP INDEX IF EXISTS idx_po_sourcing_strategy`);
  await knex.raw(`ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_sourcing_strategy_id_fkey`);
  await knex.raw(`ALTER TABLE purchase_orders DROP COLUMN IF EXISTS followed_sourcing_strategy`);
  await knex.raw(`ALTER TABLE purchase_orders DROP COLUMN IF EXISTS sourcing_strategy_id`);
  await knex.raw(`DROP INDEX IF EXISTS idx_po_cost_center`);
  await knex.raw(`ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_cost_center_id_fkey`);
  await knex.raw(`ALTER TABLE purchase_orders DROP COLUMN IF EXISTS cost_center_id`);
}
