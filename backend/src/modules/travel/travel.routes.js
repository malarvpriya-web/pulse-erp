/**
 * travel.routes.js — trips, advances, bookings and travel spend (/api/v1/travel).
 *
 * Rebuilt 26 Nov 26 after the Travel Desk audit. What changed, in short:
 *  - Every read is scoped by travelAccess.travelScope(): company-wide for the
 *    admin/HR/Finance desks, otherwise own + direct reports + delegated. It used
 *    to self-scope only a primary role of literally 'employee'.
 *  - A trip saves its travel type, service ticket, customer, project and
 *    opportunity as real links (ids from pickers), gets a TR-YYYY-NNNN number,
 *    can be edited while Pending and cancelled with a reason.
 *  - One approval path: PUT /requests/:id/status (reporting manager / delegate;
 *    HR/admin only when there is no active manager). A reject needs a reason.
 *    The unused 3-level /level-approve and /finance-post are retired.
 *  - Advances: reporting manager FIRST, then Finance (owner, 26 Nov 26); only
 *    on an approved trip; capped by the trip budget and the policy maximum;
 *    disbursement and refund of unspent advance post to the ledger.
 *  - Bookings are made by the travel desk (admin) only, always against an
 *    approved trip; no more auto-created "pending booking" rows — the desk
 *    works from GET /bookings/queue.
 *  - Trip expenses (travel_expense_items) are merged into Expense Claims.
 *  - Analytics report ACTUAL spend (paid company-borne claims + confirmed
 *    bookings) next to the ESTIMATED budget of approved trips, and are gated
 *    to the desks and line managers.
 */
import express from 'express';
import pool from '../shared/db.js';
import { hasRole, rolesOf, can } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import { companyOf } from '../../shared/scope.js';
import { resolveRange, dimension } from '../../shared/dashboardFilters.js';
import { authorizeManagerApproval, DENIED_MESSAGE } from '../../shared/managerApprovalAuthz.js';
import { initiateWorkflow, getWorkflowStatus, advanceWorkflow, cancelWorkflow } from '../../services/WorkflowService.js';
import {
  uid, seesAllTravel, isTravelDesk, ownEmployeeId, travelScope, canSeeTrip, ownsTrip,
  nextDocNumber, todayLocal, monthEnd, policyRuleFor,
  ADVANCE_FINANCE_ROLES, TRAVEL_ANALYTICS_ROLES, TRAVEL_DESK_ROLES,
} from './travelAccess.js';
import { postAdvanceDisbursement, postAdvanceRefund, TravelGlError } from './travelGl.service.js';

const router = express.Router();

const isId = (v) => /^\d+$/.test(String(v ?? ''));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const NOT_LINKED = 'No employee record is linked to this account';
const TRAVEL_MODES = ['Flight', 'Train', 'Bus', 'Car', 'Cab', 'Two-Wheeler', 'Other'];
const BOOKING_TYPES = ['Flight', 'Train', 'Bus', 'Cab', 'Hotel', 'Other'];

const gate = (roles) => (req, res, next) =>
  hasRole(req, ...roles) ? next() : res.status(403).json({ error: 'You do not have access to this travel report' });
const deskOnly = (req, res, next) =>
  isTravelDesk(req) ? next() : res.status(403).json({ error: 'Bookings are made by the travel desk (admin)' });

const actorAuth = async (req, requesterEmployeeId, delegateApproverId) => authorizeManagerApproval({
  actorEmployeeId: await ownEmployeeId(req),
  actorRole: req.user?.role,
  actorRoles: rolesOf(req),
  requesterEmployeeId,
  delegateApproverId,
});

const fail = (res, err) => {
  if (err instanceof TravelGlError) return res.status(err.status).json({ code: err.code, error: err.message, problems: err.problems });
  if (err?.status && err.status < 500) return res.status(err.status).json({ code: err.code, error: err.message });
  console.error('[travel]', err?.message);
  return res.status(500).json({ error: 'Something went wrong — please try again' });
};

async function loadInCompany(table, req, id, client = pool) {
  if (!isId(id)) return null;
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [Number(id), companyOf(req)]);
  return rows[0] || null;
}
const loadTrip    = (req, id, c) => loadInCompany('travel_requests', req, id, c);
const loadAdvance = (req, id, c) => loadInCompany('travel_advances', req, id, c);
const decidedElsewhere = (res, what = 'request') =>
  res.status(409).json({ error: `This ${what} was already acted on — refresh to see its current status.` });

async function assertDelegateEligible(delegateId, companyId, requesterEmployeeId) {
  if (!isId(delegateId)) return 'Choose the employee to delegate to';
  const { rows: [d] } = await pool.query(
    `SELECT id FROM employees
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL
        AND LOWER(status) IN ('active', 'probation', 'notice')`, [Number(delegateId), companyId ?? null]);
  if (!d) return 'The delegate must be an active employee in the same company';
  if (requesterEmployeeId != null && Number(d.id) === Number(requesterEmployeeId)) return 'A request cannot be delegated to the person who raised it';
  return null;
}

const TRIP_SELECT = `
  SELECT tr.*,
         COALESCE(tr.request_number, 'TR-' || LPAD(tr.id::text, 3, '0')) AS request_number,
         COALESCE(NULLIF(TRIM(CONCAT(e.first_name,' ',e.last_name)), ''), tr.employee_name) AS employee_name,
         COALESCE(tr.department, e.department) AS department,
         e.reporting_manager_id,
         st.ticket_number AS service_ticket_number,
         COALESCE(du.name, NULLIF(TRIM(CONCAT(de.first_name,' ',de.last_name)), '')) AS decided_by_name,
         NULLIF(TRIM(CONCAT(dl.first_name,' ',dl.last_name)), '') AS delegate_name
    FROM travel_requests tr
    LEFT JOIN employees e  ON e.id  = tr.employee_id
    LEFT JOIN support_tickets st ON st.id = tr.service_ticket_id
    LEFT JOIN users du     ON du.id = tr.decided_by
    LEFT JOIN employees de ON de.id = du.employee_id
    LEFT JOIN employees dl ON dl.id = tr.delegate_approver_id`;

// ── Pickers ───────────────────────────────────────────────────────────────────
// Customer, project, ticket and opportunity were free-text boxes, so no trip or
// claim ever linked to a real record: Customer 360, Project 360, project
// profitability and the project cost ledger all read nothing. These lists feed
// the pickers; employees cannot call the CRM / project lists directly.
router.get('/lookups/:kind', async (req, res) => {
  const cid = companyOf(req);
  const q = String(req.query.q || '').trim();
  const like = q ? `%${q}%` : null;
  try {
    let rows;
    switch (req.params.kind) {
      case 'customers':
        ({ rows } = await pool.query(
          `SELECT id, COALESCE(NULLIF(account_name,''), name) AS name FROM accounts
            WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
              AND ($2::text IS NULL OR COALESCE(account_name, name) ILIKE $2)
            ORDER BY 2 LIMIT 300`, [cid, like]));
        break;
      case 'projects':
        ({ rows } = await pool.query(
          `SELECT id, COALESCE(project_number, project_code) AS number, project_name, customer_name,
                  CONCAT_WS(' — ', COALESCE(project_number, project_code), project_name) AS name
             FROM projects WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
              AND ($2::text IS NULL OR CONCAT(project_number, project_code, project_name) ILIKE $2)
            ORDER BY id DESC LIMIT 300`, [cid, like]));
        break;
      case 'tickets':
        ({ rows } = await pool.query(
          `SELECT id, ticket_number, CONCAT_WS(' — ', ticket_number, title) AS name FROM support_tickets
            WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
              AND ($2::text IS NULL OR CONCAT(ticket_number, title) ILIKE $2)
            ORDER BY id DESC LIMIT 300`, [cid, like]));
        break;
      case 'opportunities':
        ({ rows } = await pool.query(
          `SELECT id, opportunity_number, CONCAT_WS(' — ', opportunity_number, opportunity_name) AS name FROM opportunities
            WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
              AND ($2::text IS NULL OR CONCAT(opportunity_number, opportunity_name) ILIKE $2)
            ORDER BY id DESC LIMIT 300`, [cid, like]));
        break;
      case 'employees':
        // Raising a trip for someone else is the travel desk's job only.
        if (!isTravelDesk(req)) return res.status(403).json({ error: 'Only the travel desk raises trips for others' });
        ({ rows } = await pool.query(
          `SELECT id, CONCAT_WS(' ', first_name, last_name) AS name, department FROM employees
            WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
              AND LOWER(status) IN ('active','probation','notice')
            ORDER BY first_name LIMIT 1000`, [cid]));
        break;
      case 'trips': {
        // ?for=claim|advance|booking|visit — the trips a picker may offer.
        const purpose = String(req.query.for || 'claim');
        const params = [cid];
        let where = `($1::int IS NULL OR tr.company_id = $1)`;
        if (purpose === 'booking') {
          if (!isTravelDesk(req)) return res.json([]);
          where += ` AND tr.status = 'Approved'`;
        } else {
          where += ` AND tr.status = 'Approved'`;
          // Claims, advances and visit reports are filed for one's OWN trip;
          // the desk may pick anyone's.
          if (!isTravelDesk(req)) {
            params.push((await ownEmployeeId(req)) ?? -1, uid(req) ?? -1);
            where += ` AND (tr.employee_id = $2 OR tr.created_by = $3)`;
          }
        }
        ({ rows } = await pool.query(
          `SELECT tr.id, COALESCE(tr.request_number, 'TR-' || LPAD(tr.id::text, 3, '0')) AS request_number,
                  tr.destination, tr.travel_type, tr.from_date, tr.to_date, tr.budget, tr.mode,
                  tr.customer_id, tr.customer_name, tr.project_id, tr.project_number, tr.site_name,
                  tr.opportunity_id, tr.po_number, tr.employee_id, tr.employee_name,
                  CONCAT(COALESCE(tr.request_number, 'TR-' || tr.id), ' — ', tr.destination,
                         ' (', TO_CHAR(tr.from_date, 'DD Mon YY'), ')') AS name
             FROM travel_requests tr WHERE ${where}
            ORDER BY tr.from_date DESC LIMIT 300`, params));
        break;
      }
      default:
        return res.status(404).json({ error: 'Unknown list' });
    }
    res.json(rows);
  } catch (err) { fail(res, err); }
});

