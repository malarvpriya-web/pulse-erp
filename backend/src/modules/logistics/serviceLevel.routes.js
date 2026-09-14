// backend/src/modules/logistics/serviceLevel.routes.js
//
// Customer-facing service level: OTIF, fill rate, order fulfilment rate,
// stockout rate, order accuracy, returns and delivery delay.
//
// WHY THIS IS NEW
// ---------------
// The 2026-09-11 SCA audit found service level measured thoroughly in ONE
// direction only. Supplier performance had on-time delivery, fill rate, lead-time
// adherence, PPV and a whole vendor health engine. The customer side had none of
// it: every on_time_delivery_pct in the codebase was vendor-side, fill_rate_pct
// existed solely for supplier development, and stockout rate, order accuracy and
// order fulfilment rate were not computed anywhere.
//
// WHAT "ON TIME" IS MEASURED AGAINST
// ----------------------------------
// sales_orders.promised_date — the date the customer was given — and NOT
// delivery_date, which gets edited as reality moves. Measuring against a date
// that is revised whenever it is about to be missed produces a number that is
// always near 100% and means nothing. Orders with no promise are excluded from
// the percentage and reported separately as unmeasurable, rather than counted as
// successes.
//
// EVERY METRIC CAN RETURN NULL. An unmeasurable service level says so; it does
// not report 0% (which reads as catastrophic) or 100% (which reads as perfect).
// This codebase has been bitten by that before — a supplier who had never
// shipped anything once scored 0% on-time.

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';

const router = Router();

const pct = (num, den) => (den > 0 ? Math.round((10000 * num) / den) / 100 : null);
const int = (v) => parseInt(v, 10) || 0;
const flt = (v) => parseFloat(v) || 0;

