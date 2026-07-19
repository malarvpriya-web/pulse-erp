/**
 * 20260716000002_po_items_received_quantity.js
 *
 * The GRN receipt path writes/reads purchase_order_items.received_quantity
 * (poRepo.updateItemReceived + grn.service allReceived check), but no migration
 * ever created that column — the base schema only defined `received_qty`.
 * On a DB that matches the migrations this makes GRN receipt against PO lines
 * throw ("column received_quantity does not exist") or silently never mark
 * lines received. This idempotently ensures the column exists and backfills it
 * from the legacy `received_qty` so receiving works for both freshly-converted
 * POs and any historical rows.
 */
export async function up(pool) {
  const safe = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[po_items_received_quantity] skip (${label}): ${e.message.split('\n')[0]}`); }
  };

  await safe('poi add received_quantity',
    `ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS received_quantity NUMERIC(12,2) DEFAULT 0`);

  // Backfill from the legacy received_qty column when it exists and holds data.
  await safe('poi backfill received_quantity from received_qty', `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchase_order_items' AND column_name = 'received_qty'
      ) THEN
        UPDATE purchase_order_items
           SET received_quantity = received_qty
         WHERE COALESCE(received_quantity, 0) = 0
           AND COALESCE(received_qty, 0) <> 0;
      END IF;
    END $$;
  `);
}

export async function down(pool) {
  const safe = async (sql) => { try { await pool.query(sql); } catch (_) {} };
  await safe(`ALTER TABLE purchase_order_items DROP COLUMN IF EXISTS received_quantity`);
}
