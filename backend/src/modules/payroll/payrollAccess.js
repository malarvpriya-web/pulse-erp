/**
 * payrollAccess.js — who may read whose payroll data.
 *
 * A holder of `payroll:view` may read any employee's payroll data IN THEIR OWN
 * COMPANY. Everyone else reaches only their own employee record, resolved from
 * the signed-in account — never from a client-supplied employee_id.
 *
 * PC-01 (04 Nov 26): this was a role list in code (PAYROLL_READ_ROLES) that let
 * manager and hr_exec read every salary although the permission matrix grants
 * them no payroll access at all. The matrix now decides, resolved like every
 * other module (user override, else the union of the caller's roles).
 *
 * Used by payroll.routes.js (ownPayslipOrForbidden). The self-service
 * dashboard has its own explicit grants (§202).
 */
import pool from '../../config/db.js';
import { companyOf } from '../../shared/scope.js';
import { can } from '../../middlewares/auth.middleware.js';

/** May the caller read ANY employee's payroll in their company? Fails closed on a lookup error. */
export const canReadAnyPayroll = (req) => can(req, 'payroll', 'view');

/** The caller's own employee id, from the token or the users row. */
export async function ownEmployeeId(req) {
  if (req.user?.employee_id != null) return req.user.employee_id;
  const userId = req.user?.userId ?? req.user?.id;
  if (!userId) return null;
  const { rows } = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]).catch(() => ({ rows: [] }));
  return rows[0]?.employee_id ?? null;
}

/**
 * Resolve the employee a request may read, or a refusal.
 * @returns {{ employeeId: number, self: boolean } | { status: number, message: string }}
 *   Refusals carry no detail about the requested employee (no name, no
 *   existence hint across companies).
 */
export async function resolveReadableEmployee(req, requestedId) {
  const own = await ownEmployeeId(req);
  const requested = requestedId == null || requestedId === '' ? null : String(requestedId);
  if (requested != null && !/^\d+$/.test(requested)) return { status: 400, message: 'Invalid employee id' };

  if (requested == null || (own != null && requested === String(own))) {
    if (own == null) return { status: 403, message: 'No employee record is linked to this account' };
    return { employeeId: Number(own), self: true };
  }
  if (!(await canReadAnyPayroll(req))) return { status: 403, message: 'You may only view your own records' };
  const cid = companyOf(req);
  if (cid == null) return { status: 400, message: 'Company context required' };
  const { rows } = await pool.query('SELECT 1 FROM employees WHERE id = $1 AND company_id = $2', [Number(requested), cid]);
  // Same answer whether the employee is in another company or does not exist.
  if (!rows.length) return { status: 404, message: 'Employee not found' };
  return { employeeId: Number(requested), self: false };
}
