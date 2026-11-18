import pool from "../config/db.js";
import { isCurrentSql, statusExpr, NOTICE_STATUS } from "../shared/employeeStatus.js";
import { toIsoDate, probationEndDate, parseProbationMonths } from "../shared/probationDates.js";
import { logAudit } from "../services/AuditService.js";
import { ProbationError, insertNotifications, dispatchAfterCommit } from "./probation.service.js";
import { freshClearance } from "../modules/hr/exitCase.js";

/**
 * Probation reviews (20261014000007_probation_reviews) — request,
 * department-head submission and the HR decision.
 *
 *   HR  : request a review for an employee on probation whose saved end date
 *         exists. The reviewer is resolved — never supplied — from the
 *         employee's department through the active department-head mapping.
 *   Head: submit a rating, comments and a recommendation for a review assigned
 *         to THEM. Identity is the caller's linked employee record
 *         as linked RIGHT NOW in users.employee_id (linkedEmployee); a
 *         reviewer id in the request is ignored, and the head is re-verified
 *         at submission time.
 *
 *   HR  : decide a SUBMITTED review (decideReview). This is the only step that
 *         changes the employee: confirmed → Active + confirmation date;
 *         extended → a new probation end date; not confirmed → an exit request
 *         (termination) and status Notice. Review and employee commit together.
 *
 *   HR  : cancel an open review with a reason (cancelReview), and print the
 *         confirmation / extension letter of a decided one (letterContent).
 *
 * Request, submission and cancellation never touch the employee row, probation dates,
 * confirmation, payroll or exit records. Every step is written to the audit trail (logAudit,
 * recordType 'probation_review'). The reviewer is notified in-app once per
 * review: the notification and reviewer_notified_at commit together, and a
 * repeated request returns the existing open review without notifying again.
 */

const RECOMMENDATIONS = ['confirm', 'extend', 'not_confirm'];
const COMMENTS_MAX = 4000;
const DEFAULT_LEAD_DAYS = 7;   // due date when the probation end date has already passed

