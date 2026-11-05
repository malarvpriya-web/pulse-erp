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
      // Batches — searchable by the SUPPLIER's lot number and the manufacturer
      // part number as well as our own batch number. A defective-lot notice
      // arrives quoting the supplier's reference, never ours, so a recall that
      // could only be started from an internal batch id required someone to
      // find the translation by hand first.
      pool.query(`SELECT b.id, b.batch_number AS ref, i.item_name, b.quantity_available, b.quantity_received,
                         b.supplier_batch_no, b.manufacturer, b.manufacturer_part_no
                    FROM inventory_batches b LEFT JOIN inventory_items i ON i.id = b.item_id
                   WHERE ($1::int IS NULL OR b.company_id = $1 OR b.company_id IS NULL)
                     AND (b.batch_number ILIKE $2 OR b.supplier_batch_no ILIKE $2
                          OR b.manufacturer_part_no ILIKE $2)
                     AND b.deleted_at IS NULL
                   ORDER BY b.id DESC LIMIT 20`, [cid, q]),
      // Inventory Items (Component master) — also by manufacturer part number
      pool.query(`SELECT id, item_code AS ref, item_name, current_stock, unit_of_measure, manufacturer_part_no
                    FROM inventory_items
                   WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
                     AND (item_code ILIKE $2 OR item_name ILIKE $2 OR manufacturer_part_no ILIKE $2)
                     AND deleted_at IS NULL
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
      // The supplier's lot number is shown when it is what matched, so a search
      // for "ABC123" visibly resolves to our own batch rather than appearing to
      // return an unrelated row.
      ...bt.rows.map(r => ({
        type: 'batch', id: r.id, label: r.ref,
        supplier_batch_no: r.supplier_batch_no || null,
        manufacturer_part_no: r.manufacturer_part_no || null,
        sublabel: `${r.item_name || 'batch'} · avail ${Number(r.quantity_available)}/${Number(r.quantity_received)}`
          + (r.supplier_batch_no ? ` · supplier lot ${r.supplier_batch_no}` : '')
          + (r.manufacturer_part_no ? ` · MPN ${r.manufacturer_part_no}` : ''),
      })),
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
       AND LOWER(COALESCE(pkg.status, '')) <> 'unpacked'   -- undone; delivered nothing
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
      if (serials.length) {
        downstream.push(node('serials', `${serials.length} finished serial(s)`, po.product_name, {},
          serials.map(s => node('serial', s.serial_number, s.status || '', { id: s.id }))));
      } else if (po.serial_number) {
        // The serial_numbers registry is not always written, but
        // production_orders.serial_number names the unit this order built.
        // Reporting no serials while the order record itself carries one makes
        // the trace look emptier than the truth.
        downstream.push(node('serials', '1 finished serial', po.product_name, {},
          [node('serial', po.serial_number, po.status || '')]));
      }
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

/* ── 3d. AS-BUILT FROM THE ASSEMBLY RECORD ─────────────────────────────────── */
/**
 * Audit finding 15, read side.
 *
 * `component_installations` records what was FITTED into a panel — by whom, at
 * which station, when. That is a stronger statement than the material issue the
 * as-built list was previously reconstructed from, which only says material left
 * the store for the order.
 *
 * So the answer is graded, and the grade is returned rather than hidden:
 *
 *   as_built_source: 'installation'  fitted, with operator and station
 *   as_built_source: 'issue'         issued to the order; who fitted it is
 *                                    unrecorded because no installation exists
 *
 * Panels built before the assembly event existed report 'issue' and say so. No
 * installation rows were invented for them: deriving an assembly history from
 * the issue log would produce operators and timestamps nobody observed, and
 * afterwards it would be indistinguishable from the real thing.
 */
router.get('/assembly/:serialNumber', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows: [sn] } = await pool.query(
      `SELECT sn.id, sn.serial_number, sn.status, sn.production_order_id,
              po.production_order_no, po.product_name, po.project_id,
              pr.project_code, pr.project_name, pr.customer_name
         FROM serial_numbers sn
         LEFT JOIN production_orders po ON po.id = sn.production_order_id
         LEFT JOIN projects pr ON pr.id = po.project_id
        WHERE sn.serial_number = $1 AND sn.deleted_at IS NULL
          AND ($2::int IS NULL OR sn.company_id = $2 OR sn.company_id IS NULL)
        LIMIT 1`, [req.params.serialNumber, cid]);
    if (!sn) return res.status(404).json({ error: `Serial ${req.params.serialNumber} not found` });

    const { rows: installs } = await pool.query(`
      SELECT ci.id, ci.item_id, ci.quantity, ci.unit, ci.installed_at, ci.started_at, ci.completed_at,
             ci.installed_by, ci.installed_by_name, ci.station_code, ci.work_instruction_ref,
             ci.deviation_reference, ci.bom_line_id, ci.status,
             ci.removed_at, ci.removed_by, ci.removal_reason,
             ii.item_code, ii.item_name, ii.manufacturer, ii.manufacturer_part_no,
             b.batch_number, b.supplier_batch_no, b.grn_id,
             g.grn_number, g.received_date, v.vendor_name AS supplier_name, po2.po_number,
             cs.serial_number AS component_serial,
             wc.name AS work_centre_name, op.operation AS operation_name
        FROM component_installations ci
        LEFT JOIN inventory_items   ii  ON ii.id = ci.item_id
        LEFT JOIN inventory_batches b   ON b.id  = ci.batch_id
        LEFT JOIN goods_receipt_notes g ON g.id  = b.grn_id
        LEFT JOIN purchase_orders   po2 ON po2.id = g.po_id
        LEFT JOIN vendors           v   ON v.id  = b.supplier_id
        LEFT JOIN serial_numbers    cs  ON cs.id = ci.component_serial_id
        LEFT JOIN work_centres      wc  ON wc.id = ci.work_centre_id
        LEFT JOIN production_operations op ON op.id = ci.operation_id
       WHERE ci.serial_id = $1
       ORDER BY ci.installed_at, ci.id`, [sn.id]);

    const fitted  = installs.filter(r => !r.removed_at);
    const removed = installs.filter(r => r.removed_at);

    // Who worked on this panel — the answer finding 14 could not give.
    const operators = [...new Map(
      installs.filter(r => r.installed_by)
              .map(r => [String(r.installed_by), { id: r.installed_by, name: r.installed_by_name }])
    ).values()];

    // The tests run on THIS panel, via the real serial link rather than the
    // free-text column that matched nothing.
    const { rows: tests } = await pool.query(`
      SELECT tr.id, tr.run_number, tr.test_stage, tr.test_type, tr.test_spec_revision,
             tr.station_name, tr.overall_result, tr.started_at, tr.completed_at,
             tr.executed_by_name, tr.approved_by_name, tr.approved_at,
             (SELECT COUNT(*) FROM test_run_measurements m WHERE m.test_run_id = tr.id) AS measurement_count,
             (SELECT COUNT(*) FROM test_run_measurements m
               WHERE m.test_run_id = tr.id AND m.instrument_id IS NOT NULL) AS instrumented_count
        FROM test_runs tr
       WHERE tr.serial_id = $1
       ORDER BY tr.started_at NULLS LAST, tr.id`, [sn.id]);

    res.json({
      panel: sn,
      as_built_source: fitted.length ? 'installation' : 'issue',
      source_note: fitted.length
        ? 'Components below were recorded as FITTED, with the operator and station that fitted them.'
        : 'No assembly record exists for this panel. Its as-built list can only be derived from what was '
          + 'issued to the order (GET /genealogy/as-built/serial/:serial), which cannot say who fitted what. '
          + 'Assembly capture began 2026-09-15; panels built before then have none, and none was invented.',
      installedComponents: fitted,
      removedComponents: removed,
      operators,
      tests,
      counts: {
        fitted: fitted.length,
        removed: removed.length,
        distinct_operators: operators.length,
        tests_run: tests.length,
        tests_passed: tests.filter(t => String(t.overall_result || '').toLowerCase() === 'pass').length,
      },
    });
  } catch (e) { console.error('[genealogy/assembly]', e); res.status(500).json({ error: e.message }); }
});

/* ── 3c. BOM REQUIRED vs ACTUAL CONSUMPTION ────────────────────────────────── */
/**
 * Audit finding 26. Nothing anywhere compared what a BOM required against what
 * was actually issued, consumed, returned or scrapped — no endpoint, no service,
 * no query — so no discrepancy could be flagged, which is the only reason to
 * make the comparison.
 *
 * Reads the FROZEN snapshot (production_order_bom_lines), never bom_lines. The
 * live BOM is what the part list looks like TODAY; the snapshot is what this
 * order was actually built against. Comparing actual consumption to today's BOM
 * would report a variance every time engineering revised a drawing, and report
 * none when somebody quietly changed the BOM to match what was consumed.
 *
 * An order with no snapshot returns planned_bom_available: false rather than
 * silently falling back to the live BOM — a variance computed against the wrong
 * baseline is worse than no variance at all, because it looks authoritative.
 *
 * Issued and returned are netted: a rework removal that returned material to
 * stock is a reversal, not a second consumption.
 */
router.get('/bom-vs-actual/:productionOrderId', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const orderId = Number(req.params.productionOrderId);

    const { rows: [order] } = await pool.query(
      `SELECT id, production_order_no, product_name, quantity_planned, quantity_completed,
              quantity_scrapped, bom_id, bom_version, bom_snapshot_at, status
         FROM production_orders
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
      [orderId, cid]);
    if (!order) return res.status(404).json({ error: 'Production order not found' });

    const { rows: planned } = await pool.query(
      `SELECT component_id, component_code, component_name, qty_per_unit, qty_required, unit, unit_cost
         FROM production_order_bom_lines
        WHERE production_order_id = $1 ORDER BY line_no`, [orderId]);

    if (!planned.length) {
      return res.json({
        order,
        planned_bom_available: false,
        // Said plainly, because the alternative — comparing against the live
        // BOM — produces an authoritative-looking number computed against a
        // baseline that may have changed since the order was built.
        message: 'No frozen BOM snapshot for this order, so required quantities cannot be '
               + 'established. Freeze the BOM (POST /production/orders/:id/freeze-bom) to enable '
               + 'variance reporting. Comparing against the current BOM would measure against a '
               + 'baseline that may have changed since this order was built.',
        lines: [],
      });
    }

    // Actual movement per component on this order.
    const { rows: actual } = await pool.query(`
      SELECT mil.item_id,
             SUM(CASE WHEN mil.reversed_at IS NULL THEN mil.qty_issued ELSE 0 END)   AS qty_issued,
             SUM(CASE WHEN mil.reversed_at IS NOT NULL THEN mil.qty_issued ELSE 0 END) AS qty_returned_by_rework,
             SUM(CASE WHEN mil.reversed_at IS NULL AND mil.serial_id IS NOT NULL
                      THEN mil.qty_issued ELSE 0 END)                                AS qty_attributed_to_units,
             COUNT(*) FILTER (WHERE mil.substitute_for_item_id IS NOT NULL)          AS substitute_lines,
             SUM(CASE WHEN mil.reversed_at IS NULL THEN mil.total_cost ELSE 0 END)   AS actual_cost
        FROM material_issue_logs mil
       WHERE mil.production_order_id = $1
       GROUP BY mil.item_id`, [orderId]);
    const actualOf = new Map(actual.map(r => [String(r.item_id), r]));

    const { rows: scrap } = await pool.query(`
      SELECT item_id, SUM(quantity) AS qty FROM production_scrap
       WHERE production_order_id = $1 GROUP BY item_id`, [orderId]).catch(() => ({ rows: [] }));
    const scrapOf = new Map(scrap.map(r => [String(r.item_id), Number(r.qty) || 0]));

    const n = (v) => Number(v || 0);
    const lines = planned.map(p => {
      const a = actualOf.get(String(p.component_id)) || {};
      const required  = n(p.qty_required);
      const issued    = n(a.qty_issued);
      const returned  = n(a.qty_returned_by_rework);
      const scrapped  = scrapOf.get(String(p.component_id)) || 0;
      const consumed  = issued;                 // net of rework reversals already
      const installed = n(a.qty_attributed_to_units);
      const variance  = consumed - required;
      return {
        component_id: p.component_id, component_code: p.component_code,
        component_name: p.component_name, unit: p.unit,
        qty_per_unit: n(p.qty_per_unit),
        bom_required_qty: required,
        issued_qty: issued,
        returned_qty: returned,
        consumed_qty: consumed,
        scrapped_qty: scrapped,
        installed_qty: installed,
        // installed can legitimately be below consumed: bulk material issued to
        // the order without naming a unit is real consumption that simply
        // cannot be attributed to one panel.
        unattributed_qty: Math.round((consumed - installed) * 1000) / 1000,
        substitute_lines: Number(a.substitute_lines || 0),
        variance_qty: Math.round(variance * 1000) / 1000,
        variance_pct: required > 0 ? Math.round((variance / required) * 10000) / 100 : null,
        planned_cost: Math.round(required * n(p.unit_cost) * 100) / 100,
        actual_cost: Math.round(n(a.actual_cost) * 100) / 100,
        status: issued === 0 ? 'not_issued'
              : Math.abs(variance) < 0.001 ? 'on_plan'
              : variance > 0 ? 'over_consumed' : 'under_consumed',
      };
    });

    // Components consumed that the frozen BOM never called for. Substitutes are
    // separated out: an approved substitute is expected to be off-BOM and is not
    // the same finding as an unexplained component appearing in a panel.
    const plannedIds = new Set(planned.map(p => String(p.component_id)));
    const { rows: offBom } = await pool.query(`
      SELECT mil.item_id, mil.item_name, ii.item_code,
             SUM(mil.qty_issued) AS qty_issued,
             MAX(mil.substitute_for_item_id) AS substitute_for_item_id,
             MAX(mil.substitution_reason) AS substitution_reason,
             MAX(mil.substitution_approved_by_name) AS substitution_approved_by_name,
             MAX(mil.deviation_reference) AS deviation_reference
        FROM material_issue_logs mil
        LEFT JOIN inventory_items ii ON ii.id = mil.item_id
       WHERE mil.production_order_id = $1 AND mil.reversed_at IS NULL
       GROUP BY mil.item_id, mil.item_name, ii.item_code`, [orderId]);
    const unplanned = offBom.filter(r => !plannedIds.has(String(r.item_id)));

    const discrepancies = lines.filter(l => l.status !== 'on_plan');

    res.json({
      order,
      planned_bom_available: true,
      bom_version: order.bom_version,
      bom_frozen_at: order.bom_snapshot_at,
      lines,
      unplannedConsumption: unplanned.map(r => ({
        item_id: r.item_id, item_code: r.item_code, item_name: r.item_name,
        qty_issued: Number(r.qty_issued),
        is_approved_substitute: r.substitute_for_item_id != null,
        substitution_reason: r.substitution_reason,
        substitution_approved_by: r.substitution_approved_by_name,
        deviation_reference: r.deviation_reference,
      })),
      summary: {
        components_planned: lines.length,
        components_on_plan: lines.filter(l => l.status === 'on_plan').length,
        components_not_issued: lines.filter(l => l.status === 'not_issued').length,
        components_over_consumed: lines.filter(l => l.status === 'over_consumed').length,
        components_under_consumed: lines.filter(l => l.status === 'under_consumed').length,
        unplanned_components: unplanned.length,
        unapproved_unplanned_components: unplanned.filter(r => r.substitute_for_item_id == null).length,
        planned_material_cost: Math.round(lines.reduce((t, l) => t + l.planned_cost, 0) * 100) / 100,
        actual_material_cost: Math.round(lines.reduce((t, l) => t + l.actual_cost, 0) * 100) / 100,
      },
      discrepancies,
    });
  } catch (e) { console.error('[genealogy/bom-vs-actual]', e); res.status(500).json({ error: e.message }); }
});

