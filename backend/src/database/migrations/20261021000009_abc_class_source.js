/**
 * 20261021000009 — who owns inventory_items.abc_class: a person, or the engine.
 *
 * abc_class is the OPERATIVE class every consumer reads (MRP, procurement, the
 * dashboards, the planning optimiser). It has two possible authors — a planner's
 * override from Item Master, or the planning run — and nothing recorded which.
 * Until 2026-10-21 the run simply overwrote it every night; Phase 1 inferred
 * ownership by comparing it with the previous calculated class, which cannot
 * see an override that happens to EQUAL the calculated class. This column is
 * the record, mirroring safety_stock_source / reorder_point_source (same width,
 * same two words):
 *
 *   'manual'      a person set it; no recompute may change it
 *   'calculated'  the planning run owns it and moves it on every recompute
 *   NULL          legacy row whose author cannot be established (see below)
 *
 * ── BACKFILL — only what the data can prove ─────────────────────────────────
 *   abc_class IS NULL                            -> 'calculated'  nothing to own
 *   abc_class set, abc_class_calculated IS NULL  -> 'manual'      the engine has
 *                                                   never written a class for
 *                                                   this item, so it did not
 *                                                   write this one
 *   abc_class differs from abc_class_calculated  -> 'manual'      the engine
 *                                                   writes the two together and
 *                                                   equal; a difference has a
 *                                                   human (or Phase 1's
 *                                                   protection of one) behind it
 *   abc_class = abc_class_calculated             -> NULL          AMBIGUOUS
 *
 * The ambiguous case is left NULL rather than guessed. Policy (enforced in
 * inventoryPlanning.service.js): a NULL source is treated as ENGINE-OWNED, and
 * the next run stamps it 'calculated'. Rationale: before Phase 1 every run
 * overwrote abc_class unconditionally, so no override that differed from the
 * engine survived in these rows anyway, and at this moment the value equals the
 * calculation — taking ownership changes nothing anyone can see today. What it
 * gives up is an override someone set equal to the calculated class and wants
 * held if the calculation later moves; a planner who wants that re-pins it, and
 * it is then recorded explicitly. The API reports these rows as
 * classification_status 'legacy_unverified' until the run resolves them.
 *
 * A manual source with no class is meaningless (clearing an override returns
 * the item to the engine), so that combination is refused at the database.
 *
 * New rows default to 'calculated'. The default is set AFTER the backfill:
 * ADD COLUMN ... DEFAULT would have stamped every legacy row 'calculated',
 * erasing exactly the manual overrides the backfill exists to find.
 *
 * Rollback: down() drops the column and constraint. The engine then needs the
 * previous service code, which inferred ownership — deploy and roll back the
 * migration together with inventoryPlanning.service.js.
 */

/**
 * The backfill, exported so a test can run it over its own fixture companies
 * only. Re-running it is a no-op for every row it has already resolved, and
 * ambiguous rows stay NULL.
 */
export async function backfillAbcClassSource(knex, companyIds = null) {
  return knex.raw(`
    UPDATE inventory_items
       SET abc_class_source = CASE
             WHEN abc_class IS NULL                          THEN 'calculated'
             WHEN abc_class_calculated IS NULL                THEN 'manual'
             WHEN abc_class::text <> abc_class_calculated::text THEN 'manual'
             ELSE NULL
           END
     WHERE abc_class_source IS NULL
       AND ($1::int[] IS NULL OR company_id = ANY($1::int[]))`, [companyIds]);
}

export async function up(knex) {
  await knex.raw(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS abc_class_source VARCHAR(12)`);

  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_abc_class_source_chk'`);
  if (!rows.length) {
    await knex.raw(`
      ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_abc_class_source_chk
        CHECK (abc_class_source IS NULL
               OR abc_class_source = 'calculated'
               OR (abc_class_source = 'manual' AND abc_class IS NOT NULL))
    `);
  }

  await backfillAbcClassSource(knex, null);
  await knex.raw(`ALTER TABLE inventory_items ALTER COLUMN abc_class_source SET DEFAULT 'calculated'`);

  const { rows: summary } = await knex.raw(`
    SELECT COALESCE(abc_class_source, 'ambiguous (NULL)') AS source, COUNT(*)::int AS items
      FROM inventory_items GROUP BY 1 ORDER BY 1`);
  console.log('[20261021000009] abc_class_source backfill:',
    summary.map(r => `${r.source}=${r.items}`).join(', '));
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE inventory_items
      DROP CONSTRAINT IF EXISTS inventory_items_abc_class_source_chk,
      DROP COLUMN IF EXISTS abc_class_source
  `);
}