const positiveInt = (v) => {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
};
const todayIso = async (db) => (await db.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
const addDaysIso = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fullName = (r, prefix = '') =>
  `${r[`${prefix}first_name`] ?? ''} ${r[`${prefix}last_name`] ?? ''}`.trim();

/* ── reviewer resolution ───────────────────────────────────────────────── */

/**
 * The department head who reviews `emp`: employee.department (text) → the
 * active master department of that name → this company's active
 * department_heads row → a head who is current and has an active login, and
 * is not the employee themselves. Anything else is a 409 that says why.
 *
 * `lock: true` takes a SHARE lock on the active mapping row (inside the
 * caller's transaction). Changing a department head needs FOR UPDATE on that
 * row (departmentHeads.service), so a submission that has verified "you are
 * the head" cannot interleave with a reassignment of the head: whichever
 * commits first, the other sees the committed state.
 */
export async function resolveReviewer(db, companyId, emp, { lock = false } = {}) {
  const deptName = String(emp.department ?? '').trim();
  if (!deptName) {
    throw new ProbationError(409, `${fullName(emp)} has no department, so no department head can be found to review them.`);
  }
  const { rows: [dept] } = await db.query(
    `SELECT id, name FROM master_departments
      WHERE is_active = true AND LOWER(BTRIM(name)) = LOWER(BTRIM($1::text))`,
    [deptName],
  );
  if (!dept) {
    throw new ProbationError(409, `Department "${deptName}" is not an active department in Master Data, so it has no department head.`);
  }
  const { rows: [head] } = await db.query(
    `SELECT dh.id AS department_head_id, h.id AS employee_id, h.first_name, h.last_name, h.office_id,
            (h.deleted_at IS NULL AND ${isCurrentSql('h.status')}) AS is_current,
            EXISTS (SELECT 1 FROM users u WHERE u.employee_id = h.id AND u.is_active = true) AS has_login
       FROM department_heads dh
       JOIN employees h ON h.id = dh.head_employee_id
      WHERE dh.company_id = $1 AND dh.department_id = $2 AND dh.ended_at IS NULL
      ${lock ? 'FOR SHARE OF dh' : ''}`,
    [companyId, dept.id],
  );
  if (!head) {
    throw new ProbationError(409, `No department head is assigned for ${dept.name}. Assign one under Department Heads first.`);
  }
  if (!head.is_current) {
    throw new ProbationError(409, `${fullName(head)}, the head of ${dept.name}, is no longer a current employee. Reassign the department head first.`);
  }
  if (!head.has_login) {
    throw new ProbationError(409, `${fullName(head)}, the head of ${dept.name}, has no active Pulse login. Reassign the department head first.`);
  }
  if (head.employee_id === emp.id) {
    throw new ProbationError(409, `${fullName(emp)} is the head of ${dept.name} and cannot review their own probation. Assign a different head first.`);
  }
  return { department_id: dept.id, department: dept.name, ...head };
}

/* ── HR: worklist and detail ───────────────────────────────────────────── */

const REVIEW_SELECT = `
  r.id, r.employee_id, r.cycle_no, r.period_start::text AS period_start,
  r.original_end_date::text AS original_end_date, r.status,
  r.requested_at, r.reviewer_due_date::text AS reviewer_due_date, r.reviewer_notified_at,
  r.reviewer_employee_id, r.department_id,
  r.rating, r.comments, r.recommendation, r.submitted_at,
  r.decision, r.decision_notes, r.decided_at, r.extension_months, r.new_end_date::text AS new_end_date,
  r.cancelled_at, r.cancel_reason,
  (r.status = 'requested' AND r.reviewer_due_date < CURRENT_DATE) AS is_overdue,
  e.office_id, e.first_name, e.last_name, e.department,
  rv.first_name AS reviewer_first_name, rv.last_name AS reviewer_last_name, rv.office_id AS reviewer_office_id,
  rq.name AS requested_by, sb.name AS submitted_by, dc.name AS decided_by, cx.name AS cancelled_by`;
const REVIEW_FROM = `
  FROM probation_reviews r
  JOIN employees e  ON e.id  = r.employee_id
  JOIN employees rv ON rv.id = r.reviewer_employee_id
  LEFT JOIN users rq ON rq.id = r.requested_by_user_id
  LEFT JOIN users sb ON sb.id = r.submitted_by_user_id
  LEFT JOIN users dc ON dc.id = r.decided_by_user_id
  LEFT JOIN users cx ON cx.id = r.cancelled_by_user_id`;
const shape = (r) => ({
  id: r.id, employee_id: r.employee_id, employee: fullName(r), office_id: r.office_id, department: r.department,
  cycle_no: r.cycle_no, period_start: r.period_start, original_end_date: r.original_end_date, status: r.status,
  requested_at: r.requested_at, requested_by: r.requested_by,
  reviewer_employee_id: r.reviewer_employee_id, reviewer: fullName(r, 'reviewer_'), reviewer_office_id: r.reviewer_office_id,
  reviewer_due_date: r.reviewer_due_date, reviewer_notified_at: r.reviewer_notified_at, is_overdue: r.is_overdue,
  rating: r.rating, comments: r.comments, recommendation: r.recommendation,
  submitted_at: r.submitted_at, submitted_by: r.submitted_by,
  decision: r.decision, decision_notes: r.decision_notes, decided_at: r.decided_at, decided_by: r.decided_by,
  extension_months: r.extension_months, new_end_date: r.new_end_date,
  cancelled_at: r.cancelled_at, cancelled_by: r.cancelled_by, cancel_reason: r.cancel_reason,
});

/**
 * HR worklist: this company's reviews (optionally by status), and the
 * probationers with a saved end date and no open review — each with the
 * reviewer a request would go to, or the reason none can be resolved.
 */
export async function worklist(companyId, query = {}) {
  const status = query.status ? String(query.status) : null;
  if (status && !['requested', 'submitted', 'decided', 'cancelled'].includes(status)) {
    throw new ProbationError(400, 'status must be one of requested, submitted, decided, cancelled.');
  }
  const { rows } = await pool.query(
    `SELECT ${REVIEW_SELECT} ${REVIEW_FROM}
      WHERE r.company_id = $1 AND ($2::text IS NULL OR r.status = $2)
      ORDER BY CASE r.status WHEN 'submitted' THEN 0 WHEN 'requested' THEN 1 ELSE 2 END,
               CASE WHEN r.status IN ('requested', 'submitted') THEN r.reviewer_due_date END,
               r.decided_at DESC NULLS LAST, r.id DESC`,
    [companyId, status],
  );
  const { rows: candidates } = await pool.query(
    `SELECT e.id, e.office_id, e.first_name, e.last_name, e.department,
            e.probation_end_date::text AS probation_end_date,
            (e.probation_end_date - CURRENT_DATE) AS days_remaining
       FROM employees e
      WHERE e.company_id = $1 AND e.deleted_at IS NULL
        AND ${statusExpr('e.status')} = 'probation'
        AND e.probation_end_date IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM probation_reviews r
                         WHERE r.employee_id = e.id AND r.status IN ('requested', 'submitted'))
      ORDER BY e.probation_end_date, e.id`,
    [companyId],
  );
  // Stale-reviewer flags for OPEN reviews only — a submitted, decided or
  // cancelled review is history and is never flagged.
  const reviews = [];
  for (const row of rows) {
    reviews.push({ ...shape(row), ...(await reviewerStateFor(companyId, row)) });
  }
  const awaiting = [];
  for (const c of candidates) {
    let reviewer = null; let blocked = null;
    try {
      const h = await resolveReviewer(pool, companyId, c);
      reviewer = { employee_id: h.employee_id, name: fullName(h), department: h.department };
    } catch (err) {
      if (!(err instanceof ProbationError)) throw err;
      blocked = err.message;
    }
    awaiting.push({
      employee_id: c.id, employee: fullName(c), office_id: c.office_id, department: c.department,
      probation_end_date: c.probation_end_date, days_remaining: c.days_remaining, reviewer, blocked,
    });
  }
  return { reviews, awaiting_request: awaiting };
}

/**
 * Is an OPEN review's assigned reviewer still the eligible head?
 *
 * Re-resolves with the SAME resolveReviewer() that request, submission and
 * reassignment use (read-only, no lock), so the worklist cannot disagree with
 * what the server will enforce:
 *
 *   current           the resolved head IS the assigned reviewer
 *   reviewer_replaced an eligible head exists and it is someone else (head
 *                     changed, employee moved department, …) — reassignable
 *   no_eligible_head  no head can be resolved (none assigned, head left or has
 *                     no login, self-review, inactive department) — HR must
 *                     fix the department head first; the reason says why
 *
 * It is a snapshot: the reassignment endpoint re-checks under its locks.
 */
async function reviewerStateFor(companyId, row) {
  if (row.status !== 'requested') {
    return { reviewer_state: null, reviewer_state_reason: null, current_head: null, reassignable: false };
  }
  const emp = { id: row.employee_id, first_name: row.first_name, last_name: row.last_name, department: row.department };
  try {
    const head = await resolveReviewer(pool, companyId, emp);
    if (head.employee_id === row.reviewer_employee_id) {
      return { reviewer_state: 'current', reviewer_state_reason: null, current_head: null, reassignable: false };
    }
    return {
      reviewer_state: 'reviewer_replaced',
      reviewer_state_reason: `${fullName(row, 'reviewer_') || 'The assigned reviewer'} is no longer the head of ${head.department}; the current head is ${fullName(head)}.`,
      current_head: { employee_id: head.employee_id, name: fullName(head), department: head.department },
      reassignable: true,
    };
  } catch (err) {
    if (!(err instanceof ProbationError)) throw err;
    return { reviewer_state: 'no_eligible_head', reviewer_state_reason: err.message, current_head: null, reassignable: false };
  }
}

/** Every review cycle for one employee of this company, with its audit events. */
export async function employeeReviews(companyId, employeeId) {
  const id = positiveInt(employeeId);
  if (!id) throw new ProbationError(400, 'Invalid employee id.');
  const { rows: [emp] } = await pool.query(
    `SELECT id, office_id, first_name, last_name, department, status,
            joining_date::text AS joining_date, probation_end_date::text AS probation_end_date
       FROM employees WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (!emp) throw new ProbationError(404, 'Employee not found.');
  const { rows } = await pool.query(
    `SELECT ${REVIEW_SELECT} ${REVIEW_FROM}
      WHERE r.company_id = $1 AND r.employee_id = $2
      ORDER BY r.cycle_no DESC, r.id DESC`, [companyId, id]);
  const ids = rows.map((r) => String(r.id));
  const { rows: events } = ids.length ? await pool.query(
    `SELECT a.reference_id AS review_id, a.action_type AS action, a.created_at, u.name AS by
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.reference_type = 'probation_review' AND a.reference_id = ANY($1::text[])
        AND (a.company_id IS NULL OR a.company_id = $2)
      ORDER BY a.created_at, a.id`, [ids, companyId]) : { rows: [] };
  return {
    employee: {
      id: emp.id, name: fullName(emp), office_id: emp.office_id, department: emp.department, status: emp.status,
      joining_date: emp.joining_date, probation_end_date: emp.probation_end_date,
    },
    reviews: rows.map(shape),
    events: events.map((e) => ({ review_id: Number(e.review_id), action: e.action, at: e.created_at, by: e.by })),
  };
}

/* ── HR: request ───────────────────────────────────────────────────────── */

/**
 * Request a review. Repeating the request while one is open returns that
 * review unchanged (created: false) — no second row, no second notification.
 */
export async function requestReview(companyId, body = {}, actorUserId, req = null) {
  const employeeId = positiveInt(body.employee_id);
  if (!employeeId) throw new ProbationError(400, 'employee_id is required.');

  const client = await pool.connect();
  let sent = [];
  let review;
  try {
    await client.query('BEGIN');
    const { rows: [emp] } = await client.query(
      `SELECT id, company_id, office_id, first_name, last_name, department, status,
              joining_date::text AS joining_date, probation_end_date::text AS probation_end_date,
              (deleted_at IS NULL AND ${isCurrentSql('status')}) AS is_current
         FROM employees WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
      [employeeId, companyId],
    );
    if (!emp) throw new ProbationError(404, 'Employee not found.');

    const { rows: [open] } = await client.query(
      `SELECT id FROM probation_reviews WHERE employee_id = $1 AND status IN ('requested', 'submitted')`, [emp.id]);
    if (open) {
      await client.query('ROLLBACK');
      return { created: false, review: await reviewById(companyId, open.id) };
    }

    if (!emp.is_current) throw new ProbationError(400, `${fullName(emp)} is not a current employee.`);
    if (String(emp.status ?? '').trim().toLowerCase() !== 'probation') {
      throw new ProbationError(400, `${fullName(emp)} is not on probation (status: ${emp.status ?? 'none'}).`);
    }
    if (!emp.probation_end_date) {
      throw new ProbationError(400, `${fullName(emp)} has no saved probation end date. Set it on the employee record first.`);
    }

    const reviewer = await resolveReviewer(client, companyId, emp);

    const today = await todayIso(client);
    let due;
    if (body.due_date != null && String(body.due_date).trim() !== '') {
      due = toIsoDate(body.due_date);
      if (!due) throw new ProbationError(400, `"${body.due_date}" is not a valid due date. Expected YYYY-MM-DD.`);
      if (due < today) throw new ProbationError(400, 'The reviewer due date cannot be in the past.');
    } else {
      due = emp.probation_end_date >= today ? emp.probation_end_date : addDaysIso(today, DEFAULT_LEAD_DAYS);
    }

    // Cycle numbering and the period it covers. A later cycle (after an
    // extension, once decisions exist) starts the day after the previous
    // cycle's end; the first starts at joining.
    // A CANCELLED review keeps its cycle number (unique) but covered no period,
    // so the period starts after the last review that was not cancelled.
    const { rows: [last] } = await client.query(
      `SELECT cycle_no FROM probation_reviews WHERE employee_id = $1 ORDER BY cycle_no DESC LIMIT 1`, [emp.id]);
    const { rows: [prev] } = await client.query(
      `SELECT cycle_no, original_end_date::text AS original_end_date
         FROM probation_reviews WHERE employee_id = $1 AND status <> 'cancelled'
        ORDER BY cycle_no DESC LIMIT 1`, [emp.id]);
    const cycleNo = (last?.cycle_no ?? 0) + 1;
    const periodStart = prev ? addDaysIso(prev.original_end_date, 1) : (emp.joining_date ?? emp.probation_end_date);
    if (periodStart > emp.probation_end_date) {
      throw new ProbationError(409, `The saved probation end date ${emp.probation_end_date} is not after the previous review period. Correct the end date first.`);
    }

    const { rows: [row] } = await client.query(
      `INSERT INTO probation_reviews
         (company_id, employee_id, cycle_no, period_start, original_end_date,
          requested_by_user_id, department_id, department_head_id, reviewer_employee_id, reviewer_due_date)
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10::date)
       RETURNING id`,
      [companyId, emp.id, cycleNo, periodStart, emp.probation_end_date, actorUserId,
        reviewer.department_id, reviewer.department_head_id, reviewer.employee_id, due],
    );

    const { rows: logins } = await client.query(
      `SELECT id FROM users WHERE employee_id = $1 AND is_active = true ORDER BY id`, [reviewer.employee_id]);
    sent = await insertNotifications(client, logins.map((u) => u.id), {
      title: `Probation review requested — ${fullName(emp)}`,
      message: `HR has asked you to review ${fullName(emp)} (${emp.office_id || 'no ID'}), whose probation ends on `
        + `${emp.probation_end_date}. Please submit your rating, comments and recommendation by ${due}.`,
      module_name: 'probation',
      reference_id: row.id,
      notification_type: 'probation_review_request',
      company_id: companyId,
    });
    await client.query(
      `UPDATE probation_reviews SET reviewer_notified_at = NOW(), updated_at = NOW() WHERE id = $1`, [row.id]);
    await client.query('COMMIT');
    review = row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      // A concurrent request opened it first: answer with that one.
      const { rows: [open] } = await pool.query(
        `SELECT id FROM probation_reviews WHERE employee_id = $1 AND company_id = $2
            AND status IN ('requested', 'submitted')`, [employeeId, companyId]);
      if (open) return { created: false, review: await reviewById(companyId, open.id) };
    }
    throw err;
  } finally {
    client.release();
  }

  await dispatchAfterCommit(sent);
  logAudit({
    userId: actorUserId, module: 'hr', recordId: review.id, recordType: 'probation_review',
    action: 'request_review', newData: { employee_id: employeeId, review_id: review.id }, req, company_id: companyId,
  });
  return { created: true, notified: sent.length, review: await reviewById(companyId, review.id) };
}

