// backend/src/modules/warehouse/scan.routes.js
//
// Scan-driven identification and movement — audit finding 32.
//
// ── WHAT WAS MISSING ────────────────────────────────────────────────────────
// The audit found the data architecture ready for scanning — every anchor has a
// stable id and `/genealogy/search` resolves most of them — but nothing a
// scanner could actually talk to. A handheld does not know whether the string it
// just read is a panel serial, a supplier lot, a bin code or a work order; it
// has one field and one barcode. Requiring the operator to choose the entity
// type first is precisely the friction that stops scanning being adopted.
//
// So `/scan/resolve` takes ONE opaque code and works out what it is.
//
// ── WHY NOT REUSE /genealogy/search ─────────────────────────────────────────
// That endpoint is built for a human typing a fragment: it does ILIKE prefix
// matching and returns a ranked list to choose from. A scanner needs the
// opposite — an EXACT match, and an unambiguous answer or an explicit refusal.
// A fuzzy match on a scanned code is how the wrong lot gets moved.
//
// Resolution is therefore exact-match only, and when a code matches more than
// one kind of entity the endpoint says so and returns the candidates rather than
// guessing a precedence order.
//
// ── SCANNING IS NOT MANDATORY ───────────────────────────────────────────────
// The brief is explicit that scanning must not be forced where the hardware
// workflow does not need it. Nothing here is required by any other path: these
// endpoints sit alongside the keyboard-driven ones and write exactly the same
// rows through the same guards. A shop that never buys a scanner loses nothing.

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf, employeeOf } from '../../shared/scope.js';
import { postStock } from '../production/subcontracting.routes.js';

const router = Router();
const actor = (req) => ({
  id: req.user?.userId || req.user?.id || null,
  name: req.user?.name || req.user?.email || 'System',
});

/**
 * GET /scan/resolve?code=<scanned string>
 *
 * Exact-match only. Returns { type, id, label, detail } for a single hit, or
 * 409 with the candidates when a code is ambiguous, or 404 when it is unknown.
 */
