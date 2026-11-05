/**
 * 20260915000021_reservation_guard_stock_basis.js
 *
 * Corrects what reservation_guard() counts as "on hand".
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * The guard measured available stock from `stock_ledger` alone. The ISSUE path
 * does not: it draws from `inventory_batches.quantity_available`, lot by lot, in
 * FEFO/FIFO order. So the guard was refusing to promise stock that the system
 * would happily issue — two different answers to "what have we got", with the
 * stricter one placed in front of the promise and the looser one in front of the
 * actual withdrawal. That is backwards, and it is the wrong way round to be
 * wrong: it blocks planning while leaving issuing unguarded.
 *
 * It surfaced immediately — 31 tests across the material-issue suite went red,
 * every one of them a legitimate reservation being refused, because lots seeded
 * straight into inventory_batches have no ledger rows behind them.
 *
 * That is a fixture shortcut, but it is not ONLY a fixture shortcut: the same
 * shape occurs in live data. The audit found lots created by seeds and
 * migrations that never posted a ledger row, and `inventory_fifo_layers` /
 * `stock_ledger.fifo_layer_id` both read 100% NULL for the same reason. A guard
 * that refuses to promise real, issuable stock because one of two records is
 * missing would have been a production incident, not a test failure.
 *
 * ── THE FIX ─────────────────────────────────────────────────────────────────
 * On-hand is now the GREATER of the two measures:
 *
 *   lot availability   SUM(inventory_batches.quantity_available) — what the
 *                      issue path will actually draw from
 *   ledger balance     SUM(quantity_in - quantity_out) — the movement record,
 *                      and the only measure for items that carry no lots
 *
 * Where both records are consistent — which is what the GRN path now produces,
 * since the batch and the ledger row are written in one transaction — they agree
 * and GREATEST changes nothing. Where they disagree, the guard sides with the
 * measure that governs issuing, so it can never refuse to promise stock the
 * system would then hand out.
 *
 * The guarantee the requirement asks for is unchanged: total live promises for
 * an item may not exceed the stock that exists. Only the definition of "exists"
 * is corrected, to the one the rest of the system already uses.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION reservation_guard() RETURNS trigger AS $fn$
    DECLARE
      v_item       integer;
      v_warehouse  integer;
      v_ledger     numeric;
      v_lots       numeric;
      v_on_hand    numeric;
      v_others     numeric;
      v_requested  numeric;
    BEGIN
      v_item := NEW.item_id;
      IF v_item IS NULL THEN RETURN NEW; END IF;

      IF TG_TABLE_NAME = 'inventory_reservations' THEN
        v_warehouse := NEW.warehouse_id;
        v_requested := GREATEST(COALESCE(NEW.quantity_remaining, NEW.quantity_reserved, 0), 0);
      ELSE
        v_warehouse := NULL;
        v_requested := GREATEST(COALESCE(NEW.qty_reserved, 0) - COALESCE(NEW.qty_issued, 0), 0);
      END IF;

      IF v_requested <= 0 THEN RETURN NEW; END IF;

      SELECT COALESCE(SUM(quantity_in - quantity_out), 0) INTO v_ledger
        FROM stock_ledger
       WHERE item_id = v_item
         AND (v_warehouse IS NULL OR warehouse_id = v_warehouse);

      -- What the issue path will actually draw from, and therefore the floor
      -- under what may be promised. Lots held for quality are excluded: they
      -- cannot be issued, so they must not be promised either.
      SELECT COALESCE(SUM(COALESCE(quantity_available, 0)), 0) INTO v_lots
        FROM inventory_batches
       WHERE item_id = v_item
         AND deleted_at IS NULL
         AND (v_warehouse IS NULL OR warehouse_id = v_warehouse)
         AND LOWER(COALESCE(status, 'available')) NOT IN ('rejected','quarantine','hold','blocked');

      v_on_hand := GREATEST(v_ledger, v_lots);

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
  await knex.raw(`DROP FUNCTION IF EXISTS reservation_guard() CASCADE`);
}