async function reviewById(companyId, id) {
  const { rows: [r] } = await pool.query(
    `SELECT ${REVIEW_SELECT} ${REVIEW_FROM} WHERE r.id = $1 AND r.company_id = $2`, [id, companyId]);
  return r ? shape(r) : null;
}

/* ── Department head: my reviews and submission ────────────────────────── */

/**
 * The employee record this login is linked to RIGHT NOW, or null.
 *
 * Read from users.employee_id, not from the token. shared/scope employeeOf()
 * prefers the employee_id claim minted into the JWT at login, so a login HR
 * has since unlinked (or deactivated) would still pass as that employee until
 * its token expired. A reviewer acts on someone's probation, so the live link
 * is what counts.
 */
async function linkedEmployee(req) {
  const userId = req?.user?.userId ?? req?.user?.id ?? null;
  if (!userId) return null;
  const { rows: [u] } = await pool.query(
    `SELECT employee_id FROM users WHERE id = $1 AND is_active = true`, [userId]);
  return u?.employee_id ?? null;
}

/** The caller's employee id, or a 403 — the only identity a reviewer has. */
async function callerEmployee(req) {
  const id = await linkedEmployee(req);
  if (!id) throw new ProbationError(403, 'Your login is not linked to an employee record, so it cannot review probations.');
  return id;
}

