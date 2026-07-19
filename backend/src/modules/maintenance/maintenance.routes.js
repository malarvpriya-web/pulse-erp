// backend/src/modules/maintenance/maintenance.routes.js
import { Router } from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';

const router = Router();
const cid = (req) => req.scope?.company_id ?? null;

// ── helper: record spare parts movement ─────────────────────────────────────
async function recordMovement(client, { part_id, type, qty, stockBefore, stockAfter, ref_type, ref_id, unit_cost, remarks, done_by, company_id }) {
  await client.query(
    `INSERT INTO spare_parts_movements
       (part_id, movement_type, quantity, reference_type, reference_id, unit_cost, total_cost, stock_before, stock_after, remarks, done_by, company_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [part_id, type, qty, ref_type || null, ref_id || null, unit_cost || 0, (qty * (unit_cost || 0)), stockBefore, stockAfter, remarks || null, done_by || null, company_id || null]
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSETS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/assets', requirePermission('maintenance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, category, search } = req.query;
    let q = `
      SELECT a.*,
        (SELECT next_due_date FROM maintenance_schedules WHERE asset_id=a.id AND (company_id=$1 OR $1 IS NULL)
         ORDER BY next_due_date ASC LIMIT 1) AS next_maintenance,
        (SELECT COUNT(*) FROM maintenance_logs WHERE asset_id=a.id AND log_type='breakdown'
         AND created_at >= NOW()-INTERVAL '12 months' AND (company_id=$1 OR $1 IS NULL)) AS breakdowns_12m
      FROM assets_register a WHERE ($1::int IS NULL OR a.company_id=$1)
    `;
    const params = [companyId];
    if (status)   { params.push(status);          q += ` AND a.status=$${params.length}`; }
    if (category) { params.push(category);         q += ` AND a.category=$${params.length}`; }
    if (search)   { params.push(`%${search}%`);   q += ` AND (a.name ILIKE $${params.length} OR a.asset_code ILIKE $${params.length} OR a.serial_number ILIKE $${params.length})`; }
    q += ' ORDER BY a.asset_code';
    res.json((await pool.query(q, params)).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/assets', requirePermission('maintenance', 'add'), async (req, res) => {
  try {
    const { asset_code, name, category, location, department, purchase_date,
            purchase_cost, current_value, manufacturer, model, serial_number,
            warranty_expiry, notes } = req.body;
    if (!name) return res.status(422).json({ error: 'Asset name is required' });
    const companyId = cid(req);
    const { rows } = await pool.query(
      `INSERT INTO assets_register
         (asset_code, name, category, location, department, purchase_date, purchase_cost,
          current_value, manufacturer, model, serial_number, warranty_expiry, notes, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [asset_code, name, category||null, location||null, department||null, purchase_date||null,
       purchase_cost||0, current_value||purchase_cost||0, manufacturer||null, model||null,
       serial_number||null, warranty_expiry||null, notes||null, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'maintenance', recordId: rows[0].id, recordType: 'asset', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/assets/:id', requirePermission('maintenance', 'edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { asset_code, name, category, location, department, purchase_date,
            purchase_cost, current_value, manufacturer, model, serial_number,
            warranty_expiry, notes, status } = req.body;
    const { rows: old } = await pool.query(
      `SELECT * FROM assets_register WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!old[0]) return res.status(404).json({ error: 'Asset not found' });
    const { rows } = await pool.query(
      `UPDATE assets_register
       SET asset_code=$1, name=$2, category=$3, location=$4, department=$5, purchase_date=$6,
           purchase_cost=$7, current_value=$8, manufacturer=$9, model=$10, serial_number=$11,
           warranty_expiry=$12, notes=$13, status=COALESCE($14, status)
       WHERE id=$15 AND ($16::int IS NULL OR company_id=$16) RETURNING *`,
      [asset_code||old[0].asset_code, name||old[0].name, category||old[0].category,
       location||old[0].location, department||old[0].department, purchase_date||old[0].purchase_date,
       purchase_cost||old[0].purchase_cost, current_value||old[0].current_value,
       manufacturer||old[0].manufacturer, model||old[0].model, serial_number||old[0].serial_number,
       warranty_expiry||old[0].warranty_expiry, notes||old[0].notes, status||null,
       req.params.id, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'maintenance', recordId: req.params.id, recordType: 'asset', action: 'update', oldData: old[0], newData: rows[0], req });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/assets/:id', requirePermission('maintenance', 'delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT id FROM assets_register WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Asset not found' });
    await pool.query(`UPDATE assets_register SET status='decommissioned' WHERE id=$1`, [req.params.id]);
    logAudit({ userId: req.user?.userId, module: 'maintenance', recordId: req.params.id, recordType: 'asset', action: 'delete', req });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MAINTENANCE SCHEDULES
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/schedule', requirePermission('maintenance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { asset_id, days = 30 } = req.query;
    let q = `
      SELECT s.*, a.name AS asset_name, a.asset_code, a.category, a.location
      FROM maintenance_schedules s
      JOIN assets_register a ON a.id = s.asset_id
      WHERE ($1::int IS NULL OR s.company_id = $1) AND (s.is_active IS NULL OR s.is_active = TRUE)
    `;
    const params = [companyId];
    if (asset_id) { params.push(asset_id); q += ` AND s.asset_id = $${params.length}`; }
    else { params.push(parseInt(days)); q += ` AND s.next_due_date <= NOW() + ($${params.length} || ' days')::INTERVAL`; }
    q += ' ORDER BY s.next_due_date ASC';

    const now = new Date();
    const { rows } = await pool.query(q, params);
    res.json(rows.map(r => ({
      ...r,
      overdue: r.next_due_date && new Date(r.next_due_date) < now,
      days_until: r.next_due_date ? Math.ceil((new Date(r.next_due_date) - now) / 86400000) : null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/schedule', requirePermission('maintenance', 'add'), async (req, res) => {
  try {
    const { asset_id, maintenance_type, frequency_days, next_due_date,
            assigned_to, checklist_items, standard_ref } = req.body;
    if (!asset_id || !maintenance_type) return res.status(422).json({ error: 'asset_id and maintenance_type are required' });
    const companyId = cid(req);
    const { rows } = await pool.query(
      `INSERT INTO maintenance_schedules
         (asset_id, maintenance_type, frequency_days, next_due_date, assigned_to, checklist_items, standard_ref, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [asset_id, maintenance_type, frequency_days||90, next_due_date,
       assigned_to||null, JSON.stringify(checklist_items||[]), standard_ref||null, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'maintenance', recordId: rows[0].id, recordType: 'schedule', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/schedule/:id', requirePermission('maintenance', 'edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { maintenance_type, frequency_days, next_due_date, assigned_to, checklist_items, standard_ref, is_active } = req.body;
    const { rows: old } = await pool.query(
      `SELECT * FROM maintenance_schedules WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!old[0]) return res.status(404).json({ error: 'Schedule not found' });
    const { rows } = await pool.query(
      `UPDATE maintenance_schedules
       SET maintenance_type=$1, frequency_days=$2, next_due_date=$3, assigned_to=$4,
           checklist_items=$5, standard_ref=$6, is_active=$7
       WHERE id=$8 AND ($9::int IS NULL OR company_id=$9) RETURNING *`,
      [maintenance_type||old[0].maintenance_type, frequency_days||old[0].frequency_days,
       next_due_date||old[0].next_due_date, assigned_to??old[0].assigned_to,
       JSON.stringify(checklist_items||old[0].checklist_items||[]), standard_ref??old[0].standard_ref,
       is_active !== undefined ? is_active : old[0].is_active,
       req.params.id, companyId]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/schedule/:id', requirePermission('maintenance', 'delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT id FROM maintenance_schedules WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Schedule not found' });
    await pool.query(`UPDATE maintenance_schedules SET is_active=FALSE WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MAINTENANCE LOGS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/logs', requirePermission('maintenance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { asset_id, status, log_type, date_from, date_to, page = 1, limit = 50 } = req.query;
    const lim = Math.min(200, parseInt(limit));
    const off = (Math.max(1, parseInt(page)) - 1) * lim;
    let q = `
      SELECT l.*, a.name AS asset_name, a.asset_code, a.category
      FROM maintenance_logs l
      JOIN assets_register a ON a.id = l.asset_id
      WHERE ($1::int IS NULL OR l.company_id = $1)
    `;
    const params = [companyId];
    if (asset_id)  { params.push(asset_id);  q += ` AND l.asset_id=$${params.length}`; }
    if (status)    { params.push(status);    q += ` AND l.status=$${params.length}`; }
    if (log_type)  { params.push(log_type);  q += ` AND l.log_type=$${params.length}`; }
    if (date_from) { params.push(date_from); q += ` AND l.created_at >= $${params.length}`; }
    if (date_to)   { params.push(date_to);   q += ` AND l.created_at <= $${params.length}::date + INTERVAL '1 day'`; }
    params.push(lim, off);
    q += ` ORDER BY l.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`;
    res.json((await pool.query(q, params)).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/logs', requirePermission('maintenance', 'add'), async (req, res) => {
  try {
    const { asset_id, schedule_id, log_type, description, done_by,
            start_time, parts_used, cost, priority, ticket_id, root_cause, failure_mode } = req.body;
    if (!asset_id || !log_type) return res.status(422).json({ error: 'asset_id and log_type are required' });
    const companyId = cid(req);
    const { rows } = await pool.query(
      `INSERT INTO maintenance_logs
         (asset_id, schedule_id, log_type, description, done_by, start_time, parts_used, cost, status,
          priority, ticket_id, root_cause, failure_mode, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13) RETURNING *`,
      [asset_id, schedule_id||null, log_type, description||null, done_by||null,
       start_time||new Date(), JSON.stringify(parts_used||[]), cost||0,
       priority||'Medium', ticket_id||null, root_cause||null, failure_mode||null, companyId]
    );
    if (log_type === 'breakdown') {
      await pool.query(`UPDATE assets_register SET status='under-maintenance' WHERE id=$1`, [asset_id]);
    }
    logAudit({ userId: req.user?.userId, module: 'maintenance', recordId: rows[0].id, recordType: 'maintenance_log', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/logs/:id', requirePermission('maintenance', 'edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { description, done_by, priority, ticket_id, root_cause, failure_mode, resolution_notes, corrective_action, preventive_action } = req.body;
    const { rows: old } = await pool.query(
      `SELECT * FROM maintenance_logs l
       JOIN assets_register a ON a.id = l.asset_id
       WHERE l.id=$1 AND ($2::int IS NULL OR l.company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!old[0]) return res.status(404).json({ error: 'Log not found' });
    const { rows } = await pool.query(
      `UPDATE maintenance_logs
       SET description=COALESCE($1,description), done_by=COALESCE($2,done_by),
           priority=COALESCE($3,priority), ticket_id=COALESCE($4,ticket_id),
           root_cause=COALESCE($5,root_cause), failure_mode=COALESCE($6,failure_mode),
           resolution_notes=COALESCE($7,resolution_notes), corrective_action=COALESCE($8,corrective_action),
           preventive_action=COALESCE($9,preventive_action), updated_at=NOW()
       WHERE id=$10 AND ($11::int IS NULL OR company_id=$11) RETURNING *`,
      [description||null, done_by||null, priority||null, ticket_id||null,
       root_cause||null, failure_mode||null, resolution_notes||null, corrective_action||null,
       preventive_action||null, req.params.id, companyId]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/logs/:id/complete', requirePermission('maintenance', 'edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { end_time, parts_used, cost, notes, resolution_notes, root_cause, failure_mode, corrective_action } = req.body;

    // IDOR check: verify log belongs to this company
    const { rows: [log] } = await pool.query(
      `SELECT l.*, a.company_id AS asset_company_id FROM maintenance_logs l
       JOIN assets_register a ON a.id = l.asset_id
       WHERE l.id=$1`,
      [req.params.id]
    );
    if (!log) return res.status(404).json({ error: 'Log not found' });
    if (companyId !== null && log.company_id !== null && log.company_id !== companyId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const endT       = end_time ? new Date(end_time) : new Date();
    const startT     = log.start_time ? new Date(log.start_time) : new Date();
    const downtimeHrs = parseFloat(((endT - startT) / 3600000).toFixed(2));

    const { rows } = await pool.query(
      `UPDATE maintenance_logs
       SET end_time=$1, downtime_hrs=$2, parts_used=$3, cost=$4, status='completed',
           notes=COALESCE($5,notes), resolution_notes=COALESCE($6,resolution_notes),
           root_cause=COALESCE($7,root_cause), failure_mode=COALESCE($8,failure_mode),
           corrective_action=COALESCE($9,corrective_action), updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [endT, downtimeHrs, JSON.stringify(parts_used||log.parts_used||[]),
       cost ?? log.cost, notes||null, resolution_notes||null, root_cause||null,
       failure_mode||null, corrective_action||null, req.params.id]
    );

    await pool.query(`UPDATE assets_register SET status='active' WHERE id=$1`, [log.asset_id]);

    if (log.schedule_id) {
      const { rows: [sched] } = await pool.query(`SELECT * FROM maintenance_schedules WHERE id=$1`, [log.schedule_id]);
      if (sched) {
        const nextDue = new Date();
        nextDue.setDate(nextDue.getDate() + (sched.frequency_days||90));
        await pool.query(
          `UPDATE maintenance_schedules SET last_done_date=NOW(), next_due_date=$1 WHERE id=$2`,
          [nextDue.toISOString().split('T')[0], log.schedule_id]
        );
      }
    }

    logAudit({ userId: req.user?.userId, module: 'maintenance', recordId: req.params.id, recordType: 'maintenance_log', action: 'complete', newData: rows[0], req });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPARE PARTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/spare-parts', requirePermission('maintenance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { search, low_stock_only, category } = req.query;
    let q = `SELECT * FROM spare_parts WHERE ($1::int IS NULL OR company_id = $1)`;
    const params = [companyId];
    if (search)        { params.push(`%${search}%`); q += ` AND (name ILIKE $${params.length} OR part_number ILIKE $${params.length})`; }
    if (category)      { params.push(category); q += ` AND category = $${params.length}`; }
    q += ' ORDER BY name';
    const rows = (await pool.query(q, params)).rows.map(r => ({
      ...r,
      stock_quantity: r.stock_qty,
      low_stock: parseFloat(r.stock_qty) <= parseFloat(r.reorder_level || r.min_level || 0),
    }));
    res.json(low_stock_only === 'true' ? rows.filter(r => r.low_stock) : rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/spare-parts', requirePermission('maintenance', 'add'), async (req, res) => {
  try {
    const { name, category, unit, unit_cost, reorder_level,
            part_number, supplier_name, location, barcode, hsn_code, lead_time_days, min_level, max_level } = req.body;
    const openingStock = parseFloat(req.body.stock_quantity ?? req.body.stock_qty ?? 0);
    if (!name) return res.status(422).json({ error: 'Part name is required' });
    const companyId = cid(req);
    const { rows } = await pool.query(
      `INSERT INTO spare_parts
         (name, category, unit, unit_cost, stock_qty, reorder_level, part_number,
          supplier_name, location, barcode, hsn_code, lead_time_days, min_level, max_level, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [name, category||null, unit||'Nos', unit_cost||0, openingStock, reorder_level||0,
       part_number||null, supplier_name||null, location||null, barcode||null, hsn_code||null,
       lead_time_days||7, min_level||0, max_level||0, companyId]
    );
    // Record opening stock movement
    if (openingStock > 0) {
      await recordMovement(pool, { part_id: rows[0].id, type: 'opening', qty: openingStock,
        stockBefore: 0, stockAfter: openingStock, unit_cost: parseFloat(unit_cost)||0,
        remarks: 'Opening stock', company_id: companyId });
    }
    logAudit({ userId: req.user?.userId, module: 'maintenance', recordId: rows[0].id, recordType: 'spare_part', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/spare-parts/:id', requirePermission('maintenance', 'edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, category, unit, unit_cost, reorder_level, part_number,
            supplier_name, location, barcode, hsn_code, lead_time_days, min_level, max_level } = req.body;
    const { rows: old } = await pool.query(
      `SELECT * FROM spare_parts WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!old[0]) return res.status(404).json({ error: 'Part not found' });
    const { rows } = await pool.query(
      `UPDATE spare_parts
       SET name=$1, category=$2, unit=$3, unit_cost=$4, reorder_level=$5, part_number=$6,
           supplier_name=$7, location=$8, barcode=$9, hsn_code=$10, lead_time_days=$11,
           min_level=$12, max_level=$13, updated_at=NOW()
       WHERE id=$14 AND ($15::int IS NULL OR company_id=$15) RETURNING *`,
      [name||old[0].name, category??old[0].category, unit||old[0].unit, unit_cost??old[0].unit_cost,
       reorder_level??old[0].reorder_level, part_number??old[0].part_number,
       supplier_name??old[0].supplier_name, location??old[0].location, barcode??old[0].barcode,
       hsn_code??old[0].hsn_code, lead_time_days??old[0].lead_time_days,
       min_level??old[0].min_level, max_level??old[0].max_level, req.params.id, companyId]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stock receive
router.post('/spare-parts/receive', requirePermission('maintenance', 'add'), async (req, res) => {
  try {
    const { part_id, unit_cost, remarks, supplier_name, po_number } = req.body;
    const qty = req.body.qty ?? req.body.quantity;
    if (!part_id || !qty || parseFloat(qty) <= 0) return res.status(422).json({ error: 'part_id and quantity > 0 are required' });
    const companyId = cid(req);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [part] } = await client.query(
        `SELECT * FROM spare_parts WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) FOR UPDATE`,
        [part_id, companyId]
      );
      if (!part) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Part not found' }); }

      const stockBefore = parseFloat(part.stock_qty);
      const stockAfter  = stockBefore + parseFloat(qty);

      await client.query(`UPDATE spare_parts SET stock_qty=$1, updated_at=NOW() WHERE id=$2`, [stockAfter, part_id]);
      await recordMovement(client, {
        part_id, type: 'receipt', qty: parseFloat(qty), stockBefore, stockAfter,
        unit_cost: parseFloat(unit_cost)||0,
        remarks: remarks || (po_number ? `PO: ${po_number}` : `Received from ${supplier_name||'supplier'}`),
        done_by: req.user?.name || req.user?.email, company_id: companyId
      });

      await client.query('COMMIT');
      logAudit({ userId: req.user?.userId, module: 'maintenance', recordId: part_id, recordType: 'spare_part', action: 'receipt', newData: { part_id, qty, stockAfter }, req });
      res.json({ success: true, part_id, qty_received: parseFloat(qty), new_stock: stockAfter });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stock adjustment
router.post('/spare-parts/adjust', requirePermission('maintenance', 'edit'), async (req, res) => {
  try {
    const { part_id, remarks } = req.body;
    const new_qty = req.body.new_qty ?? req.body.quantity;
    if (part_id == null || new_qty == null) return res.status(422).json({ error: 'part_id and quantity required' });
    const companyId = cid(req);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [part] } = await client.query(
        `SELECT * FROM spare_parts WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) FOR UPDATE`,
        [part_id, companyId]
      );
      if (!part) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Part not found' }); }

      const stockBefore = parseFloat(part.stock_qty);
      const stockAfter  = parseFloat(new_qty);
      const diff        = stockAfter - stockBefore;

      await client.query(`UPDATE spare_parts SET stock_qty=$1, updated_at=NOW() WHERE id=$2`, [stockAfter, part_id]);
      await recordMovement(client, {
        part_id, type: 'adjustment', qty: Math.abs(diff), stockBefore, stockAfter,
        remarks: remarks || `Manual adjustment: ${stockBefore} → ${stockAfter}`,
        done_by: req.user?.name || req.user?.email, company_id: companyId
      });

      await client.query('COMMIT');
      res.json({ success: true, old_stock: stockBefore, new_stock: stockAfter, difference: diff });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stock issue
router.post('/spare-parts/issue', requirePermission('maintenance', 'edit'), async (req, res) => {
  try {
    const { part_id, qty, log_id, remarks } = req.body;
    if (!part_id || !qty) return res.status(422).json({ error: 'part_id and qty are required' });
    const companyId = cid(req);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [part] } = await client.query(
        `SELECT * FROM spare_parts WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) FOR UPDATE`,
        [part_id, companyId]
      );
      if (!part) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Part not found' }); }
      if (parseFloat(part.stock_qty) < parseFloat(qty)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient stock: ${part.stock_qty} available` });
      }

      const stockBefore = parseFloat(part.stock_qty);
      const stockAfter  = stockBefore - parseFloat(qty);

      await client.query(`UPDATE spare_parts SET stock_qty=$1, updated_at=NOW() WHERE id=$2`, [stockAfter, part_id]);
      await recordMovement(client, {
        part_id, type: 'issue', qty: parseFloat(qty), stockBefore, stockAfter,
        unit_cost: parseFloat(part.unit_cost)||0, ref_type: log_id ? 'maintenance_log' : null,
        ref_id: log_id||null, remarks: remarks || null,
        done_by: req.user?.name || req.user?.email, company_id: companyId
      });

      if (log_id) {
        const { rows: [log] } = await client.query(`SELECT parts_used FROM maintenance_logs WHERE id=$1`, [log_id]);
        if (log) {
          const parts = Array.isArray(log.parts_used) ? log.parts_used : [];
          parts.push({ part_id, name: part.name, qty: parseFloat(qty), unit_cost: parseFloat(part.unit_cost)||0 });
          await client.query(`UPDATE maintenance_logs SET parts_used=$1 WHERE id=$2`, [JSON.stringify(parts), log_id]);
        }
      }

      await client.query('COMMIT');
      res.json({ success: true, remaining_stock: stockAfter });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All movements (global audit trail)
router.get('/spare-parts/movements', requirePermission('maintenance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const { rows } = await pool.query(
      `SELECT m.*, p.name AS part_name, p.part_number
       FROM spare_parts_movements m
       LEFT JOIN spare_parts p ON p.id = m.part_id
       WHERE ($1::int IS NULL OR m.company_id = $1)
       ORDER BY m.created_at DESC LIMIT $2`,
      [companyId, limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stock movements history per part
router.get('/spare-parts/:id/movements', requirePermission('maintenance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT * FROM spare_parts_movements
       WHERE part_id=$1 AND ($2::int IS NULL OR company_id=$2)
       ORDER BY created_at DESC LIMIT 100`,
      [req.params.id, companyId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD & ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/dashboard', requirePermission('maintenance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const p = [companyId];
    const [due, openBreakdowns, mttrResult, costMTD, topBreakdowns, lowStock, overdueSchedules] =
      await Promise.allSettled([
        pool.query(`SELECT COUNT(*) AS n FROM maintenance_schedules
                    WHERE ($1::int IS NULL OR company_id=$1)
                    AND next_due_date <= NOW() + INTERVAL '7 days'
                    AND (is_active IS NULL OR is_active=TRUE)`, p),
        pool.query(`SELECT COUNT(*) AS n FROM maintenance_logs
                    WHERE log_type='breakdown' AND status != 'completed'
                    AND ($1::int IS NULL OR company_id=$1)`, p),
        pool.query(`SELECT ROUND(AVG(downtime_hrs),2) AS mttr FROM maintenance_logs
                    WHERE status='completed' AND downtime_hrs IS NOT NULL
                    AND created_at >= NOW()-INTERVAL '6 months'
                    AND ($1::int IS NULL OR company_id=$1)`, p),
        pool.query(`SELECT COALESCE(SUM(cost),0) AS total FROM maintenance_logs
                    WHERE created_at >= date_trunc('month',NOW())
                    AND ($1::int IS NULL OR company_id=$1)`, p),
        pool.query(`SELECT a.name, a.asset_code, COUNT(l.id) AS breakdown_count
                    FROM maintenance_logs l JOIN assets_register a ON a.id=l.asset_id
                    WHERE l.log_type='breakdown' AND l.created_at >= NOW()-INTERVAL '12 months'
                    AND ($1::int IS NULL OR l.company_id=$1)
                    GROUP BY a.id, a.name, a.asset_code
                    ORDER BY breakdown_count DESC LIMIT 5`, p),
        pool.query(`SELECT COUNT(*) AS n FROM spare_parts
                    WHERE stock_qty <= reorder_level AND ($1::int IS NULL OR company_id=$1)`, p),
        pool.query(`SELECT COUNT(*) AS n FROM maintenance_schedules
                    WHERE next_due_date < NOW() AND (is_active IS NULL OR is_active=TRUE)
                    AND ($1::int IS NULL OR company_id=$1)`, p),
      ]);

    res.json({
      assets_due_maintenance  : parseInt(due.status === 'fulfilled' ? due.value.rows[0].n : 0),
      open_breakdowns         : parseInt(openBreakdowns.status === 'fulfilled' ? openBreakdowns.value.rows[0].n : 0),
      mttr_hrs                : parseFloat(mttrResult.status === 'fulfilled' ? mttrResult.value.rows[0].mttr||0 : 0),
      maintenance_cost_mtd    : parseFloat(costMTD.status === 'fulfilled' ? costMTD.value.rows[0].total : 0),
      top_breakdown_assets    : topBreakdowns.status === 'fulfilled' ? topBreakdowns.value.rows : [],
      low_stock_parts         : parseInt(lowStock.status === 'fulfilled' ? lowStock.value.rows[0].n : 0),
      overdue_schedules       : parseInt(overdueSchedules.status === 'fulfilled' ? overdueSchedules.value.rows[0].n : 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/analytics', requirePermission('maintenance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const p = [companyId];
    const [mttrByCat, costTrend, topBreakdowns, pmCompliance] = await Promise.allSettled([
      pool.query(`
        SELECT a.category, ROUND(AVG(l.downtime_hrs),1) AS mttr
        FROM maintenance_logs l JOIN assets_register a ON a.id=l.asset_id
        WHERE l.status='completed' AND l.downtime_hrs IS NOT NULL
        AND l.created_at >= NOW()-INTERVAL '6 months'
        AND ($1::int IS NULL OR l.company_id=$1)
        GROUP BY a.category ORDER BY mttr DESC`, p),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month',created_at),'Mon YY') AS month,
               DATE_TRUNC('month',created_at) AS month_ts,
               COALESCE(SUM(cost),0) AS cost,
               COUNT(*) FILTER (WHERE log_type='breakdown') AS breakdowns,
               COUNT(*) FILTER (WHERE log_type='preventive') AS preventive
        FROM maintenance_logs
        WHERE created_at >= NOW()-INTERVAL '6 months'
        AND ($1::int IS NULL OR company_id=$1)
        GROUP BY DATE_TRUNC('month',created_at)
        ORDER BY month_ts ASC`, p),
      pool.query(`
        SELECT a.name, a.asset_code, a.department, COUNT(l.id) AS breakdown_count
        FROM maintenance_logs l JOIN assets_register a ON a.id=l.asset_id
        WHERE l.log_type='breakdown' AND l.created_at >= NOW()-INTERVAL '12 months'
        AND ($1::int IS NULL OR l.company_id=$1)
        GROUP BY a.id, a.name, a.asset_code, a.department
        ORDER BY breakdown_count DESC LIMIT 5`, p),
      pool.query(`
        SELECT
          COUNT(*) AS scheduled,
          COUNT(*) FILTER (WHERE status='completed') AS completed
        FROM maintenance_logs
        WHERE log_type='preventive'
        AND created_at >= date_trunc('year', NOW())
        AND ($1::int IS NULL OR company_id=$1)`, p),
    ]);

    const pmRow = pmCompliance.status === 'fulfilled' ? pmCompliance.value.rows[0] : {};
    const pmTotal = parseInt(pmRow.scheduled||0);
    const pmDone  = parseInt(pmRow.completed||0);

    res.json({
      mttr            : mttrByCat.status === 'fulfilled' ? mttrByCat.value.rows.map(r => ({ category: r.category, mttr: parseFloat(r.mttr||0) })) : [],
      cost_trend      : costTrend.status === 'fulfilled' ? costTrend.value.rows.map(r => ({ month: r.month, cost: parseFloat(r.cost||0), breakdowns: parseInt(r.breakdowns||0), preventive: parseInt(r.preventive||0) })) : [],
      top_breakdowns  : topBreakdowns.status === 'fulfilled' ? topBreakdowns.value.rows.map(r => ({ ...r, breakdowns_12m: parseInt(r.breakdown_count||0) })) : [],
      pm_compliance   : { scheduled: pmTotal, completed: pmDone, pct: pmTotal > 0 ? Math.round((pmDone/pmTotal)*100) : 100 },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Service notifications list
router.get('/notifications', requirePermission('maintenance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT * FROM service_notifications
       WHERE ($1::int IS NULL OR company_id=$1)
       ORDER BY created_at DESC LIMIT 50`,
      [companyId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/notifications/:id/read', requirePermission('maintenance', 'view'), async (req, res) => {
  try {
    await pool.query(`UPDATE service_notifications SET is_read=TRUE WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
