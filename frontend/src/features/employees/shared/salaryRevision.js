/**
 * The salary revision IN FORCE on `today`: the latest one effective on or
 * before it, or — for a future joiner whose only revisions are still ahead —
 * the earliest. The same rule the backend uses to keep `employees.basic_salary`
 * (payroll's fallback) in step, so the figure Edit Employee shows is the figure
 * payroll would pay today.
 *
 * Edit Employee corrects THIS revision in place (by id). It never books a new
 * one; increments with their own effective date belong to Salary Structure.
 *
 * @param {Array<{id:number, effective_from:string}>|null|undefined} revisions
 * @param {string} [today] YYYY-MM-DD
 * @returns {object|null}
 */
export function pickCurrentRevision(revisions, today = new Date().toISOString().slice(0, 10)) {
  if (!Array.isArray(revisions) || !revisions.length) return null;
  const day = (r) => String(r?.effective_from ?? '').slice(0, 10);
  const dated = revisions.filter(r => day(r));
  const inForce = dated.filter(r => day(r) <= today).sort((a, b) => day(b).localeCompare(day(a)));
  if (inForce.length) return inForce[0];
  return [...dated].sort((a, b) => day(a).localeCompare(day(b)))[0] ?? null;
}

/** '45000.00' → '45000'; null/undefined → '' — a value an <input type=number> can hold. */
export function salaryInputValue(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
}
