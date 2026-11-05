/**
 * 20260915000019_dispatch_serial_and_reservation_guard.js
 *
 * Inventory / traceability audit — findings 34 (dispatch link) and 20 (reservation).
 *
 * ── FINDING 34: THE REVERSE CHAIN CANNOT START ──────────────────────────────
 *
 * `package_lines.serial_id` is 100% NULL across every row, while five serials
 * sit flagged `status = 'shipped'` — stamped by something that never wrote a
 * package line. So "which customer received panel P-1007" has no answer, and
 * the customer → supplier walk the requirement asks for cannot begin.
 *
 * The cause is upstream of packing. `pick_list_lines` records item, lot and
 * bin — but not WHICH UNIT was picked. The packing handler then defaults its
 * contents from those pick lines, so there is no serial for it to carry even in
 * principle; the `serial_id` column it writes is always the NULL it was handed.
 *
 * The chain is pick → pack → ship, and it was broken at the first link. This
 * adds `pick_list_lines.serial_id` so a pick can name the unit, and
 * `shipment_id` on the package so a shipped unit is provably attached to a
 * shipment rather than merely flagged.
 *
 * NOT BACKFILLED. Which physical panel went into which carton was never
 * recorded. The five 'shipped' serials cannot be matched to the six package
 * lines by anything better than guesswork, and a guessed customer on a panel is
 * exactly the kind of confident-but-wrong genealogy this audit exists to remove.
 * They are reported by v_shipped_serials_unlinked below instead, as a worklist.
 *
 * ── FINDING 20: RESERVED STOCK HAD NO GUARANTEE ─────────────────────────────
 *
 * The requirement is blunt: stock promised for a production order must not
 * accidentally be issued to another requirement. Availability was COMPUTED in
 * application queries and never CONSTRAINED, so two concurrent requirements
 * could each read the same free quantity and both reserve it — the classic
 * check-then-act race, which no amount of careful reading prevents.
 *
 * `reservation_guard()` closes it at the database: the sum of live reservations
 * for an item in a store may not exceed what that store holds. It runs on the
 * reservation tables rather than at issue time on purpose — refusing the
 * over-commitment when it is PROMISED is actionable ("we cannot promise this"),
 * whereas refusing it at issue is a shortage discovered on the shop floor.
 *
 * It deliberately covers BOTH live reservation tables. `inventory_reservations`
 * and `material_reservations` are a documented duplicate family — the production
 * issue path reads one, the inventory screens read the other, and both hold rows.
 * Merging them is a larger change that belongs in its own pass; until then the
 * guard has to see the whole commitment or it would let each table over-promise
 * up to the other's total.
 */

