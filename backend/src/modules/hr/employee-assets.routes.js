// backend/src/modules/hr/employee-assets.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { requirePermission, verifyToken, allowRoles } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';

const router = express.Router();

const HR_ROLES = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec', 'HR', 'Admin', 'SuperAdmin'];

// All asset routes require authentication
router.use(verifyToken);

/**
 * Fetch an allocation the caller is actually allowed to touch.
 *
 * ⚠ SIX write routes read the row with a bare `WHERE id=$1` and then updated it:
 * PUT, PATCH /:id/return, POST /:id/transfer, POST /:id/maintenance,
 * POST /:id/maintenance/complete and PATCH /:id/dispose. Every one of them was
 * a cross-tenant write — an HR user in company A could rename, return, transfer,
 * send to maintenance, or scrap company B's laptop by guessing an id, and the
 * audit entry would be written against A. (POST and DELETE were scoped in the
 * 2026-09-28 pass; these six were flagged then and are closed here.)
 *
 * A row outside the caller's scope is a 404, identical to one that does not
 * exist: whether an id is real in another tenant is the fact a prober wants.
 *
 * `companyOf(req)` — never `req.scope?.company_id` directly, which is what the
 * old code used. See shared/scope.js.
 */
async function loadOwnedAllocation(req, res) {
  const cid = companyOf(req);
  const { rows } = await pool.query(
    `SELECT * FROM employee_asset_allocations
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
    [req.params.id, cid],
  );
  if (!rows.length) { res.status(404).json({ message: 'Not found' }); return null; }
  return rows[0];
}

/** The same scope, as a clause for the UPDATE that follows the read. */
const ownedClause = (req, startAt) => {
  const cid = companyOf(req);
  return { where: ` AND ($${startAt}::int IS NULL OR company_id = $${startAt})`, params: [cid] };
};

/* ─── GET /employee-assets?employee_id=X ────────────────────── */
// Gated on the owning module 2026-09-04. A live probe with a plain
// `employee` token returned other people's records from this router, and an
// employee has no routine need for this register — their own record reaches
// them through self-service. `employee` is denied assets in role_permissions,
// which is what makes this gate real rather than decorative.
router.get('/', requirePermission('assets', 'view'), async (req, res) => {
  const { employee_id, status } = req.query;
  // ⚠ `company_id` from req.query is IGNORED. It used to be a fallback
  // (`req.scope?.company_id ?? qCid`), so any caller whose scope resolved to
  // null could name a tenant and read its asset register. A client-supplied
  // scope is not a scope.
  const cid = companyOf(req);
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
router.get('/:id', requirePermission('assets', 'view'), async (req, res) => {
  const cid = companyOf(req);
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
  const cid = companyOf(req);
  const allocatedBy = req.user?.employee_id ?? null;
  try {
    // ── Tenant check on employee_id ──────────────────────────────────────────
    // `employee_id` came straight off the request body and went into the
    // INSERT unverified, while company_id was stamped from the CALLER's scope.
    // So an HR user in company A could allocate an asset to an employee in
    // company B, and the resulting row claimed to belong to A while pointing at
    // a person in B — a cross-tenant write that also corrupts both companies'
    // asset registers. The Add Employee form posts here once per asset row.
    //
    // A 404 rather than a 403: whether an id exists in another tenant is the
    // fact a prober is after.
    const owner = await pool.query(
      `SELECT id FROM employees
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
        LIMIT 1`,
      [employee_id, cid],
    );
    if (!owner.rows.length) {
      return res.status(404).json({ message: 'Employee not found in this company.' });
    }

    // ── Asset type must come from the master ────────────────────────────────
    // The picker is a <VocabSelect vocab="asset-types">, so the UI can only
    // offer the 13 ASSET_TYPE rows — but the API accepted any string at all,
    // and this column is what the Employee Assets page groups and reports by.
    // A tenant's own added types (company_id = theirs) count, as does the
    // shared seed (company_id IS NULL). Skipped when the master is unseeded,
    // matching validateMasterValue's rule for department and designation: an
    // empty master must not block every allocation.
    const { rows: seeded } = await pool.query(
      `SELECT 1 FROM master_values
        WHERE type = 'ASSET_TYPE' AND is_active = true
          AND (company_id IS NULL OR company_id = $1) LIMIT 1`,
      [cid],
    );
    if (seeded.length) {
      const { rows: hit } = await pool.query(
        `SELECT 1 FROM master_values
          WHERE type = 'ASSET_TYPE' AND is_active = true
            AND (company_id IS NULL OR company_id = $1)
            AND LOWER(BTRIM(value)) = LOWER(BTRIM($2)) LIMIT 1`,
        [cid, asset_type],
      );
      if (!hit.length) {
        return res.status(400).json({
          message: `"${asset_type}" is not a valid asset type. Select one from the list.`,
        });
      }
    }

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
    const prev = await loadOwnedAllocation(req, res);
    if (!prev) return undefined;
    const scope = ownedClause(req, 12);
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
       WHERE id=$11${scope.where} RETURNING *`,
      [asset_type, asset_name, asset_tag, serial_number, brand, model, allocated_date, condition_in, notes, status, req.params.id, ...scope.params]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'update', oldData: prev, newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PATCH /employee-assets/:id/return ────────────────────── */
router.patch('/:id/return', allowRoles(...HR_ROLES), captureBefore('employee_asset_allocations'), async (req, res) => {
  const { return_date, condition_out, notes } = req.body;
  const returnedTo = req.user?.employee_id ?? null;
  try {
    // Read through the loader like its siblings: the scoped UPDATE below is
    // what enforces the boundary, but reading first gives the audit entry a
    // real `oldData` and keeps all six routes on one pattern.
    const prev = await loadOwnedAllocation(req, res);
    if (!prev) return undefined;
    const scope = ownedClause(req, 6);
    const { rows } = await pool.query(
      `UPDATE employee_asset_allocations SET
         status        = 'returned',
         return_date   = COALESCE($1, CURRENT_DATE),
         condition_out = COALESCE($2, 'good'),
         notes         = COALESCE($3, notes),
         returned_to   = $4,
         updated_at    = NOW()
       WHERE id=$5 AND status='allocated'${scope.where} RETURNING *`,
      [return_date, condition_out, notes, returnedTo, req.params.id, ...scope.params]
    );
    if (!rows.length) return res.status(404).json({ message: 'Asset not found or already returned' });
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'return', oldData: prev, newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /employee-assets/:id/transfer — reassign a currently-allocated
   asset to a different employee, preserving its identity (same row/id,
   same history via audit log) instead of a blind return+re-create. ───── */
router.post('/:id/transfer', allowRoles(...HR_ROLES), async (req, res) => {
  const { to_employee_id, notes } = req.body;
  if (!to_employee_id) return res.status(400).json({ message: 'to_employee_id is required' });
  try {
    const prev = await loadOwnedAllocation(req, res);
    if (!prev) return undefined;
    if (prev.status !== 'allocated') {
      return res.status(400).json({ message: `Cannot transfer an asset that is ${prev.status}, not allocated` });
    }
    // ⚠ The DESTINATION employee is checked too. Scoping the allocation alone
    // would still let an asset be transferred OUT of this tenant to a person in
    // another one — the row would keep company A's company_id while pointing at
    // an employee in B, which is the same corruption POST was fixed for.
    const cid = companyOf(req);
    const dest = await pool.query(
      `SELECT id FROM employees
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2) LIMIT 1`,
      [to_employee_id, cid]);
    if (!dest.rows.length) {
      return res.status(404).json({ message: 'Employee not found in this company.' });
    }
    const scope = ownedClause(req, 4);
    const { rows } = await pool.query(
      `UPDATE employee_asset_allocations SET
         transferred_from = employee_id,
         employee_id      = $1,
         transferred_at    = NOW(),
         notes             = COALESCE($2, notes),
         updated_at        = NOW()
       WHERE id=$3${scope.where} RETURNING *`,
      [to_employee_id, notes, req.params.id, ...scope.params]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'transfer', oldData: prev, newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /employee-assets/:id/maintenance — pull an allocated asset out of
   service temporarily (repair, servicing) without a full return. ───────── */
router.post('/:id/maintenance', allowRoles(...HR_ROLES), async (req, res) => {
  const { notes, expected_return_date } = req.body;
  try {
    const prev = await loadOwnedAllocation(req, res);
    if (!prev) return undefined;
    if (prev.status !== 'allocated') {
      return res.status(400).json({ message: `Cannot send to maintenance from status ${prev.status}` });
    }
    const scope = ownedClause(req, 4);
    const { rows } = await pool.query(
      `UPDATE employee_asset_allocations SET
         status                       = 'under_maintenance',
         maintenance_started_at        = NOW(),
         maintenance_expected_return   = $1,
         maintenance_notes             = $2,
         updated_at                    = NOW()
       WHERE id=$3${scope.where} RETURNING *`,
      [expected_return_date || null, notes || null, req.params.id, ...scope.params]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'maintenance_start', oldData: prev, newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /employee-assets/:id/maintenance/complete — back in service. ─ */
router.post('/:id/maintenance/complete', allowRoles(...HR_ROLES), async (req, res) => {
  const { condition_in, notes } = req.body;
  try {
    const prev = await loadOwnedAllocation(req, res);
    if (!prev) return undefined;
    if (prev.status !== 'under_maintenance') {
      return res.status(400).json({ message: `Asset is ${prev.status}, not under maintenance` });
    }
    const scope = ownedClause(req, 4);
    const { rows } = await pool.query(
      `UPDATE employee_asset_allocations SET
         status         = 'allocated',
         condition_in   = COALESCE($1, condition_in),
         maintenance_notes = COALESCE($2, maintenance_notes),
         updated_at     = NOW()
       WHERE id=$3${scope.where} RETURNING *`,
      [condition_in || null, notes || null, req.params.id, ...scope.params]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'maintenance_complete', oldData: prev, newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PATCH /employee-assets/:id/dispose — terminal state; scrapped/written
   off, no longer anyone's responsibility (so Exit Clearance stops blocking
   on it — see exit.routes.js computeClearanceBlockers). ────────────────── */
router.patch('/:id/dispose', allowRoles(...HR_ROLES), async (req, res) => {
  const { reason, notes } = req.body;
  try {
    const prev = await loadOwnedAllocation(req, res);
    if (!prev) return undefined;
    if (prev.status === 'disposed') {
      return res.status(400).json({ message: 'Asset is already disposed' });
    }
    const scope = ownedClause(req, 5);
    const { rows } = await pool.query(
      `UPDATE employee_asset_allocations SET
         status           = 'disposed',
         disposed_at      = NOW(),
         disposal_reason  = $1,
         disposed_by      = $2,
         notes            = COALESCE($3, notes),
         updated_at       = NOW()
       WHERE id=$4${scope.where} RETURNING *`,
      [reason || null, req.user?.employee_id ?? null, notes || null, req.params.id, ...scope.params]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'dispose', oldData: prev, newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── DELETE /employee-assets/:id ───────────────────────────── */
router.delete('/:id', allowRoles(...HR_ROLES), async (req, res) => {
  const cid = companyOf(req);
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
