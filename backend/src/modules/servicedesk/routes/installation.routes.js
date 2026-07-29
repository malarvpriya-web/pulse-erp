/**
 * Installation as a First-Class Module (Priority 6).
 *
 * Lifecycle: Dispatch -> Installation Request -> Engineer Assignment ->
 * Travel Planning -> Installation -> Commissioning -> Customer Acceptance.
 *
 * Rows are auto-created on Sales Order dispatch (see sales.routes.js's
 * PUT /orders/:id/dispatch) when a project can be resolved; can also be
 * created manually for cases dispatch doesn't cover (e.g. a standalone
 * site visit). All routes: GET/POST /api/installation-requests/*.
 */
import express from 'express';
import pool from '../../../config/db.js';
import { verifyToken } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';
import { createCommissioningWorkflow } from './commissioning.routes.js';

const router = express.Router();
router.use(verifyToken);

const cid = (req) => companyOf(req);
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

async function nextInstallationNo(companyId) {
  const yr = new Date().getFullYear().toString().slice(-2);
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM installation_requests WHERE ($1::int IS NULL OR company_id=$1)`,
    [companyId]
  );
  return `INS-${yr}-${String(parseInt(rows[0].cnt, 10) + 1).padStart(4, '0')}`;
}

// Reusable creation logic — also called from sales.routes.js on dispatch.
// Idempotent: the DB has a partial unique index on (sales_order_id) WHERE
// status NOT IN ('cancelled'), so a retry/re-dispatch can't create a second
// active request for the same order.
export async function createInstallationRequest(companyId, data, actorId) {
  const { sales_order_id, project_id, equipment_id, customer_name, site_address, notes } = data;
  if (sales_order_id) {
    const { rows: existing } = await pool.query(
      `SELECT * FROM installation_requests WHERE sales_order_id=$1 AND status NOT IN ('cancelled')`,
      [sales_order_id]
    );
    if (existing.length) return { installation: existing[0], created: false };
  }
  const installation_number = await nextInstallationNo(companyId);
  const { rows } = await pool.query(
    `INSERT INTO installation_requests
       (company_id, installation_number, sales_order_id, project_id, equipment_id,
        customer_name, site_address, notes, created_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested')
     RETURNING *`,
    [companyId, installation_number, sales_order_id || null, project_id || null, equipment_id || null,
     customer_name || null, site_address || null, notes || null, actorId]
  );
  return { installation: rows[0], created: true };
}

// ── GET /installation-requests ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, project_id } = req.query;
    const params = [companyId];
    let where = `WHERE ($1::int IS NULL OR ir.company_id=$1)`;
    if (status)     { params.push(status);     where += ` AND ir.status=$${params.length}`; }
    if (project_id) { params.push(project_id); where += ` AND ir.project_id=$${params.length}`; }
    const { rows } = await pool.query(
      `SELECT ir.*,
              p.project_code, p.project_name,
              so.order_number,
              CONCAT(e.first_name,' ',e.last_name) AS engineer_name,
              tr.status AS travel_status,
              cw.workflow_number AS commissioning_workflow_number,
              cw.status AS commissioning_status
       FROM installation_requests ir
       LEFT JOIN projects p ON p.id = ir.project_id
       LEFT JOIN sales_orders so ON so.id = ir.sales_order_id
       LEFT JOIN employees e ON e.id = ir.engineer_id
       LEFT JOIN travel_requests tr ON tr.id = ir.travel_request_id
       LEFT JOIN commissioning_workflows cw ON cw.id = ir.commissioning_workflow_id
       ${where}
       ORDER BY ir.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /installation-requests/:id ────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT ir.*,
              p.project_code, p.project_name,
              so.order_number,
              CONCAT(e.first_name,' ',e.last_name) AS engineer_name,
              tr.status AS travel_status, tr.destination AS travel_destination,
              tr.from_date AS travel_from_date, tr.to_date AS travel_to_date,
              cw.workflow_number AS commissioning_workflow_number,
              cw.status AS commissioning_status
       FROM installation_requests ir
       LEFT JOIN projects p ON p.id = ir.project_id
       LEFT JOIN sales_orders so ON so.id = ir.sales_order_id
       LEFT JOIN employees e ON e.id = ir.engineer_id
       LEFT JOIN travel_requests tr ON tr.id = ir.travel_request_id
       LEFT JOIN commissioning_workflows cw ON cw.id = ir.commissioning_workflow_id
       WHERE ir.id=$1 AND ($2::int IS NULL OR ir.company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Installation request not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /installation-requests — manual creation ─────────────────────────────
router.post('/', async (req, res) => {
  try {
    if (!req.body.customer_name) return res.status(400).json({ error: 'customer_name is required' });
    const { installation } = await createInstallationRequest(cid(req), req.body, req.user?.employee_id ?? null);
    logAudit({ userId: uid(req), module: 'installation', recordId: installation.id, recordType: 'installation_request', action: 'create', newData: installation, req });
    res.status(201).json(installation);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /installation-requests/:id/assign-engineer ───────────────────────────
router.post('/:id/assign-engineer', async (req, res) => {
  try {
    const { engineer_id } = req.body;
    if (!engineer_id) return res.status(400).json({ error: 'engineer_id is required' });
    const companyId = cid(req);
    const old = await pool.query(`SELECT * FROM installation_requests WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`, [req.params.id, companyId]);
    if (!old.rows.length) return res.status(404).json({ error: 'Installation request not found' });
    if (old.rows[0].status !== 'requested') {
      return res.status(400).json({ error: `Cannot assign engineer from status '${old.rows[0].status}'` });
    }
    const { rows } = await pool.query(
      `UPDATE installation_requests
          SET engineer_id=$1, engineer_assigned_at=NOW(), status='engineer_assigned', updated_at=NOW()
        WHERE id=$2 RETURNING *`,
      [engineer_id, req.params.id]
    );
    logAudit({ userId: uid(req), module: 'installation', recordId: rows[0].id, recordType: 'installation_request', action: 'assign_engineer', oldData: old.rows[0], newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /installation-requests/:id/plan-travel — creates a real Travel
// Request (travel.routes.js), doesn't just record a date on this row. ───────
router.post('/:id/plan-travel', async (req, res) => {
  const client = await pool.connect();
  try {
    const { from_date, to_date, mode, notes } = req.body;
    if (!from_date || !to_date) return res.status(400).json({ error: 'from_date and to_date are required' });
    const companyId = cid(req);
    await client.query('BEGIN');
    const { rows: irRows } = await client.query(
      `SELECT * FROM installation_requests WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) FOR UPDATE`,
      [req.params.id, companyId]
    );
    if (!irRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Installation request not found' }); }
    const ir = irRows[0];
    if (!ir.engineer_id) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Assign an engineer before planning travel' }); }
    if (!['engineer_assigned', 'travel_planned'].includes(ir.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot plan travel from status '${ir.status}'` });
    }

    const { rows: [travelReq] } = await client.query(
      `INSERT INTO travel_requests
         (employee_id, destination, purpose, from_date, to_date, mode, notes,
          travel_type, project_id, sales_order_id, site_name, status, approval_level, created_by, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Installation',$8,$9,$10,'Pending',0,$11,$12)
       RETURNING *`,
      [ir.engineer_id, ir.site_address || ir.customer_name || 'Site', `Installation — ${ir.installation_number}`,
       from_date, to_date, mode || null, notes || null, ir.project_id, ir.sales_order_id, ir.site_address,
       uid(req), companyId]
    );
    await client.query(
      `INSERT INTO travel_request_approvals (travel_request_id, level, level_name, status)
       VALUES ($1,1,'Reporting Manager','Pending')`,
      [travelReq.id]
    );

    const { rows: updated } = await client.query(
      `UPDATE installation_requests
          SET travel_request_id=$1, scheduled_date=$2, status='travel_planned', updated_at=NOW()
        WHERE id=$3 RETURNING *`,
      [travelReq.id, from_date, ir.id]
    );
    await client.query('COMMIT');
    logAudit({ userId: uid(req), module: 'installation', recordId: updated[0].id, recordType: 'installation_request', action: 'plan_travel', oldData: ir, newData: updated[0], req });
    res.json({ ...updated[0], travel_request: travelReq });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// ── POST /installation-requests/:id/start ─────────────────────────────────────
router.post('/:id/start', async (req, res) => {
  try {
    const companyId = cid(req);
    const old = await pool.query(`SELECT * FROM installation_requests WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`, [req.params.id, companyId]);
    if (!old.rows.length) return res.status(404).json({ error: 'Installation request not found' });
    if (!['engineer_assigned', 'travel_planned'].includes(old.rows[0].status)) {
      return res.status(400).json({ error: `Cannot start installation from status '${old.rows[0].status}'` });
    }
    const { rows } = await pool.query(
      `UPDATE installation_requests SET status='in_progress', actual_start_at=NOW(), updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    logAudit({ userId: uid(req), module: 'installation', recordId: rows[0].id, recordType: 'installation_request', action: 'start', oldData: old.rows[0], newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /installation-requests/:id/complete — optionally hands off straight
// into Commissioning (Installation -> Commissioning, the next chain link). ──
router.post('/:id/complete', async (req, res) => {
  try {
    const { completion_notes, create_commissioning = true, scheduled_date: commissioningDate } = req.body;
    const companyId = cid(req);
    const old = await pool.query(`SELECT * FROM installation_requests WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`, [req.params.id, companyId]);
    if (!old.rows.length) return res.status(404).json({ error: 'Installation request not found' });
    const ir = old.rows[0];
    if (ir.status !== 'in_progress') {
      return res.status(400).json({ error: `Cannot complete from status '${ir.status}' — start the installation first` });
    }

    let commissioningWorkflowId = null;
    if (create_commissioning) {
      const wf = await createCommissioningWorkflow(companyId, {
        project_id: ir.project_id,
        equipment_id: ir.equipment_id,
        customer_name: ir.customer_name || 'Unknown',
        site_address: ir.site_address,
        engineer_id: ir.engineer_id,
        scheduled_date: commissioningDate || new Date().toISOString().split('T')[0],
        notes: `Auto-created on completion of installation ${ir.installation_number}`,
      });
      commissioningWorkflowId = wf.id;
    }

    const { rows } = await pool.query(
      `UPDATE installation_requests
          SET status='completed', actual_end_at=NOW(), completion_notes=$1,
              commissioning_workflow_id=$2, updated_at=NOW()
        WHERE id=$3 RETURNING *`,
      [completion_notes || null, commissioningWorkflowId, req.params.id]
    );
    logAudit({ userId: uid(req), module: 'installation', recordId: rows[0].id, recordType: 'installation_request', action: 'complete', oldData: ir, newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /installation-requests/:id/customer-acceptance ──────────────────────
router.post('/:id/customer-acceptance', async (req, res) => {
  try {
    const { accepted_by, notes } = req.body;
    if (!accepted_by) return res.status(400).json({ error: 'accepted_by is required' });
    const companyId = cid(req);
    const old = await pool.query(`SELECT * FROM installation_requests WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`, [req.params.id, companyId]);
    if (!old.rows.length) return res.status(404).json({ error: 'Installation request not found' });
    if (old.rows[0].status !== 'completed') {
      return res.status(400).json({ error: 'Installation must be completed before customer acceptance' });
    }
    const { rows } = await pool.query(
      `UPDATE installation_requests
          SET customer_accepted=true, customer_accepted_by=$1, customer_accepted_at=NOW(),
              customer_acceptance_notes=$2, updated_at=NOW()
        WHERE id=$3 RETURNING *`,
      [accepted_by, notes || null, req.params.id]
    );
    logAudit({ userId: uid(req), module: 'installation', recordId: rows[0].id, recordType: 'installation_request', action: 'customer_acceptance', oldData: old.rows[0], newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /installation-requests/:id/cancel ───────────────────────────────────
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { reason } = req.body;
    const companyId = cid(req);
    const { rows } = await pool.query(
      `UPDATE installation_requests SET status='cancelled', notes=COALESCE($1, notes), updated_at=NOW()
        WHERE id=$2 AND ($3::int IS NULL OR company_id=$3) AND status NOT IN ('completed','cancelled')
        RETURNING *`,
      [reason || null, req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found, already completed, or already cancelled' });
    logAudit({ userId: uid(req), module: 'installation', recordId: rows[0].id, recordType: 'installation_request', action: 'cancel', newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
