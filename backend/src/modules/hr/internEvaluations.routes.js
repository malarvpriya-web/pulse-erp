// ──────────────────────────────────────────────────────────────────────────────
// internEvaluations.routes.js — mentor evaluation of an intern, and HR review.
//
// Mounted at /api/intern-evaluations (and /api/v1/…). Two audiences, two gates:
//
//   MENTOR  /mine…   Decided by IDENTITY, not by a permission row. The caller's
//                    login must link (users.employee_id) to the intern's CURRENT
//                    mentor, who must be a current employee of the caller's
//                    company. No `internships` permission is consulted or
//                    granted — a mentor gets this one evaluation, never the
//                    intern register or the edit form.
//   HR      queue / history need internships:view; the review needs
//                    internships:approve (super_admin, admin, hr, hr_manager —
//                    20261013000004). The reviewer may not be the submitter or
//                    the evaluating mentor.
//
// Every query is scoped by companyOf(req). Nothing reads a company id from the
// body. Every state change appends an intern_evaluation_events row (UPDATE on
// that table is refused by trigger) and an audit_logs entry.
//
// REQUEST WORKFLOW (HR, internships:edit): Request Mentor Evaluation creates
// the evaluation for a chosen mentor and sends it (in-app notification + the
// evaluation letter as a PDF the mentor can download). Reminders are counted.
// A mentor returns it online (Submit) or on paper: HR then records the ratings
// AND attaches the returned document (POST /:id/receive) — never ratings
// without the mentor's document. Files go through StorageService and are
// served by /api/files like every other intern document.
//
// Request status (Draft / Sent / Reminder / Received / Completed) is derived
// from the row (REQUEST_STATUS_SQL), never stored separately.
//
// This router never changes `interns`; completion is POST /interns/:id/complete.
// ──────────────────────────────────────────────────────────────────────────────
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission, permissionFor } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { logAudit } from '../../services/AuditService.js';
import { respondError } from '../../shared/pgErrors.js';
import { isCurrentSql } from '../../shared/employeeStatus.js';
import { uploadFile, deleteFile } from '../../services/StorageService.js';
import { sendNotificationEmail } from '../../utils/mailer.js';
import { buildEvaluationLetterPdf } from '../../utils/internshipPdf.js';
import { RECOMMENDATIONS, RATING_FIELDS, RATING_SCALE, REQUEST_STATUSES, REQUEST_STATUS_SQL } from '../../shared/internship.js';
import { loadTemplate, renderTemplate, internValues, companyName, fmtDocDate } from '../../shared/internshipTemplates.js';
import { singleFileUpload } from './internshipUploads.js';

const router = express.Router();

export { RECOMMENDATIONS };
export const EVALUATION_STATUSES = ['Draft', 'Submitted', 'Returned', 'Approved'];
/** States the mentor may still edit. */
const EDITABLE = ['Draft', 'Returned'];
const MAX_COMMENTS = 5000;

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode: status, ...extra });
}
function sendError(res, err) {
  if (err?.statusCode) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.field ? { field: err.field } : {}),
      ...(typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) ? { code: err.code } : {}),
    });
  }
  return respondError(res, err);
}
const userIdOf = (req) => req.user?.userId ?? req.user?.id ?? null;

/**
 * The caller's employee id, read from users.employee_id — the login link — not
 * from a token claim, so a link changed or removed since login is honoured now.
 */
async function callerEmployeeId(db, req) {
  const uid = userIdOf(req);
  if (!uid) return null;
  const { rows } = await db.query(`SELECT employee_id FROM users WHERE id = $1::int`, [uid]);
  return rows[0]?.employee_id ?? null;
}

function requireCompany(req) {
  const companyId = companyOf(req);
  if (companyId == null) throw httpError(403, 'Your account is not assigned to a company.');
  return companyId;
}

const RATING_KEYS = RATING_FIELDS.map(f => f.key);

const EVAL_SELECT = `
  ev.id, ev.intern_id, ev.mentor_employee_id, ev.comments, ev.recommendation, ev.status,
  ${RATING_KEYS.map(k => `ev.${k}`).join(', ')},
  ev.submitted_by_user_id, ev.submitted_at, ev.reviewed_by_user_id, ev.reviewed_at,
  ev.return_reason, ev.created_at, ev.updated_at,
  ev.requested_by_user_id, ev.request_sent_at, ev.reminder_count, ev.last_reminder_at,
  ev.received_at, ev.received_via, ev.evaluation_document_id,
  ${REQUEST_STATUS_SQL} AS request_status,
  ed.file_url AS evaluation_document_url, ed.original_name AS evaluation_document_name,
  NULLIF(BTRIM(CONCAT_WS(' ', me.first_name, me.last_name)), '') AS mentor_name,
  me.office_id AS mentor_office_id,
  su.name AS submitted_by_name, ru.name AS reviewed_by_name, qu.name AS requested_by_name`;
const EVAL_FROM = `
  FROM intern_evaluations ev
  JOIN employees me ON me.id = ev.mentor_employee_id
  LEFT JOIN users su ON su.id = ev.submitted_by_user_id
  LEFT JOIN users ru ON ru.id = ev.reviewed_by_user_id
  LEFT JOIN users qu ON qu.id = ev.requested_by_user_id
  LEFT JOIN intern_documents ed ON ed.id = ev.evaluation_document_id AND ed.deleted_at IS NULL`;

