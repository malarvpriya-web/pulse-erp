/**
 * Which days a company treats as its weekend.
 *
 * This lived only inside attendance.routes.js, so every other module that had
 * to answer "is this a non-working day?" grew its own copy — and comp-off's
 * copy hardcoded Saturday/Sunday. A company on a six-day week (or a plant whose
 * weekly off is Wednesday) had attendance and comp-off disagreeing about the
 * same date: attendance auto-granted comp off for it while the request form
 * rejected the manual claim with "weekend or declared holiday".
 *
 * One definition, imported by both.
 */
import pool from '../config/db.js';

export const DOW_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const DEFAULT_WEEKEND = ['saturday', 'sunday'];

/**
 * The company's configured weekend days, falling back to Sat/Sun.
 *
 * The original lookup was `WHERE company_id = $1`, which matches nothing when
 * the settings row is global (company_id IS NULL) — SQL `= NULL` is never true,
 * so a null companyId matched nothing either. Every tenant silently fell
 * through to the hardcoded default and the Attendance Settings screen had no
 * effect. Prefer a company-specific row, fall back to the global one.
 */
export async function getWeekendDays(companyId) {
  try {
    const { rows } = await pool.query(
      `SELECT weekend_days, saturday_off_weeks
         FROM attendance_general_settings
        WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
        ORDER BY (company_id IS NULL), id
        LIMIT 1`,
      [companyId ?? null]
    );
    const days = rows[0]?.weekend_days;
    const list = Array.isArray(days) && days.length ? days.map(d => String(d).toLowerCase()) : [...DEFAULT_WEEKEND];
    return withSaturdayWeeks(list, rows[0]?.saturday_off_weeks);
  } catch {
    return [...DEFAULT_WEEKEND];
  }
}

/**
 * Saturdays off by week of the month (owner, 2026-11-23): e.g. 2nd and 4th
 * Saturday off, the other Saturdays working. Only applies when 'saturday' is
 * NOT a whole weekend day. Carried on the returned array as `saturdayWeeks`
 * so every existing caller of getWeekendDays()/dayIsWeekend() follows it.
 */
export function withSaturdayWeeks(list, weeks) {
  const w = (Array.isArray(weeks) ? weeks : []).map(Number).filter(n => n >= 1 && n <= 5);
  const out = [...list];
  out.saturdayWeeks = list.includes('saturday') ? [] : [...new Set(w)].sort();
  return out;
}

/** Week of the month a date falls in for its weekday (1 = days 1–7, 2 = 8–14, …). */
export const weekOfMonth = (dateStr) => Math.ceil(Number(String(dateStr).slice(8, 10)) / 7);

/**
 * SQL test "this date is a weekly off" for `col` (a date expression), given the
 * array from getWeekendDays(). Binds two parameters at $n and $n+1:
 *   params.push(names, weeks) — see weekendSqlParams().
 */
export const weekendSql = (col, n) =>
  `(LOWER(TRIM(TO_CHAR(${col}, 'day'))) = ANY($${n}::text[])
    OR (EXTRACT(DOW FROM ${col}) = 6 AND CEIL(EXTRACT(DAY FROM ${col}) / 7.0)::int = ANY($${n + 1}::int[])))`;
export const weekendSqlParams = (weekendDays) => [
  [...(weekendDays || DEFAULT_WEEKEND)].map(d => String(d).toLowerCase()),
  weekendDays?.saturdayWeeks || [],
];

/**
 * Day-of-week name for a 'YYYY-MM-DD' string.
 *
 * The 'T00:00:00' suffix is load-bearing: `new Date('2026-09-05')` is parsed as
 * UTC midnight and `.getDay()` reads it back in local time, so on any server
 * west of UTC a Saturday reports as Friday. Appending the time forces the
 * local-midnight parse the calendar actually means.
 */
export function dayNameOf(dateStr) {
  return DOW_NAMES[new Date(`${String(dateStr).slice(0, 10)}T00:00:00`).getDay()];
}

export function dayIsWeekend(dateStr, weekendDays) {
  const name = dayNameOf(dateStr);
  if ((weekendDays || DEFAULT_WEEKEND).includes(name)) return true;
  return name === 'saturday' && (weekendDays?.saturdayWeeks || []).includes(weekOfMonth(dateStr));
}
