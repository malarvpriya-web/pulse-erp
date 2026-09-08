/**
 * Give the negotiated price book a tenant boundary.
 *
 * `price_history` is the manually-kept half of what a buyer sees on the Price
 * History screen — the other half is derived from purchase orders, which carry
 * `company_id` and were already scoped. This table had NO `company_id` column at
 * all, so five endpoints had nothing to scope the manual leg on and returned
 * every tenant's negotiated prices to any caller holding procurement view:
 *
 *   GET /procurement/price-history          (PO leg scoped, manual leg not)
 *   GET /procurement/price-history/compare  (neither leg scoped)
 *   GET /procurement/vendor-comparison      (PO leg scoped, manual leg not)
 *
 * Verified live before this change: a token scoped to company 999901 received
 * company 1's supplier names, unit prices, quantities and the buyer's own notes
 * ("Reviewed and found acceptable against the agreed specification"), plus the
 * min/max/avg price statistics computed over them. That is the single most
 * commercially sensitive read in the module — what a competitor would pay for.
 *
 * The role dimension on this data was closed in section 152. The tenant
 * dimension was not, because the column to close it on did not exist.
 *
 * BACKFILL
 * --------
 * Through the item: `price_history.item_id` FKs `inventory_items(id)`, and an
 * item belongs to exactly one company. That is an assertion the schema already
 * enforces, not a guess. Falls back to the vendor's company for a row whose
 * item has since been removed, and leaves NULL where neither is available —
 * NULL is already this codebase's "global" scope and is visible to a super
 * admin, which is where a row nobody can attribute belongs.
 *
 * The two sources are cross-checked and any row where they DISAGREE is reported
 * rather than silently resolved in favour of the item: a price row whose item
 * and vendor sit in different companies is a data problem a person should see.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE price_history ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await knex.raw(`ALTER TABLE price_history DROP CONSTRAINT IF EXISTS price_history_company_id_fkey`);
  await knex.raw(`
    ALTER TABLE price_history
      ADD CONSTRAINT price_history_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
  `);

  const { rows: conflicting } = await knex.raw(`
    SELECT ph.id, ii.company_id AS item_company, v.company_id AS vendor_company
      FROM price_history ph
      JOIN inventory_items ii ON ii.id = ph.item_id
      JOIN vendors v          ON v.id  = ph.vendor_id
     WHERE ph.company_id IS NULL
       AND ii.company_id IS NOT NULL
       AND v.company_id  IS NOT NULL
       AND ii.company_id <> v.company_id
  `);

  const { rows: byItem } = await knex.raw(`
    UPDATE price_history ph
       SET company_id = ii.company_id
      FROM inventory_items ii
     WHERE ph.company_id IS NULL
       AND ph.item_id = ii.id
       AND ii.company_id IS NOT NULL
    RETURNING ph.id
  `);

  const { rows: byVendor } = await knex.raw(`
    UPDATE price_history ph
       SET company_id = v.company_id
      FROM vendors v
     WHERE ph.company_id IS NULL
       AND ph.vendor_id = v.id
       AND v.company_id IS NOT NULL
    RETURNING ph.id
  `);

  const { rows: [orphaned] } = await knex.raw(`
    SELECT COUNT(*)::int AS n FROM price_history WHERE company_id IS NULL
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_price_history_company ON price_history(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_price_history_company_item ON price_history(company_id, item_id)`);

  console.log(
    `[20260904000001] price_history.company_id added; ${byItem.length} row(s) attributed via their ` +
    `item, ${byVendor.length} via their vendor, ${orphaned.n} left unattributed (global scope).`
  );
  for (const c of conflicting) {
    console.warn(
      `[20260904000001] price row #${c.id}: its item belongs to company ${c.item_company} but its ` +
      `vendor to company ${c.vendor_company}. Attributed to the item's company; the disagreement ` +
      `itself needs a person to resolve.`
    );
  }
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_price_history_company_item`);
  await knex.raw(`DROP INDEX IF EXISTS idx_price_history_company`);
  await knex.raw(`ALTER TABLE price_history DROP CONSTRAINT IF EXISTS price_history_company_id_fkey`);
  await knex.raw(`ALTER TABLE price_history DROP COLUMN IF EXISTS company_id`);
}
