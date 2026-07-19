/**
 * imr.routes.js — Module Production Batch Request (IMR)
 *
 * A request layer between a project (IPP) and a production batch (production_orders).
 * Header + line-items so Total Quantity always auto-sums from the requested lines.
 *
 * Lifecycle (enforced by status guards on each transition):
 *   draft → submitted → partially_assigned → completed   (+ cancel from any pre-terminal state)
 *
 * Assign Quantity links the request to an EXISTING production_orders row (the batch)
 * and records how much of each requested module has been allocated.
 */
import { Router } from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { nextImrNumber } from '../../shared/docNumber.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = Router();

const actor = (req) => ({
  id:   req.user?.userId || req.user?.id || null,
  name: req.user?.name   || req.user?.email || 'System',
});

/* Resolve the company an IMR should belong to — scoped users use their own,
   a global super-admin falls back to an explicit body company_id, else first company. */
async function resolveCompanyId(client, scope, bodyCompanyId) {
  if (scope?.company_id != null) return scope.company_id;
  if (bodyCompanyId != null)     return bodyCompanyId;
  const { rows } = await client.query('SELECT id FROM companies ORDER BY id LIMIT 1');
  return rows[0]?.id ?? null;
}

/* Derive the header status from its line totals (never manually set on assign). */
function deriveStatus(totalRequested, totalAssigned) {
  if (totalAssigned <= 0) return 'submitted';
  if (totalAssigned >= totalRequested) return 'completed';
  return 'partially_assigned';
}

/* Shared SELECT — header + aggregated line totals + project (IPP) reference. */
const SELECT_LIST = `
  SELECT r.id, r.imr_no, r.company_id, r.project_id, r.production_order_id,
         r.status, r.notes, r.created_by, r.created_by_name,
         r.submitted_at, r.completed_at, r.created_at, r.updated_at,
         c.name        AS company_name,
         p.project_code, p.project_name,
         po.production_order_no,
         COALESCE(l.total_qty, 0)    AS total_quantity,
         COALESCE(l.assigned_qty, 0) AS assigned_qty,
         COALESCE(l.line_count, 0)   AS line_count,
         l.modules_text
  FROM module_production_requests r
  LEFT JOIN companies c        ON c.id = r.company_id
  LEFT JOIN projects p         ON p.id = r.project_id
  LEFT JOIN production_orders po ON po.id = r.production_order_id
  LEFT JOIN LATERAL (
    SELECT SUM(ln.requested_qty)  AS total_qty,
           SUM(ln.assigned_qty)   AS assigned_qty,
           COUNT(*)               AS line_count,
           string_agg(ln.module_spec || ' - ' || TRIM(TO_CHAR(ln.requested_qty, 'FM999999990.###')) || ' ' || ln.unit, E'\n'
                      ORDER BY ln.id) AS modules_text
    FROM module_production_request_lines ln
    WHERE ln.request_id = r.id
  ) l ON TRUE
`;

/* ═══════════════════════════════════════════════════════════════════
   LIST + STATS
═══════════════════════════════════════════════════════════════════ */

