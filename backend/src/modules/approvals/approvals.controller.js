import pool from "../../config/db.js";
import { notifyWorkflowEvent } from "../../services/WorkflowNotificationService.js";
import { logAudit } from "../../services/AuditService.js";
import { canOverride, canClaimCategory, isApproverRole } from "./approvals.authz.js";
import { isAttendanceApprover } from "../attendance/attendance.authz.js";
import { triggerEmail } from "../../services/emailTrigger.js";
import recruitmentRepository from "../recruitment/repositories/recruitment.repository.js";
import { getOfferValidityDays } from "../recruitment/offerValidity.js";
import {
  SOURCES, SOURCE_BY_TYPE, MODULE_DECIDED_TYPES, central,
  buildContext, loadSlaHours, displayStatus, DEFAULT_SLA_HOURS,
} from "./approvals.sources.js";

// The Approval Center is an inbox over the modules (see approvals.sources.js):
// it lists what awaits the caller, what the caller submitted, and what the
// caller decided. Decisions on module records go to the MODULE's endpoint —
// only requisitions, offers and central `approvals` rows are decided here,
// because this IS their native path.

const uid = (req) => req.user?.userId ?? req.user?.id ?? null;
const cid = (req) => req.scope?.company_id ?? null;

// JWT carries employee_id for most logins; legacy/demo users don't, so fall
// back to the users table (mirrors ownEmployeeId() in the travel routes).
async function myEmployeeId(req) {
  if (req.user?.employee_id != null) return req.user.employee_id;
  const userId = uid(req);
  if (!userId) return null;
  try {
    const { rows } = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
    return rows[0]?.employee_id ?? null;
  } catch { return null; }
}

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode: status, extra });
}

const send = (res, err, fallback) => {
  // A malformed id (non-numeric requisition, non-uuid offer) is "not found",
  // not a server error.
  if (err.code === '22P02') return res.status(404).json({ error: 'Request not found' });
  if (!err.statusCode) console.error(fallback, err);
  res.status(err.statusCode || 500).json({ error: err.message, ...(err.extra || {}) });
};

// ─── read model ──────────────────────────────────────────────────────────────

const hoursSince = (d) => (d ? (Date.now() - new Date(d).getTime()) / 3600000 : 0);

/**
 * Every pending row in the caller's company, annotated with can_act (does
 * the module let THIS caller decide it), the module action descriptors, its
 * SLA and overdue flag. "My Pending Approvals" is the can_act subset.
 */
async function collectPending(req, ctx) {
  const companyId = cid(req);
  const sla = await loadSlaHours();
  const all = [...SOURCES, central];
  const perSource = await Promise.all(all.map(s => s.pending(companyId)));

  const out = [];
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    for (const r of perSource[i]) {
      const canAct = !!(await s.canAct(ctx, r));
      const slaHours = sla[s.type]?.hours ?? DEFAULT_SLA_HOURS;
      const waiting = hoursSince(r.request_date);
      out.push({
        id: String(r.id),
        type: s.type,
        module_name: s.type === 'appr' ? r.category : s.type,
        request_type: s.type === 'appr' ? (r.category || s.label) : s.label,
        request_title: r.request_title,
        description: r.description ?? null,
        requested_by: r.requested_by ?? '—',
        requester_email: r.requester_email ?? null,
        department: r.department ?? null,
        request_date: r.request_date,
        amount: r.amount != null ? Number(r.amount) : null,
        amount_unit: r.amount_unit ?? null,
        priority: r.priority || 'Medium',
        stage: s.stage(r),
        sla_hours: slaHours,
        sla_source: sla[s.type]?.source ?? 'default',
        waiting_hours: Math.floor(waiting),
        overdue: waiting > slaHours,
        link_page: s.page ?? null,
        can_act: canAct,
        actions: canAct ? s.actions(r) : {},
      });
    }
  }
  out.sort((a, b) => new Date(a.request_date || 0) - new Date(b.request_date || 0));
  return out;
}

