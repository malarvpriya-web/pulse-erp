/**
 * announcement.visibility.js — the ONE definition of "who sees an announcement".
 *
 * Every employee-facing read goes through here: GET /announcements/active, the
 * Home summary and Home's events card, POST /:id/read (which may only mark what
 * the caller can see), the admin list's read/audience counts, and the publisher's
 * notification recipients. They used to be four separate queries that disagreed:
 * /active had no login and no company filter, Home ignored publish_at and
 * from_date, none of them looked at target_type, and the audience count counted
 * every company's employees while reads were counted per login.
 *
 * Population: a LOGIN (users row, is_active) linked to an EMPLOYEE (users.employee_id)
 * whose employees.company_id is the announcement's company and who is still
 * employed (shared/employeeStatus — anyone not exited, so Notice and Probation
 * count, Left does not). The employee's company is used, not users.company_id:
 * 24 of 36 linked logins have users.company_id NULL. Reads can only come from
 * logins, so counting employees without one would make 100% unreachable.
 *
 * Audience: target_type 'all' (or blank), 'department' (case/space-insensitive
 * match on employees.department) or 'employee' (target_value = employees.id).
 * Anything else matches nobody — an unknown audience fails closed.
 *
 * Live: not archived, is_active, from_date <= today <= to_date, and publish_at
 * (if set) has passed. Dates are compared in the database session time zone
 * (Asia/Calcutta), as they always were.
 */
import pool from '../config/db.js';
import { isCurrentSql } from '../shared/employeeStatus.js';

/** SQL: the announcement `a` is live right now. */
export const liveSql = (a = 'a') => `(
      ${a}.deleted_at IS NULL
  AND ${a}.is_active = true
  AND ${a}.from_date::date <= CURRENT_DATE
  AND ${a}.to_date::date   >= CURRENT_DATE
  AND (${a}.publish_at IS NULL OR ${a}.publish_at <= NOW())
)`;

/** SQL: employee `e` is in the audience of announcement `a`. `e` may be NULL (unlinked login). */
export const audienceSql = (a = 'a', e = 'e') => `(
     COALESCE(NULLIF(BTRIM(${a}.target_type), ''), 'all') = 'all'
  OR (${a}.target_type = 'department' AND ${e}.id IS NOT NULL
      AND LOWER(BTRIM(${e}.department)) = LOWER(BTRIM(${a}.target_value)))
  OR (${a}.target_type = 'employee' AND ${e}.id IS NOT NULL
      AND BTRIM(${a}.target_value) = ${e}.id::text)
)`;

/**
 * SQL: the eligible-recipient population of announcement `a`, as rows of
 * (u.id, e.id). Used for notification recipients and for the read/audience counts,
 * so the two can never be measured over different people.
 */
export const populationFromSql = (a = 'a') => `
  FROM users u
  JOIN employees e ON e.id = u.employee_id
 WHERE u.is_active = true
   AND e.company_id = ${a}.company_id
   AND ${isCurrentSql('e.status')}
   AND ${audienceSql(a, 'e')}`;

/** SQL columns: total_audience and read_count over the same population. */
export const countsSql = (a = 'a') => `
  (SELECT COUNT(DISTINCT u.id) ${populationFromSql(a)})::int AS total_audience,
  (SELECT COUNT(DISTINCT u.id) ${populationFromSql(a)}
      AND EXISTS (SELECT 1 FROM announcement_reads ar
                   WHERE ar.announcement_id = ${a}.id AND ar.user_id = u.id))::int AS read_count`;

/**
 * Who is looking. companyId comes from companyOf(req) / req.scope — never from
 * the query string or the body. employeeId falls back to users.employee_id for
 * tokens minted without the claim, and is dropped if that employee belongs to
 * another company.
 */
export async function resolveViewer({ companyId, userId, employeeId }, db = pool) {
  const cid = companyId == null || companyId === '' ? null : Number(companyId);
  let emp = employeeId ?? null;
  if (emp == null && userId != null) {
    const { rows } = await db.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
    emp = rows[0]?.employee_id ?? null;
  }
  if (emp != null && cid != null) {
    const { rows } = await db.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [emp, cid]);
    if (!rows.length) emp = null;
  }
  return { companyId: Number.isFinite(cid) ? cid : null, userId: userId ?? null, employeeId: emp };
}

/** The viewer from an authenticated request. */
export const viewerFromReq = (req, companyId) => resolveViewer({
  companyId,
  userId: req.user?.userId ?? req.user?.id ?? null,
  employeeId: req.user?.employee_id ?? null,
});

const FEED_COLUMNS = `
  a.id, a.title, a.message, a.from_date, a.to_date, a.priority, a.category,
  a.is_pinned, a.publish_at, a.created_at, a.company_id`;

/**
 * The announcements the viewer may see now, pinned first, newest first.
 * No company → nothing (a company-less login is not "every company").
 */
export async function visibleAnnouncements(viewer, { limit = null, db = pool } = {}) {
  if (viewer?.companyId == null) return [];
  const params = [viewer.companyId, viewer.employeeId ?? null, viewer.userId ?? null];
  let sql = `
    SELECT ${FEED_COLUMNS},
           COALESCE(a.publish_at, a.from_date) AS published_at,
           (ar.id IS NOT NULL) AS is_read,
           ar.read_at
      FROM announcements a
      LEFT JOIN employees e ON e.id = $2::int AND e.company_id = $1::int
      LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = $3::int
     WHERE a.company_id = $1::int
       AND ${liveSql('a')}
       AND ${audienceSql('a', 'e')}
     ORDER BY a.is_pinned DESC, COALESCE(a.publish_at, a.created_at) DESC, a.id DESC`;
  if (limit != null) { params.push(Number(limit)); sql += ` LIMIT $4`; }
  const { rows } = await db.query(sql, params);
  return rows;
}

/** One announcement, only if the viewer may see it now. */
export async function visibleAnnouncement(viewer, id, db = pool) {
  if (viewer?.companyId == null || !/^\d+$/.test(String(id))) return null;
  const { rows } = await db.query(`
    SELECT a.id
      FROM announcements a
      LEFT JOIN employees e ON e.id = $2::int AND e.company_id = $1::int
     WHERE a.id = $3::int
       AND a.company_id = $1::int
       AND ${liveSql('a')}
       AND ${audienceSql('a', 'e')}`,
    [viewer.companyId, viewer.employeeId ?? null, Number(id)]);
  return rows[0] ?? null;
}
