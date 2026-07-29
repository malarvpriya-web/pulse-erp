/**
 * 20260728000001_rfq_items.js
 *
 * `rfqs` has always been schema-level single-item (item_description/quantity/
 * unit as scalar columns on the header) — flagged repeatedly across the
 * enterprise workflow audit as a real feature gap, not a wiring bug: unlike
 * purchase_requests/purchase_orders, there was no child table to carry more
 * than one line per RFQ. Adds `rfq_items` mirroring purchase_request_items'
 * shape (item_id/item_name/quantity/unit/required_date/remarks).
 *
 * Backfills one rfq_items row per existing rfqs row from its own scalar
 * fields, so every RFQ — old and new — has a real line under the new model
 * going forward. The header's scalar columns are left in place (not dropped)
 * as a summary of line #1, since several existing read paths (list view,
 * award's PR-linked-items fallback) still reference them directly.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_rfqitems_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`
    CREATE TABLE IF NOT EXISTS rfq_items (
      id SERIAL PRIMARY KEY,
      rfq_id INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES inventory_items(id),
      item_name VARCHAR(300),
      quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
      unit VARCHAR(20) DEFAULT 'Nos',
      required_date DATE,
      remarks TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_rfq_items_rfq ON rfq_items(rfq_id)`);

  await safe(`
    INSERT INTO rfq_items (rfq_id, item_name, quantity, unit, required_date)
    SELECT r.id, r.item_description, COALESCE(r.quantity, 1), COALESCE(r.unit, 'Nos'), r.required_by
    FROM rfqs r
    WHERE NOT EXISTS (SELECT 1 FROM rfq_items ri WHERE ri.rfq_id = r.id)
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS rfq_items`);
}
