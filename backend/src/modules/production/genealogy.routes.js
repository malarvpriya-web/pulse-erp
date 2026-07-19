// backend/src/modules/production/genealogy.routes.js
//
// Batch / serial genealogy (traceability). Read-only reporting that assembles a
// two-directional trace from existing records:
//
//   UPSTREAM  (where-from): finished production order → components consumed
//     (material_issue_logs) → source batches (inventory_batches) → vendor + GRN.
//   DOWNSTREAM (where-used): a component batch/item → production orders that
//     consumed it → finished output (serials, batch) → sales dispatch → customer.
//
// Anchors: a production order, a finished serial number, or a component batch.

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = Router();
const cidOf = (req) => (req.scope?.company_id != null ? req.scope.company_id : null);
const node = (kind, label, sublabel, meta = {}, children = []) => ({ kind, label, sublabel, meta, children });

/* GET /genealogy/search?q= — find anchor candidates across POs, serials, batches */
router.get('/search', requirePermission('production', 'view'), async (req, res) => {
  try {
    const q = `%${(req.query.q || '').trim()}%`;
    const cid = cidOf(req);
    const [po, sn, bt] = await Promise.all([
      pool.query(`SELECT id, production_order_no AS ref, product_name, batch_number
                    FROM production_orders
                   WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
                     AND (production_order_no ILIKE $2 OR product_name ILIKE $2 OR batch_number ILIKE $2)
                   ORDER BY id DESC LIMIT 25`, [cid, q]),
      pool.query(`SELECT sn.id, sn.serial_number AS ref, i.item_name
                    FROM serial_numbers sn LEFT JOIN inventory_items i ON i.id = sn.item_id
                   WHERE ($1::int IS NULL OR sn.company_id = $1 OR sn.company_id IS NULL)
                     AND sn.serial_number ILIKE $2 AND sn.deleted_at IS NULL
                   ORDER BY sn.id DESC LIMIT 25`, [cid, q]),
      pool.query(`SELECT b.id, b.batch_number AS ref, i.item_name
                    FROM inventory_batches b LEFT JOIN inventory_items i ON i.id = b.item_id
                   WHERE b.batch_number ILIKE $1 AND b.deleted_at IS NULL
                   ORDER BY b.id DESC LIMIT 25`, [q]),
    ]);
    res.json([
      ...po.rows.map(r => ({ type: 'production_order', id: r.id, label: r.ref, sublabel: `${r.product_name}${r.batch_number ? ` · batch ${r.batch_number}` : ''}` })),
      ...sn.rows.map(r => ({ type: 'serial', id: r.id, label: r.ref, sublabel: r.item_name || 'serial' })),
      ...bt.rows.map(r => ({ type: 'batch', id: r.id, label: r.ref, sublabel: r.item_name || 'batch' })),
    ]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Source batches (with vendor + GRN) for a consumed component item. */
async function sourceBatchesForItem(itemId) {
  if (!itemId) return [];
  const { rows } = await pool.query(`
    SELECT b.id, b.batch_number, b.quantity_received, b.quantity_consumed, b.rate, b.received_date,
           v.vendor_name, g.grn_number
      FROM inventory_batches b
      LEFT JOIN vendors v ON v.id = b.supplier_id
      LEFT JOIN goods_receipt_notes g ON g.id = b.grn_id
     WHERE b.item_id = $1 AND b.deleted_at IS NULL
     ORDER BY b.received_date DESC NULLS LAST, b.id DESC LIMIT 20`, [itemId]);
  return rows.map(b => node('batch', b.batch_number || `Batch #${b.id}`,
    `${b.vendor_name || 'unknown vendor'}${b.grn_number ? ` · GRN ${b.grn_number}` : ''}`,
    { received: b.quantity_received, consumed: b.quantity_consumed, rate: b.rate, received_date: b.received_date }));
}

/** Upstream: components consumed by a production order → their source batches. */
async function upstreamForPO(poId) {
  let { rows: consumed } = await pool.query(
    `SELECT item_id, item_name, SUM(qty_issued) AS qty, SUM(total_cost) AS cost
       FROM material_issue_logs WHERE production_order_id = $1 GROUP BY item_id, item_name`, [poId]);
  if (consumed.length === 0) {
    const r = await pool.query(
      `SELECT item_id, item_name, SUM(COALESCE(qty_consumed, qty_reserved, 0)) AS qty, NULL::numeric AS cost
         FROM material_reservations WHERE production_order_id = $1 GROUP BY item_id, item_name`, [poId]);
    consumed = r.rows;
  }
  const out = [];
  for (const c of consumed) {
    const batches = await sourceBatchesForItem(c.item_id);
    out.push(node('component', c.item_name, `consumed ${Number(c.qty || 0)}${c.cost ? ` · ₹${Number(c.cost).toLocaleString('en-IN')}` : ''}`,
      { item_id: c.item_id, qty: c.qty }, batches));
  }
  return out;
}

/** Downstream for a production order: output serials, sales order, dispatch. */
async function downstreamForPO(po) {
  const out = [];
  const { rows: serials } = await pool.query(
    `SELECT serial_number, status, manufactured_date FROM serial_numbers WHERE production_order_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 100`, [po.id]);
  if (serials.length) out.push(node('serials', `${serials.length} finished serial(s)`, po.product_name, {},
    serials.map(s => node('serial', s.serial_number, s.status || '', { manufactured_date: s.manufactured_date }))));
  if (po.batch_number) out.push(node('batch', `Output batch ${po.batch_number}`, po.product_name, {}));

  if (po.sales_order_id) {
    const { rows: so } = await pool.query(`SELECT order_number, customer_name FROM sales_orders WHERE id = $1`, [po.sales_order_id]);
    if (so[0]) out.push(node('sales_order', `Sales Order ${so[0].order_number}`, so[0].customer_name || 'customer', { sales_order_id: po.sales_order_id }));
  }
  if (po.product_id) {
    const { rows: disp } = await pool.query(
      `SELECT transaction_date, quantity_out, reference_type, remarks FROM stock_ledger
        WHERE item_id = $1 AND quantity_out > 0 AND (transaction_type ILIKE '%dispatch%' OR reference_type IN ('invoice','sales_order','pick_list'))
        ORDER BY transaction_date DESC LIMIT 20`, [po.product_id]);
    if (disp.length) out.push(node('dispatches', `${disp.length} dispatch movement(s)`, po.product_name, {},
      disp.map(d => node('dispatch', `${Number(d.quantity_out)} out`, `${d.reference_type || ''} · ${d.transaction_date ? new Date(d.transaction_date).toISOString().slice(0, 10) : ''}`, { remarks: d.remarks }))));
  }
  return out;
}

/* GET /genealogy/trace?type=&id= */
router.get('/trace', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { type, id } = req.query;
    if (!type || !id) return res.status(400).json({ error: 'type and id required' });

    if (type === 'production_order') {
      const { rows: [po] } = await pool.query(`SELECT * FROM production_orders WHERE id = $1`, [id]);
      if (!po) return res.status(404).json({ error: 'Production order not found' });
      return res.json({
        anchor: node('production_order', po.production_order_no, `${po.product_name} · qty ${Number(po.quantity_planned)}${po.batch_number ? ` · batch ${po.batch_number}` : ''}`, { status: po.status }),
        upstream: await upstreamForPO(po.id),
        downstream: await downstreamForPO(po),
      });
    }

    if (type === 'serial') {
      const { rows: [sn] } = await pool.query(
        `SELECT sn.*, i.item_name FROM serial_numbers sn LEFT JOIN inventory_items i ON i.id = sn.item_id WHERE sn.id = $1`, [id]);
      if (!sn) return res.status(404).json({ error: 'Serial not found' });
      const anchor = node('serial', sn.serial_number, `${sn.item_name || ''} · ${sn.status || ''}`, { production_order_id: sn.production_order_id });
      let upstream = [];
      if (sn.production_order_id) upstream = await upstreamForPO(sn.production_order_id);
      const { rows: events } = await pool.query(
        `SELECT event_type, event_date, description, reference_type FROM serial_events WHERE serial_id = $1 ORDER BY event_date DESC, id DESC LIMIT 50`, [id]);
      const downstream = events.length
        ? [node('lifecycle', `${events.length} lifecycle event(s)`, sn.serial_number, {},
            events.map(e => node('event', e.event_type, `${e.reference_type || ''} · ${e.event_date ? new Date(e.event_date).toISOString().slice(0, 10) : ''}`, { description: e.description })))]
        : [];
      return res.json({ anchor, upstream, downstream });
    }

    if (type === 'batch') {
      const { rows: [b] } = await pool.query(`
        SELECT b.*, i.item_name, v.vendor_name, g.grn_number
          FROM inventory_batches b
          LEFT JOIN inventory_items i ON i.id = b.item_id
          LEFT JOIN vendors v ON v.id = b.supplier_id
          LEFT JOIN goods_receipt_notes g ON g.id = b.grn_id
         WHERE b.id = $1`, [id]);
      if (!b) return res.status(404).json({ error: 'Batch not found' });
      const anchor = node('batch', b.batch_number || `Batch #${b.id}`, `${b.item_name || ''} · received ${Number(b.quantity_received || 0)}`, { item_id: b.item_id });
      const upstream = [node('source', b.vendor_name || 'Unknown vendor', b.grn_number ? `GRN ${b.grn_number}` : 'no GRN link',
        { received_date: b.received_date, rate: b.rate })];
      // where-used: production orders that consumed this item
      const { rows: usage } = await pool.query(`
        SELECT DISTINCT po.id, po.production_order_no, po.product_name, po.batch_number
          FROM material_issue_logs mil JOIN production_orders po ON po.id = mil.production_order_id
         WHERE mil.item_id = $1 ORDER BY po.id DESC LIMIT 25`, [b.item_id]);
      const downstream = [];
      for (const u of usage) {
        const { rows: serials } = await pool.query(
          `SELECT serial_number FROM serial_numbers WHERE production_order_id = $1 AND deleted_at IS NULL LIMIT 20`, [u.id]);
        downstream.push(node('production_order', u.production_order_no, `${u.product_name}${u.batch_number ? ` · batch ${u.batch_number}` : ''}`,
          { id: u.id }, serials.map(s => node('serial', s.serial_number, 'finished serial'))));
      }
      return res.json({ anchor, upstream, downstream });
    }

    return res.status(400).json({ error: 'Unknown anchor type' });
  } catch (e) { console.error('[genealogy/trace]', e); res.status(500).json({ error: e.message }); }
});

export default router;
