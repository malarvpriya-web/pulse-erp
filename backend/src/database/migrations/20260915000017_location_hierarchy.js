/**
 * 20260915000017_location_hierarchy.js
 *
 * Inventory / traceability audit — findings 5, 18 and 32.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 *
 * Required:  Company → Plant → Store → Zone → Rack → Shelf/Bin → Location
 * Actual:    Company → Warehouse → (two rival bin systems, neither reachable
 *                                   from a stock position)
 *
 * 1. NO PLANT TIER. `warehouses` has no `plant_id` and no `parent_id`, so a
 *    company running two factories cannot say which one a store belongs to —
 *    and "where is this component" could never be answered above store level.
 *
 * 2. TWO RIVAL BIN TABLES, both live, with no relationship to each other:
 *
 *      bin_locations   12 rows · zone_id, bin_code, row_no, shelf, level
 *                      referenced by pick_list_lines, cycle_count_lines
 *                      ⚠ NO company_id AT ALL
 *      warehouse_bins  14 rows · company_id, warehouse_id, row_code,
 *                      shelf_code, bin_code · UNIQUE (company, warehouse, bin)
 *                      referenced by inventory_batches, put_away_tasks
 *
 * 3. Neither was reachable from a lot until `inventory_batches.bin_id` was
 *    added, so bin-level location history and bin scanning were both impossible.
 *
 * ── THE DECISION: warehouse_bins IS CANONICAL ───────────────────────────────
 * Not because it is newer, but because `bin_locations` HAS NO company_id. In a
 * multi-tenant system a location table with no tenant column is a hole, not a
 * style difference: any scoped query over it either leaks or has to route
 * through a join that nothing enforces. warehouse_bins also already carries the
 * unique key (company, warehouse, bin_code) that makes a bin code mean one
 * physical place.
 *
 * ── WHAT THIS MIGRATION DOES, AND WHAT IT REFUSES TO DO ─────────────────────
 * It does NOT drop bin_locations. Two live foreign keys point at it
 * (pick_list_lines, cycle_count_lines) and three source files read it; dropping
 * it would break picking to tidy a data model, and ⚠ DROP COLUMN cascade-drops
 * indexes naming the column, so the blast radius is wider than it looks.
 *
 * Instead it MAPS: every bin_locations row is materialised into warehouse_bins
 * (same bin_code, same warehouse resolved through its zone) where one does not
 * already exist, and the two consumers gain a `bin_id` column backfilled from
 * that mapping. The backfill is provable — same bin code, same warehouse — not
 * invented. Old columns stay and keep working; new writes go to warehouse_bins.
 *
 * Zones are attached to warehouse_bins so the hierarchy finally resolves
 * end to end: plant → warehouse → zone → rack(row) → shelf → bin.
 */