// Central-table history rows written by the old Approval Center for module
// records carry module_name in one of these spellings.
const CENTRAL_TO_TYPE = {
  leave: 'leave', reg: 'reg', regularization: 'reg', ot: 'ot',
  pr: 'pr', purchase: 'pr', purchase_request: 'pr', exp: 'exp', expense: 'exp',
  ecn: 'ecn', pay: 'pay', payment: 'pay', requisition: 'requisition', offer: 'offer',
};

async function collectHistory(ctx) {
  const sources = SOURCES.filter(s => s.decided);
  const [perSource, centralRows] = await Promise.all([
    Promise.all(sources.map(s => s.decided(ctx))),
    central.decided(ctx),
  ]);

  const rows = [];
  const seen = new Set();
  sources.forEach((s, i) => {
    for (const r of perSource[i]) {
      const ref = `${s.type}:${r.source_id}`;
      seen.add(ref);
      rows.push({ ...r, ref, key: `${ref}:${r.stage || ''}:${String(r.decision).toLowerCase()}`,
        type: s.type, request_type: s.label, link_page: s.page });
    }
  });
  for (const r of centralRows) {
    const t = CENTRAL_TO_TYPE[String(r.category || '').toLowerCase()];
    // Skip a central shadow row when the module's own record already shows the
    // same decision by this person; keep it when it is the only trace (e.g. a
    // leave decided through the old Approval Center path, which wrote no
    // leave_approval_history row).
    if (t && r.source_id && seen.has(`${t}:${r.source_id}`)) continue;
    const src = t ? SOURCE_BY_TYPE[t] : null;
    rows.push({
      ...r, key: `appr:${r.id}`, ref: t && r.source_id ? `${t}:${r.source_id}` : String(r.id), type: t || 'appr',
      request_type: src?.label || r.category || 'Approval', link_page: src?.page ?? null,
    });
  }
  return rows
    .filter(r => r.decision_date)
    .map(r => ({
      id: r.ref,      // the request, e.g. "travel:12" — what the Approval Center links on
      key: r.key,     // unique per decision (one request can carry several levels)
      type: r.type,
      request_type: r.request_type,
      request_title: r.request_title,
      requested_by: r.requested_by || '—',
      request_date: r.request_date,
      decision: String(r.decision).toLowerCase() === 'rejected' ? 'Rejected' : 'Approved',
      decision_date: r.decision_date,
      comments: r.comments || null,
      stage: r.stage || null,
      link_page: r.link_page,
    }))
    .sort((a, b) => new Date(b.decision_date) - new Date(a.decision_date));
}

const sameLocalDay = (d) => d && new Date(d).toDateString() === new Date().toDateString();

// ─── controller functions ────────────────────────────────────────────────────

