/**
 * fnfDue.js — when a leaver's Full & Final is due (§276).
 *
 * Final wages: within settlement.wage_payment.working_days (2) working days
 * after the last working day (Code on Wages s.17(2)). Working days skip
 * Sundays and the company's holidays (the employee's zone, or company-wide).
 * Gratuity: within settlement.gratuity.payment_days (30) calendar days.
 * Shown on Exit Management and used by the overdue reminder job.
 */
import { resolveSettlementRules } from './settlementRules.js';
import { loadRuleRows } from '../payroll/statutoryRules.js';

const DAY = 86400000;
const utc = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The date `n` working days after `fromIso` (Sundays and `holidays` skipped). */
export function addWorkingDays(fromIso, n, holidays = new Set()) {
  let t = utc(fromIso), left = Number(n) || 0;
  while (left > 0) {
    t += DAY;
    const d = iso(t);
    if (new Date(t).getUTCDay() !== 0 && !holidays.has(d)) left -= 1;
  }
  return iso(t);
}

/** Calendar days `today` is past `dueIso` (0 when not late). */
export const daysLate = (dueIso, todayIso) => Math.max(0, Math.round((utc(todayIso) - utc(dueIso)) / DAY));

/** The company's holidays (company-wide or the given zone) in a window, as a Set of YYYY-MM-DD. */
export async function holidaySet(db, companyId, fromIso, toIso, zoneId = null) {
  const { rows } = await db.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS d FROM holidays
      WHERE company_id = $1 AND date BETWEEN $2::date AND $3::date AND (zone_id IS NULL OR zone_id = $4)`,
    [companyId, fromIso, toIso, zoneId]);
  return new Set(rows.map((r) => r.d));
}

/**
 * Due dates for one exit. `rules` may be passed (one company, many exits);
 * otherwise they are read for the company.
 * @returns {{ wages_due: string, gratuity_due: string, working_days: number, payment_days: number }}
 */
export async function fnfDueDates(db, { companyId, lwd, zoneId = null, rules = null }) {
  const r = rules ?? resolveSettlementRules(lwd, await loadRuleRows(db, companyId)).values;
  const workingDays = Number(r['settlement.wage_payment']?.working_days ?? 2);
  const paymentDays = Number(r['settlement.gratuity']?.payment_days ?? 30);
  // A generous window: every working day needed sits inside it.
  const holidays = await holidaySet(db, companyId, lwd, iso(utc(lwd) + (workingDays * 3 + 14) * DAY), zoneId);
  return {
    wages_due: addWorkingDays(lwd, workingDays, holidays),
    gratuity_due: iso(utc(lwd) + paymentDays * DAY),
    working_days: workingDays,
    payment_days: paymentDays,
  };
}
