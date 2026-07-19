import express from 'express';
import pool from '../../shared/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';

const router = express.Router();

// ── GET /inventory/serials ────────────────────────────────────────────────────
router.get('/', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const { item_id, status, search, warehouse_id } = req.query;
    const companyId = req.scope?.company_id ?? null;
    const params = [];
    let q = `
      SELECT
        sn.*,
        ii.item_code, ii.item_name, ii.unit_of_measure,
        ii.manufacturer,
        w.warehouse_name,
        ib.batch_number
      FROM serial_numbers sn
      JOIN inventory_items ii ON ii.id = sn.item_id
      LEFT JOIN warehouses w  ON w.id  = sn.warehouse_id
      LEFT JOIN inventory_batches ib ON ib.id = sn.batch_id
      WHERE sn.deleted_at IS NULL
    `;
    if (companyId != null) { params.push(companyId);    q += ` AND sn.company_id = $${params.length}`; }
    if (item_id)           { params.push(item_id);      q += ` AND sn.item_id = $${params.length}`; }
    if (status)            { params.push(status);       q += ` AND sn.status = $${params.length}`; }
    if (warehouse_id)      { params.push(warehouse_id); q += ` AND sn.warehouse_id = $${params.length}`; }
    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      q += ` AND (sn.serial_number ILIKE $${p} OR ii.item_name ILIKE $${p} OR ii.item_code ILIKE $${p})`;
    }
    q += ' ORDER BY sn.created_at DESC LIMIT 200';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /inventory/serials/:id ────────────────────────────────────────────────
