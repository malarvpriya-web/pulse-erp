/**
 * Make on-hand stock STRUCTURALLY equal to the ledger, not merely reconciled to it.
 *
 * THE PROBLEM WITH RECONCILING
 * ----------------------------
 * The 2026-09-11 audit found inventory_items.current_stock and stock_ledger 100%
 * divergent: every item's ledger balance was 0 while current_stock read 10006 /
 * 12 / 8 / 15 / 3. It was reconciled, a reconciliation endpoint was added — and
 * then, during the verification run for that very fix, it drifted AGAIN by 208
 * units on one item.
 *
 * That second drift is the important one. It proves the invariant cannot be held
 * by discipline. current_stock was a second, independently-writable copy of a
 * number the ledger already determines, and every path that forgot to update
 * both — a seeding script, a test teardown, a future call site nobody has
 * written yet — silently desynchronised the figure that MRP, valuation, ATP and
 * allocation all read.
 *
 * THE FIX
 * -------
 * current_stock becomes DERIVED. A row-level trigger on stock_ledger recomputes
 * it from SUM(quantity_in - quantity_out) after every insert, update or delete.
 * There is now exactly one way to change stock — write a ledger row — and no way
 * to get it wrong, including by deleting ledger rows, which now corrects the
 * balance instead of orphaning it.
 *
 * WHY NOT A GENERATED COLUMN OR A VIEW: both would be cleaner, and both are
 * ruled out by how much code reads and filters on inventory_items.current_stock
 * directly. A trigger keeps the column where every existing query expects it
 * while removing the ability to write it independently.
 *
 * postStock() loses its manual UPDATE in the same commit — with the trigger in
 * place it would double-count. It remains the correct entry point for stock
 * movement; it simply no longer maintains the copy by hand.
 *
 * An UPDATE that moves a row to a different item syncs BOTH items, which a naive
 * trigger misses and which would leave the old item permanently overstated.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION sync_item_current_stock() RETURNS trigger AS $fn$
    DECLARE
      new_item INTEGER := CASE WHEN TG_OP <> 'DELETE' THEN NEW.item_id END;
      old_item INTEGER := CASE WHEN TG_OP <> 'INSERT' THEN OLD.item_id END;
    BEGIN
      IF new_item IS NOT NULL THEN
        UPDATE inventory_items ii
           SET current_stock = COALESCE(
                 (SELECT SUM(sl.quantity_in - sl.quantity_out)
                    FROM stock_ledger sl WHERE sl.item_id = new_item), 0),
               updated_at = NOW()
         WHERE ii.id = new_item;
      END IF;

      -- A ledger row that moved between items leaves the ORIGINAL item wrong
      -- unless it is recomputed too.
      IF old_item IS NOT NULL AND old_item IS DISTINCT FROM new_item THEN
        UPDATE inventory_items ii
           SET current_stock = COALESCE(
                 (SELECT SUM(sl.quantity_in - sl.quantity_out)
                    FROM stock_ledger sl WHERE sl.item_id = old_item), 0),
               updated_at = NOW()
         WHERE ii.id = old_item;
      END IF;

      RETURN NULL;  -- AFTER trigger: the return value is discarded
    END
    $fn$ LANGUAGE plpgsql`);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_stock_ledger_sync ON stock_ledger`);
  await knex.raw(`
    CREATE TRIGGER trg_stock_ledger_sync
    AFTER INSERT OR UPDATE OR DELETE ON stock_ledger
    FOR EACH ROW EXECUTE FUNCTION sync_item_current_stock()`);

  // One-time correction of everything that drifted before the trigger existed.
  // Items with no ledger history hold no stock: saying otherwise is precisely
  // the fiction this migration removes.
  await knex.raw(`
    UPDATE inventory_items ii
       SET current_stock = COALESCE(l.bal, 0), updated_at = NOW()
      FROM (SELECT i.id, (SELECT SUM(sl.quantity_in - sl.quantity_out)
                            FROM stock_ledger sl WHERE sl.item_id = i.id) AS bal
              FROM inventory_items i) l
     WHERE l.id = ii.id
       AND ii.current_stock IS DISTINCT FROM COALESCE(l.bal, 0)`);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_stock_ledger_sync ON stock_ledger`);
  await knex.raw(`DROP FUNCTION IF EXISTS sync_item_current_stock()`);
}
