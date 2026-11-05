/**
 * 20260917000002_tco_input_integrity.js
 *
 * Component 360's vendor comparison was ranking on two numbers that no human
 * ever entered: an 81% discount and a freight figure nobody could reach.
 *
 * ── 1. THE PRICE BOOK'S "CHEAPEST QUOTE" WAS A SEED ARTEFACT ────────────────
 * Component 360 for ITM-004 (Desk Chair) headlined "Best Price ₹370.6 from
 * Microsoft India" and a "price spread 2,328.5%". Both came from one row of
 * `item_vendor_prices`:
 *
 *     unit_price 1950.50, discount_pct 81.000, tax_pct 81.000
 *     net = 1950.50 x (1 - 0.81) = 370.595
 *
 * The same value in BOTH columns is the tell. Across the five contaminated
 * rows the values are an arithmetic progression:
 *
 *     id 23  1250.50   55.0        id 26  1775.50   74.5
 *     id 24  1425.50   61.5        id 27  1950.50   81.0
 *     id 25  1600.50   68.0
 *
 * unit_price steps +175, the percentage steps +6.5 — and 55 + i * 6.5 is
 * verbatim the percentage branch of `scripts/seed/lib-values.mjs`:
 *
 *     if (/(percent|pct|percentage|utilization|efficiency|progress)/.test(n))
 *       return Number(Math.min(100, 55 + i * 6.5).toFixed(2));
 *
 * All five rows were written within 8ms of each other in the 2026-08-20 seed
 * run. The generator classifies purely on column NAME, so it fed the same
 * meaningless percentage to `discount_pct` and to `tax_pct` — a column where 81
 * is not a GST rate that exists.
 *
 * This is the same defect 20260902000004_percentage_rate_range_checks closed
 * for the `_rate` family. That migration constrained 35 rate columns and left
 * the `_pct` family untouched; `item_vendor_prices` is in the gap. (A live
 * sweep finds the same 55/61.5/68/74.5/81 signature in ~30 other `_pct`
 * columns — out of scope here, and NOT swept in, because a data remediation
 * must touch only the rows it actually measured.)
 *
 * WHAT THE ROWS BECOME
 *   discount_pct -> 0     There is no evidence of any negotiated discount, and
 *                         for a discount the absence of one IS zero: net price
 *                         then equals list price, which is the honest reading.
 *                         The column is NOT NULL DEFAULT 0 already.
 *   tax_pct      -> NULL  Zero would assert "nil-rated supply", which is a
 *                         false statement about a taxable one. NULL is "the
 *                         price book did not state a rate", and it is also the
 *                         value that makes the app correct: itemSourcing.routes
 *                         already reads `v.tax_pct ?? itemTaxPct`, so a NULL
 *                         falls through to resolveGstRate(item) — 18% for these
 *                         items via inventory_items.default_gst_rate.
 *
 * That fallback is why the column must lose both its NOT NULL and its
 * DEFAULT 0. Leaving DEFAULT 0 in place would mean any INSERT that omits the
 * rate still lands a literal 0 and still suppresses the item's real GST rate —
 * the "a column default quietly defines a workflow" trap that shared/gstRate.js
 * was written to document.
 *
 * ── 2. EVERY LANDED COST IN THE DATABASE WAS ORPHANED ───────────────────────
 * The TCO engine's freight input has a four-level waterfall (tcoEngine.js):
 * quoted order amount, quoted per-unit, OBSERVED from this vendor's history,
 * then the company default. Level 3 is loaded by tco.service.loadVendorPerformance:
 *
 *     SUM(COALESCE(lc.freight_cost, po.freight_amount, 0) + ...)
 *       FROM purchase_orders po LEFT JOIN landed_costs lc ON lc.po_id = po.id
 *
 * It returned 0.00 for every vendor, so every vendor on every comparison fell
 * through to level 4 — a flat 2% of order value, identical for all of them,
 * contributing nothing to the ranking while scaling with price.
 *
 * `landed_costs` is not empty. It holds five rows carrying ₹125,000 to ₹275,000
 * of freight. They point at po_id 1, 2, 3, 4 and 5 — and no such purchase
 * orders exist. The live ids are 12, 13, 28741-28743 and 35591. The LEFT JOIN
 * has never matched a single row.
 *
 * Nothing prevented this: `landed_costs.po_id` carried no foreign key at all.
 * The table's only constraints were NOT NULLs, a PK and two CHECKs.
 *
 * The five rows are deleted rather than re-pointed. Re-pointing would mean
 * inventing an attribution — there is no evidence tying ₹125,000 of freight to
 * any surviving PO, and guessing one would put a fabricated cost into a
 * comparison that awards real business. They are seed debris on their own
 * evidence: created in the same 2026-08-20 batch, and each carries
 * total_landed_cost EQUAL TO freight_cost while duty, insurance and other
 * charges sit at 100/125/150/175/200 — an arithmetic the live writer
 * (inventory.routes.js POST /landed-costs) does not produce, since it sums all
 * four. Their values are preserved verbatim in down().
 *
 * The FK is then added so the condition cannot recur, with ON DELETE CASCADE:
 * a landed cost has no meaning once its PO is gone.
 */

// The seed generator's percentage ladder: 55 + i * 6.5, capped at 100.
// 0 and 100 are EXCLUDED. Both occur legitimately elsewhere (two later
// price-book rows carry a true 0/0, and 100 is a real value for
// gst_input_credit_pct and abc_cumulative_pct), and a remediation that cannot
// tell a collision from a corruption is not a remediation.
const SEED_PCT_LADDER = [55, 61.5, 68, 74.5, 81, 87.5, 94];

