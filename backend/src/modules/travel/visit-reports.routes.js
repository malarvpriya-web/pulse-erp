/**
 * visit-reports.routes.js — customer / site visit reports (/api/v1/visit-reports).
 *
 * Rebuilt 26 Nov 26 (Travel Desk audit). Customer Visits was a second table for
 * the same thing and is merged in here (owner). Flow:
 *
 *   Draft ──submit──▶ Submitted ──manager review──▶ Completed
 *     ▲                    │
 *     └──── Returned ◀─────┘   (with the reviewer's remarks; author fixes, resubmits)
 *
 *  - The author edits all of it while Draft / Returned; the reporting manager
 *    (or delegate rules of managerApprovalAuthz — HR/admin only without one)
 *    reviews it. An author used to mark their own report "Completed".
 *  - Customer, project, opportunity, ticket and trip are links (ids), not text.
 *  - Report numbers VR-YYYY-NNNN never repeat (COUNT(*)+1 did after a delete).
 *  - Reads are scoped like the rest of Travel (travelAccess.travelScope) —
 *    they self-scoped only a primary role of literally 'employee'.
 *  - A visit-type trip's claims cannot be submitted until its report is
 *    Submitted (travel-reimbursement.routes.js).
 */
import express from 'express';
import pool from '../shared/db.js';
import { rolesOf } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import { companyOf } from '../../shared/scope.js';
import { authorizeManagerApproval, DENIED_MESSAGE } from '../../shared/managerApprovalAuthz.js';
import { uid, ownEmployeeId, travelScope, isTravelDesk, seesAllTravel, nextDocNumber, todayLocal, MANDATORY_REPORT_TYPES } from './travelAccess.js';
import { resolveLinks } from './travel.routes.js';

const router = express.Router();
const isId = (v) => /^\d+$/.test(String(v ?? ''));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const EDITABLE = ['Draft', 'Returned'];
const OUTCOMES = ['Positive', 'Neutral', 'Negative', 'Order Expected', 'Issue Resolved', 'Follow-up Needed'];

const SELECT = `
  SELECT vr.*, CONCAT(e.first_name,' ',e.last_name) AS visited_by_name, e.designation, e.department,
         COALESCE(tr.request_number, CASE WHEN tr.id IS NOT NULL THEN 'TR-' || LPAD(tr.id::text,3,'0') END) AS trip_number,
         COALESCE(NULLIF(TRIM(CONCAT(re.first_name,' ',re.last_name)), ''), ru.name) AS reviewed_by_name
    FROM visit_reports vr
    LEFT JOIN employees e ON e.id = vr.visited_by
    LEFT JOIN travel_requests tr ON tr.id = vr.travel_request_id
    LEFT JOIN users ru ON ru.id = vr.reviewed_by
    LEFT JOIN employees re ON re.id = ru.employee_id`;

async function load(req, id) {
  if (!isId(id)) return null;
  const { rows: [r] } = await pool.query(`${SELECT} WHERE vr.id = $1 AND ($2::int IS NULL OR vr.company_id = $2)`, [Number(id), companyOf(req)]);
  return r || null;
}
async function isAuthor(req, r) {
  const eid = await ownEmployeeId(req);
  return (eid != null && Number(r.visited_by) === eid) || Number(r.created_by) === Number(uid(req));
}
async function canSee(req, r) {
  if (!r) return false;
  if (seesAllTravel(req) || (await isAuthor(req, r))) return true;
  const eid = await ownEmployeeId(req);
  if (eid == null) return false;
  const { rows } = await pool.query(`SELECT 1 FROM employees WHERE id = $1 AND reporting_manager_id = $2`, [r.visited_by, eid]);
  return rows.length > 0;
}
const reviewAuth = async (req, r) => authorizeManagerApproval({
  actorEmployeeId: await ownEmployeeId(req), actorRole: req.user?.role, actorRoles: rolesOf(req),
  requesterEmployeeId: r.visited_by, delegateApproverId: null,
});
const fail = (res, err) => (err?.status && err.status < 500)
  ? res.status(err.status).json({ error: err.message })
  : (console.error('[visit-reports]', err?.message), res.status(500).json({ error: 'Something went wrong — please try again' }));

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(ai => ({
      action: String(ai?.action || '').trim(), owner: String(ai?.owner || '').trim() || null,
      due_date: isDate(ai?.due_date) ? ai.due_date : null, status: ai?.status === 'Done' ? 'Done' : 'Open',
    }))
    .filter(ai => ai.action);
}