export async function up(knex) {
  // ── 1. The plant tier ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS plants (
      id          SERIAL PRIMARY KEY,
      company_id  integer,
      plant_code  text NOT NULL,
      plant_name  text NOT NULL,
      address     text,
      city        text,
      state       text,
      country     text,
      gstin       text,
      is_active   boolean NOT NULL DEFAULT true,
      deleted_at  timestamptz,
      created_at  timestamptz NOT NULL DEFAULT NOW(),
      updated_at  timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  const addFk = async (name, table, column, refTable, onDelete = 'SET NULL') => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${name} FOREIGN KEY (${column}) REFERENCES ${refTable}(id) ON DELETE ${onDelete}
    `);
  };
  await addFk('plants_company_fkey', 'plants', 'company_id', 'companies');

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_plants_company_code
      ON plants (company_id, plant_code) WHERE deleted_at IS NULL
  `);

  await knex.raw(`ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS plant_id integer`);
  await addFk('warehouses_plant_fkey', 'warehouses', 'plant_id', 'plants');
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_warehouses_plant ON warehouses (plant_id) WHERE plant_id IS NOT NULL
  `);

  // Deliberately NOT auto-creating a plant per company and assigning every
  // store to it. That would look like a modelled hierarchy while being a
  // placeholder nobody chose, and a wrong plant on a store is worse than a null
  // one: it reads as an answer. plant_id stays NULL until someone defines the
  // real plants, and every read treats NULL as "not yet assigned".

  // ── 2. Zones on the canonical bin table ──────────────────────────────────
  await knex.raw(`ALTER TABLE warehouse_bins ADD COLUMN IF NOT EXISTS zone_id integer`);
  await knex.raw(`ALTER TABLE warehouse_bins ADD COLUMN IF NOT EXISTS legacy_bin_location_id integer`);
  await addFk('warehouse_bins_zone_fkey', 'warehouse_bins', 'zone_id', 'warehouse_zones');
  await addFk('warehouse_bins_legacy_fkey', 'warehouse_bins', 'legacy_bin_location_id', 'bin_locations');

  // ── 3. Materialise bin_locations into warehouse_bins ─────────────────────
  // The warehouse comes from the zone the legacy bin belongs to; the company
  // from that warehouse. A legacy bin whose zone names no warehouse cannot be
  // placed and is skipped rather than guessed — it would otherwise land in some
  // arbitrary store and become a real-looking wrong location.
  await knex.raw(`
    INSERT INTO warehouse_bins
      (company_id, warehouse_id, zone_id, row_code, shelf_code, bin_code, status, legacy_bin_location_id)
    SELECT w.company_id, w.id, bl.zone_id,
           NULLIF(bl.row_no::text, ''), NULLIF(bl.shelf, ''), bl.bin_code,
           'active', bl.id
      FROM bin_locations bl
      JOIN warehouse_zones wz ON wz.id = bl.zone_id
      JOIN warehouses w       ON w.id = wz.warehouse_id AND w.deleted_at IS NULL
     WHERE bl.bin_code IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM warehouse_bins wb
          WHERE wb.warehouse_id = w.id
            AND wb.bin_code = bl.bin_code
            AND (wb.company_id IS NOT DISTINCT FROM w.company_id)
       )
  `);

  // Where a warehouse_bins row already existed for the same code in the same
  // store, point it at its legacy twin so the two are demonstrably the same
  // place rather than merely looking alike.
  await knex.raw(`
    UPDATE warehouse_bins wb
       SET zone_id = COALESCE(wb.zone_id, bl.zone_id),
           legacy_bin_location_id = COALESCE(wb.legacy_bin_location_id, bl.id)
      FROM bin_locations bl
      JOIN warehouse_zones wz ON wz.id = bl.zone_id
     WHERE wb.bin_code = bl.bin_code
       AND wb.warehouse_id = wz.warehouse_id
       AND wb.legacy_bin_location_id IS NULL
  `);

  // ── 4. The two legacy consumers gain a canonical bin reference ───────────
  for (const t of ['pick_list_lines', 'cycle_count_lines']) {
    await knex.raw(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS bin_id integer`);
    await addFk(`${t}_bin_id_fkey`, t, 'bin_id', 'warehouse_bins');
    // Provable backfill: the legacy id maps to exactly one canonical bin.
    await knex.raw(`
      UPDATE ${t} t
         SET bin_id = wb.id
        FROM warehouse_bins wb
       WHERE wb.legacy_bin_location_id = t.bin_location_id
         AND t.bin_id IS NULL
    `);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_${t}_bin ON ${t} (bin_id) WHERE bin_id IS NOT NULL
    `);
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_warehouse_bins_zone ON warehouse_bins (zone_id) WHERE zone_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_bins_legacy
      ON warehouse_bins (legacy_bin_location_id) WHERE legacy_bin_location_id IS NOT NULL;
  `);

  // ── 5. A movement can name the bin it went to ────────────────────────────
  // stock_ledger already gained from_bin_id / to_bin_id in 20260915000008; the
  // FKs were deferred until a canonical bin table existed to point them at.
  await addFk('stock_ledger_from_bin_fkey', 'stock_ledger', 'from_bin_id', 'warehouse_bins');
  await addFk('stock_ledger_to_bin_fkey',   'stock_ledger', 'to_bin_id',   'warehouse_bins');
}

export async function down(knex) {
  for (const t of ['pick_list_lines', 'cycle_count_lines']) {
    await knex.raw(`ALTER TABLE ${t} DROP COLUMN IF EXISTS bin_id`);
  }
  await knex.raw(`
    DELETE FROM warehouse_bins WHERE legacy_bin_location_id IS NOT NULL;
    ALTER TABLE warehouse_bins
      DROP COLUMN IF EXISTS zone_id, DROP COLUMN IF EXISTS legacy_bin_location_id;
  `);
  await knex.raw(`ALTER TABLE warehouses DROP COLUMN IF EXISTS plant_id`);
  await knex.raw(`DROP TABLE IF EXISTS plants`);
}
