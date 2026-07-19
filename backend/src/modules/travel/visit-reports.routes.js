/**
 * visit-reports.routes.js
 * Phase 47 — Formal Customer / Site Visit Reports
 *
 * Mandatory for: Sales Visits, Application Visits, Commissioning, Service, AMC
 */
import express from 'express';
import pool from '../shared/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
const uid = req => req.user?.userId ?? req.user?.id ?? null;
const cid = req => companyOf(req);

// ── Employee self-scoping ─────────────────────────────────────────────────────
// Employees may only see / file their own visit reports. Ownership is matched
// on visited_by (employees.id, from the JWT / users.employee_id) and
// created_by (users.id).
const isEmployeeRole = (req) => String(req.user?.role || '').toLowerCase() === 'employee';

async function ownEmployeeId(req) {
  if (req.user?.employee_id != null) return req.user.employee_id;
  const userId = uid(req);
  if (!userId) return null;
  try {
    const { rows } = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
    return rows[0]?.employee_id ?? null;
  } catch { return null; }
}

// Visit types that require a formal report
const MANDATORY_REPORT_TYPES = new Set([
  'Sales Visit', 'Application Engineering', 'Commissioning',
  'Service Visit', 'AMC Visit', 'Site Survey', 'Installation',
]);

async function nextReportNumber(companyId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)+1 AS seq FROM visit_reports WHERE company_id=$1`, [companyId]);
  const seq = String(rows[0].seq).padStart(4, '0');
  const yr  = new Date().getFullYear();
  return `VR-${yr}-${seq}`;
}

// ── GET /visit-reports ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { customer_id, project_id, visited_by, visit_type, status,
            from_date, to_date, limit = 100 } = req.query;
    const companyId = cid(req);
    const conditions = [];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`vr.company_id=$${idx++}`); params.push(companyId); }
    if (isEmployeeRole(req)) {
      // Employees always see only their own reports — any visited_by query
      // param from the client is superseded by this filter.
      const eid = await ownEmployeeId(req);
      conditions.push(`(vr.visited_by=$${idx} OR vr.created_by=$${idx + 1})`);
      params.push(eid ?? -1, uid(req) ?? -1);
      idx += 2;
    }
    if (customer_id) { conditions.push(`vr.customer_id=$${idx++}`); params.push(customer_id); }
    if (project_id) { conditions.push(`vr.project_id=$${idx++}`); params.push(project_id); }
    if (visited_by) { conditions.push(`vr.visited_by=$${idx++}`); params.push(visited_by); }
    if (visit_type) { conditions.push(`vr.visit_type=$${idx++}`); params.push(visit_type); }
    if (status) { conditions.push(`vr.status=$${idx++}`); params.push(status); }
    if (from_date) { conditions.push(`vr.visit_date>=$${idx++}`); params.push(from_date); }
    if (to_date) { conditions.push(`vr.visit_date<=$${idx++}`); params.push(to_date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT vr.*,
             CONCAT(e.first_name,' ',e.last_name) AS visited_by_name,
             e.designation, e.department
      FROM visit_reports vr
      LEFT JOIN employees e ON e.id = vr.visited_by
      ${where}
      ORDER BY vr.visit_date DESC, vr.created_at DESC
      LIMIT ${parseInt(limit)}
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /visit-reports/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows: [report] } = await pool.query(`
      SELECT vr.*,
             CONCAT(e.first_name,' ',e.last_name) AS visited_by_name,
             e.designation, e.department
      FROM visit_reports vr
      LEFT JOIN employees e ON e.id = vr.visited_by
      WHERE vr.id=$1`, [req.params.id]);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (isEmployeeRole(req)) {
      const eid = await ownEmployeeId(req);
      const owns = (eid != null && report.visited_by === eid) || report.created_by === uid(req);
      if (!owns) return res.status(403).json({ error: 'You can only view your own visit reports' });
    }
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /visit-reports ───────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const {
      travel_request_id, visit_type,
      customer_id, customer_name,
      project_id, project_number,
      site_id, site_name,
      opportunity_id, opportunity_ref, service_ticket_id,
      visited_by, visit_date, purpose, discussion_summary,
      action_items = [], next_followup, next_followup_notes,
      attachments = [], photos = [],
      gps_lat, gps_lng, location, outcome, status = 'Draft',
    } = req.body;

    if (!visit_date) return res.status(400).json({ error: 'visit_date is required' });
    if (!visited_by && !uid(req)) return res.status(400).json({ error: 'visited_by is required' });

    const actorId = uid(req);
    const companyId = cid(req);
    // Employees can only file visit reports as themselves.
    const visitedBy = isEmployeeRole(req)
      ? ((await ownEmployeeId(req)) ?? actorId)
      : (visited_by || actorId);
    const reportNumber = await nextReportNumber(companyId);

    const { rows: [report] } = await pool.query(`
      INSERT INTO visit_reports
        (report_number, travel_request_id, visit_type,
         customer_id, customer_name, project_id, project_number,
         site_id, site_name, opportunity_id, opportunity_ref, service_ticket_id,
         visited_by, visit_date, purpose, discussion_summary,
         action_items, next_followup, next_followup_notes,
         attachments, photos, gps_lat, gps_lng, location, outcome,
         status, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
              $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
      RETURNING *
    `, [reportNumber, travel_request_id, visit_type,
        customer_id, customer_name, project_id, project_number,
        site_id||null, site_name, opportunity_id||null, opportunity_ref, service_ticket_id||null,
        visitedBy, visit_date, purpose, discussion_summary,
        JSON.stringify(action_items), next_followup||null, next_followup_notes,
        JSON.stringify(attachments), JSON.stringify(photos),
        gps_lat||null, gps_lng||null, location, outcome,
        status, companyId, actorId]);

    logAudit({ userId: actorId, module: 'visit_reports', recordId: report.id,
      recordType: 'visit_report', action: 'create', newData: report });
    res.status(201).json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /visit-reports/:id ────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const {
      visit_type, customer_name, project_number, site_name,
      visited_by, visit_date, purpose, discussion_summary,
      action_items, next_followup, next_followup_notes,
      attachments, photos, gps_lat, gps_lng, location, outcome, status,
    } = req.body;

    if (isEmployeeRole(req)) {
      const { rows: [existing] } = await pool.query(
        `SELECT visited_by, created_by FROM visit_reports WHERE id=$1`, [req.params.id]);
      const eid = await ownEmployeeId(req);
      const owns = existing &&
        ((eid != null && existing.visited_by === eid) || existing.created_by === uid(req));
      if (!owns) return res.status(403).json({ error: 'You can only edit your own visit reports' });
    }

    const { rows: [updated] } = await pool.query(`
      UPDATE visit_reports SET
        visit_type=$1, customer_name=$2, project_number=$3, site_name=$4,
        visited_by=$5, visit_date=$6, purpose=$7, discussion_summary=$8,
        action_items=$9, next_followup=$10, next_followup_notes=$11,
        attachments=$12, photos=$13, gps_lat=$14, gps_lng=$15,
        location=$16, outcome=$17, status=$18, updated_at=NOW()
      WHERE id=$19 RETURNING *
    `, [visit_type, customer_name, project_number, site_name,
        visited_by, visit_date, purpose, discussion_summary,
        JSON.stringify(action_items||[]),
        next_followup||null, next_followup_notes,
        JSON.stringify(attachments||[]), JSON.stringify(photos||[]),
        gps_lat||null, gps_lng||null, location, outcome, status||'Draft',
        req.params.id]);

    if (!updated) return res.status(404).json({ error: 'Report not found' });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /visit-reports/:id ─────────────────────────────────────────────────
router.delete('/:id', allowRoles('admin', 'super_admin', 'manager'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM visit_reports WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Report deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /visit-reports/summary/stats ─────────────────────────────────────────
router.get('/summary/stats', async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? `WHERE company_id=${companyId}` : '';
    const [total, thisMonth, pending, upcoming] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM visit_reports ${cFilter}`),
      pool.query(`SELECT COUNT(*) FROM visit_reports ${cFilter}
        ${cFilter?'AND':'WHERE'} DATE_TRUNC('month',visit_date)=DATE_TRUNC('month',NOW())`),
      pool.query(`SELECT COUNT(*) FROM visit_reports ${cFilter}
        ${cFilter?'AND':'WHERE'} status='Draft'`),
      pool.query(`SELECT COUNT(*) FROM visit_reports ${cFilter}
        ${cFilter?'AND':'WHERE'} next_followup>=NOW() AND next_followup<=NOW()+INTERVAL '7 days'`),
    ]);
    res.json({
      total:             parseInt(total.rows[0].count),
      this_month:        parseInt(thisMonth.rows[0].count),
      pending_reports:   parseInt(pending.rows[0].count),
      upcoming_followups:parseInt(upcoming.rows[0].count),
    });
  } catch { res.json({ total:0, this_month:0, pending_reports:0, upcoming_followups:0 }); }
});

