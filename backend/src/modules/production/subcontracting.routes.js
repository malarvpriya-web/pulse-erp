// backend/src/modules/production/subcontracting.routes.js
//
// Subcontracting / job-work API. A subcontract order issues component materials
// to a vendor (stock OUT) and receives back the finished/semi-finished item
// (stock IN, valued at material + service cost). Integrates with stock_ledger
// and inventory_items.current_stock.

import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = Router();
const actor = (req) => ({ id: req.user?.userId || req.user?.id || null, name: req.user?.name || req.user?.email || 'System' });
const cidOf = (req) => (req.scope?.company_id != null ? req.scope.company_id : null);
const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v)) || 0;

/** Post a stock movement to the ledger and keep inventory_items.current_stock in sync. */
export async function postStock(client, { itemId, warehouseId = null, inQty = 0, outQty = 0, txnType, refType, refId, remarks, rate = 0, createdBy, companyId }) {
  if (!itemId) return;
  const { rows: [bal] } = await client.query(
    `SELECT COALESCE(SUM(quantity_in - quantity_out),0) AS balance
       FROM stock_ledger WHERE item_id = $1 AND ($2::int IS NULL OR warehouse_id = $2)`,
    [itemId, warehouseId]);
  const newBalance = num(bal.balance) + inQty - outQty;
  await client.query(
    `INSERT INTO stock_ledger
       (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, balance_qty,
        rate, value, reference_type, reference_id, transaction_date, remarks, created_by, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_DATE,$11,$12,$13)`,
    [itemId, warehouseId, txnType, inQty, outQty, newBalance, rate,
     Math.round((inQty + outQty) * rate * 100) / 100, refType, refId, remarks, createdBy, companyId]);
  await client.query(
    `UPDATE inventory_items SET current_stock = COALESCE(current_stock,0) + $2, updated_at = NOW() WHERE id = $1`,
    [itemId, inQty - outQty]);
}