/**
 * Which interns may this mentor (employee $3, company $2, row alias i) evaluate?
 * Their CURRENT mentees, plus any intern whose OPEN evaluation HR has SENT to
 * them — Request Mentor Evaluation may name someone other than the assigned
 * mentor. A draft HR has not sent grants nothing, and neither does a closed one.
 */
const mentorAccessSql = (emp) => `(
  i.mentor_employee_id = ${emp}::int
  OR EXISTS (SELECT 1 FROM intern_evaluations aev
              WHERE aev.intern_id = i.id AND aev.mentor_employee_id = ${emp}::int
                AND aev.request_sent_at IS NOT NULL
                AND aev.status IN ('Draft', 'Submitted', 'Returned')))`;
/** The caller's own employee row: current, in the caller's company. */
const mentorSelfJoin = (company, emp) =>
  `JOIN employees e ON e.id = ${emp}::int AND e.company_id = ${company}::int AND e.deleted_at IS NULL AND ${isCurrentSql('e.status')}`;

/**
 * The intern, IF the caller is its current mentor — else a 404 that says
 * nothing about whether the intern exists. Locks the intern row when asked so a
 * concurrent mentor change cannot interleave with a save.
 */
async function mentoredIntern(db, req, internId, { lock = false } = {}) {
  const companyId = requireCompany(req);
  const employeeId = await callerEmployeeId(db, req);
  if (!employeeId) throw httpError(403, 'Your login is not linked to an employee record, so it cannot evaluate interns.');
  const { rows } = await db.query(
    `SELECT i.id, i.intern_code, i.first_name, i.last_name, i.department, i.designation,
            i.start_date::text AS start_date, i.end_date::text AS end_date, i.status, i.company_id,
            i.mentor_employee_id, i.project_work_area
       FROM interns i
       ${mentorSelfJoin('$2', '$3')}
      WHERE i.id = $1::int AND i.deleted_at IS NULL
        AND i.company_id = $2::int
        AND ${mentorAccessSql('$3')}
      ${lock ? 'FOR UPDATE OF i' : ''}`,
    [internId, companyId, employeeId]);
  if (!rows.length) throw httpError(404, 'No intern you currently mentor has that id.');
  return { intern: rows[0], companyId, employeeId };
}

/** A 1..5 rating, or null when blank. Anything else is a 400 naming the field. */
function rating(raw, key) {
  if (raw == null || raw === '' || raw === 'null') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > RATING_SCALE.length) {
    const label = RATING_FIELDS.find(f => f.key === key)?.label || key;
    throw httpError(400, `${label} must be a rating from 1 to ${RATING_SCALE.length}.`, { field: key });
  }
  return n;
}

function validateContent(body, { forSubmit }) {
  const comments = body?.comments == null ? null : String(body.comments).trim();
  const recommendation = body?.recommendation == null || body.recommendation === '' ? null : String(body.recommendation).trim();
  const ratings = Object.fromEntries(RATING_KEYS.map(k => [k, rating(body?.[k], k)]));
  if (comments != null && comments.length > MAX_COMMENTS) {
    throw httpError(400, `Comments are limited to ${MAX_COMMENTS} characters.`, { field: 'comments' });
  }
  if (recommendation != null && !RECOMMENDATIONS.includes(recommendation)) {
    throw httpError(400, `Recommendation must be one of: ${RECOMMENDATIONS.join(', ')}.`, { field: 'recommendation' });
  }
  if (forSubmit) {
    const missing = RATING_FIELDS.find(f => ratings[f.key] == null);
    if (missing) throw httpError(400, `Rate ${missing.label} before submitting.`, { field: missing.key });
    if (!comments) throw httpError(400, 'Add evaluation comments before submitting.', { field: 'comments' });
    if (!recommendation) throw httpError(400, 'Choose a recommendation before submitting.', { field: 'recommendation' });
  }
  return { comments: comments || null, recommendation, ...ratings };
}

/** `comments = $2, recommendation = $3, <ratings> = $4…$9` for UPDATE … WHERE id = $1. */
const CONTENT_SETS = ['comments = $2::text', 'recommendation = $3::varchar',
  ...RATING_KEYS.map((k, i) => `${k} = $${i + 4}::smallint`)].join(', ');
const contentValues = (c) => [c.comments, c.recommendation, ...RATING_KEYS.map(k => c[k] ?? null)];

async function loadEvaluation(db, id) {
  const { rows } = await db.query(`SELECT ${EVAL_SELECT} ${EVAL_FROM} WHERE ev.id = $1::int`, [id]);
  return rows[0] ?? null;
}

