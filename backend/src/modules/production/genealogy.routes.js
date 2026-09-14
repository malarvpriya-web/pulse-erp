// backend/src/modules/production/genealogy.routes.js
//
// Complete Bidirectional Material Genealogy & Traceability Engine
// Supports:
//   1. Global Traceability Search across PO, GRN, Batch, Serial, Work Order, Item, Project, Customer
//   2. Forward & Backward Recursive Traceability Tree (Supplier <-> Customer)
//   3. Where-Used / Recall & Impact Analysis with Exact Quantity Reconciliation
//   4. As-Built BOM vs Planned BOM with Actual Lots, Assemblers, Substitutions & Rework Replacements
//   5. QC & Test Traceability (IQC, Test Runs, Measurements, FAT/SAT, NCR, CAPA)
//   6. Location & Bin Movement History

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';

const router = Router();
const MAX_DEPTH = 12;
const node = (kind, label, sublabel, meta = {}, children = []) => ({ kind, label, sublabel, meta, children });
const d10 = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/* ── 1. GLOBAL TRACEABILITY SEARCH ─────────────────────────────────────────── */
router.get('/search', requirePermission('production', 'view'), async (req, res) => {
  try {
    const rawQ = (req.query.q || '').trim();
    if (!rawQ) return res.json([]);
    const q = `%${rawQ}%`;
    const cid = companyOf(req);

    const [po, sn, bt, items, grns, purchOrders, projects, salesOrders] = await Promise.all([
      // Production Orders
      pool.query(`SELECT id, production_order_no AS ref, product_name, batch_number, status
                    FROM production_orders
                   WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
                     AND (production_order_no ILIKE $2 OR product_name ILIKE $2 OR batch_number ILIKE $2 OR customer_ref ILIKE $2)
                   ORDER BY id DESC LIMIT 20`, [cid, q]),
      // Serials
      pool.query(`SELECT sn.id, sn.serial_number AS ref, i.item_name, sn.status, sn.current_location
                    FROM serial_numbers sn LEFT JOIN inventory_items i ON i.id = sn.item_id
                   WHERE ($1::int IS NULL OR sn.company_id = $1 OR sn.company_id IS NULL)
                     AND sn.serial_number ILIKE $2 AND sn.deleted_at IS NULL
                   ORDER BY sn.id DESC LIMIT 20`, [cid, q]),
      // Batches
      pool.query(`SELECT b.id, b.batch_number AS ref, i.item_name, b.quantity_available, b.quantity_received
                    FROM inventory_batches b LEFT JOIN inventory_items i ON i.id = b.item_id
                   WHERE ($1::int IS NULL OR b.company_id = $1 OR b.company_id IS NULL)
                     AND b.batch_number ILIKE $2 AND b.deleted_at IS NULL
                   ORDER BY b.id DESC LIMIT 20`, [cid, q]),
      // Inventory Items (Component master)
      pool.query(`SELECT id, item_code AS ref, item_name, current_stock, unit_of_measure
                    FROM inventory_items
                   WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
                     AND (item_code ILIKE $2 OR item_name ILIKE $2) AND deleted_at IS NULL
                   ORDER BY id DESC LIMIT 20`, [cid, q]),
      // Goods Receipt Notes (GRN)
      pool.query(`SELECT id, grn_number AS ref, received_date, status, quality_status
                    FROM goods_receipt_notes
                   WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
                     AND grn_number ILIKE $2 AND deleted_at IS NULL
                   ORDER BY id DESC LIMIT 20`, [cid, q]),
      // Purchase Orders
      pool.query(`SELECT po.id, po.po_number AS ref, v.vendor_name, po.status, po.order_date
                    FROM purchase_orders po LEFT JOIN vendors v ON v.id = po.supplier_id
                   WHERE ($1::int IS NULL OR po.company_id = $1 OR po.company_id IS NULL)
                     AND (po.po_number ILIKE $2 OR v.vendor_name ILIKE $2) AND po.deleted_at IS NULL
                   ORDER BY po.id DESC LIMIT 20`, [cid, q]),
      // Projects
      pool.query(`SELECT id, project_code AS ref, project_name, customer_name, status
                    FROM projects
                   WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
                     AND (project_code ILIKE $2 OR project_name ILIKE $2 OR customer_name ILIKE $2) AND deleted_at IS NULL
                   ORDER BY id DESC LIMIT 20`, [cid, q]),
      // Sales Orders
      pool.query(`SELECT id, order_number AS ref, customer_name, order_status, order_date
                    FROM sales_orders
                   WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
                     AND (order_number ILIKE $2 OR customer_name ILIKE $2) AND deleted_at IS NULL
                   ORDER BY id DESC LIMIT 20`, [cid, q]),
    ]);

    res.json([
      ...po.rows.map(r => ({ type: 'production_order', id: r.id, label: r.ref, sublabel: `${r.product_name}${r.batch_number ? ` · batch ${r.batch_number}` : ''} (${r.status})` })),
      ...sn.rows.map(r => ({ type: 'serial', id: r.id, label: r.ref, sublabel: `${r.item_name || 'serial'} · ${r.status}${r.current_location ? ` @ ${r.current_location}` : ''}` })),
      ...bt.rows.map(r => ({ type: 'batch', id: r.id, label: r.ref, sublabel: `${r.item_name || 'batch'} · avail ${Number(r.quantity_available)}/${Number(r.quantity_received)}` })),
      ...items.rows.map(r => ({ type: 'item', id: r.id, label: r.ref, sublabel: `${r.item_name} · stock ${Number(r.current_stock || 0)} ${r.unit_of_measure || ''}` })),
      ...grns.rows.map(r => ({ type: 'grn', id: r.id, label: r.ref, sublabel: `GRN · ${d10(r.received_date)} (${r.quality_status || r.status})` })),
      ...purchOrders.rows.map(r => ({ type: 'purchase_order', id: r.id, label: r.ref, sublabel: `PO · ${r.vendor_name || 'Supplier'} · ${r.status}` })),
      ...projects.rows.map(r => ({ type: 'project', id: r.id, label: r.ref, sublabel: `Project · ${r.project_name}${r.customer_name ? ` · ${r.customer_name}` : ''}` })),
      ...salesOrders.rows.map(r => ({ type: 'sales_order', id: r.id, label: r.ref, sublabel: `Sales Order · ${r.customer_name || ''} · ${r.order_status}` })),
    ]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Shared lookups ───────────────────────────────────────────────────────────

async function batchRow(batchId) {
  const { rows: [b] } = await pool.query(`
    SELECT b.*, i.item_name, i.item_code, i.manufacturer, v.vendor_name, g.grn_number, g.quality_status AS grn_quality,
           w.name AS warehouse_name, po.po_number
      FROM inventory_batches b
      LEFT JOIN inventory_items i ON i.id = b.item_id
      LEFT JOIN vendors v ON v.id = b.supplier_id
      LEFT JOIN goods_receipt_notes g ON g.id = b.grn_id
      LEFT JOIN purchase_orders po ON po.id = g.po_id
      LEFT JOIN warehouses w ON w.id = b.warehouse_id
     WHERE b.id = $1`, [batchId]);
  return b || null;
}

/** QC verdicts recorded against a production order or a GRN. */
async function qcNodes({ productionOrderId = null, grnId = null }) {
  const { rows } = await pool.query(`
    SELECT test_name, result, status, tested_at, tested_by_name, remarks
      FROM quality_tests
     WHERE ($1::int IS NULL OR production_order_id = $1)
       AND ($2::int IS NULL OR grn_id = $2)
       AND ($1::int IS NOT NULL OR $2::int IS NOT NULL)
     ORDER BY tested_at DESC NULLS LAST LIMIT 25`, [productionOrderId, grnId]);
  if (!rows.length) return [];
  const failed = rows.filter(r => r.result === 'fail').length;
  return [node('qc', `${rows.length} quality test(s)`,
    failed ? `${failed} FAILED` : 'all passed',
    { failed, passed: rows.length - failed },
    rows.map(r => node('qc_test', r.test_name || 'test',
      `${(r.result || r.status || '').toUpperCase()}${r.tested_by_name ? ` · ${r.tested_by_name}` : ''}${r.tested_at ? ` · ${d10(r.tested_at)}` : ''}`,
      { result: r.result, remarks: r.remarks })))];
}

/** Rework / scrap recorded against a production order. */
async function scrapNodes(productionOrderId) {
  try {
    const { rows } = await pool.query(
      `SELECT quantity, reason, scrapped_at, scrapped_by_name FROM production_scrap
        WHERE production_order_id = $1 ORDER BY id DESC LIMIT 20`, [productionOrderId]);
    if (!rows.length) return [];
    return [node('scrap', `${rows.length} scrap/rework record(s)`, '', {},
      rows.map(r => node('scrap_line', `${Number(r.quantity)} rejected`,
        `${r.reason || 'no reason recorded'}${r.scrapped_by_name ? ` · ${r.scrapped_by_name}` : ''}`, {})))];
  } catch { return []; }
}

// ── BACKWARD: what went into this ────────────────────────────────────────────

async function traceUpProductionOrder(poId, depth, seen) {
  if (depth > MAX_DEPTH || seen.has(`po:${poId}`)) return [];
  seen.add(`po:${poId}`);

  const { rows: issues } = await pool.query(`
    SELECT mil.item_id, mil.item_name, mil.batch_id, mil.qty_issued, mil.total_cost,
           mil.issued_by_name, mil.issued_at, mil.work_centre_id, mil.operation_id,
           wc.name AS work_centre_name, op.operation AS operation_name,
           b.batch_number, b.received_date, b.production_order_id AS made_by_po,
           v.vendor_name, g.grn_number, po.po_number
      FROM material_issue_logs mil
      LEFT JOIN inventory_batches b   ON b.id  = mil.batch_id
      LEFT JOIN vendors v             ON v.id  = b.supplier_id
      LEFT JOIN goods_receipt_notes g ON g.id  = b.grn_id
      LEFT JOIN purchase_orders po    ON po.id = g.po_id
      LEFT JOIN work_centres wc       ON wc.id = mil.work_centre_id
      LEFT JOIN production_operations op ON op.id = mil.operation_id
     WHERE mil.production_order_id = $1
     ORDER BY mil.issued_at NULLS LAST, mil.id`, [poId]);

  if (!issues.length) {
    const { rows: resv } = await pool.query(`
      SELECT item_id, item_name, batch_id, COALESCE(qty_consumed, qty_reserved, 0) AS qty_issued
        FROM material_reservations WHERE production_order_id = $1`, [poId]);
    return resv.map(r => node('component', r.item_name, `reserved ${Number(r.qty_issued)} · lot not recorded`,
      { item_id: r.item_id, lot_known: false }));
  }

  const out = [];
  for (const c of issues) {
    const who = [
      c.issued_by_name ? `issued by ${c.issued_by_name}` : null,
      c.work_centre_name || null,
      c.operation_name || null,
      c.issued_at ? d10(c.issued_at) : null,
    ].filter(Boolean).join(' · ');

    const children = [];
    if (c.batch_id) {
      if (c.made_by_po) {
        const { rows: [sub] } = await pool.query(
          `SELECT id, production_order_no, product_name, batch_number, status FROM production_orders WHERE id = $1`,
          [c.made_by_po]);
        if (sub) {
          children.push(node('production_order', sub.production_order_no,
            `built ${sub.product_name}${sub.batch_number ? ` · batch ${sub.batch_number}` : ''}`,
            { id: sub.id, status: sub.status },
            [...await qcNodes({ productionOrderId: sub.id }),
             ...await scrapNodes(sub.id),
             ...await traceUpProductionOrder(sub.id, depth + 1, seen)]));
        }
      } else {
        children.push(node('supplier', c.vendor_name || 'Unknown supplier',
          `${c.po_number ? `PO ${c.po_number} · ` : ''}${c.grn_number ? `GRN ${c.grn_number}` : 'no GRN link'}${c.received_date ? ` · received ${d10(c.received_date)}` : ''}`,
          { grn_number: c.grn_number, po_number: c.po_number, received_date: c.received_date }));
      }
    }

    out.push(node('component', c.item_name,
      `consumed ${Number(c.qty_issued || 0)}${c.batch_number ? ` · lot ${c.batch_number}` : ' · lot not recorded'}${who ? ` · ${who}` : ''}`,
      { item_id: c.item_id, batch_id: c.batch_id, qty: c.qty_issued,
        lot_known: Boolean(c.batch_id), operator: c.issued_by_name,
        work_centre: c.work_centre_name, operation: c.operation_name },
      children));
  }
  return out;
}

// ── FORWARD: where this ended up ─────────────────────────────────────────────

async function deliveryForBatch(batchId) {
  const { rows } = await pool.query(`
    SELECT pkg.package_no, pkg.packed_at, pl.quantity,
           s.dispatch_ref, s.tracking_number, s.courier_partner, s.status AS shipment_status,
           s.dispatch_date, s.actual_delivery, s.promised_date,
           so.order_number, so.customer_name
      FROM package_lines pl
      JOIN packages pkg ON pkg.id = pl.package_id
      LEFT JOIN shipments s   ON s.id  = pkg.shipment_id
      LEFT JOIN sales_orders so ON so.id = pkg.sales_order_id
     WHERE pl.batch_id = $1
     ORDER BY pkg.packed_at DESC NULLS LAST LIMIT 20`, [batchId]);
  return rows.map(r => node('delivery',
    r.customer_name || 'customer',
    [r.order_number ? `Order ${r.order_number}` : null,
     r.package_no ? `carton ${r.package_no}` : null,
     r.dispatch_ref || null,
     r.actual_delivery ? `delivered ${d10(r.actual_delivery)}` : (r.shipment_status || null)].filter(Boolean).join(' · '),
    { quantity: r.quantity, tracking_number: r.tracking_number, carrier: r.courier_partner,
      promised_date: d10(r.promised_date), actual_delivery: d10(r.actual_delivery) }));
}

async function traceDownBatch(batchId, depth, seen) {
  if (depth > MAX_DEPTH || seen.has(`b:${batchId}`)) return [];
  seen.add(`b:${batchId}`);

  const out = [];
  out.push(...await deliveryForBatch(batchId));

  const { rows: consumers } = await pool.query(`
    SELECT DISTINCT po.id, po.production_order_no, po.product_name, po.batch_number, po.status,
           po.sales_order_id, po.project_id, mil.qty_issued, mil.issued_by_name
      FROM material_issue_logs mil
      JOIN production_orders po ON po.id = mil.production_order_id
     WHERE mil.batch_id = $1
     ORDER BY po.id DESC LIMIT 25`, [batchId]);

  for (const u of consumers) {
    const children = [];
    children.push(...await qcNodes({ productionOrderId: u.id }));
    children.push(...await scrapNodes(u.id));

    const { rows: serials } = await pool.query(
      `SELECT id, serial_number, status FROM serial_numbers
        WHERE production_order_id = $1 AND deleted_at IS NULL LIMIT 50`, [u.id]);
    if (serials.length) {
      children.push(node('serials', `${serials.length} finished serial(s)`, u.product_name, {},
        serials.map(s => node('serial', s.serial_number, s.status || '', { id: s.id }))));
    }

    const { rows: outputs } = await pool.query(
      `SELECT id, batch_number FROM inventory_batches WHERE production_order_id = $1`, [u.id]);
    for (const o of outputs) {
      const deeper = await traceDownBatch(o.id, depth + 1, seen);
      children.push(node('batch', `Output lot ${o.batch_number || o.id}`, u.product_name, { batch_id: o.id }, deeper));
    }

    if (u.project_id) {
      const { rows: [prj] } = await pool.query(
        `SELECT project_code, project_name, customer_name FROM projects WHERE id = $1`, [u.project_id]);
      if (prj) children.push(node('project', `Project ${prj.project_code}`,
        `${prj.project_name}${prj.customer_name ? ` · Customer: ${prj.customer_name}` : ''}`,
        { project_id: u.project_id }));
    }

    if (u.sales_order_id) {
      const { rows: [so] } = await pool.query(
        `SELECT order_number, customer_name, order_status, delivered_at FROM sales_orders WHERE id = $1`,
        [u.sales_order_id]);
      if (so) children.push(node('sales_order', `Sales Order ${so.order_number}`,
        `${so.customer_name || 'customer'} · ${so.order_status || ''}${so.delivered_at ? ` · delivered ${d10(so.delivered_at)}` : ''}`,
        { sales_order_id: u.sales_order_id }));
    }

    out.push(node('production_order', u.production_order_no,
      `consumed ${Number(u.qty_issued || 0)} into ${u.product_name}${u.batch_number ? ` · batch ${u.batch_number}` : ''}`,
      { id: u.id, status: u.status }, children));
  }
  return out;
}

/* ── 2. RECURSIVE BIDIRECTIONAL TRACE ───────────────────────────────────────── */
router.get('/trace', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { type, id } = req.query;
    if (!type || !id) return res.status(400).json({ error: 'type and id required' });
    const cid = companyOf(req);

    if (type === 'production_order') {
      const { rows: [po] } = await pool.query(
        `SELECT * FROM production_orders WHERE id = $1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
        [id, cid]);
      if (!po) return res.status(404).json({ error: 'Production order not found' });

      const downstream = [];
      downstream.push(...await qcNodes({ productionOrderId: po.id }));
      downstream.push(...await scrapNodes(po.id));
      const { rows: outputs } = await pool.query(
        `SELECT id, batch_number FROM inventory_batches WHERE production_order_id = $1`, [po.id]);
      for (const o of outputs) {
        downstream.push(node('batch', `Output lot ${o.batch_number || o.id}`, po.product_name,
          { batch_id: o.id }, await traceDownBatch(o.id, 0, new Set())));
      }
      const { rows: serials } = await pool.query(
        `SELECT id, serial_number, status FROM serial_numbers WHERE production_order_id = $1 AND deleted_at IS NULL LIMIT 100`, [po.id]);
      if (serials.length) downstream.push(node('serials', `${serials.length} finished serial(s)`, po.product_name, {},
        serials.map(s => node('serial', s.serial_number, s.status || '', { id: s.id }))));
      if (po.project_id) {
        const { rows: [prj] } = await pool.query(`SELECT project_code, project_name, customer_name FROM projects WHERE id = $1`, [po.project_id]);
        if (prj) downstream.push(node('project', `Project ${prj.project_code}`, `${prj.project_name} · ${prj.customer_name || ''}`, { project_id: po.project_id }));
      }
      if (po.sales_order_id) {
        const { rows: [so] } = await pool.query(
          `SELECT order_number, customer_name, order_status FROM sales_orders WHERE id = $1`, [po.sales_order_id]);
        if (so) downstream.push(node('sales_order', `Sales Order ${so.order_number}`,
          so.customer_name || 'customer', { sales_order_id: po.sales_order_id }));
      }

      return res.json({
        anchor: node('production_order', po.production_order_no,
          `${po.product_name} · qty ${Number(po.quantity_planned)}${po.batch_number ? ` · batch ${po.batch_number}` : ''}`,
          { status: po.status, id: po.id }),
        upstream: await traceUpProductionOrder(po.id, 0, new Set()),
        downstream,
      });
    }

    if (type === 'serial') {
      const { rows: [sn] } = await pool.query(`
        SELECT sn.*, i.item_name FROM serial_numbers sn
          LEFT JOIN inventory_items i ON i.id = sn.item_id
         WHERE sn.id = $1 AND ($2::int IS NULL OR sn.company_id = $2 OR sn.company_id IS NULL)`, [id, cid]);
      if (!sn) return res.status(404).json({ error: 'Serial not found' });

      const upstream = sn.production_order_id ? await traceUpProductionOrder(sn.production_order_id, 0, new Set()) : [];
      const downstream = [];
      if (sn.batch_id) downstream.push(...await deliveryForBatch(sn.batch_id));
      const { rows: events } = await pool.query(
        `SELECT event_type, event_date, description, reference_type FROM serial_events
          WHERE serial_id = $1 ORDER BY event_date DESC, id DESC LIMIT 50`, [id]);
      if (events.length) downstream.push(node('lifecycle', `${events.length} lifecycle event(s)`, sn.serial_number, {},
        events.map(e => node('event', e.event_type, `${e.reference_type || ''} · ${d10(e.event_date) || ''}`,
          { description: e.description }))));

      return res.json({
        anchor: node('serial', sn.serial_number, `${sn.item_name || ''} · ${sn.status || ''}`,
          { production_order_id: sn.production_order_id }),
        upstream, downstream,
      });
    }

    if (type === 'batch') {
      const b = await batchRow(id);
      if (!b) return res.status(404).json({ error: 'Batch not found' });
      if (cid != null && b.company_id != null && b.company_id !== cid) {
        return res.status(404).json({ error: 'Batch not found' });
      }

      const upstream = [];
      if (b.production_order_id) {
        const { rows: [po] } = await pool.query(
          `SELECT id, production_order_no, product_name, status FROM production_orders WHERE id = $1`,
          [b.production_order_id]);
        if (po) upstream.push(node('production_order', po.production_order_no, `built ${po.product_name}`,
          { id: po.id, status: po.status },
          [...await qcNodes({ productionOrderId: po.id }),
           ...await traceUpProductionOrder(po.id, 0, new Set())]));
      } else {
        upstream.push(node('supplier', b.vendor_name || 'Unknown supplier',
          `${b.po_number ? `PO ${b.po_number} · ` : ''}${b.grn_number ? `GRN ${b.grn_number}` : 'no GRN link'}${b.received_date ? ` · received ${d10(b.received_date)}` : ''}`,
          { rate: b.rate, grn_quality: b.grn_quality, po_number: b.po_number, grn_number: b.grn_number },
          b.grn_id ? await qcNodes({ grnId: b.grn_id }) : []));
      }

      return res.json({
        anchor: node('batch', b.batch_number || `Batch #${b.id}`,
          `${b.item_name || ''} · received ${Number(b.quantity_received || 0)} · available ${Number(b.quantity_available || 0)}`,
          { item_id: b.item_id, id: b.id }),
        upstream,
        downstream: await traceDownBatch(b.id, 0, new Set()),
      });
    }

    if (type === 'item') {
      const { rows: [item] } = await pool.query(
        `SELECT * FROM inventory_items WHERE id = $1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
        [id, cid]);
      if (!item) return res.status(404).json({ error: 'Item not found' });

      const { rows: batches } = await pool.query(
        `SELECT id, batch_number, quantity_received, quantity_available FROM inventory_batches WHERE item_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 20`,
        [id]);

      return res.json({
        anchor: node('item', item.item_code, `${item.item_name} · Stock: ${Number(item.current_stock || 0)} ${item.unit_of_measure || ''}`, { id: item.id }),
        upstream: batches.map(b => node('batch', b.batch_number, `Avail: ${Number(b.quantity_available)} / ${Number(b.quantity_received)}`, { id: b.id })),
        downstream: [],
      });
    }

    return res.status(400).json({ error: 'Unknown anchor type' });
  } catch (e) { console.error('[genealogy/trace]', e); res.status(500).json({ error: e.message }); }
});

/* ── 3. WHERE-USED / BATCH RECALL & IMPACT ANALYSIS ────────────────────────── */
router.get('/where-used/:batchId', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { batchId } = req.params;
    const cid = companyOf(req);
    const b = await batchRow(batchId);
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    if (cid != null && b.company_id != null && b.company_id !== cid) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    // 1. Remaining Stock in exact stores / warehouse bins
    const { rows: binStock } = await pool.query(`
      SELECT wb.id AS bin_id, wb.row_code AS rack, wb.shelf_code AS shelf, wb.bin_code AS bin,
             w.name AS warehouse_name, wb.current_qty
        FROM warehouse_bins wb
        JOIN warehouses w ON w.id = wb.warehouse_id
       WHERE wb.item_id = $1 AND ($2::int IS NULL OR wb.company_id = $2)
       ORDER BY w.name, wb.row_code, wb.bin_code`, [b.item_id, cid]);

    // 2. Consumed in Work Orders & Panels
    const { rows: consumedOrders } = await pool.query(`
      SELECT po.id AS production_order_id, po.production_order_no, po.product_name, po.status AS order_status,
             mil.qty_issued, mil.issued_at, mil.issued_by_name, wc.name AS work_centre_name,
             op.operation AS operation_name, po.project_id, prj.project_code, prj.project_name, prj.customer_name
        FROM material_issue_logs mil
        JOIN production_orders po ON po.id = mil.production_order_id
        LEFT JOIN work_centres wc ON wc.id = mil.work_centre_id
        LEFT JOIN production_operations op ON op.id = mil.operation_id
        LEFT JOIN projects prj ON prj.id = po.project_id
       WHERE mil.batch_id = $1
       ORDER BY mil.issued_at DESC`, [batchId]);

    // 3. Shipped to Customers / Sales Orders / Shipments
    const { rows: shipments } = await pool.query(`
      SELECT s.id AS shipment_id, s.dispatch_ref, s.tracking_number, s.courier_partner, s.status AS shipment_status,
             s.dispatch_date, s.actual_delivery, so.id AS sales_order_id, so.order_number, so.customer_name,
             pkg.package_no, pl.quantity AS packed_quantity
        FROM package_lines pl
        JOIN packages pkg ON pkg.id = pl.package_id
        LEFT JOIN shipments s ON s.id = pkg.shipment_id
        LEFT JOIN sales_orders so ON so.id = pkg.sales_order_id
       WHERE pl.batch_id = $1
       ORDER BY s.dispatch_date DESC NULLS LAST`, [batchId]);

    // 4. Mathematical Quantity Reconciliation
    const qtyReceived   = parseFloat(b.quantity_received || 0);
    const qtyAvailable  = parseFloat(b.quantity_available || 0);
    const qtyConsumed   = parseFloat(b.quantity_consumed || 0);
    const qtyReserved   = parseFloat(b.quantity_reserved || 0);
    const totalAccounted = qtyAvailable + qtyConsumed + qtyReserved;

    res.json({
      batch: {
        id: b.id,
        batch_number: b.batch_number,
        item_id: b.item_id,
        item_code: b.item_code,
        item_name: b.item_name,
        manufacturer: b.manufacturer,
        supplier_id: b.supplier_id,
        vendor_name: b.vendor_name,
        po_number: b.po_number,
        grn_id: b.grn_id,
        grn_number: b.grn_number,
        received_date: b.received_date,
        expiry_date: b.expiry_date,
        warehouse_name: b.warehouse_name,
        quality_status: b.quality_status || b.grn_quality || 'passed',
      },
      reconciliation: {
        received_qty: qtyReceived,
        available_qty: qtyAvailable,
        consumed_qty: qtyConsumed,
        reserved_qty: qtyReserved,
        total_accounted: totalAccounted,
        is_reconciled: Math.abs(qtyReceived - totalAccounted) < 0.0001,
      },
      locations: binStock,
      consumed_in_orders: consumedOrders,
      shipped_deliveries: shipments,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── 4. AS-BUILT BOM VS PLANNED BOM ────────────────────────────────────────── */
router.get('/as-built/:productionOrderId', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { productionOrderId } = req.params;
    const cid = companyOf(req);

    // 1. Fetch Order
    const { rows: [order] } = await pool.query(
      `SELECT po.*, prj.project_code, prj.project_name, prj.customer_name AS project_customer,
              so.order_number AS sales_order_number, so.customer_name AS sales_customer
         FROM production_orders po
         LEFT JOIN projects prj ON prj.id = po.project_id
         LEFT JOIN sales_orders so ON so.id = po.sales_order_id
        WHERE po.id = $1 AND ($2::int IS NULL OR po.company_id = $2 OR po.company_id IS NULL)`,
      [productionOrderId, cid]
    );
    if (!order) return res.status(404).json({ error: 'Production order not found' });

    // 2. Planned BOM lines
    let plannedBom = [];
    if (order.bom_id) {
      const { rows } = await pool.query(`
        SELECT bl.id, bl.component_id AS item_id, bl.component_name AS item_name,
               ii.item_code, ii.manufacturer,
               (bl.qty * $2)::numeric AS qty_planned, bl.unit, bl.unit_cost
          FROM bom_lines bl
          LEFT JOIN inventory_items ii ON ii.id = bl.component_id
         WHERE bl.bom_id = $1
         ORDER BY bl.id`, [order.bom_id, parseFloat(order.quantity_planned || 1)]);
      plannedBom = rows;
    }

    // 3. As-Built Components (Physical Materials Consumed)
    const { rows: asBuilt } = await pool.query(`
      SELECT mil.id AS issue_log_id, mil.item_id, mil.item_name, ii.item_code, ii.manufacturer,
             mil.batch_id, b.batch_number, sn.serial_number,
             mil.qty_issued AS qty_consumed, mil.unit, mil.unit_cost, mil.total_cost,
             mil.issued_at, mil.issued_by_name,
             wc.name AS work_centre_name, op.operation AS operation_name,
             v.vendor_name AS supplier_name, po.po_number, g.grn_number, g.received_date AS grn_date,
             g.quality_status AS iqc_result,
             (CASE WHEN order_bom.component_ids IS NOT NULL AND NOT (mil.item_id = ANY(order_bom.component_ids))
                   THEN true ELSE false END) AS is_substitute,
             mil.notes
        FROM material_issue_logs mil
        LEFT JOIN inventory_items ii ON ii.id = mil.item_id
        LEFT JOIN inventory_batches b ON b.id = mil.batch_id
        LEFT JOIN serial_numbers sn ON sn.batch_id = b.id AND sn.production_order_id = mil.production_order_id
        LEFT JOIN vendors v ON v.id = b.supplier_id
        LEFT JOIN goods_receipt_notes g ON g.id = b.grn_id
        LEFT JOIN purchase_orders po ON po.id = g.po_id
        LEFT JOIN work_centres wc ON wc.id = mil.work_centre_id
        LEFT JOIN production_operations op ON op.id = mil.operation_id
        LEFT JOIN (
          SELECT ARRAY_AGG(component_id) AS component_ids FROM bom_lines WHERE bom_id = $2
        ) order_bom ON true
       WHERE mil.production_order_id = $1 AND mil.qty_issued > 0
       ORDER BY mil.issued_at ASC, mil.id ASC`, [productionOrderId, order.bom_id || 0]);

    // 4. Rework & Removed Components
    const { rows: reworkReplacements } = await pool.query(`
      SELECT mil.id, mil.item_id, mil.item_name, mil.batch_id, b.batch_number,
             ABS(mil.qty_issued) AS qty_removed, mil.issued_at AS removed_at,
             mil.issued_by_name AS removed_by, mil.notes AS removal_reason
        FROM material_issue_logs mil
        LEFT JOIN inventory_batches b ON b.id = mil.batch_id
       WHERE mil.production_order_id = $1 AND mil.qty_issued < 0
       ORDER BY mil.issued_at ASC`, [productionOrderId]);

    res.json({
      order: {
        id: order.id,
        production_order_no: order.production_order_no,
        product_name: order.product_name,
        quantity_planned: order.quantity_planned,
        quantity_completed: order.quantity_completed,
        status: order.status,
        project_code: order.project_code,
        project_name: order.project_name,
        customer_name: order.sales_customer || order.project_customer,
        serial_number: order.serial_number,
        batch_number: order.batch_number,
        planned_start_date: order.planned_start_date,
        planned_end_date: order.planned_end_date,
        actual_start_at: order.actual_start_at,
        actual_end_at: order.actual_end_at,
      },
      planned_bom: plannedBom,
      as_built_components: asBuilt,
      rework_history: reworkReplacements,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── 5. QC & TEST TRACEABILITY ─────────────────────────────────────────────── */
router.get('/qc-history/:productionOrderId', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { productionOrderId } = req.params;
    const cid = companyOf(req);

    // 1. In-process Quality Tests
    const { rows: tests } = await pool.query(`
      SELECT qt.*, op.operation AS operation_name
        FROM quality_tests qt
        LEFT JOIN production_operations op ON op.id = qt.operation_id
       WHERE qt.production_order_id = $1 AND ($2::int IS NULL OR qt.company_id = $2 OR qt.company_id IS NULL)
       ORDER BY qt.tested_at DESC NULLS LAST`, [productionOrderId, cid]);

    // 2. Final Test Runs & Measurements
    const { rows: testRuns } = await pool.query(`
      SELECT tr.*,
             (SELECT JSON_AGG(trm.*) FROM test_run_measurements trm WHERE trm.test_run_id = tr.id) AS measurements
        FROM test_runs tr
       WHERE tr.production_order_id = $1 AND ($2::int IS NULL OR tr.company_id = $2 OR tr.company_id IS NULL)
       ORDER BY tr.started_at DESC NULLS LAST`, [productionOrderId, cid]);

    // 3. FAT / SAT Trackers
    const [fat, sat] = await Promise.all([
      pool.query(`SELECT * FROM fat_trackers WHERE production_order_id = $1`, [productionOrderId]),
      pool.query(`SELECT * FROM sat_trackers WHERE production_order_id = $1`, [productionOrderId]),
    ]);

    // 4. NCRs and CAPA
    const { rows: ncrs } = await pool.query(`
      SELECT ncr.*,
             (SELECT JSON_AGG(capa.*) FROM capa_actions capa WHERE capa.ncr_id = ncr.id) AS capa_actions
        FROM ncr_reports ncr
       WHERE ((ncr.reference_type = 'production_order' AND ncr.reference_id = $1)
           OR (ncr.reference_type = 'production_operation' AND ncr.reference_id IN (SELECT id FROM production_operations WHERE production_order_id = $1)))
         AND ($2::int IS NULL OR ncr.company_id = $2 OR ncr.company_id IS NULL)
       ORDER BY ncr.created_at DESC`, [productionOrderId, cid]);

    res.json({
      in_process_tests: tests,
      test_runs: testRuns,
      fat_trackers: fat.rows,
      sat_trackers: sat.rows,
      ncrs,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── 6. LOCATION & BIN MOVEMENT HISTORY ────────────────────────────────────── */
router.get('/location-history', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { batch_id, item_id } = req.query;
    if (!batch_id && !item_id) return res.status(400).json({ error: 'batch_id or item_id is required' });
    const cid = companyOf(req);

    const { rows: movements } = await pool.query(`
      SELECT sl.id, sl.transaction_date, sl.transaction_type, sl.quantity_in, sl.quantity_out,
             sl.balance_qty, sl.rate, sl.value, sl.reference_type, sl.reference_id, sl.remarks,
             w.name AS warehouse_name, sl.created_at, e.first_name || ' ' || e.last_name AS employee_name
        FROM stock_ledger sl
        LEFT JOIN warehouses w ON w.id = sl.warehouse_id
        LEFT JOIN employees e ON e.id = sl.created_by
       WHERE ($1::int IS NULL OR sl.item_id = $1)
         AND ($2::int IS NULL OR sl.company_id = $2 OR sl.company_id IS NULL)
       ORDER BY sl.transaction_date DESC, sl.id DESC LIMIT 100`,
      [item_id || null, cid]);

    res.json(movements);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;