/**
 * Resolve the linked records a trip (or claim) names, inside the company. The
 * names stored next to the ids always come from the record, never from typing.
 */
export async function resolveLinks(db, companyId, b) {
  const out = { customer_id: null, customer_name: null, project_id: null, project_number: null,
                opportunity_id: null, opportunity_ref: null, service_ticket_id: null };
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (b.project_id) {
    if (!isId(b.project_id)) bad('Invalid project');
    const { rows: [p] } = await db.query(
      `SELECT id, COALESCE(project_number, project_code) AS number, customer_name FROM projects
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`, [Number(b.project_id), companyId]);
    if (!p) bad('That project was not found');
    out.project_id = p.id; out.project_number = p.number; out.customer_name = p.customer_name;
  }
  if (b.customer_id) {
    if (!isId(b.customer_id)) bad('Invalid customer');
    const { rows: [c] } = await db.query(
      `SELECT id, COALESCE(NULLIF(account_name,''), name) AS name FROM accounts
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`, [Number(b.customer_id), companyId]);
    if (!c) bad('That customer was not found');
    out.customer_id = c.id; out.customer_name = c.name;
  }
  if (b.opportunity_id) {
    if (!isId(b.opportunity_id)) bad('Invalid opportunity');
    const { rows: [o] } = await db.query(
      `SELECT id, opportunity_number FROM opportunities
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`, [Number(b.opportunity_id), companyId]);
    if (!o) bad('That opportunity was not found');
    out.opportunity_id = o.id; out.opportunity_ref = o.opportunity_number;
  }
  if (b.service_ticket_id) {
    if (!isId(b.service_ticket_id)) bad('Invalid service ticket');
    const { rows: [t] } = await db.query(
      `SELECT id FROM support_tickets WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [Number(b.service_ticket_id), companyId]);
    if (!t) bad('That service ticket was not found');
    out.service_ticket_id = t.id;
  }
  return out;
}

/** Validate a trip body; throws {status:400}. Returns the cleaned values. */
async function cleanTrip(db, req, b, emp) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  const destination = String(b.destination || '').trim();
  const purpose = String(b.purpose || '').trim();
  const travelType = String(b.travel_type || '').trim();
  if (!destination) bad('Destination is required');
  if (!purpose) bad('Purpose is required');
  if (!travelType) bad('Travel type is required');
  if (!isDate(b.from_date) || !isDate(b.to_date)) bad('Start and end dates are required');
  if (b.to_date < b.from_date) bad('The end date cannot be before the start date');
  const budget = b.budget === '' || b.budget == null ? 0 : Number(b.budget);
  if (!(budget >= 0)) bad('Estimated cost cannot be negative');
  const mode = b.mode && TRAVEL_MODES.includes(b.mode) ? b.mode : 'Other';
  // Travel policy: flight eligibility by grade / role / department.
  if (mode === 'Flight') {
    const rule = await policyRuleFor(db, companyOf(req), emp, b.from_date);
    if (rule && rule.flight_eligible === false) {
      bad(`Your travel policy (${rule.rule_name}) does not allow flights — choose ${rule.train_class || 'train'} or another mode`);
    }
  }
  const links = await resolveLinks(db, companyOf(req), b);
  return {
    destination, purpose, travel_type: travelType, from_date: b.from_date, to_date: b.to_date, budget, mode,
    hotel_required: !!b.hotel_required, advance_required: !!b.advance_required,
    notes: b.notes ? String(b.notes) : null,
    site_name: b.site_name ? String(b.site_name).trim() : null,
    po_number: b.po_number ? String(b.po_number).trim() : null,
    ...links,
  };
}

async function travellerFor(req, client, bodyEmployeeId) {
  let empId = await ownEmployeeId(req);
  if (isTravelDesk(req) && bodyEmployeeId) empId = Number(bodyEmployeeId);
  if (empId == null) { const e = new Error(NOT_LINKED); e.status = 403; throw e; }
  const { rows: [emp] } = await client.query(
    `SELECT id, first_name, last_name, department, grade, designation, company_id FROM employees
      WHERE id = $1 AND deleted_at IS NULL`, [empId]);
  const cid = companyOf(req);
  if (!emp || (cid != null && emp.company_id !== cid)) { const e = new Error(isTravelDesk(req) && bodyEmployeeId ? 'That employee was not found' : NOT_LINKED); e.status = 403; throw e; }
  return emp;
}

// ── Trips ─────────────────────────────────────────────────────────────────────
router.get('/requests', async (req, res) => {
  try {
    const params = [companyOf(req)];
    let q = `${TRIP_SELECT} WHERE ($1::int IS NULL OR tr.company_id = $1)`;
    q += await travelScope(req, params, { empCol: 'tr.employee_id', creatorCol: 'tr.created_by', delegateCol: 'tr.delegate_approver_id' });
    if (req.query.mine === '1') {
      params.push((await ownEmployeeId(req)) ?? -1, uid(req) ?? -1);
      q += ` AND (tr.employee_id = $${params.length - 1} OR tr.created_by = $${params.length})`;
    }
    if (req.query.status && req.query.status !== 'All') { params.push(String(req.query.status)); q += ` AND LOWER(tr.status) = LOWER($${params.length})`; }
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    q += ` ORDER BY tr.created_at DESC LIMIT ${lim}`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/requests/:id', async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'Trip not found' });
    const { rows: [tr] } = await pool.query(`${TRIP_SELECT} WHERE tr.id = $1 AND ($2::int IS NULL OR tr.company_id = $2)`,
      [Number(req.params.id), companyOf(req)]);
    if (!tr || !(await canSeeTrip(req, tr))) return res.status(404).json({ error: 'Trip not found' });
    const [adv, book, claims, visit] = await Promise.all([
      pool.query(`SELECT id, amount, status, settled_amount, refund_amount FROM travel_advances WHERE travel_request_id = $1 ORDER BY id`, [tr.id]),
      pool.query(`SELECT id, booking_type, airline_train, booking_ref, amount, status, from_date, to_date FROM travel_bookings WHERE travel_request_id = $1 ORDER BY id`, [tr.id]),
      pool.query(`SELECT id, claim_number, expense_type, total_amount, status, borne_by FROM expense_claims WHERE travel_request_id = $1 AND deleted_at IS NULL ORDER BY id`, [tr.id]),
      pool.query(`SELECT id, report_number, status FROM visit_reports WHERE travel_request_id = $1 ORDER BY id DESC LIMIT 1`, [tr.id]),
    ]);
    const auth = tr.status === 'Pending' ? await actorAuth(req, tr.employee_id, tr.delegate_approver_id) : { authorized: false };
    res.json({
      ...tr,
      advances: adv.rows, bookings: book.rows, claims: claims.rows, visit_report: visit.rows[0] || null,
      can_decide: auth.authorized,
      can_edit: tr.status === 'Pending' && ((await ownsTrip(req, tr)) || isTravelDesk(req)),
      can_cancel: ['Pending', 'Approved'].includes(tr.status) && ((await ownsTrip(req, tr)) || isTravelDesk(req)),
    });
  } catch (err) { fail(res, err); }
});

async function createTrip(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const emp = await travellerFor(req, client, req.body?.employee_id);
    const t = await cleanTrip(client, req, req.body || {}, emp);
    const number = await nextDocNumber(client, 'travel_requests', 'request_number', 'TR');
    const actorId = uid(req);
    const { rows: [trip] } = await client.query(
      `INSERT INTO travel_requests
         (request_number, employee_id, employee_name, department, travel_type, service_ticket_id,
          customer_id, customer_name, project_id, project_number, site_name,
          opportunity_id, opportunity_ref, po_number,
          destination, purpose, from_date, to_date, budget, mode, hotel_required, advance_required, notes,
          status, approval_level, created_by, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'Pending',0,$24,$25)
       RETURNING *`,
      [number, emp.id, `${emp.first_name || ''} ${emp.last_name || ''}`.trim(), emp.department || null,
       t.travel_type, t.service_ticket_id, t.customer_id, t.customer_name, t.project_id, t.project_number, t.site_name,
       t.opportunity_id, t.opportunity_ref, t.po_number,
       t.destination, t.purpose, t.from_date, t.to_date, t.budget, t.mode, t.hotel_required, t.advance_required, t.notes,
       actorId, companyOf(req) ?? emp.company_id]);
    await client.query('COMMIT');
    logAudit({ userId: actorId, module: 'travel', recordId: trip.id, recordType: 'travel_request', action: 'create', newData: trip, req });
    initiateWorkflow('travel', trip.id, 'travel_request', actorId)
      .catch((e) => console.warn('[travel] initiateWorkflow failed:', e.message));
    res.status(201).json(trip);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally { client.release(); }
}
router.post('/requests', createTrip);
router.post('/requests/v2', createTrip); // older callers

// Edit while still Pending — the traveller or the travel desk.
router.put('/requests/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await loadTrip(req, req.params.id, client);
    if (!old || !((await ownsTrip(req, old)) || isTravelDesk(req))) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Trip not found' }); }
    if (old.status !== 'Pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: `A ${old.status} trip can no longer be edited` }); }
    const { rows: [emp] } = await client.query(`SELECT id, grade, designation, department FROM employees WHERE id = $1`, [old.employee_id]);
    const t = await cleanTrip(client, req, req.body || {}, emp);
    const { rows: [trip] } = await client.query(
      `UPDATE travel_requests SET travel_type=$1, service_ticket_id=$2, customer_id=$3, customer_name=$4,
          project_id=$5, project_number=$6, site_name=$7, opportunity_id=$8, opportunity_ref=$9, po_number=$10,
          destination=$11, purpose=$12, from_date=$13, to_date=$14, budget=$15, mode=$16,
          hotel_required=$17, advance_required=$18, notes=$19, updated_at=NOW()
        WHERE id=$20 AND status='Pending' RETURNING *`,
      [t.travel_type, t.service_ticket_id, t.customer_id, t.customer_name, t.project_id, t.project_number, t.site_name,
       t.opportunity_id, t.opportunity_ref, t.po_number, t.destination, t.purpose, t.from_date, t.to_date, t.budget, t.mode,
       t.hotel_required, t.advance_required, t.notes, old.id]);
    if (!trip) { await client.query('ROLLBACK'); return decidedElsewhere(res, 'trip'); }
    await client.query('COMMIT');
    logAudit({ userId: uid(req), module: 'travel', recordId: trip.id, recordType: 'travel_request', action: 'update', oldData: old, newData: trip, req });
    res.json(trip);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally { client.release(); }
});

// Cancel with a reason — the traveller (before the trip starts) or the desk.
router.post('/requests/:id/cancel', async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Please give a reason for cancelling' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tr = await loadTrip(req, req.params.id, client);
    const desk = isTravelDesk(req);
    if (!tr || !((await ownsTrip(req, tr)) || desk)) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Trip not found' }); }
    if (!['Pending', 'Approved'].includes(tr.status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: `A ${tr.status} trip cannot be cancelled` }); }
    // DATE columns arrive as 'YYYY-MM-DD' strings (config/db.js), so text order is date order.
    if (!desk && tr.status === 'Approved' && tr.from_date && String(tr.from_date).slice(0, 10) <= todayLocal()) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This trip has already started — ask the travel desk to cancel it' });
    }
    const { rows: [blk] } = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM expense_claims WHERE travel_request_id = $1 AND deleted_at IS NULL AND status <> 'Draft'
             AND status NOT IN ('Manager Rejected','Accounts Rejected','Mgmt Rejected'))::int AS claims,
         (SELECT COUNT(*) FROM travel_advances WHERE travel_request_id = $1 AND status IN ('Disbursed','Partially Settled'))::int AS paid_adv`, [tr.id]);
    if (blk.claims) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Expense claims are already filed on this trip — it cannot be cancelled' }); }
    if (blk.paid_adv) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'An advance was paid on this trip — Finance must record its refund before the trip is cancelled' }); }
    const actorId = uid(req);
    const { rows: [updated] } = await client.query(
      `UPDATE travel_requests SET status='Cancelled', cancel_reason=$1, cancelled_by=$2, cancelled_at=NOW(), updated_at=NOW()
        WHERE id=$3 AND status=$4 RETURNING *`, [reason, actorId, tr.id, tr.status]);
    if (!updated) { await client.query('ROLLBACK'); return decidedElsewhere(res, 'trip'); }
    await client.query(`UPDATE travel_bookings SET status='Cancelled', cancel_reason=$1, updated_at=NOW() WHERE travel_request_id=$2 AND status <> 'Cancelled'`,
      [`Trip cancelled: ${reason}`, tr.id]);
    await client.query(`UPDATE travel_advances SET status='Cancelled', updated_at=NOW() WHERE travel_request_id=$1 AND status IN ('Pending Manager','Pending Finance','Approved','Finance Rejected','Rejected')`, [tr.id]);
    await client.query(`UPDATE expense_claims SET deleted_at=NOW(), updated_at=NOW() WHERE travel_request_id=$1 AND status='Draft' AND deleted_at IS NULL`, [tr.id]);
    await client.query('COMMIT');
    cancelWorkflow('travel', tr.id, actorId).catch(() => {});
    logAudit({ userId: actorId, module: 'travel', recordId: tr.id, recordType: 'travel_request', action: 'cancel', oldData: tr, newData: updated, req });
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally { client.release(); }
});

