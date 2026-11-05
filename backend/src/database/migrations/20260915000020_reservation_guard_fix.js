/**
 * 20260915000020_reservation_guard_fix.js
 *
 * Corrects reservation_guard() from 20260915000019.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * The guard DID refuse over-reservation — but for the wrong reason, and with a
 * message that named none of it:
 *
 *     reserve 20 of an item with 10 left  ->  ERROR: record "new" has no field
 *                                             "qty_reserved"
 *
 * The RAISE EXCEPTION built its numbers from a COALESCE spanning BOTH reservation
 * tables' column names. plpgsql resolves every field reference in an expression
 * at runtime whether or not COALESCE would short-circuit it, so on
 * `inventory_reservations` — which has no `qty_reserved` — the statement threw
 * before it could report the actual over-commitment.
 *
 * That is the worse kind of passing test: the write was correctly refused, so a
 * test asserting "this is rejected" goes green, while the operator is handed an
 * internal error about a column instead of "only 10 on hand and 90 already
 * promised". It would also have masked a genuine regression — any later bug in
 * the quantity arithmetic would still have thrown this same error and still
 * looked like the guard working.
 *
 * ── THE FIX ─────────────────────────────────────────────────────────────────
 * The requested quantity is resolved into a variable inside the branch that
 * knows which table fired, and the message is built from variables only. No
 * expression now names a column that does not exist on the triggering table.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION reservation_guard() RETURNS trigger AS $fn$
    DECLARE
      v_item       integer;
      v_warehouse  integer;
      v_on_hand    numeric;
      v_others     numeric;
      v_requested  numeric;
    BEGIN
      v_item := NEW.item_id;
      IF v_item IS NULL THEN RETURN NEW; END IF;

      -- Resolve the requested quantity in the branch that knows the shape of
      -- the row. Referencing both tables' columns in one expression is what
      -- broke the first version: plpgsql resolves every field reference whether
      -- or not COALESCE would short-circuit it.
      IF TG_TABLE_NAME = 'inventory_reservations' THEN
        v_warehouse := NEW.warehouse_id;
        v_requested := GREATEST(COALESCE(NEW.quantity_remaining, NEW.quantity_reserved, 0), 0);
      ELSE
        -- material_reservations carries no warehouse, so company-wide stock is
        -- the only honest scope for it.
        v_warehouse := NULL;
        v_requested := GREATEST(COALESCE(NEW.qty_reserved, 0) - COALESCE(NEW.qty_issued, 0), 0);
      END IF;

      IF v_requested <= 0 THEN RETURN NEW; END IF;

      SELECT COALESCE(SUM(quantity_in - quantity_out), 0) INTO v_on_hand
        FROM stock_ledger
       WHERE item_id = v_item
         AND (v_warehouse IS NULL OR warehouse_id = v_warehouse);

      -- Both live reservation families promise the same physical stock. Seeing
      -- only one would let each over-promise up to the other's total.
      SELECT COALESCE((
               SELECT SUM(GREATEST(COALESCE(r.quantity_remaining, r.quantity_reserved, 0), 0))
                 FROM inventory_reservations r
                WHERE r.item_id = v_item
                  AND (v_warehouse IS NULL OR r.warehouse_id = v_warehouse)
                  AND LOWER(COALESCE(r.status,'')) IN ('active','partially_consumed')
                  AND (TG_OP = 'INSERT' OR TG_TABLE_NAME <> 'inventory_reservations' OR r.id <> NEW.id)
             ), 0)
           + COALESCE((
               SELECT SUM(GREATEST(COALESCE(m.qty_reserved,0) - COALESCE(m.qty_issued,0), 0))
                 FROM material_reservations m
                WHERE m.item_id = v_item
                  AND LOWER(COALESCE(m.status,'')) IN ('reserved','partially_issued')
                  AND (TG_OP = 'INSERT' OR TG_TABLE_NAME <> 'material_reservations' OR m.id <> NEW.id)
             ), 0)
        INTO v_others;

      IF v_others + v_requested > v_on_hand THEN
        RAISE EXCEPTION
          'Cannot promise % of item %: % on hand, % already promised elsewhere, % free',
          v_requested, v_item, v_on_hand, v_others, GREATEST(v_on_hand - v_others, 0)
          USING ERRCODE = 'check_violation',
                HINT = 'Release or reduce another reservation before promising this quantity.';
      END IF;

      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
}

export async function down(knex) {
  // The previous definition is restored by re-running 20260915000019.
  await knex.raw(`DROP FUNCTION IF EXISTS reservation_guard() CASCADE`);
}
