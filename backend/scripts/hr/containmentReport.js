/**
 * containmentReport.js — READ-ONLY checks for HR P0 containment C2 and C4
 * (HR_P0_REMEDIATION_DESIGN_2026-11-03.md, Appendix A). Library; the CLI is
 * hr-containment-report.mjs. Nothing here writes: every function is a SELECT.
 *
 * C4  exitedActiveLogins — an employee who has left (any exit status) whose
 *     login is still active, and whether it was used after the last working
 *     day. Deactivating is NOT done here: each account needs HR confirmation.
 *
 * C2  leaversInMonth — everyone with a last working day (or exit date) in a
 *     payroll month and that month's payroll run. Today an exited status fails
 *     payroll rule E2, so `excluded_by_e2` people are dropped from the month and
 *     regenerating the month DELETES their draft (`draft_at_risk`). Payroll uses
 *     this list by hand until the P0-2 fix ships.
 */
import { isExitedSql, statusExpr } from '../../src/shared/employeeStatus.js';
import { PAYABLE_STATUSES } from '../../src/modules/payroll/payrollEligibility.js';

const companyFilter = (alias, n) => `($${n}::int IS NULL OR ${alias}.company_id = $${n}::int)`;

/** C4 — exited employees whose login still works. */
export async function exitedActiveLogins(db, { companyId = null } = {}) {
  const { rows } = await db.query(`
    SELECT e.id AS employee_id, e.office_id, e.company_id, e.status, e.exit_date,
           u.id AS user_id, u.email, u.last_login,
           er.id AS exit_request_id, er.status AS exit_status, er.last_working_date,
           c.access_revoked,
           (u.last_login IS NOT NULL
             AND COALESCE(er.last_working_date, e.exit_date) IS NOT NULL
             AND u.last_login::date > COALESCE(er.last_working_date, e.exit_date)) AS logged_in_after_lwd
      FROM employees e
      JOIN users u ON u.employee_id = e.id AND u.is_active = true
      LEFT JOIN LATERAL (
             SELECT id, status, last_working_date FROM exit_requests x
              WHERE x.employee_id = e.id AND x.status NOT IN ('rejected','cancelled')
              ORDER BY x.created_at DESC, x.id DESC LIMIT 1) er ON true
      LEFT JOIN exit_clearance c ON c.employee_id = e.id
     WHERE ${isExitedSql('e.status')} AND ${companyFilter('e', 1)}
     ORDER BY e.company_id, e.id, u.id`, [companyId]);
  return rows;
}

/** C2 — leavers in a payroll month and what payroll will do with them today. */
export async function leaversInMonth(db, { year, month, companyId = null }) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('leaversInMonth needs an integer year and a month 1–12');
  }
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const { rows } = await db.query(`
    WITH period AS (SELECT $1::date AS s, ($1::date + INTERVAL '1 month' - INTERVAL '1 day')::date AS e)
    SELECT e.id AS employee_id, e.office_id, e.company_id, e.status, e.exit_date,
           er.id AS exit_request_id, er.status AS exit_status, er.last_working_date,
           pr.id AS payroll_run_id, pr.status AS run_status,
           NOT (${statusExpr('e.status')} = ANY($3::text[])) AS excluded_by_e2,
           COALESCE(pr.status IN ('draft','pending') AND NOT (${statusExpr('e.status')} = ANY($3::text[])), false) AS draft_at_risk
      FROM employees e
      CROSS JOIN period p
      LEFT JOIN LATERAL (
             SELECT id, status, last_working_date FROM exit_requests x
              WHERE x.employee_id = e.id AND x.status NOT IN ('rejected','cancelled')
              ORDER BY x.created_at DESC, x.id DESC LIMIT 1) er ON true
      LEFT JOIN payroll_runs pr
             ON pr.employee_id = e.id AND pr.month = $4 AND pr.year = $5 AND pr.is_test = false
     WHERE ${companyFilter('e', 2)}
       AND e.deleted_at IS NULL
       AND (er.last_working_date BETWEEN p.s AND p.e OR e.exit_date BETWEEN p.s AND p.e)
     ORDER BY e.company_id, e.id`,
    [start, companyId, PAYABLE_STATUSES, month, year]);
  return rows;
}
