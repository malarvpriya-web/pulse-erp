/**
 * Repair two pieces of procurement data that code fixes alone cannot reach.
 *
 * Both were found by probing the live module, not by reading it — each looked
 * correct in the source and was wrong only in the rows.
 *
 * ── 1. purchase_order_items.received_qty was never written ───────────────────
 * The table carries two receipt columns. `received_quantity` is the one the GRN
 * service has always incremented and the one the procurement module and the
 * goods-receipt screen read. `received_qty` was added by the 20260426
 * module-tables migration and NOTHING has ever written to it — every row in the
 * table reads 0.00 on it regardless of what was actually received.
 *
 * That would be harmless drift if nothing read it, but mrpEngine.service.js
 * computes open purchase supply as `quantity - COALESCE(received_qty, 0)` in
 * four places. With the column pinned at zero the planner treats every PO line
 * ever raised as still fully inbound: a PO for 5 units, received in full months
 * ago, still counts as 5 units of incoming supply forever. MRP therefore
 * under-orders against stock that will never arrive, and it gets worse with
 * every PO the business closes.
 *
 * purchaseOrder.repository.updateItemReceived now writes both columns on every
 * receipt. This backfills the rows that already exist so the planner is correct
 * from the first run after deploy rather than only for future receipts.
 *
 * ── 2. purchase_requests.status = 'pending' is a status no screen counts ─────
 * The column DEFAULTS to 'pending' and the create route never set a status, so
 * every requisition raised through the app inherited it. Nothing in the product
 * reads that value: the PR stats endpoint, the procurement dashboard's pending
 * count, the status filter and STATUS_META in PurchaseRequest.jsx are all keyed
 * on 'pending_approval'. The result was a requisition that existed in the table,
 * was absent from the "Pending Approval" KPI (which read 0 immediately after one
 * was raised), missing from the approval queue's filter, and rendered under the
 * grey "Draft" chip because its status matched no entry in the map.
 *
 * The repository now sets 'pending_approval' explicitly at INSERT. This moves
 * the rows already sitting in the orphan status onto the vocabulary the rest of
 * the system speaks, so historic requisitions become visible and actionable
 * instead of silently stuck.
 */

export async function up(knex) {
  // ── 1. received_qty backfill ───────────────────────────────────────────────
  const { rows: drifted } = await knex.raw(`
    SELECT COUNT(*)::int AS n
      FROM purchase_order_items
     WHERE COALESCE(received_qty, 0) IS DISTINCT FROM COALESCE(received_quantity, 0)
  `);

  await knex.raw(`
    UPDATE purchase_order_items
       SET received_qty = COALESCE(received_quantity, 0)
     WHERE COALESCE(received_qty, 0) IS DISTINCT FROM COALESCE(received_quantity, 0)
  `);

  // ── 2. PR status vocabulary ────────────────────────────────────────────────
  // Only the bare 'pending' is moved. 'draft' is a real state the UI offers and
  // is left alone; every other status is already canonical.
  const { rows: moved } = await knex.raw(`
    UPDATE purchase_requests
       SET status = 'pending_approval', updated_at = CURRENT_TIMESTAMP
     WHERE status = 'pending'
       AND deleted_at IS NULL
    RETURNING id, request_number
  `);

  // Stop the column default from re-creating the orphan status for any writer
  // that forgets to pass one — the repository sets it explicitly now, but a
  // default that disagrees with the application's vocabulary is a trap waiting
  // for the next INSERT that omits the column.
  await knex.raw(`
    ALTER TABLE purchase_requests ALTER COLUMN status SET DEFAULT 'pending_approval'
  `);

  console.log(
    `[20260902000003] received_qty backfilled on ${drifted[0]?.n ?? 0} PO line(s); ` +
    `${moved?.length ?? 0} purchase request(s) moved from 'pending' to 'pending_approval'; ` +
    `purchase_requests.status default is now 'pending_approval'.`
  );
}

export async function down(knex) {
  // received_qty is deliberately NOT zeroed again: restoring a column to a value
  // that was only ever wrong would re-break MRP, and the column carrying the
  // right number harms nothing under the previous code.
  await knex.raw(`
    ALTER TABLE purchase_requests ALTER COLUMN status SET DEFAULT 'pending'
  `);
}