/* ── 3b. REWORK HISTORY FOR A PANEL OR AN ORDER ────────────────────────────── */
/**
 * Reads the rework_records table added for finding 17.
 *
 * Genealogy previously derived rework from `notes ILIKE 'REWORK%'` and
 * `qty_issued < 0`, neither of which anything ever wrote — so the answer was
 * always "no rework", indistinguishable from a panel that had genuinely never
 * been touched.
 *
 * Both sides of every swap are returned. The part that came OUT is still named
 * here even though it is no longer in the panel: that is the whole point of
 * preserving the original installation row rather than editing it, and a lot
 * recall has to reach a panel that CONTAINED a defective part, not merely one
 * that still does.
 */
router.get('/rework', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { serial_number, production_order_id } = req.query;
    if (!serial_number && !production_order_id) {
      return res.status(400).json({ error: 'serial_number or production_order_id is required' });
    }

    // Resolve the anchor to a concrete id before querying, so the filter can
    // never degrade to "no filter" and return another panel's rework.
    let serialId = null;
    if (serial_number) {
      const { rows: [sn] } = await pool.query(
        `SELECT id FROM serial_numbers WHERE serial_number = $1 AND deleted_at IS NULL
           AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL) LIMIT 1`,
        [serial_number, cid]);
      if (!sn) return res.status(404).json({ error: `Serial ${serial_number} not found` });
      serialId = sn.id;
    }

    const { rows } = await pool.query(`
      SELECT rr.*,
             po.production_order_no, po.product_name,
             sn.serial_number      AS panel_serial,
             ri.item_code          AS removed_item_code,
             ri.item_name          AS removed_item_name,
             rb.batch_number       AS removed_batch_number,
             rb.supplier_batch_no  AS removed_supplier_batch_no,
             rcs.serial_number     AS removed_component_serial,
             pb.batch_number       AS replacement_batch_number,
             pcs.serial_number     AS replacement_component_serial
        FROM rework_records rr
        LEFT JOIN production_orders po ON po.id = rr.production_order_id
        LEFT JOIN serial_numbers   sn  ON sn.id = rr.serial_id
        LEFT JOIN inventory_items  ri  ON ri.id = rr.removed_item_id
        LEFT JOIN inventory_batches rb ON rb.id = rr.removed_batch_id
        LEFT JOIN serial_numbers   rcs ON rcs.id = rr.removed_component_serial_id
        LEFT JOIN inventory_batches pb ON pb.id = rr.replacement_batch_id
        LEFT JOIN serial_numbers   pcs ON pcs.id = rr.replacement_component_serial_id
       WHERE ($1::int IS NULL OR rr.company_id = $1)
         AND ($2::int IS NULL OR rr.serial_id = $2)
         AND ($3::int IS NULL OR rr.production_order_id = $3)
       ORDER BY rr.removed_at DESC, rr.id DESC`,
      [cid, serialId, production_order_id ? Number(production_order_id) : null]);

    res.json({
      anchor: { serial_number: serial_number || null, production_order_id: production_order_id || null },
      count: rows.length,
      // An empty list now honestly means "no rework recorded", which it could
      // not mean before this table existed.
      reworkHistory: rows,
      openReworks: rows.filter(r => !['closed', 'cancelled'].includes(r.status)).length,
      failedRetests: rows.filter(r => r.retest_result === 'fail').length,
    });
  } catch (e) { console.error('[genealogy/rework]', e); res.status(500).json({ error: e.message }); }
});

