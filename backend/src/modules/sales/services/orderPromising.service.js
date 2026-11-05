// backend/src/modules/sales/services/orderPromising.service.js
//
// What happens to a customer order the moment it is accepted: check it can be
// promised, reserve what exists, backorder what does not, and consume the
// forecast it was already planned against.
//
// WHY THIS EXISTS
// ---------------
// The 2026-09-11 SCA audit found four separate holes in order intake, all of
// them things the system already had the pieces for:
//
//   AVAILABLE-TO-PROMISE  computeATP() in mrpEngine.service.js is a correct
//     discrete + cumulative ATP implementation. Nothing called it. Order entry
//     validated credit and nothing else, so an order could be accepted for
//     quantities that neither stock nor supply could cover, with no signal.
//
//   ALLOCATION  inventory_allocations existed with write paths, and picking
//     never checked it. Stock was effectively first-come-first-served at pick
//     time regardless of what had been promised to whom.
//
//   BACKORDERS  had no representation at all. An under-supplied order simply
//     stalled, with nothing in the system saying what was short or when it might
//     arrive.
//
//   FORECAST CONSUMPTION  did not exist, which is what allowed someone to
//     hand-set consumed_qty equal to quantity and zero out all MRP demand. An
//     order that arrives against a forecast must consume it, or the same demand
//     is planned twice — once as forecast and once as the order.
//
// PROMISING IS NOT RATIONING. This does not refuse an order that exceeds
// availability; commercially that decision is not the software's to make. It
// records precisely what can be met from stock, what is covered by inbound
// supply, and what is genuinely short — and returns that so the person taking
// the order can make the call with real numbers.

import pool from '../../../config/db.js';
import { computeATP } from '../../production/mrpEngine.service.js';
import forecasting from '../../inventory/services/demandForecast.service.js';

const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Which warehouse an allocation should be taken from.
 *
 * `inventory_allocations.warehouse_id` is NOT NULL and both allocation paths
 * omitted it, so every call to promise an order died on the constraint and the
 * table stayed permanently empty. The ATP figure was real; the allocation it
 * was supposed to make had never once succeeded.
 *
 * The warehouse holding the most of the item is the right default: allocating
 * from a location that cannot fill the line is worse than not allocating.
 * Falls back to the company's first warehouse so an item with no ledger history
 * still allocates somewhere nameable rather than failing.
 */
async function warehouseHolding(client, itemId) {
  const { rows } = await client.query(`
    SELECT warehouse_id,
           SUM(COALESCE(quantity_in,0) - COALESCE(quantity_out,0)) AS qty
      FROM stock_ledger
     WHERE item_id = $1 AND warehouse_id IS NOT NULL
     GROUP BY warehouse_id
    HAVING SUM(COALESCE(quantity_in,0) - COALESCE(quantity_out,0)) > 0
     ORDER BY qty DESC LIMIT 1`, [itemId]);
  if (rows[0]?.warehouse_id) return rows[0].warehouse_id;
  // The item's own company's first warehouse — never another tenant's. This
  // fallback used to take the lowest-numbered warehouse of ANY company.
  const { rows: any } = await client.query(
    `SELECT w.id FROM warehouses w
      WHERE w.deleted_at IS NULL
        AND w.company_id IS NOT DISTINCT FROM (SELECT company_id FROM inventory_items WHERE id = $1)
      ORDER BY w.id LIMIT 1`, [itemId]);
  return any[0]?.id ?? null;
}

// ── Shared by promising and backorder release ───────────────────────────────
//
// WHAT IS STILL RESERVED
// An order-promise allocation is never released by a writer. What is still
// reserved for an order is derived, per order and item, by
// v_sales_order_open_allocation: allocated minus what the order's pick lists
// hold out (stock leaves at PICK) minus approved legacy shipments, capped at
// what the order still needs, and zero once the order is delivered, completed,
// closed, cancelled or deleted.
//
// LOCK ORDER (no deadlocks between these and picks)
//   promise:         the order row  → its items, ascending id → its backorders
//   backorder release:                items, ascending id     → backorder rows
//   pick (reconcileStock): pick list → lines → items, ascending id (each ledger
//                    posting's trigger updates the item row)
//   cancel / delete: the order row  → its backorders
// Every path that takes item locks takes them in ascending id order and none
// takes an order row after an item, so two of these can wait for each other
// but never deadlock. current_stock is read under the item lock, so a promise
// and a pick on the same item serialise and each sees the other's result.