// Approve / Reject — the ONE decision path (Travel Approvals and the Approval
// Center both call it). A reject needs a reason.
router.put('/requests/:id/status', async (req, res) => {
  try {
    const raw = String(req.body?.status || '');
    const status = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    const comments = String(req.body?.comments ?? req.body?.remarks ?? '').trim();
    if (status === 'Cancelled') return res.status(400).json({ error: 'Cancel a trip with POST /travel/requests/:id/cancel and a reason' });
    if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });
    // Not found / already decided / not yours come BEFORE the reason check, so
    // another company's trip reads exactly like a missing one.
    const old = await loadTrip(req, req.params.id);
    if (!old) return res.status(404).json({ error: 'Trip not found' });
    if (old.status !== 'Pending') return res.status(409).json({ error: `A ${old.status} trip cannot be ${status.toLowerCase()}` });
    const auth = await actorAuth(req, old.employee_id, old.delegate_approver_id);
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    if (status === 'Rejected' && !comments) return res.status(400).json({ error: 'Please give a reason for rejecting' });

    const actorId = uid(req);
    const { rows: [updated] } = await pool.query(
      `UPDATE travel_requests SET status=$1::varchar, decided_by=$2::int, decided_at=NOW(), decision_comments=$3,
              approved_by_rm = CASE WHEN $1::varchar = 'Approved' THEN $2::int ELSE approved_by_rm END, updated_at=NOW()
        WHERE id=$4 AND status='Pending' RETURNING *`, [status, actorId, comments || null, old.id]);
    if (!updated) return decidedElsewhere(res, 'trip');

    let advancedViaEngine = false;
    try {
      const instance = await getWorkflowStatus('travel', old.id);
      if (instance && !['approved', 'rejected', 'cancelled'].includes(instance.status)) {
        await advanceWorkflow(instance.id, status === 'Approved' ? 'approve' : 'reject', actorId, comments);
        advancedViaEngine = true;
      }
    } catch (e) { console.warn('[travel] workflow mirror failed, status already updated:', e.message); }

    logAudit({ userId: actorId, module: 'travel', recordId: updated.id, recordType: 'travel_request',
      action: status === 'Approved' ? 'approve' : 'reject', oldData: old, newData: updated, req });
    if (!advancedViaEngine) {
      notifyWorkflowEvent(status === 'Approved' ? 'approved' : 'rejected',
        { module: 'Travel', recordId: updated.id, submitterUserId: updated.created_by, comments });
    }
    res.json(updated);
  } catch (err) { fail(res, err); }
});

router.post('/requests/:id/delegate', async (req, res) => {
  try {
    const { delegate_employee_id } = req.body || {};
    const tr = await loadTrip(req, req.params.id);
    if (!tr) return res.status(404).json({ error: 'Trip not found' });
    if (tr.status !== 'Pending') return res.status(409).json({ error: `A ${tr.status} trip cannot be delegated` });
    const auth = await actorAuth(req, tr.employee_id, tr.delegate_approver_id);
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    const bad = await assertDelegateEligible(delegate_employee_id, tr.company_id, tr.employee_id);
    if (bad) return res.status(400).json({ error: bad });
    const { rows: [updated] } = await pool.query(
      `UPDATE travel_requests SET delegate_approver_id=$1, updated_at=NOW() WHERE id=$2 AND status='Pending' RETURNING *`,
      [Number(delegate_employee_id), tr.id]);
    if (!updated) return decidedElsewhere(res, 'trip');
    logAudit({ userId: uid(req), module: 'travel', recordId: updated.id, recordType: 'travel_request', action: 'delegate', newData: { delegate_employee_id }, req });
    res.json(updated);
  } catch (err) { fail(res, err); }
});

// Retired: an unused 3-level approval and a trip-level "finance post" that no
// screen called, which disagreed with the real single-step decision.
router.put('/requests/:id/level-approve', (_req, res) => res.status(410).json({ error: 'Trips are approved with PUT /travel/requests/:id/status' }));
router.put('/requests/:id/finance-post', (_req, res) => res.status(410).json({ error: 'Trip spend is posted when its expense claims are paid' }));
router.get('/requests/:id/approvals', (_req, res) => res.status(410).json({ error: 'See GET /travel/requests/:id (decided_by / decided_at)' }));

