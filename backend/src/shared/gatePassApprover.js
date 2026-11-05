/**
 * gatePassApprover.js — who approves a gate pass. MODULE_FEATURE_CONNECTION_MANUAL.md §198.
 *
 * Policy (account holder, 2026-10-28): the approver comes from the pass
 * holder's own department —
 *   1. the CURRENT head of the employee's department (department_heads,
 *      ended_at IS NULL, matched to employees.department by name, the way
 *      shared/employeeAccess.js managesEmployee() matches it);
 *   2. if the department has no head, the employee's reporting manager;
 *   3. if neither exists — or the pass names a visitor, not an employee — HR
 *      (any holder of hr:edit).
 * The approver must be a current, non-deleted employee of the same company,
 * and is never the pass holder: a head's own pass falls to their manager.
 * HR does not approve over a department head or manager; it covers only the
 * case where the department has nobody to approve.
 *
 * One SQL fragment, used by the approve/cancel routes, the gate-pass list
 * (who is awaited, and whether the caller may act) and the Approval Center —
 * so the button, the inbox and the endpoint cannot disagree.
 */
import { isCurrentSql } from './employeeStatus.js';

/**
 * LEFT JOIN LATERAL yielding `appr.approver_kind` ('department_head' |
 * 'reporting_manager' | 'hr'), `appr.approver_employee_id` and
 * `appr.approver_name` for the gate pass aliased `gp`.
 */
export const GP_APPROVER_JOIN = `
  LEFT JOIN LATERAL (
    SELECT x.kind AS approver_kind, x.emp_id AS approver_employee_id, x.emp_name AS approver_name
      FROM (
        SELECT 1 AS rk, 'department_head'::text AS kind, h.id AS emp_id, h.name::text AS emp_name
          FROM employees pe
          JOIN master_departments d ON LOWER(BTRIM(d.name)) = LOWER(BTRIM(pe.department))
          JOIN department_heads dh ON dh.department_id = d.id AND dh.ended_at IS NULL
                                  AND dh.company_id = pe.company_id
          JOIN employees h ON h.id = dh.head_employee_id
         WHERE pe.id = gp.employee_id AND pe.company_id = gp.company_id
           AND h.id <> pe.id AND h.company_id = pe.company_id
           AND h.deleted_at IS NULL AND ${isCurrentSql('h.status')}
        UNION ALL
        SELECT 2, 'reporting_manager', m.id, m.name::text
          FROM employees pe
          JOIN employees m ON m.id = pe.reporting_manager_id
         WHERE pe.id = gp.employee_id AND pe.company_id = gp.company_id
           AND m.id <> pe.id AND m.company_id = pe.company_id
           AND m.deleted_at IS NULL AND ${isCurrentSql('m.status')}
        UNION ALL
        SELECT 3, 'hr', NULL::int, NULL::text
      ) x
     ORDER BY x.rk
     LIMIT 1
  ) appr ON true`;

export const APPROVER_LABEL = {
  department_head: 'Department head',
  reporting_manager: 'Reporting manager',
  hr: 'HR',
};

/**
 * May `callerEmployeeId` (holding hr:edit or not) approve this pass?
 * `row` carries employee_id + the GP_APPROVER_JOIN columns.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function approverDecision(row, { callerEmployeeId, hrEdit }) {
  if (row.employee_id != null && callerEmployeeId != null
      && String(row.employee_id) === String(callerEmployeeId)) {
    return { ok: false, reason: 'You cannot approve your own gate pass.' };
  }
  if (row.approver_kind === 'hr') {
    return hrEdit ? { ok: true }
      : { ok: false, reason: 'This pass is approved by HR: its department has no head and the employee has no reporting manager.' };
  }
  if (callerEmployeeId != null && String(callerEmployeeId) === String(row.approver_employee_id)) return { ok: true };
  return {
    ok: false,
    reason: `This pass is approved by ${row.approver_name || 'the approver'} (${APPROVER_LABEL[row.approver_kind] || 'approver'}).`,
  };
}