router.get('/resolve', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const code = String(req.query.code ?? '').trim();
    if (!code) return res.status(400).json({ error: 'code is required' });
    const cid = companyOf(req);

    // Each probe is exact, and each is scoped. A scanner that reads a code from
    // another tenant's label must not resolve it.
    const probes = await Promise.all([
      pool.query(`
        SELECT sn.id, sn.serial_number AS label, sn.status, i.item_code, i.item_name,
               sn.production_order_id, sn.package_id, sn.warehouse_id
          FROM serial_numbers sn LEFT JOIN inventory_items i ON i.id = sn.item_id
         WHERE sn.serial_number = $1 AND sn.deleted_at IS NULL
           AND ($2::int IS NULL OR sn.company_id = $2 OR sn.company_id IS NULL)`, [code, cid]),
      pool.query(`
        SELECT b.id, b.batch_number AS label, b.supplier_batch_no, b.quantity_available,
               b.status, b.warehouse_id, b.bin_id, i.item_code, i.item_name, b.item_id
          FROM inventory_batches b LEFT JOIN inventory_items i ON i.id = b.item_id
         WHERE (b.batch_number = $1 OR b.supplier_batch_no = $1) AND b.deleted_at IS NULL
           AND ($2::int IS NULL OR b.company_id = $2 OR b.company_id IS NULL)`, [code, cid]),
      pool.query(`
        SELECT wb.id, wb.bin_code AS label, wb.warehouse_id, w.name AS warehouse_name,
               wb.row_code, wb.shelf_code, wb.zone_id, wb.status
          FROM warehouse_bins wb LEFT JOIN warehouses w ON w.id = wb.warehouse_id
         WHERE wb.bin_code = $1
           AND ($2::int IS NULL OR wb.company_id = $2)`, [code, cid]),
      pool.query(`
        SELECT id, item_code AS label, item_name, manufacturer_part_no, current_stock, unit_of_measure
          FROM inventory_items
         WHERE (item_code = $1 OR manufacturer_part_no = $1) AND deleted_at IS NULL
           AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`, [code, cid]),
      pool.query(`
        SELECT id, production_order_no AS label, product_name, status, quantity_planned
          FROM production_orders
         WHERE production_order_no = $1
           AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`, [code, cid]),
      pool.query(`
        SELECT id, grn_number AS label, received_date, status, quality_status
          FROM goods_receipt_notes
         WHERE grn_number = $1 AND deleted_at IS NULL
           AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`, [code, cid]),
      pool.query(`
        SELECT id, warehouse_code AS label, name, warehouse_type, plant_id
          FROM warehouses
         WHERE warehouse_code = $1 AND deleted_at IS NULL
           AND ($2::int IS NULL OR company_id = $2)`, [code, cid]),
    ]);

    const kinds = ['serial', 'batch', 'bin', 'item', 'production_order', 'grn', 'warehouse'];
    const hits = [];
    probes.forEach((r, i) => r.rows.forEach(row =>
      hits.push({ type: kinds[i], id: row.id, label: row.label, detail: row })));

    if (!hits.length) {
      return res.status(404).json({
        error: `Nothing matches the scanned code "${code}"`,
        code: 'SCAN_UNKNOWN',
        scanned: code,
      });
    }
    if (hits.length > 1) {
      // Never guess. A silent precedence order is how the wrong lot gets moved.
      return res.status(409).json({
        error: `"${code}" matches ${hits.length} records. Choose which one was scanned.`,
        code: 'SCAN_AMBIGUOUS',
        scanned: code,
        candidates: hits.map(h => ({ type: h.type, id: h.id, label: h.label })),
      });
    }
    res.json({ scanned: code, ...hits[0] });
  } catch (e) { console.error('[scan/resolve]', e); res.status(500).json({ error: e.message }); }
});

/**
 * POST /scan/move
 *   { lot_code, to_bin_code, quantity?, reason? }
 *
 * The two-scan bin move: scan the lot, scan the destination bin. Writes the same
 * ledger row any other movement writes, through postStock, carrying the lot and
 * both bins — so a scanned move is indistinguishable downstream from a typed one
 * and appears in location history like everything else.
 */