/** Validate a report body against the caller's company; throws {status}. */
async function cleanReport(req, b, visitedBy) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (!String(b.visit_type || '').trim()) bad('Visit type is required');
  if (!isDate(b.visit_date)) bad('Visit date is required');
  if (b.visit_date > todayLocal()) bad('A visit report is written after the visit — the date cannot be in the future');
  if (!String(b.purpose || '').trim()) bad('Purpose is required');
  if (b.next_followup && !isDate(b.next_followup)) bad('Invalid follow-up date');
  if (b.next_followup && b.next_followup < b.visit_date) bad('The follow-up date cannot be before the visit');
  if (b.outcome && !OUTCOMES.includes(b.outcome)) bad('Choose an outcome from the list');
  let tr = null;
  if (b.travel_request_id) {
    if (!isId(b.travel_request_id)) bad('Invalid trip');
    ({ rows: [tr] } = await pool.query(
      `SELECT id, employee_id, status, customer_id, project_id, opportunity_id, service_ticket_id, site_name, company_id
         FROM travel_requests WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [Number(b.travel_request_id), companyOf(req)]));
    if (!tr) bad('That trip was not found');
    if (Number(tr.employee_id) !== Number(visitedBy)) bad('The trip must be the visitor\'s own');
    if (tr.status !== 'Approved') bad(`That trip is ${tr.status} — link an approved trip`);
  }
  const links = await resolveLinks(pool, companyOf(req), {
    customer_id: b.customer_id || tr?.customer_id, project_id: b.project_id || tr?.project_id,
    opportunity_id: b.opportunity_id || tr?.opportunity_id, service_ticket_id: b.service_ticket_id || tr?.service_ticket_id,
  });
  const lat = b.gps_lat === '' || b.gps_lat == null ? null : Number(b.gps_lat);
  const lng = b.gps_lng === '' || b.gps_lng == null ? null : Number(b.gps_lng);
  if (lat != null && !(lat >= -90 && lat <= 90)) bad('Invalid latitude');
  if (lng != null && !(lng >= -180 && lng <= 180)) bad('Invalid longitude');
  return {
    travel_request_id: tr?.id ?? null, visit_type: String(b.visit_type).trim(),
    ...links,
    site_name: String(b.site_name || tr?.site_name || '').trim() || null,
    visit_date: b.visit_date, purpose: String(b.purpose).trim(),
    discussion_summary: b.discussion_summary ? String(b.discussion_summary) : null,
    action_items: JSON.stringify(cleanItems(b.action_items)),
    next_followup: b.next_followup || null, next_followup_notes: b.next_followup_notes || null,
    attachments: JSON.stringify(Array.isArray(b.attachments) ? b.attachments : []),
    photos: JSON.stringify(Array.isArray(b.photos) ? b.photos : []),
    gps_lat: lat, gps_lng: lng, location: b.location ? String(b.location) : null, outcome: b.outcome || null,
  };
}

// ── Lists ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const params = [companyOf(req)];
    let q = `${SELECT} WHERE ($1::int IS NULL OR vr.company_id = $1)`;
    q += await travelScope(req, params, { empCol: 'vr.visited_by', creatorCol: 'vr.created_by' });
    const f = req.query;
    for (const [k, col] of [['customer_id', 'vr.customer_id'], ['project_id', 'vr.project_id'], ['visited_by', 'vr.visited_by'],
                            ['visit_type', 'vr.visit_type'], ['status', 'vr.status'], ['travel_request_id', 'vr.travel_request_id']]) {
      if (f[k] && f[k] !== 'All') { params.push(String(f[k])); q += ` AND ${col}::text = $${params.length}`; }
    }
    if (isDate(f.from_date)) { params.push(f.from_date); q += ` AND vr.visit_date >= $${params.length}`; }
    if (isDate(f.to_date)) { params.push(f.to_date); q += ` AND vr.visit_date <= $${params.length}`; }
    const lim = Math.min(Math.max(parseInt(f.limit, 10) || 200, 1), 1000);
    const { rows } = await pool.query(`${q} ORDER BY vr.visit_date DESC, vr.id DESC LIMIT ${lim}`, params);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/summary/stats', async (req, res) => {
  try {
    const params = [companyOf(req)];
    const scope = await travelScope(req, params, { empCol: 'vr.visited_by', creatorCol: 'vr.created_by' });
    const { rows: [r] } = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE date_trunc('month', vr.visit_date) = date_trunc('month', CURRENT_DATE))::int AS this_month,
             COUNT(*) FILTER (WHERE vr.status IN ('Draft','Returned'))::int AS pending_reports,
             COUNT(*) FILTER (WHERE vr.status = 'Submitted')::int AS awaiting_review,
             COUNT(*) FILTER (WHERE vr.next_followup BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS upcoming_followups,
             COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(vr.action_items,'[]'::jsonb)) x WHERE COALESCE(x->>'status','Open') <> 'Done')), 0)::int AS open_actions
        FROM visit_reports vr WHERE ($1::int IS NULL OR vr.company_id = $1) ${scope}`, params);
    // Approved visit-type trips that ended with no report yet — the reports owed.
    const p2 = [companyOf(req)];
    const s2 = await travelScope(req, p2, { empCol: 'tr.employee_id', creatorCol: 'tr.created_by' });
    const { rows: owed } = await pool.query(`
      SELECT tr.id, COALESCE(tr.request_number, 'TR-' || tr.id) AS request_number, tr.travel_type, tr.destination,
             tr.to_date, tr.employee_id, CONCAT(e.first_name,' ',e.last_name) AS employee_name
        FROM travel_requests tr LEFT JOIN employees e ON e.id = tr.employee_id
       WHERE tr.status = 'Approved' AND tr.travel_type = ANY($${p2.length + 1}) AND tr.from_date <= CURRENT_DATE
         AND ($1::int IS NULL OR tr.company_id = $1) ${s2}
         AND NOT EXISTS (SELECT 1 FROM visit_reports vr WHERE vr.travel_request_id = tr.id)
       ORDER BY tr.to_date LIMIT 50`, [...p2, [...MANDATORY_REPORT_TYPES]]);
    res.json({ ...r, reports_owed: owed.length, owed });
  } catch (err) { fail(res, err); }
});

