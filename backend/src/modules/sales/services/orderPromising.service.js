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
 * Promise an order: ATP check + allocate + backorder + consume forecast.
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
      `SELECT * FROM sales_orders WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [orderId, companyId]);
    if (!order) { await client.query('ROLLBACK'); return null; }

    const { rows: lines } = await client.query(`
      SELECT soi.*, ii.item_code, ii.item_name, ii.unit_of_measure,
             COALESCE(ii.current_stock,0) AS current_stock
        FROM sales_order_items soi
        LEFT JOIN inventory_items ii ON ii.id = soi.item_id
       WHERE soi.order_id = $1 ORDER BY soi.id`, [orderId]);

    const needDate = order.promised_date || order.delivery_date || order.order_date;
    const results = [];

    for (const line of lines) {
      const qty = num(line.quantity) - num(line.fulfilled_qty);

      // A line with no item_id cannot be promised: there is nothing to check
      // availability of. Reported rather than silently passed, because this was
      // the state of every order line in the database before the item FK existed.
      if (!line.item_id) {
        results.push({ line_id: line.id, item_id: null,
          description: line.description, quantity: qty,
          promised: false, reason: 'line is not linked to an item' });
        continue;
      }
      if (qty <= 0) {
        results.push({ line_id: line.id, item_id: line.item_id, item_code: line.item_code,
          quantity: 0, promised: true, reason: 'already fulfilled' });
        continue;
      }

      // ── Availability ──────────────────────────────────────────────────────
      // On-hand minus what is already allocated to other orders. ATP adds dated
      // inbound supply, which is what makes a future promise defensible.
      const { rows: [alloc] } = await client.query(
        `SELECT COALESCE(SUM(quantity),0) AS qty FROM inventory_allocations WHERE item_id = $1`,
        [line.item_id]);
      const freeStock = Math.max(0, num(line.current_stock) - num(alloc.qty));

      let atpTotal = null;
      try {
        const atp = await computeATP({ companyId, itemId: line.item_id, horizonDays: 180, bucketDays: 7 });
        atpTotal = atp ? num(atp.total_atp) : null;
      } catch { /* ATP is advisory here; a failure must not block order intake */ }

      const fromStock   = Math.min(qty, freeStock);
      const shortfall   = r3(qty - fromStock);
      const coveredBySupply = atpTotal === null ? null : Math.max(0, Math.min(shortfall, atpTotal - fromStock));

      const result = {
        line_id: line.id, item_id: line.item_id, item_code: line.item_code,
        item_name: line.item_name, quantity: r3(qty),
        on_hand: num(line.current_stock), already_allocated: num(alloc.qty),
        available_now: r3(freeStock), atp_total: atpTotal,
        allocated: 0, backordered: 0,
        promised: shortfall <= 0.0001,
      };

      if (allocate) {
        if (fromStock > 0) {
          await client.query(`
            INSERT INTO inventory_allocations
              (item_id, quantity, allocation_type, reference_type, reference_id, allocation_date, allocated_by, purpose)
            VALUES ($1,$2,'sales_order','sales_order',$3,CURRENT_DATE,$4,$5)`,
            [line.item_id, fromStock, orderId, actor.id ?? null,
             `Order ${order.order_number} line ${line.id}`]);
          await client.query(
            `UPDATE sales_order_items SET allocated_qty = COALESCE(allocated_qty,0) + $2 WHERE id = $1`,
            [line.id, fromStock]);
          result.allocated = r3(fromStock);
        }

        if (shortfall > 0.0001) {
          // Idempotent: re-promising an order must not stack backorders.
          const { rows: [existing] } = await client.query(
            `SELECT id FROM backorders WHERE sales_order_item_id = $1 AND status = 'open'`, [line.id]);
          if (existing) {
            await client.query(
              `UPDATE backorders SET qty_backordered = $2, qty_available = $3, expected_date = $4 WHERE id = $1`,
              [existing.id, shortfall, freeStock, null]);
          } else {
            await client.query(`
              INSERT INTO backorders
                (company_id, sales_order_id, sales_order_item_id, order_number, item_id, item_name,
                 qty_ordered, qty_available, qty_backordered, promised_date, reason, priority, status)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open')`,
              [order.company_id, orderId, line.id, order.order_number, line.item_id, line.item_name,
               qty, freeStock, shortfall, needDate,
               atpTotal !== null && atpTotal >= qty ? 'awaiting_inbound_supply' : 'insufficient_supply',
               order.priority || 'normal']);
          }
          await client.query(
            `UPDATE sales_order_items SET backordered_qty = $2 WHERE id = $1`, [line.id, shortfall]);
          result.backordered = shortfall;
          result.covered_by_inbound_supply = coveredBySupply;
        } else {
          await client.query(
            `UPDATE backorders SET status = 'closed', closed_at = NOW()
              WHERE sales_order_item_id = $1 AND status = 'open'`, [line.id]);
          await client.query(`UPDATE sales_order_items SET backordered_qty = 0 WHERE id = $1`, [line.id]);
        }

        // ── Forecast consumption ────────────────────────────────────────────
        // The order is real demand arriving against demand that was forecast.
        // Consuming it is what stops MRP planning the same units twice.
        const consumed = await forecasting.consumeForecast(client, {
          companyId: order.company_id, itemId: line.item_id, qty,
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
      order: { id: order.id, order_number: order.order_number, promised_date: order.promised_date },
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
 * Release open backorders that stock has since arrived for, oldest promise
 * first, then by order priority. Called after a goods receipt or a production
 * completion puts stock back on the shelf.
 */
export async function releaseBackorders({ companyId = null, itemId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: open } = await client.query(`
      SELECT b.*, COALESCE(ii.current_stock,0) AS current_stock
        FROM backorders b
        JOIN inventory_items ii ON ii.id = b.item_id
       WHERE b.status = 'open'
         AND ($1::int IS NULL OR b.company_id = $1)
         AND ($2::int IS NULL OR b.item_id = $2)
       ORDER BY CASE LOWER(COALESCE(b.priority,'normal'))
                  WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                b.promised_date NULLS LAST, b.created_at`,
      [companyId, itemId]);

    const released = [];
    const freeByItem = new Map();
    for (const b of open) {
      if (!freeByItem.has(b.item_id)) {
        const { rows: [a] } = await client.query(
          `SELECT COALESCE(SUM(quantity),0) AS qty FROM inventory_allocations WHERE item_id = $1`, [b.item_id]);
        freeByItem.set(b.item_id, Math.max(0, num(b.current_stock) - num(a.qty)));
      }
      const free = freeByItem.get(b.item_id);
      if (free <= 0) continue;

      const take = Math.min(free, num(b.qty_backordered) - num(b.qty_released));
      if (take <= 0) continue;

      await client.query(`
        INSERT INTO inventory_allocations
          (item_id, quantity, allocation_type, reference_type, reference_id, allocation_date, purpose)
        VALUES ($1,$2,'sales_order','sales_order',$3,CURRENT_DATE,$4)`,
        [b.item_id, take, b.sales_order_id, `Backorder release ${b.order_number}`]);
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
      released.push({ backorder_id: b.id, order_number: b.order_number,
        item_id: b.item_id, released: r3(take), fully_released: done });
    }
    await client.query('COMMIT');
    return { released: released.length, rows: released };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

export default { promiseOrder, releaseBackorders };