// Travel Approvals: the trips the caller can see except their own, each marked
// with whether the caller may decide it.
router.get('/approvals', async (req, res) => {
  try {
    const status = req.query.status && req.query.status !== 'All' ? String(req.query.status) : null;
    const eid = (await ownEmployeeId(req)) ?? -1;
    const params = [companyOf(req), eid];
    let q = `${TRIP_SELECT} WHERE ($1::int IS NULL OR tr.company_id = $1) AND tr.employee_id IS DISTINCT FROM $2`;
    q += await travelScope(req, params, { empCol: 'tr.employee_id', delegateCol: 'tr.delegate_approver_id' });
    if (status) { params.push(status); q += ` AND LOWER(tr.status) = LOWER($${params.length})`; }
    q += ` ORDER BY tr.created_at DESC LIMIT 300`;
    const { rows } = await pool.query(q, params);
    for (const r of rows) {
      r.can_decide = r.status === 'Pending' ? (await actorAuth(req, r.employee_id, r.delegate_approver_id)).authorized : false;
    }
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/calendar', async (req, res) => {
  try {
    const m = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : todayLocal().slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    // monthEnd() builds the date as text — new Date(y, m, 0).toISOString()
    // shifted it to the previous day under IST and hid the month's last day.
    const params = [`${m}-01`, monthEnd(y, mo), companyOf(req)];
    let q = `SELECT tr.id, COALESCE(tr.request_number, 'TR-' || LPAD(tr.id::text, 3, '0')) AS request_number,
                    COALESCE(NULLIF(TRIM(CONCAT(e.first_name,' ',e.last_name)), ''), tr.employee_name) AS employee_name,
                    tr.destination, tr.purpose, tr.travel_type,
                    TO_CHAR(tr.from_date, 'YYYY-MM-DD') AS from_date,
                    TO_CHAR(COALESCE(tr.to_date, tr.from_date), 'YYYY-MM-DD') AS to_date, tr.status
               FROM travel_requests tr LEFT JOIN employees e ON e.id = tr.employee_id
              WHERE tr.from_date <= $2::date AND COALESCE(tr.to_date, tr.from_date) >= $1::date
                AND tr.status IN ('Pending','Approved')
                AND ($3::int IS NULL OR tr.company_id = $3)`;
    q += await travelScope(req, params, { empCol: 'tr.employee_id', creatorCol: 'tr.created_by', delegateCol: 'tr.delegate_approver_id' });
    q += ` ORDER BY tr.from_date`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/recent-requests', async (req, res) => {
  try {
    const params = [companyOf(req)];
    const scope = await travelScope(req, params, { empCol: 'tr.employee_id', creatorCol: 'tr.created_by', delegateCol: 'tr.delegate_approver_id' });
    const where = `WHERE ($1::int IS NULL OR tr.company_id = $1) ${scope}`;
    const { rows } = await pool.query(
      `SELECT tr.id, COALESCE(tr.request_number, 'TR-' || LPAD(tr.id::text, 3, '0')) AS request_number,
              COALESCE(NULLIF(TRIM(CONCAT(e.first_name,' ',e.last_name)), ''), tr.employee_name) AS employee_name,
              tr.destination, tr.purpose, tr.from_date AS travel_date, tr.budget, tr.status
         FROM travel_requests tr LEFT JOIN employees e ON e.id = tr.employee_id
        ${where} ORDER BY tr.id DESC LIMIT 10`, params);
    const { rows: [k] } = await pool.query(
      `SELECT COUNT(*)::int AS total_requests,
              COALESCE(SUM(budget) FILTER (WHERE status = 'Approved'), 0) AS total_budget,
              COUNT(*) FILTER (WHERE status = 'Pending')::int AS pending_count,
              COUNT(*) FILTER (WHERE status = 'Approved')::int AS approved_count
         FROM travel_requests tr ${where}`, params);
    res.json({ requests: rows, ...k, total_budget: Number(k.total_budget) });
  } catch (err) { fail(res, err); }
});

// The caller's own trips (advance / dashboard pickers).
router.get('/my-entries', async (req, res) => {
  try {
    const params = [(await ownEmployeeId(req)) ?? -1, uid(req) ?? -1, companyOf(req)];
    // Matches employees.id and the filing login only. It also used to match
    // employee_id = the caller's USERS id, which showed another employee's
    // trips to whoever's login number equalled that employee's id.
    let q = `SELECT id, COALESCE(request_number, 'TR-' || LPAD(id::text, 3, '0')) AS request_number,
                    destination, travel_type, from_date AS start, to_date AS end,
                    (to_date - from_date) + 1 AS days, status, purpose, budget AS total, created_at AS created_on
               FROM travel_requests
              WHERE (employee_id = $1 OR created_by = $2) AND ($3::int IS NULL OR company_id = $3)`;
    if (req.query.status && req.query.status !== 'All') { params.push(String(req.query.status)); q += ` AND status = $${params.length}`; }
    q += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/travel-types', (_req, res) => res.json([
  'Sales Visit', 'Customer Meeting', 'Tender Discussion', 'Site Survey', 'Application Engineering',
  'Design Discussion', 'FAT Support', 'Installation', 'Commissioning', 'Service Visit', 'AMC Visit',
  'Training', 'Internal Meeting',
]));

// ── Advances ──────────────────────────────────────────────────────────────────
// Pending Manager → (reporting manager) Pending Finance → (Finance) Approved
//   → (Finance pays, ledger posted) Disbursed → (claims paid / refund) Partially Settled | Settled
// Rejected by either step → the employee fixes it and resubmits → Pending Manager.
// travel_advances.employee_id holds the traveller's LOGIN (users.id) — kept for
// the Approval Center, Home and F&F, which all read it that way.
const ADVANCE_STATUSES = ['Pending Manager', 'Pending Finance', 'Approved', 'Rejected', 'Finance Rejected',
  'Disbursed', 'Partially Settled', 'Settled', 'Cancelled'];
router.get('/advances/statuses', (_req, res) => res.json(ADVANCE_STATUSES));

const ADV_FROM = `
  FROM travel_advances ta
  LEFT JOIN travel_requests tr ON tr.id = ta.travel_request_id
  LEFT JOIN users u ON u.id = ta.employee_id
  LEFT JOIN employees eu ON eu.id = COALESCE(tr.employee_id, u.employee_id)`;

router.get('/advances/years', async (req, res) => {
  try {
    const params = [companyOf(req)];
    let q = `SELECT DISTINCT EXTRACT(YEAR FROM COALESCE(ta.required_by, ta.created_at::date))::int AS year ${ADV_FROM}
              WHERE ($1::int IS NULL OR ta.company_id = $1)`;
    q += await travelScope(req, params, { empCol: 'eu.id', creatorCol: 'ta.created_by', delegateCol: 'ta.delegate_approver_id' });
    const { rows } = await pool.query(`${q} ORDER BY year DESC`, params);
    res.json(rows.map(r => r.year).filter(Boolean));
  } catch (err) { fail(res, err); }
});

router.get('/advances', async (req, res) => {
  try {
    const params = [companyOf(req)];
    let q = `SELECT ta.*, eu.id AS traveller_employee_id,
                    COALESCE(NULLIF(TRIM(CONCAT(eu.first_name,' ',eu.last_name)), ''), u.name) AS employee_name,
                    COALESCE(tr.request_number, CASE WHEN tr.id IS NOT NULL THEN 'TR-' || LPAD(tr.id::text,3,'0') END) AS request_number,
                    tr.destination, tr.from_date AS travel_from, tr.to_date AS travel_to, tr.travel_type, tr.budget AS trip_budget,
                    CASE WHEN tr.from_date IS NOT NULL AND tr.to_date IS NOT NULL THEN (tr.to_date - tr.from_date) + 1 END AS days,
                    exp.company_expense, exp.personal_expense, (exp.company_expense + exp.personal_expense) AS total_expense,
                    (COALESCE(ta.amount,0) - COALESCE(ta.settled_amount,0)) AS outstanding
               ${ADV_FROM}
               LEFT JOIN LATERAL (
                 SELECT COALESCE(SUM(ec.total_amount) FILTER (WHERE ec.borne_by = 'company'), 0) AS company_expense,
                        COALESCE(SUM(ec.total_amount) FILTER (WHERE ec.borne_by = 'personal'), 0) AS personal_expense
                   FROM expense_claims ec
                  WHERE ec.travel_request_id = ta.travel_request_id AND ec.deleted_at IS NULL
                    AND ec.status NOT IN ('Draft','Manager Rejected','Accounts Rejected','Mgmt Rejected')
               ) exp ON TRUE
              WHERE ($1::int IS NULL OR ta.company_id = $1)`;
    q += await travelScope(req, params, { empCol: 'eu.id', creatorCol: 'ta.created_by', delegateCol: 'ta.delegate_approver_id' });
    if (req.query.status && req.query.status !== 'All') { params.push(String(req.query.status)); q += ` AND ta.status = $${params.length}`; }
    if (req.query.year && req.query.year !== 'All') {
      params.push(parseInt(req.query.year, 10));
      q += ` AND EXTRACT(YEAR FROM COALESCE(ta.required_by, ta.created_at::date)) = $${params.length}`;
    }
    const { rows } = await pool.query(`${q} ORDER BY ta.created_at DESC`, params);
    const myEid = await ownEmployeeId(req);
    const fin = hasRole(req, ...ADVANCE_FINANCE_ROLES);
    for (const a of rows) {
      const mine = (myEid != null && Number(a.traveller_employee_id) === myEid) || Number(a.employee_id) === Number(uid(req));
      a.is_mine = mine;
      a.can_manager_review = a.status === 'Pending Manager' && !mine
        ? (await actorAuth(req, a.traveller_employee_id, a.delegate_approver_id)).authorized : false;
      a.can_finance_review = a.status === 'Pending Finance' && fin && !mine;
      a.can_disburse = a.status === 'Approved' && fin && !mine;
      a.can_refund = ['Disbursed', 'Partially Settled'].includes(a.status) && fin && !mine && Number(a.outstanding) > 0;
      a.can_resubmit = ['Finance Rejected', 'Rejected'].includes(a.status) && mine;
      a.can_withdraw = ['Pending Manager', 'Pending Finance'].includes(a.status) && mine;
    }
    res.json(rows);
  } catch (err) { fail(res, err); }
});

/** Amount checks: positive, within the trip budget (net of other live advances) and the policy maximum. */
async function checkAdvanceAmount(db, req, tr, amount, excludeId = null) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (!(amount > 0)) bad('Enter an amount greater than 0');
  const { rows: [o] } = await db.query(
    `SELECT COALESCE(SUM(amount),0) AS taken FROM travel_advances
      WHERE travel_request_id = $1 AND ($2::int IS NULL OR id <> $2)
        AND status NOT IN ('Rejected','Finance Rejected','Cancelled')`, [tr.id, excludeId]);
  const budget = Number(tr.budget || 0);
  if (budget > 0 && Number(o.taken) + amount > budget) {
    bad(`Advances on this trip cannot exceed its estimated cost of ₹${budget.toLocaleString('en-IN')} (₹${Number(o.taken).toLocaleString('en-IN')} already requested)`);
  }
  const { rows: [emp] } = await db.query(`SELECT grade, designation, department FROM employees WHERE id = $1`, [tr.employee_id]);
  const rule = await policyRuleFor(db, companyOf(req), emp, tr.from_date);
  const max = Number(rule?.max_advance_amount || 0);
  if (max > 0 && amount > max) bad(`Your travel policy allows an advance of up to ₹${max.toLocaleString('en-IN')}`);
}

router.post('/advances', async (req, res) => {
  try {
    const { purpose, required_by, travel_request_id, document_link } = req.body || {};
    const amount = Number(req.body?.amount);
    if (!String(purpose || '').trim()) return res.status(400).json({ error: 'Purpose is required' });
    if (!isId(travel_request_id)) return res.status(400).json({ error: 'Choose the approved trip this advance is for' });
    const tr = await loadTrip(req, travel_request_id);
    if (!tr || !((await ownsTrip(req, tr)) || isTravelDesk(req))) return res.status(404).json({ error: 'Trip not found' });
    if (tr.status !== 'Approved') return res.status(409).json({ error: `An advance can be requested only on an approved trip — this one is ${tr.status}` });
    await checkAdvanceAmount(pool, req, tr, amount);
    // The traveller's login (see the note on ADVANCE_STATUSES).
    const { rows: [login] } = await pool.query(`SELECT id FROM users WHERE employee_id = $1 ORDER BY is_active DESC, id LIMIT 1`, [tr.employee_id]);
    const actorId = uid(req);
    const { rows: [adv] } = await pool.query(
      `INSERT INTO travel_advances (employee_id, company_id, amount, purpose, required_by, travel_request_id, document_link, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Pending Manager',$8) RETURNING *`,
      [login?.id ?? actorId, tr.company_id, amount, String(purpose).trim(), isDate(required_by) ? required_by : null,
       tr.id, document_link || null, actorId]);
    logAudit({ userId: actorId, module: 'travel', recordId: adv.id, recordType: 'travel_advance', action: 'create', newData: adv, req });
    res.status(201).json(adv);
  } catch (err) { fail(res, err); }
});

async function advanceTraveller(adv) {
  if (adv.travel_request_id) {
    const { rows } = await pool.query(`SELECT employee_id FROM travel_requests WHERE id=$1`, [adv.travel_request_id]);
    if (rows[0]?.employee_id != null) return rows[0].employee_id;
  }
  const { rows } = await pool.query(`SELECT employee_id FROM users WHERE id=$1`, [adv.employee_id]);
  return rows[0]?.employee_id ?? null;
}
async function isOwnAdvance(req, adv) {
  const eid = await ownEmployeeId(req);
  return Number(adv.employee_id) === Number(uid(req)) || (eid != null && Number(await advanceTraveller(adv)) === eid);
}

// Step 1 — reporting manager (or delegate; HR/admin only without a manager).
router.put('/advances/:id/manager-review', async (req, res) => {
  try {
    const { status } = req.body || {};
    const comments = String(req.body?.comments || '').trim();
    if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });
    if (status === 'Rejected' && !comments) return res.status(400).json({ error: 'Please give a reason for rejecting' });
    const adv = await loadAdvance(req, req.params.id);
    if (!adv) return res.status(404).json({ error: 'Advance not found' });
    if (adv.status !== 'Pending Manager') return res.status(409).json({ error: `This advance is ${adv.status}, not waiting for the manager` });
    const auth = await actorAuth(req, await advanceTraveller(adv), adv.delegate_approver_id);
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    const actorId = uid(req);
    const next = status === 'Approved' ? 'Pending Finance' : 'Rejected';
    const { rows: [updated] } = await pool.query(
      `UPDATE travel_advances SET status=$1, manager_comments=$2, manager_by=$3, manager_at=NOW(), updated_at=NOW()
        WHERE id=$4 AND status='Pending Manager' RETURNING *`, [next, comments || null, actorId, adv.id]);
    if (!updated) return decidedElsewhere(res, 'advance');
    if (status === 'Rejected') notifyWorkflowEvent('rejected', { module: 'TravelAdvance', recordId: updated.id, submitterUserId: adv.employee_id, comments });
    logAudit({ userId: actorId, module: 'travel', recordId: updated.id, recordType: 'travel_advance',
      action: `manager_${status.toLowerCase()}`, oldData: adv, newData: updated, req });
    res.json(updated);
  } catch (err) { fail(res, err); }
});

