/**
 * 20260916000001_bin_locations_cutover.js
 *
 * Retire `bin_locations`. This is the contract half of the expand/contract that
 * 20260915000017_location_hierarchy.js started.
 *
 * ── WHY IT WAS LEFT HALF-DONE, AND WHY IT CAN FINISH NOW ────────────────────
 * That migration made `warehouse_bins` canonical and materialised every legacy
 * bin into it, but deliberately did not drop the old table, for a good reason
 * it stated plainly: two live foreign keys pointed at it and three source files
 * read it, so dropping it then would have broken picking in order to tidy a
 * data model.
 *
 * Both of those conditions are now cleared. The three source files have been
 * repointed at `warehouse_bins` in the same change as this migration, and the
 * mapping the cutover depends on is complete and checked below rather than
 * assumed.
 *
 * ── THE GUARD ───────────────────────────────────────────────────────────────
 * This migration REFUSES to run if any legacy bin lacks a canonical twin, or if
 * any pick or cycle-count line still carries a legacy id that did not resolve.
 * A cutover that silently drops the unmappable remainder is how location data
 * goes missing, and the remainder is exactly the part nobody would notice.
 *
 * ── WHAT IS PRESERVED ───────────────────────────────────────────────────────
 * `current_items`, `max_weight_kg` and `level` move onto `warehouse_bins`, so
 * the warehouse screen keeps working unchanged rather than losing its contents
 * display on the day of the merge.
 *
 * ⚠ `current_items` is a hand-maintained JSON blob, and it is the same shape of
 * defect as `current_stock` before it was derived: a second copy of a fact the
 * ledger already holds, updated by whoever remembers to. It is carried across
 * so nothing breaks, NOT endorsed — `GET /warehouse/bins` now also returns the
 * lots actually sitting in each bin, read from `inventory_batches.bin_id`,
 * which is the figure with referential integrity behind it.
 *
 * `legacy_bin_location_id` survives as a plain integer once its foreign key is
 * gone, so a row can still be traced back to the bin it came from.
 *
 * ── ROLLBACK ────────────────────────────────────────────────────────────────
 * `down()` rebuilds `bin_locations` from the canonical rows that carry a legacy
 * id, restoring the original ids, and re-adds both consumer foreign keys. The
 * data survives the round trip because every column the old table had is still
 * held on the new one.
 */

export async function up(knex) {
  // ── 0. Refuse to proceed on an incomplete mapping ─────────────────────────
  const { rows: [pre] } = await knex.raw(`
    SELECT
      (SELECT COUNT(*) FROM bin_locations bl
        WHERE NOT EXISTS (SELECT 1 FROM warehouse_bins wb
                           WHERE wb.legacy_bin_location_id = bl.id))::int      AS unmapped_bins,
      (SELECT COUNT(*) FROM pick_list_lines
        WHERE bin_location_id IS NOT NULL AND bin_id IS NULL)::int             AS unmapped_picks,
      (SELECT COUNT(*) FROM cycle_count_lines
        WHERE bin_location_id IS NOT NULL AND bin_id IS NULL)::int             AS unmapped_counts
  `);
  if (pre.unmapped_bins || pre.unmapped_picks || pre.unmapped_counts) {
    throw new Error(
      `bin_locations cutover refused: ${pre.unmapped_bins} unmapped bin(s), ` +
      `${pre.unmapped_picks} pick line(s) and ${pre.unmapped_counts} cycle-count line(s) ` +
      `still reference a legacy bin with no canonical twin. Re-run ` +
      `20260915000017_location_hierarchy.js's mapping step before retrying.`);
  }

  // ── 1. Carry the columns only the legacy table had ────────────────────────
  await knex.raw(`ALTER TABLE warehouse_bins ADD COLUMN IF NOT EXISTS current_items JSONB`);
  await knex.raw(`ALTER TABLE warehouse_bins ADD COLUMN IF NOT EXISTS max_weight_kg NUMERIC(12,2)`);
  await knex.raw(`ALTER TABLE warehouse_bins ADD COLUMN IF NOT EXISTS level_code    VARCHAR(24)`);

  await knex.raw(`
    UPDATE warehouse_bins wb
       SET current_items = COALESCE(wb.current_items, bl.current_items),
           max_weight_kg = COALESCE(wb.max_weight_kg, bl.max_weight_kg),
           level_code    = COALESCE(wb.level_code,    NULLIF(bl.level, ''))
      FROM bin_locations bl
     WHERE wb.legacy_bin_location_id = bl.id
  `);

  // ── 2. Release the foreign keys that pin the old table in place ───────────
  await knex.raw(`ALTER TABLE warehouse_bins    DROP CONSTRAINT IF EXISTS warehouse_bins_legacy_fkey`);
  await knex.raw(`ALTER TABLE pick_list_lines   DROP CONSTRAINT IF EXISTS pick_list_lines_bin_location_id_fkey`);
  await knex.raw(`ALTER TABLE cycle_count_lines DROP CONSTRAINT IF EXISTS cycle_count_lines_bin_location_id_fkey`);

  // The legacy id columns on the consumers are KEPT, not dropped. They are the
  // record of where a line's bin came from, `bin_id` is what every query now
  // reads, and ⚠ DROP COLUMN cascade-drops any index naming the column — a
  // wider blast radius than this change needs.

  // ── 3. Retire it ──────────────────────────────────────────────────────────
  await knex.raw(`DROP TABLE IF EXISTS bin_locations`);

  // A bin whose contents are tracked should be findable by them.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_warehouse_bins_item
      ON warehouse_bins (item_id) WHERE item_id IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bin_locations (
      id            SERIAL PRIMARY KEY,
      zone_id       integer,
      bin_code      varchar(64),
      row_no        varchar(64),
      shelf         varchar(64),
      level         varchar(24),
      max_weight_kg numeric(12,2),
      current_items jsonb,
      created_at    timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  // Rebuild from the canonical rows that remember where they came from,
  // restoring the original primary keys so both consumers' legacy ids resolve.
  await knex.raw(`
    INSERT INTO bin_locations (id, zone_id, bin_code, row_no, shelf, level, max_weight_kg, current_items)
    SELECT wb.legacy_bin_location_id, wb.zone_id, wb.bin_code, wb.row_code, wb.shelf_code,
           wb.level_code, wb.max_weight_kg, wb.current_items
      FROM warehouse_bins wb
     WHERE wb.legacy_bin_location_id IS NOT NULL
    ON CONFLICT (id) DO NOTHING
  `);
  await knex.raw(`
    SELECT setval(pg_get_serial_sequence('bin_locations','id'),
                  GREATEST(COALESCE((SELECT MAX(id) FROM bin_locations), 0), 1))
  `);

  const addFk = async (name, table, column) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (rows.length) return;
    await knex.raw(`
      ALTER TABLE ${table} ADD CONSTRAINT ${name}
        FOREIGN KEY (${column}) REFERENCES bin_locations(id)`);
  };
  await addFk('pick_list_lines_bin_location_id_fkey', 'pick_list_lines', 'bin_location_id');
  await addFk('cycle_count_lines_bin_location_id_fkey', 'cycle_count_lines', 'bin_location_id');
  await addFk('warehouse_bins_legacy_fkey', 'warehouse_bins', 'legacy_bin_location_id');

  await knex.raw(`ALTER TABLE warehouse_bins DROP COLUMN IF EXISTS current_items`);
  await knex.raw(`ALTER TABLE warehouse_bins DROP COLUMN IF EXISTS max_weight_kg`);
  await knex.raw(`ALTER TABLE warehouse_bins DROP COLUMN IF EXISTS level_code`);
}