// Legacy raw listing of the central table. Not used by the Approval Center UI.
export const getAllApprovals = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const userId    = uid(req);
    const companyId = cid(req);
    const { status, module_name, limit = 100, offset = 0 } = req.query;

    const conditions = ['1=1'];
    const params = [];
    if (companyId != null) { params.push(companyId); conditions.push(`company_id = $${params.length}`); }
    if (!canOverride(req)) { params.push(userId); conditions.push(`approver_id = $${params.length}`); }
    if (status)      { params.push(status);      conditions.push(`status = $${params.length}`); }
    if (module_name) { params.push(module_name); conditions.push(`module_name = $${params.length}`); }
    params.push(Math.min(parseInt(limit, 10) || 100, 500), parseInt(offset, 10) || 0);

    const result = await pool.query(
      `SELECT * FROM approvals
       WHERE ${conditions.join(' AND ')}
       ORDER BY request_date DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    send(res, err, 'Get all approvals error:');
  }
};

/**
 * The caller's My Pending Approvals rows, oldest first. Home's preview card
 * reads this too, so the card and "View all" can never disagree.
 */
export async function myPendingApprovals(req) {
  const ctx = await buildContext(req);
  return (await collectPending(req, ctx)).filter(r => r.can_act);
}

/** My Pending Approvals — only rows the caller can actually decide. */
export const getPendingApprovals = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const mine = await myPendingApprovals(req);
    const limit  = Math.min(parseInt(req.query.limit || '500', 10) || 500, 1000);
    const offset = parseInt(req.query.offset || '0', 10) || 0;
    res.json(mine.slice(offset, offset + limit));
  } catch (err) {
    send(res, err, 'Get pending approvals error:');
  }
};

/** Approval History — decisions the caller made, across every module. */
export const getApprovalHistory = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const ctx = await buildContext(req);
    res.json((await collectHistory(ctx)).slice(0, 200));
  } catch (err) {
    send(res, err, 'Get approval history error:');
  }
};

/**
 * KPIs, computed from the SAME rows the tabs show, for the SAME person:
 *   pending        = rows in My Pending Approvals
 *   overdue        = those waiting longer than their SLA (configured
 *                    workflow_steps.sla_hours for the type, else the 48h default)
 *   approvedToday / rejectedToday = my decisions dated today
 *   slaCompliance  = % of my decisions in the last 30 days made within SLA;
 *                    null when I made none — the UI shows "No data", never 100%.
 */
export const getApprovalStats = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const ctx = await buildContext(req);
    const [pending, history, sla] = await Promise.all([
      collectPending(req, ctx).then(rows => rows.filter(r => r.can_act)),
      collectHistory(ctx),
      loadSlaHours(),
    ]);

    const cutoff = Date.now() - 30 * 86400000;
    const recent = history.filter(h => h.request_date && new Date(h.decision_date).getTime() >= cutoff);
    const within = recent.filter(h => {
      const hours = (new Date(h.decision_date) - new Date(h.request_date)) / 3600000;
      return hours <= (sla[h.type]?.hours ?? DEFAULT_SLA_HOURS);
    });

    const configured = Object.entries(sla)
      .filter(([, v]) => v.source === 'configured')
      .map(([type, v]) => ({ type, label: SOURCE_BY_TYPE[type]?.label || type, hours: v.hours }));

    res.json({
      pending:        pending.length,
      overdue:        pending.filter(r => r.overdue).length,
      approvedToday:  history.filter(h => h.decision === 'Approved' && sameLocalDay(h.decision_date)).length,
      rejectedToday:  history.filter(h => h.decision === 'Rejected' && sameLocalDay(h.decision_date)).length,
      slaCompliance:  recent.length ? Math.round((within.length / recent.length) * 100) : null,
      slaDecisions:   recent.length,
      sla: { default_hours: DEFAULT_SLA_HOURS, configured },
      // Whether to show the approver tabs at all. True for anyone who holds an
      // approval role/permission, has something to decide, or has decided before.
      isApprover: pending.length > 0 || history.length > 0
        || isApproverRole(req) || isAttendanceApprover(req)
        || !!ctx.perms.leaves?.can_approve || ctx.directReports.size > 0,
    });
  } catch (err) {
    send(res, err, 'Get approval stats error:');
  }
};

/**
 * My Requests — everything the caller submitted in any module, newest first,
 * with status, current approver and the module page to view/track it on.
 * Scoped by the caller's own user/employee id, never by client input.
 */
export const getMyRequests = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const ctx = await buildContext(req);
    const all = [...SOURCES.filter(s => s.mine), central];
    const per = await Promise.all(all.map(s => (ctx.employeeId == null && s.type !== 'appr' && s.type !== 'pay' && s.type !== 'adv'
      ? [] : s.mine(ctx))));

    const submitted = [];
    all.forEach((s, i) => {
      for (const r of per[i]) {
        submitted.push({
          id: String(r.id),
          type: s.type,
          request_type: s.type === 'appr' ? (r.category || s.label) : s.label,
          request_title: r.request_title,
          request_date: r.request_date,
          amount: r.amount != null ? Number(r.amount) : null,
          amount_unit: r.amount_unit ?? null,
          status: displayStatus(r.raw_status),
          status_detail: r.raw_status,
          current_approver: r.current_approver ?? null,
          decided_at: r.decided_at ?? null,
          comments: r.comments ?? null,
          link_page: s.myPage ?? null,
          actions: s.myActions ? s.myActions(r) : {},
        });
      }
    });
    submitted.sort((a, b) => new Date(b.request_date || 0) - new Date(a.request_date || 0));
    res.json({ submitted: submitted.slice(0, 300) });
  } catch (err) {
    send(res, err, 'Get my requests error:');
  }
};

// ─── decisions this module owns: requisition, offer, central rows ───────────

function moduleEndpointError(prefix) {
  const src = SOURCE_BY_TYPE[prefix];
  return httpError(409, `${src.label} requests are decided by their own module so its approval levels, `
    + `balances and checks apply. Use the action provided by GET /approvals/pending.`,
  { code: 'USE_MODULE_ENDPOINT', type: prefix });
}

async function approveSourceItem(prefix, sourceId, req) {
  const companyId = cid(req);
  switch (prefix) {
    case 'requisition': {
      // Segregation of duties: requisition/offer are deliberately NOT narrowed
      // in APPROVER_CATEGORY_SCOPE, so the roles that raise a requisition could
      // otherwise approve their own from the shared pool.
      const reqRows = await pool.query(
        `SELECT requested_by, company_id FROM job_requisitions WHERE id = $1::integer`, [sourceId]);
      const row = reqRows.rows[0];
      if (!row || (companyId != null && Number(row.company_id) !== Number(companyId))) {
        throw httpError(404, 'Requisition not found');
      }
      const actorEmployeeId = await myEmployeeId(req);
      if (row.requested_by != null && actorEmployeeId != null && String(actorEmployeeId) === String(row.requested_by)) {
        throw httpError(403, 'You cannot approve a requisition you raised yourself. Ask another approver to review it.');
      }
      // Compare-and-swap on the prior state: two approvers racing the same
      // requisition must not both succeed.
      const updated = await pool.query(
        `UPDATE job_requisitions SET status = 'approved', updated_at = NOW()
          WHERE id = $1::integer AND status = 'pending_approval' RETURNING id`, [sourceId]);
      if (!updated.rows.length) {
        throw httpError(409, 'This requisition is no longer pending approval — someone else may have already actioned it.');
      }
      return { requesterEmployeeId: row.requested_by, companyId: row.company_id, label: 'Requisition' };
    }
    case 'offer': {
      const offerRow = (await pool.query(
        `SELECT company_id, created_by FROM offer_letters WHERE id = $1::uuid`, [sourceId])).rows[0];
      if (!offerRow || (companyId != null && Number(offerRow.company_id) !== Number(companyId))) {
        throw httpError(404, 'Offer not found');
      }
      // created_by is NULL on offers drafted before migration 20260813000002 and
      // on auto-drafted offers: "author unknown, allow", as for requisitions.
      const actorEmployeeId = await myEmployeeId(req);
      if (offerRow.created_by != null && actorEmployeeId != null && String(actorEmployeeId) === String(offerRow.created_by)) {
        throw httpError(403, 'You cannot approve an offer you raised yourself. Ask another approver to review it.');
      }
      // Expiry stamped at send time from the company's validity; COALESCE keeps
      // an expiry a recruiter deliberately set on the draft.
      const validityDays = await getOfferValidityDays(offerRow.company_id ?? null);
      const updated = await pool.query(
        `UPDATE offer_letters
            SET offer_status = 'sent', offer_sent_date = CURRENT_DATE,
                offer_expiry_date = COALESCE(offer_expiry_date, (CURRENT_DATE + $2::int)::date),
                updated_at = NOW()
          WHERE id = $1::uuid AND offer_status = 'pending_approval' RETURNING id`,
        [sourceId, validityDays]);
      if (!updated.rows.length) {
        throw httpError(409, 'This offer is no longer pending approval — someone else may have already actioned it.');
      }
      // Candidate-facing "offer sent" email — sending requires approval, so it fires here.
      const offer = await recruitmentRepository.findOfferById(sourceId, null);
      if (offer) {
        triggerEmail('offer_sent', {
          candidate_email: offer.candidate_email || '',
          candidate_name:  offer.candidate_name  || '',
          offer_date:      offer.offer_sent_date || '',
          designation:     offer.job_title        || '',
          ctc:             offer.offered_salary   || '',
        }, offer.company_id);
      }
      return { requesterEmployeeId: offerRow.created_by, companyId: offerRow.company_id, label: 'Offer Letter' };
    }
    default:
      if (MODULE_DECIDED_TYPES.has(prefix)) throw moduleEndpointError(prefix);
      throw httpError(400, `Unknown request type "${prefix}"`);
  }
}

// Reject = send back to draft for the requester to revise and resubmit —
// neither table has a 'rejected' state (job_requisitions' CHECK constraint is
// draft/pending_approval/approved/open/closed).
async function rejectSourceItem(prefix, sourceId, req) {
  const companyId = cid(req);
  const tables = {
    requisition: { sql: `UPDATE job_requisitions SET status = 'draft', updated_at = NOW()
                          WHERE id = $1::integer AND status = 'pending_approval'
                            AND ($2::int IS NULL OR company_id = $2) RETURNING requested_by AS author, company_id`,
                   label: 'Requisition' },
    offer:       { sql: `UPDATE offer_letters SET offer_status = 'draft', updated_at = NOW()
                          WHERE id = $1::uuid AND offer_status = 'pending_approval'
                            AND ($2::int IS NULL OR company_id = $2) RETURNING created_by AS author, company_id`,
                   label: 'Offer Letter' },
  };
  const t = tables[prefix];
  if (!t) {
    if (MODULE_DECIDED_TYPES.has(prefix)) throw moduleEndpointError(prefix);
    throw httpError(400, `Unknown request type "${prefix}"`);
  }
  const { rows } = await pool.query(t.sql, [sourceId, companyId]);
  if (!rows.length) {
    throw httpError(409, `This ${t.label.toLowerCase()} is no longer pending approval — someone else may have already actioned it.`);
  }
  return { requesterEmployeeId: rows[0].author, companyId: rows[0].company_id, label: t.label };
}

// History row for a decision made here, so it appears in Approval History and
// in the requester's "sent back" status. reference_id is an integer column; a
// uuid offer id goes in the title, which offer.mine() matches on.
async function recordDecision(prefix, sourceId, status, userId, comment, companyId) {
  const label = prefix.charAt(0).toUpperCase() + prefix.slice(1);
  const refId = /^\d+$/.test(sourceId) ? parseInt(sourceId, 10) : null;
  await pool.query(
    `INSERT INTO approvals
       (module_name, reference_id, reference_type, title, requester_name, approver_id,
        status, decision_date, comments, company_id)
     VALUES ($1, $2, $3, $4, 'System', $5, $6, NOW(), $7, $8)`,
    [prefix, refId, label, `${label} #${sourceId}`, userId, status, comment || null, companyId]
  );
}

