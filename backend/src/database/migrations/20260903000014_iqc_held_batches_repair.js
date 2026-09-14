/**
 * Take back the stock that was published while Quality was still holding it.
 *
 * THE DEFECT (fixed in code by grn.service.postAcceptedStock)
 * ----------------------------------------------------------
 * When `quality_settings.require_iqc_before_stock` is on, a goods receipt is
 * supposed to hold its accepted quantity out of usable stock until an incoming
 * inspection clears it. The receipt path withheld the STOCK LEDGER entry — and
 * created the inventory BATCH anyway, with `quantity_available` set to the full
 * accepted quantity.
 *
 * `quantity_available` is what allocation, valuation, `v_batch_stock` and the
 * low-stock endpoints all read. So the hold held nothing: the goods were
 * available to pick and to value from the moment they were booked in, while the
 * ledger — the thing an auditor reconciles against — had no record of them at
 * all. Two records for the same event, with different lifetimes and different
 * truths.
 *
 * WHAT THIS REPAIRS
 * -----------------
 * Receipts still awaiting (or failing) inspection that have a live batch and no
 * stock-ledger entry. In this database: GRN0005 (5 units) and GRN0006 (2 units),
 * both booked 2026-08-05 and both still `quality_status = 'pending'` — seven
 * units that have been pickable for a month without ever passing inspection.
 *
 * The batches are SOFT-deleted, not dropped. `v_batch_stock` filters
 * `deleted_at IS NULL`, so the quantity leaves every stock figure at once, while
 * the row stays for anyone reconciling the correction.
 *
 * Nothing is lost by doing this: `grnService.releaseGrnStock()` keys its
 * idempotency on the STOCK LEDGER (`reference_type='grn'`), not on the batch, so
 * when Quality does clear one of these receipts the release path creates the
 * batch and the ledger entry together, correctly, exactly as it would for a new
 * receipt. The repair puts these receipts back into the state they should have
 * been in all along: goods received, recorded on the GRN, not yet usable.
 *
 * NOT REPAIRED HERE, DELIBERATELY:
 *   - a batch with `quantity_consumed > 0` is skipped and reported. Something has
 *     already been issued from it, so withdrawing it now would drive a downstream
 *     document negative. That needs a person, not a migration.
 *   - `inventory_items.current_stock` is untouched. These batches never reached
 *     the ledger, and `postStock()` is the only thing that moves current_stock,
 *     so it never counted them — adjusting it would introduce the error this
 *     removes.
 */

export async function up(knex) {
  const { rows: held } = await knex.raw(`
    SELECT b.id, b.grn_id, b.batch_number, b.quantity_available, b.quantity_consumed,
           g.grn_number, g.quality_status
      FROM inventory_batches b
      JOIN goods_receipt_notes g ON g.id = b.grn_id
     WHERE b.deleted_at IS NULL
       AND g.deleted_at IS NULL
       -- Quality has not cleared it...
       AND COALESCE(g.quality_status, 'not_required') IN ('pending', 'in_progress', 'failed')
       -- ...and it never reached the ledger, so nothing has accounted for it.
       AND NOT EXISTS (
         SELECT 1 FROM stock_ledger s
          WHERE s.reference_type = 'grn' AND s.reference_id = g.id
       )
  `);

  const consumed = held.filter(h => Number(h.quantity_consumed) > 0);
  const safe     = held.filter(h => Number(h.quantity_consumed) === 0);

  if (safe.length) {
    await knex.raw(
      `UPDATE inventory_batches SET deleted_at = NOW(), updated_at = NOW() WHERE id = ANY($1)`,
      [safe.map(s => s.id)]
    );
  }

  const qty = safe.reduce((s, h) => s + Number(h.quantity_available || 0), 0);
  console.log(
    `[20260903000014] withdrew ${safe.length} inventory batch(es) totalling ${qty} unit(s) that were ` +
    `published while their goods receipt was still awaiting inspection` +
    (safe.length ? ': ' + safe.map(s => `${s.grn_number} (${s.quantity_available})`).join(', ') : '') +
    `. They reappear, with a matching stock-ledger entry, when Quality clears the receipt.`
  );

  for (const c of consumed) {
    console.warn(
      `[20260903000014] batch #${c.id} (${c.batch_number}, ${c.grn_number}) was published before ` +
      `inspection AND has ${c.quantity_consumed} unit(s) already consumed — left in place. ` +
      `Withdrawing it now would drive a downstream document negative; this one needs a human decision.`
    );
  }
}

export async function down(knex) {
  // Deliberately NOT reversed. Restoring these batches would put uninspected
  // goods back into available stock, which is the corruption, not the change.
  await knex.raw(`SELECT 1`);
}