/**
 * "Is this login CURRENTLY a department head here?" — for the navigation.
 *
 * Answers from the assignment itself: login → linked employee (current, this
 * company) → an ACTIVE department_heads row in this company. Never from a role,
 * and never an error: no company, no linked employee or no active assignment
 * all read as is_head: false, so the menu entry fails closed. The page and the
 * /mine endpoints make their own decision regardless.
 */
export async function mySummary(companyId, req) {
  if (companyId == null) return { linked: false, is_head: false, departments: [], needs_action: 0 };
  const me = await linkedEmployee(req);
  if (!me) return { linked: false, is_head: false, departments: [], needs_action: 0 };
  const { rows: [r] } = await pool.query(
    `SELECT
        COALESCE(ARRAY(
          SELECT md.name FROM department_heads dh
            JOIN master_departments md ON md.id = dh.department_id AND md.is_active = true
           WHERE dh.company_id = $1 AND dh.head_employee_id = $2 AND dh.ended_at IS NULL
           ORDER BY md.name), '{}') AS departments,
        (SELECT COUNT(*)::int FROM probation_reviews
          WHERE company_id = $1 AND reviewer_employee_id = $2 AND status = 'requested') AS needs_action,
        EXISTS (SELECT 1 FROM employees
                 WHERE id = $2 AND company_id = $1 AND deleted_at IS NULL AND ${isCurrentSql('status')}) AS is_current`,
    [companyId, me],
  );
  const isHead = r.is_current && r.departments.length > 0;
  return {
    linked: true,
    is_head: isHead,
    departments: isHead ? r.departments : [],
    needs_action: isHead ? r.needs_action : 0,
  };
}

/** Reviews assigned to the caller in their company: open first, then recently submitted. */
export async function myReviews(companyId, req) {
  const me = await callerEmployee(req);
  const { rows } = await pool.query(
    `SELECT ${REVIEW_SELECT} ${REVIEW_FROM}
      WHERE r.company_id = $1 AND r.reviewer_employee_id = $2
        AND r.status IN ('requested', 'submitted')
      ORDER BY (r.status = 'requested') DESC, r.reviewer_due_date, r.id`,
    [companyId, me],
  );
  return { reviews: rows.map(shape), recommendations: RECOMMENDATIONS };
}

/**
 * Submit the review assigned to the caller — once, and only while the caller
 * is STILL the eligible reviewer. In one transaction:
 *
 *   1. the review row is locked (FOR UPDATE), so a concurrent HR reassignment
 *      of this review is serialised with it;
 *   2. it must be in the caller's company (the company comes from the login's
 *      scope, never the body), assigned to the caller's linked employee record
 *      (never a reviewer id from the body), and still 'requested';
 *   3. the caller must still be a current employee of the company;
 *   4. the head of the employee's department is RE-RESOLVED now, with a share
 *      lock on the active mapping row, and must be the caller. A head whose
 *      assignment ended — even a moment ago, even in a concurrent transaction
 *      that has committed — is refused, and HR is told to reassign.
 */