router.get('/summary/by-customer', async (req, res) => {
  try {
    const params = [companyOf(req)];
    const scope = await travelScope(req, params, { empCol: 'vr.visited_by', creatorCol: 'vr.created_by' });
    const { rows } = await pool.query(`
      SELECT vr.customer_id, COALESCE(vr.customer_name, 'Not linked') AS customer_name, COUNT(*)::int AS visit_count,
             MAX(vr.visit_date) AS last_visit, STRING_AGG(DISTINCT vr.visit_type, ', ') AS visit_types
        FROM visit_reports vr WHERE ($1::int IS NULL OR vr.company_id = $1) ${scope}
       GROUP BY vr.customer_id, 2 ORDER BY visit_count DESC LIMIT 10`, params);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/summary/by-type', async (req, res) => {
  try {
    const params = [companyOf(req)];
    const scope = await travelScope(req, params, { empCol: 'vr.visited_by', creatorCol: 'vr.created_by' });
    const { rows } = await pool.query(`
      SELECT vr.visit_type, COUNT(*)::int AS count FROM visit_reports vr
       WHERE ($1::int IS NULL OR vr.company_id = $1) ${scope} GROUP BY 1 ORDER BY count DESC`, params);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/check-pending', async (req, res) => {
  try {
    if (!isId(req.query.travel_request_id)) return res.json({ report_required: false, report_submitted: true });
    const { rows: [tr] } = await pool.query(
      `SELECT travel_type FROM travel_requests WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`,
      [Number(req.query.travel_request_id), companyOf(req)]);
    if (!tr || !MANDATORY_REPORT_TYPES.has(tr.travel_type)) return res.json({ report_required: false, report_submitted: true });
    const { rows: [ex] } = await pool.query(
      `SELECT id, status FROM visit_reports WHERE travel_request_id=$1 ORDER BY id DESC LIMIT 1`, [Number(req.query.travel_request_id)]);
    res.json({ report_required: true, report_submitted: !!ex && ['Submitted', 'Completed'].includes(ex.status),
               report_id: ex?.id ?? null, report_status: ex?.status ?? null });
  } catch (err) { fail(res, err); }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await load(req, req.params.id);
    if (!(await canSee(req, r))) return res.status(404).json({ error: 'Report not found' });
    const author = await isAuthor(req, r);
    const auth = r.status === 'Submitted' && !author ? await reviewAuth(req, r) : { authorized: false };
    res.json({ ...r, can_edit: author && EDITABLE.includes(r.status), can_review: auth.authorized,
               can_delete: (author && r.status === 'Draft') || isTravelDesk(req) });
  } catch (err) { fail(res, err); }
});

// ── Write ─────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    let visitedBy = await ownEmployeeId(req);
    if (isTravelDesk(req) && isId(b.visited_by)) visitedBy = Number(b.visited_by);
    if (visitedBy == null) return res.status(403).json({ error: 'No employee record is linked to this account' });
    const v = await cleanReport(req, b, visitedBy);
    const submit = b.status === 'Submitted';
    await client.query('BEGIN');
    const number = await nextDocNumber(client, 'visit_reports', 'report_number', 'VR');
    const { rows: [r] } = await client.query(`
      INSERT INTO visit_reports
        (report_number, travel_request_id, visit_type, customer_id, customer_name, project_id, project_number,
         site_name, opportunity_id, opportunity_ref, service_ticket_id, visited_by, visit_date, purpose,
         discussion_summary, action_items, next_followup, next_followup_notes, attachments, photos,
         gps_lat, gps_lng, location, outcome, status, submitted_at, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
      RETURNING *`,
      [number, v.travel_request_id, v.visit_type, v.customer_id, v.customer_name, v.project_id, v.project_number,
       v.site_name, v.opportunity_id, v.opportunity_ref, v.service_ticket_id, visitedBy, v.visit_date, v.purpose,
       v.discussion_summary, v.action_items, v.next_followup, v.next_followup_notes, v.attachments, v.photos,
       v.gps_lat, v.gps_lng, v.location, v.outcome, submit ? 'Submitted' : 'Draft', submit ? new Date() : null,
       companyOf(req), uid(req)]);
    await client.query('COMMIT');
    logAudit({ userId: uid(req), module: 'visit_reports', recordId: r.id, recordType: 'visit_report', action: 'create', newData: r, req });
    res.status(201).json(r);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally { client.release(); }
});