// Step 2 — Finance.
router.put('/advances/:id/finance-review', async (req, res) => {
  try {
    if (!hasRole(req, ...ADVANCE_FINANCE_ROLES)) return res.status(403).json({ error: 'Finance reviews advances' });
    const { status } = req.body || {};
    const comments = String(req.body?.comments || '').trim();
    if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });
    if (status === 'Rejected' && !comments) return res.status(400).json({ error: 'Please give a reason for rejecting' });
    const adv = await loadAdvance(req, req.params.id);
    if (!adv) return res.status(404).json({ error: 'Advance not found' });
    if (await isOwnAdvance(req, adv)) return res.status(403).json({ error: 'You cannot review your own advance' });
    if (adv.status !== 'Pending Finance') return res.status(409).json({ error: `This advance is ${adv.status}, not waiting for Finance` });
    const actorId = uid(req);
    const next = status === 'Approved' ? 'Approved' : 'Finance Rejected';
    const { rows: [updated] } = await pool.query(
      `UPDATE travel_advances SET status=$1, finance_comments=$2, finance_by=$3, finance_at=NOW(), updated_at=NOW()
        WHERE id=$4 AND status='Pending Finance' RETURNING *`, [next, comments || null, actorId, adv.id]);
    if (!updated) return decidedElsewhere(res, 'advance');
    notifyWorkflowEvent(status === 'Approved' ? 'approved' : 'rejected', { module: 'TravelAdvance', recordId: updated.id, submitterUserId: adv.employee_id, comments });
    logAudit({ userId: actorId, module: 'travel', recordId: updated.id, recordType: 'travel_advance',
      action: `finance_${status.toLowerCase()}`, oldData: adv, newData: updated, req });
    res.json(updated);
  } catch (err) { fail(res, err); }
});

// The employee fixes a rejected advance and sends it again — back to the manager.
router.put('/advances/:id/resubmit', async (req, res) => {
  try {
    const adv = await loadAdvance(req, req.params.id);
    if (!adv || !(await isOwnAdvance(req, adv))) return res.status(404).json({ error: 'Advance not found' });
    if (!['Finance Rejected', 'Rejected'].includes(adv.status)) return res.status(409).json({ error: 'Only a rejected advance can be resubmitted' });
    const tr = await loadTrip(req, adv.travel_request_id);
    if (!tr || tr.status !== 'Approved') return res.status(409).json({ error: 'Its trip is no longer approved' });
    const amount = req.body?.amount == null || req.body.amount === '' ? Number(adv.amount) : Number(req.body.amount);
    await checkAdvanceAmount(pool, req, tr, amount, adv.id);
    const { rows: [updated] } = await pool.query(
      `UPDATE travel_advances SET amount=$1, purpose=COALESCE($2, purpose), required_by=COALESCE($3, required_by),
              document_link=COALESCE($4, document_link), status='Pending Manager',
              resubmission_count=COALESCE(resubmission_count,0)+1,
              manager_by=NULL, manager_at=NULL, finance_by=NULL, finance_at=NULL, updated_at=NOW()
        WHERE id=$5 AND status=$6 RETURNING *`,
      [amount, String(req.body?.purpose || '').trim() || null, isDate(req.body?.required_by) ? req.body.required_by : null,
       req.body?.document_link || null, adv.id, adv.status]);
    if (!updated) return decidedElsewhere(res, 'advance');
    logAudit({ userId: uid(req), module: 'travel', recordId: updated.id, recordType: 'travel_advance', action: 'resubmit', oldData: adv, newData: updated, req });
    res.json(updated);
  } catch (err) { fail(res, err); }
});

// The employee withdraws an advance nobody has paid yet.
router.post('/advances/:id/withdraw', async (req, res) => {
  try {
    const adv = await loadAdvance(req, req.params.id);
    if (!adv || !(await isOwnAdvance(req, adv))) return res.status(404).json({ error: 'Advance not found' });
    const { rows: [updated] } = await pool.query(
      `UPDATE travel_advances SET status='Cancelled', updated_at=NOW()
        WHERE id=$1 AND status IN ('Pending Manager','Pending Finance','Finance Rejected','Rejected') RETURNING *`, [adv.id]);
    if (!updated) return res.status(409).json({ error: `A ${adv.status} advance cannot be withdrawn` });
    logAudit({ userId: uid(req), module: 'travel', recordId: adv.id, recordType: 'travel_advance', action: 'withdraw', oldData: adv, newData: updated, req });
    res.json(updated);
  } catch (err) { fail(res, err); }
});

router.post('/advances/:id/delegate', async (req, res) => {
  try {
    const { delegate_employee_id } = req.body || {};
    const adv = await loadAdvance(req, req.params.id);
    if (!adv) return res.status(404).json({ error: 'Advance not found' });
    if (adv.status !== 'Pending Manager') return res.status(409).json({ error: `This advance is ${adv.status}; only the manager step can be delegated` });
    const traveller = await advanceTraveller(adv);
    const auth = await actorAuth(req, traveller, adv.delegate_approver_id);
    if (!auth.authorized) return res.status(403).json({ error: DENIED_MESSAGE });
    const bad = await assertDelegateEligible(delegate_employee_id, adv.company_id, traveller);
    if (bad) return res.status(400).json({ error: bad });
    const { rows: [updated] } = await pool.query(
      `UPDATE travel_advances SET delegate_approver_id=$1, updated_at=NOW() WHERE id=$2 AND status='Pending Manager' RETURNING *`,
      [Number(delegate_employee_id), adv.id]);
    if (!updated) return decidedElsewhere(res, 'advance');
    logAudit({ userId: uid(req), module: 'travel', recordId: adv.id, recordType: 'travel_advance', action: 'delegate', newData: { delegate_employee_id }, req });
    res.json(updated);
  } catch (err) { fail(res, err); }
});