async function decide(req, res, action) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { id } = req.params;
    const comment   = String(req.body?.comment ?? req.body?.comments ?? '').trim();
    const userId    = uid(req);
    const companyId = cid(req);
    const Status    = action === 'approve' ? 'Approved' : 'Rejected';

    if (action === 'reject' && !comment) {
      return res.status(400).json({ error: 'A reason is required when rejecting or sending back a request.' });
    }

    if (id.includes(':')) {
      const [prefix, sourceId] = id.split(':');
      const result = action === 'approve'
        ? await approveSourceItem(prefix, sourceId, req)
        : await rejectSourceItem(prefix, sourceId, req);
      await recordDecision(prefix, sourceId, Status, userId, comment, result.companyId ?? companyId);
      logAudit({
        userId, module: 'approvals', recordId: sourceId, recordType: prefix, action,
        oldData: { status: 'Pending' }, newData: { status: Status, comment: comment || null }, req,
      });
      // Tell the REQUESTER (an employees.id, resolved to their login). The old
      // code addressed this to the approver's own user id.
      notifyWorkflowEvent(action === 'approve' ? 'approved' : 'rejected', {
        module: result.label, recordId: sourceId,
        recipientIds: [result.requesterEmployeeId].filter(v => v != null),
        comments: comment,
      });
      return res.json({ id, status: Status, decision_date: new Date() });
    }

    // Central approvals table row.
    const existing = (await pool.query(
      `SELECT module_name, reference_id FROM approvals WHERE id = $1 ${companyId != null ? 'AND company_id = $2' : ''}`,
      companyId != null ? [id, companyId] : [id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Approval not found' });
    const linkedType = CENTRAL_TO_TYPE[String(existing.module_name || '').toLowerCase()];
    if (linkedType && existing.reference_id != null && MODULE_DECIDED_TYPES.has(linkedType)) {
      throw moduleEndpointError(linkedType);
    }

    const result = await pool.query(
      `UPDATE approvals
          SET status = $1, decision_date = NOW(), approver_id = $2,
              comments = COALESCE(NULLIF($3, ''), comments)
        WHERE id = $4 AND status = 'Pending' ${companyId != null ? 'AND company_id = $5' : ''}
        RETURNING *`,
      companyId != null ? [Status, userId, comment, id, companyId] : [Status, userId, comment, id]
    );
    const approval = result.rows[0];
    if (!approval) return res.status(409).json({ error: 'Approval not found or already processed' });

    if (linkedType && approval.reference_id != null && !MODULE_DECIDED_TYPES.has(linkedType)) {
      if (action === 'approve') await approveSourceItem(linkedType, String(approval.reference_id), req);
      else await rejectSourceItem(linkedType, String(approval.reference_id), req);
    }

    logAudit({
      userId, module: 'approvals', recordId: id, recordType: approval.module_name || 'approval', action,
      oldData: { status: 'Pending' }, newData: { status: Status, comment: comment || null }, req,
    });
    notifyWorkflowEvent(action === 'approve' ? 'approved' : 'rejected', {
      module: approval.module_name || 'Approval',
      recordId: approval.reference_id || approval.id,
      submitterUserId: approval.requested_by,
      comments: comment,
    });
    res.json(approval);
  } catch (err) {
    send(res, err, `${action} request error:`);
  }
}

export const approveRequest = (req, res) => decide(req, res, 'approve');
export const rejectRequest  = (req, res) => decide(req, res, 'reject');

/**
 * Bulk endpoints cover only what this module decides itself (requisition,
 * offer, central rows). Module records are skipped with code
 * USE_MODULE_ENDPOINT — the UI runs each row's own module action instead.
 */
async function bulk(req, res, action) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
  const comment = String(req.body?.comment ?? '').trim();
  if (action === 'reject' && !comment) return res.status(400).json({ error: 'A reason is required when rejecting.' });

  const results = [];
  const skipped = [];
  for (const raw of ids) {
    const id = String(raw);
    const prefix = id.includes(':') ? id.split(':')[0] : null;
    if (prefix && MODULE_DECIDED_TYPES.has(prefix)) { skipped.push({ id, code: 'USE_MODULE_ENDPOINT' }); continue; }
    if (prefix && !canClaimCategory(req, prefix)) { skipped.push({ id, code: 'APPROVAL_NOT_YOURS' }); continue; }
    if (!prefix && !canOverride(req)) {
      const own = (await pool.query(`SELECT approver_id FROM approvals WHERE id = $1`, [id])).rows[0];
      if (own && own.approver_id != null && String(own.approver_id) !== String(uid(req))) {
        skipped.push({ id, code: 'APPROVAL_NOT_YOURS' }); continue;
      }
    }
    // Re-use the single-item path through a captured response.
    let status = 200; let body = null;
    const fakeRes = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    await decide({ ...req, params: { id }, body: { comment } }, fakeRes, action);
    if (status >= 400) skipped.push({ id, code: body?.code || status, error: body?.error });
    else results.push({ id, status: action === 'approve' ? 'Approved' : 'Rejected' });
  }
  res.json({
    count: results.length, approvals: results,
    ...(skipped.length ? { skipped, message: 'Some items were not processed — see `skipped`.' } : {}),
  });
}

