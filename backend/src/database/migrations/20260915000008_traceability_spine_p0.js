/**
 * 20260915000008_traceability_spine_p0.js
 *
 * Inventory / material-genealogy audit — P0 schema findings 5.1, 6, 7.1, 7.2,
 * 15.1 and 33.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * 1. THE LEDGER CANNOT CARRY LOT IDENTITY (finding 6 / 19).
 *    `stock_ledger` is the inventory ledger — 442 rows, a running balance, and
 *    `inventory_items.current_stock` derived from it by trigger. It records
 *    "item X, warehouse W, +/- qty" and nothing else. No batch. No serial. No
 *    source location and no destination location — a transfer is two
 *    single-warehouse rows that nothing joins. No project, no work order.
 *
 *    Eight of the fifteen fields the requirement mandates per movement are
 *    absent, so no query can recover them. That absence is why
 *    /genealogy/location-history had to be rewritten to stitch together
 *    inventory_batches, pick_list_lines, material_issue_logs and package_lines:
 *    the ledger, which should be the spine, could not answer.
 *
 *    The clearest symptom is at receipt. grn.service.postAcceptedStock()
 *    creates the batch and the ledger row TOGETHER, in one transaction — and
 *    then calls postStock() without the batch id it generated one line earlier.
 *    The link exists at that instant and is thrown away.
 *
 * 2. SUPPLIER LOT IDENTITY IS LOST AT THE DOOR (finding 7.1).
 *    There is no supplier_batch_no column anywhere in the database, and no
 *    manufacturer part number. `grn_items` stores quantity, rate and remarks.
 *    So the recall the business actually needs — "supplier batch ABC123 is
 *    defective, which panels have it" — has no starting point. Neither does
 *    "manufacturer part XYZ, batch 2026-08-A, which panels are affected".
 *
 *    The internal batch number is auto-generated as GRN-<no>-<item> when the
 *    receipt does not supply one, so it does not carry the supplier's identity
 *    either.
 *
 * 3. SERIAL CONTROL IS NOT CONFIGURABLE (finding 7.2).
 *    `inventory_items.is_batch_tracked` exists; there is no is_serial_tracked.
 *    The requirement is that an item is batch-controlled OR serial-controlled
 *    by configuration. Without the flag, serials are created ad hoc with no
 *    policy — which is why only one of eight production orders has any.
 *
 * 4. THE SAME SERIALISED COMPONENT CAN BE INSTALLED TWICE (finding 15.1).
 *    idx_mil_component_serial_id is a PLAIN index. The application checks that
 *    a component serial exists and belongs to the item being issued
 *    (execution.routes.js:1353) and stops there. Nothing — in either layer —
 *    stops the same physical unit being consumed into two panels.
 *
 * 5. A LOT HAS NO BIN (finding 5.1).
 *    inventory_batches.warehouse_id is the finest location a lot has.
 *    pick_list_lines.bin_location_id is the only bin-level record in the
 *    system, and it is a pick instruction, not a stock position.
 *
 * ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
 * Adds the columns and the two constraints. Every new column is NULLABLE.
 *
 * ── WHY REVERSAL, NOT A BARE UNIQUE INDEX ───────────────────────────────────
 * "One serialised unit is installed in at most one panel" is only true of
 * CURRENT state. A unit removed during rework and fitted to another panel is
 * legitimate, and a bare unique index on component_serial_id would forbid it
 * forever — which would push the floor into deleting the original issue row to
 * get their work done, destroying exactly the history this exists to protect.
 *
 * So the uniqueness is scoped to live installations: reversed_at IS NULL. A
 * rework removal STAMPS the original row (it is never deleted or overwritten)
 * and that frees the serial for a new installation. History accumulates; the
 * invariant still holds at every instant.
 *
 * ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ────────────────────────────
 * It does not backfill stock_ledger.batch_id. The obvious recovery — join a
 * 'grn' ledger row to the single batch carrying that grn_id — was measured
 * against live data before this was written and matches ZERO rows: the live
 * ledger holds no GRN-referenced rows at all (its types are adjustment,
 * consumption, dispatch, opening, production_receipt, receipt — seeded stock,
 * not receipts posted through the GRN path). There is nothing to recover, and
 * guessing a lot for a historical movement would be indistinguishable from a
 * real one afterwards. Historical rows stay NULL, which honestly reads as
 * "not recorded" rather than as a lot that was never observed.
 *
 * Verified before writing: no live row violates either new constraint
 * (0 duplicate component serials, 0 duplicate (company,item,batch_number),
 * 0 NULL batch numbers, 0 negative available quantities).
 */