router.post('/move', requirePermission('inventory', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id ?? null;
    const a = actor(req);
    const { lot_code, to_bin_code, quantity, reason } = req.body || {};
    if (!lot_code || !to_bin_code) {
      return res.status(400).json({ error: 'lot_code and to_bin_code are required' });
    }

    await client.query('BEGIN');

    const { rows: [lot] } = await client.query(`
      SELECT b.id, b.batch_number, b.item_id, b.warehouse_id, b.bin_id,
             b.quantity_available, b.status, b.rate
        FROM inventory_batches b
       WHERE (b.batch_number = $1 OR b.supplier_batch_no = $1) AND b.deleted_at IS NULL
         AND ($2::int IS NULL OR b.company_id = $2 OR b.company_id IS NULL)`, [lot_code, cid]);
    if (!lot) { await client.query('ROLLBACK'); return res.status(404).json({ error: `No lot matches "${lot_code}"` }); }

    // A lot held for quality does not get relocated by a scan without a reason —
    // moving quarantined stock is exactly what a quarantine is meant to prevent.
    if (['rejected', 'quarantine', 'hold', 'blocked'].includes(String(lot.status || '').toLowerCase())
        && !reason) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Lot ${lot.batch_number} is ${lot.status}. Moving it requires a stated reason.`,
        code: 'QC_BLOCKED_NEEDS_REASON',
      });
    }

    const { rows: [bin] } = await client.query(`
      SELECT wb.id, wb.bin_code, wb.warehouse_id, wb.status
        FROM warehouse_bins wb
       WHERE wb.bin_code = $1 AND ($2::int IS NULL OR wb.company_id = $2)`, [to_bin_code, cid]);
    if (!bin) { await client.query('ROLLBACK'); return res.status(404).json({ error: `No bin matches "${to_bin_code}"` }); }
    if (String(bin.status || 'active').toLowerCase() !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Bin ${bin.bin_code} is ${bin.status}`, code: 'BIN_INACTIVE' });
    }

    if (String(lot.bin_id ?? '') === String(bin.id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Lot ${lot.batch_number} is already in bin ${bin.bin_code}`,
        code: 'SCAN_NO_OP',
      });
    }

    const qty = Number(quantity) > 0 ? Number(quantity) : Number(lot.quantity_available || 0);
    const fromBin = lot.bin_id ?? null;

    await client.query(
      `UPDATE inventory_batches
          SET bin_id = $2, warehouse_id = COALESCE($3, warehouse_id), updated_at = NOW()
        WHERE id = $1`, [lot.id, bin.id, bin.warehouse_id]);

    const employeeId = await employeeOf(req, pool);

    // A bin move is a location change, not a quantity change: in and out are
    // both the moved quantity, so the balance is untouched while the route is
    // recorded. Writing only one side would silently alter stock on hand.
    await postStock(client, {
      itemId: lot.item_id,
      warehouseId: bin.warehouse_id ?? lot.warehouse_id,
      inQty: qty, outQty: qty,
      txnType: 'bin_transfer',
      refType: 'scan_move', refId: lot.id,
      rate: Number(lot.rate) || 0,
      remarks: reason || `Scanned move ${lot.batch_number} -> ${bin.bin_code}`,
      createdBy: employeeId, companyId: cid,
      batchId: lot.id,
      fromWarehouseId: lot.warehouse_id, toWarehouseId: bin.warehouse_id,
      fromBinId: fromBin, toBinId: bin.id,
      reasonCode: 'scan_bin_transfer',
    });

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      lot: { id: lot.id, batch_number: lot.batch_number },
      from_bin_id: fromBin,
      to_bin: { id: bin.id, bin_code: bin.bin_code, warehouse_id: bin.warehouse_id },
      quantity: qty,
      moved_by: a.name,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/**
 * GET /scan/bin/:binCode — what is physically in a bin.
 * The counterpart a stock-check actually needs: scan the bin, see the lots.
 */
router.get('/bin/:binCode', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows: [bin] } = await pool.query(`
      SELECT wb.id, wb.bin_code, wb.row_code, wb.shelf_code, wb.status,
             wb.warehouse_id, w.name AS warehouse_name, wz.name AS zone_name
        FROM warehouse_bins wb
        LEFT JOIN warehouses w ON w.id = wb.warehouse_id
        LEFT JOIN warehouse_zones wz ON wz.id = wb.zone_id
       WHERE wb.bin_code = $1 AND ($2::int IS NULL OR wb.company_id = $2)`,
      [req.params.binCode, cid]);
    if (!bin) return res.status(404).json({ error: `No bin matches "${req.params.binCode}"` });

    const { rows: lots } = await pool.query(`
      SELECT b.id, b.batch_number, b.supplier_batch_no, b.quantity_available, b.status,
             b.expiry_date, i.item_code, i.item_name, i.manufacturer_part_no
        FROM inventory_batches b
        LEFT JOIN inventory_items i ON i.id = b.item_id
       WHERE b.bin_id = $1 AND b.deleted_at IS NULL
       ORDER BY (b.expiry_date IS NULL), b.expiry_date, b.received_date`, [bin.id]);

    res.json({
      bin,
      lots,
      lot_count: lots.length,
      total_quantity: lots.reduce((t, l) => t + Number(l.quantity_available || 0), 0),
      blocked_lots: lots.filter(l =>
        ['rejected', 'quarantine', 'hold', 'blocked'].includes(String(l.status || '').toLowerCase())).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
