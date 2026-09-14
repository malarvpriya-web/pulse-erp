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
      `SELECT weekend_days
         FROM attendance_general_settings
        WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
        ORDER BY (company_id IS NULL), id
        LIMIT 1`,
      [companyId ?? null]
    );
    const days = rows[0]?.weekend_days;
    return Array.isArray(days) && days.length ? days.map(d => String(d).toLowerCase()) : DEFAULT_WEEKEND;
  } catch {
    return DEFAULT_WEEKEND;
  }
}

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
  return (weekendDays || DEFAULT_WEEKEND).includes(dayNameOf(dateStr));
}
