// GET /home/my-employment — the signed-in person's OWN employment status for
// HR > My Dashboard: probation / confirmation, notice period, an exit in
// progress, this month's attendance, and the small "needs your attention"
// counts (leave awaiting approval, documents expiring, assets held), and
// who in the caller's own team is on leave today.
//
// Always the caller's own record: the employee id comes from the token (else
// users.employee_id), never from a query or body field, and the row must sit
// in the caller's company. A login with no linked employee gets
// { linked: false } rather than an error, so the page can say so.
//
// Reviewer-side probation detail (rating, comments, recommendation) is NOT
// returned — the employee sees only that a review is under way and, once HR
// has decided, the decision.
import pool from '../config/db.js';
import { companyOf } from '../shared/scope.js';
import { ownEmployeeId } from '../modules/payroll/payrollAccess.js';

// Exit requests in these states are finished — nothing to show.
const EXIT_DONE = ['closed', 'paid', 'cancelled', 'rejected'];
const CLEARANCE_KEYS = ['noc_it', 'noc_admin', 'noc_finance', 'noc_hr', 'noc_manager',
  'it_assets_returned', 'access_revoked', 'documents_collected', 'exit_interview_done'];

const settledRows = (r) => (r.status === 'fulfilled' ? r.value.rows : []);

export function probationStateOf(emp, today) {
  const end = emp.probation_end_date;
  const conf = emp.confirmation_date;
  if (!end && !conf) return { state: 'not_set' };
  if (conf && conf <= today) return { state: 'confirmed', confirmation_date: conf, probation_end_date: end };
  if (end && end >= today) {
    return { state: 'on_probation', probation_end_date: end, confirmation_date: conf, days_left: emp.probation_days_left };
  }
  // The probation period has ended but no confirmation is on record yet.
  return { state: 'decision_pending', probation_end_date: end, confirmation_date: conf };
}