/** Window helper: ?from=&to=, defaulting to the last 12 months. */
function windowOf(req) {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from ||
    new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

/* GET /service-level/summary — the customer service-level scorecard */
router.get('/summary', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { from, to } = windowOf(req);

    // ── Delivery performance, per order ─────────────────────────────────────
    // in_full is computed off the LINES: an order is in full only when every
    // line is. Counting orders flagged 'delivered' would score an order that
    // shipped 40% of every line identically to one that shipped all of it.
    const { rows: [delivery] } = await pool.query(`
      WITH o AS (
        SELECT so.id, so.promised_date, so.delivered_at,
               (so.delivered_at IS NOT NULL) AS is_delivered,
               (so.promised_date IS NOT NULL) AS has_promise,
               (so.delivered_at IS NOT NULL AND so.promised_date IS NOT NULL
                AND so.delivered_at::date <= so.promised_date) AS on_time,
               COALESCE(SUM(soi.quantity), 0)      AS qty_ordered,
               COALESCE(SUM(soi.fulfilled_qty), 0) AS qty_fulfilled,
               BOOL_AND(COALESCE(soi.fulfilled_qty,0) >= COALESCE(soi.quantity,0)) AS in_full,
               CASE WHEN so.delivered_at IS NOT NULL AND so.promised_date IS NOT NULL
                    THEN GREATEST(so.delivered_at::date - so.promised_date, 0) END AS delay_days
          FROM sales_orders so
          LEFT JOIN sales_order_items soi ON soi.order_id = so.id
         WHERE ($1::int IS NULL OR so.company_id = $1)
           AND so.deleted_at IS NULL
           AND LOWER(COALESCE(so.order_status,'')) <> 'cancelled'
           AND COALESCE(so.order_date, so.created_at::date) BETWEEN $2 AND $3
         GROUP BY so.id, so.promised_date, so.delivered_at
      )
      SELECT COUNT(*)::int                                             AS total_orders,
             COUNT(*) FILTER (WHERE is_delivered)::int                 AS delivered_orders,
             COUNT(*) FILTER (WHERE is_delivered AND has_promise)::int AS measurable_orders,
             COUNT(*) FILTER (WHERE on_time)::int                      AS on_time_orders,
             COUNT(*) FILTER (WHERE is_delivered AND in_full)::int     AS in_full_orders,
             COUNT(*) FILTER (WHERE on_time AND in_full)::int          AS otif_orders,
             COUNT(*) FILTER (WHERE is_delivered AND NOT has_promise)::int AS unmeasurable_orders,
             COALESCE(SUM(qty_ordered),0)::numeric                     AS qty_ordered,
             COALESCE(SUM(qty_fulfilled),0)::numeric                   AS qty_fulfilled,
             ROUND(AVG(delay_days) FILTER (WHERE delay_days > 0), 2)   AS avg_delay_days,
             COUNT(*) FILTER (WHERE delay_days > 0)::int               AS late_orders
        FROM o`, [cid, from, to]);

    // ── Stockout exposure ───────────────────────────────────────────────────
    // Two readings, because they answer different questions: how much of the
    // catalogue is out of stock now, and how much is below its reorder point.
    const { rows: [stock] } = await pool.query(`
      SELECT COUNT(*)::int                                                       AS total_items,
             COUNT(*) FILTER (WHERE COALESCE(current_stock,0) <= 0)::int         AS stocked_out,
             COUNT(*) FILTER (WHERE COALESCE(reorder_level,0) > 0
                                AND COALESCE(current_stock,0) <= reorder_level)::int AS below_rop
        FROM inventory_items
       WHERE ($1::int IS NULL OR company_id = $1)
         AND COALESCE(is_active,true) = true AND deleted_at IS NULL`, [cid]);

    // ── Returns and complaints ──────────────────────────────────────────────
    const { rows: [ret] } = await pool.query(`
      SELECT COUNT(*)::int AS return_count,
             COUNT(DISTINCT sales_order_id) FILTER (WHERE sales_order_id IS NOT NULL)::int AS orders_returned
        FROM sales_returns
       WHERE ($1::int IS NULL OR company_id = $1)
         AND return_date BETWEEN $2 AND $3`, [cid, from, to]).catch(() => ({ rows: [{}] }));

    let complaints = { complaint_count: 0 };
    try {
      const { rows: [c] } = await pool.query(`
        SELECT COUNT(*)::int AS complaint_count FROM complaints
         WHERE ($1::int IS NULL OR company_id = $1)
           AND COALESCE(created_at::date, CURRENT_DATE) BETWEEN $2 AND $3`, [cid, from, to]);
      complaints = c;
    } catch { /* complaints module optional */ }

    const totalOrders  = int(delivery.total_orders);
    const delivered    = int(delivery.delivered_orders);
    const measurable   = int(delivery.measurable_orders);
    const returned     = int(ret?.orders_returned);

    res.json({
      window: { from, to },
      orders: {
        total: totalOrders,
        delivered,
        measurable_for_on_time: measurable,
        unmeasurable_no_promise: int(delivery.unmeasurable_orders),
      },
      // The headline five.
      on_time_delivery_pct:   pct(int(delivery.on_time_orders), measurable),
      in_full_pct:            pct(int(delivery.in_full_orders), delivered),
      otif_pct:               pct(int(delivery.otif_orders),    measurable),
      fill_rate_pct:          pct(flt(delivery.qty_fulfilled),  flt(delivery.qty_ordered)),
      order_fulfilment_rate_pct: pct(delivered, totalOrders),

      late_orders:     int(delivery.late_orders),
      avg_delay_days:  delivery.avg_delay_days === null ? null : flt(delivery.avg_delay_days),

      stockout_rate_pct:   pct(int(stock.stocked_out), int(stock.total_items)),
      below_reorder_pct:   pct(int(stock.below_rop),   int(stock.total_items)),
      items_stocked_out:   int(stock.stocked_out),
      items_below_reorder: int(stock.below_rop),

      returns_count:       int(ret?.return_count),
      return_rate_pct:     pct(returned, delivered),
      complaints_count:    int(complaints?.complaint_count),
      // Order accuracy is the share of delivered orders that generated neither a
      // return nor a complaint — the closest honest proxy available from the
      // data actually recorded.
      order_accuracy_pct:  pct(delivered - returned - int(complaints?.complaint_count), delivered),
    });
  } catch (e) { console.error('[service-level/summary]', e); res.status(500).json({ error: e.message }); }
});