export async function submitReview(companyId, reviewId, body = {}, req) {
  const id = positiveInt(reviewId);
  if (!id) throw new ProbationError(400, 'Invalid review id.');
  const me = await callerEmployee(req);

  const rating = positiveInt(body.rating);
  if (!rating || rating > 5) throw new ProbationError(400, 'rating must be a whole number from 1 to 5.');
  const comments = String(body.comments ?? '').trim();
  if (!comments) throw new ProbationError(400, 'comments are required.');
  if (comments.length > COMMENTS_MAX) throw new ProbationError(400, `comments must be at most ${COMMENTS_MAX} characters.`);
  const recommendation = String(body.recommendation ?? '').trim();
  if (!RECOMMENDATIONS.includes(recommendation)) {
    throw new ProbationError(400, `recommendation must be one of: ${RECOMMENDATIONS.join(', ')}.`);
  }
  const actorUserId = req?.user?.userId ?? req?.user?.id ?? null;

  const client = await pool.connect();
  let doneId;
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query(
      `SELECT id, employee_id, reviewer_employee_id, status
         FROM probation_reviews WHERE id = $1 AND company_id = $2
         FOR UPDATE`, [id, companyId]);
    if (!r) throw new ProbationError(404, 'Review not found.');
    if (r.reviewer_employee_id !== me) throw new ProbationError(403, 'This review is not assigned to you.');
    if (r.status !== 'requested') throw new ProbationError(409, `This review has already been ${r.status}.`);

    const { rows: [self] } = await client.query(
      `SELECT (deleted_at IS NULL AND ${isCurrentSql('status')}) AS is_current
         FROM employees WHERE id = $1 AND company_id = $2`, [me, companyId]);
    if (!self?.is_current) throw new ProbationError(403, 'Only a current employee can submit a probation review.');

    const { rows: [emp] } = await client.query(
      `SELECT id, first_name, last_name, department FROM employees WHERE id = $1 AND company_id = $2`,
      [r.employee_id, companyId]);
    if (!emp) throw new ProbationError(404, 'Review not found.');
    let head;
    try {
      head = await resolveReviewer(client, companyId, emp, { lock: true });
    } catch (err) {
      if (!(err instanceof ProbationError)) throw err;
      throw new ProbationError(403,
        `You are no longer the eligible reviewer for ${fullName(emp)} (${err.message}) HR needs to reassign this review.`);
    }
    if (head.employee_id !== me) {
      throw new ProbationError(403,
        `You are no longer the head of ${head.department}, so you cannot submit this review. HR needs to reassign it to ${fullName(head)}.`);
    }

    const { rows: [done] } = await client.query(
      `UPDATE probation_reviews
          SET rating = $3, comments = $4, recommendation = $5,
              submitted_by_user_id = $6, submitted_at = NOW(), status = 'submitted', updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND status = 'requested'
        RETURNING id`,
      [id, companyId, rating, comments, recommendation, actorUserId]);
    if (!done) throw new ProbationError(409, 'This review has already been submitted.');
    await client.query('COMMIT');
    doneId = done.id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  logAudit({
    userId: actorUserId, module: 'hr', recordId: doneId, recordType: 'probation_review',
    action: 'submit_review', newData: { review_id: doneId, rating, recommendation }, req, company_id: companyId,
  });
  return { submitted: true, review: await reviewById(companyId, doneId) };
}

/**
 * HR: move an UNSUBMITTED review to the employee's CURRENT department head.
 *
 * The new reviewer is resolved exactly as at request time (department →
 * active mapping → current head with a login, not the employee) — HR does not
 * choose a person here, and nothing in the body can. A reason is required.
 * In one transaction: lock the review, update the reviewer columns in place
 * (the review is never cancelled, deleted or recreated), write an audit row
 * holding the previous and new reviewer, the acting user, the time and the
 * reason, and notify the new reviewer once. Notifications go out after commit.
 *
 * Refused, leaving the review exactly as it was, when the review is not
 * 'requested' (submitted reviews stay with their author), when no eligible
 * head can be resolved, or when the current head is already the reviewer
 * (200 with changed: false — no duplicate notification).
 */