export const bulkApprove = (req, res) => bulk(req, res, 'approve');
export const bulkReject  = (req, res) => bulk(req, res, 'reject');

/**
 * Escalation of module records is automatic (workflowEscalation.cron.js,
 * leave.cron.js) and follows each module's SLA — there is no manual
 * "escalate" state in those modules. For a central row, escalation means
 * reassigning it to a named approver in the same company: it stays Pending.
 * (It used to flip the row to 'Escalated' with no new approver, which removed
 * it from every queue.)
 */
export const escalateRequest = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { id } = req.params;
    if (String(id).includes(':')) {
      return res.status(400).json({
        error: 'This request escalates automatically under its module\'s SLA rules; it cannot be escalated manually.',
        code: 'ESCALATION_IS_AUTOMATIC',
      });
    }
    const target = Number(req.body?.approver_user_id);
    if (!Number.isInteger(target)) return res.status(400).json({ error: 'approver_user_id is required' });
    const companyId = cid(req);
    if (!(await isActiveUserInCompany(target, companyId))) {
      return res.status(400).json({ error: 'The escalation target must be an active user in your company.' });
    }
    const result = await pool.query(
      `UPDATE approvals
          SET approver_id = $1,
              comments = CONCAT_WS(' ', comments, '[Escalated by user ' || $2::text || ']')
        WHERE id = $3 AND status = 'Pending' ${companyId != null ? 'AND company_id = $4' : ''}
        RETURNING *`,
      companyId != null ? [target, uid(req), id, companyId] : [target, uid(req), id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Approval not found or not in Pending status' });
    const approval = result.rows[0];
    logAudit({ userId: uid(req), module: 'approvals', recordId: id, recordType: approval.module_name || 'approval', action: 'escalate',
      oldData: { status: 'Pending' }, newData: { approver_id: target }, req });
    notifyWorkflowEvent('escalated', { module: approval.module_name || 'Approval', recordId: approval.reference_id || approval.id, approverUserId: target });
    res.json(approval);
  } catch (err) {
    send(res, err, 'Escalate error:');
  }
};