router.put('/:id', async (req, res) => {
  try {
    const old = await load(req, req.params.id);
    if (!old || !(await isAuthor(req, old))) return res.status(404).json({ error: 'Report not found' });
    if (!EDITABLE.includes(old.status)) return res.status(409).json({ error: `A ${old.status} report can no longer be edited` });
    const v = await cleanReport(req, { ...old, visit_date: String(old.visit_date).slice(0, 10), ...req.body }, old.visited_by);
    const { rows: [r] } = await pool.query(`
      UPDATE visit_reports SET travel_request_id=$1, visit_type=$2, customer_id=$3, customer_name=$4, project_id=$5,
        project_number=$6, site_name=$7, opportunity_id=$8, opportunity_ref=$9, service_ticket_id=$10, visit_date=$11,
        purpose=$12, discussion_summary=$13, action_items=$14, next_followup=$15, next_followup_notes=$16,
        attachments=$17, photos=$18, gps_lat=$19, gps_lng=$20, location=$21, outcome=$22, updated_at=NOW()
      WHERE id=$23 AND status = ANY($24) RETURNING *`,
      [v.travel_request_id, v.visit_type, v.customer_id, v.customer_name, v.project_id, v.project_number, v.site_name,
       v.opportunity_id, v.opportunity_ref, v.service_ticket_id, v.visit_date, v.purpose, v.discussion_summary,
       v.action_items, v.next_followup, v.next_followup_notes, v.attachments, v.photos, v.gps_lat, v.gps_lng,
       v.location, v.outcome, old.id, EDITABLE]);
    if (!r) return res.status(409).json({ error: 'This report was acted on by someone else — reload it' });
    logAudit({ userId: uid(req), module: 'visit_reports', recordId: r.id, recordType: 'visit_report', action: 'update', oldData: old, newData: r, req });
    res.json(r);
  } catch (err) { fail(res, err); }
});

