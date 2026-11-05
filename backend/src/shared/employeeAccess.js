/**
 * Who may read what about ANOTHER employee — the pieces the HR-notes,
 * onboarding-progress and employee-list reads share (2026-10-20).
 *
 * Three rules live here so the three endpoints cannot drift apart:
 *
 *  1. Scope. companyOf(req) answers "which company", but a NULL answer means
 *     two different things: a super admin with a genuinely global scope, and a
 *     user whose company could not be resolved at all (auth.middleware sets
 *     req.scope = null for them). Treating the second as "every company" is a
 *     fail-open. readScope() refuses it.
 *
 *  2. HR seats. HR_RECORD_ROLES are the roles that work an employee's HR
 *     record: they read it company-wide. payroll_admin is deliberately not one
 *     — it holds hr:view for payroll, not for personnel notes or onboarding.
 *
 *  3. Management. managesEmployee() is true only when the caller is in the
 *     employee's reporting line by id (direct or indirect manager), or is the
 *     current head of the employee's department. The name-matching fallback some
 *     dashboards use (reporting_manager text = caller's name) is deliberately
 *     NOT honoured here: two people can share a name, and an access decision
 *     cannot rest on that.
 */
import pool from "../config/db.js";
import { companyOf } from "./scope.js";
import { hasRole } from "../middlewares/auth.middleware.js";

export const HR_RECORD_ROLES = ["admin", "super_admin", "hr", "hr_manager", "hr_exec"];
export const LINE_MANAGER_ROLES = ["manager", "department_head"];

export const isHrRecordUser = (req) => hasRole(req, HR_RECORD_ROLES);
export const isLineManager = (req) => hasRole(req, LINE_MANAGER_ROLES);

/**
 * The caller's company for a read, or `{ refused: true }`.
 * `companyId: null` is returned only to a super admin (global scope).
 */
export function readScope(req) {
  const companyId = companyOf(req);
  if (companyId == null && !hasRole(req, "super_admin")) return { refused: true, companyId: null };
  return { refused: false, companyId };
}

/** A positive integer id from a route param, or null. "12abc", "1.5", "-0" are null. */
export function parseEmployeeId(raw) {
  const s = String(raw ?? "").trim();
  if (!/^[1-9][0-9]{0,9}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n <= 2147483647 ? n : null;
}

/** Is this employee (not deleted) inside the caller's company? null company = global. */
export async function employeeInCompany(employeeId, companyId, db = pool) {
  const { rows } = await db.query(
    `SELECT 1 FROM employees
      WHERE id = $1 AND deleted_at IS NULL
        AND ($2::int IS NULL OR company_id = $2::int)`,
    [employeeId, companyId]
  );
  return rows.length > 0;
}

/**
 * True when `managerEmployeeId` is the employee's direct or indirect manager
 * (by reporting_manager_id, same company), or the CURRENT head of the
 * employee's department (department_heads, ended_at IS NULL). Never true for
 * oneself, and never across companies.
 */
export async function managesEmployee({ managerEmployeeId, employeeId, companyId }, db = pool) {
  if (managerEmployeeId == null || employeeId == null) return false;
  if (String(managerEmployeeId) === String(employeeId)) return false;
  const { rows } = await db.query(
    `WITH RECURSIVE up AS (
        SELECT e.reporting_manager_id AS mid, 1 AS depth
          FROM employees e
         WHERE e.id = $1 AND e.deleted_at IS NULL
           AND ($3::int IS NULL OR e.company_id = $3::int)
        UNION ALL
        SELECT m.reporting_manager_id, up.depth + 1
          FROM employees m
          JOIN up ON m.id = up.mid
         WHERE up.depth < 25
           AND m.deleted_at IS NULL
           AND ($3::int IS NULL OR m.company_id = $3::int)
     )
     SELECT 1 WHERE EXISTS (
              SELECT 1 FROM up
                JOIN employees mgr ON mgr.id = up.mid
               WHERE up.mid = $2 AND mgr.deleted_at IS NULL
                 AND ($3::int IS NULL OR mgr.company_id = $3::int))
         OR EXISTS (
              SELECT 1
                FROM department_heads dh
                JOIN master_departments d ON d.id = dh.department_id
                JOIN employees e ON LOWER(TRIM(e.department)) = LOWER(TRIM(d.name))
               WHERE dh.head_employee_id = $2
                 AND dh.ended_at IS NULL
                 AND e.id = $1 AND e.deleted_at IS NULL
                 AND dh.company_id = e.company_id
                 AND ($3::int IS NULL OR e.company_id = $3::int))`,
    [employeeId, managerEmployeeId, companyId]
  );
  return rows.length > 0;
}