export async function reassignReview(companyId, reviewId, body = {}, actorUserId, req = null) {
  const id = positiveInt(reviewId);
  if (!id) throw new ProbationError(400, 'Invalid review id.');
  const reason = String(body.reason ?? '').trim();
  if (!reason) throw new ProbationError(400, 'A reason is required to reassign a review.');
  if (reason.length > 500) throw new ProbationError(400, 'reason must be at most 500 characters.');

  const client = await pool.connect();
  let sent = [];
  let previous;
  let head;
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query(
      `SELECT id, employee_id, reviewer_employee_id, department_id, department_head_id, status
         FROM probation_reviews WHERE id = $1 AND company_id = $2
         FOR UPDATE`, [id, companyId]);
    if (!r) throw new ProbationError(404, 'Review not found.');
    if (r.status !== 'requested') {
      throw new ProbationError(409, `Only a review awaiting submission can be reassigned; this one is ${r.status}.`);
    }

    const { rows: [emp] } = await client.query(
      `SELECT id, office_id, first_name, last_name, department,
              probation_end_date::text AS probation_end_date
         FROM employees WHERE id = $1 AND company_id = $2`, [r.employee_id, companyId]);
    if (!emp) throw new ProbationError(404, 'Review not found.');
    head = await resolveReviewer(client, companyId, emp, { lock: true });   // 409 with the reason if none

    if (head.employee_id === r.reviewer_employee_id) {
      await client.query('ROLLBACK');
      return { changed: false, review: await reviewById(companyId, id) };
    }
    previous = r;

    const { rows: [due] } = await client.query(
      `UPDATE probation_reviews
          SET reviewer_employee_id = $3, department_id = $4, department_head_id = $5,
              reviewer_notified_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND status = 'requested'
        RETURNING reviewer_due_date::text AS reviewer_due_date`,
      [id, companyId, head.employee_id, head.department_id, head.department_head_id]);

    const { rows: logins } = await client.query(
      `SELECT id FROM users WHERE employee_id = $1 AND is_active = true ORDER BY id`, [head.employee_id]);
    const sentNew = await insertNotifications(client, logins.map((u) => u.id), {
      title: `Probation review requested — ${fullName(emp)}`,
      message: `HR has reassigned to you the probation review of ${fullName(emp)} (${emp.office_id || 'no ID'}), `
        + `whose probation ends on ${emp.probation_end_date}. Please submit your rating, comments and `
        + `recommendation by ${due.reviewer_due_date}.`,
      module_name: 'probation',
      reference_id: id,
      notification_type: 'probation_review_request',
      company_id: companyId,
    });

    // The FORMER reviewer is told, generically: no review reference (the id
    // would only lead to a page saying they can no longer see it) and no
    // employee details — the review is no longer theirs to see. Active logins
    // only; a former reviewer who has left gets nothing, and the reassignment
    // still goes through.
    const { rows: formerLogins } = await client.query(
      `SELECT id FROM users WHERE employee_id = $1 AND is_active = true ORDER BY id`, [r.reviewer_employee_id]);
    const sentPrevious = await insertNotifications(client, formerLogins.map((u) => u.id), {
      title: 'Probation review reassigned',
      message: 'HR has reassigned a probation review that was waiting for you. No action is needed from you.',
      module_name: 'probation',
      reference_id: null,
      notification_type: 'probation_review_reassigned',
      company_id: companyId,
    });
    sent = [...sentNew, ...sentPrevious];

    // Same table and shape logAudit() writes, but inside this transaction, so
    // the reassignment, its notifications and its record commit — or roll
    // back — together. Written last so it can record who was notified.
    await client.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type,
                               old_data_json, new_data_json, ip_address, user_agent, company_id)
       VALUES ($1, 'hr', 'reassign_reviewer', $2, 'probation_review', $3, $4, $5, $6, $7)`,
      [actorUserId, String(id),
        JSON.stringify({ reviewer_employee_id: r.reviewer_employee_id, department_id: r.department_id,
          department_head_id: r.department_head_id }),
        JSON.stringify({ reviewer_employee_id: head.employee_id, department_id: head.department_id,
          department_head_id: head.department_head_id, reason,
          notified_new: sentNew.length, notified_previous: sentPrevious.length }),
        req?.ip ?? null, req?.get?.('user-agent') ?? null, companyId]);
    if (req) req._auditLogged = true;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await dispatchAfterCommit(sent);
  return {
    changed: true,
    previous_reviewer_employee_id: previous.reviewer_employee_id,
    notified: sent.filter((n) => n.notification_type === 'probation_review_request').length,
    notified_previous: sent.filter((n) => n.notification_type === 'probation_review_reassigned').length,
    review: await reviewById(companyId, id),
  };
}

/* ── HR: decision ──────────────────────────────────────────────────────── */

const DECISIONS = ['confirmed', 'extended', 'not_confirmed'];
const NOTES_MAX = 4000;
const CLOSED_EXIT_STATUSES = ['closed', 'paid', 'cancelled', 'rejected'];

/**
 * HR decides a SUBMITTED review. One transaction locks the review and the
 * employee, writes the decision onto the review, applies it to the employee
 * record, and records an audit row with the before and after:
 *
 *   confirmed      status → Active, confirmation_date = effective_date
 *                  (default today; not in the future, not before joining)
 *   extended       probation_end_date → the last day of `extension_months`
 *                  more months, counted from the day after the current end
 *                  (shared/probationDates.js — the one calendar rule). Status
 *                  stays Probation, so the reminder job and the next review
 *                  cycle pick up the new end date.
 *   not_confirmed  an exit request (separation_type 'termination') with the
 *                  given last working date, its clearance row, status → Notice
 *                  — the same as Exit Management's "initiate"; the nightly exit
 *                  job finalises it on the last working day.
 *
 * Notes are required for extended and not_confirmed. Refused, with nothing
 * written, when the review is not 'submitted', the employee is no longer a
 * current probationer, an exit is already open, or the caller is the
 * employee being decided.
 */
export async function decideReview(companyId, reviewId, body = {}, actorUserId, req = null) {
  const id = positiveInt(reviewId);
  if (!id) throw new ProbationError(400, 'Invalid review id.');
  const decision = String(body.decision ?? '').trim();
  if (!DECISIONS.includes(decision)) {
    throw new ProbationError(400, `decision must be one of: ${DECISIONS.join(', ')}.`);
  }
  const notes = String(body.notes ?? '').trim();
  if (notes.length > NOTES_MAX) throw new ProbationError(400, `notes must be at most ${NOTES_MAX} characters.`);
  if (decision !== 'confirmed' && !notes) {
    throw new ProbationError(400, decision === 'extended'
      ? 'A reason is required to extend a probation.'
      : 'A reason is required when a probation is not confirmed.');
  }
  let months = null;
  if (decision === 'extended') {
    months = parseProbationMonths(body.extension_months);
    if (months == null) throw new ProbationError(400, 'extension_months must be a whole number of months from 1 to 24.');
  }

  const me = await linkedEmployee(req);
  const client = await pool.connect();
  let sent = [];
  let result;
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query(
      `SELECT id, employee_id, reviewer_employee_id, status, recommendation,
              original_end_date::text AS original_end_date
         FROM probation_reviews WHERE id = $1 AND company_id = $2
         FOR UPDATE`, [id, companyId]);
    if (!r) throw new ProbationError(404, 'Review not found.');
    if (r.status !== 'submitted') {
      throw new ProbationError(409, r.status === 'requested'
        ? 'The department head has not submitted this review yet.'
        : `This review has already been ${r.status}.`);
    }
    if (me != null && me === r.employee_id) {
      throw new ProbationError(403, 'You cannot decide your own probation.');
    }

    const { rows: [emp] } = await client.query(
      `SELECT id, office_id, first_name, last_name, status,
              joining_date::text AS joining_date, probation_end_date::text AS probation_end_date,
              confirmation_date::text AS confirmation_date,
              (deleted_at IS NULL AND ${isCurrentSql('status')}) AS is_current
         FROM employees WHERE id = $1 AND company_id = $2
         FOR UPDATE`, [r.employee_id, companyId]);
    if (!emp) throw new ProbationError(404, 'Review not found.');
    if (!emp.is_current || String(emp.status ?? '').trim().toLowerCase() !== 'probation') {
      throw new ProbationError(409,
        `${fullName(emp)} is no longer on probation (status: ${emp.status ?? 'none'}), so this decision cannot be applied.`);
    }

    const today = await todayIso(client);
    const before = {
      status: emp.status, probation_end_date: emp.probation_end_date, confirmation_date: emp.confirmation_date,
    };
    let after;
    let newEndDate = null;
    let exitRequestId = null;

    if (decision === 'confirmed') {
      let effective = today;
      if (body.effective_date != null && String(body.effective_date).trim() !== '') {
        effective = toIsoDate(body.effective_date);
        if (!effective) throw new ProbationError(400, `"${body.effective_date}" is not a valid date. Expected YYYY-MM-DD.`);
      }
      if (effective > today) throw new ProbationError(400, 'The confirmation date cannot be in the future.');
      if (emp.joining_date && effective < emp.joining_date) {
        throw new ProbationError(400, `The confirmation date cannot be before the joining date (${emp.joining_date}).`);
      }
      await client.query(
        `UPDATE employees SET status = 'Active', confirmation_date = $3::date, updated_at = NOW()
          WHERE id = $1 AND company_id = $2`, [emp.id, companyId, effective]);
      after = { status: 'Active', confirmation_date: effective };
    } else if (decision === 'extended') {
      const from = emp.probation_end_date ?? r.original_end_date;
      newEndDate = probationEndDate(addDaysIso(from, 1), months);
      await client.query(
        `UPDATE employees SET probation_end_date = $3::date, updated_at = NOW()
          WHERE id = $1 AND company_id = $2`, [emp.id, companyId, newEndDate]);
      after = { probation_end_date: newEndDate };
    } else {
      const lwd = toIsoDate(body.last_working_date);
      if (!lwd) throw new ProbationError(400, 'last_working_date is required (YYYY-MM-DD) when a probation is not confirmed.');
      if (lwd < today) throw new ProbationError(400, 'The last working date cannot be in the past.');
      let noticeDays = null;
      if (body.notice_days != null && String(body.notice_days).trim() !== '') {
        noticeDays = Number(body.notice_days);
        if (!Number.isInteger(noticeDays) || noticeDays < 0 || noticeDays > 365) {
          throw new ProbationError(400, 'notice_days must be a whole number from 0 to 365.');
        }
      }
      const { rows: [openExit] } = await client.query(
        `SELECT id FROM exit_requests
          WHERE employee_id = $1 AND LOWER(COALESCE(status, '')) <> ALL($2::text[])
          LIMIT 1`, [emp.id, CLOSED_EXIT_STATUSES]);
      if (openExit) {
        throw new ProbationError(409,
          `${fullName(emp)} already has an open exit request (#${openExit.id}). Close it in Exit Management first.`);
      }
      const { rows: [er] } = await client.query(
        `INSERT INTO exit_requests (employee_id, separation_type, last_working_date, notice_period, reason, status)
         VALUES ($1, 'termination', $2::date, $3, $4, 'active') RETURNING id`,
        [emp.id, lwd, noticeDays, `Probation not confirmed: ${notes}`]);
      exitRequestId = er.id;
      // A fresh clearance, as every other exit path starts (B7): DO NOTHING here
      // let a rehire's earlier exit's ticks carry into this one.
      await freshClearance(client, emp.id);
      await client.query(
        `UPDATE employees SET status = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
        [emp.id, companyId, NOTICE_STATUS]);
      after = { status: NOTICE_STATUS, exit_request_id: exitRequestId, last_working_date: lwd };
    }

    await client.query(
      `UPDATE probation_reviews
          SET decision = $3, decision_notes = $4, decided_by_user_id = $5, decided_at = NOW(),
              extension_months = $6, new_end_date = $7::date, status = 'decided', updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND status = 'submitted'`,
      [id, companyId, decision, notes || null, actorUserId, months, newEndDate]);

    // The head who reviewed is told the outcome, which closes their loop.
    const { rows: logins } = await client.query(
      `SELECT id FROM users WHERE employee_id = $1 AND is_active = true ORDER BY id`, [r.reviewer_employee_id]);
    const outcome = decision === 'confirmed' ? 'confirmed'
      : decision === 'extended' ? `extended to ${newEndDate}` : 'not confirmed';
    sent = await insertNotifications(client, logins.map((u) => u.id), {
      title: `Probation decided — ${fullName(emp)}`,
      message: `HR has recorded the probation decision for ${fullName(emp)} (${emp.office_id || 'no ID'}): ${outcome}.`,
      module_name: 'probation',
      reference_id: null,
      notification_type: 'probation_review_decided',
      company_id: companyId,
    });

    // In-transaction audit (same shape as logAudit), so the decision, the
    // employee change and its record commit or roll back together.
    await client.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type,
                               old_data_json, new_data_json, ip_address, user_agent, company_id)
       VALUES ($1, 'hr', 'decide_review', $2, 'probation_review', $3, $4, $5, $6, $7)`,
      [actorUserId, String(id),
        JSON.stringify({ employee_id: emp.id, ...before, recommendation: r.recommendation }),
        JSON.stringify({ employee_id: emp.id, decision, notes: notes || null, extension_months: months, ...after }),
        req?.ip ?? null, req?.get?.('user-agent') ?? null, companyId]);
    if (req) req._auditLogged = true;
    await client.query('COMMIT');
    result = { decision, employee_id: emp.id, new_end_date: newEndDate, exit_request_id: exitRequestId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await dispatchAfterCommit(sent);
  return { decided: true, ...result, review: await reviewById(companyId, id) };
}

