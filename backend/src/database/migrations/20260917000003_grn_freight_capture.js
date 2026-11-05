/**
 * 20260917000003_grn_freight_capture.js
 *
 * Freight is a per-CONSIGNMENT cost, and nothing in the schema could hold it
 * at that grain.
 *
 * ── THE GAP ─────────────────────────────────────────────────────────────────
 * The TCO engine wants a vendor's observed freight ratio. Before this
 * migration it could only be assembled from two places, and both are per-PO:
 *
 *   purchase_orders.freight_amount   numeric DEFAULT 0
 *   landed_costs (one row per po_id, no FK until 20260917000002)
 *
 * A purchase order is not a shipment. One PO is routinely received in several
 * consignments — part loads, back orders, a split delivery after a shortage —
 * and each arrives on its own lorry with its own carrier bill. Transport cost
 * genuinely differs every time, which is precisely the thing a per-PO column
 * cannot record. Booking the second consignment's freight overwrites the
 * first, so the "observed" ratio is whichever receipt was costed last.
 *
 * `goods_receipt_notes` IS the consignment — it is the row created when a
 * vehicle arrives — and it carried no cost columns at all.
 *
 * ── WHY NULLABLE WITH NO DEFAULT ────────────────────────────────────────────
 * These three columns are deliberately NULL-able and deliberately carry NO
 * DEFAULT, which is the opposite of how purchase_orders.freight_amount was
 * declared (`numeric DEFAULT 0`).
 *
 * That default is the reason the existing data is unusable. Every one of the
 * six live POs holds freight_amount = 0.00 — not because freight was zero, but
 * because nobody was ever asked. A NOT NULL DEFAULT 0 makes "never captured"
 * and "genuinely free of charge" the same value, and the TCO service then
 * cannot tell them apart:
 *
 *     COALESCE(lc.freight_cost, po.freight_amount, 0)
 *
 * never reaches its third branch, because the second is never NULL. This is the
 * standing `unmeasured != zero` rule that shared/gstRate.js, tco.service's
 * masterRate() and 20260902000004 were each written to enforce; a DEFAULT 0
 * here would reproduce the exact bug this migration exists to fix.
 *
 * So: NULL means "this receipt was not costed", and the engine reports the
 * freight line as `assumed` and says so on the page. A real zero — a delivery
 * the vendor genuinely carried free — is entered as 0 by a human, and it counts.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 * Freight, insurance and other charges only. NOT customs duty: the TCO engine
 * takes duty by its own route (`duty_amount` / `duty_pct` on the quote) and the
 * observed-freight ratio does not read it, so a duty column here would be a
 * field that is written and never read — the failure mode logged in
 * project_feature_exists_but_mounted_nowhere. Duty stays on landed_costs, which
 * is where the bill-of-entry workflow already puts it.
 *
 * Amounts are consignment-level totals in the PO's currency, matching how a
 * carrier actually bills: one figure for the vehicle, not a rate per unit.
 * tco.service apportions across the receipt's lines by value.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE goods_receipt_notes ADD COLUMN IF NOT EXISTS freight_amount   NUMERIC(14,2)`);
  await knex.raw(`ALTER TABLE goods_receipt_notes ADD COLUMN IF NOT EXISTS insurance_amount NUMERIC(14,2)`);
  await knex.raw(`ALTER TABLE goods_receipt_notes ADD COLUMN IF NOT EXISTS other_charges    NUMERIC(14,2)`);

  // A negative carrier bill is a credit note, not a receipt cost. Letting one
  // through would subtract from the vendor's observed freight ratio and make
  // them look cheaper to ship from than they are.
  await knex.raw(`
    ALTER TABLE goods_receipt_notes
      ADD CONSTRAINT grn_inbound_charges_non_negative_chk
      CHECK (
        (freight_amount   IS NULL OR freight_amount   >= 0) AND
        (insurance_amount IS NULL OR insurance_amount >= 0) AND
        (other_charges    IS NULL OR other_charges    >= 0)
      )
  `);

  // The observed-freight query groups receipts by PO to reach the vendor.
  // Partial: only costed receipts are ever scanned for it.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_grn_costed_po
      ON goods_receipt_notes(po_id)
     WHERE freight_amount IS NOT NULL
        OR insurance_amount IS NOT NULL
        OR other_charges IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_grn_costed_po`);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP CONSTRAINT IF EXISTS grn_inbound_charges_non_negative_chk`);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP COLUMN IF EXISTS other_charges`);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP COLUMN IF EXISTS insurance_amount`);
  await knex.raw(`ALTER TABLE goods_receipt_notes DROP COLUMN IF EXISTS freight_amount`);
}
