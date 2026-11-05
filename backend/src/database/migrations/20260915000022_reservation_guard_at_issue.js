/**
 * 20260915000022_reservation_guard_at_issue.js
 *
 * Retires the reservation-insert trigger added in 20260915000019/20/21 and
 * moves the guarantee to where the requirement actually puts it.
 *
 * ── WHY THE FIRST DESIGN WAS WRONG ──────────────────────────────────────────
 * The trigger refused any reservation whose quantity exceeded stock on hand. It
 * worked, and the message was clear, and it was the wrong rule — it broke
 * planning outright:
 *
 *     Cannot promise 100 of item 3090: 0 on hand, 0 promised, 0 free
 *
 * Reserving material that has not arrived yet is not an error, it is the normal
 * manufacturing case. MRP nets a requirement, reserves against it, and only then
 * raises the PR that buys the stock; a works order is planned and its material
 * allocated weeks before delivery. A constraint that forbids promising anything
 * not already in the store makes reservation useless for planning and would have
 * been a production incident — 24 tests went red the moment it was applied, every
 * one a legitimate forward reservation.
 *
 * It was also the wrong way round to be wrong: it policed the PROMISE, which is
 * reversible and cheap to correct, while leaving the WITHDRAWAL — the
 * irreversible act — unguarded.
 *
 * ── WHAT THE REQUIREMENT ACTUALLY SAYS ──────────────────────────────────────
 * "Stock promised for a production order must not accidentally be issued to
 * another requirement."
 *
 * That is an ISSUE-time rule about physical stock, not a limit on promises. Two
 * orders may each legitimately reserve 100 of a part nobody has bought yet. What
 * must never happen is that the first order to walk up to the store takes stock
 * the second order was promised.
 *
 * ── WHERE THE GUARANTEE LIVES NOW ───────────────────────────────────────────
 * At issue, inside the transaction that draws the stock, where the requirement
 * being served is known — which a trigger on the reservation table cannot see.
 * `assertNotReservedElsewhere()` in execution.routes.js refuses an issue that
 * would take a lot below what OTHER live requirements are holding against it,
 * with a 409 naming the orders that hold the claim.
 *
 * The database keeps the invariant that does not need requirement context and
 * cannot be expressed in application code alone: a lot may not go negative
 * (inventory_batches_avail_nonneg_chk, added in 20260915000008 and still in
 * force). Between the two, stock cannot be over-issued and cannot be silently
 * taken from another order.
 */

export async function up(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_reservation_guard ON inventory_reservations`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_material_reservation_guard ON material_reservations`);
  await knex.raw(`DROP FUNCTION IF EXISTS reservation_guard()`);

  // The over-commitment the trigger was trying to prevent is still worth
  // SEEING — it is a planning signal, not an integrity violation. A view
  // reports it instead of refusing it, so buyers can act on the shortfall
  // rather than discovering it when the shop floor cannot be served.
  await knex.raw(`
    CREATE OR REPLACE VIEW v_reservation_over_commitment AS
    WITH promised AS (
      SELECT item_id,
             SUM(GREATEST(COALESCE(quantity_remaining, quantity_reserved, 0), 0)) AS qty
        FROM inventory_reservations
       WHERE LOWER(COALESCE(status,'')) IN ('active','partially_consumed')
       GROUP BY item_id
      UNION ALL
      SELECT item_id,
             SUM(GREATEST(COALESCE(qty_reserved,0) - COALESCE(qty_issued,0), 0))
        FROM material_reservations
       WHERE LOWER(COALESCE(status,'')) IN ('reserved','partially_issued')
       GROUP BY item_id
    ), total AS (
      SELECT item_id, SUM(qty) AS promised_qty FROM promised GROUP BY item_id
    ), lots AS (
      SELECT item_id, SUM(COALESCE(quantity_available,0)) AS lot_qty
        FROM inventory_batches
       WHERE deleted_at IS NULL
         AND LOWER(COALESCE(status,'available')) NOT IN ('rejected','quarantine','hold','blocked')
       GROUP BY item_id
    ), incoming AS (
      SELECT poi.item_id,
             SUM(GREATEST(COALESCE(poi.quantity,0) - COALESCE(poi.received_quantity,0), 0)) AS on_order
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
       WHERE po.deleted_at IS NULL
         AND LOWER(COALESCE(po.status,'')) NOT IN ('cancelled','closed','rejected','draft')
       GROUP BY poi.item_id
    )
    SELECT ii.id AS item_id, ii.company_id, ii.item_code, ii.item_name,
           COALESCE(l.lot_qty, 0)      AS available_qty,
           COALESCE(i.on_order, 0)     AS on_order_qty,
           t.promised_qty,
           t.promised_qty - COALESCE(l.lot_qty, 0) - COALESCE(i.on_order, 0) AS uncovered_qty
      FROM total t
      JOIN inventory_items ii ON ii.id = t.item_id
      LEFT JOIN lots     l ON l.item_id = t.item_id
      LEFT JOIN incoming i ON i.item_id = t.item_id
     WHERE t.promised_qty > COALESCE(l.lot_qty, 0) + COALESCE(i.on_order, 0)
  `);
}

export async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS v_reservation_over_commitment`);
}
