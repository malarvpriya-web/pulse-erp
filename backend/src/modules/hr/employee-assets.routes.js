// backend/src/modules/hr/employee-assets.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { requirePermission, verifyToken, allowRoles } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { ownOrPermission } from '../../shared/ownRecordRead.js';
import { isExitedSql } from '../../shared/employeeStatus.js';

const router = express.Router();

/**
 * Status a return lands on, from the condition recorded at return.
 * A return marked 'lost' used to land on 'returned' like any other, so the
 * Lost / Damaged count was always 0 and a lost laptop cleared Exit Clearance.
 *   lost    → 'lost'    — NOT handed back; still blocks exit until disposed.
 *   damaged → 'damaged' — handed back broken; no longer blocks exit.
 */
const RETURN_STATUS_FOR = { lost: 'lost', damaged: 'damaged' };

/** Only closed-out records may be deleted; anything else is live history. */
const DELETABLE_STATUSES = ['returned', 'disposed'];

/**
 * Statuses where the physical item is back with the company (or gone for
 * good). Every other status means somebody is accountable for it right now,
 * so a second record with the same tag or serial would be two people "holding"
 * one laptop.
 */
const CLOSED_STATUSES = ['returned', 'disposed', 'damaged'];

/**
 * Asset type must come from the ASSET_TYPE master. The picker is a
 * <VocabSelect vocab="asset-types">, but the API accepted any string, and this
 * column is what the page groups and filters by. A tenant's own added types
 * count, as does the shared seed (company_id IS NULL). Skipped when the master
 * is unseeded, matching validateMasterValue's rule for department and
 * designation: an empty master must not block every allocation.
 * @returns an error message, or null when the type is acceptable.
 */
async function assetTypeError(cid, assetType) {
  const { rows: seeded } = await pool.query(
    `SELECT 1 FROM master_values
      WHERE type = 'ASSET_TYPE' AND is_active = true
        AND (company_id IS NULL OR company_id = $1) LIMIT 1`,
    [cid],
  );
  if (!seeded.length) return null;
  const { rows: hit } = await pool.query(
    `SELECT 1 FROM master_values
      WHERE type = 'ASSET_TYPE' AND is_active = true
        AND (company_id IS NULL OR company_id = $1)
        AND LOWER(BTRIM(value)) = LOWER(BTRIM($2)) LIMIT 1`,
    [cid, assetType],
  );
  return hit.length ? null : `"${assetType}" is not a valid asset type. Select one from the list.`;
}

/**
 * Another LIVE record carrying the same asset tag or serial number in this
 * company. Nothing checked this, so the same laptop could be allocated to two
 * people at once. Compared trimmed and case-insensitively ("it003" = "IT003 ").
 * Closed records (returned/disposed/damaged) don't count — re-issuing a
 * returned laptop is the normal case.
 * @returns an error message, or null.
 */
async function duplicateError(cid, { asset_tag, serial_number }, excludeId = null) {
  const tag = String(asset_tag ?? '').trim();
  const sn  = String(serial_number ?? '').trim();
  if (!tag && !sn) return null;
  const { rows } = await pool.query(
    `SELECT a.id, a.asset_tag, a.serial_number,
            (e.first_name || ' ' || COALESCE(e.last_name,'')) AS holder
       FROM employee_asset_allocations a
       LEFT JOIN employees e ON e.id = a.employee_id
      WHERE ($1::int IS NULL OR a.company_id = $1)
        AND a.status <> ALL($2::text[])
        AND ($3::int IS NULL OR a.id <> $3)
        AND (   ($4 <> '' AND LOWER(BTRIM(a.asset_tag))     = LOWER($4))
             OR ($5 <> '' AND LOWER(BTRIM(a.serial_number)) = LOWER($5)))
      LIMIT 1`,
    [cid, CLOSED_STATUSES, excludeId, tag, sn],
  );
  if (!rows.length) return null;
  const d = rows[0];
  const which = tag && String(d.asset_tag ?? '').trim().toLowerCase() === tag.toLowerCase()
    ? `Asset tag "${tag}"` : `Serial number "${sn}"`;
  return `${which} is already on a live record (with ${String(d.holder || 'someone').trim()}). Return or dispose of that one first, or correct the number.`;
}

