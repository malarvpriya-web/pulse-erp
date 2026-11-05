import pool from "../config/db.js";
import { companyOf } from "../shared/scope.js";
import {
  getProbationPolicy, saveProbationPolicy, parseProbationMonths, parseReminderDays,
  resolveProbationWrite, toIsoDate, MIN_PROBATION_MONTHS, MAX_PROBATION_MONTHS, MAX_REMINDER_DAYS,
} from "../shared/probationDates.js";
import notificationsRepository from "../modules/notifications/repositories/notifications.repository.js";

/**
 * Probation service — company-scoped.
 *
 * Everything here used to run without a tenant:
 *   - GET /probation listed every company's probation log (LIMIT 200);
 *   - a decision could be recorded against any id in the database;
 *   - recipients were found by matching a free-text NAME against users.name
 *     and then against employees' full names across all companies, so
 *     "notify Priya" reached whichever Priya the database returned first;
 *   - "also notify the super admins" meant every super admin of every company.
 *
 * Now the caller's company (companyOf) is required — no company, no access —
 * every probation_notifications row is reached through its employee's
 * company_id (the table has no company column of its own, and the legacy rows
 * are deliberately left as they are), and recipients are resolved by id inside
 * that company.
 *
 * The Approval Center push that createNotification used to attempt is gone:
 * it bound one parameter to both a varchar and an integer column, failed with
 * "inconsistent types deduced for parameter $4" on every call, and the error
 * was swallowed — not one probation approval row was ever created. Whether
 * probation reviews go through the Approval Center is a decision for the
 * review workflow, not something to switch on by fixing a typo here.
 */

export class ProbationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The caller's company, or a 403. A global (company-less) caller has no probation scope. */
export function requireCompany(req) {
  const companyId = companyOf(req);
  if (companyId == null) {
    throw new ProbationError(403, 'Your account is not assigned to a company, so it has no probation records.');
  }
  return companyId;
}

const positiveInt = (v) => {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
};

const NOTIFICATION_TYPES = ['approval', 'probation_warning', 'probation_due'];
const TYPE_TITLE = {
  probation_warning: 'Probation Due Soon',
  probation_due: 'Probation End Date Reached',
  approval: 'Probation Review Required',
};

/** An employee of THIS company, or null. */
async function companyEmployee(db, companyId, employeeId) {
  const { rows } = await db.query(
    `SELECT id, office_id, first_name, last_name, department,
            probation_end_date::text AS probation_end_date
       FROM employees
      WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [employeeId, companyId],
  );
  return rows[0] || null;
}

/**
 * Active logins of this company holding any of `roles`, by role CODE through
 * user_roles. The company is the linked employee's when there is one, the
 * users row's otherwise (pilot accounts carry users.company_id NULL) — the
 * same resolution every other tenant-scoped cron uses. A login with no
 * company at all is never matched, so a platform-wide super admin is not
 * pulled into one tenant's probation traffic.
 */
export async function companyUsersWithRoles(db, companyId, roles) {
  const { rows } = await db.query(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r       ON r.id = ur.role_id
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.is_active = true
        AND r.code = ANY($2::text[])
        AND COALESCE(e.company_id, u.company_id) = $1
      ORDER BY u.id`,
    [companyId, roles],
  );
  return rows.map((r) => r.id);
}

