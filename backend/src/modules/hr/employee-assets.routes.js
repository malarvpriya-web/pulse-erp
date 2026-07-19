// backend/src/modules/hr/employee-assets.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { verifyToken, allowRoles } from '../../middlewares/auth.middleware.js';

const router = express.Router();

const HR_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'HR', 'Admin', 'SuperAdmin'];

// All asset routes require authentication
router.use(verifyToken);

/* ─── GET /employee-assets?employee_id=X ────────────────────── */
router.get('/', async (req, res) => {
  const { employee_id, status, company_id: qCid } = req.query;
  const cid = req.scope?.company_id ?? qCid ?? null;
  try {
    const params = [];
    let i = 1;
    let q = `
      SELECT a.*,
        (e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name,
        (ab.first_name || ' ' || COALESCE(ab.last_name,'')) AS allocated_by_name
      FROM employee_asset_allocations a
      LEFT JOIN employees e ON e.id = a.employee_id
      LEFT JOIN employees ab ON ab.id = a.allocated_by
      WHERE 1=1
    `;
    if (cid != null)       { params.push(cid);         q += ` AND a.company_id = $${i++}`; }
    if (employee_id)       { params.push(parseInt(employee_id, 10)); q += ` AND a.employee_id = $${i++}`; }
    if (status)            { params.push(status);       q += ` AND a.status = $${i++}`; }
    q += ` ORDER BY a.allocated_date DESC`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /employee-assets/:id ──────────────────────────────── */
router.get('/:id', async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT a.*,
         (e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name
       FROM employee_asset_allocations a
       LEFT JOIN employees e ON e.id = a.employee_id
       WHERE a.id = $1
         AND ($2::int IS NULL OR a.company_id = $2)`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /employee-assets ─────────────────────────────────── */
router.post('/', allowRoles(...HR_ROLES), async (req, res) => {
  const {
    employee_id, asset_type, asset_name, asset_tag, serial_number,
    brand, model, allocated_date, condition_in, notes,
  } = req.body;
  if (!employee_id || !asset_type || !asset_name)
    return res.status(400).json({ message: 'employee_id, asset_type, asset_name required' });
  const cid = req.scope?.company_id ?? null;
  const allocatedBy = req.user?.employee_id ?? null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO employee_asset_allocations
         (company_id, employee_id, asset_type, asset_name, asset_tag, serial_number,
          brand, model, allocated_date, condition_in, notes, allocated_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'allocated') RETURNING *`,
      [cid, employee_id, asset_type, asset_name, asset_tag || null, serial_number || null,
       brand || null, model || null, allocated_date || new Date().toISOString().split('T')[0],
       condition_in || 'good', notes || null, allocatedBy]
    );
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /employee-assets/:id ──────────────────────────────── */
router.put('/:id', allowRoles(...HR_ROLES), async (req, res) => {
  const { asset_type, asset_name, asset_tag, serial_number, brand, model, allocated_date, condition_in, notes, status } = req.body;
  try {
    const old = await pool.query(`SELECT * FROM employee_asset_allocations WHERE id=$1`, [req.params.id]);
    if (!old.rows.length) return res.status(404).json({ message: 'Not found' });
    const { rows } = await pool.query(
      `UPDATE employee_asset_allocations SET
         asset_type     = COALESCE($1, asset_type),
         asset_name     = COALESCE($2, asset_name),
         asset_tag      = COALESCE($3, asset_tag),
         serial_number  = COALESCE($4, serial_number),
         brand          = COALESCE($5, brand),
         model          = COALESCE($6, model),
         allocated_date = COALESCE($7, allocated_date),
         condition_in   = COALESCE($8, condition_in),
         notes          = COALESCE($9, notes),
         status         = COALESCE($10, status),
         updated_at     = NOW()
       WHERE id=$11 RETURNING *`,
      [asset_type, asset_name, asset_tag, serial_number, brand, model, allocated_date, condition_in, notes, status, req.params.id]
    );
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'update', oldData: old.rows[0], newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PATCH /employee-assets/:id/return ────────────────────── */
router.patch('/:id/return', allowRoles(...HR_ROLES), async (req, res) => {
  const { return_date, condition_out, notes } = req.body;
  const returnedTo = req.user?.employee_id ?? null;
  try {
    const { rows } = await pool.query(
      `UPDATE employee_asset_allocations SET
         status        = 'returned',
         return_date   = COALESCE($1, CURRENT_DATE),
         condition_out = COALESCE($2, 'good'),
         notes         = COALESCE($3, notes),
         returned_to   = $4,
         updated_at    = NOW()
       WHERE id=$5 AND status='allocated' RETURNING *`,
      [return_date, condition_out, notes, returnedTo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Asset not found or already returned' });
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'return', newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── DELETE /employee-assets/:id ───────────────────────────── */
router.delete('/:id', allowRoles(...HR_ROLES), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  try {
    const old = await pool.query(
      `SELECT * FROM employee_asset_allocations WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]
    );
    if (!old.rows.length) return res.status(404).json({ message: 'Not found' });
    await pool.query(`DELETE FROM employee_asset_allocations WHERE id=$1`, [req.params.id]);
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: Number(req.params.id), recordType: 'asset_allocation', action: 'delete', oldData: old.rows[0], req });
    res.json({ message: 'Deleted', id: Number(req.params.id) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