export async function up(knex) {
  // ── 1. The ledger gains lot, unit, route, and demand context ──────────────
  await knex.raw(`
    ALTER TABLE stock_ledger
      ADD COLUMN IF NOT EXISTS batch_id             integer,
      ADD COLUMN IF NOT EXISTS serial_id            integer,
      ADD COLUMN IF NOT EXISTS from_warehouse_id    integer,
      ADD COLUMN IF NOT EXISTS to_warehouse_id      integer,
      ADD COLUMN IF NOT EXISTS from_bin_id          integer,
      ADD COLUMN IF NOT EXISTS to_bin_id            integer,
      ADD COLUMN IF NOT EXISTS project_id           integer,
      ADD COLUMN IF NOT EXISTS production_order_id  integer,
      ADD COLUMN IF NOT EXISTS reason_code          text
  `);

  // ── 2. Supplier / manufacturer lot identity, kept at the lot ──────────────
  await knex.raw(`
    ALTER TABLE inventory_batches
      ADD COLUMN IF NOT EXISTS supplier_batch_no    text,
      ADD COLUMN IF NOT EXISTS manufacturer         text,
      ADD COLUMN IF NOT EXISTS manufacturer_part_no text,
      ADD COLUMN IF NOT EXISTS manufacturing_date   date,
      ADD COLUMN IF NOT EXISTS bin_id               integer
  `);

  // ── 3. …and captured at the receipt line, where it is actually known ──────
  await knex.raw(`
    ALTER TABLE grn_items
      ADD COLUMN IF NOT EXISTS batch_number         text,
      ADD COLUMN IF NOT EXISTS supplier_batch_no    text,
      ADD COLUMN IF NOT EXISTS manufacturer         text,
      ADD COLUMN IF NOT EXISTS manufacturer_part_no text,
      ADD COLUMN IF NOT EXISTS manufacturing_date   date,
      ADD COLUMN IF NOT EXISTS expiry_date          date
  `);

  // ── 4. Item-level control policy ──────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE inventory_items
      ADD COLUMN IF NOT EXISTS is_serial_tracked    boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS manufacturer_part_no text
  `);

  // ── 5. Rework reversal on the as-built record ─────────────────────────────
  await knex.raw(`
    ALTER TABLE material_issue_logs
      ADD COLUMN IF NOT EXISTS reversed_at      timestamptz,
      ADD COLUMN IF NOT EXISTS reversed_by      integer,
      ADD COLUMN IF NOT EXISTS reversal_reason  text
  `);

  // ── FKs. ADD CONSTRAINT has no IF NOT EXISTS, so each is guarded by name.
  // The runner's `raw` is a straight pg passthrough: bindings are $n, never ?.
  const addFk = async (name, table, column, refTable) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${name} FOREIGN KEY (${column})
        REFERENCES ${refTable}(id) ON DELETE SET NULL
    `);
  };

  await addFk('stock_ledger_batch_id_fkey',      'stock_ledger', 'batch_id',            'inventory_batches');
  await addFk('stock_ledger_serial_id_fkey',     'stock_ledger', 'serial_id',           'serial_numbers');
  await addFk('stock_ledger_from_wh_fkey',       'stock_ledger', 'from_warehouse_id',   'warehouses');
  await addFk('stock_ledger_to_wh_fkey',         'stock_ledger', 'to_warehouse_id',     'warehouses');
  await addFk('stock_ledger_prod_order_fkey',    'stock_ledger', 'production_order_id', 'production_orders');
  await addFk('inventory_batches_bin_id_fkey',   'inventory_batches', 'bin_id',         'warehouse_bins');

  // ── Indexes for the traceability reads these columns exist to serve ───────
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_stock_ledger_batch
      ON stock_ledger (batch_id) WHERE batch_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_stock_ledger_serial
      ON stock_ledger (serial_id) WHERE serial_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_stock_ledger_prod_order
      ON stock_ledger (production_order_id) WHERE production_order_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_batches_supplier_batch
      ON inventory_batches (company_id, supplier_batch_no) WHERE supplier_batch_no IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_batches_mpn
      ON inventory_batches (company_id, manufacturer_part_no) WHERE manufacturer_part_no IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_items_mpn
      ON inventory_items (company_id, manufacturer_part_no) WHERE manufacturer_part_no IS NOT NULL;
  `);

  // ── The two integrity rules the audit found unenforced ────────────────────

  // 15.1 — a serialised unit is in at most one panel AT A TIME. Scoped to live
  // installations so rework can legitimately move a unit (see header).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mil_component_serial_live
      ON material_issue_logs (component_serial_id)
      WHERE component_serial_id IS NOT NULL AND reversed_at IS NULL
  `);

  // 33 — no duplicate batch number within a company and item.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_batches_company_item_number
      ON inventory_batches (company_id, item_id, batch_number)
      WHERE deleted_at IS NULL AND batch_number IS NOT NULL
  `);

  // 33 — a lot cannot go negative. Added NOT VALID so the constraint governs
  // every future write immediately without a full-table rewrite; it is then
  // validated, which succeeds because the live check above found 0 offenders.
  const { rows: neg } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'inventory_batches_avail_nonneg_chk'`);
  if (!neg.length) {
    await knex.raw(`
      ALTER TABLE inventory_batches
        ADD CONSTRAINT inventory_batches_avail_nonneg_chk
        CHECK (quantity_available IS NULL OR quantity_available >= 0) NOT VALID
    `);
    await knex.raw(`ALTER TABLE inventory_batches VALIDATE CONSTRAINT inventory_batches_avail_nonneg_chk`);
  }
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS uq_mil_component_serial_live;
    DROP INDEX IF EXISTS uq_batches_company_item_number;
    ALTER TABLE inventory_batches DROP CONSTRAINT IF EXISTS inventory_batches_avail_nonneg_chk;
  `);
  await knex.raw(`
    ALTER TABLE stock_ledger
      DROP COLUMN IF EXISTS batch_id, DROP COLUMN IF EXISTS serial_id,
      DROP COLUMN IF EXISTS from_warehouse_id, DROP COLUMN IF EXISTS to_warehouse_id,
      DROP COLUMN IF EXISTS from_bin_id, DROP COLUMN IF EXISTS to_bin_id,
      DROP COLUMN IF EXISTS project_id, DROP COLUMN IF EXISTS production_order_id,
      DROP COLUMN IF EXISTS reason_code
  `);
  await knex.raw(`
    ALTER TABLE inventory_batches
      DROP COLUMN IF EXISTS supplier_batch_no, DROP COLUMN IF EXISTS manufacturer,
      DROP COLUMN IF EXISTS manufacturer_part_no, DROP COLUMN IF EXISTS manufacturing_date,
      DROP COLUMN IF EXISTS bin_id
  `);
  await knex.raw(`
    ALTER TABLE grn_items
      DROP COLUMN IF EXISTS batch_number, DROP COLUMN IF EXISTS supplier_batch_no,
      DROP COLUMN IF EXISTS manufacturer, DROP COLUMN IF EXISTS manufacturer_part_no,
      DROP COLUMN IF EXISTS manufacturing_date, DROP COLUMN IF EXISTS expiry_date
  `);
  await knex.raw(`
    ALTER TABLE inventory_items
      DROP COLUMN IF EXISTS is_serial_tracked, DROP COLUMN IF EXISTS manufacturer_part_no
  `);
  await knex.raw(`
    ALTER TABLE material_issue_logs
      DROP COLUMN IF EXISTS reversed_at, DROP COLUMN IF EXISTS reversed_by,
      DROP COLUMN IF EXISTS reversal_reason
  `);
}