async function appendEvent(db, ev, { action, fromStatus, actorUserId, actorEmployeeId, reason = null }) {
  const snapshot = {
    status: ev.status, comments: ev.comments, recommendation: ev.recommendation,
    ...Object.fromEntries(RATING_KEYS.map(k => [k, ev[k]])),
    request_sent_at: ev.request_sent_at, reminder_count: ev.reminder_count,
    received_at: ev.received_at, received_via: ev.received_via, evaluation_document_id: ev.evaluation_document_id,
    submitted_by_user_id: ev.submitted_by_user_id, submitted_at: ev.submitted_at,
    reviewed_by_user_id: ev.reviewed_by_user_id, reviewed_at: ev.reviewed_at, return_reason: ev.return_reason,
  };
  await db.query(
    `INSERT INTO intern_evaluation_events
       (company_id, evaluation_id, intern_id, action, from_status, to_status, actor_user_id, actor_employee_id, reason, snapshot)
     SELECT company_id, id, intern_id, $2::varchar, $3::varchar, status, $4::int, $5::int, $6::text, $7::jsonb
       FROM intern_evaluations WHERE id = $1::int`,
    [ev.id, action, fromStatus, actorUserId, actorEmployeeId, reason, JSON.stringify(snapshot)]);
}

/**
 * Create-or-update the caller's open evaluation for this intern. Returns
 * { evaluation, fromStatus, created }. Runs inside the caller's transaction.
 */
async function saveDraft(client, req, internId, content) {
  const { intern, employeeId } = await mentoredIntern(client, req, internId, { lock: true });
  const { rows: [open] } = await client.query(
    `SELECT id, status FROM intern_evaluations
      WHERE intern_id = $1::int AND mentor_employee_id = $2::int AND status IN ('Draft','Submitted','Returned')
      FOR UPDATE`, [intern.id, employeeId]);
  if (open && !EDITABLE.includes(open.status)) {
    throw httpError(409, 'This evaluation has been submitted and is waiting for HR review. It can be revised only if HR returns it.');
  }
  if (!open) {
    // Only the CURRENT mentor starts an evaluation unasked. Someone HR sent a
    // request to always has that open row, so they never reach this branch.
    if (intern.mentor_employee_id !== employeeId) throw httpError(404, 'No intern you currently mentor has that id.');
    const { rows: [row] } = await client.query(
      `INSERT INTO intern_evaluations (intern_id, mentor_employee_id, created_by_user_id)
       VALUES ($1::int, $2::int, $3::int) RETURNING id`,
      [intern.id, employeeId, userIdOf(req)]);
    await client.query(`UPDATE intern_evaluations SET ${CONTENT_SETS} WHERE id = $1::int`, [row.id, ...contentValues(content)]);
    return { id: row.id, fromStatus: null, created: true, intern, employeeId };
  }
  await client.query(
    `UPDATE intern_evaluations SET ${CONTENT_SETS}, updated_at = NOW() WHERE id = $1::int`,
    [open.id, ...contentValues(content)]);
  return { id: open.id, fromStatus: open.status, created: false, intern, employeeId };
}

function audit(req, ev, action, oldData, companyId) {
  logAudit({ userId: userIdOf(req), module: 'internships', recordId: ev.id, recordType: 'intern_evaluation',
    action, oldData, newData: ev, req, company_id: companyId });
}

// ── Mentor ───────────────────────────────────────────────────────────────────

/**
 * GET /mine/summary — "is this login a current mentor?", for the navigation.
 *
 * The Sidebar draws the My Intern Evaluations entry only when this says yes, so
 * the entry follows the ASSIGNMENT, not the role: a manager or employee who
 * mentors nobody never sees it, and a former mentor loses it the moment the
 * intern is reassigned. Same identity rule as every other /mine route (login ->
 * users.employee_id -> current employee of the caller's company -> currently
 * the intern's mentor). No permission is consulted or granted, and it returns
 * counts only — never another person's data.
 *
 * `needs_action` counts mentored interns, not yet closed, whose latest
 * evaluation by this mentor is missing, a Draft, or Returned by HR.
 */