export async function getMyEmployment(req) {
  const empId = await ownEmployeeId(req);
  if (empId == null) return { linked: false };
  const cid = companyOf(req);

  const { rows } = await pool.query(
    `SELECT e.id, e.office_id, e.status,
            COALESCE(NULLIF(TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')), ''), e.name) AS full_name, e.employment_type, e.grade, e.department, e.designation,
            e.joining_date::text       AS joining_date,
            e.probation_end_date::text AS probation_end_date,
            e.confirmation_date::text  AS confirmation_date,
            (e.probation_end_date - CURRENT_DATE) AS probation_days_left,
            e.notice_period_days,
            CURRENT_DATE::text AS today,
            NULLIF(TRIM(COALESCE(m.first_name,'') || ' ' || COALESCE(m.last_name,'')), '') AS manager_name,
            e.reporting_manager AS manager_label,
            e.reporting_manager_id
       FROM employees e
       LEFT JOIN employees m ON m.id = e.reporting_manager_id AND m.deleted_at IS NULL
      WHERE e.id = $1 AND e.deleted_at IS NULL
        AND ($2::int IS NULL OR e.company_id = $2::int)`,
    [empId, cid],
  );
  const emp = rows[0];
  if (!emp) return { linked: false };
  const today = emp.today;

  const [reviewRes, exitRes, attRes, leaveRes, docRes, assetRes, teamRes] = await Promise.allSettled([
    pool.query(
      `SELECT status, decision, new_end_date::text AS new_end_date, decided_at
         FROM probation_reviews
        WHERE employee_id = $1 AND ($2::int IS NULL OR company_id = $2::int)
        ORDER BY cycle_no DESC, id DESC LIMIT 1`,
      [empId, cid]),
    pool.query(
      `SELECT er.id, er.separation_type, er.status, er.notice_period,
              er.created_at, er.last_working_date::text AS last_working_date,
              (er.last_working_date - CURRENT_DATE) AS days_left,
              row_to_json(c) AS clearance
         FROM exit_requests er
         LEFT JOIN exit_clearance c ON c.employee_id = er.employee_id
        WHERE er.employee_id = $1 AND er.status <> ALL($2::text[])
        ORDER BY er.created_at DESC LIMIT 1`,
      [empId, EXIT_DONE]),
    pool.query(
      `SELECT LOWER(status) AS status, COUNT(*)::int AS n,
              COALESCE(SUM(late_minutes) FILTER (WHERE late_minutes > 0), 0)::int AS late_minutes,
              COUNT(*) FILTER (WHERE late_minutes > 0)::int AS late_days
         FROM attendance_records
        WHERE employee_id = $1 AND deleted_at IS NULL
          AND attendance_date >= date_trunc('month', CURRENT_DATE)::date
          AND attendance_date <= CURRENT_DATE
        GROUP BY 1`,
      [empId]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM leave_applications
        WHERE employee_id = $1 AND deleted_at IS NULL AND LOWER(status) = 'pending'`,
      [empId]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM employee_documents
        WHERE employee_id = $1 AND expiry_date IS NOT NULL
          AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30`,
      [empId]),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM employee_asset_allocations
        WHERE employee_id = $1 AND status NOT IN ('returned', 'disposed', 'damaged')`,
      [empId]),
    // Team on leave today: my manager, colleagues who share my manager, and my
    // direct reports — approved leave covering today. Name and designation
    // only: the leave type (sick, maternity…) is the colleague's business.
    pool.query(
      `SELECT DISTINCT e.id,
              COALESCE(NULLIF(TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')), ''), e.name) AS name,
              e.designation,
              la.end_date::text AS back_after
         FROM leave_applications la
         JOIN employees e ON e.id = la.employee_id AND e.deleted_at IS NULL
        WHERE la.deleted_at IS NULL AND LOWER(la.status) = 'approved'
          AND CURRENT_DATE BETWEEN la.start_date AND la.end_date
          AND e.id <> $1
          AND ($3::int IS NULL OR e.company_id = $3::int)
          AND (e.reporting_manager_id = $1
               OR ($2::int IS NOT NULL AND (e.id = $2::int OR e.reporting_manager_id = $2::int)))
        ORDER BY name`,
      [empId, emp.reporting_manager_id, cid]),
  ]);

  const probation = probationStateOf(emp, today);
  const review = settledRows(reviewRes)[0];
  if (review && probation.state !== 'confirmed') {
    probation.review = {
      status: review.status,
      decision: review.decision || null,
      new_end_date: review.decision ? review.new_end_date : null,
    };
  }

  const exitRow = settledRows(exitRes)[0];
  let exit = null;
  if (exitRow) {
    const c = exitRow.clearance || {};
    exit = {
      separation_type: exitRow.separation_type,
      status: exitRow.status,
      submitted_on: exitRow.created_at,
      last_working_date: exitRow.last_working_date,
      notice_period_days: exitRow.notice_period,
      days_left: exitRow.days_left,
      clearance_done: CLEARANCE_KEYS.filter(k => c[k] === true).length,
      clearance_total: CLEARANCE_KEYS.length,
    };
  }

  const attendance = { present: 0, absent: 0, leave: 0, half_day: 0, holiday: 0, other: 0, late_days: 0, late_minutes: 0 };
  for (const r of settledRows(attRes)) {
    const s = (r.status || '').replace(/[\s-]+/g, '_');
    if (s === 'present' || s === 'late' || s === 'wfh' || s === 'on_duty') attendance.present += r.n;
    else if (s === 'absent' || s === 'lop') attendance.absent += r.n;
    else if (s === 'leave' || s === 'on_leave') attendance.leave += r.n;
    else if (s === 'half_day') attendance.half_day += r.n;
    else if (s === 'holiday' || s === 'weekend' || s === 'weekly_off') attendance.holiday += r.n;
    else attendance.other += r.n;
    attendance.late_days += r.late_days;
    attendance.late_minutes += r.late_minutes;
  }

  // Each failed slice is reported, so the page never shows "0" for a query
  // that did not run.
  const degraded = [];
  if (attRes.status === 'rejected') degraded.push('attendance');
  if (leaveRes.status === 'rejected') degraded.push('pendingLeave');
  if (docRes.status === 'rejected') degraded.push('expiringDocuments');
  if (assetRes.status === 'rejected') degraded.push('assets');
  if (exitRes.status === 'rejected') degraded.push('exit');
  if (teamRes.status === 'rejected') degraded.push('teamOnLeave');

  return {
    linked: true,
    employee: {
      office_id: emp.office_id,
      name: emp.full_name,
      status: emp.status,
      employment_type: emp.employment_type,
      grade: emp.grade,
      department: emp.department,
      designation: emp.designation,
      joining_date: emp.joining_date,
      reporting_manager: emp.manager_name || emp.manager_label || null,
      notice_period_days: emp.notice_period_days,
    },
    probation,
    exit,
    attendance,
    attention: {
      pending_leave_requests: settledRows(leaveRes)[0]?.n ?? 0,
      expiring_documents: settledRows(docRes)[0]?.n ?? 0,
      assets_held: settledRows(assetRes)[0]?.n ?? 0,
    },
    team_on_leave_today: settledRows(teamRes).map(r => ({ name: r.name, designation: r.designation, back_after: r.back_after })),
    degraded,
  };
}

export const getMyEmploymentHandler = async (req, res) => {
  try {
    res.json(await getMyEmployment(req));
  } catch (err) {
    console.error('getMyEmployment error:', err);
    res.status(500).json({ error: 'Could not load your employment details' });
  }
};