/* ── 3e. COMPONENT DOSSIER — everything known about one component ─────────── */
/**
 * Audit finding 23.
 *
 * The genealogy screen could reach a component, but only sideways — through a
 * where-used lookup that answers "which panels hold this lot". The requirement
 * asks for the component's own page: supplier, PO, GRN, batch/serial, IQC,
 * location history, inventory transactions, material issues, production usage,
 * panels used in, assembly, QC, rework, documents, audit history.
 *
 * Every one of those is a different table, and a screen that fetched them
 * separately would make fifteen round trips and render in fifteen stages. This
 * assembles the dossier in one pass so the page has one loading state and one
 * failure mode.
 *
 * Anchored by `type`/`id` — batch, serial or item — because a component means
 * different things at different granularities, and collapsing them would make
 * "this lot" and "this part number" the same question when they are not.
 *
 * Sections that are genuinely empty come back as empty arrays with a `note`
 * explaining why, rather than being omitted. An absent section and an empty one
 * look identical to a screen, and the difference is exactly what a person
 * investigating a defect needs to know.
 */
router.get('/component/:type/:id', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { type } = req.params;
    const id = Number(req.params.id);
    if (!['batch', 'serial', 'item'].includes(type)) {
      return res.status(400).json({ error: "type must be 'batch', 'serial' or 'item'" });
    }
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id must be numeric' });

    // ── Resolve the anchor to concrete ids FIRST, so no query below can
    // degrade to an unfiltered scan — the failure that once returned an entire
    // company's ledger for a single batch.
    let itemId = null, batchIds = [], serialId = null, anchor = null;

    if (type === 'serial') {
      const { rows: [sn] } = await pool.query(`
        SELECT sn.*, i.item_code, i.item_name, i.manufacturer, i.manufacturer_part_no, i.unit_of_measure
          FROM serial_numbers sn LEFT JOIN inventory_items i ON i.id = sn.item_id
         WHERE sn.id = $1 AND sn.deleted_at IS NULL
           AND ($2::int IS NULL OR sn.company_id = $2 OR sn.company_id IS NULL)`, [id, cid]);
      if (!sn) return res.status(404).json({ error: 'Serial not found' });
      anchor = sn; serialId = sn.id; itemId = sn.item_id;
      if (sn.batch_id) batchIds = [sn.batch_id];
    } else if (type === 'batch') {
      const { rows: [b] } = await pool.query(`
        SELECT b.*, i.item_code, i.item_name, i.manufacturer AS item_manufacturer,
               i.manufacturer_part_no AS item_mpn, i.unit_of_measure
          FROM inventory_batches b LEFT JOIN inventory_items i ON i.id = b.item_id
         WHERE b.id = $1 AND b.deleted_at IS NULL
           AND ($2::int IS NULL OR b.company_id = $2 OR b.company_id IS NULL)`, [id, cid]);
      if (!b) return res.status(404).json({ error: 'Batch not found' });
      anchor = b; batchIds = [b.id]; itemId = b.item_id;
    } else {
      const { rows: [i] } = await pool.query(`
        SELECT * FROM inventory_items
         WHERE id = $1 AND deleted_at IS NULL
           AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`, [id, cid]);
      if (!i) return res.status(404).json({ error: 'Item not found' });
      anchor = i; itemId = i.id;
      const { rows } = await pool.query(
        `SELECT id FROM inventory_batches WHERE item_id = $1 AND deleted_at IS NULL`, [itemId]);
      batchIds = rows.map(r => r.id);
    }

    const lots = batchIds.length ? batchIds : [-1];   // never an empty IN ()

    const [
      procurement, locations, ledger, issues, installs, panels, qc, rework, documents, audit,
    ] = await Promise.all([
      // ── Supplier · PO · GRN — the procurement genealogy ────────────────
      pool.query(`
        SELECT b.id AS batch_id, b.batch_number, b.supplier_batch_no, b.manufacturer,
               b.manufacturer_part_no, b.manufacturing_date, b.expiry_date, b.received_date,
               b.quantity_received, b.quantity_available, b.quantity_consumed,
               b.quantity_in_wip, b.quantity_rejected, b.quantity_returned,
               b.status, b.quality_status, b.rate,
               g.id AS grn_id, g.grn_number, g.received_date AS grn_date,
               g.quality_status AS grn_quality_status, g.quality_status_source,
               po.id AS po_id, po.po_number, po.order_date,
               v.id AS vendor_id, v.vendor_name,
               w.name AS warehouse_name, wb.bin_code
          FROM inventory_batches b
          LEFT JOIN goods_receipt_notes g ON g.id = b.grn_id
          LEFT JOIN purchase_orders po ON po.id = g.po_id
          LEFT JOIN vendors v ON v.id = b.supplier_id
          LEFT JOIN warehouses w ON w.id = b.warehouse_id
          LEFT JOIN warehouse_bins wb ON wb.id = b.bin_id
         WHERE b.id = ANY($1::int[])
         ORDER BY b.received_date NULLS LAST, b.id`, [lots]),

      // ── Where it has physically been ──────────────────────────────────
      pool.query(`
        SELECT sl.transaction_date, sl.transaction_type, sl.reason_code,
               sl.quantity_in, sl.quantity_out,
               fw.name AS from_warehouse, tw.name AS to_warehouse,
               fb.bin_code AS from_bin, tb.bin_code AS to_bin,
               sl.reference_type, sl.reference_id, sl.remarks
          FROM stock_ledger sl
          LEFT JOIN warehouses fw ON fw.id = sl.from_warehouse_id
          LEFT JOIN warehouses tw ON tw.id = sl.to_warehouse_id
          LEFT JOIN warehouse_bins fb ON fb.id = sl.from_bin_id
          LEFT JOIN warehouse_bins tb ON tb.id = sl.to_bin_id
         WHERE sl.batch_id = ANY($1::int[])
            OR ($2::int IS NOT NULL AND sl.serial_id = $2)
         ORDER BY sl.transaction_date, sl.id`, [lots, serialId]),

      // ── Every inventory transaction against it ────────────────────────
      pool.query(`
        SELECT sl.id, sl.transaction_date, sl.transaction_type, sl.quantity_in, sl.quantity_out,
               sl.balance_qty, sl.rate, sl.value, sl.reference_type, sl.reference_id,
               sl.production_order_id, sl.project_id, sl.reason_code, sl.remarks
          FROM stock_ledger sl
         WHERE sl.batch_id = ANY($1::int[])
            OR ($2::int IS NOT NULL AND sl.serial_id = $2)
         ORDER BY sl.id DESC LIMIT 200`, [lots, serialId]),

      // ── Material issues ───────────────────────────────────────────────
      pool.query(`
        SELECT mil.id, mil.qty_issued, mil.unit, mil.unit_cost, mil.total_cost,
               mil.issued_at, mil.issued_by_name, mil.notes,
               mil.reversed_at, mil.reversal_reason,
               mil.substitute_for_item_id, mil.substitution_reason, mil.deviation_reference,
               b.batch_number, po.production_order_no, po.product_name,
               sn.serial_number AS built_serial, cs.serial_number AS component_serial
          FROM material_issue_logs mil
          LEFT JOIN inventory_batches b ON b.id = mil.batch_id
          LEFT JOIN production_orders po ON po.id = mil.production_order_id
          LEFT JOIN serial_numbers sn ON sn.id = mil.serial_id
          LEFT JOIN serial_numbers cs ON cs.id = mil.component_serial_id
         WHERE mil.batch_id = ANY($1::int[])
            OR ($2::int IS NOT NULL AND mil.component_serial_id = $2)
         ORDER BY mil.issued_at, mil.id`, [lots, serialId]),

      // ── Assembly: where it was fitted, by whom ────────────────────────
      pool.query(`
        SELECT ci.id, ci.quantity, ci.installed_at, ci.started_at, ci.completed_at,
               ci.installed_by, ci.installed_by_name, ci.station_code,
               ci.work_instruction_ref, ci.deviation_reference, ci.status,
               ci.removed_at, ci.removal_reason,
               sn.serial_number AS panel_serial, po.production_order_no,
               wc.name AS work_centre_name, b.batch_number
          FROM component_installations ci
          LEFT JOIN serial_numbers sn ON sn.id = ci.serial_id
          LEFT JOIN production_orders po ON po.id = ci.production_order_id
          LEFT JOIN work_centres wc ON wc.id = ci.work_centre_id
          LEFT JOIN inventory_batches b ON b.id = ci.batch_id
         WHERE ci.batch_id = ANY($1::int[])
            OR ($2::int IS NOT NULL AND ci.component_serial_id = $2)
         ORDER BY ci.installed_at, ci.id`, [lots, serialId]),

      // ── Panels it ended up in ─────────────────────────────────────────
      pool.query(`
        SELECT DISTINCT sn.id, sn.serial_number, sn.status, sn.package_id,
               po.production_order_no, po.product_name,
               pr.project_code, pr.project_name, pr.customer_name,
               (ci.id IS NOT NULL) AS from_assembly_record
          FROM serial_numbers sn
          LEFT JOIN production_orders po ON po.id = sn.production_order_id
          LEFT JOIN projects pr ON pr.id = po.project_id
          LEFT JOIN component_installations ci
                 ON ci.serial_id = sn.id
                AND (ci.batch_id = ANY($1::int[])
                     OR ($2::int IS NOT NULL AND ci.component_serial_id = $2))
                AND ci.removed_at IS NULL
         WHERE ci.id IS NOT NULL
            OR sn.id IN (SELECT mil.serial_id FROM material_issue_logs mil
                          WHERE mil.serial_id IS NOT NULL AND mil.reversed_at IS NULL
                            AND (mil.batch_id = ANY($1::int[])
                                 OR ($2::int IS NOT NULL AND mil.component_serial_id = $2)))
         ORDER BY sn.serial_number`, [lots, serialId]),

      // ── IQC and any test evidence ─────────────────────────────────────
      pool.query(`
        SELECT qi.id, qi.inspection_date, qi.overall_result, qi.status, qi.notes,
               g.grn_number, ce.name AS instrument_name, ce.certificate_number
          FROM quality_inspections qi
          LEFT JOIN goods_receipt_notes g ON g.id = qi.grn_id
          LEFT JOIN calibration_equipment ce ON ce.id = qi.instrument_id
         WHERE qi.batch_id = ANY($1::int[])
            OR ($2::int IS NOT NULL AND qi.component_serial_id = $2)
            OR qi.grn_id IN (SELECT grn_id FROM inventory_batches WHERE id = ANY($1::int[]))
         ORDER BY qi.inspection_date NULLS LAST, qi.id`, [lots, serialId]),

      // ── Rework it was involved in, either side ────────────────────────
      pool.query(`
        SELECT rr.id, rr.reason, rr.defect_code, rr.disposition, rr.status,
               rr.removed_at, rr.removed_by_name, rr.replaced_at, rr.replaced_by_name,
               rr.retest_result, rr.retested_by_name, rr.retested_at,
               sn.serial_number AS panel_serial, po.production_order_no,
               (rr.removed_batch_id = ANY($1::int[])
                OR ($2::int IS NOT NULL AND rr.removed_component_serial_id = $2)) AS was_removed,
               (rr.replacement_batch_id = ANY($1::int[])
                OR ($2::int IS NOT NULL AND rr.replacement_component_serial_id = $2)) AS was_replacement
          FROM rework_records rr
          LEFT JOIN serial_numbers sn ON sn.id = rr.serial_id
          LEFT JOIN production_orders po ON po.id = rr.production_order_id
         WHERE rr.removed_batch_id = ANY($1::int[])
            OR rr.replacement_batch_id = ANY($1::int[])
            OR ($2::int IS NOT NULL AND (rr.removed_component_serial_id = $2
                                         OR rr.replacement_component_serial_id = $2))
         ORDER BY rr.removed_at DESC`, [lots, serialId]),

      // ── Certificates and documents attached to the receipt ────────────
      // document_master is the live document table (there is no `documents`
      // table); it links by linked_entity_type / linked_entity_id.
      pool.query(`
        SELECT d.id, d.file_name, d.revision_label, d.approval_status, d.drive_link,
               d.uploaded_by_name, d.uploaded_at, d.linked_entity_type AS attached_to
          FROM document_master d
         WHERE d.deleted_at IS NULL
           AND LOWER(d.linked_entity_type) IN ('grn','goods_receipt_note')
           AND d.linked_entity_id IN (SELECT grn_id FROM inventory_batches
                                       WHERE id = ANY($1::int[]) AND grn_id IS NOT NULL)
         ORDER BY d.uploaded_at DESC NULLS LAST LIMIT 50`, [lots]),

      // ── Audit trail ───────────────────────────────────────────────────
      // audit_logs keys on reference_type / reference_id, not table_name /
      // record_id. Written against the wrong column names this returned nothing
      // and, wrapped in a catch, would have looked like "no history" forever —
      // the same silently-empty failure as the free-text test serial.
      pool.query(`
        SELECT a.id, a.action_type, a.module_name, a.reference_type, a.reference_id,
               a.created_at, u.name AS user_name, a.old_data_json, a.new_data_json
          FROM audit_logs a
          LEFT JOIN users u ON u.id = a.user_id
         WHERE (LOWER(a.reference_type) IN ('inventory_batch','inventory_batches','batch')
                -- reference_id is TEXT on this table, so the lot ids are cast to
                -- text rather than the column to int: a non-numeric reference_id
                -- elsewhere in the table would make an int cast throw for rows
                -- this query is not even interested in.
                AND a.reference_id = ANY(ARRAY(SELECT x::text FROM unnest($1::int[]) AS x)))
            OR ($2::int IS NOT NULL
                AND LOWER(a.reference_type) IN ('serial_number','serial_numbers','serial')
                AND a.reference_id = $2::text)
         ORDER BY a.created_at DESC LIMIT 100`, [lots, serialId]),
    ]);

    const emptyNote = (rows, note) => (rows.length ? null : note);

    res.json({
      anchor: { type, id, ...anchor },
      item_id: itemId,
      batch_ids: batchIds,

      procurement: procurement.rows,
      locationHistory: locations.rows,
      inventoryTransactions: ledger.rows,
      materialIssues: issues.rows,
      assembly: installs.rows,
      panelsUsedIn: panels.rows,
      quality: qc.rows,
      rework: rework.rows,
      documents: documents.rows,
      auditTrail: audit.rows,

      // An absent section and an empty one look identical to a screen. Saying
      // which is which is the whole point for someone chasing a defect.
      notes: {
        locationHistory: emptyNote(locations.rows,
          'No movements carry this lot. Movements recorded before 2026-09-15 carry no lot id, and none was invented.'),
        assembly: emptyNote(installs.rows,
          'No assembly record. Assembly capture began 2026-09-15; earlier builds recorded the material issue only.'),
        quality: emptyNote(qc.rows, 'No incoming inspection recorded against this lot or its receipt.'),
        rework: emptyNote(rework.rows, 'Never removed from or fitted as a replacement into any panel.'),
        documents: emptyNote(documents.rows, 'No certificates or documents attached to the receipt.'),
        auditTrail: emptyNote(audit.rows, 'No audit entries recorded against this lot or unit.'),
      },

      summary: {
        lots: procurement.rows.length,
        quantity_received: procurement.rows.reduce((t, r) => t + Number(r.quantity_received || 0), 0),
        quantity_available: procurement.rows.reduce((t, r) => t + Number(r.quantity_available || 0), 0),
        quantity_consumed: procurement.rows.reduce((t, r) => t + Number(r.quantity_consumed || 0), 0),
        quantity_rejected: procurement.rows.reduce((t, r) => t + Number(r.quantity_rejected || 0), 0),
        movements: ledger.rows.length,
        issues: issues.rows.filter(r => !r.reversed_at).length,
        installations: installs.rows.filter(r => !r.removed_at).length,
        panels: panels.rows.length,
        rework_events: rework.rows.length,
      },
    });
  } catch (e) { console.error('[genealogy/component]', e); res.status(500).json({ error: e.message }); }
});