router.get('/mine/summary', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const employeeId = companyId == null ? null : await callerEmployeeId(pool, req);
    if (!employeeId) return res.json({ linked: employeeId != null, is_mentor: false, interns: 0, needs_action: 0 });
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*)::int AS interns,
              COUNT(*) FILTER (
                WHERE i.status NOT IN ('Completed', 'Cancelled', 'Terminated')
                  AND COALESCE((SELECT ev.status FROM intern_evaluations ev
                                 WHERE ev.intern_id = i.id AND ev.mentor_employee_id = $2::int
                                 ORDER BY ev.id DESC LIMIT 1), 'none') IN ('none', 'Draft', 'Returned'))::int AS needs_action
         FROM interns i
         ${mentorSelfJoin('$1', '$2')}
        WHERE i.deleted_at IS NULL AND i.company_id = $1::int AND ${mentorAccessSql('$2')}`,
      [companyId, employeeId]);
    res.json({ linked: true, is_mentor: r.interns > 0, interns: r.interns, needs_action: r.needs_action });
  } catch (err) { sendError(res, err); }
});

/** Interns the caller currently mentors, each with the caller's latest evaluation. */
router.get('/mine', async (req, res) => {
  try {
    const companyId = requireCompany(req);
    const employeeId = await callerEmployeeId(pool, req);
    if (!employeeId) return res.json({ linked: false, interns: [], recommendations: RECOMMENDATIONS, ratings: RATING_FIELDS, scale: RATING_SCALE });
    const { rows } = await pool.query(
      `SELECT i.id, i.intern_code, i.first_name, i.last_name, i.department, i.designation,
              i.start_date::text AS start_date, i.end_date::text AS end_date, i.status, i.project_work_area,
              (i.mentor_employee_id = $2::int) AS is_current_mentor
         FROM interns i
         ${mentorSelfJoin('$1', '$2')}
        WHERE i.deleted_at IS NULL AND i.company_id = $1::int AND ${mentorAccessSql('$2')}
        ORDER BY i.end_date, i.id`, [companyId, employeeId]);
    const ids = rows.map(r => r.id);
    const { rows: evals } = ids.length ? await pool.query(
      `SELECT DISTINCT ON (ev.intern_id) ${EVAL_SELECT} ${EVAL_FROM}
        WHERE ev.intern_id = ANY($1::int[]) AND ev.mentor_employee_id = $2::int
        ORDER BY ev.intern_id, ev.id DESC`, [ids, employeeId]) : { rows: [] };
    const byIntern = Object.fromEntries(evals.map(e => [e.intern_id, e]));
    res.json({
      linked: true,
      recommendations: RECOMMENDATIONS,
      ratings: RATING_FIELDS,
      scale: RATING_SCALE,
      interns: rows.map(r => ({ ...r, evaluation: byIntern[r.id] ?? null })),
    });
  } catch (err) { sendError(res, err); }
});

/** Save (create or revise) the caller's draft. Allowed while Draft or Returned. */
router.put('/mine/:internId', async (req, res) => {
  const internId = Number(req.params.internId);
  if (!Number.isInteger(internId) || internId < 1) return res.status(400).json({ error: 'Invalid intern id' });
  const client = await pool.connect();
  try {
    const content = validateContent(req.body, { forSubmit: false });
    await client.query('BEGIN');
    const saved = await saveDraft(client, req, internId, content);
    const ev = await loadEvaluation(client, saved.id);
    await appendEvent(client, ev, { action: saved.created ? 'created' : 'saved', fromStatus: saved.fromStatus,
      actorUserId: userIdOf(req), actorEmployeeId: saved.employeeId });
    await client.query('COMMIT');
    audit(req, ev, saved.created ? 'create' : 'update', null, saved.intern.company_id);
    res.json(ev);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});

/** Submit for HR review (saving any content sent with it). Draft/Returned → Submitted. */
router.post('/mine/:internId/submit', async (req, res) => {
  const internId = Number(req.params.internId);
  if (!Number.isInteger(internId) || internId < 1) return res.status(400).json({ error: 'Invalid intern id' });
  const client = await pool.connect();
  try {
    const sent = validateContent(req.body, { forSubmit: false });
    await client.query('BEGIN');
    const hasContent = req.body && ['comments', 'recommendation', ...RATING_KEYS].some(k => k in req.body);
    let saved;
    if (hasContent) {
      saved = await saveDraft(client, req, internId, sent);
    } else {
      const { intern, employeeId } = await mentoredIntern(client, req, internId, { lock: true });
      const { rows: [open] } = await client.query(
        `SELECT id, status FROM intern_evaluations
          WHERE intern_id = $1::int AND mentor_employee_id = $2::int AND status IN ('Draft','Submitted','Returned')
          FOR UPDATE`, [intern.id, employeeId]);
      if (!open) throw httpError(404, 'There is no draft evaluation to submit. Write one first.');
      if (!EDITABLE.includes(open.status)) throw httpError(409, 'This evaluation is already waiting for HR review.');
      saved = { id: open.id, fromStatus: open.status, created: false, intern, employeeId };
    }
    const current = await loadEvaluation(client, saved.id);
    validateContent(current, { forSubmit: true });
    // Content sent WITH the submit is a save in its own right: record it, so the
    // trail shows the draft being created (or revised) before it was submitted.
    if (hasContent) {
      await appendEvent(client, current, { action: saved.created ? 'created' : 'saved', fromStatus: saved.fromStatus,
        actorUserId: userIdOf(req), actorEmployeeId: saved.employeeId });
    }
    // A resubmission starts a fresh review: the previous decision lives in the
    // event trail, not on the row.
    await client.query(
      `UPDATE intern_evaluations
          SET status = 'Submitted', submitted_by_user_id = $2::int, submitted_at = NOW(),
              received_at = NOW(), received_via = 'Online',
              reviewed_by_user_id = NULL, reviewed_at = NULL, return_reason = NULL, updated_at = NOW()
        WHERE id = $1::int`, [saved.id, userIdOf(req)]);
    const ev = await loadEvaluation(client, saved.id);
    await appendEvent(client, ev, { action: 'submitted', fromStatus: saved.fromStatus ?? 'Draft',
      actorUserId: userIdOf(req), actorEmployeeId: saved.employeeId });
    await client.query('COMMIT');
    audit(req, ev, 'submit', current, saved.intern.company_id);
    res.json(ev);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});

// ── HR ───────────────────────────────────────────────────────────────────────

/** The evaluation vocabularies, so HR forms and the API cannot drift. */
router.get('/meta', requirePermission('internships', 'view'), (_req, res) => {
  res.json({ recommendations: RECOMMENDATIONS, ratings: RATING_FIELDS, scale: RATING_SCALE, request_statuses: REQUEST_STATUSES });
});

/** The review queue (default: Submitted), for the caller's company. */
router.get('/', requirePermission('internships', 'view'), async (req, res) => {
  try {
    const companyId = requireCompany(req);
    const status = String(req.query.status || 'Submitted');
    if (!EVALUATION_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
    const { rows } = await pool.query(
      `SELECT ${EVAL_SELECT}, i.intern_code,
              NULLIF(BTRIM(CONCAT_WS(' ', i.first_name, i.last_name)), '') AS intern_name
         ${EVAL_FROM}
         JOIN interns i ON i.id = ev.intern_id AND i.deleted_at IS NULL
        WHERE ev.company_id = $1::int AND ev.status = $2::varchar
        ORDER BY ev.submitted_at NULLS LAST, ev.id`, [companyId, status]);
    res.json(rows);
  } catch (err) { sendError(res, err); }
});

/** Every evaluation of one intern, with its event trail. */
router.get('/intern/:internId', requirePermission('internships', 'view'), async (req, res) => {
  const internId = Number(req.params.internId);
  if (!Number.isInteger(internId) || internId < 1) return res.status(400).json({ error: 'Invalid intern id' });
  try {
    const companyId = requireCompany(req);
    const { rows: own } = await pool.query(
      `SELECT 1 FROM interns WHERE id = $1::int AND company_id = $2::int AND deleted_at IS NULL`, [internId, companyId]);
    if (!own.length) return res.status(404).json({ error: 'Intern not found' });
    const { rows: evals } = await pool.query(
      `SELECT ${EVAL_SELECT} ${EVAL_FROM} WHERE ev.intern_id = $1::int AND ev.company_id = $2::int ORDER BY ev.id DESC`,
      [internId, companyId]);
    const { rows: events } = evals.length ? await pool.query(
      `SELECT x.id, x.evaluation_id, x.action, x.from_status, x.to_status, x.reason, x.created_at,
              x.actor_user_id, u.name AS actor_name
         FROM intern_evaluation_events x LEFT JOIN users u ON u.id = x.actor_user_id
        WHERE x.evaluation_id = ANY($1::int[]) AND x.company_id = $2::int
        ORDER BY x.id`, [evals.map(e => e.id), companyId]) : { rows: [] };
    const me = await callerEmployeeId(pool, req);
    res.json(evals.map(e => ({
      ...e,
      events: events.filter(x => x.evaluation_id === e.id),
      // Tells the page whether to offer Approve / Return to this viewer; the
      // review endpoint enforces the same rule on its own.
      is_own: e.submitted_by_user_id === userIdOf(req) || (me != null && e.mentor_employee_id === me),
    })));
  } catch (err) { sendError(res, err); }
});

/** Approve or Return a submitted evaluation. */
router.post('/:id/review', requirePermission('internships', 'approve'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid evaluation id' });
  const decision = String(req.body?.decision || '');
  if (!['Approve', 'Return'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be Approve or Return.', field: 'decision' });
  }
  const reason = req.body?.reason == null ? '' : String(req.body.reason).trim();
  if (decision === 'Return' && !reason) {
    return res.status(400).json({ error: 'Give a reason for returning the evaluation.', field: 'reason' });
  }
  if (reason.length > MAX_COMMENTS) return res.status(400).json({ error: 'Reason is too long.', field: 'reason' });
  const client = await pool.connect();
  try {
    const companyId = requireCompany(req);
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      `SELECT * FROM intern_evaluations WHERE id = $1::int AND company_id = $2::int FOR UPDATE`, [id, companyId]);
    if (!row) throw httpError(404, 'Evaluation not found');
    if (row.status !== 'Submitted') {
      throw httpError(409, `Only a submitted evaluation can be reviewed; this one is ${row.status}.`);
    }
    const reviewerUser = userIdOf(req);
    const reviewerEmployee = await callerEmployeeId(client, req);
    if (row.submitted_by_user_id === reviewerUser || (reviewerEmployee != null && reviewerEmployee === row.mentor_employee_id)) {
      throw httpError(403, 'You wrote this evaluation, so someone else in HR must review it.');
    }
    const before = await loadEvaluation(client, id);
    const toStatus = decision === 'Approve' ? 'Approved' : 'Returned';
    await client.query(
      `UPDATE intern_evaluations
          SET status = $2::varchar, reviewed_by_user_id = $3::int, reviewed_at = NOW(),
              return_reason = $4::text, updated_at = NOW()
        WHERE id = $1::int`,
      [id, toStatus, reviewerUser, decision === 'Return' ? reason : null]);
    const ev = await loadEvaluation(client, id);
    await appendEvent(client, ev, { action: decision === 'Approve' ? 'approved' : 'returned', fromStatus: 'Submitted',
      actorUserId: reviewerUser, actorEmployeeId: reviewerEmployee, reason: reason || null });
    await client.query('COMMIT');
    audit(req, ev, decision === 'Approve' ? 'approve' : 'reject', before, companyId);
    res.json(ev);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});

// ── HR: the evaluation request ───────────────────────────────────────────────
//
// Request Mentor Evaluation → (Draft) → Send → Sent → Remind → Reminder
//   → the mentor submits online, or HR records the returned document → Received
//   → HR approves → Completed.
// All of it needs internships:edit, and is scoped to the caller's company.

const posInt = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; };
const OPEN = ['Draft', 'Submitted', 'Returned'];

/** The intern, in the caller's company, with what the letter needs. */
async function companyIntern(db, internId, companyId, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT i.id, i.company_id, i.intern_code, i.first_name, i.last_name, i.department, i.designation,
            i.college, i.course, i.specialization, i.project_work_area, i.mentor_employee_id, i.status,
            i.start_date::text AS start_date, i.end_date::text AS end_date
       FROM interns i
      WHERE i.id = $1::int AND i.company_id = $2::int AND i.deleted_at IS NULL
      ${lock ? 'FOR UPDATE OF i' : ''}`, [internId, companyId]);
  return rows[0] ?? null;
}