async function isActiveUserInCompany(userId, companyId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM users u LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.id = $1 AND u.is_active = TRUE
        AND ($2::int IS NULL OR COALESCE(e.company_id, u.company_id) = $2)`,
    [userId, companyId]);
  return rows.length > 0;
}

/**
 * Colleagues a request can be delegated to. Returns BOTH ids: module
 * delegation routes take an employees.id (delegate_employee_id); a central
 * approvals row's approver_id is a users.id. Only employees with an active
 * login are listed — a delegate who cannot sign in cannot decide anything.
 */
export const getDelegateUsers = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const companyId = cid(req);
    const qtext = String(req.query.q || '').trim();
    const params = [companyId];
    let filter = '';
    if (qtext) {
      params.push(`%${qtext}%`);
      filter = `AND (e.first_name ILIKE $2 OR e.last_name ILIKE $2 OR e.company_email ILIKE $2)`;
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (e.id) e.id, u.id AS user_id,
              TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) AS name,
              e.company_email AS email, e.designation, e.department
         FROM employees e
         JOIN users u ON u.employee_id = e.id AND u.is_active = TRUE
        WHERE LOWER(e.status) IN ('active', 'probation', 'notice')
          AND ($1::int IS NULL OR e.company_id = $1)
          AND e.id IS DISTINCT FROM $${params.length + 1}::int
          ${filter}
        ORDER BY e.id, u.id
        LIMIT 50`,
      [...params, await myEmployeeId(req)]
    );
    rows.sort((a, b) => a.name.localeCompare(b.name));
    res.json(rows);
  } catch (err) {
    send(res, err, 'Get delegate users error:');
  }
};

