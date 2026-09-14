/**
 * bills.po_id — the missing join between accounts payable and procurement.
 *
 * WHY THIS EXISTS
 * ---------------
 * §137 closed the spend cube's four wrong numbers but left it PO-only, because
 * there was no way out of purchase orders and into what was actually invoiced.
 * `bills` carried no reference to a purchase order at all, and the nearest
 * thing — `three_way_matches.vendor_invoice_no` — is free text, not a key. So:
 *
 *   - invoice spend (what suppliers billed) could not be compared to ordered
 *     spend (what we committed to), which is where leakage shows up;
 *   - non-PO spend could not be identified, and therefore neither could the
 *     maverick-spend ratio — the headline control metric of every spend suite;
 *   - PO-to-invoice variance had no expression.
 *
 * One nullable column with a foreign key behind it unlocks all of them.
 *
 * WHAT NULL MEANS, AND WHY THIS MIGRATION DOES NOT GUESS
 * -----------------------------------------------------
 * The backfill links a bill to a PO ONLY through `three_way_matches`, where a
 * human already asserted that this invoice belongs to that PO, and only where
 * the invoice number matches exactly within one company and resolves to exactly
 * one purchase order. Nothing is inferred from supplier name, amount or date.
 *
 * A name+amount+date heuristic would link most rows and be wrong for some, and
 * a wrong PO link is far worse than a missing one: it moves spend out of the
 * maverick bucket, which is the one number this column exists to produce. An
 * unlinked bill stays unlinked.
 *
 * That leaves `po_id IS NULL` carrying two meanings — genuinely non-PO spend,
 * and a bill raised before this column existed. The analytics layer must not
 * conflate them: `GET /procurement/analytics/invoice-spend` reports the two
 * separately, using the cut-off noted below, rather than reporting a maverick
 * ratio that silently counts every legacy row as maverick.
 *
 * On this database the backfill is expected to link zero rows: the single
 * three-way match sits at `matched`, never `approved`, so no bill was ever
 * auto-created from it, and all 21 existing bills are seeded non-PO spend
 * (office supplies, cloud, telecom, marketing). Zero linked rows is the
 * correct answer here, not a failed backfill.
 */

// The moment a bill could first carry a PO link is 2026-09-02 — the date this
// migration runs. Bills dated before it cannot be classified as PO-backed or
// non-PO, and `loadInvoiceSpend()` reports them as unclassifiable rather than
// assuming. That constant lives in spendAnalytics.service.js as
// PO_LINK_AVAILABLE_FROM and is the single runtime source of truth; it is NOT
// exported from here.
//
// Deliberately not imported the other way either. A migration is a frozen
// record of what ran on a given day: if it read a live app constant, editing
// that constant would retroactively change what this migration is documented to
// have done. Five migrations in this directory have already been deleted from
// disk while staying in the ledger — app code must never depend on one.

export async function up(knex) {
  // `bills` had no po/order/purchase column of any kind before this, so there
  // is no chance of the ADD COLUMN IF NOT EXISTS no-op that bites when a column
  // already exists under a different type.
  await knex.raw(`ALTER TABLE bills ADD COLUMN IF NOT EXISTS po_id INTEGER;`);

  // The type is asserted rather than assumed: purchase_orders.id is integer,
  // and a uuid/integer mismatch here would fail as 22P02 at query time rather
  // than at migration time.
  const { rows: typeRows } = await knex.raw(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'bills' AND column_name = 'po_id'`
  );
  if (typeRows[0]?.data_type !== 'integer') {
    throw new Error(`bills.po_id must be integer to reference purchase_orders(id), got ${typeRows[0]?.data_type}`);
  }

  // ON DELETE SET NULL: a deleted PO must not take the payable with it. The
  // bill is still money owed; it just stops being attributable to an order.
  await knex.raw(`
    ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_po_id_fkey;
    ALTER TABLE bills ADD CONSTRAINT bills_po_id_fkey
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_bills_po_id ON bills(po_id) WHERE po_id IS NOT NULL;`);

  // Backfill: only where a three-way match already asserted the relationship,
  // the invoice number matches exactly inside one company, and exactly one PO
  // is implicated. `HAVING COUNT(DISTINCT t.po_id) = 1` is what makes an
  // ambiguous invoice number stay NULL rather than pick a PO arbitrarily.
  const { rows: linked } = await knex.raw(`
    WITH unambiguous AS (
      SELECT b.id AS bill_id, MIN(t.po_id) AS po_id
        FROM bills b
        JOIN three_way_matches t
          ON t.vendor_invoice_no = b.bill_number
         AND t.company_id IS NOT DISTINCT FROM b.company_id
       WHERE b.po_id IS NULL
         AND b.deleted_at IS NULL
         AND b.bill_number IS NOT NULL
         AND t.po_id IS NOT NULL
       GROUP BY b.id
      HAVING COUNT(DISTINCT t.po_id) = 1
    )
    UPDATE bills b
       SET po_id = u.po_id
      FROM unambiguous u
     WHERE b.id = u.bill_id
    RETURNING b.id
  `);

  console.log(`[20260902000001] bills.po_id added; backfilled ${linked?.length ?? 0} bill(s) from three_way_matches.`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_bills_po_id;`);
  await knex.raw(`ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_po_id_fkey;`);
  await knex.raw(`ALTER TABLE bills DROP COLUMN IF EXISTS po_id;`);
}
