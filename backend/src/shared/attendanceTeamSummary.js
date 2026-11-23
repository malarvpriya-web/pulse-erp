/**
 * Monthly team attendance summary (§278.3, owner 2026-11-19).
 *
 * "Manager should be shared with their team members' attendance every month:
 * no. of leaves, no. of late by 15 mins, less than 30 mins and more than 30
 * mins, logging in the geo-fencing area etc."
 *
 * One row per team member for a calendar month:
 *   leave_days        approved leave inside the month (half-day leave = 0.5;
 *                     weekly offs not counted)
 *   absent_days, present_days, half_days
 *   late_upto_15      late by 1–15 min
 *   late_15_30        late by 16–30 min
 *   late_over_30      late by more than 30 min
 *   early_exits       days the last punch was before shift end
 *   app_punches       in-app (field) punches with a location — inside the fence
 *   geo_blocked       in-app punches refused for being outside the geo fence
 *   penalty_days      late-coming penalty days (Settings → Late-coming penalties)
 *
 * Used by GET /attendance/team-summary (Team Attendance → Monthly summary) and
 * by the 1st-of-month notification to each manager (jobs/attendance.cron.js).
 */
import pool from '../config/db.js';
import { getWeekendDays } from './weekend.js';
import { computePenalties } from './attendancePenalties.js';

const pad = (n) => String(n).padStart(2, '0');
export const monthRange = (m, y) => [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`];

/**
 * @param {object} o
 * @param {number|null} o.companyId
 * @param {number} o.month, o.year
 * @param {string} o.employeeWhere  extra SQL on alias `e` (team / view limit), '' for all
 */
export async function teamMonthlySummary({ companyId, month, year, employeeWhere = '' }, db = pool) {
  const [from, to] = monthRange(month, year);
  const weekend = await getWeekendDays(companyId);
  const { rows } = await db.query(`
    SELECT e.id AS employee_id, e.office_id AS emp_code,
           COALESCE(e.name, CONCAT(e.first_name, ' ', COALESCE(e.last_name, ''))) AS employee_name,
           e.department, e.designation, e.reporting_manager_id,
           COUNT(ar.id) FILTER (WHERE LOWER(ar.status) IN ('present','late','wfh'))            AS present_days,
           COUNT(ar.id) FILTER (WHERE LOWER(ar.status) = 'absent')                             AS absent_days,
           COUNT(ar.id) FILTER (WHERE LOWER(ar.status) = 'half_day')                           AS half_days,
           COUNT(ar.id) FILTER (WHERE ar.late_minutes BETWEEN 1 AND 15)                        AS late_upto_15,
           COUNT(ar.id) FILTER (WHERE ar.late_minutes BETWEEN 16 AND 30)                       AS late_15_30,
           COUNT(ar.id) FILTER (WHERE ar.late_minutes > 30)                                    AS late_over_30,
           COUNT(ar.id) FILTER (WHERE ar.early_leave_minutes > 0)                              AS early_exits,
           COUNT(ar.id) FILTER (WHERE ar.source = 'mobile' AND ar.check_in_location IS NOT NULL) AS app_punches,
           (SELECT COUNT(*) FROM attendance_audit_logs al
             WHERE al.employee_id = e.id AND al.action = 'clock_in_geo_blocked'
               AND al.performed_at::date BETWEEN $1::date AND $2::date)                       AS geo_blocked,
           (SELECT COALESCE(SUM(CASE WHEN la.half_day THEN 0.5 ELSE 1 END), 0)
              FROM leave_applications la
              CROSS JOIN LATERAL generate_series(GREATEST(la.start_date, $1::date), LEAST(la.end_date, $2::date), INTERVAL '1 day') d
             WHERE la.employee_id = e.id AND LOWER(la.status) = 'approved'
               AND la.start_date <= $2::date AND la.end_date >= $1::date
               AND NOT (LOWER(TRIM(TO_CHAR(d, 'day'))) = ANY($3::text[])))                    AS leave_days
      FROM employees e
      LEFT JOIN attendance_records ar
        ON ar.employee_id = e.id AND ar.attendance_date BETWEEN $1::date AND $2::date AND ar.deleted_at IS NULL
     WHERE e.deleted_at IS NULL AND LOWER(e.status) IN ('active', 'probation', 'notice')
       AND ($4::int IS NULL OR e.company_id = $4)
       ${employeeWhere}
     GROUP BY e.id
     ORDER BY e.department NULLS LAST, employee_name`,
  [from, to, weekend.map((d) => String(d).toLowerCase()), companyId ?? null]);

  const today = new Date().toLocaleDateString('en-CA');
  const pen = await computePenalties(companyId, rows.map((r) => r.employee_id), from, [to, today].sort()[0], db);
  return {
    month, year, from, to,
    members: rows.map((r) => {
      const num = (k) => Number(r[k] || 0);
      return {
        employee_id: r.employee_id, emp_code: r.emp_code, employee_name: r.employee_name,
        department: r.department, designation: r.designation, reporting_manager_id: r.reporting_manager_id,
        present_days: num('present_days'), absent_days: num('absent_days'), half_days: num('half_days'),
        leave_days: num('leave_days'),
        late_upto_15: num('late_upto_15'), late_15_30: num('late_15_30'), late_over_30: num('late_over_30'),
        early_exits: num('early_exits'), app_punches: num('app_punches'), geo_blocked: num('geo_blocked'),
        penalty_days: pen.get(Number(r.employee_id))?.days || 0,
      };
    }),
  };
}

/** Short text for the manager's notification. */
export function summaryText(members, monthLabel) {
  const sum = (k) => members.reduce((s, m) => s + Number(m[k] || 0), 0);
  const lines = [
    `Team attendance for ${monthLabel} (${members.length} people):`,
    `Leave ${sum('leave_days')} days · Absent ${sum('absent_days')} · Late up to 15 min ${sum('late_upto_15')} · 15–30 min ${sum('late_15_30')} · over 30 min ${sum('late_over_30')} · Early exits ${sum('early_exits')}`,
    `Geo fence: ${sum('app_punches')} app punches inside, ${sum('geo_blocked')} refused outside · Salary cut for late coming ${sum('penalty_days')} days`,
  ];
  const worst = [...members].sort((a, b) => (b.late_15_30 + b.late_over_30) - (a.late_15_30 + a.late_over_30))
    .filter((m) => m.late_15_30 + m.late_over_30 > 0).slice(0, 3);
  if (worst.length) lines.push(`Most late: ${worst.map((m) => `${m.employee_name} (${m.late_15_30 + m.late_over_30})`).join(', ')}`);
  lines.push('Open Attendance → Team Attendance → Monthly summary for each person.');
  return lines.join('\n');
}