export async function up(knex) {
  const addFk = async (name, table, column, refTable, onDelete = 'SET NULL') => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES ${refTable}(id) ON DELETE ${onDelete}
    `);
  };

  // ── 34: a pick can name the unit it picked ───────────────────────────────
  await knex.raw(`ALTER TABLE pick_list_lines ADD COLUMN IF NOT EXISTS serial_id integer`);
  await addFk('pick_list_lines_serial_fkey', 'pick_list_lines', 'serial_id', 'serial_numbers');
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_pll_serial ON pick_list_lines (serial_id) WHERE serial_id IS NOT NULL
  `);

  // A serialised unit is picked onto one open pick line at a time, for the same
  // reason it is installed in one panel at a time.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pll_serial_live
      ON pick_list_lines (serial_id)
      WHERE serial_id IS NOT NULL AND LOWER(COALESCE(status,'')) <> 'cancelled'
  `);

  // A packed unit belongs to one package line.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_package_lines_serial
      ON package_lines (serial_id) WHERE serial_id IS NOT NULL
  `);

  // Close the loop from the serial's own side, so "shipped" is provable rather
  // than a flag somebody set.
  await knex.raw(`
    ALTER TABLE serial_numbers
      ADD COLUMN IF NOT EXISTS package_id   integer,
      ADD COLUMN IF NOT EXISTS shipment_id  integer,
      ADD COLUMN IF NOT EXISTS shipped_at   timestamptz,
      ADD COLUMN IF NOT EXISTS customer_id  integer
  `);
  await addFk('serial_numbers_package_fkey', 'serial_numbers', 'package_id', 'packages');

  const shipmentsExists = await knex.raw(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'shipments'`);
  if (shipmentsExists.rows.length) {
    await addFk('serial_numbers_shipment_fkey', 'serial_numbers', 'shipment_id', 'shipments');
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_serial_package ON serial_numbers (package_id) WHERE package_id IS NOT NULL
  `);

  // The worklist: units flagged shipped that no package line accounts for.
  await knex.raw(`
    CREATE OR REPLACE VIEW v_shipped_serials_unlinked AS
    SELECT sn.id AS serial_id, sn.serial_number, sn.company_id, sn.status,
           sn.production_order_id, po.production_order_no, sn.updated_at
      FROM serial_numbers sn
      LEFT JOIN production_orders po ON po.id = sn.production_order_id
     WHERE sn.deleted_at IS NULL
       AND LOWER(COALESCE(sn.status,'')) IN ('shipped','dispatched','delivered')
       AND sn.package_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM package_lines pl WHERE pl.serial_id = sn.id)
  `);

  // ── 20: reserved stock cannot exceed what the store holds ────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION reservation_guard() RETURNS trigger AS $fn$
    DECLARE
      v_item      integer;
      v_warehouse integer;
      v_on_hand   numeric;
      v_reserved  numeric;
    BEGIN
      v_item := NEW.item_id;
      IF v_item IS NULL THEN RETURN NEW; END IF;

      -- material_reservations has no warehouse column; company-wide is then the
      -- only honest scope for it, and the guard says so by leaving it NULL.
      BEGIN
        v_warehouse := NEW.warehouse_id;
      EXCEPTION WHEN undefined_column THEN
        v_warehouse := NULL;
      END;

      SELECT COALESCE(SUM(quantity_in - quantity_out), 0) INTO v_on_hand
        FROM stock_ledger
       WHERE item_id = v_item
         AND (v_warehouse IS NULL OR warehouse_id = v_warehouse);

      -- Both live reservation families count toward the same physical stock.
      -- Seeing only one would let each over-promise up to the other's total.
      SELECT COALESCE((
               SELECT SUM(COALESCE(r.quantity_remaining, r.quantity_reserved, 0))
                 FROM inventory_reservations r
                WHERE r.item_id = v_item
                  AND (v_warehouse IS NULL OR r.warehouse_id = v_warehouse)
                  AND LOWER(COALESCE(r.status,'')) IN ('active','partially_consumed')
                  AND (TG_TABLE_NAME <> 'inventory_reservations' OR r.id IS DISTINCT FROM NEW.id)
             ), 0)
           + COALESCE((
               SELECT SUM(GREATEST(COALESCE(m.qty_reserved,0) - COALESCE(m.qty_issued,0), 0))
                 FROM material_reservations m
                WHERE m.item_id = v_item
                  AND LOWER(COALESCE(m.status,'')) IN ('reserved','partially_issued')
                  AND (TG_TABLE_NAME <> 'material_reservations' OR m.id IS DISTINCT FROM NEW.id)
             ), 0)
        INTO v_reserved;

      IF TG_TABLE_NAME = 'inventory_reservations' THEN
        v_reserved := v_reserved + COALESCE(NEW.quantity_remaining, NEW.quantity_reserved, 0);
      ELSE
        v_reserved := v_reserved + GREATEST(COALESCE(NEW.qty_reserved,0) - COALESCE(NEW.qty_issued,0), 0);
      END IF;

      IF v_reserved > v_on_hand THEN
        RAISE EXCEPTION
          'Cannot reserve % of item %: only % on hand and % already promised elsewhere',
          v_reserved - (v_reserved - COALESCE(NEW.quantity_remaining, NEW.quantity_reserved,
                                              GREATEST(COALESCE(NEW.qty_reserved,0) - COALESCE(NEW.qty_issued,0), 0))),
          v_item, v_on_hand, v_reserved - COALESCE(NEW.quantity_remaining, NEW.quantity_reserved,
                                              GREATEST(COALESCE(NEW.qty_reserved,0) - COALESCE(NEW.qty_issued,0), 0))
          USING ERRCODE = 'check_violation',
                HINT = 'Release or reduce another reservation before promising this quantity.';
      END IF;

      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);

  // Applied only to rows that actually promise something, so releasing or
  // cancelling a reservation is never blocked by the guard.
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_reservation_guard ON inventory_reservations;
    CREATE TRIGGER trg_reservation_guard
      BEFORE INSERT OR UPDATE ON inventory_reservations
      FOR EACH ROW
      WHEN (LOWER(COALESCE(NEW.status,'')) IN ('active','partially_consumed'))
      EXECUTE FUNCTION reservation_guard();
  `);
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_material_reservation_guard ON material_reservations;
    CREATE TRIGGER trg_material_reservation_guard
      BEFORE INSERT OR UPDATE ON material_reservations
      FOR EACH ROW
      WHEN (LOWER(COALESCE(NEW.status,'')) IN ('reserved','partially_issued'))
      EXECUTE FUNCTION reservation_guard();
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_reservation_guard ON inventory_reservations`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_material_reservation_guard ON material_reservations`);
  await knex.raw(`DROP FUNCTION IF EXISTS reservation_guard()`);
  await knex.raw(`DROP VIEW IF EXISTS v_shipped_serials_unlinked`);
  await knex.raw(`
    DROP INDEX IF EXISTS uq_pll_serial_live;
    DROP INDEX IF EXISTS uq_package_lines_serial;
    ALTER TABLE pick_list_lines DROP COLUMN IF EXISTS serial_id;
    ALTER TABLE serial_numbers
      DROP COLUMN IF EXISTS package_id, DROP COLUMN IF EXISTS shipment_id,
      DROP COLUMN IF EXISTS shipped_at, DROP COLUMN IF EXISTS customer_id;
  `);
}
