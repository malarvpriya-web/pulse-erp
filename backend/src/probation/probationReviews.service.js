import pool from "../config/db.js";
import { isCurrentSql, statusExpr } from "../shared/employeeStatus.js";
import { toIsoDate } from "../shared/probationDates.js";
import { logAudit } from "../services/AuditService.js";
import { ProbationError, insertNotifications, dispatchAfterCommit } from "./probation.service.js";

/**
 * Probation reviews (20261014000007_probation_reviews) — request and
 * department-head submission. The HR decision stage is NOT here.
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
 * Neither step touches the employee row, probation dates, confirmation,
 * payroll or exit records. Both are written to the audit trail (logAudit,
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
  (r.status = 'requested' AND r.reviewer_due_date < CURRENT_DATE) AS is_overdue,
  e.office_id, e.first_name, e.last_name, e.department,
  rv.first_name AS reviewer_first_name, rv.last_name AS reviewer_last_name, rv.office_id AS reviewer_office_id,
  rq.name AS requested_by, sb.name AS submitted_by`;
const REVIEW_FROM = `
  FROM probation_reviews r
  JOIN employees e  ON e.id  = r.employee_id
  JOIN employees rv ON rv.id = r.reviewer_employee_id
  LEFT JOIN users rq ON rq.id = r.requested_by_user_id
  LEFT JOIN users sb ON sb.id = r.submitted_by_user_id`;
const shape = (r) => ({
  id: r.id, employee_id: r.employee_id, employee: fullName(r), office_id: r.office_id, department: r.department,
  cycle_no: r.cycle_no, period_start: r.period_start, original_end_date: r.original_end_date, status: r.status,
  requested_at: r.requested_at, requested_by: r.requested_by,
  reviewer_employee_id: r.reviewer_employee_id, reviewer: fullName(r, 'reviewer_'), reviewer_office_id: r.reviewer_office_id,
  reviewer_due_date: r.reviewer_due_date, reviewer_notified_at: r.reviewer_notified_at, is_overdue: r.is_overdue,
  rating: r.rating, comments: r.comments, recommendation: r.recommendation,
  submitted_at: r.submitted_at, submitted_by: r.submitted_by,
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
      ORDER BY (r.status = 'requested') DESC, r.reviewer_due_date, r.id`,
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
    const { rows: [prev] } = await client.query(
      `SELECT cycle_no, original_end_date::text AS original_end_date
         FROM probation_reviews WHERE employee_id = $1 ORDER BY cycle_no DESC LIMIT 1`, [emp.id]);
    const cycleNo = (prev?.cycle_no ?? 0) + 1;
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
            JOIN master_departments md ON md.id = dh.department_id
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