/* ── HR: cancel ────────────────────────────────────────────────────────── */

/**
 * Withdraw an OPEN review (requested or submitted), with a reason — e.g. the
 * employee resigned, moved department, or was confirmed some other way.
 * Nothing on the employee changes. One transaction: lock the review, mark it
 * cancelled with who/when/why, tell the reviewer generically if it was still
 * waiting on them, and write the audit row. A cancelled review frees the
 * employee for a new request (the one-open-review index covers only
 * requested/submitted).
 */
export async function cancelReview(companyId, reviewId, body = {}, actorUserId, req = null) {
  const id = positiveInt(reviewId);
  if (!id) throw new ProbationError(400, 'Invalid review id.');
  const reason = String(body.reason ?? '').trim();
  if (!reason) throw new ProbationError(400, 'A reason is required to cancel a review.');
  if (reason.length > 500) throw new ProbationError(400, 'reason must be at most 500 characters.');

  const client = await pool.connect();
  let sent = [];
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query(
      `SELECT id, employee_id, reviewer_employee_id, status
         FROM probation_reviews WHERE id = $1 AND company_id = $2
         FOR UPDATE`, [id, companyId]);
    if (!r) throw new ProbationError(404, 'Review not found.');
    if (r.status !== 'requested' && r.status !== 'submitted') {
      throw new ProbationError(409, `Only an open review can be cancelled; this one is ${r.status}.`);
    }
    await client.query(
      `UPDATE probation_reviews
          SET status = 'cancelled', cancelled_by_user_id = $3, cancelled_at = NOW(), cancel_reason = $4,
              updated_at = NOW()
        WHERE id = $1 AND company_id = $2`, [id, companyId, actorUserId, reason]);

    if (r.status === 'requested') {
      const { rows: logins } = await client.query(
        `SELECT id FROM users WHERE employee_id = $1 AND is_active = true ORDER BY id`, [r.reviewer_employee_id]);
      sent = await insertNotifications(client, logins.map((u) => u.id), {
        title: 'Probation review withdrawn',
        message: 'HR has withdrawn a probation review that was waiting for you. No action is needed from you.',
        module_name: 'probation',
        reference_id: null,
        notification_type: 'probation_review_cancelled',
        company_id: companyId,
      });
    }

    await client.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type,
                               old_data_json, new_data_json, ip_address, user_agent, company_id)
       VALUES ($1, 'hr', 'cancel_review', $2, 'probation_review', $3, $4, $5, $6, $7)`,
      [actorUserId, String(id),
        JSON.stringify({ status: r.status, employee_id: r.employee_id }),
        JSON.stringify({ status: 'cancelled', reason, notified_reviewer: sent.length }),
        req?.ip ?? null, req?.get?.('user-agent') ?? null, companyId]);
    if (req) req._auditLogged = true;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await dispatchAfterCommit(sent);
  return { cancelled: true, review: await reviewById(companyId, id) };
}

/* ── HR: confirmation / extension letter ──────────────────────────────── */

/**
 * The content of the letter for a DECIDED review: a Confirmation Letter for
 * 'confirmed', a Probation Extension Letter for 'extended'. 'not_confirmed'
 * has no letter here — separation letters belong to Exit Management.
 *
 * Read from the records as they are now: the employee's confirmation date
 * (written by the decision) and the review's extension. The wording is the
 * default below; utils/probationLetterPdf.js lays it out.
 */
export async function letterContent(companyId, reviewId) {
  const id = positiveInt(reviewId);
  if (!id) throw new ProbationError(400, 'Invalid review id.');
  const { rows: [r] } = await pool.query(
    `SELECT r.id, r.status, r.decision, r.extension_months, r.cycle_no,
            r.original_end_date::text AS previous_end_date, r.new_end_date::text AS new_end_date,
            r.decided_at, dc.name AS decided_by,
            e.office_id, e.first_name, e.last_name, e.designation, e.department,
            e.joining_date::text AS joining_date, e.confirmation_date::text AS confirmation_date,
            c.name AS company_name, c.address, c.city, c.state, c.pincode
       FROM probation_reviews r
       JOIN employees e ON e.id = r.employee_id
       JOIN companies c ON c.id = r.company_id
       LEFT JOIN users dc ON dc.id = r.decided_by_user_id
      WHERE r.id = $1 AND r.company_id = $2`, [id, companyId]);
  if (!r) throw new ProbationError(404, 'Review not found.');
  if (r.status !== 'decided') throw new ProbationError(409, 'A letter is available once HR has recorded the decision.');
  if (r.decision !== 'confirmed' && r.decision !== 'extended') {
    throw new ProbationError(409, 'There is no probation letter for this decision; separation letters are issued from Exit Management.');
  }
  const fmt = (iso) => {
    if (!iso) return '-';
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
  };
  const name = fullName(r);
  const decidedIso = new Date(r.decided_at).toISOString().slice(0, 10);
  const role = [r.designation, r.department ? `in ${r.department}` : null].filter(Boolean).join(' ');
  const common = {
    companyName: r.company_name,
    companyAddress: [r.address, [r.city, r.state, r.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n'),
    reference: `PROB/${r.office_id || r.id}/${r.cycle_no}`,
    letterDate: fmt(decidedIso),
    recipient: [name, r.office_id ? `Employee ID: ${r.office_id}` : null, r.designation, r.department].filter(Boolean),
    signatoryName: r.decided_by || '',
    signatoryTitle: 'Human Resources',
  };
  if (r.decision === 'confirmed') {
    return {
      ...common,
      kind: 'confirmation',
      filename: `Confirmation_Letter_${(r.office_id || name).replace(/[^A-Za-z0-9_-]+/g, '_')}.pdf`,
      subject: 'Confirmation of Employment',
      body: [
        `Dear ${name},`,
        `Further to your appointment${role ? ` as ${role}` : ''} with effect from ${fmt(r.joining_date)}, we are pleased to inform you that you have successfully completed your probation period.`,
        `Your employment with ${r.company_name} is confirmed with effect from ${fmt(r.confirmation_date || decidedIso)}.`,
        'All other terms and conditions of your appointment remain unchanged.',
        'We appreciate your contribution and wish you continued success with us.',
      ].join('\n\n'),
    };
  }
  const months = r.extension_months;
  return {
    ...common,
    kind: 'extension',
    filename: `Probation_Extension_Letter_${(r.office_id || name).replace(/[^A-Za-z0-9_-]+/g, '_')}.pdf`,
    subject: 'Extension of Probation Period',
    body: [
      `Dear ${name},`,
      `Your probation period${role ? ` as ${role}` : ''}, which was due to end on ${fmt(r.previous_end_date)}, has been reviewed.`,
      `Your probation is extended by ${months} ${months === 1 ? 'month' : 'months'} and will now end on ${fmt(r.new_end_date)}. Your performance will be reviewed again before that date.`,
      'All other terms and conditions of your appointment remain unchanged.',
    ].join('\n\n'),
  };
}
