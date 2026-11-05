// backend/src/modules/hr/hr-widgets.routes.js
// HR dashboard widget data: birthdays, anniversaries, expiring docs, pending confirmations
import express from 'express';
import pool from '../../config/db.js';
import { requirePermission, verifyToken } from '../../middlewares/auth.middleware.js';
import { isCurrentSql } from '../../shared/employeeStatus.js';
import { getUpcomingJoinees, DEFAULT_JOINEE_WINDOW_DAYS } from './upcomingJoinees.service.js';

const router = express.Router();

/**
 * These widgets used to test `LOWER(status) IN ('active','probation')`, which
 * is a fourth private copy of the employment vocabulary and the only one that
 * excluded 'Notice'. Someone serving notice still has a passport that expires
 * and a birthday next week; hiding them here made the Expiring Docs card
 * disagree with the headcount on the same page. See shared/employeeStatus.js.
 */
const CURRENT_EMP           = isCurrentSql('e.status');
/** Same predicate for the two queries that read `employees` unaliased. */
const CURRENT_EMP_UNALIASED = isCurrentSql('status');

/**
 * Optional department filter, matching `getEmployeeAnalytics`'s dimension
 * exactly — including its 'Unassigned' bucket for a blank department.
 *
 * ⚠ Without this the dashboard was only HALF filtered: picking a department
 * narrowed headcount, the charts and the data-quality counts, while the HR
 * action tiles beside them kept showing the whole company. One strip, one
 * heading, two different populations.
 */
const deptFilter = (alias, param) =>
  `(${param}::text IS NULL OR COALESCE(NULLIF(TRIM(${alias}department), ''), 'Unassigned') = ${param})`;

/** '' / 'all' / absent all mean "no filter", as everywhere else. */
function departmentOf(req) {
  const raw = req.query?.department;
  if (raw == null) return null;
  const v = String(raw).trim();
  return v === '' || v.toLowerCase() === 'all' ? null : v;
}

router.use(verifyToken);