const INACTIVE_STATUSES = ['delivered', 'completed', 'closed', 'cancelled'];
const orderActive = (o) => o.deleted_at == null
  && !INACTIVE_STATUSES.includes(String(o.order_status || '').toLowerCase());

/** Lock item rows in ascending id order; current_stock as read under the lock. */
async function lockItems(client, itemIds) {
  const ids = [...new Set(itemIds.filter(v => v != null).map(Number))].sort((a, b) => a - b);
  if (!ids.length) return new Map();
  const { rows } = await client.query(
    `SELECT id, COALESCE(current_stock, 0) AS current_stock FROM inventory_items
      WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids]);
  return new Map(rows.map(r => [r.id, num(r.current_stock)]));
}

/**
 * Stock spoken for, per item: every order's OPEN promise allocation (from the
 * view — picked, shipped and inactive orders reserve nothing) plus
 * advanced_manual and historical NULL rows, which keep counting as before.
 * Consumption is excluded: its stock already left current_stock.
 */
async function committedByItem(client, itemIds) {
  const out = new Map();
  if (!itemIds.length) return out;
  const { rows: promised } = await client.query(
    `SELECT item_id, SUM(open_alloc_qty) AS qty FROM v_sales_order_open_allocation
      WHERE item_id = ANY($1::int[]) GROUP BY item_id`, [itemIds]);
  const { rows: other } = await client.query(
    `SELECT item_id, SUM(COALESCE(quantity, 0)) AS qty FROM inventory_allocations
      WHERE item_id = ANY($1::int[])
        AND allocation_source IS DISTINCT FROM 'consumption'
        AND allocation_source IS DISTINCT FROM 'order_promise'
      GROUP BY item_id`, [itemIds]);
  for (const r of [...promised, ...other]) out.set(r.item_id, (out.get(r.item_id) || 0) + num(r.qty));
  return out;
}

/** This order's open demand / open allocation / shipped, per item. */
async function openForOrder(client, orderId) {
  const { rows } = await client.query(
    `SELECT item_id, open_demand_qty, open_alloc_qty, shipped_qty
       FROM v_sales_order_open_allocation WHERE sales_order_id = $1`, [orderId]);
  return new Map(rows.map(r => [r.item_id, {
    open_demand: num(r.open_demand_qty), open_alloc: num(r.open_alloc_qty), shipped: num(r.shipped_qty),
  }]));
}

/**
 * Promise an order: ATP check + allocate + backorder + consume forecast.
 *
 * Re-promising is idempotent: only what the order still needs and does not
 * already have reserved is allocated, so promising twice never stacks
 * allocations. Several lines of one item share the item's figures, in line
 * order. An inactive order (deleted, delivered, completed, closed, cancelled)
 * is reported and nothing is written.
 *
 * @param {object} opts
 * @param {number} opts.orderId
 * @param {number|null} opts.companyId
 * @param {boolean} opts.allocate  false = check only, write nothing
 */
export async function promiseOrder({ orderId, companyId = null, allocate = true, actor = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [order] } = await client.query(
      `SELECT * FROM sales_orders WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [orderId, companyId]);
    if (!order) { await client.query('ROLLBACK'); return null; }
    const { rows: lines } = await client.query(`
      SELECT soi.*, ii.item_code, ii.item_name, ii.unit_of_measure, ii.company_id AS item_company_id
        FROM sales_order_items soi
        LEFT JOIN inventory_items ii ON ii.id = soi.item_id
       WHERE soi.order_id = $1 ORDER BY soi.id`, [orderId]);
    // Only the order's own company's items are promised: a line naming another
    // tenant's item would read that tenant's stock and reserve against it.
    const foreign = (l) => l.item_id != null && String(l.item_company_id ?? '') !== String(order.company_id ?? '');

    const orderSummary = { id: order.id, order_number: order.order_number, promised_date: order.promised_date };
    if (!orderActive(order)) {
      await client.query('ROLLBACK');
      const reason = order.deleted_at != null ? 'order is deleted' : `order is ${String(order.order_status).toLowerCase()}`;
      return {
        order: orderSummary, inactive: true, fully_promised: false, backordered_lines: 0,
        lines: lines.map(l => ({ line_id: l.id, item_id: l.item_id, item_code: l.item_code,
          quantity: 0, allocated: 0, backordered: 0, promised: false, reason })),
      };
    }

    const stock = await lockItems(client, lines.filter(l => !foreign(l)).map(l => l.item_id));
    const itemIds = [...stock.keys()];
    const committed = await committedByItem(client, itemIds);
    const own = await openForOrder(client, order.id);

    // Per item, shared out across the order's lines of that item in line order.
    const free = new Map(), need = new Map(), shippedLeft = new Map(), reservedLeft = new Map();
    for (const id of itemIds) {
      const o = own.get(id) || { open_demand: 0, open_alloc: 0, shipped: 0 };
      free.set(id, Math.max(0, stock.get(id) - (committed.get(id) || 0)));
      need.set(id, Math.max(0, o.open_demand - o.open_alloc));
      shippedLeft.set(id, o.shipped);
      reservedLeft.set(id, o.open_alloc);
    }

    const needDate = order.promised_date || order.delivery_date || order.order_date;
    const results = [];
    for (const line of lines) {
      const ordered = num(line.quantity);
      // A line with no item_id cannot be promised: there is nothing to check
      // availability of. Reported rather than silently passed, because this was
      // the state of every order line in the database before the item FK existed.
      if (!line.item_id) {
        results.push({ line_id: line.id, item_id: null,
          description: line.description, quantity: ordered,
          promised: false, reason: 'line is not linked to an item' });
        continue;
      }
      if (foreign(line)) {
        results.push({ line_id: line.id, item_id: line.item_id, quantity: ordered,
          promised: false, reason: 'item belongs to another company' });
        continue;
      }
      const id = line.item_id;
      const shippedShare = Math.min(ordered, shippedLeft.get(id) || 0);
      shippedLeft.set(id, (shippedLeft.get(id) || 0) - shippedShare);
      const lineOpen = Math.max(0, ordered - shippedShare);
      const reservedShare = Math.min(lineOpen, reservedLeft.get(id) || 0);
      reservedLeft.set(id, (reservedLeft.get(id) || 0) - reservedShare);
      const lineNeed = lineOpen - reservedShare;

      if (lineOpen <= 0) {
        if (allocate) {
          await client.query(`UPDATE sales_order_items SET allocated_qty = 0, backordered_qty = 0 WHERE id = $1`, [line.id]);
          await client.query(
            `UPDATE backorders SET status = 'closed', closed_at = NOW()
              WHERE sales_order_item_id = $1 AND status IN ('open','partial')`, [line.id]);
        }
        results.push({ line_id: line.id, item_id: id, item_code: line.item_code,
          quantity: 0, promised: true, reason: 'already fulfilled' });
        continue;
      }

      // ── Availability ──────────────────────────────────────────────────────
      // On-hand (read under the item lock) minus what is spoken for: every
      // order's OPEN reservation, Advanced Inventory and historical rows. ATP
      // adds dated inbound supply, which is what makes a future promise defensible.
      const freeStock = free.get(id) || 0;
      let atpTotal = null;
      try {
        const atp = await computeATP({ companyId, itemId: id, horizonDays: 180, bucketDays: 7 });
        atpTotal = atp ? num(atp.total_atp) : null;
      } catch { /* ATP is advisory here; a failure must not block order intake */ }
      const fromStock = Math.max(0, Math.min(lineNeed, freeStock, need.get(id) || 0));
      const shortfall = r3(lineNeed - fromStock);
      free.set(id, freeStock - fromStock);
      need.set(id, (need.get(id) || 0) - fromStock);
      const coveredBySupply = atpTotal === null ? null : Math.max(0, Math.min(shortfall, atpTotal - fromStock));
      const result = {
        line_id: line.id, item_id: id, item_code: line.item_code,
        item_name: line.item_name, quantity: r3(lineOpen),
        on_hand: num(stock.get(id)), already_allocated: num(committed.get(id) || 0),
        already_reserved_for_order: r3(reservedShare),
        available_now: r3(freeStock), atp_total: atpTotal,
        allocated: 0, backordered: 0,
        promised: shortfall <= 0.0001,
      };

      if (allocate) {
        if (fromStock > 0) {
          await client.query(`
            INSERT INTO inventory_allocations
              (item_id, warehouse_id, quantity, allocation_type, reference_type, reference_id,
               allocation_date, allocated_by, purpose, allocation_source)
            VALUES ($1,$2,$3,'sales_order','sales_order',$4,CURRENT_DATE,$5,$6,'order_promise')`,
            [id, await warehouseHolding(client, id), fromStock, orderId,
             actor.id ?? null, `Order ${order.order_number} line ${line.id}`]);
          result.allocated = r3(fromStock);
        }
        // What the line has reserved now — set, not accumulated, so a
        // re-promise cannot inflate it.
        await client.query(
          `UPDATE sales_order_items SET allocated_qty = $2, backordered_qty = $3 WHERE id = $1`,
          [line.id, r3(reservedShare + fromStock), shortfall > 0.0001 ? shortfall : 0]);

        if (shortfall > 0.0001) {
          // Idempotent: re-promising an order must not stack backorders. An
          // existing open or partial backorder is updated so that what is still
          // outstanding (backordered - released) equals today's shortfall.
          const { rows: [existing] } = await client.query(
            `SELECT id, COALESCE(qty_released, 0) AS qty_released FROM backorders
              WHERE sales_order_item_id = $1 AND status IN ('open','partial')
              ORDER BY id LIMIT 1 FOR UPDATE`, [line.id]);
          if (existing) {
            await client.query(
              `UPDATE backorders SET qty_backordered = $2, qty_available = $3, expected_date = $4 WHERE id = $1`,
              [existing.id, r3(num(existing.qty_released) + shortfall), freeStock, null]);
          } else {
            await client.query(`
              INSERT INTO backorders
                (company_id, sales_order_id, sales_order_item_id, order_number, item_id, item_name,
                 qty_ordered, qty_available, qty_backordered, promised_date, reason, priority, status)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open')`,
              [order.company_id, orderId, line.id, order.order_number, id, line.item_name,
               lineOpen, freeStock, shortfall, needDate,
               atpTotal !== null && atpTotal >= lineOpen ? 'awaiting_inbound_supply' : 'insufficient_supply',
               order.priority || 'normal']);
          }
          result.backordered = shortfall;
          result.covered_by_inbound_supply = coveredBySupply;
        } else {
          await client.query(
            `UPDATE backorders SET status = 'closed', closed_at = NOW()
              WHERE sales_order_item_id = $1 AND status IN ('open','partial')`, [line.id]);
        }

        // ── Forecast consumption ────────────────────────────────────────────
        // The order is real demand arriving against demand that was forecast.
        // Consuming it is what stops MRP planning the same units twice.
        // Idempotent per line (demand_forecast_consumption is unique per source).
        const consumed = await forecasting.consumeForecast(client, {
          companyId: order.company_id, itemId: id, qty: ordered,
          sourceType: 'sales_order', sourceId: line.id,
          sourceRef: order.order_number, date: needDate,
        });
        result.forecast_consumed = consumed.consumed;
      }

      results.push(result);
    }

    await client.query('COMMIT');

    const shortLines = results.filter(r => r.backordered > 0);
    return {
      order: orderSummary,
      lines: results,
      fully_promised: shortLines.length === 0 && results.every(r => r.promised || r.reason === 'already fulfilled'),
      backordered_lines: shortLines.length,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Release open (and partly released) backorders that stock has since arrived
 * for, oldest promise first, then by order priority. Called after a goods
 * receipt or a production completion puts stock back on the shelf.
 *
 * Only orders that are still active are served — a cancelled, deleted or
 * finished order's backorder gets nothing — and never more than the order
 * still needs reserved, so a line shipped in the meantime is not over-allocated.
 * A backorder whose line no longer needs anything is closed.
 */
export async function releaseBackorders({ companyId = null, itemId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const where = `b.status IN ('open','partial')
         AND ($1::int IS NULL OR b.company_id = $1)
         AND ($2::int IS NULL OR b.item_id = $2)
         AND so.deleted_at IS NULL
         AND LOWER(COALESCE(so.order_status,'')) NOT IN ('delivered','completed','closed','cancelled')`;
    // Items first, ascending (see LOCK ORDER above), then the backorder rows.
    const { rows: cand } = await client.query(
      `SELECT DISTINCT b.item_id FROM backorders b JOIN sales_orders so ON so.id = b.sales_order_id
        WHERE ${where} AND b.item_id IS NOT NULL`, [companyId, itemId]);
    const stock = await lockItems(client, cand.map(r => r.item_id));
    if (!stock.size) { await client.query('COMMIT'); return { released: 0, rows: [], closed: [] }; }
    const itemIds = [...stock.keys()];
    const { rows: open } = await client.query(`
      SELECT b.* FROM backorders b JOIN sales_orders so ON so.id = b.sales_order_id
       WHERE ${where} AND b.item_id = ANY($3::int[])
       ORDER BY CASE LOWER(COALESCE(b.priority,'normal'))
                  WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                b.promised_date NULLS LAST, b.created_at, b.id
       FOR UPDATE OF b`, [companyId, itemId, itemIds]);

    const committed = await committedByItem(client, itemIds);
    const freeByItem = new Map(itemIds.map(id => [id, Math.max(0, stock.get(id) - (committed.get(id) || 0))]));
    const needByOrder = new Map();   // `${order}:${item}` -> still to reserve
    const needOf = async (orderId, id) => {
      const k = `${orderId}:${id}`;
      if (!needByOrder.has(k)) {
        const o = (await openForOrder(client, orderId)).get(id);
        needByOrder.set(k, o ? Math.max(0, o.open_demand - o.open_alloc) : 0);
      }
      return needByOrder.get(k);
    };

    const released = [];
    const closed = [];
    for (const b of open) {
      const outstanding = num(b.qty_backordered) - num(b.qty_released);
      const need = await needOf(b.sales_order_id, b.item_id);
      if (outstanding <= 0.0001 || need <= 0.0001) {
        // Nothing left to release for this line: it is fully released, or
        // shipped / reserved some other way since. Closed rather than left open.
        await client.query(`UPDATE backorders SET status = 'closed', closed_at = NOW() WHERE id = $1`, [b.id]);
        if (b.sales_order_item_id) {
          await client.query(`UPDATE sales_order_items SET backordered_qty = 0 WHERE id = $1`, [b.sales_order_item_id]);
        }
        closed.push({ backorder_id: b.id, order_number: b.order_number, item_id: b.item_id });
        continue;
      }
      const free = freeByItem.get(b.item_id) || 0;
      const take = Math.min(free, outstanding, need);
      if (take <= 0) continue;

      await client.query(`
        INSERT INTO inventory_allocations
          (item_id, warehouse_id, quantity, allocation_type, reference_type, reference_id,
           allocation_date, purpose, allocation_source)
        VALUES ($1,$2,$3,'sales_order','sales_order',$4,CURRENT_DATE,$5,'order_promise')`,
        [b.item_id, await warehouseHolding(client, b.item_id), take, b.sales_order_id,
         `Backorder release ${b.order_number}`]);
      await client.query(
        `UPDATE sales_order_items SET allocated_qty = COALESCE(allocated_qty,0) + $2,
                backordered_qty = GREATEST(COALESCE(backordered_qty,0) - $2, 0) WHERE id = $1`,
        [b.sales_order_item_id, take]);

      const nowReleased = num(b.qty_released) + take;
      const done = nowReleased >= num(b.qty_backordered) - 0.0001;
      await client.query(`
        UPDATE backorders SET qty_released = $2, released_at = NOW(),
               status = CASE WHEN $3 THEN 'closed' ELSE 'partial' END,
               closed_at = CASE WHEN $3 THEN NOW() ELSE closed_at END
         WHERE id = $1`, [b.id, nowReleased, done]);

      freeByItem.set(b.item_id, free - take);
      needByOrder.set(`${b.sales_order_id}:${b.item_id}`, need - take);
      released.push({ backorder_id: b.id, order_number: b.order_number,
        item_id: b.item_id, released: r3(take), fully_released: done });
    }
    await client.query('COMMIT');
    return { released: released.length, rows: released, closed };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

/**
 * An order that is cancelled or deleted keeps nothing on order: its open and
 * partly released backorders are closed as 'cancelled' and its lines' display
 * figures zeroed. Its allocations need no write — v_sales_order_open_allocation
 * already gives an inactive order zero open allocation. Call inside the
 * caller's transaction, after the order row is locked (LOCK ORDER above).
 */
export async function closeOrderBackorders(client, orderId) {
  const { rowCount } = await client.query(
    `UPDATE backorders SET status = 'cancelled', closed_at = NOW()
      WHERE sales_order_id = $1 AND status IN ('open','partial')`, [orderId]);
  await client.query(
    `UPDATE sales_order_items SET allocated_qty = 0, backordered_qty = 0 WHERE order_id = $1`, [orderId]);
  return rowCount;
}

export default { promiseOrder, releaseBackorders, closeOrderBackorders };