/**
 * Delegate central approvals rows to another login. Module records are
 * delegated through each module's own per-record delegation route (leave,
 * expense, travel) — the row's `actions.delegate` descriptor — because those
 * routes check that the caller is entitled to hand the decision on and write
 * the module's delegate column. The old code wrote an employees.id into
 * approved_by columns, which made a pending PR look "approved by" the delegate.
 */
export const delegateApprovals = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { ids, delegate_to_user_id } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
    const target = Number(delegate_to_user_id);
    if (!Number.isInteger(target)) return res.status(400).json({ error: 'delegate_to_user_id is required' });
    const userId = uid(req);
    const companyId = cid(req);
    if (String(target) === String(userId)) return res.status(400).json({ error: 'You cannot delegate to yourself.' });
    if (!(await isActiveUserInCompany(target, companyId))) {
      return res.status(400).json({ error: 'The delegate must be an active user in your company.' });
    }

    const results = [];
    const centralIds = [];
    for (const raw of ids) {
      const id = String(raw);
      if (id.includes(':')) {
        results.push({ id, delegated: false, code: 'USE_MODULE_ENDPOINT',
          error: 'Delegate this request from its row — it uses the module\'s own delegation.' });
      } else if (/^\d+$/.test(id)) centralIds.push(Number(id));
    }

    if (centralIds.length) {
      // Only rows the caller owns (or may override) can be handed on.
      const own = canOverride(req) ? '' : 'AND (approver_id = $3 OR approver_id IS NULL)';
      const params = [target, centralIds, ...(own ? [userId] : [])];
      const cFilter = companyId != null ? `AND company_id = $${params.length + 1}` : '';
      if (companyId != null) params.push(companyId);
      const r = await pool.query(
        `UPDATE approvals
            SET approver_id = $1,
                comments = CONCAT_WS(' ', comments, '[Delegated from user ' || COALESCE(approver_id::text, 'pool') || ']')
          WHERE id = ANY($2::int[]) AND status = 'Pending' ${own} ${cFilter}
          RETURNING *`, params);
      for (const approval of r.rows) {
        logAudit({ userId, module: 'approvals', recordId: approval.id, recordType: approval.module_name || 'approval', action: 'delegate',
          oldData: { approver_id: userId }, newData: { approver_id: target }, req });
        notifyWorkflowEvent('escalated', { module: approval.module_name || 'Approval', recordId: approval.reference_id || approval.id, approverUserId: target });
        results.push({ id: String(approval.id), delegated: true });
      }
      for (const cidv of centralIds) {
        if (!r.rows.some(a => a.id === cidv)) results.push({ id: String(cidv), delegated: false, error: 'Not found, already decided, or not yours to delegate' });
      }
    }

    res.json({ count: results.filter(r => r.delegated).length, delegate_to_user_id: target, approvals: results });
  } catch (err) {
    send(res, err, 'Delegate error:');
  }
};