router.get('/', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { status, search } = req.query;
    const params = [cid];
    let where = 'WHERE (r.company_id = $1 OR $1 IS NULL)';
    if (status) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) { params.push(statuses[0]); where += ` AND r.status = $${params.length}`; }
      else if (statuses.length > 1) { params.push(statuses); where += ` AND r.status = ANY($${params.length}::text[])`; }
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (r.imr_no ILIKE $${params.length} OR p.project_code ILIKE $${params.length} OR p.project_name ILIKE $${params.length})`;
    }
    const { rows } = await pool.query(`${SELECT_LIST} ${where} ORDER BY r.created_at DESC`, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stats', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                              AS total,
        COUNT(*) FILTER (WHERE status = 'draft')              AS draft,
        COUNT(*) FILTER (WHERE status = 'submitted')          AS submitted,
        COUNT(*) FILTER (WHERE status = 'partially_assigned') AS partially_assigned,
        COUNT(*) FILTER (WHERE status = 'completed')          AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled')          AS cancelled
      FROM module_production_requests
      WHERE (company_id = $1 OR $1 IS NULL)
    `, [cid]);
    const r = rows[0] || {};
    res.json({
      total:              parseInt(r.total) || 0,
      draft:              parseInt(r.draft) || 0,
      submitted:          parseInt(r.submitted) || 0,
      partially_assigned: parseInt(r.partially_assigned) || 0,
      completed:          parseInt(r.completed) || 0,
      cancelled:          parseInt(r.cancelled) || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   DETAIL (header + lines)
═══════════════════════════════════════════════════════════════════ */

router.get('/:id', requirePermission('production', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows } = await pool.query(
      `${SELECT_LIST} WHERE r.id = $1 AND (r.company_id = $2 OR $2 IS NULL)`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });
    const { rows: lines } = await pool.query(
      `SELECT * FROM module_production_request_lines WHERE request_id = $1 ORDER BY id`,
      [req.params.id]
    );
    res.json({ ...rows[0], lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   CREATE (draft)
═══════════════════════════════════════════════════════════════════ */

router.post('/', requirePermission('production', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const { project_id, notes, company_id, lines = [] } = req.body;
    const cleanLines = (Array.isArray(lines) ? lines : [])
      .filter(l => l && String(l.module_spec || '').trim())
      .map(l => ({
        module_spec:   String(l.module_spec).trim(),
        product_id:    l.product_id || null,
        unit:          String(l.unit || 'No.').trim() || 'No.',
        requested_qty: parseFloat(l.requested_qty) || 0,
      }));
    if (!cleanLines.length)
      return res.status(400).json({ error: 'At least one requested module line is required' });

    await client.query('BEGIN');
    const cid = await resolveCompanyId(client, req.scope, company_id);
    const no  = await nextImrNumber(client);
    const a   = actor(req);

    const { rows: [hdr] } = await client.query(
      `INSERT INTO module_production_requests
         (imr_no, company_id, project_id, status, notes, created_by, created_by_name)
       VALUES ($1,$2,$3,'draft',$4,$5,$6)
       RETURNING *`,
      [no, cid, project_id || null, notes || null, a.id, a.name]
    );
    for (const l of cleanLines) {
      await client.query(
        `INSERT INTO module_production_request_lines
           (request_id, module_spec, product_id, unit, requested_qty)
         VALUES ($1,$2,$3,$4,$5)`,
        [hdr.id, l.module_spec, l.product_id, l.unit, l.requested_qty]
      );
    }
    await client.query('COMMIT');
    logAudit({ userId: a.id, module: 'production', recordId: hdr.id, recordType: 'module_production_request',
      action: 'create', newData: { imr_no: no, project_id: project_id ?? null, lines: cleanLines.length }, req });
    res.status(201).json(hdr);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════════════════════════════════════
   EDIT (draft only) — header + full line replacement
═══════════════════════════════════════════════════════════════════ */

router.put('/:id', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { project_id, notes, lines } = req.body;

    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      `SELECT status FROM module_production_requests WHERE id=$1 AND (company_id=$2 OR $2 IS NULL) FOR UPDATE`,
      [req.params.id, cid]
    );
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Request not found' }); }
    if (current.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Only draft requests can be edited (current: ${current.status})` });
    }

    const { rows: [hdr] } = await client.query(
      `UPDATE module_production_requests
       SET project_id=$1, notes=$2, updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [project_id || null, notes || null, req.params.id]
    );

    // Replace lines only when a lines array is supplied
    if (Array.isArray(lines)) {
      const cleanLines = lines
        .filter(l => l && String(l.module_spec || '').trim())
        .map(l => ({
          module_spec:   String(l.module_spec).trim(),
          product_id:    l.product_id || null,
          unit:          String(l.unit || 'No.').trim() || 'No.',
          requested_qty: parseFloat(l.requested_qty) || 0,
        }));
      if (!cleanLines.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'At least one requested module line is required' }); }
      await client.query(`DELETE FROM module_production_request_lines WHERE request_id=$1`, [req.params.id]);
      for (const l of cleanLines) {
        await client.query(
          `INSERT INTO module_production_request_lines
             (request_id, module_spec, product_id, unit, requested_qty)
           VALUES ($1,$2,$3,$4,$5)`,
          [req.params.id, l.module_spec, l.product_id, l.unit, l.requested_qty]
        );
      }
    }
    await client.query('COMMIT');
    logAudit({ userId: actor(req).id, module: 'production', recordId: req.params.id,
      recordType: 'module_production_request', action: 'update', newData: { imr_no: hdr.imr_no }, req });
    res.json(hdr);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════════════════════════════════════
   SUBMIT  (draft → submitted)
═══════════════════════════════════════════════════════════════════ */

router.post('/:id/submit', requirePermission('production', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows } = await pool.query(
      `UPDATE module_production_requests
       SET status='submitted', submitted_at=COALESCE(submitted_at, NOW()), updated_at=NOW()
       WHERE id=$1 AND (company_id=$2 OR $2 IS NULL) AND status='draft'
       RETURNING *`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(400).json({ error: 'Only draft requests can be submitted' });
    logAudit({ userId: actor(req).id, module: 'production', recordId: req.params.id,
      recordType: 'module_production_request', action: 'update',
      oldData: { status: 'draft' }, newData: { status: 'submitted' }, req });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ASSIGN QUANTITY  (submitted / partially_assigned → …)
   body: { production_order_id, assignments: [{ line_id, assigned_qty }] }
═══════════════════════════════════════════════════════════════════ */

router.post('/:id/assign', requirePermission('production', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { production_order_id, assignments = [] } = req.body;

    await client.query('BEGIN');
    const { rows: [hdr] } = await client.query(
      `SELECT * FROM module_production_requests
       WHERE id=$1 AND (company_id=$2 OR $2 IS NULL) FOR UPDATE`,
      [req.params.id, cid]
    );
    if (!hdr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Request not found' }); }
    if (!['submitted', 'partially_assigned'].includes(hdr.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot assign against a ${hdr.status} request` });
    }

    // Validate the linked production order belongs to the same company (the batch/MPP)
    if (production_order_id) {
      const { rows: [po] } = await client.query(
        `SELECT id FROM production_orders WHERE id=$1 AND (company_id=$2 OR $2 IS NULL)`,
        [production_order_id, cid]
      );
      if (!po) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Linked production order not found in this company' }); }
    }

    // Apply per-line assignments, clamped to requested_qty
    for (const asg of (Array.isArray(assignments) ? assignments : [])) {
      const qty = parseFloat(asg?.assigned_qty);
      if (!asg?.line_id || isNaN(qty)) continue;
      await client.query(
        `UPDATE module_production_request_lines
         SET assigned_qty = LEAST(GREATEST($1, 0), requested_qty)
         WHERE id=$2 AND request_id=$3`,
        [qty, asg.line_id, req.params.id]
      );
    }

    // Recompute totals → derive status
    const { rows: [tot] } = await client.query(
      `SELECT COALESCE(SUM(requested_qty),0) AS req, COALESCE(SUM(assigned_qty),0) AS asg
       FROM module_production_request_lines WHERE request_id=$1`,
      [req.params.id]
    );
    const newStatus = deriveStatus(parseFloat(tot.req), parseFloat(tot.asg));

    const { rows: [updated] } = await client.query(
      `UPDATE module_production_requests
       SET status=$1,
           production_order_id=COALESCE($2, production_order_id),
           completed_at = CASE WHEN $1='completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
           updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [newStatus, production_order_id || null, req.params.id]
    );
    await client.query('COMMIT');
    logAudit({ userId: actor(req).id, module: 'production', recordId: req.params.id,
      recordType: 'module_production_request', action: 'update',
      oldData: { status: hdr.status }, newData: { status: newStatus, production_order_id: production_order_id ?? hdr.production_order_id }, req });
    res.json(updated);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════════════════════════════════════
   COMPLETE  (submitted / partially_assigned → completed)
═══════════════════════════════════════════════════════════════════ */

router.post('/:id/complete', requirePermission('production', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows } = await pool.query(
      `UPDATE module_production_requests
       SET status='completed', completed_at=COALESCE(completed_at, NOW()), updated_at=NOW()
       WHERE id=$1 AND (company_id=$2 OR $2 IS NULL) AND status IN ('submitted','partially_assigned')
       RETURNING *`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(400).json({ error: 'Only submitted or partially-assigned requests can be completed' });
    logAudit({ userId: actor(req).id, module: 'production', recordId: req.params.id,
      recordType: 'module_production_request', action: 'update', newData: { status: 'completed' }, req });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   CANCEL  (any pre-terminal state → cancelled)
═══════════════════════════════════════════════════════════════════ */

router.post('/:id/cancel', requirePermission('production', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { reason } = req.body;
    const { rows } = await pool.query(
      `UPDATE module_production_requests
       SET status='cancelled',
           notes=COALESCE($1 || ' | ' || COALESCE(notes,''), notes),
           updated_at=NOW()
       WHERE id=$2 AND (company_id=$3 OR $3 IS NULL) AND status NOT IN ('completed','cancelled')
       RETURNING *`,
      [reason ? `Cancelled: ${reason}` : null, req.params.id, cid]
    );
    if (!rows.length) return res.status(400).json({ error: 'Request cannot be cancelled in its current state' });
    logAudit({ userId: actor(req).id, module: 'production', recordId: req.params.id,
      recordType: 'module_production_request', action: 'update', newData: { status: 'cancelled', reason }, req });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