// ─────────────────────────────────────────────────────────────────────────────
router.get('/vendors', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows } = await pool.query(
      `SELECT id, COALESCE(name, vendor_name) AS vendor_name, vendor_code, lead_time_days
         FROM vendors WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
          AND deleted_at IS NULL AND LOWER(COALESCE(status,'active')) <> 'inactive'
        ORDER BY COALESCE(name, vendor_name)`, [cid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/dashboard', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { rows: [k] } = await pool.query(`
      SELECT COUNT(*)::int total,
             COUNT(*) FILTER (WHERE status IN ('draft','issued'))::int open,
             COUNT(*) FILTER (WHERE status = 'materials_issued')::int at_vendor,
             COUNT(*) FILTER (WHERE status IN ('received','closed'))::int completed,
             COALESCE(SUM((quantity_ordered - quantity_received) *
               (COALESCE(service_charge_per_unit,0) + COALESCE(material_cost_per_unit,0)))
               FILTER (WHERE status NOT IN ('closed','cancelled','received')),0) AS open_value
        FROM subcontract_orders
       WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)`, [cid]);
    res.json(k);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders', requirePermission('production', 'view'), async (req, res) => {
  try {
    const cid = cidOf(req);
    const { status } = req.query;
    const vals = [cid], where = [`($1::int IS NULL OR company_id = $1 OR company_id IS NULL)`];
    if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
    const { rows } = await pool.query(
      `SELECT * FROM subcontract_orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders/:id', requirePermission('production', 'view'), async (req, res) => {
  try {
    const [o, m, t] = await Promise.all([
      pool.query(`SELECT * FROM subcontract_orders WHERE id = $1`, [req.params.id]),
      pool.query(`SELECT * FROM subcontract_materials WHERE sc_id = $1 ORDER BY id`, [req.params.id]),
      pool.query(`SELECT * FROM subcontract_transactions WHERE sc_id = $1 ORDER BY created_at DESC`, [req.params.id]),
    ]);
    if (!o.rows[0]) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: o.rows[0], materials: m.rows, transactions: t.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/orders', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = actor(req); const cid = cidOf(req);
    const {
      vendor_id, production_order_id, item_id, item_name, uom,
      quantity_ordered, service_charge_per_unit = 0, expected_date, warehouse_id, notes,
      materials = [],
    } = req.body || {};
    if (!item_name || !quantity_ordered) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'item_name and quantity_ordered required' }); }

    let vendorName = null;
    if (vendor_id) {
      const { rows } = await client.query(`SELECT COALESCE(name, vendor_name) AS n FROM vendors WHERE id = $1`, [vendor_id]);
      vendorName = rows[0]?.n || null;
    }
    const qtyOrd = num(quantity_ordered);
    const materialCostPerUnit = materials.reduce((s, m) => s + num(m.qty_per_unit) * num(m.unit_cost), 0);

    const { rows: [ord] } = await client.query(`
      INSERT INTO subcontract_orders
        (company_id, vendor_id, vendor_name, production_order_id, item_id, item_name, uom,
         quantity_ordered, service_charge_per_unit, material_cost_per_unit, status, expected_date,
         warehouse_id, notes, created_by, created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11,$12,$13,$14,$15) RETURNING *`,
      [cid, vendor_id || null, vendorName, production_order_id || null, item_id || null, item_name, uom || null,
       qtyOrd, num(service_charge_per_unit), Math.round(materialCostPerUnit * 100) / 100, expected_date || null,
       warehouse_id || null, notes || null, a.id, a.name]);

    await client.query(`UPDATE subcontract_orders SET sc_number = $2 WHERE id = $1`,
      [ord.id, `SC-${String(ord.id).padStart(5, '0')}`]);

    for (const m of materials) {
      await client.query(`
        INSERT INTO subcontract_materials (sc_id, company_id, item_id, item_name, uom, qty_per_unit, qty_required, unit_cost)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ord.id, cid, m.item_id || null, m.item_name, m.uom || null, num(m.qty_per_unit),
         Math.round(num(m.qty_per_unit) * qtyOrd * 1000) / 1000, num(m.unit_cost)]);
    }

    await client.query('COMMIT');
    const { rows: [full] } = await pool.query(`SELECT * FROM subcontract_orders WHERE id = $1`, [ord.id]);
    res.status(201).json(full);
  } catch (e) { await client.query('ROLLBACK'); console.error('[sc/create]', e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

router.put('/orders/:id', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const f = req.body || {};
    const { rows: [existing] } = await pool.query(`SELECT status FROM subcontract_orders WHERE id = $1`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (!['draft', 'issued'].includes(existing.status)) return res.status(409).json({ error: `Cannot edit a ${existing.status} order` });
    const { rows: [row] } = await pool.query(`
      UPDATE subcontract_orders SET
        vendor_id = COALESCE($2, vendor_id), expected_date = COALESCE($3, expected_date),
        service_charge_per_unit = COALESCE($4, service_charge_per_unit),
        notes = COALESCE($5, notes), warehouse_id = COALESCE($6, warehouse_id), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
      [req.params.id, f.vendor_id, f.expected_date, f.service_charge_per_unit, f.notes, f.warehouse_id]);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Issue component materials to the vendor (stock OUT). */
router.post('/orders/:id/issue', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = actor(req);
    const { challan_no, remarks } = req.body || {};
    const { rows: [ord] } = await client.query(`SELECT * FROM subcontract_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!ord) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (['received', 'closed', 'cancelled'].includes(ord.status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Cannot issue on a ${ord.status} order` }); }

    const { rows: mats } = await client.query(`SELECT * FROM subcontract_materials WHERE sc_id = $1 FOR UPDATE`, [ord.id]);
    let issuedCount = 0;
    for (const m of mats) {
      const toIssue = num(m.qty_required) - num(m.qty_issued);
      if (toIssue <= 0 || !m.item_id) continue;
      await postStock(client, {
        itemId: m.item_id, warehouseId: ord.warehouse_id, outQty: toIssue, txnType: 'sc_issue',
        refType: 'subcontract', refId: ord.id, rate: num(m.unit_cost),
        remarks: `SC issue ${ord.sc_number} → ${ord.vendor_name || 'vendor'}`, createdBy: a.id, companyId: ord.company_id,
      });
      await client.query(`UPDATE subcontract_materials SET qty_issued = qty_required WHERE id = $1`, [m.id]);
      await client.query(`
        INSERT INTO subcontract_transactions (sc_id, company_id, txn_type, item_id, item_name, quantity, rate, challan_no, remarks, created_by, created_by_name)
        VALUES ($1,$2,'material_issue',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ord.id, ord.company_id, m.item_id, m.item_name, toIssue, num(m.unit_cost), challan_no || null, remarks || null, a.id, a.name]);
      issuedCount++;
    }
    await client.query(`UPDATE subcontract_orders SET status = 'materials_issued', updated_at = NOW() WHERE id = $1`, [ord.id]);
    await client.query('COMMIT');
    res.json({ ok: true, materials_issued: issuedCount });
  } catch (e) { await client.query('ROLLBACK'); console.error('[sc/issue]', e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

/* Receive finished/semi-finished goods from the vendor (stock IN). */
router.post('/orders/:id/receive', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = actor(req);
    const { quantity, challan_no, remarks, rate } = req.body || {};
    const qty = num(quantity);
    if (qty <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'quantity must be > 0' }); }
    const { rows: [ord] } = await client.query(`SELECT * FROM subcontract_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!ord) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (['cancelled', 'closed'].includes(ord.status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Cannot receive on a ${ord.status} order` }); }
    const remaining = num(ord.quantity_ordered) - num(ord.quantity_received);
    if (qty > remaining + 1e-6) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Only ${remaining} remaining to receive` }); }

    const unitValue = rate != null ? num(rate) : (num(ord.service_charge_per_unit) + num(ord.material_cost_per_unit));
    if (ord.item_id) {
      await postStock(client, {
        itemId: ord.item_id, warehouseId: ord.warehouse_id, inQty: qty, txnType: 'sc_receipt',
        refType: 'subcontract', refId: ord.id, rate: unitValue,
        remarks: `SC receipt ${ord.sc_number} from ${ord.vendor_name || 'vendor'}`, createdBy: a.id, companyId: ord.company_id,
      });
    }
    await client.query(`
      INSERT INTO subcontract_transactions (sc_id, company_id, txn_type, item_id, item_name, quantity, rate, challan_no, remarks, created_by, created_by_name)
      VALUES ($1,$2,'finished_receipt',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ord.id, ord.company_id, ord.item_id, ord.item_name, qty, unitValue, challan_no || null, remarks || null, a.id, a.name]);

    const newReceived = num(ord.quantity_received) + qty;
    const newStatus = newReceived >= num(ord.quantity_ordered) - 1e-6 ? 'received' : 'partially_received';
    const { rows: [updated] } = await client.query(
      `UPDATE subcontract_orders SET quantity_received = $2, status = $3, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [ord.id, newReceived, newStatus]);
    await client.query('COMMIT');
    res.json({ order: updated, received: qty, unit_value: unitValue });
  } catch (e) { await client.query('ROLLBACK'); console.error('[sc/receive]', e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

router.post('/orders/:id/close', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE subcontract_orders SET status='closed', updated_at=NOW() WHERE id=$1 AND status IN ('received','partially_received') RETURNING *`,
      [req.params.id]);
    if (!row) return res.status(409).json({ error: 'Order must be received before closing' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/orders/:id/cancel', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE subcontract_orders SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status IN ('draft','issued') RETURNING *`,
      [req.params.id]);
    if (!row) return res.status(409).json({ error: 'Only draft/issued orders can be cancelled (materials not yet issued)' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/orders/:id', requirePermission('production', 'edit'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM subcontract_orders WHERE id=$1 AND status='draft'`, [req.params.id]);
    if (!rowCount) return res.status(409).json({ error: 'Only draft orders can be deleted' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