/**
 * Tell the mentor, in-app (every login linked to that employee). Runs on the
 * caller's transaction. Returns the addresses to e-mail once it has committed,
 * so a rolled-back request never sends mail.
 */
async function notifyMentor(db, ev, intern, { reminder }) {
  const { rows: logins } = await db.query(
    `SELECT id, email FROM users WHERE employee_id = $1::int AND COALESCE(is_active, true)`, [ev.mentor_employee_id]);
  const name = [intern.first_name, intern.last_name].filter(Boolean).join(' ');
  const title = reminder ? 'Reminder: intern evaluation pending' : 'Intern evaluation requested';
  const message = `${reminder ? 'HR is still waiting for your evaluation of' : 'HR has asked you to evaluate'} ${name} (${intern.intern_code}). `
    + 'Open My Intern Evaluations to fill it in online, or download the evaluation letter, complete it and return it to HR.';
  for (const u of logins) {
    await db.query(
      `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
       VALUES ($1::int, $2::varchar, $3::text, 'internships', $4::int, 'intern_evaluation_request')`,
      [u.id, title, message, ev.id]);
  }
  return { count: logins.length, mail: logins.filter(u => u.email).map(u => ({ to: u.email, title, message })) };
}

/** After COMMIT: mirror the notification by e-mail, never failing the request. */
function mailMentor(mail, companyId) {
  for (const m of mail) {
    Promise.resolve()
      .then(() => sendNotificationEmail(m.to, { title: m.title, message: m.message, companyId }))
      .catch(err => console.error('[internEvaluations] mentor e-mail failed:', err.message));
  }
}