/* GET /service-level/trend?bucket=month — the same metrics over time */
router.get('/trend', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { from, to } = windowOf(req);
    const bucket = ['day', 'week', 'month', 'quarter'].includes(req.query.bucket) ? req.query.bucket : 'month';
    const { rows } = await pool.query(`
      WITH o AS (
        SELECT date_trunc('${bucket}', COALESCE(so.order_date, so.created_at::date))::date AS period,
               so.id, so.promised_date, so.delivered_at,
               (so.delivered_at IS NOT NULL AND so.promised_date IS NOT NULL
                AND so.delivered_at::date <= so.promised_date) AS on_time,
               (so.delivered_at IS NOT NULL AND so.promised_date IS NOT NULL) AS measurable,
               BOOL_AND(COALESCE(soi.fulfilled_qty,0) >= COALESCE(soi.quantity,0)) AS in_full,
               COALESCE(SUM(soi.quantity),0)      AS qty_ordered,
               COALESCE(SUM(soi.fulfilled_qty),0) AS qty_fulfilled
          FROM sales_orders so
          LEFT JOIN sales_order_items soi ON soi.order_id = so.id
         WHERE ($1::int IS NULL OR so.company_id = $1) AND so.deleted_at IS NULL
           AND LOWER(COALESCE(so.order_status,'')) <> 'cancelled'
           AND COALESCE(so.order_date, so.created_at::date) BETWEEN $2 AND $3
         GROUP BY 1, so.id, so.promised_date, so.delivered_at
      )
      SELECT period,
             COUNT(*)::int AS orders,
             COUNT(*) FILTER (WHERE measurable)::int AS measurable,
             COUNT(*) FILTER (WHERE on_time)::int    AS on_time,
             COUNT(*) FILTER (WHERE on_time AND in_full)::int AS otif,
             SUM(qty_ordered)::numeric   AS qty_ordered,
             SUM(qty_fulfilled)::numeric AS qty_fulfilled
        FROM o GROUP BY period ORDER BY period`, [cid, from, to]);

    res.json(rows.map(r => ({
      period: r.period,
      orders: int(r.orders),
      on_time_delivery_pct: pct(int(r.on_time), int(r.measurable)),
      otif_pct:             pct(int(r.otif),    int(r.measurable)),
      fill_rate_pct:        pct(flt(r.qty_fulfilled), flt(r.qty_ordered)),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* GET /service-level/late-orders — the orders behind the number */
router.get('/late-orders', requirePermission('sales', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { from, to } = windowOf(req);
    const { rows } = await pool.query(`
      SELECT so.id, so.order_number, so.customer_name, so.promised_date,
             so.delivered_at::date AS delivered_on,
             (so.delivered_at::date - so.promised_date) AS delay_days,
             so.order_status, so.priority,
             COALESCE(SUM(soi.quantity),0)::numeric      AS qty_ordered,
             COALESCE(SUM(soi.fulfilled_qty),0)::numeric AS qty_fulfilled
        FROM sales_orders so
        LEFT JOIN sales_order_items soi ON soi.order_id = so.id
       WHERE ($1::int IS NULL OR so.company_id = $1) AND so.deleted_at IS NULL
         AND so.promised_date IS NOT NULL
         AND COALESCE(so.order_date, so.created_at::date) BETWEEN $2 AND $3
         AND (
           (so.delivered_at IS NOT NULL AND so.delivered_at::date > so.promised_date)
           OR (so.delivered_at IS NULL AND so.promised_date < CURRENT_DATE
               AND LOWER(COALESCE(so.order_status,'')) NOT IN ('cancelled','completed','delivered'))
         )
       GROUP BY so.id
       ORDER BY COALESCE(so.delivered_at::date - so.promised_date,
                         CURRENT_DATE - so.promised_date) DESC
       LIMIT 100`, [cid, from, to]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
