/**
 * Comp-off policy: how many leave days a stint of holiday/weekend work earns,
 * and which leave type that credit lands in.
 *
 * The credit rule was written out by hand in four places (the submit route, the
 * approve route, the manual expiry route and leave.cron.js) as
 * `hours >= 8 ? 1 : 0.5`, which pays half a day for working one hour. The
 * documented policy — COMPOFF_AUDIT.md §3 — is 8h+ = a full day, 4h+ = half a
 * day, under 4h = nothing. One function, so a policy change is one edit.
 */
import { getWeekendDays, dayIsWeekend, dayNameOf } from './weekend.js';

export const FULL_DAY_HOURS = 8;
export const HALF_DAY_HOURS = 4;
export const COMP_OFF_EXPIRY_MONTHS = 3;

/** Leave days earned for `hours` worked. 0 means the stint earns nothing. */
export function creditDaysFor(hours) {
  // hours_worked is NUMERIC, which node-postgres hands back as a string.
  const h = Number(hours);
  if (!Number.isFinite(h) || h < HALF_DAY_HOURS) return 0;
  return h >= FULL_DAY_HOURS ? 1 : 0.5;
}

/**
 * The leave type comp-off credits are posted into, or null when the company
 * has not flagged one.
 *
 * Callers MUST treat null as a hard failure. The approve route used to do
 * `if (ltRows.length) { ...credit... }` and then reply `{ credited: true }`
 * regardless — so on a database where no leave type carries the
 * is_comp_off_type flag (the shipped seed data flags none), approving a comp
 * off marked the record credited, told the employee their balance had gone up,
 * and moved no balance at all.
 */
export async function compOffLeaveTypeId(pool, companyId) {
  const { rows } = await pool.query(
    `SELECT id FROM leave_types
      WHERE is_comp_off_type = true AND is_active = true AND deleted_at IS NULL
        AND (company_id IS NULL OR company_id = $1)
      ORDER BY (company_id IS NULL), id
      LIMIT 1`,
    [companyId ?? null]
  );
  return rows[0]?.id ?? null;
}

export const NO_COMP_OFF_TYPE_MESSAGE =
  'No leave type is marked as the comp-off type, so there is nowhere to credit the balance. ' +
  'Set "Is comp off type" on a leave type (Leave → Leave Types) and approve again.';

/**
 * Is `workDate` a day comp off can be claimed for?
 *
 * Returns { eligible, reason, day_name, holiday } so the caller can explain the
 * answer rather than just refusing. The request form calls this through
 * GET /comp-off/eligibility to show the verdict before the employee submits.
 */
export async function checkEligibility(pool, workDate, companyId) {
  const date = String(workDate).slice(0, 10);
  const day_name = dayNameOf(date);

  const { rows: holRows } = await pool.query(
    `SELECT id, name FROM holidays
      WHERE date = $1::date AND (company_id = $2 OR company_id IS NULL)
      ORDER BY (company_id IS NULL)
      LIMIT 1`,
    [date, companyId ?? null]
  );
  const holiday = holRows[0] ?? null;
  if (holiday) {
    return { eligible: true, reason: `${holiday.name} — declared holiday`, day_name, holiday };
  }

  const weekendDays = await getWeekendDays(companyId);
  if (dayIsWeekend(date, weekendDays)) {
    const label = day_name.charAt(0).toUpperCase() + day_name.slice(1);
    return { eligible: true, reason: `${label} — weekend`, day_name, holiday: null };
  }

  const label = day_name.charAt(0).toUpperCase() + day_name.slice(1);
  return {
    eligible: false,
    reason: `${label} is a working day — comp off can only be claimed for a weekend or a declared holiday.`,
    day_name,
    holiday: null,
  };
}

/**
 * Is comp off given to this employee? (§278.4, owner 2026-11-19: "we are not
 * going to give comp off to everyone — production employees; for each employee
 * we have to choose".) Chosen in Attendance → Configuration → Settings → Comp off.
 */
export async function isCompOffEligible(db, employeeId) {
  const { rows: [e] } = await db.query(`SELECT comp_off_eligible FROM employees WHERE id = $1`, [employeeId])
    .catch(() => ({ rows: [] }));
  return e?.comp_off_eligible === true;
}

/**
 * Grant comp off for a full day worked on a holiday — from the punch machine
 * or the app. Does nothing unless comp off is switched on in Settings AND the
 * employee is chosen for it. One open grant per employee per date (a rejected
 * one may be raised again). Returns true when a grant was written.
 */
export async function autoGrantHolidayCompOff(db, { employeeId, companyId, date, hours, fullDayHours, enabled }) {
  if (!enabled || !(Number(hours) >= Number(fullDayHours || FULL_DAY_HOURS))) return false;
  if (!(await isCompOffEligible(db, employeeId))) return false;
  const { rows: [h] } = await db.query(
    `SELECT id FROM holidays WHERE date = $1::date AND (company_id = $2 OR company_id IS NULL) LIMIT 1`, [date, companyId]);
  if (!h) return false;
  const { rowCount } = await db.query(`
    INSERT INTO compensatory_off (employee_id, work_date, hours_worked, holiday_id, reason, expires_on, company_id, auto_granted)
    SELECT $1, $2::date, $3, $4, 'Auto-granted: worked a full day on a holiday', ($2::date + INTERVAL '3 months')::date, $5, TRUE
     WHERE NOT EXISTS (SELECT 1 FROM compensatory_off WHERE employee_id = $1 AND work_date = $2::date AND status <> 'rejected')`,
  [employeeId, date, Number(hours).toFixed(2), h.id, companyId]);
  return rowCount > 0;
}