// Company each chain-bearing source belongs to — the chain is only returned
// for a record in the caller's company.
const CHAIN_COMPANY_SQL = {
  leave: `SELECT e.company_id FROM leave_applications la JOIN employees e ON e.id = la.employee_id WHERE la.id = $1::integer`,
  exp:   `SELECT e.company_id FROM expense_claims c JOIN employees e ON e.id = c.employee_id WHERE c.id = $1::integer`,
  ecn:   `SELECT company_id FROM engineering_changes WHERE id = $1::integer`,
};

/** Approval chain / level trail for a request (leave levels, expense levels, ECN parallel approvers, central chain). */
export const getApprovalChain = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { id } = req.params;
    const companyId = cid(req);
    if (String(id).includes(':')) {
      const [prefix, sourceId] = String(id).split(':');
      const src = SOURCE_BY_TYPE[prefix];
      if (!src?.chain || !/^\d+$/.test(sourceId)) return res.json([]);
      const own = (await pool.query(CHAIN_COMPANY_SQL[prefix], [sourceId])).rows[0];
      if (!own || (companyId != null && Number(own.company_id) !== Number(companyId))) return res.json([]);
      return res.json(await src.chain(sourceId));
    }
    const { rows } = await pool.query(
      `SELECT c.step_order AS step, c.approver_name, c.approver, c.status, c.decision_date, c.comment
         FROM approval_chain c JOIN approvals a ON a.id = c.approval_id
        WHERE c.approval_id = $1 ${companyId != null ? 'AND a.company_id = $2' : ''}
        ORDER BY c.step_order ASC`,
      companyId != null ? [id, companyId] : [id]
    );
    res.json(rows);
  } catch (err) {
    if (err.code === '42P01' || err.code === '22P02') return res.json([]);
    send(res, err, 'Get approval chain error:');
  }
};