export async function up(knex) {
  // ── 1. Price book ─────────────────────────────────────────────────────────
  // Nullable + no default FIRST, so the UPDATE below can write NULL.
  await knex.raw(`ALTER TABLE item_vendor_prices ALTER COLUMN tax_pct DROP NOT NULL`);
  await knex.raw(`ALTER TABLE item_vendor_prices ALTER COLUMN tax_pct DROP DEFAULT`);

  // Scoped to the signature, not to a row count: discount and tax carrying the
  // SAME value, and that value on the generator's ladder. On this database that
  // is exactly the five measured rows and nothing else.
  await knex.raw(
    `UPDATE item_vendor_prices
        SET discount_pct = 0,
            tax_pct      = NULL,
            updated_at   = NOW()
      WHERE discount_pct IS NOT NULL
        AND tax_pct IS NOT NULL
        AND discount_pct = tax_pct
        AND discount_pct = ANY($1::numeric[])`,
    [`{${SEED_PCT_LADDER.join(',')}}`]
  );

  // Prevention. Neither bound could have caught 81 on its own — 81 is a legal
  // percentage — but they stop the next generator defect from writing 899 or
  // 120 into a column that prices a purchase, which is how this family failed
  // the last two times.
  await knex.raw(`
    ALTER TABLE item_vendor_prices
      ADD CONSTRAINT item_vendor_prices_discount_pct_range_chk
      CHECK (discount_pct >= 0 AND discount_pct <= 100)
  `);
  await knex.raw(`
    ALTER TABLE item_vendor_prices
      ADD CONSTRAINT item_vendor_prices_tax_pct_range_chk
      CHECK (tax_pct IS NULL OR (tax_pct >= 0 AND tax_pct <= 100))
  `);

  // ── 2. Landed costs ───────────────────────────────────────────────────────
  await knex.raw(`
    DELETE FROM landed_costs lc
     WHERE lc.po_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.id = lc.po_id)
  `);

  // po_id stays NULLABLE: the POST route accepts a landed cost with no PO
  // attached, and a NULL is honest ("not attributable"). What must be
  // impossible is a NON-NULL id pointing at nothing.
  await knex.raw(`
    ALTER TABLE landed_costs
      ADD CONSTRAINT landed_costs_po_id_fkey
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
  `);
  // An unindexed FK makes every PO delete scan this table, and the TCO
  // observed-freight join reads it per vendor on every comparison.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_landed_costs_po_id ON landed_costs(po_id)`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_landed_costs_po_id`);
  await knex.raw(`ALTER TABLE landed_costs DROP CONSTRAINT IF EXISTS landed_costs_po_id_fkey`);

  // The deleted rows, verbatim as they stood before up() ran. Restored with
  // their original ids so anything that referenced them still resolves; the
  // sequence is left alone because these ids are below its current value.
  // This is a restore of evidence, not an assertion that the rows are correct —
  // they are the seed debris described in the header.
  for (const r of [
    { id: 21, po_id: 1, freight: 125000, duty: 100, ins: 100, other: 100, total: 125000, method: 'value',  status: 'pending',   at: '2026-08-10T10:00:00Z', by: 1 },
    { id: 22, po_id: 2, freight: 162500, duty: 125, ins: 125, other: 125, total: 162500, method: 'qty',    status: 'allocated', at: '2026-08-11T10:00:00Z', by: 2 },
    { id: 23, po_id: 3, freight: 200000, duty: 150, ins: 150, other: 150, total: 200000, method: 'weight', status: 'pending',   at: '2026-08-12T10:00:00Z', by: 3 },
    { id: 24, po_id: 4, freight: 237500, duty: 175, ins: 175, other: 175, total: 237500, method: 'value',  status: 'allocated', at: '2026-08-13T10:00:00Z', by: 4 },
    { id: 25, po_id: 5, freight: 275000, duty: 200, ins: 200, other: 200, total: 275000, method: 'qty',    status: 'pending',   at: '2026-08-14T10:00:00Z', by: 5 },
  ]) {
    await knex.raw(
      `INSERT INTO landed_costs
         (id, po_id, freight_cost, customs_duty, insurance, other_charges,
          total_landed_cost, allocation_method, status, allocated_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.po_id, r.freight, r.duty, r.ins, r.other, r.total, r.method, r.status, r.at, r.by]
    );
  }

  await knex.raw(`ALTER TABLE item_vendor_prices DROP CONSTRAINT IF EXISTS item_vendor_prices_tax_pct_range_chk`);
  await knex.raw(`ALTER TABLE item_vendor_prices DROP CONSTRAINT IF EXISTS item_vendor_prices_discount_pct_range_chk`);

  // Put the five rows back as the seed left them, keyed on the repair's own
  // fingerprint (discount 0 + tax NULL) so a row edited by a human since is not
  // dragged back to 81%.
  for (const [id, pct] of [[23, 55], [24, 61.5], [25, 68], [26, 74.5], [27, 81]]) {
    await knex.raw(
      `UPDATE item_vendor_prices
          SET discount_pct = $2, tax_pct = $2
        WHERE id = $1 AND discount_pct = 0 AND tax_pct IS NULL`,
      [id, pct]
    );
  }

  await knex.raw(`UPDATE item_vendor_prices SET tax_pct = 0 WHERE tax_pct IS NULL`);
  await knex.raw(`ALTER TABLE item_vendor_prices ALTER COLUMN tax_pct SET DEFAULT 0`);
  await knex.raw(`ALTER TABLE item_vendor_prices ALTER COLUMN tax_pct SET NOT NULL`);
}