// Step 3 — Finance pays it out; Dr Employee advances / Cr Bank.
router.put('/advances/:id/disburse', async (req, res) => {
  if (!hasRole(req, ...ADVANCE_FINANCE_ROLES)) return res.status(403).json({ error: 'Finance pays advances' });
  const { payment_ref, payment_date } = req.body || {};
  if (!String(payment_ref || '').trim()) return res.status(400).json({ error: 'Payment reference is required' });
  if (!isDate(payment_date)) return res.status(400).json({ error: 'Payment date is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const adv = await loadAdvance(req, req.params.id, client);
    if (!adv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Advance not found' }); }
    if (await isOwnAdvance(req, adv)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'You cannot pay your own advance' }); }
    const { rows: [locked] } = await client.query(`SELECT * FROM travel_advances WHERE id=$1 FOR UPDATE`, [adv.id]);
    if (locked.status !== 'Approved') { await client.query('ROLLBACK'); return res.status(409).json({ error: `This advance is ${locked.status} — only an approved advance is paid` }); }
    const { rows: [tr] } = await client.query(`SELECT request_number FROM travel_requests WHERE id=$1`, [adv.travel_request_id]);
    const je = await postAdvanceDisbursement(client, locked, { date: payment_date, userId: uid(req), label: tr?.request_number });
    const { rows: [updated] } = await client.query(
      `UPDATE travel_advances SET status='Disbursed', payment_ref=$1, payment_date=$2, disbursed_by=$3, disbursed_at=NOW(),
              journal_entry_id=$4, updated_at=NOW() WHERE id=$5 RETURNING *`,
      [String(payment_ref).trim(), payment_date, uid(req), je.id, adv.id]);
    await client.query('COMMIT');
    notifyWorkflowEvent('paid', { module: 'TravelAdvance', recordId: adv.id, submitterUserId: adv.employee_id });
    logAudit({ userId: uid(req), module: 'travel', recordId: adv.id, recordType: 'travel_advance', action: 'disburse', oldData: adv, newData: updated, req });
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally { client.release(); }
});

// Finance records the employee returning unspent advance; Dr Bank / Cr Employee advances.
router.put('/advances/:id/refund', async (req, res) => {
  if (!hasRole(req, ...ADVANCE_FINANCE_ROLES)) return res.status(403).json({ error: 'Finance records refunds' });
  const amount = Number(req.body?.amount);
  const { refund_ref, refund_date } = req.body || {};
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter the amount returned' });
  if (!String(refund_ref || '').trim()) return res.status(400).json({ error: 'Receipt reference is required' });
  if (!isDate(refund_date)) return res.status(400).json({ error: 'Date received is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const adv = await loadAdvance(req, req.params.id, client);
    if (!adv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Advance not found' }); }
    const { rows: [a] } = await client.query(`SELECT * FROM travel_advances WHERE id=$1 FOR UPDATE`, [adv.id]);
    if (!['Disbursed', 'Partially Settled'].includes(a.status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: `A ${a.status} advance has nothing outstanding` }); }
    const outstanding = Number(a.amount) - Number(a.settled_amount || 0);
    if (amount > outstanding + 0.001) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Only ₹${outstanding.toLocaleString('en-IN')} is outstanding` }); }
    const je = await postAdvanceRefund(client, a, { amount, date: refund_date, userId: uid(req) });
    const { rows: [updated] } = await client.query(
      `UPDATE travel_advances SET settled_amount = COALESCE(settled_amount,0) + $1,
              refund_amount = COALESCE(refund_amount,0) + $1, refund_ref=$2, refund_date=$3, refund_by=$4,
              refund_journal_entry_id=$5,
              status = CASE WHEN COALESCE(settled_amount,0) + $1 >= amount THEN 'Settled' ELSE 'Partially Settled' END,
              updated_at=NOW()
        WHERE id=$6 RETURNING *`, [amount, String(refund_ref).trim(), refund_date, uid(req), je.id, a.id]);
    await client.query('COMMIT');
    logAudit({ userId: uid(req), module: 'travel', recordId: a.id, recordType: 'travel_advance', action: 'refund', oldData: a, newData: updated, req });
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally { client.release(); }
});

// ── Bookings (travel desk only) ───────────────────────────────────────────────
const BOOKING_SELECT = `
  SELECT tb.*, COALESCE(tr.request_number, 'TR-' || LPAD(tr.id::text,3,'0')) AS request_number,
         COALESCE(NULLIF(TRIM(CONCAT(e.first_name,' ',e.last_name)), ''), tb.employee_name, tr.employee_name) AS employee_name,
         COALESCE(tb.destination, tr.destination) AS destination, tr.travel_type, tr.status AS trip_status
    FROM travel_bookings tb
    LEFT JOIN travel_requests tr ON tr.id = tb.travel_request_id
    LEFT JOIN employees e ON e.id = tr.employee_id`;

router.get('/bookings', async (req, res) => {
  try {
    const params = [companyOf(req)];
    let q = `${BOOKING_SELECT} WHERE ($1::int IS NULL OR COALESCE(tb.company_id, tr.company_id) = $1)`;
    q += await travelScope(req, params, { empCol: 'tr.employee_id', creatorCol: 'tr.created_by', delegateCol: 'tr.delegate_approver_id' });
    if (req.query.status && req.query.status !== 'All') { params.push(String(req.query.status)); q += ` AND tb.status = $${params.length}`; }
    const { rows } = await pool.query(`${q} ORDER BY COALESCE(tb.from_date, tr.from_date) DESC, tb.id DESC`, params);
    res.json(rows.map(r => ({ ...r, can_edit: isTravelDesk(req) && r.status !== 'Cancelled' })));
  } catch (err) { fail(res, err); }
});

// Approved trips with nothing booked yet — the desk's to-do list.
router.get('/bookings/queue', deskOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tr.id, COALESCE(tr.request_number, 'TR-' || LPAD(tr.id::text,3,'0')) AS request_number,
              COALESCE(NULLIF(TRIM(CONCAT(e.first_name,' ',e.last_name)), ''), tr.employee_name) AS employee_name,
              tr.destination, tr.travel_type, tr.mode, tr.hotel_required, tr.from_date, tr.to_date, tr.notes
         FROM travel_requests tr LEFT JOIN employees e ON e.id = tr.employee_id
        WHERE tr.status = 'Approved' AND tr.to_date >= CURRENT_DATE
          AND ($1::int IS NULL OR tr.company_id = $1)
          AND NOT EXISTS (SELECT 1 FROM travel_bookings tb WHERE tb.travel_request_id = tr.id AND tb.status <> 'Cancelled')
        ORDER BY tr.from_date`, [companyOf(req)]);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

function cleanBooking(b, tr) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  const type = BOOKING_TYPES.includes(b.booking_type) ? b.booking_type : bad('Choose what was booked');
  const amount = b.amount === '' || b.amount == null ? 0 : Number(b.amount ?? b.cost);
  if (!(amount >= 0)) bad('Cost cannot be negative');
  const from = isDate(String(b.from_date || '').slice(0, 10)) ? String(b.from_date).slice(0, 10) : tr.from_date || null;
  const to = isDate(String(b.to_date || '').slice(0, 10)) ? String(b.to_date).slice(0, 10) : tr.to_date || null;
  if (from && to && String(to) < String(from)) bad('The end date cannot be before the start date');
  return {
    booking_type: type, airline_train: b.airline_train ? String(b.airline_train).trim() : null,
    booking_ref: b.booking_ref ? String(b.booking_ref).trim() : null, amount, from_date: from, to_date: to,
    notes: b.notes ? String(b.notes) : null,
  };
}

router.post('/bookings', deskOnly, async (req, res) => {
  try {
    const tr = await loadTrip(req, req.body?.travel_request_id);
    if (!tr) return res.status(400).json({ error: 'Choose the approved trip this booking is for' });
    if (tr.status !== 'Approved') return res.status(409).json({ error: `Only an approved trip is booked — this one is ${tr.status}` });
    const b = cleanBooking(req.body || {}, tr);
    const { rows: [bk] } = await pool.query(
      `INSERT INTO travel_bookings (travel_request_id, booking_type, destination, from_date, to_date, mode, airline_train,
              booking_ref, amount, notes, status, employee_name, company_id, created_by, booked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Confirmed',$11,$12,$13,$13) RETURNING *`,
      [tr.id, b.booking_type, tr.destination, b.from_date, b.to_date, b.booking_type === 'Hotel' ? null : b.booking_type,
       b.airline_train, b.booking_ref, b.amount, b.notes, tr.employee_name, tr.company_id, uid(req)]);
    logAudit({ userId: uid(req), module: 'travel', recordId: bk.id, recordType: 'travel_booking', action: 'create', newData: bk, req });
    res.status(201).json(bk);
  } catch (err) { fail(res, err); }
});

router.put('/bookings/:id', deskOnly, async (req, res) => {
  try {
    const old = await loadInCompany('travel_bookings', req, req.params.id);
    if (!old) return res.status(404).json({ error: 'Booking not found' });
    if (old.status === 'Cancelled') return res.status(409).json({ error: 'A cancelled booking cannot be edited' });
    const tr = await loadTrip(req, old.travel_request_id) || {};
    const b = cleanBooking({ ...old, ...req.body }, tr);
    const { rows: [bk] } = await pool.query(
      `UPDATE travel_bookings SET booking_type=$1, airline_train=$2, booking_ref=$3, amount=$4, from_date=$5, to_date=$6,
              notes=$7, mode=$8, status='Confirmed', updated_at=NOW() WHERE id=$9 RETURNING *`,
      [b.booking_type, b.airline_train, b.booking_ref, b.amount, b.from_date, b.to_date, b.notes,
       b.booking_type === 'Hotel' ? null : b.booking_type, old.id]);
    logAudit({ userId: uid(req), module: 'travel', recordId: bk.id, recordType: 'travel_booking', action: 'update', oldData: old, newData: bk, req });
    res.json(bk);
  } catch (err) { fail(res, err); }
});

router.post('/bookings/:id/cancel', deskOnly, async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Please give a reason for cancelling' });
    const old = await loadInCompany('travel_bookings', req, req.params.id);
    if (!old) return res.status(404).json({ error: 'Booking not found' });
    const { rows: [bk] } = await pool.query(
      `UPDATE travel_bookings SET status='Cancelled', cancel_reason=$1, updated_at=NOW() WHERE id=$2 AND status <> 'Cancelled' RETURNING *`,
      [reason, old.id]);
    if (!bk) return res.status(409).json({ error: 'This booking is already cancelled' });
    logAudit({ userId: uid(req), module: 'travel', recordId: bk.id, recordType: 'travel_booking', action: 'cancel', oldData: old, newData: bk, req });
    res.json(bk);
  } catch (err) { fail(res, err); }
});

// ── Trip expenses: merged into Expense Claims (owner, 26 Nov 26) ──────────────
const CLAIMS_MOVED = { error: 'Trip expenses are filed as Expense Claims (Travel Desk → Expenses).', moved_to: '/reimbursement/claims' };
router.get('/expenses', (_req, res) => res.status(410).json(CLAIMS_MOVED));
router.post('/expenses', (_req, res) => res.status(410).json(CLAIMS_MOVED));
router.post('/expenses/v2', (_req, res) => res.status(410).json(CLAIMS_MOVED));
router.put('/expenses/:id/reimburse', (_req, res) => res.status(410).json(CLAIMS_MOVED));
router.get('/review-entries', (_req, res) => res.status(410).json({ error: 'Trips are approved in Travel Approvals' }));
router.get('/dashboard', (_req, res) => res.status(410).json({ error: 'Use GET /travel/recent-requests and /travel/analytics/stats' }));

// ── Closure guard ─────────────────────────────────────────────────────────────
/**
 * What still blocks closing a project / opportunity: trips awaiting a decision,
 * approved trips whose claims are not finished, and unfinished claims. Used by
 * the project and opportunity close routes, and by GET /closure-check.
 */
export async function travelClosureBlockers(companyId, { project_id = null, opportunity_id = null } = {}) {
  if (!project_id && !opportunity_id) return [];
  const p = [companyId ?? null, project_id ? Number(project_id) : null, opportunity_id ? Number(opportunity_id) : null];
  const link = (a) => `(($2::int IS NOT NULL AND ${a}.project_id = $2) OR ($3::int IS NOT NULL AND ${a}.opportunity_id = $3))`;
  const { rows: [r] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM travel_requests tr WHERE ($1::int IS NULL OR tr.company_id = $1) AND ${link('tr')}
          AND tr.status = 'Pending')::int AS trips,
      (SELECT COUNT(*) FROM expense_claims ec WHERE ($1::int IS NULL OR ec.company_id = $1) AND ec.deleted_at IS NULL AND ${link('ec')}
          AND ec.status NOT IN ('Paid','Closed','Manager Rejected','Accounts Rejected','Mgmt Rejected'))::int AS claims`, p);
  const out = [];
  if (r.trips) out.push({ type: 'travel_requests', count: r.trips, message: `${r.trips} trip(s) still waiting for approval` });
  if (r.claims) out.push({ type: 'expense_claims', count: r.claims, message: `${r.claims} expense claim(s) not yet paid or closed` });
  return out;
}
router.get('/closure-check', async (req, res) => {
  try {
    const blocking = await travelClosureBlockers(companyOf(req), req.query);
    res.json({ canClose: blocking.length === 0, blocking });
  } catch (err) { fail(res, err); }
});

// ── Spend analytics ───────────────────────────────────────────────────────────
// Spend used to be the ESTIMATED budget typed on each trip, pending ones
// included. It is now two figures:
//   estimated  budget of approved trips (dated by the trip start)
//   actual     paid, company-borne expense claims (dated by payment) plus
//              confirmed travel-desk bookings (dated by the booking start)
function spendRows(alias = 's') {
  return `(
    SELECT tr.id AS trip_id, tr.employee_id, COALESCE(tr.department, e.department) AS department,
           tr.project_id, tr.project_number, tr.customer_id, tr.customer_name, tr.travel_type,
           tr.from_date AS d, tr.budget AS est, 0::numeric AS act, tr.company_id
      FROM travel_requests tr LEFT JOIN employees e ON e.id = tr.employee_id
     WHERE tr.status = 'Approved'
    UNION ALL
    SELECT ec.travel_request_id, ec.employee_id, COALESCE(ec.department, e.department),
           COALESCE(ec.project_id, tr.project_id), COALESCE(ec.project_number, tr.project_number),
           COALESCE(ec.customer_id, tr.customer_id), COALESCE(ec.customer_name, tr.customer_name), tr.travel_type,
           COALESCE(ec.payment_date, ec.expense_date), 0, ec.total_amount, ec.company_id
      FROM expense_claims ec
      LEFT JOIN travel_requests tr ON tr.id = ec.travel_request_id
      LEFT JOIN employees e ON e.id = ec.employee_id
     WHERE ec.status = 'Paid' AND ec.borne_by = 'company' AND ec.deleted_at IS NULL
    UNION ALL
    SELECT tr.id, tr.employee_id, COALESCE(tr.department, e.department), tr.project_id, tr.project_number,
           tr.customer_id, tr.customer_name, tr.travel_type, COALESCE(tb.from_date, tr.from_date), 0, tb.amount,
           COALESCE(tb.company_id, tr.company_id)
      FROM travel_bookings tb JOIN travel_requests tr ON tr.id = tb.travel_request_id
      LEFT JOIN employees e ON e.id = tr.employee_id
     WHERE tb.status = 'Confirmed'
  ) ${alias}`;
}
function spendScope(req, { defaultPeriod = 'last6m' } = {}) {
  const range = resolveRange(req.query, { defaultPeriod });
  const department = dimension(req.query, 'department');
  return {
    range,
    params: [companyOf(req), range.from, range.to, department],
    where: `($1::int IS NULL OR s.company_id = $1) AND ($2::date IS NULL OR s.d >= $2::date)
            AND ($3::date IS NULL OR s.d <= $3::date) AND ($4::text IS NULL OR s.department = $4)`,
  };
}
const nums = (r) => ({ ...r, estimated: Number(r.estimated || 0), actual: Number(r.actual || 0), total_spend: Number(r.actual || 0) });

const analytics = express.Router();
analytics.use(gate(TRAVEL_ANALYTICS_ROLES));

analytics.get('/stats', async (req, res) => {
  try {
    const s = spendScope(req);
    const { rows: [r] } = await pool.query(`
      SELECT COUNT(DISTINCT s.trip_id)::int AS trips,
             COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual,
             COUNT(DISTINCT s.employee_id)::int AS active_travelers
        FROM ${spendRows()} WHERE ${s.where}`, s.params);
    const trips = r.trips || 0;
    res.json({
      trips_this_month: trips, trips,
      estimated: Number(r.estimated), actual: Number(r.actual), spend_this_month: Number(r.actual),
      avg_cost_per_trip: trips ? Math.round(Number(r.actual) / trips) : 0,
      active_travelers: r.active_travelers, period: s.range.period, period_label: s.range.label,
    });
  } catch (err) { fail(res, err); }
});

analytics.get('/trend', async (req, res) => {
  try {
    const s = spendScope(req);
    const { rows } = await pool.query(`
      WITH months AS (
        SELECT generate_series(date_trunc('month', COALESCE($2::date, NOW() - INTERVAL '5 months')),
                               date_trunc('month', COALESCE($3::date, NOW())), '1 month'::interval) AS m)
      SELECT TO_CHAR(m.m, 'Mon YY') AS month, COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual
        FROM months m LEFT JOIN ${spendRows()} ON date_trunc('month', s.d) = m.m AND ${s.where}
       GROUP BY m.m ORDER BY m.m`, s.params);
    res.json(rows.map(nums));
  } catch (err) { fail(res, err); }
});

analytics.get('/department', async (req, res) => {
  try {
    const s = spendScope(req);
    const { rows } = await pool.query(`
      SELECT COALESCE(s.department, 'Unassigned') AS department, COUNT(DISTINCT s.trip_id)::int AS trip_count,
             COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual
        FROM ${spendRows()} WHERE ${s.where} GROUP BY 1 ORDER BY actual DESC, estimated DESC`, s.params);
    res.json(rows.map(nums));
  } catch (err) { fail(res, err); }
});

async function byEmployee(req, limit) {
  const s = spendScope(req);
  const { rows } = await pool.query(`
    SELECT e.id, CONCAT(e.first_name,' ',e.last_name) AS employee_name, e.designation, e.department,
           COUNT(DISTINCT s.trip_id)::int AS trip_count, COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual
      FROM ${spendRows()} JOIN employees e ON e.id = s.employee_id
     WHERE ${s.where} GROUP BY e.id, e.first_name, e.last_name, e.designation, e.department
     ORDER BY actual DESC, trip_count DESC LIMIT ${limit}`, s.params);
  return rows.map(r => ({ ...nums(r), avg_spend: r.trip_count ? Math.round(Number(r.actual) / r.trip_count) : 0 }));
}
analytics.get('/travelers', async (req, res) => { try { res.json(await byEmployee(req, 10)); } catch (err) { fail(res, err); } });
analytics.get('/by-employee', async (req, res) => { try { res.json(await byEmployee(req, 50)); } catch (err) { fail(res, err); } });

analytics.get('/by-project', async (req, res) => {
  try {
    const s = spendScope(req);
    const { rows } = await pool.query(`
      SELECT s.project_id, COALESCE(s.project_number, 'Not linked to a project') AS project_number, MAX(s.customer_name) AS customer_name,
             COUNT(DISTINCT s.trip_id)::int AS trip_count, COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual
        FROM ${spendRows()} WHERE ${s.where} GROUP BY s.project_id, 2 ORDER BY actual DESC, estimated DESC LIMIT 50`, s.params);
    res.json(rows.map(nums));
  } catch (err) { fail(res, err); }
});

analytics.get('/by-customer', async (req, res) => {
  try {
    const s = spendScope(req);
    const { rows } = await pool.query(`
      SELECT s.customer_id, COALESCE(s.customer_name, 'Not linked to a customer') AS customer_name,
             COUNT(DISTINCT s.trip_id)::int AS trip_count, COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual
        FROM ${spendRows()} WHERE ${s.where} GROUP BY s.customer_id, 2 ORDER BY actual DESC, estimated DESC LIMIT 50`, s.params);
    res.json(rows.map(nums));
  } catch (err) { fail(res, err); }
});

async function byTravelType(req, res) {
  try {
    const s = spendScope(req);
    const { rows } = await pool.query(`
      SELECT COALESCE(s.travel_type, 'Not linked to a trip') AS travel_type, COUNT(DISTINCT s.trip_id)::int AS trip_count,
             COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual
        FROM ${spendRows()} WHERE ${s.where} GROUP BY 1 ORDER BY actual DESC, estimated DESC`, s.params);
    res.json(rows.map(r => ({ ...nums(r), total_budget: Number(r.estimated) })));
  } catch (err) { fail(res, err); }
}
analytics.get('/by-travel-type', byTravelType);

analytics.get('/filter-options', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT d AS v FROM (
         SELECT COALESCE(tr.department, e.department) AS d FROM travel_requests tr LEFT JOIN employees e ON e.id = tr.employee_id
          WHERE ($1::int IS NULL OR tr.company_id = $1)
         UNION SELECT department FROM expense_claims WHERE ($1::int IS NULL OR company_id = $1)) x
        WHERE d IS NOT NULL AND TRIM(d) <> '' ORDER BY v`, [companyOf(req)]);
    res.json({ departments: rows.map(r => r.v) });
  } catch { res.json({ departments: [] }); }
});