/** The active login linked to an employee of this company, or null. */
export async function userForEmployee(db, companyId, employeeId) {
  if (employeeId == null) return null;
  const { rows } = await db.query(
    `SELECT u.id
       FROM users u
       JOIN employees e ON e.id = u.employee_id
      WHERE u.employee_id = $1 AND u.is_active = true
        AND e.company_id = $2 AND e.deleted_at IS NULL
      ORDER BY u.id
      LIMIT 1`,
    [employeeId, companyId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Insert notification rows on `client` (inside the caller's transaction) and
 * return the payloads, so the caller can dispatch push/email AFTER it commits.
 */
export async function insertNotifications(client, userIds, payload) {
  const sent = [];
  for (const userId of [...new Set(userIds.filter((id) => id != null))]) {
    await client.query(
      `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, payload.title, payload.message, payload.module_name, payload.reference_id, payload.notification_type],
    );
    sent.push({ ...payload, user_id: userId });
  }
  return sent;
}

export async function dispatchAfterCommit(sent) {
  for (const n of sent) {
    // Push/email are best-effort by design (see the repository); the in-app
    // row is already committed and is the notification of record.
    try { await notificationsRepository.dispatchSideEffects(n); }
    catch (err) { console.error('[Probation] notification side effects failed:', err.message); }
  }
}

/* ── policy ─────────────────────────────────────────────────────────────── */

export const getPolicy = (companyId) => getProbationPolicy(pool, companyId);

export function updatePolicy(companyId, body = {}) {
  const patch = {};
  if ('probation_months' in body) {
    const m = parseProbationMonths(body.probation_months);
    if (m == null) {
      throw new ProbationError(400,
        `Probation period must be a whole number of months between ${MIN_PROBATION_MONTHS} and ${MAX_PROBATION_MONTHS}.`);
    }
    patch.probation_months = m;
  }
  if ('reminder_days' in body) {
    const d = parseReminderDays(body.reminder_days);
    if (d == null) {
      throw new ProbationError(400, `Reminder lead time must be a whole number of days between 0 and ${MAX_REMINDER_DAYS}.`);
    }
    patch.reminder_days = d;
  }
  if (!Object.keys(patch).length) {
    throw new ProbationError(400, 'Send probation_months and/or reminder_days.');
  }
  return saveProbationPolicy(pool, companyId, patch);
}

/**
 * What Add/Edit Employee shows before saving: the end date the server WILL
 * store for this joining date and period. Same function the write path uses,
 * so the preview cannot disagree with the saved value.
 */
export async function calculate(companyId, query = {}) {
  const policy = await getPolicy(companyId);
  const joining = toIsoDate(query.joining_date);
  if (!joining) throw new ProbationError(400, 'joining_date must be a date (YYYY-MM-DD).');
  try {
    const r = resolveProbationWrite({
      joiningDate: joining,
      months: query.months,
      defaultMonths: policy.probation_months,
    });
    return {
      joining_date: joining,
      probation_months: r.probation_months,
      probation_end_date: r.probation_end_date,
      policy,
    };
  } catch (e) {
    if (e instanceof RangeError) throw new ProbationError(400, e.message);
    throw e;
  }
}

/* ── probation log ──────────────────────────────────────────────────────── */

export async function getNotifications(companyId) {
  const { rows } = await pool.query(
    `SELECT pn.*,
            e.first_name, e.last_name, e.office_id, e.department,
            e.designation, e.joining_date, e.probation_end_date
       FROM probation_notifications pn
       JOIN employees e ON e.id = pn.employee_id
      WHERE e.company_id = $1
      ORDER BY pn.created_at DESC
      LIMIT 200`,
    [companyId],
  );
  return rows;
}

/**
 * Notify a named colleague about an employee's probation. The recipient is an
 * EMPLOYEE ID of this company (`notified_to_employee_id`), resolved to their
 * login; the company's super admins are copied, as before, but only this
 * company's. The log row and the notification rows commit together.
 */
export async function createNotification(companyId, body = {}) {
  const employeeId = positiveInt(body.employee_id);
  if (!employeeId) throw new ProbationError(400, 'employee_id is required.');
  const recipientId = positiveInt(body.notified_to_employee_id);
  if (!recipientId) {
    throw new ProbationError(400, 'Choose the person to notify from the list (notified_to_employee_id).');
  }
  const type = body.notification_type || 'approval';
  if (!NOTIFICATION_TYPES.includes(type)) {
    throw new ProbationError(400, `notification_type must be one of: ${NOTIFICATION_TYPES.join(', ')}.`);
  }
  const remarks = String(body.remarks ?? '').trim() || null;

  const client = await pool.connect();
  let sent = [];
  let saved;
  try {
    await client.query('BEGIN');
    const emp = await companyEmployee(client, companyId, employeeId);
    if (!emp) throw new ProbationError(404, 'Employee not found.');
    const recipient = await companyEmployee(client, companyId, recipientId);
    if (!recipient) throw new ProbationError(400, 'The person to notify is not an employee of this company.');

    const recipientName = `${recipient.first_name ?? ''} ${recipient.last_name ?? ''}`.trim();
    const { rows: [row] } = await client.query(
      `INSERT INTO probation_notifications
         (employee_id, notified_to, notified_role, notification_type, module_name, remarks)
       VALUES ($1, $2, $3, $4, 'Probation', $5)
       RETURNING *`,
      [employeeId, recipientName || null, body.notified_role || 'Manager', type, remarks],
    );
    saved = row;

    const empName = `${emp.first_name ?? ''} ${emp.last_name ?? ''}`.trim() || 'An employee';
    const payload = {
      title: `${TYPE_TITLE[type]} — ${empName}`,
      message: `${empName}${emp.department ? ` (${emp.department})` : ''} requires a probation review.`
        + `${emp.probation_end_date ? ` Probation ends ${emp.probation_end_date}.` : ''}`
        + `${remarks ? ` Note: ${remarks}` : ''}`,
      module_name: 'probation',
      reference_id: employeeId,
      notification_type: type,
      company_id: companyId,
    };
    const recipientUser = await userForEmployee(client, companyId, recipientId);
    const superAdmins = await companyUsersWithRoles(client, companyId, ['super_admin']);
    sent = await insertNotifications(client, [recipientUser, ...superAdmins], payload);
    await client.query('COMMIT');
    saved = { ...saved, recipient_has_login: recipientUser != null, delivered_to: sent.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await dispatchAfterCommit(sent);
  return saved;
}

/** Record a decision on one log row — only a row whose employee is in this company. */
export async function updateNotification(companyId, id, data = {}) {
  const rowId = positiveInt(id);
  if (!rowId) throw new ProbationError(400, 'Invalid probation record id.');
  const { decision, performance_rating, comments } = data;
  const { rows } = await pool.query(
    `UPDATE probation_notifications pn
        SET decision = $1, performance_rating = $2, comments = $3,
            status = 'completed', decided_at = CURRENT_TIMESTAMP
       FROM employees e
      WHERE pn.id = $4 AND e.id = pn.employee_id AND e.company_id = $5
      RETURNING pn.*`,
    [decision, performance_rating || null, comments || null, rowId, companyId],
  );
  if (!rows[0]) throw new ProbationError(404, 'Probation record not found.');
  return rows[0];
}

export async function updateByEmployee(companyId, employeeId, data = {}) {
  const empId = positiveInt(employeeId);
  if (!empId) throw new ProbationError(400, 'Invalid employee id.');
  const { decision, performance_rating, comments } = data;
  const { rows } = await pool.query(
    `UPDATE probation_notifications
        SET decision = $1, performance_rating = $2, comments = $3,
            status = 'completed', decided_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT pn.id FROM probation_notifications pn
          JOIN employees e ON e.id = pn.employee_id
         WHERE pn.employee_id = $4 AND e.company_id = $5 AND pn.status = 'pending'
         ORDER BY pn.created_at DESC
         LIMIT 1
      )
      RETURNING *`,
    [decision, performance_rating || null, comments || null, empId, companyId],
  );
  return rows[0] || null;
}