router.post('/:id/submit', async (req, res) => {
  try {
    const old = await load(req, req.params.id);
    if (!old || !(await isAuthor(req, old))) return res.status(404).json({ error: 'Report not found' });
    if (!String(old.discussion_summary || '').trim()) return res.status(400).json({ error: 'Write the discussion summary before submitting' });
    const { rows: [r] } = await pool.query(
      `UPDATE visit_reports SET status='Submitted', submitted_at=NOW(), updated_at=NOW() WHERE id=$1 AND status = ANY($2) RETURNING *`,
      [old.id, EDITABLE]);
    if (!r) return res.status(409).json({ error: `A ${old.status} report cannot be submitted` });
    logAudit({ userId: uid(req), module: 'visit_reports', recordId: r.id, recordType: 'visit_report', action: 'submit', newData: r, req });
    res.json(r);
  } catch (err) { fail(res, err); }
});

// The reporting manager accepts (Completed) or sends back (Returned, remarks required).
router.post('/:id/review', async (req, res) => {
  try {
    const decision = req.body?.decision;
    const remarks = String(req.body?.remarks || '').trim();
    if (!['Completed', 'Returned'].includes(decision)) return res.status(400).json({ error: 'decision must be Completed or Returned' });
    if (decision === 'Returned' && !remarks) return res.status(400).json({ error: 'Say what needs fixing before sending it back' });
    const old = await load(req, req.params.id);
    if (!old) return res.status(404).json({ error: 'Report not found' });
    if (await isAuthor(req, old)) return res.status(403).json({ error: 'You cannot review your own visit report' });
    if (old.status !== 'Submitted') return res.status(409).json({ error: `A ${old.status} report is not waiting for review` });
    const auth = await reviewAuth(req, old);
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    const { rows: [r] } = await pool.query(
      `UPDATE visit_reports SET status=$1, reviewed_by=$2, reviewed_at=NOW(), review_remarks=$3, updated_at=NOW()
        WHERE id=$4 AND status='Submitted' RETURNING *`, [decision, uid(req), remarks || null, old.id]);
    if (!r) return res.status(409).json({ error: 'This report was acted on by someone else — reload it' });
    notifyWorkflowEvent(decision === 'Completed' ? 'approved' : 'rejected',
      { module: 'VisitReport', recordId: r.id, recipientIds: [old.visited_by], comments: remarks });
    logAudit({ userId: uid(req), module: 'visit_reports', recordId: r.id, recordType: 'visit_report', action: `review_${decision.toLowerCase()}`, oldData: old, newData: r, req });
    res.json(r);
  } catch (err) { fail(res, err); }
});

// Tick action items off at any stage — the author or their manager.
router.put('/:id/action-items', async (req, res) => {
  try {
    const old = await load(req, req.params.id);
    if (!(await canSee(req, old))) return res.status(404).json({ error: 'Report not found' });
    if (!(await isAuthor(req, old)) && !(await reviewAuth(req, old)).authorized) return res.status(403).json({ error: 'Only the visitor or their manager updates action items' });
    const items = cleanItems(req.body?.action_items);
    const { rows: [r] } = await pool.query(
      `UPDATE visit_reports SET action_items=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [JSON.stringify(items), old.id]);
    logAudit({ userId: uid(req), module: 'visit_reports', recordId: r.id, recordType: 'visit_report', action: 'action_items', oldData: old, newData: r, req });
    res.json(r);
  } catch (err) { fail(res, err); }
});

router.delete('/:id', async (req, res) => {
  try {
    const old = await load(req, req.params.id);
    if (!old) return res.status(404).json({ error: 'Report not found' });
    const author = await isAuthor(req, old);
    if (!((author && old.status === 'Draft') || isTravelDesk(req))) {
      return res.status(403).json({ error: author ? 'Only a draft can be deleted' : 'You cannot delete this report' });
    }
    await pool.query(`DELETE FROM visit_reports WHERE id=$1`, [old.id]);
    logAudit({ userId: uid(req), module: 'visit_reports', recordId: old.id, recordType: 'visit_report', action: 'delete', oldData: old, req });
    res.json({ message: 'Report deleted' });
  } catch (err) { fail(res, err); }
});

export default router;
