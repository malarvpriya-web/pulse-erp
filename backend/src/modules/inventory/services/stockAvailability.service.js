/**
 * What is actually issuable, once reservations are taken into account.
 *
 * Every issue path in this module used to ask the same narrow question — "is the
 * ledger balance at least the quantity I want?" — and so reserved stock was
 * freely issuable to whoever asked next. A reservation constrained other
 * reservations and nothing else, which made it a note rather than a claim.
 *
 * The rule these helpers enforce:
 *
 *   - Issuing WITHOUT a reservation draws on free stock only:
 *       available = on hand − everything currently reserved
 *   - Issuing WITH a reservation draws on that reservation's own remaining
 *     quantity. Its claim is what the reservation was for, so it is not blocked
 *     by itself — but it still cannot exceed what is physically on hand.
 *
 * Both readings run inside the caller's transaction, so the figures cannot move
 * between the check and the ledger write.
 */

/** Reservation states that still hold stock. Cancelled / consumed / expired do not. */
export const OPEN_RESERVATION_STATES = ['active', 'partially_consumed'];

const num = (v) => Number.parseFloat(v ?? 0) || 0;

/** On-hand, reserved and free quantities for one item at one warehouse. */
export async function availability(client, itemId, warehouseId) {
  const { rows: [bal] } = await client.query(
    `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS on_hand
       FROM stock_ledger WHERE item_id = $1 AND warehouse_id = $2`,
    [itemId, warehouseId]
  );
  const { rows: [res] } = await client.query(
    `SELECT COALESCE(SUM(quantity_remaining), 0) AS reserved
       FROM inventory_reservations
      WHERE item_id = $1 AND warehouse_id = $2 AND status = ANY($3)`,
    [itemId, warehouseId, OPEN_RESERVATION_STATES]
  );
  const onHand   = num(bal.on_hand);
  const reserved = num(res.reserved);
  return { onHand, reserved, available: onHand - reserved };
}

const fail = (message) => { throw Object.assign(new Error(message), { status: 422 }); };

/**
 * Authorise an issue of `qty`, and draw down `reservationId` when one is given.
 *
 * Call inside a transaction, immediately before writing the ledger entry.
 * Returns the availability figures so callers can report them.
 */
export async function authorizeIssue(client, { itemId, warehouseId, qty, reservationId = null }) {
  const quantity = num(qty);
  if (!(quantity > 0)) fail('Issue quantity must be a positive number.');

  const figures = await availability(client, itemId, warehouseId);

  if (!reservationId) {
    if (quantity > figures.available) {
      fail(
        `Insufficient unreserved stock for item ${itemId}: ${figures.available} available ` +
        `(${figures.onHand} on hand, ${figures.reserved} reserved). Requested ${quantity}. ` +
        `Issue against a reservation to draw on reserved stock.`
      );
    }
    return figures;
  }

  // FOR UPDATE so two issues cannot both spend the same remaining quantity.
  const { rows: [reservation] } = await client.query(
    `SELECT id, item_id, warehouse_id, quantity_remaining, status
       FROM inventory_reservations WHERE id = $1 FOR UPDATE`,
    [reservationId]
  );
  if (!reservation) fail(`Reservation ${reservationId} not found.`);
  if (String(reservation.item_id) !== String(itemId) ||
      String(reservation.warehouse_id) !== String(warehouseId)) {
    fail(`Reservation ${reservationId} is for a different item or warehouse.`);
  }
  if (!OPEN_RESERVATION_STATES.includes(reservation.status)) {
    fail(`Reservation ${reservationId} is ${reservation.status} and holds no stock.`);
  }

  const remaining = num(reservation.quantity_remaining);
  if (quantity > remaining) {
    fail(`Reservation ${reservationId} has ${remaining} remaining; requested ${quantity}.`);
  }
  // The reservation guarantees this quantity, but it cannot conjure stock that
  // was never received — a reservation made before a receipt fell through would
  // otherwise issue against nothing.
  if (quantity > figures.onHand) {
    fail(`Only ${figures.onHand} on hand for item ${itemId}; requested ${quantity}.`);
  }

  await client.query(
    `UPDATE inventory_reservations
        SET quantity_consumed  = COALESCE(quantity_consumed, 0) + $1,
            quantity_remaining = quantity_remaining - $1,
            status = CASE WHEN quantity_remaining - $1 <= 0 THEN 'fully_consumed'
                          ELSE 'partially_consumed' END,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
    [quantity, reservationId]
  );

  return { ...figures, reservation_id: reservationId, reservation_remaining: remaining - quantity };
}
