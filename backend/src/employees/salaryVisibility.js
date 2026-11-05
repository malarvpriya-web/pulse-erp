// Who may see the master Basic on an employee record (PC-01 closure, 04 Nov 26).
//
// maskPII's role lists return the full row to every HR_PII role — hr_exec
// included — so a role with no payroll access read every colleague's Basic
// through the employee APIs while the Payroll Center refused it. The salary
// history behind it (GET /employees/:id/salary-revisions) is payroll:view
// already; this puts the master figure on the same permission. The employee's
// own row is always theirs to see.
import { can } from "../middlewares/auth.middleware.js";

export const SALARY_KEYS = ["basic_salary"];

/** Drop the salary keys from every row but the caller's own, unless they hold payroll:view. */
export async function withSalaryMasking(req, payload) {
  if (await can(req, "payroll", "view")) return payload;
  const own = req.user?.employee_id != null ? String(req.user.employee_id) : null;
  const strip = (e) => {
    if (!e || typeof e !== "object" || String(e.id) === own || !SALARY_KEYS.some(k => k in e)) return e;
    const out = { ...e };
    for (const k of SALARY_KEYS) delete out[k];
    return out;
  };
  if (Array.isArray(payload)) return payload.map(strip);
  if (payload && typeof payload === "object") {
    const out = strip(payload);
    for (const k of ["data", "employees", "rows"]) if (Array.isArray(out[k])) out[k] = out[k].map(strip);
    if (out.employee && typeof out.employee === "object") out.employee = strip(out.employee);
    return out;
  }
  return payload;
}