// ── GET /visit-reports/summary/by-customer ────────────────────────────────────
router.get('/summary/by-customer', async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? `WHERE company_id=${companyId}` : '';
    const { rows } = await pool.query(`
      SELECT customer_name, customer_id,
             COUNT(*) AS visit_count,
             MAX(visit_date) AS last_visit,
             STRING_AGG(DISTINCT visit_type, ', ') AS visit_types
      FROM visit_reports ${cFilter}
      GROUP BY customer_name, customer_id
      ORDER BY visit_count DESC LIMIT 10
    `);
    res.json(rows);
  } catch { res.json([]); }
});

// ── GET /visit-reports/summary/by-type ────────────────────────────────────────
router.get('/summary/by-type', async (req, res) => {
  try {
    const companyId = cid(req);
    const cFilter = companyId ? `WHERE company_id=${companyId}` : '';
    const { rows } = await pool.query(`
      SELECT visit_type, COUNT(*) AS count
      FROM visit_reports ${cFilter}
      GROUP BY visit_type ORDER BY count DESC
    `);
    res.json(rows);
  } catch { res.json([]); }
});

// ── GET /visit-reports/check-pending ──────────────────────────────────────────
// Check if a travel_request has a required visit report
router.get('/check-pending', async (req, res) => {
  try {
    const { travel_request_id } = req.query;
    if (!travel_request_id) return res.json({ report_required: false, report_submitted: true });

    const { rows: [tr] } = await pool.query(
      `SELECT travel_type FROM travel_requests WHERE id=$1`, [travel_request_id]);
    const reportRequired = tr && MANDATORY_REPORT_TYPES.has(tr.travel_type);

    if (!reportRequired) return res.json({ report_required: false, report_submitted: true });

    const { rows: [existing] } = await pool.query(
      `SELECT id, status FROM visit_reports WHERE travel_request_id=$1 LIMIT 1`,
      [travel_request_id]);

    res.json({
      report_required: true,
      report_submitted: !!existing,
      report_id: existing?.id || null,
      report_status: existing?.status || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