// CEO Command Center — one call, admin desks.
analytics.get('/ceo-summary', async (req, res) => {
  try {
    const [by_employee, by_department, by_project, by_customer] = await Promise.all([
      byEmployee(req, 10),
      (async () => { const s = spendScope(req, { defaultPeriod: 'fytd' }); const { rows } = await pool.query(`
        SELECT COALESCE(s.department,'Unassigned') AS department, COUNT(DISTINCT s.trip_id)::int AS trips,
               COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual
          FROM ${spendRows()} WHERE ${s.where} GROUP BY 1 ORDER BY actual DESC LIMIT 8`, s.params); return rows.map(nums); })(),
      (async () => { const s = spendScope(req, { defaultPeriod: 'fytd' }); const { rows } = await pool.query(`
        SELECT COALESCE(s.project_number,'Not linked') AS project_number, MAX(s.customer_name) AS customer_name,
               COUNT(DISTINCT s.trip_id)::int AS trips, COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual
          FROM ${spendRows()} WHERE ${s.where} GROUP BY s.project_id, 1 ORDER BY actual DESC LIMIT 10`, s.params); return rows.map(nums); })(),
      (async () => { const s = spendScope(req, { defaultPeriod: 'fytd' }); const { rows } = await pool.query(`
        SELECT COALESCE(s.customer_name,'Not linked') AS customer_name, COUNT(DISTINCT s.trip_id)::int AS trips,
               COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual
          FROM ${spendRows()} WHERE ${s.where} GROUP BY s.customer_id, 1 ORDER BY actual DESC LIMIT 10`, s.params); return rows.map(nums); })(),
    ]);
    const { rows: trend } = await pool.query(`
      WITH months AS (SELECT generate_series(date_trunc('month', NOW() - INTERVAL '11 months'), date_trunc('month', NOW()), '1 month') AS m)
      SELECT TO_CHAR(m.m, 'Mon YY') AS month, m.m AS month_date, COUNT(DISTINCT s.trip_id)::int AS trips,
             COALESCE(SUM(s.est),0) AS estimated, COALESCE(SUM(s.act),0) AS actual
        FROM months m LEFT JOIN ${spendRows()} ON date_trunc('month', s.d) = m.m AND ($1::int IS NULL OR s.company_id = $1)
       GROUP BY m.m ORDER BY m.m`, [companyOf(req)]);
    res.json({ by_employee, by_department, by_project, by_customer, trend: trend.map(r => ({ ...nums(r), spend: Number(r.actual) })) });
  } catch (err) { fail(res, err); }
});