/** An employee of this company who has not been deleted. */
async function liveEmployee(cid, employeeId) {
  const { rows } = await pool.query(
    `SELECT id FROM employees
      WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
      LIMIT 1`,
    [employeeId, cid],
  );
  return rows.length > 0;
}

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
// assets:view, or the caller's own allocations (?employee_id=<own>) — My Details' Assets tab.
router.get('/', ownOrPermission('assets', 'view', req => req.query.employee_id), async (req, res) => {
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
        (ab.first_name || ' ' || COALESCE(ab.last_name,'')) AS allocated_by_name,
        e.office_id AS employee_code,
        -- Shown but flagged: an asset still out with someone who has left or
        -- was deleted is exactly what HR needs to see.
        (e.deleted_at IS NOT NULL OR ${isExitedSql('e.status')}) AS employee_left,
        -- The later allocation this returned record was re-issued as, if any.
        (SELECT r.id FROM employee_asset_allocations r WHERE r.reissued_from = a.id
          ORDER BY r.id LIMIT 1) AS reissued_as
      FROM employee_asset_allocations a
      LEFT JOIN employees e ON e.id = a.employee_id
      LEFT JOIN employees ab ON ab.id = a.allocated_by
      WHERE 1=1
    `;
    if (cid != null)       { params.push(cid);         q += ` AND a.company_id = $${i++}`; }
    if (employee_id)       { params.push(parseInt(employee_id, 10)); q += ` AND a.employee_id = $${i++}`; }
    if (status)            { params.push(status);       q += ` AND a.status = $${i++}`; }
    q += ` ORDER BY a.allocated_date DESC, a.id DESC`;
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
    if (!(await liveEmployee(cid, employee_id))) {
      return res.status(404).json({ message: 'Employee not found in this company.' });
    }
    const typeErr = await assetTypeError(cid, asset_type);
    if (typeErr) return res.status(400).json({ message: typeErr });
    const dupErr = await duplicateError(cid, { asset_tag, serial_number });
    if (dupErr) return res.status(409).json({ message: dupErr });

    const { rows } = await pool.query(
      `INSERT INTO employee_asset_allocations
         (company_id, employee_id, asset_type, asset_name, asset_tag, serial_number,
          brand, model, allocated_date, condition_in, notes, allocated_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, CURRENT_DATE),$10,$11,$12,'allocated') RETURNING *`,
      [cid, employee_id, asset_type, asset_name, String(asset_tag ?? '').trim() || null,
       String(serial_number ?? '').trim() || null,
       brand || null, model || null, allocated_date || null,
       condition_in || 'good', notes || null, allocatedBy]
    );
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /employee-assets/:id ──────────────────────────────── */
// Corrects the asset's DETAILS only. Holder and status change through their own
// actions (transfer, return, maintenance, dispose, re-issue), each with its
// checks and audit entry. This route used to accept `status` too, so any value
// at all could be written past every one of those checks.
//
// A field present in the body is set (blank text clears an optional field);
// a field left out is kept. Asset type and name can't be cleared. Add Employee
// (edit mode) sends `null` for a cleared tag or serial and relies on this.
const EDITABLE_TEXT = ['asset_tag', 'serial_number', 'brand', 'model', 'notes'];
router.put('/:id', allowRoles(...HR_ROLES), async (req, res) => {
  const body = req.body || {};
  if ('status' in body || 'employee_id' in body) {
    return res.status(400).json({
      message: 'Holder and status are changed with Transfer, Return, Maintenance, Dispose or Re-issue, not Edit.',
    });
  }
  const cid = companyOf(req);
  try {
    const prev = await loadOwnedAllocation(req, res);
    if (!prev) return undefined;
    if (prev.status === 'disposed') {
      return res.status(400).json({ message: 'A disposed asset is closed and cannot be edited.' });
    }
    const { rows: child } = await pool.query(
      `SELECT id FROM employee_asset_allocations WHERE reissued_from = $1 LIMIT 1`, [prev.id]);
    if (child.length) {
      return res.status(400).json({ message: 'This record was re-issued. Edit the asset on its current record instead.' });
    }

    const sets = [];
    const params = [];
    const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    for (const col of ['asset_type', 'asset_name']) {
      if (body[col] == null) continue;            // null/absent → keep
      const v = String(body[col]).trim();
      if (!v) return res.status(400).json({ message: `${col === 'asset_type' ? 'Asset type' : 'Asset name'} cannot be blank.` });
      put(col, v);
    }
    for (const col of EDITABLE_TEXT) {
      if (!(col in body)) continue;
      put(col, String(body[col] ?? '').trim() || null);
    }
    if (body.allocated_date) put('allocated_date', body.allocated_date);
    if (body.condition_in)   put('condition_in', String(body.condition_in).trim().toLowerCase());
    if (!sets.length) return res.json(prev);

    const next = { ...prev, ...Object.fromEntries(
      sets.map((s, k) => [s.split(' = ')[0], params[k]])) };
    if (next.asset_type !== prev.asset_type) {
      const typeErr = await assetTypeError(cid, next.asset_type);
      if (typeErr) return res.status(400).json({ message: typeErr });
    }
    // Checked only while this record is live: a closed one can hold the same
    // number as the live record it was re-issued as.
    if (!CLOSED_STATUSES.includes(prev.status)) {
      const dupErr = await duplicateError(cid, next, prev.id);
      if (dupErr) return res.status(409).json({ message: dupErr });
    }

    const scope = ownedClause(req, params.length + 2);
    const { rows } = await pool.query(
      `UPDATE employee_asset_allocations SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length + 1}${scope.where} RETURNING *`,
      [...params, req.params.id, ...scope.params]
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
    // Said plainly instead of the UPDATE's 0-row "not found or already
    // returned", which was wrong for an asset that is out for repair.
    if (prev.status !== 'allocated') {
      const why = prev.status === 'under_maintenance'
        ? 'It is under maintenance. Complete the maintenance first, then process the return.'
        : `It is ${prev.status}.`;
      return res.status(400).json({ message: `This asset cannot be returned. ${why}` });
    }
    const cond = String(condition_out || 'good').trim().toLowerCase();
    const newStatus = RETURN_STATUS_FOR[cond] || 'returned';
    const scope = ownedClause(req, 7);
    const { rows } = await pool.query(
      `UPDATE employee_asset_allocations SET
         status        = $6,
         return_date   = COALESCE($1, CURRENT_DATE),
         condition_out = $2,
         notes         = COALESCE($3, notes),
         returned_to   = $4,
         updated_at    = NOW()
       WHERE id=$5 AND status='allocated'${scope.where} RETURNING *`,
      [return_date || null, cond, notes || null, returnedTo, req.params.id, newStatus, ...scope.params]
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
    // A "transfer" to the current holder overwrote transferred_from with that
    // same person, erasing who really had it before (verified 11 Nov 26).
    if (String(to_employee_id) === String(prev.employee_id)) {
      return res.status(400).json({ message: 'The asset is already with this employee.' });
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
    // A returned record that was re-issued is history; the item now lives on
    // the later record, which is the one to dispose of.
    const { rows: child } = await pool.query(
      `SELECT id FROM employee_asset_allocations WHERE reissued_from = $1 LIMIT 1`, [prev.id]);
    if (child.length) {
      return res.status(400).json({ message: 'This asset was re-issued. Dispose of it on its current record instead.' });
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

/* ─── POST /employee-assets/:id/reissue — give a RETURNED asset to someone.
   Creates the new allocation linked by `reissued_from`, so the item's history
   stays one chain instead of an unrelated fresh record. The returned record is
   kept as it was: it is the proof of who had it before and in what condition
   it came back. ─────────────────────────────────────────────────────────── */
router.post('/:id/reissue', allowRoles(...HR_ROLES), async (req, res) => {
  const { employee_id, allocated_date, condition_in, notes } = req.body || {};
  if (!employee_id) return res.status(400).json({ message: 'employee_id is required' });
  const cid = companyOf(req);
  try {
    const prev = await loadOwnedAllocation(req, res);
    if (!prev) return undefined;
    if (prev.status !== 'returned') {
      return res.status(400).json({ message: `Only a returned asset can be re-issued. This one is ${prev.status}.` });
    }
    const { rows: already } = await pool.query(
      `SELECT id FROM employee_asset_allocations WHERE reissued_from = $1 LIMIT 1`, [prev.id]);
    if (already.length) {
      return res.status(409).json({ message: 'This returned asset has already been re-issued.' });
    }
    if (!(await liveEmployee(cid, employee_id))) {
      return res.status(404).json({ message: 'Employee not found in this company.' });
    }
    const dupErr = await duplicateError(cid, prev, prev.id);
    if (dupErr) return res.status(409).json({ message: dupErr });

    const { rows } = await pool.query(
      `INSERT INTO employee_asset_allocations
         (company_id, employee_id, asset_type, asset_name, asset_tag, serial_number,
          brand, model, allocated_date, condition_in, notes, allocated_by, status, reissued_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::date, CURRENT_DATE),$10,$11,$12,'allocated',$13)
       RETURNING *`,
      [prev.company_id, employee_id, prev.asset_type, prev.asset_name, prev.asset_tag,
       prev.serial_number, prev.brand, prev.model, allocated_date || null,
       // It goes out in the condition it came back in, unless HR says otherwise.
       condition_in || prev.condition_out || 'good', notes || null,
       req.user?.employee_id ?? null, prev.id]
    );
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: rows[0].id, recordType: 'asset_allocation', action: 'reissue', oldData: prev, newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /employee-assets/:id/history — every event for this physical
   asset: the record itself plus the records it was re-issued from / as.
   Built from the audit log; a record older than its audit entries (SEED or
   pre-audit rows) falls back to the dates stored on the row. ─────────────── */
const ACTION_LABEL = {
  create: 'Allocated', reissue: 'Re-issued', update: 'Details edited', transfer: 'Transferred',
  return: 'Returned', maintenance_start: 'Sent to maintenance', maintenance_complete: 'Back in service',
  dispose: 'Disposed', delete: 'Record deleted',
};
router.get('/:id/history', requirePermission('assets', 'view'), async (req, res) => {
  const cid = companyOf(req);
  try {
    const prev = await loadOwnedAllocation(req, res);
    if (!prev) return undefined;

    // The chain: walk to the oldest ancestor, then collect every descendant.
    const { rows: chain } = await pool.query(
      `WITH RECURSIVE up AS (
         SELECT id, reissued_from FROM employee_asset_allocations WHERE id = $1
         UNION ALL
         SELECT p.id, p.reissued_from FROM employee_asset_allocations p JOIN up ON p.id = up.reissued_from
       ), root AS (SELECT id FROM up WHERE reissued_from IS NULL LIMIT 1),
       down AS (
         SELECT a.* FROM employee_asset_allocations a WHERE a.id = (SELECT id FROM root)
         UNION ALL
         SELECT c.* FROM employee_asset_allocations c JOIN down ON c.reissued_from = down.id
       )
       SELECT * FROM down WHERE ($2::int IS NULL OR company_id = $2) ORDER BY id`,
      [prev.id, cid]);
    const ids = chain.map(r => String(r.id));

    const { rows: logs } = await pool.query(
      `SELECT l.id, l.action_type, l.reference_id, l.old_data_json, l.new_data_json,
              l.created_at, u.name AS by_name
         FROM audit_logs l
         LEFT JOIN users u ON u.id = l.user_id
        WHERE l.reference_type = 'asset_allocation'
          AND l.module_name = 'employee_assets'
          AND l.reference_id = ANY($1::text[])
        ORDER BY l.created_at, l.id`,
      [ids]);

    // Names for every employee id the events mention.
    const empIds = new Set();
    for (const r of chain) [r.employee_id, r.transferred_from, r.returned_to, r.disposed_by].forEach(x => x && empIds.add(x));
    for (const l of logs) for (const d of [l.old_data_json, l.new_data_json]) if (d?.employee_id) empIds.add(d.employee_id);
    const { rows: emps } = await pool.query(
      `SELECT id, TRIM(first_name || ' ' || COALESCE(last_name,'')) AS name, office_id
         FROM employees WHERE id = ANY($1::int[])`, [[...empIds].map(Number)]);
    const nameOf = id => {
      const e = emps.find(x => x.id === Number(id));
      return e ? `${e.name}${e.office_id ? ` (${e.office_id})` : ''}` : (id ? `Employee #${id}` : '—');
    };

    const DETAIL_FIELDS = ['asset_type', 'asset_name', 'asset_tag', 'serial_number', 'brand', 'model', 'allocated_date', 'condition_in', 'notes'];
    const events = [];
    const logged = new Set(logs.map(l => String(l.reference_id)));
    for (const l of logs) {
      const o = l.old_data_json || {}; const n = l.new_data_json || {};
      let detail = '';
      switch (l.action_type) {
        case 'create':   detail = `To ${nameOf(n.employee_id)}`; break;
        case 'reissue':  detail = `To ${nameOf(n.employee_id)} (previously with ${nameOf(o.employee_id)})`; break;
        case 'transfer': detail = `From ${nameOf(o.employee_id)} to ${nameOf(n.employee_id)}`; break;
        case 'return':   detail = `By ${nameOf(o.employee_id)} · condition ${n.condition_out || '—'}${n.status && n.status !== 'returned' ? ` · marked ${n.status}` : ''}`; break;
        case 'maintenance_start': detail = [n.maintenance_notes, n.maintenance_expected_return && `due back ${String(n.maintenance_expected_return).slice(0, 10)}`].filter(Boolean).join(' · '); break;
        case 'maintenance_complete': detail = `Condition ${n.condition_in || '—'}`; break;
        case 'dispose':  detail = n.disposal_reason || ''; break;
        case 'update': {
          const changed = DETAIL_FIELDS.filter(f => String(o[f] ?? '') !== String(n[f] ?? ''));
          detail = changed.map(f => `${f.replace(/_/g, ' ')}: ${o[f] ?? '—'} → ${n[f] ?? '—'}`).join('; ');
          break;
        }
        default: break;
      }
      events.push({ at: l.created_at, record_id: Number(l.reference_id), action: l.action_type,
        label: ACTION_LABEL[l.action_type] || l.action_type, detail, by: l.by_name || null, source: 'audit' });
    }
    // Rows with no audit trail at all: reconstruct what the row itself records.
    for (const r of chain) {
      if (logged.has(String(r.id))) continue;
      const push = (at, action, detail) => at && events.push({ at, record_id: r.id, action,
        label: ACTION_LABEL[action], detail, by: null, source: 'record' });
      push(r.allocated_date, 'create', `To ${nameOf(r.transferred_from || r.employee_id)}`);
      if (r.transferred_at) push(r.transferred_at, 'transfer', `From ${nameOf(r.transferred_from)} to ${nameOf(r.employee_id)}`);
      if (r.maintenance_started_at) push(r.maintenance_started_at, 'maintenance_start', r.maintenance_notes || '');
      if (r.return_date && ['returned', 'lost', 'damaged'].includes(r.status)) push(r.return_date, 'return', `Condition ${r.condition_out || '—'}`);
      if (r.disposed_at) push(r.disposed_at, 'dispose', r.disposal_reason || '');
    }
    events.sort((a, b) => new Date(a.at) - new Date(b.at));

    res.json({
      asset: { id: prev.id, asset_name: prev.asset_name, asset_tag: prev.asset_tag, serial_number: prev.serial_number },
      records: chain.map(r => ({ id: r.id, status: r.status, holder: nameOf(r.employee_id),
        allocated_date: r.allocated_date, return_date: r.return_date, reissued_from: r.reissued_from })),
      events,
    });
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
    // Delete used to accept any status, so an asset someone still had could
    // vanish from the register. Live records must be returned or disposed first.
    if (!DELETABLE_STATUSES.includes(old.rows[0].status)) {
      return res.status(400).json({
        message: `This asset is ${old.rows[0].status}. Only returned or disposed records can be deleted; return or dispose of it first.`,
      });
    }
    // A record a later allocation was re-issued from is that asset's history.
    const { rows: child } = await pool.query(
      `SELECT id FROM employee_asset_allocations WHERE reissued_from = $1 LIMIT 1`, [req.params.id]);
    if (child.length) {
      return res.status(400).json({
        message: 'This record is part of a re-issued asset\'s history and cannot be deleted.',
      });
    }
    await pool.query(
      `DELETE FROM employee_asset_allocations WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]);
    logAudit({ userId: req.user?.id, module: 'employee_assets', recordId: Number(req.params.id), recordType: 'asset_allocation', action: 'delete', oldData: old.rows[0], req });
    res.json({ message: 'Deleted', id: Number(req.params.id) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