/* ── 3a. RECALL BY SUPPLIER LOT / MANUFACTURER PART ────────────────────────── */
/**
 * "Supplier batch ABC123 is defective — what have we got and where has it gone?"
 *
 * where-used answers this for ONE internal batch id. That is not the form the
 * question arrives in: a defect notice quotes the SUPPLIER's lot number or the
 * manufacturer's part number, never our internal id, and one supplier lot can
 * land as several internal lots across several receipts and stores. Until the
 * supplier_batch_no / manufacturer_part_no columns existed this could not be
 * asked at all, and a recall began with someone reading the identifiers off
 * paperwork to find our batch ids by hand.
 *
 * Accepts exactly one anchor: supplier_batch_no, manufacturer_part_no, or
 * batch_number. Resolving to no lot is a 404 — never an empty recall presented
 * as "nothing affected", which is the most dangerous possible wrong answer here.
 *
 * Attribution follows the same two-tier rule as as-built, and for the same
 * reason: a unit whose consumption named it is CONFIRMED; a unit on an order the
 * lot was issued to without naming a unit CANNOT BE RULED OUT. Merging them
 * would either overstate the recall or, far worse, understate it.
 */
router.get('/recall', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { supplier_batch_no, manufacturer_part_no, batch_number } = req.query;
    const anchors = [
      ['supplier_batch_no', supplier_batch_no],
      ['manufacturer_part_no', manufacturer_part_no],
      ['batch_number', batch_number],
    ].filter(([, v]) => v != null && String(v).trim() !== '');

    if (anchors.length !== 1) {
      return res.status(400).json({
        error: 'Provide exactly one of supplier_batch_no, manufacturer_part_no or batch_number',
      });
    }
    const [field, value] = anchors[0];

    // Resolve the anchor to concrete lot ids FIRST. The filter can then never
    // degrade to "no filter" — the failure mode that once made a single-batch
    // location query return the entire company ledger.
    const { rows: lots } = await pool.query(`
      SELECT b.id, b.batch_number, b.supplier_batch_no, b.manufacturer, b.manufacturer_part_no,
             b.manufacturing_date, b.expiry_date, b.received_date, b.status, b.quality_status,
             b.quantity_received, b.quantity_available, b.quantity_consumed, b.quantity_reserved,
             b.item_id, ii.item_code, ii.item_name,
             b.warehouse_id, w.name AS warehouse_name,
             b.grn_id, g.grn_number, g.received_date AS grn_date,
             g.po_id, po.po_number, v.vendor_name AS supplier_name
        FROM inventory_batches b
        LEFT JOIN inventory_items ii ON ii.id = b.item_id
        LEFT JOIN warehouses w ON w.id = b.warehouse_id
        LEFT JOIN goods_receipt_notes g ON g.id = b.grn_id
        LEFT JOIN purchase_orders po ON po.id = g.po_id
        LEFT JOIN vendors v ON v.id = b.supplier_id
       WHERE b.deleted_at IS NULL
         AND ($1::int IS NULL OR b.company_id = $1 OR b.company_id IS NULL)
         AND b.${field} = $2
       ORDER BY b.received_date ASC, b.id ASC`, [cid, String(value).trim()]);

    if (!lots.length) {
      return res.status(404).json({
        error: `No lot found for ${field} "${value}"`,
        searched: { field, value },
      });
    }

    const lotIds = lots.map(l => l.id);

    // Consumption of these lots, split by whether it named the unit it went into.
    // Reversed rows are EXCLUDED from what is currently installed but kept in
    // the history below: a component removed during rework is no longer in that
    // panel, and recalling the panel for a part that was taken out of it would
    // be a false positive.
    const { rows: consumption } = await pool.query(`
      SELECT mil.id, mil.batch_id, mil.qty_issued, mil.production_order_id, mil.serial_id,
             mil.component_serial_id, mil.issued_at, mil.issued_by_name, mil.reversed_at,
             po.production_order_no, po.product_name, po.project_id,
             pr.project_code, pr.project_name, pr.customer_name,
             bs.serial_number AS built_serial, bs.status AS built_serial_status,
             cs.serial_number AS component_serial
        FROM material_issue_logs mil
        LEFT JOIN production_orders po ON po.id = mil.production_order_id
        LEFT JOIN projects pr ON pr.id = po.project_id
        LEFT JOIN serial_numbers bs ON bs.id = mil.serial_id
        LEFT JOIN serial_numbers cs ON cs.id = mil.component_serial_id
       WHERE mil.batch_id = ANY($1::int[])
       ORDER BY mil.issued_at ASC, mil.id ASC`, [lotIds]);

    const live = consumption.filter(c => c.reversed_at == null);

    // CONFIRMED: the consumption named the unit it went into.
    const confirmed = new Map();
    for (const c of live) {
      if (!c.serial_id || !c.built_serial) continue;
      if (!confirmed.has(c.built_serial)) {
        confirmed.set(c.built_serial, {
          serial_number: c.built_serial, status: c.built_serial_status,
          production_order_id: c.production_order_id, production_order_no: c.production_order_no,
          product_name: c.product_name, project_id: c.project_id, project_code: c.project_code,
          project_name: c.project_name, customer_name: c.customer_name,
          qty_from_lot: 0, component_serials: [],
        });
      }
      const e = confirmed.get(c.built_serial);
      e.qty_from_lot += Number(c.qty_issued || 0);
      if (c.component_serial) e.component_serials.push(c.component_serial);
    }

    // CANNOT BE RULED OUT: the lot reached the order, but no unit was named, so
    // every unit that order built is a candidate.
    const unattributedOrders = [...new Set(live.filter(c => !c.serial_id && c.production_order_id)
      .map(c => String(c.production_order_id)))];
    let possible = [];
    if (unattributedOrders.length) {
      const { rows } = await pool.query(`
        SELECT sn.serial_number, sn.status, sn.production_order_id,
               po.production_order_no, po.product_name, po.project_id,
               pr.project_code, pr.project_name, pr.customer_name
          FROM serial_numbers sn
          LEFT JOIN production_orders po ON po.id = sn.production_order_id
          LEFT JOIN projects pr ON pr.id = po.project_id
         WHERE sn.production_order_id = ANY($1::int[]) AND sn.deleted_at IS NULL
         ORDER BY sn.serial_number`, [unattributedOrders.map(Number)]);
      possible = rows.filter(r => !confirmed.has(r.serial_number));
    }

    const n = (v) => Number(v || 0);
    const sum = (k) => lots.reduce((t, l) => t + n(l[k]), 0);
    const blockedStatuses = ['quarantine', 'rejected', 'hold', 'blocked'];

    res.json({
      searched: { field, value: String(value).trim() },
      lots,
      totals: {
        lots_matched: lots.length,
        quantity_received: sum('quantity_received'),
        quantity_remaining_in_stock: sum('quantity_available'),
        quantity_consumed: sum('quantity_consumed'),
        quantity_reserved: sum('quantity_reserved'),
        quantity_blocked_or_quarantined: lots
          .filter(l => blockedStatuses.includes(String(l.status || '').toLowerCase()))
          .reduce((t, l) => t + n(l.quantity_available), 0),
        quantity_issued_to_production: live.reduce((t, c) => t + n(c.qty_issued), 0),
      },
      storesHolding: [...new Map(lots
        .filter(l => n(l.quantity_available) > 0)
        .map(l => [String(l.warehouse_id), {
          warehouse_id: l.warehouse_id, warehouse_name: l.warehouse_name,
          quantity: lots.filter(x => String(x.warehouse_id) === String(l.warehouse_id))
            .reduce((t, x) => t + n(x.quantity_available), 0),
        }])).values()],
      affectedPanels: { confirmed: [...confirmed.values()], cannotRuleOut: possible },
      affectedProjects: [...new Map([...confirmed.values(), ...possible]
        .filter(p => p.project_id)
        .map(p => [String(p.project_id), {
          project_id: p.project_id, project_code: p.project_code,
          project_name: p.project_name, customer_name: p.customer_name,
        }])).values()],
      reworkHistory: consumption.filter(c => c.reversed_at != null).map(c => ({
        issue_log_id: c.id, built_serial: c.built_serial, component_serial: c.component_serial,
        removed_at: c.reversed_at, originally_issued_at: c.issued_at, issued_by: c.issued_by_name,
      })),
      recallScope: {
        confirmed_units: confirmed.size,
        cannot_rule_out_units: possible.length,
        upper_bound_units: confirmed.size + possible.length,
        exact: possible.length === 0,
        note: possible.length
          ? `${possible.length} unit(s) cannot be confirmed or ruled out: this lot reached their order without naming a unit. Recall scope is an upper bound of ${confirmed.size + possible.length}.`
          : (confirmed.size
              ? `Recall scope is exact: ${confirmed.size} unit(s).`
              : 'No unit has consumed this lot. Remaining stock can be quarantined without a production recall.'),
      },
    });
  } catch (e) { console.error('[genealogy/recall]', e); res.status(500).json({ error: e.message }); }
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
      SELECT wb.id AS bin_id, wb.row_code AS rack, wb.row_code AS rack_code,
             wb.shelf_code AS shelf, wb.bin_code AS bin, wb.bin_code,
             w.name AS warehouse_name, wb.current_qty, wb.current_qty AS quantity
        FROM warehouse_bins wb
        JOIN warehouses w ON w.id = wb.warehouse_id
       WHERE wb.item_id = $1 AND ($2::int IS NULL OR wb.company_id = $2)
       ORDER BY w.name, wb.row_code, wb.bin_code`, [b.item_id, cid]);

    // 2. Consumed in Work Orders & Panels
    const { rows: consumedOrders } = await pool.query(`
      SELECT po.id AS production_order_id, po.production_order_no, po.production_order_no AS order_number,
             po.product_name, po.status AS order_status,
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
         AND LOWER(COALESCE(pkg.status, '')) <> 'unpacked'   -- undone; delivered nothing
       ORDER BY s.dispatch_date DESC NULLS LAST`, [batchId]);

    // 3b. Which finished units this lot is in — the question a recall actually
    //     asks. Split by certainty, never merged: a lot issued against a named
    //     unit is IN that unit; a lot issued to the order is in an unknown
    //     subset of the units that order built. Reporting the second as though
    //     it were the first is what made every recall take the whole order.
    const { rows: affectedSerials } = await pool.query(`
      SELECT sn.id, sn.serial_number, sn.status, po.production_order_no,
             prj.customer_name, MAX(mil.qty_issued) AS qty_issued, 'attributed' AS certainty
        FROM material_issue_logs mil
        JOIN serial_numbers sn ON sn.id = mil.serial_id AND sn.deleted_at IS NULL
        JOIN production_orders po ON po.id = mil.production_order_id
        LEFT JOIN projects prj ON prj.id = po.project_id
       WHERE mil.batch_id = $1
       GROUP BY sn.id, sn.serial_number, sn.status, po.production_order_no, prj.customer_name

       UNION ALL

      SELECT sn.id, sn.serial_number, sn.status, po.production_order_no,
             prj.customer_name, NULL AS qty_issued, 'possible' AS certainty
        FROM material_issue_logs mil
        JOIN production_orders po ON po.id = mil.production_order_id
        JOIN serial_numbers sn ON sn.production_order_id = po.id AND sn.deleted_at IS NULL
        LEFT JOIN projects prj ON prj.id = po.project_id
       WHERE mil.batch_id = $1 AND mil.serial_id IS NULL
         AND NOT EXISTS (
               SELECT 1 FROM material_issue_logs m2
                WHERE m2.batch_id = $1 AND m2.serial_id = sn.id
             )
       GROUP BY sn.id, sn.serial_number, sn.status, po.production_order_no, prj.customer_name
       ORDER BY 7, 2`, [batchId]);

    const definite = affectedSerials.filter(s => s.certainty === 'attributed');
    const possible = affectedSerials.filter(s => s.certainty === 'possible');

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
        // Both names for each figure: the *_qty set this handler shipped with,
        // and the total_received / store_stock_remaining / consumed_in_wip names
        // the Where-Used tab and the integration test both read. Only the second
        // set was ever consumed, so every reconciliation tile rendered 0.
        received_qty: qtyReceived,      total_received: qtyReceived,
        available_qty: qtyAvailable,    store_stock_remaining: qtyAvailable,
        consumed_qty: qtyConsumed,      consumed_in_wip: qtyConsumed,
        reserved_qty: qtyReserved,
        total_accounted: totalAccounted,
        is_reconciled: Math.abs(qtyReceived - totalAccounted) < 0.0001,
      },
      // GenealogyTrace.jsx reads warehouseStock / customerDispatches, and the
      // integration test reads consumedOrders. This emitted locations /
      // consumed_in_orders / shipped_deliveries, so every panel on the
      // Where-Used tab rendered its empty state no matter what came back.
      warehouseStock: binStock,
      consumedOrders,
      customerDispatches: shipments,
      affectedSerials,
      recallScope: {
        definite_units: definite.length,
        possible_units: possible.length,
        // The number a recall decision is actually made on. When attribution is
        // complete this equals definite_units and the recall is exact; while
        // lines remain unattributed it stays an upper bound, and the gap between
        // the two figures is the cost of not recording the unit at issue time.
        upper_bound_units: definite.length + possible.length,
        exact: possible.length === 0,
        note: possible.length
          ? `${possible.length} unit(s) cannot be confirmed or ruled out: this lot was issued to their order without naming a unit. Recall scope is an upper bound of ${definite.length + possible.length}.`
          : (definite.length ? `Recall scope is exact: ${definite.length} unit(s).` : 'This lot has not been consumed into any serialised unit.'),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── 4a. AS-BUILT BOM FOR ONE PANEL ────────────────────────────────────────── */
// Registered BEFORE /as-built/:productionOrderId. Express matches in order, so
// the parameterised route would otherwise swallow the literal "serial" segment
// and try to read it as an order id.
//
// Consumption splits in two, and the split is the whole point of this endpoint:
//
//   attributed  issued against THIS serial. Definitely in this panel.
//   shared      issued to the order with no unit named. MAY be in this panel;
//               cannot be narrowed further, because nobody recorded it.
//
// Merging the two is what the old order-level answer did, and it reported every
// component of a 5-panel order as being in all five panels.
const asBuiltSelect = (whereClause) => `
  SELECT mil.id AS issue_log_id, mil.item_id, mil.item_name, ii.item_code, ii.manufacturer,
         mil.batch_id, b.batch_number,
         mil.serial_id, mil.component_serial_id, cs.serial_number AS component_serial_number,
         mil.qty_issued AS qty_consumed, mil.qty_issued, mil.unit, mil.unit AS uom,
         mil.unit_cost, mil.total_cost,
         mil.issued_at, mil.issued_by_name, mil.issued_by_name AS assembler_name,
         wc.name AS work_centre_name, wc.name AS workstation_name,
         op.operation AS operation_name,
         v.vendor_name AS supplier_name, po.po_number, g.grn_number, g.received_date AS grn_date,
         g.quality_status AS iqc_result, g.quality_status AS iqc_status,
         (mil.notes IS NOT NULL AND mil.notes ILIKE 'REWORK%') AS is_rework_replacement,
         (CASE WHEN mil.notes ILIKE 'REWORK%' THEN mil.notes ELSE NULL END) AS rework_reason,
         mil.notes
    FROM material_issue_logs mil
    LEFT JOIN inventory_items ii ON ii.id = mil.item_id
    LEFT JOIN inventory_batches b ON b.id = mil.batch_id
    LEFT JOIN serial_numbers cs ON cs.id = mil.component_serial_id
    LEFT JOIN vendors v ON v.id = b.supplier_id
    LEFT JOIN goods_receipt_notes g ON g.id = b.grn_id
    LEFT JOIN purchase_orders po ON po.id = g.po_id
    LEFT JOIN work_centres wc ON wc.id = mil.work_centre_id
    LEFT JOIN production_operations op ON op.id = mil.operation_id
   WHERE ${whereClause}
   ORDER BY mil.issued_at ASC, mil.id ASC`;

router.get('/as-built/serial/:serialNumber', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { serialNumber } = req.params;
    const cid = companyOf(req);

    const { rows: [sn] } = await pool.query(`
      SELECT sn.*, i.item_name, i.item_code, po.production_order_no, po.quantity_planned,
             po.bom_id, po.status AS order_status, po.project_id, po.sales_order_id
        FROM serial_numbers sn
        LEFT JOIN inventory_items i ON i.id = sn.item_id
        LEFT JOIN production_orders po ON po.id = sn.production_order_id
       WHERE sn.serial_number = $1 AND sn.deleted_at IS NULL
         AND ($2::int IS NULL OR sn.company_id = $2 OR sn.company_id IS NULL)
       LIMIT 1`, [serialNumber, cid]);
    if (!sn) return res.status(404).json({ error: `Serial ${serialNumber} not found` });

    const { rows: attributed } = await pool.query(
      asBuiltSelect('mil.serial_id = $1 AND mil.qty_issued > 0'), [sn.id]);

    const { rows: shared } = sn.production_order_id
      ? await pool.query(
          asBuiltSelect('mil.production_order_id = $1 AND mil.serial_id IS NULL AND mil.qty_issued > 0'),
          [sn.production_order_id])
      : { rows: [] };

    // How many units the shared material was spread across. A caller needs this
    // to judge a shared line: one lot over 5 panels is a fifth as strong a claim
    // as the same lot over 1.
    const { rows: [{ sibling_count }] } = sn.production_order_id
      ? await pool.query(
          `SELECT COUNT(*)::int AS sibling_count FROM serial_numbers
            WHERE production_order_id = $1 AND deleted_at IS NULL`, [sn.production_order_id])
      : { rows: [{ sibling_count: 1 }] };

    res.json({
      serial: {
        id: sn.id, serial_number: sn.serial_number, status: sn.status,
        item_id: sn.item_id, item_name: sn.item_name, item_code: sn.item_code,
        batch_id: sn.batch_id,
        production_order_id: sn.production_order_id,
        production_order_no: sn.production_order_no,
        quantity_planned: sn.quantity_planned,
        order_status: sn.order_status,
      },
      attributedComponents: attributed,
      sharedComponents: shared,
      attribution: {
        attributed_lines: attributed.length,
        shared_lines: shared.length,
        units_on_order: sibling_count,
        // True only when every line consumed by this order names a unit. Until
        // then a per-panel as-built is partly an upper bound, and saying so is
        // the difference between a traceable record and a plausible one.
        complete: shared.length === 0 && attributed.length > 0,
        note: shared.length
          ? `${shared.length} line(s) were issued to order ${sn.production_order_no || sn.production_order_id} without naming a unit and are shared across ${sibling_count} serial(s). They may or may not be in this panel.`
          : (attributed.length ? 'Every consumed line names this unit.' : 'No consumption recorded against this unit or its order.'),
      },
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
             mil.batch_id, b.batch_number,
             -- Which unit this line went into, where the issuer named one. NULL
             -- means it was issued to the order and is shared across every unit
             -- the order builds; see /as-built/serial/:serialNumber.
             mil.serial_id, bs.serial_number AS built_serial_number,
             mil.component_serial_id, cs.serial_number AS component_serial_number,
             -- Serials of the COMPONENT that was consumed, not of the panel this
             -- order builds. The previous join matched sn.batch_id against the
             -- component batch while filtering on the consuming order, so it
             -- compared a finished-good serial's own lot against a component lot
             -- and returned NULL on every row. Aggregated rather than joined:
             -- one component lot can hold many serials and a plain join would
             -- fan the as-built list out to one row per serial.
             csn.component_serials,
             COALESCE(csn.component_serial_count, 0) AS component_serial_count,
             -- Kept for callers reading a single value; only meaningful when the
             -- lot resolves to exactly one serial.
             (CASE WHEN csn.component_serial_count = 1 THEN csn.component_serials[1] END) AS serial_number,
             mil.qty_issued AS qty_consumed, mil.qty_issued, mil.unit, mil.unit AS uom,
             mil.unit_cost, mil.total_cost,
             mil.issued_at, mil.issued_by_name, mil.issued_by_name AS assembler_name,
             wc.name AS work_centre_name, wc.name AS workstation_name,
             op.operation AS operation_name,
             v.vendor_name AS supplier_name, po.po_number, g.grn_number, g.received_date AS grn_date,
             g.quality_status AS iqc_result, g.quality_status AS iqc_status,
             -- A rework replacement is a second issue against an order that the
             -- issuer marked as rework in the note. material_issue_logs has no
             -- column for it, so the note is the only signal available; this is
             -- the weakest link in the as-built picture and wants a real column
             -- if rework reporting matters. Distinct from is_substitute below,
             -- which means "not in the planned BOM at all".
             (mil.notes IS NOT NULL AND mil.notes ILIKE 'REWORK%') AS is_rework_replacement,
             (CASE WHEN mil.notes ILIKE 'REWORK%' THEN mil.notes ELSE NULL END) AS rework_reason,
             (CASE WHEN order_bom.component_ids IS NOT NULL AND NOT (mil.item_id = ANY(order_bom.component_ids))
                   THEN true ELSE false END) AS is_substitute,
             mil.notes
        FROM material_issue_logs mil
        LEFT JOIN inventory_items ii ON ii.id = mil.item_id
        LEFT JOIN inventory_batches b ON b.id = mil.batch_id
        LEFT JOIN LATERAL (
          SELECT ARRAY_AGG(sn.serial_number ORDER BY sn.serial_number) AS component_serials,
                 COUNT(*)::int AS component_serial_count
            FROM serial_numbers sn
           WHERE sn.batch_id = mil.batch_id
             AND sn.item_id  = mil.item_id
             AND sn.deleted_at IS NULL
        ) csn ON true
        LEFT JOIN serial_numbers bs ON bs.id = mil.serial_id
        LEFT JOIN serial_numbers cs ON cs.id = mil.component_serial_id
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

    // 5. How many units this order builds, which decides whether an order-level
    //    as-built is the answer or merely an upper bound.
    const { rows: [{ serials_on_order: serialsOnOrder }] } = await pool.query(
      `SELECT COUNT(*)::int AS serials_on_order FROM serial_numbers
        WHERE production_order_id = $1 AND deleted_at IS NULL`, [productionOrderId]);

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
      plannedBom,
      asBuiltComponents: asBuilt,
      reworkHistory: reworkReplacements,
      // Says plainly how much of this order's consumption can be pinned to a
      // unit. An order-level as-built is the correct answer for a single-unit
      // order and an UPPER BOUND for a multi-unit one; without this the two are
      // indistinguishable to the caller.
      attribution: {
        units_on_order: serialsOnOrder,
        attributed_lines: asBuilt.filter(c => c.serial_id != null).length,
        shared_lines: asBuilt.filter(c => c.serial_id == null).length,
        complete: serialsOnOrder > 0 && asBuilt.length > 0 && asBuilt.every(c => c.serial_id != null),
        note: serialsOnOrder > 1 && asBuilt.some(c => c.serial_id == null)
          ? `This order builds ${serialsOnOrder} units. Lines with no serial_id are shared across all of them — this list is an upper bound for any single unit. Use /genealogy/as-built/serial/:serialNumber for one unit.`
          : null,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── 5. QC & TEST TRACEABILITY ─────────────────────────────────────────────── */
router.get('/qc-history/:productionOrderId', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { productionOrderId } = req.params;
    const cid = companyOf(req);

    // The parent order decides the tenant boundary, the way /where-used does
    // for its batch. Without it a caller asking for another company's order got
    // 200 and empty arrays rather than 404 — and worse, every child query here
    // carries an `OR company_id IS NULL` escape, so any quality row with a null
    // company was handed to every tenant regardless of whose order it belonged
    // to. Owning the parent is now the precondition for reaching any of them.
    const { rows: [owner] } = await pool.query(
      `SELECT id, company_id FROM production_orders WHERE id = $1`, [productionOrderId]);
    if (!owner) return res.status(404).json({ error: 'Production order not found' });
    if (cid != null && owner.company_id != null && owner.company_id !== cid) {
      return res.status(404).json({ error: 'Production order not found' });
    }

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
    // sat_trackers has no production_order_id and never did: site acceptance
    // happens against a project, at a customer site, and the row is keyed on
    // project_id / commissioning_report_id. Querying it by production order
    // threw "column production_order_id does not exist" and took the whole
    // endpoint down with it. The honest link is the serial number the order
    // built — the SAT certificate for that unit.
    const [fat, sat] = await Promise.all([
      pool.query(
        `SELECT * FROM fat_trackers
          WHERE production_order_id = $1
            AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
        [productionOrderId, cid]),
      pool.query(
        `SELECT st.*
           FROM sat_trackers st
           JOIN production_orders po ON po.id = $1
          WHERE po.serial_number IS NOT NULL
            AND st.serial_number = po.serial_number
            AND ($2::int IS NULL OR st.company_id = $2 OR st.company_id IS NULL)`,
        [productionOrderId, cid]),
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
      inProcessTests: tests,
      testRuns,
      // One list, tagged, because the QC tab renders FAT and SAT together and
      // keys the card off tracker_type.
      fatSat: [
        ...fat.rows.map(r => ({ ...r, tracker_type: 'FAT' })),
        ...sat.rows.map(r => ({ ...r, tracker_type: 'SAT' })),
      ],
      ncrs,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── 6. LOCATION & BIN MOVEMENT HISTORY ────────────────────────────────────── */