router.get('/:id', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const params = [req.params.id];
    let q = `
      SELECT sn.*, ii.item_code, ii.item_name, ii.unit_of_measure, ii.manufacturer,
             w.warehouse_name, ib.batch_number
      FROM serial_numbers sn
      JOIN inventory_items ii ON ii.id = sn.item_id
      LEFT JOIN warehouses w  ON w.id  = sn.warehouse_id
      LEFT JOIN inventory_batches ib ON ib.id = sn.batch_id
      WHERE sn.id = $1 AND sn.deleted_at IS NULL
    `;
    if (companyId != null) { params.push(companyId); q += ` AND sn.company_id = $${params.length}`; }
    const { rows: [serial] } = await pool.query(q, params);
    if (!serial) return res.status(404).json({ error: 'Serial number not found' });

    // Attach full event history
    const { rows: events } = await pool.query(
      `SELECT se.*, e.first_name || ' ' || e.last_name AS performed_by_name
       FROM serial_events se
       LEFT JOIN employees e ON e.id = se.performed_by
       WHERE se.serial_id = $1
       ORDER BY se.event_date DESC, se.created_at DESC`,
      [serial.id]
    );
    res.json({ ...serial, events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /inventory/serials ───────────────────────────────────────────────────
router.post('/', requirePermission('inventory', 'add'), async (req, res) => {
  const {
    serial_number, item_id, batch_id, warehouse_id,
    status = 'in_stock', current_location, manufactured_date,
    warranty_expiry, production_order_id, notes,
  } = req.body;

  if (!serial_number || !item_id) {
    return res.status(422).json({ error: 'serial_number and item_id are required' });
  }

  const companyId = req.scope?.company_id ?? null;
  try {
    const { rows: [sn] } = await pool.query(
      `INSERT INTO serial_numbers
         (serial_number, item_id, batch_id, company_id, warehouse_id,
          status, current_location, manufactured_date, warranty_expiry,
          production_order_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        serial_number, item_id, batch_id ?? null, companyId, warehouse_id ?? null,
        status, current_location ?? null, manufactured_date ?? null,
        warranty_expiry ?? null, production_order_id ?? null, notes ?? null,
      ]
    );

    // Log initial creation event
    await pool.query(
      `INSERT INTO serial_events (serial_id, event_type, event_date, description, performed_by)
       VALUES ($1, 'created', CURRENT_DATE, $2, $3)`,
      [sn.id, `Serial ${serial_number} created — status: ${status}`, req.user?.userId ?? null]
    );

    logAudit({ userId: req.user?.userId, module: 'inventory', recordId: sn.id, recordType: 'serial_number', action: 'create', newData: sn, req });
    res.status(201).json(sn);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: `Serial number '${serial_number}' already exists for this item` });
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /inventory/serials/:id ────────────────────────────────────────────────
router.put('/:id', requirePermission('inventory', 'edit'), async (req, res) => {
  const {
    status, current_location, warehouse_id, batch_id,
    manufactured_date, warranty_expiry, notes,
  } = req.body;

  const companyId = req.scope?.company_id ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify ownership
    const params = [req.params.id];
    let checkQ = 'SELECT * FROM serial_numbers WHERE id = $1 AND deleted_at IS NULL';
    if (companyId != null) { params.push(companyId); checkQ += ` AND company_id = $${params.length}`; }
    const { rows: [old] } = await client.query(checkQ, params);
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Serial number not found' }); }

    const { rows: [sn] } = await client.query(
      `UPDATE serial_numbers
       SET status            = COALESCE($1, status),
           current_location  = COALESCE($2, current_location),
           warehouse_id      = COALESCE($3, warehouse_id),
           batch_id          = COALESCE($4, batch_id),
           manufactured_date = COALESCE($5, manufactured_date),
           warranty_expiry   = COALESCE($6, warranty_expiry),
           notes             = COALESCE($7, notes),
           updated_at        = NOW()
       WHERE id = $8
       RETURNING *`,
      [status ?? null, current_location ?? null, warehouse_id ?? null,
       batch_id ?? null, manufactured_date ?? null, warranty_expiry ?? null,
       notes ?? null, req.params.id]
    );

    // Record status change event if status changed
    if (status && status !== old.status) {
      await client.query(
        `INSERT INTO serial_events (serial_id, event_type, event_date, description, performed_by)
         VALUES ($1, 'status_change', CURRENT_DATE, $2, $3)`,
        [sn.id, `Status changed: ${old.status} → ${status}`, req.user?.userId ?? null]
      );
    }

    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId, module: 'inventory', recordId: sn.id, recordType: 'serial_number', action: 'update', oldData: old, newData: sn, req });
    res.json(sn);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /inventory/serials/:id/events ───────────────────────────────────────
router.post('/:id/events', requirePermission('inventory', 'add'), async (req, res) => {
  const { event_type, event_date, description, reference_type, reference_id } = req.body;
  if (!event_type) return res.status(422).json({ error: 'event_type is required' });

  try {
    const { rows: [serial] } = await pool.query(
      'SELECT id FROM serial_numbers WHERE id=$1 AND deleted_at IS NULL', [req.params.id]
    );
    if (!serial) return res.status(404).json({ error: 'Serial not found' });

    const { rows: [ev] } = await pool.query(
      `INSERT INTO serial_events
         (serial_id, event_type, event_date, description, performed_by, reference_type, reference_id)
       VALUES ($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7)
       RETURNING *`,
      [req.params.id, event_type, event_date ?? null, description ?? null,
       req.user?.userId ?? null, reference_type ?? null, reference_id ?? null]
    );
    res.status(201).json(ev);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /inventory/serials/:id (soft delete) ───────────────────────────────
router.delete('/:id', requirePermission('inventory', 'delete'), async (req, res) => {
  const companyId = req.scope?.company_id ?? null;
  try {
    const params = [req.params.id];
    let q = 'UPDATE serial_numbers SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL';
    if (companyId != null) { params.push(companyId); q += ` AND company_id = $${params.length}`; }
    q += ' RETURNING id';
    const { rows } = await pool.query(q, params);
    if (!rows.length) return res.status(404).json({ error: 'Serial not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /inventory/serials/stats/summary ─────────────────────────────────────
router.get('/stats/summary', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const params = [];
    let whereClause = 'WHERE sn.deleted_at IS NULL';
    if (companyId != null) { params.push(companyId); whereClause += ` AND sn.company_id = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE sn.status = 'in_stock')    AS in_stock,
         COUNT(*) FILTER (WHERE sn.status = 'dispatched')  AS dispatched,
         COUNT(*) FILTER (WHERE sn.status = 'in_service')  AS in_service,
         COUNT(*) FILTER (WHERE sn.status = 'returned')    AS returned,
         COUNT(*) FILTER (WHERE sn.status = 'scrapped')    AS scrapped,
         COUNT(*) FILTER (WHERE sn.warranty_expiry < CURRENT_DATE AND sn.status != 'scrapped') AS warranty_expired,
         COUNT(*) FILTER (WHERE sn.warranty_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 AND sn.status != 'scrapped') AS warranty_expiring_30d
       FROM serial_numbers sn
       ${whereClause}`,
      params
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
