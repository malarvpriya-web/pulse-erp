/**
 * Give every requisition in the register a document number.
 *
 * Four code paths wrote into `purchase_requests` and three of them got the
 * number wrong: production/mrp.routes.js put it in `pr_number` (the legacy
 * column procurement does not read), while production/bom.routes.js and
 * production/execution.routes.js minted none at all. All three now route
 * through purchaseRequest.repository.createSystemRequest, so no NEW row can
 * arrive without one — but the rows already in the table keep their blank.
 *
 * A requisition with no number is not a cosmetic problem. It cannot be quoted in
 * an approval, searched for, referenced in a conversation with a requester, or
 * reconciled against anything; the register simply shows an empty cell where
 * every other row has an identifier.
 *
 * Two cases, handled differently:
 *
 *   1. `pr_number` is set but `request_number` is not — an MRP-converted row
 *      that already HAS a number, filed in the wrong column. Copy it across
 *      rather than mint a second one, so the number the planner recorded in
 *      `mrp_planned_orders.converted_ref` still resolves to this requisition.
 *
 *   2. Neither is set — mint from the same `seq_pr` sequence the application
 *      uses, so the backfilled numbers sit in the same series and cannot
 *      collide with anything issued before or after.
 *
 * Deliberately does NOT invent line items, amounts or a requester for these
 * rows. Several are empty ₹0 drafts, which is what the broken writers produced;
 * a number makes them identifiable and dismissible, and inventing content would
 * turn debris into fabricated demand.
 */

export async function up(knex) {
  // Case 1 — recover the number that already exists in the legacy column.
  const { rows: moved } = await knex.raw(`
    UPDATE purchase_requests
       SET request_number = pr_number, updated_at = CURRENT_TIMESTAMP
     WHERE request_number IS NULL
       AND pr_number IS NOT NULL
       AND deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM purchase_requests o
          WHERE o.request_number = purchase_requests.pr_number
       )
    RETURNING id, request_number
  `);

  // Case 2 — mint from seq_pr, the same sequence nextPurchaseRequestNumber uses,
  // so backfilled numbers share one series with everything the app issues.
  // The prefix is read per company from procurement_settings, matching what the
  // application would have produced for that company at the time.
  const { rows: minted } = await knex.raw(`
    UPDATE purchase_requests pr
       SET request_number = COALESCE(
             NULLIF(regexp_replace(UPPER(COALESCE(s.pr_prefix, 'PR')), '[^A-Z0-9-]', '', 'g'), ''),
             'PR'
           ) || LPAD(nextval('seq_pr')::TEXT, 4, '0'),
           updated_at = CURRENT_TIMESTAMP
      FROM (SELECT 1) AS _
      LEFT JOIN procurement_settings s ON TRUE
     WHERE pr.request_number IS NULL
       AND pr.pr_number IS NULL
       AND pr.deleted_at IS NULL
       AND (s.company_id IS NULL OR s.company_id = pr.company_id)
    RETURNING pr.id, pr.request_number
  `);

  const { rows: [left] } = await knex.raw(`
    SELECT COUNT(*)::int AS n FROM purchase_requests
     WHERE request_number IS NULL AND deleted_at IS NULL
  `);

  console.log(
    `[20260902000004] purchase request numbers backfilled — ` +
    `${moved?.length ?? 0} recovered from the legacy pr_number column, ` +
    `${minted?.length ?? 0} newly minted from seq_pr; ${left.n} still without a number.`
  );
}

export async function down() {
  // Not reversed. Clearing these would restore rows the register cannot display
  // properly, and the minted numbers are consumed from a shared sequence that
  // other requisitions have since advanced past — putting them back would not
  // recover the sequence values either way.
}
