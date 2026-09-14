/**
 * 20260910000004_warehouse_zone_bin_masters.js
 *
 * Uniqueness for the zone and bin masters, which are about to become editable.
 *
 * WHY THIS EXISTS
 * ---------------
 * From the live system audit (Q4, "Is there a place to enter every master?"):
 *
 *   "Zones & Bins — Nowhere. Read-only everywhere. GET (+ bins/assign).
 *    Still no create."
 *
 * Both tables were only ever written by the development seed block at the top of
 * warehouse.routes.js, which runs once on an empty `warehouses` table. Nothing
 * else has ever inserted a zone or a bin, so nothing has ever needed to ask
 * whether two of them could collide. Opening create/edit to users changes that
 * on the first duplicate someone types.
 *
 * ⚠ WHY UNIQUENESS MATTERS MORE HERE THAN IT LOOKS
 * ------------------------------------------------
 * A bin code is not a label — it is how a picker finds physical stock. Two bins
 * reading `R1-S2-L1` in one zone means a pick list can name a location that
 * resolves to two different shelves, and `bin_locations.current_items` (the
 * jsonb that IS the stock record for that bin) would then be split across two
 * rows that every summary treats as one place. Nothing in the application would
 * look wrong; the stock would simply not be where the system said.
 *
 * Both indexes are case-folded. `R1-S2-L1` and `r1-s2-l1` are the same shelf to
 * everyone in the building, so they must be the same row here.
 *
 * Verified clean before writing: zero duplicate (zone_id, bin_code) pairs across
 * 12 bins and zero duplicate (warehouse_id, name) pairs across 5 zones, so
 * neither index can fail to build on the live database.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  // Two zones with the same name in one warehouse are indistinguishable in every
  // dropdown that offers them, and `cycle_count_headers.zone_id` would be a
  // coin flip. Scoped per warehouse: "Receiving Dock A" may exist once in each.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouse_zones_name_unique
      ON warehouse_zones (warehouse_id, lower(name))
  `);

  // ⚠ The one that protects stock. See the note above.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bin_locations_code_unique
      ON bin_locations (zone_id, upper(bin_code))
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_bin_locations_code_unique`);
  await knex.raw(`DROP INDEX IF EXISTS idx_warehouse_zones_name_unique`);
}