router.get('/location-history', requirePermission('production', 'view'), async (req, res) => {
  try {
    const { batch_id, item_id, production_order_id, serial_number } = req.query;
    if (!batch_id && !item_id && !production_order_id && !serial_number) {
      return res.status(400).json({ error: 'One of batch_id, item_id, production_order_id or serial_number is required' });
    }
    const cid = companyOf(req);

    // Resolve the caller's anchor to concrete ids BEFORE querying movements.
    // The filter is never allowed to degrade to "no filter": an anchor that does
    // not resolve is a 404, because binding NULL into the item predicate made
    // it universally true and returned the company's entire stock ledger as if
    // it were one lot's history.
    let batchId = batch_id ? parseInt(batch_id, 10) : null;
    let itemId = item_id ? parseInt(item_id, 10) : null;
    let orderId = production_order_id ? parseInt(production_order_id, 10) : null;
    let serialId = null;
    const scope = {};

    if (serial_number) {
      const { rows: [sn] } = await pool.query(
        `SELECT id, serial_number, item_id, batch_id, production_order_id FROM serial_numbers
          WHERE serial_number = $1 AND deleted_at IS NULL
            AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL) LIMIT 1`,
        [serial_number, cid]);
      if (!sn) return res.status(404).json({ error: `Serial ${serial_number} not found` });
      serialId = sn.id; batchId = batchId || sn.batch_id;
      itemId = itemId || sn.item_id; orderId = orderId || sn.production_order_id;
      scope.serial_number = sn.serial_number;
    }

    if (batchId) {
      const { rows: [b] } = await pool.query(
        `SELECT id, item_id, batch_number, warehouse_id FROM inventory_batches
          WHERE id = $1 AND deleted_at IS NULL
            AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
        [batchId, cid]);
      if (!b) return res.status(404).json({ error: 'Batch not found' });
      itemId = itemId || b.item_id;
      scope.batch_number = b.batch_number;
    }

    if (orderId) {
      const { rows: [o] } = await pool.query(
        `SELECT id, production_order_no FROM production_orders
          WHERE id = $1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
        [orderId, cid]);
      if (!o) return res.status(404).json({ error: 'Production order not found' });
      scope.production_order_no = o.production_order_no;
    }

    const movements = [];
    const push = (rows, type) => rows.forEach(r => movements.push({ ...r, movement_type: r.movement_type || type }));

    if (batchId) {
      // Receipt into stock. A purchased lot arrives from a vendor; a lot this
      // plant produced arrives from the order that built it.
      const { rows } = await pool.query(`
        SELECT b.received_date AS created_at, 'Receipt' AS movement_type,
               COALESCE(v.vendor_name, po.production_order_no, 'Receiving') AS from_location,
               COALESCE(w.name, 'Unassigned warehouse') AS to_location,
               b.quantity_received AS quantity, g.grn_number AS reference, NULL AS created_by_name
          FROM inventory_batches b
          LEFT JOIN warehouses w ON w.id = b.warehouse_id
          LEFT JOIN vendors v ON v.id = b.supplier_id
          LEFT JOIN goods_receipt_notes g ON g.id = b.grn_id
          LEFT JOIN production_orders po ON po.id = b.production_order_id
         WHERE b.id = $1`, [batchId]);
      push(rows);

      // Pick from a bin. pick_list_lines is the only table in the chain that
      // records bin-level position, so it is the only bin detail available.
      const { rows: picks } = await pool.query(`
        SELECT COALESCE(pl.completed_at, pl.created_at) AS created_at, 'Pick' AS movement_type,
               COALESCE(pll.bin_code, bl.bin_code, 'Store') AS from_location,
               'Packing' AS to_location, pll.picked_qty AS quantity,
               pl.sales_order_ref AS reference, NULL AS created_by_name
          FROM pick_list_lines pll
          JOIN pick_lists pl ON pl.id = pll.pick_list_id
          LEFT JOIN warehouse_bins bl ON bl.id = pll.bin_id
         WHERE pll.batch_id = $1
           AND ($2::int IS NULL OR pl.company_id = $2 OR pl.company_id IS NULL)`, [batchId, cid]);
      push(picks);

      // Issue to production — the store-to-workstation hop.
      const { rows: issues } = await pool.query(`
        SELECT mil.issued_at AS created_at, 'Issue to production' AS movement_type,
               COALESCE(w.name, 'Store') AS from_location,
               COALESCE(wc.name, po.production_order_no, 'Production') AS to_location,
               mil.qty_issued AS quantity, po.production_order_no AS reference,
               mil.issued_by_name AS created_by_name
          FROM material_issue_logs mil
          LEFT JOIN production_orders po ON po.id = mil.production_order_id
          LEFT JOIN work_centres wc ON wc.id = mil.work_centre_id
          LEFT JOIN inventory_batches b ON b.id = mil.batch_id
          LEFT JOIN warehouses w ON w.id = b.warehouse_id
         WHERE mil.batch_id = $1
           AND ($2::int IS NULL OR mil.company_id = $2 OR mil.company_id IS NULL)`, [batchId, cid]);
      push(issues);

      // Packed and dispatched.
      const { rows: packs } = await pool.query(`
        SELECT COALESCE(pk.packed_at, pln.created_at) AS created_at,
               CASE WHEN LOWER(COALESCE(pk.status, '')) = 'unpacked' THEN 'Packed (later unpacked)' ELSE 'Packed' END AS movement_type,
               'Packing' AS from_location,
               COALESCE(NULLIF(sh.to_address, ''), sh.tracking_number, pk.package_no) AS to_location,
               pln.quantity, pk.package_no AS reference, pk.packed_by_name AS created_by_name
          FROM package_lines pln
          JOIN packages pk ON pk.id = pln.package_id
          LEFT JOIN shipments sh ON sh.id = pk.shipment_id
         WHERE pln.batch_id = $1
           AND ($2::int IS NULL OR pln.company_id = $2 OR pln.company_id IS NULL)`, [batchId, cid]);
      push(packs);
    }

    if (orderId) {
      // WIP moves carry explicit from/to locations.
      const { rows } = await pool.query(`
        SELECT COALESCE(wt.transaction_at, wt.created_at) AS created_at,
               COALESCE(wt.transaction_type, 'WIP move') AS movement_type,
               wt.from_location, wt.to_location, wt.quantity,
               po.production_order_no AS reference, wt.actor_name AS created_by_name
          FROM wip_transactions wt
          LEFT JOIN production_orders po ON po.id = wt.production_order_id
         WHERE wt.production_order_id = $1
           AND ($2::int IS NULL OR wt.company_id = $2 OR wt.company_id IS NULL)`, [orderId, cid]);
      push(rows);

      if (!batchId) {
        // Components consumed by this order, when the caller anchored on the
        // order rather than on one lot.
        const { rows: issues } = await pool.query(`
          SELECT mil.issued_at AS created_at, 'Issue to production' AS movement_type,
                 COALESCE(w.name, 'Store') AS from_location,
                 COALESCE(wc.name, 'Production') AS to_location,
                 mil.qty_issued AS quantity, b.batch_number AS reference,
                 mil.issued_by_name AS created_by_name
            FROM material_issue_logs mil
            LEFT JOIN work_centres wc ON wc.id = mil.work_centre_id
            LEFT JOIN inventory_batches b ON b.id = mil.batch_id
            LEFT JOIN warehouses w ON w.id = b.warehouse_id
           WHERE mil.production_order_id = $1
             AND ($2::int IS NULL OR mil.company_id = $2 OR mil.company_id IS NULL)`, [orderId, cid]);
        push(issues);
      }
    }

    if (serialId) {
      const { rows } = await pool.query(`
        SELECT COALESCE(se.event_date, se.created_at) AS created_at,
               se.event_type AS movement_type, NULL AS from_location,
               se.description AS to_location, NULL AS quantity,
               se.reference_type AS reference, NULL AS created_by_name
          FROM serial_events se
         WHERE se.serial_id = $1`, [serialId]);
      push(rows);
    }

    // The stock ledger has no batch column, so it can only answer at item level.
    // It is the whole answer for an item anchor and deliberately omitted for a
    // lot anchor, where including it would re-introduce the original defect:
    // sibling lots of the same item presented as this lot's movements.
    if (itemId && !batchId && !orderId && !serialId) {
      const { rows } = await pool.query(`
        SELECT sl.transaction_date AS created_at, sl.transaction_type AS movement_type,
               CASE WHEN sl.quantity_in > 0 THEN sl.reference_type ELSE w.name END AS from_location,
               CASE WHEN sl.quantity_in > 0 THEN w.name ELSE sl.reference_type END AS to_location,
               COALESCE(NULLIF(sl.quantity_in, 0), -sl.quantity_out) AS quantity,
               sl.reference_type AS reference,
               NULLIF(TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')), '') AS created_by_name
          FROM stock_ledger sl
          LEFT JOIN warehouses w ON w.id = sl.warehouse_id
          LEFT JOIN employees e ON e.id = sl.created_by
         WHERE sl.item_id = $1
           AND ($2::int IS NULL OR sl.company_id = $2 OR sl.company_id IS NULL)
         ORDER BY sl.transaction_date DESC, sl.id DESC LIMIT 100`, [itemId, cid]);
      push(rows);
    }

    // Chronological, so the trail reads the way the material actually travelled.
    movements.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));

    res.json({ scope, movements });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;