router.use('/analytics', analytics);
router.get('/reports/by-travel-type', gate(TRAVEL_ANALYTICS_ROLES), byTravelType);

// ── 360 panels ────────────────────────────────────────────────────────────────
router.get('/customer-360/:customerId', async (req, res) => {
  try {
    if (!isId(req.params.customerId)) return res.status(404).json({ error: 'Customer not found' });
    // The CRM account page (Visits & Travel tab) and the travel desks.
    if (!(seesAllTravel(req) || hasRole(req, ...TRAVEL_ANALYTICS_ROLES) || (await can(req, 'crm', 'view')))) {
      return res.status(403).json({ error: 'You do not have access to this customer' });
    }
    const args = [Number(req.params.customerId), companyOf(req)];
    const [visits, cost, trips] = await Promise.all([
      pool.query(`SELECT vr.id, vr.report_number, vr.visit_type, vr.visit_date, vr.purpose, vr.status, vr.outcome,
                         vr.next_followup AS next_followup_date, CONCAT(e.first_name,' ',e.last_name) AS visited_by_name
                    FROM visit_reports vr LEFT JOIN employees e ON e.id = vr.visited_by
                   WHERE vr.customer_id = $1 AND ($2::int IS NULL OR vr.company_id = $2)
                   ORDER BY vr.visit_date DESC LIMIT 20`, args),
      pool.query(`SELECT COALESCE(SUM(total_amount),0) AS total_travel_cost, COUNT(*)::int AS expense_count
                    FROM expense_claims WHERE customer_id = $1 AND status = 'Paid' AND borne_by = 'company'
                     AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`, args),
      pool.query(`SELECT tr.id, COALESCE(tr.request_number, 'TR-' || tr.id) AS request_number, tr.travel_type, tr.destination,
                         tr.from_date, tr.to_date, tr.budget, tr.status, CONCAT(e.first_name,' ',e.last_name) AS employee_name
                    FROM travel_requests tr LEFT JOIN employees e ON e.id = tr.employee_id
                   WHERE tr.customer_id = $1 AND ($2::int IS NULL OR tr.company_id = $2)
                   ORDER BY tr.from_date DESC LIMIT 20`, args),
    ]);
    res.json({ visits: visits.rows, total_travel_cost: Number(cost.rows[0].total_travel_cost),
               expense_count: cost.rows[0].expense_count, travel_requests: trips.rows });
  } catch (err) { fail(res, err); }
});

router.get('/project-360/:projectId', async (req, res) => {
  try {
    if (!isId(req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
    const args = [Number(req.params.projectId), companyOf(req)];
    const [costSummary, trips, visits, costByType] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0) AS base_amount, COALESCE(SUM(gst_amount),0) AS gst_amount,
                         COALESCE(SUM(amount + COALESCE(gst_amount,0)),0) AS total_cost, COUNT(*)::int AS transaction_count
                    FROM travel_cost_transactions WHERE project_id = $1 AND ($2::int IS NULL OR company_id = $2)`, args),
      pool.query(`SELECT tr.id, COALESCE(tr.request_number, 'TR-' || tr.id) AS request_number, tr.travel_type, tr.destination,
                         tr.from_date, tr.to_date, tr.budget, tr.status, tr.site_name, CONCAT(e.first_name,' ',e.last_name) AS employee_name
                    FROM travel_requests tr LEFT JOIN employees e ON e.id = tr.employee_id
                   WHERE tr.project_id = $1 AND ($2::int IS NULL OR tr.company_id = $2) ORDER BY tr.from_date DESC LIMIT 30`, args),
      pool.query(`SELECT vr.id, vr.report_number, vr.visit_type, vr.visit_date, vr.visited_by, vr.purpose, vr.status,
                         vr.customer_name, vr.site_name, CONCAT(e.first_name,' ',e.last_name) AS visited_by_name
                    FROM visit_reports vr LEFT JOIN employees e ON e.id = vr.visited_by
                   WHERE vr.project_id = $1 AND ($2::int IS NULL OR vr.company_id = $2) ORDER BY vr.visit_date DESC LIMIT 20`, args),
      pool.query(`SELECT COALESCE(cost_type, 'OTHER') AS cost_type, COUNT(*)::int AS count, COALESCE(SUM(amount + COALESCE(gst_amount,0)),0) AS amount
                    FROM travel_cost_transactions WHERE project_id = $1 AND ($2::int IS NULL OR company_id = $2)
                   GROUP BY 1 ORDER BY amount DESC`, args),
    ]);
    const c = costSummary.rows[0];
    res.json({
      cost_summary: { base_amount: Number(c.base_amount), gst_amount: Number(c.gst_amount), total_cost: Number(c.total_cost), transaction_count: c.transaction_count },
      travel_requests: trips.rows, visit_reports: visits.rows,
      cost_by_type: costByType.rows.map(r => ({ ...r, amount: Number(r.amount) })),
    });
  } catch (err) { fail(res, err); }
});

export { TRAVEL_DESK_ROLES };
export default router;