async function markSent(client, req, evId) {
  await client.query(
    `UPDATE intern_evaluations SET request_sent_at = NOW(), requested_by_user_id = COALESCE(requested_by_user_id, $2::int),
            updated_at = NOW() WHERE id = $1::int`, [evId, userIdOf(req)]);
  const ev = await loadEvaluation(client, evId);
  await appendEvent(client, ev, { action: 'requested', fromStatus: ev.status, actorUserId: userIdOf(req), actorEmployeeId: null });
  return ev;
}

/**
 * POST /request  { intern_id, mentor_employee_id?, send? = true }
 *
 * The mentor defaults to the intern's assigned mentor; HR may name another
 * current employee of the company. One OPEN evaluation per intern: an open one
 * by the same mentor is adopted (the mentor may have started unasked), one by a
 * different mentor is a 409 — two live verdicts on one internship is the
 * ambiguity the completion gate exists to avoid.
 */
router.post('/request', requirePermission('internships', 'edit'), async (req, res) => {
  const internId = posInt(req.body?.intern_id);
  if (!internId) return res.status(400).json({ error: 'Choose the intern.', field: 'intern_id' });
  const send = !(req.body?.send === false || req.body?.send === 'false');
  const client = await pool.connect();
  let mail = [];
  try {
    const companyId = requireCompany(req);
    await client.query('BEGIN');
    const intern = await companyIntern(client, internId, companyId, { lock: true });
    if (!intern) throw httpError(404, 'Intern not found');
    if (intern.status !== 'Active') {
      throw httpError(409, `A mentor evaluation is requested for an Active internship; this one is ${intern.status}.`);
    }
    const mentorId = posInt(req.body?.mentor_employee_id) ?? intern.mentor_employee_id;
    if (!mentorId) throw httpError(400, 'Select the mentor who will evaluate this intern.', { field: 'mentor_employee_id' });
    const { rows: [mentor] } = await client.query(
      `SELECT id FROM employees WHERE id = $1::int AND company_id = $2::int AND deleted_at IS NULL AND ${isCurrentSql('status')}`,
      [mentorId, companyId]);
    if (!mentor) throw httpError(400, 'That mentor is not a current employee of your company.', { field: 'mentor_employee_id' });

    const { rows: open } = await client.query(
      `SELECT id, mentor_employee_id, status, request_sent_at FROM intern_evaluations
        WHERE intern_id = $1::int AND status IN ('Draft','Submitted','Returned') ORDER BY id FOR UPDATE`, [internId]);
    let evId; let created = false;
    const mine = open.find(o => o.mentor_employee_id === mentorId);
    const other = open.find(o => o.mentor_employee_id !== mentorId);
    if (other) {
      throw httpError(409, 'Another mentor already has an open evaluation of this intern. Finish or review that one first.',
        { code: 'EVALUATION_ALREADY_OPEN' });
    }
    if (mine) {
      if (mine.status === 'Submitted') throw httpError(409, 'The mentor has already submitted this evaluation; review it instead.');
      if (mine.request_sent_at) throw httpError(409, 'This evaluation was already sent to the mentor. Use Send reminder.', { code: 'ALREADY_REQUESTED' });
      evId = mine.id;
      await client.query(`UPDATE intern_evaluations SET requested_by_user_id = $2::int, updated_at = NOW() WHERE id = $1::int`,
        [evId, userIdOf(req)]);
    } else {
      const { rows: [row] } = await client.query(
        `INSERT INTO intern_evaluations (intern_id, mentor_employee_id, created_by_user_id, requested_by_user_id)
         VALUES ($1::int, $2::int, $3::int, $3::int) RETURNING id`, [internId, mentorId, userIdOf(req)]);
      evId = row.id; created = true;
      const ev0 = await loadEvaluation(client, evId);
      await appendEvent(client, ev0, { action: 'created', fromStatus: null, actorUserId: userIdOf(req), actorEmployeeId: null });
    }
    let ev = await loadEvaluation(client, evId);
    let notified = 0;
    if (send) {
      ev = await markSent(client, req, evId);
      const n = await notifyMentor(client, ev, intern, { reminder: false });
      notified = n.count; mail = n.mail;
    }
    await client.query('COMMIT');
    mailMentor(mail, companyId);
    audit(req, ev, created ? 'create' : 'update', null, companyId);
    res.status(created ? 201 : 200).json({ ...ev, notified_logins: notified });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});

/** Lock an evaluation of the caller's company, with its intern. */
async function lockEvaluation(client, req, id) {
  const companyId = requireCompany(req);
  const { rows: [row] } = await client.query(
    `SELECT * FROM intern_evaluations WHERE id = $1::int AND company_id = $2::int FOR UPDATE`, [id, companyId]);
  if (!row) throw httpError(404, 'Evaluation not found');
  const intern = await companyIntern(client, row.intern_id, companyId);
  if (!intern) throw httpError(404, 'Evaluation not found');
  return { row, intern, companyId };
}

/** POST /:id/send — a Draft request goes to the mentor. */
router.post('/:id/send', requirePermission('internships', 'edit'), async (req, res) => {
  const id = posInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid evaluation id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { row, intern, companyId } = await lockEvaluation(client, req, id);
    if (row.request_sent_at) throw httpError(409, 'This evaluation was already sent. Use Send reminder.', { code: 'ALREADY_REQUESTED' });
    if (!['Draft', 'Returned'].includes(row.status)) throw httpError(409, `This evaluation is ${row.status}; there is nothing to send.`);
    const ev = await markSent(client, req, id);
    const n = await notifyMentor(client, ev, intern, { reminder: false });
    await client.query('COMMIT');
    mailMentor(n.mail, companyId);
    audit(req, ev, 'update', row, companyId);
    res.json({ ...ev, notified_logins: n.count });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});

/** POST /:id/remind — a sent, still-unanswered request is chased. */
router.post('/:id/remind', requirePermission('internships', 'edit'), async (req, res) => {
  const id = posInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid evaluation id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { row, intern, companyId } = await lockEvaluation(client, req, id);
    if (!row.request_sent_at) throw httpError(409, 'This evaluation has not been sent yet. Send it first.');
    if (!['Draft', 'Returned'].includes(row.status)) {
      throw httpError(409, `The mentor has already ${row.status === 'Approved' ? 'completed' : 'returned'} this evaluation.`);
    }
    await client.query(
      `UPDATE intern_evaluations SET reminder_count = reminder_count + 1, last_reminder_at = NOW(), updated_at = NOW()
        WHERE id = $1::int`, [id]);
    const ev = await loadEvaluation(client, id);
    await appendEvent(client, ev, { action: 'reminded', fromStatus: row.status, actorUserId: userIdOf(req), actorEmployeeId: null });
    const n = await notifyMentor(client, ev, intern, { reminder: true });
    await client.query('COMMIT');
    mailMentor(n.mail, companyId);
    audit(req, ev, 'update', row, companyId);
    res.json({ ...ev, notified_logins: n.count });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});

/** Store the returned form as the intern's 'Mentor Evaluation' document. */
async function storeEvaluationDocument(client, req, row, intern) {
  const f = req.file;
  const url = await uploadFile(f.buffer, f.originalname, f.mimetype);
  try {
    const { rows: [doc] } = await client.query(
      `INSERT INTO intern_documents (company_id, intern_id, doc_type, title, file_url, original_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1::int, $2::int, 'Mentor Evaluation', $3::varchar, $4::text, $5::varchar, $6::varchar, $7::int, $8::int) RETURNING id`,
      [intern.company_id, intern.id, `Mentor evaluation #${row.id}`, url, f.originalname, f.mimetype, f.size, userIdOf(req)]);
    return { id: doc.id, url };
  } catch (err) {
    await deleteFile(url).catch(() => {});
    throw err;
  }
}

/**
 * POST /:id/receive  multipart { evaluation_file (required), ratings…, recommendation, comments }
 *
 * The mentor returned the form on paper / by mail. HR records what it says AND
 * attaches it — the document is required, so an evaluation recorded by HR is
 * always backed by the mentor's own. It is then Submitted (Received) and is
 * reviewed like any other: the HR user who recorded it cannot also approve it.
 */
router.post('/:id/receive', requirePermission('internships', 'edit'), singleFileUpload('evaluation_file'), async (req, res) => {
  const id = posInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid evaluation id' });
  if (!req.file) return res.status(400).json({ error: "Attach the mentor's returned evaluation document.", field: 'evaluation_file' });
  const client = await pool.connect();
  let stored = null;
  try {
    const content = validateContent(req.body, { forSubmit: true });
    await client.query('BEGIN');
    const { row, intern, companyId } = await lockEvaluation(client, req, id);
    if (!['Draft', 'Returned'].includes(row.status)) {
      throw httpError(409, row.status === 'Approved'
        ? 'This evaluation is already completed.'
        : 'This evaluation has already been received. Attach a document to it instead.');
    }
    stored = await storeEvaluationDocument(client, req, row, intern);
    await client.query(`UPDATE intern_evaluations SET ${CONTENT_SETS} WHERE id = $1::int`, [id, ...contentValues(content)]);
    await client.query(
      `UPDATE intern_evaluations
          SET status = 'Submitted', submitted_by_user_id = $2::int, submitted_at = NOW(),
              received_at = NOW(), received_via = 'Document', evaluation_document_id = $3::int,
              reviewed_by_user_id = NULL, reviewed_at = NULL, return_reason = NULL, updated_at = NOW()
        WHERE id = $1::int`, [id, userIdOf(req), stored.id]);
    const ev = await loadEvaluation(client, id);
    await appendEvent(client, ev, { action: 'received', fromStatus: row.status, actorUserId: userIdOf(req), actorEmployeeId: null });
    await client.query('COMMIT');
    audit(req, ev, 'submit', row, companyId);
    res.json(ev);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (stored) await deleteFile(stored.url).catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});

/** POST /:id/document  multipart { evaluation_file } — the signed copy of an evaluation received online. */
router.post('/:id/document', requirePermission('internships', 'edit'), singleFileUpload('evaluation_file'), async (req, res) => {
  const id = posInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid evaluation id' });
  if (!req.file) return res.status(400).json({ error: 'Choose the document to attach.', field: 'evaluation_file' });
  const client = await pool.connect();
  let stored = null;
  try {
    await client.query('BEGIN');
    const { row, intern, companyId } = await lockEvaluation(client, req, id);
    if (!['Submitted', 'Approved'].includes(row.status)) {
      throw httpError(409, 'Record a returned paper evaluation with "Record returned evaluation", which also captures its ratings.');
    }
    if (row.evaluation_document_id) {
      const { rows: [live] } = await client.query(
        `SELECT 1 FROM intern_documents WHERE id = $1::int AND deleted_at IS NULL`, [row.evaluation_document_id]);
      if (live) throw httpError(409, 'A document is already attached to this evaluation.');
    }
    stored = await storeEvaluationDocument(client, req, row, intern);
    await client.query(`UPDATE intern_evaluations SET evaluation_document_id = $2::int, updated_at = NOW() WHERE id = $1::int`,
      [id, stored.id]);
    const ev = await loadEvaluation(client, id);
    await appendEvent(client, ev, { action: 'document_attached', fromStatus: row.status, actorUserId: userIdOf(req), actorEmployeeId: null });
    await client.query('COMMIT');
    audit(req, ev, 'update', row, companyId);
    res.json(ev);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (stored) await deleteFile(stored.url).catch(() => {});
    sendError(res, err);
  } finally { client.release(); }
});

/**
 * GET /:id/letter.pdf — the Internship Completion / Evaluation Letter.
 *
 * HR (internships:view) of the company, or the mentor it is addressed to while
 * they may act on it (the same identity rule as /mine). Blank form until the
 * evaluation is in; afterwards it carries the submitted ratings, recommendation
 * and comments, i.e. it IS the completed evaluation document.
 */
router.get('/:id/letter.pdf', async (req, res) => {
  const id = posInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid evaluation id' });
  try {
    const companyId = requireCompany(req);
    const ev = await loadEvaluation(pool, id);
    if (!ev) return res.status(404).json({ error: 'Evaluation not found' });
    const intern = await companyIntern(pool, ev.intern_id, companyId);
    if (!intern) return res.status(404).json({ error: 'Evaluation not found' });
    let allowed = false;
    try { allowed = (await permissionFor(req, 'internships'))?.can_view === true; } catch { allowed = false; }
    if (!allowed) {
      const me = await callerEmployeeId(pool, req);
      if (me != null && me === ev.mentor_employee_id) {
        const { rows } = await pool.query(
          `SELECT 1 FROM interns i ${mentorSelfJoin('$2', '$3')}
            WHERE i.id = $1::int AND i.company_id = $2::int AND ${mentorAccessSql('$3')}`, [intern.id, companyId, me]);
        allowed = rows.length > 0;
      }
    }
    if (!allowed) return res.status(404).json({ error: 'Evaluation not found' });

    const tpl = await loadTemplate(pool, companyId, 'evaluation_letter');
    const company = await companyName(pool, companyId);
    const values = { ...internValues(intern, company), mentor_name: ev.mentor_name,
      request_date: fmtDocDate(ev.request_sent_at || ev.created_at) };
    const filled = ['Submitted', 'Approved'].includes(ev.status)
      ? { ...ev, submitted_on: fmtDocDate(ev.submitted_at) } : null;
    const pdf = await buildEvaluationLetterPdf({
      heading: renderTemplate(tpl.heading, values), text: renderTemplate(tpl.content, values),
      companyName: company, intern: values, mentorName: ev.mentor_name, evaluation: filled,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Evaluation-${intern.intern_code}-${ev.id}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (err) { sendError(res, err); }
});

export default router;