/* GET /hr-widgets/upcoming-birthdays?days=30 */
// Gated on the owning module 2026-09-04. A live probe with a plain
// `employee` token returned other people's records from this router, and an
// employee has no routine need for this register — their own record reaches
// them through self-service. `employee` is denied hr in role_permissions,
// which is what makes this gate real rather than decorative.
router.get('/upcoming-birthdays', requirePermission('hr', 'view'), async (req, res) => {
  const days = Math.min(parseInt(req.query.days ?? '30', 10), 90);
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT
         id, office_id,
         TRIM(first_name || ' ' || COALESCE(last_name,'')) AS name,
         designation, department, photo_url,
         dob,
         TO_CHAR(dob, 'MM-DD') AS birth_md
       FROM employees
       WHERE dob IS NOT NULL
         AND ${CURRENT_EMP_UNALIASED}
         AND ($1::int IS NULL OR company_id = $1)
         AND ${deptFilter('', '$3')}
         AND (
           -- same-year: birthday MMDD falls between today and today+N days
           (TO_CHAR(CURRENT_DATE,'MMDD') <= TO_CHAR(CURRENT_DATE + $2 * INTERVAL '1 day','MMDD')
            AND TO_CHAR(dob,'MMDD') BETWEEN TO_CHAR(CURRENT_DATE,'MMDD')
                                        AND TO_CHAR(CURRENT_DATE + $2 * INTERVAL '1 day','MMDD'))
           OR
           -- year-wrap: window crosses Dec→Jan boundary
           (TO_CHAR(CURRENT_DATE,'MMDD') > TO_CHAR(CURRENT_DATE + $2 * INTERVAL '1 day','MMDD')
            AND (TO_CHAR(dob,'MMDD') >= TO_CHAR(CURRENT_DATE,'MMDD')
                 OR TO_CHAR(dob,'MMDD') <= TO_CHAR(CURRENT_DATE + $2 * INTERVAL '1 day','MMDD')))
         )
       ORDER BY TO_CHAR(dob,'MM-DD')`,
      [cid, days, departmentOf(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /hr-widgets/upcoming-anniversaries?days=30 */
router.get('/upcoming-anniversaries', requirePermission('hr', 'view'), async (req, res) => {
  const days = Math.min(parseInt(req.query.days ?? '30', 10), 90);
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT
         id, office_id,
         TRIM(first_name || ' ' || COALESCE(last_name,'')) AS name,
         designation, department, photo_url,
         joining_date,
         DATE_PART('year', AGE(CURRENT_DATE, joining_date))::int AS years_completed
       FROM employees
       WHERE joining_date IS NOT NULL
         AND ${CURRENT_EMP_UNALIASED}
         AND ($1::int IS NULL OR company_id = $1)
         AND ${deptFilter('', '$3')}
         AND (
           TO_DATE(TO_CHAR(CURRENT_DATE,'YYYY') || '-' || TO_CHAR(joining_date,'MM-DD'), 'YYYY-MM-DD')
           BETWEEN CURRENT_DATE AND CURRENT_DATE + ($2 || ' days')::INTERVAL
         )
         AND DATE_PART('year', AGE(CURRENT_DATE, joining_date)) >= 1
       ORDER BY TO_CHAR(joining_date,'MM-DD')`,
      [cid, days, departmentOf(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /hr-widgets/pending-confirmations?days=14&include_overdue=1&include_undated=1
 *
 * ⚠ Three ways an employee needing confirmation fell out of this card:
 *   - probation_end_date already past      → overdue confirmation, the most
 *                                            urgent case, silently dropped
 *   - probation_end_date NULL              → HR never set one; the employee is
 *                                            on probation indefinitely with no
 *                                            prompt anywhere. One live row.
 *   - status 'Notice'                      → not relevant here, probation only
 * The first two are now included and flagged, because "nothing to do" and
 * "nobody recorded a date" must not look the same on a dashboard. */
router.get('/pending-confirmations', requirePermission('hr', 'view'), async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days ?? '14', 10) || 14, 0), 365);
  const includeOverdue = String(req.query.include_overdue ?? '1') !== '0';
  const includeUndated = String(req.query.include_undated ?? '1') !== '0';
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT
         id, office_id,
         TRIM(first_name || ' ' || COALESCE(last_name,'')) AS name,
         designation, department, joining_date,
         probation_end_date,
         (probation_end_date - CURRENT_DATE) AS days_remaining,
         CASE
           WHEN probation_end_date IS NULL          THEN 'undated'
           WHEN probation_end_date < CURRENT_DATE   THEN 'overdue'
           ELSE 'due'
         END AS confirmation_state
       FROM employees
       WHERE LOWER(COALESCE(NULLIF(TRIM(status), ''), '')) = 'probation'
         AND deleted_at IS NULL
         AND (
              (probation_end_date IS NOT NULL
               AND probation_end_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL
               AND ($3::bool OR probation_end_date >= CURRENT_DATE))
           OR (probation_end_date IS NULL AND $4::bool)
         )
         AND ($2::int IS NULL OR company_id = $2)
         AND ${deptFilter('', '$5')}
       ORDER BY probation_end_date ASC NULLS LAST`,
      [days, cid, includeOverdue, includeUndated, departmentOf(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /hr-widgets/expiring-documents?days=30&include_expired=1
 *
 * ⚠ The lower bound used to be CURRENT_DATE, so a document that had ALREADY
 * expired dropped straight out of the card the day it lapsed. On live data
 * that hid two expired documents and showed one expiring — the card read "1"
 * while three documents actually needed HR's attention, and the two that were
 * already a problem were the two it hid. `include_expired` (default on) keeps
 * them, with a negative `days_remaining` and `expiry_state = 'expired'`. */
router.get('/expiring-documents', requirePermission('hr', 'view'), async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days ?? '30', 10) || 30, 0), 365);
  const includeExpired = String(req.query.include_expired ?? '1') !== '0';
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT
         d.id AS doc_id,
         d.document_type,
         d.document_name,
         d.expiry_date,
         (d.expiry_date - CURRENT_DATE) AS days_remaining,
         CASE WHEN d.expiry_date < CURRENT_DATE THEN 'expired' ELSE 'expiring' END AS expiry_state,
         e.id AS employee_id,
         TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')) AS employee_name,
         e.department,
         e.designation,
         e.status AS employee_status
       FROM employee_documents d
       JOIN employees e ON e.id = d.employee_id
       WHERE d.expiry_date IS NOT NULL
         AND d.expiry_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL
         AND ($3::bool OR d.expiry_date >= CURRENT_DATE)
         AND e.deleted_at IS NULL
         AND ${CURRENT_EMP}
         AND ($2::int IS NULL OR d.company_id = $2)
         AND ${deptFilter('e.', '$4')}
       ORDER BY d.expiry_date ASC`,
      [days, cid, includeExpired, departmentOf(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /hr-widgets/upcoming-exits?days=30&include_overdue=1
 *
 * ⚠ Same shape of bug as expiring-documents, and worse here. The lower bound
 * was CURRENT_DATE, so an exit whose last working day had come and gone while
 * the request was still open vanished from the card. Live data has three open
 * exit_requests with last working dates in May and August against employees
 * still carrying an employment status — precisely the offboarding that has
 * stalled, and precisely what the card was hiding. `include_overdue`
 * (default on) keeps them, with a negative `days_remaining`.
 *
 * DISTINCT ON collapses multiple open requests for one employee to the
 * earliest remaining date, so a re-raised exit cannot list the same person
 * twice and double the card's count. */
router.get('/upcoming-exits', requirePermission('hr', 'view'), async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days ?? '30', 10) || 30, 0), 365);
  const includeOverdue = String(req.query.include_overdue ?? '1') !== '0';
  const cid = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (e.id)
           e.id, e.office_id,
           TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')) AS name,
           e.designation, e.department, e.status AS employee_status,
           er.last_working_date,
           er.separation_type,
           -- Notice began when the exit request was raised; there is no
           -- separate notice_start column, and exit_requests.created_at is
           -- the only record of when the clock started.
           er.created_at::date  AS notice_started_on,
           er.status            AS exit_request_status,
           (er.last_working_date - CURRENT_DATE) AS days_remaining,
           CASE WHEN er.last_working_date < CURRENT_DATE THEN 'overdue' ELSE 'upcoming' END AS exit_state
         FROM employees e
         JOIN exit_requests er ON er.employee_id = e.id
           AND LOWER(COALESCE(er.status,'')) NOT IN ('rejected','cancelled','closed')
         WHERE er.last_working_date IS NOT NULL
           AND er.last_working_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL
           AND ($3::bool OR er.last_working_date >= CURRENT_DATE)
           AND e.deleted_at IS NULL
           AND ($2::int IS NULL OR e.company_id = $2)
           AND ${deptFilter('e.', '$4')}
         ORDER BY e.id, er.last_working_date ASC
       ) x
       ORDER BY x.last_working_date ASC`,
      [days, cid, includeOverdue, departmentOf(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /hr-widgets/upcoming-joinees?days=30
 *
 * People with a CONFIRMED future start date who are not employees yet. They
 * are deliberately NOT part of headcount and never counted as new hires — a
 * hire has started, a joinee has not. See upcomingJoinees.service.js for how
 * "already joined" is decided (it is not just the FK). */
router.get('/upcoming-joinees', requirePermission('hr', 'view'), async (req, res) => {
  const days = parseInt(req.query.days ?? String(DEFAULT_JOINEE_WINDOW_DAYS), 10);
  try {
    const data = await getUpcomingJoinees({
      company_id: req.scope?.company_id ?? null,
      days,
      department: departmentOf(req),
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
