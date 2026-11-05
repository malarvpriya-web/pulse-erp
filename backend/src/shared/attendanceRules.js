/**
 * attendanceRules.js — rules every attendance_records capture path must apply
 * the same way.
 *
 * Both helpers lived inside attendance.routes.js, so only `/qr/scan` could use
 * them, and MODULE_FEATURE_CONNECTION_MANUAL.md §103 recorded that the
 * biometric sync had neither a freeze check nor the configurable OT threshold.
 * They live here so the biometric sync and CSV import (hr/biometric.routes.js)
 * answer the same question the same way. §197.
 *
 * Both take an optional `db` (a pool client inside a transaction); the pool is
 * the default.
 */
import pool from '../config/db.js';

/**
 * The working day as Attendance Settings define it:
 *   workHours    full_day_hours   (hours of work)
 *   breakMinutes break_duration   (unpaid lunch, minutes)
 *   spanHours    workHours + breakMinutes / 60 — time ON SITE that makes a
 *                full day. Overtime is on-site time beyond this.
 *
 * Policy (account holder, 2026-10-28): "8 hrs + lunch break 30 mins = 8.30
 * hrs" — a full day is 8.5 h on site, and OT starts after it, on every capture
 * path. §198.
 *
 * Company row first, else the global row (company_id IS NULL), the lookup
 * shared/weekend.js uses. ⚠ It used to read the company row ONLY, which never
 * matched the global rows Attendance Settings actually holds, so every tenant
 * fell through to a hardcoded 9 and the configured 8 h was ignored.
 * With no settings row at all: 8 h + 60 min, i.e. the old 9 h.
 */
export async function getShiftRule(companyId, db = pool) {
  const fallback = { workHours: 8, breakMinutes: 60, spanHours: 9 };
  try {
    const { rows: [s] } = await db.query(
      `SELECT full_day_hours, break_duration FROM attendance_general_settings
        WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
        ORDER BY (company_id IS NULL), id LIMIT 1`,
      [companyId ?? null]
    );
    if (!s) return fallback;
    const work = parseFloat(s.full_day_hours);
    const brk = parseInt(s.break_duration, 10);
    const workHours = Number.isFinite(work) && work > 0 ? work : fallback.workHours;
    const breakMinutes = Number.isFinite(brk) && brk >= 0 ? brk : 0;
    return { workHours, breakMinutes, spanHours: workHours + breakMinutes / 60 };
  } catch {
    return fallback;
  }
}

/**
 * Hours ON SITE that count as a full day before OT starts accruing
 * (= getShiftRule().spanHours: 8.5 with the current settings).
 * Every OT computation reads this — /clock, regularisation, /qr/scan,
 * offline sync, the auto-checkout cron and the biometric sync/import.
 */
export async function getFullDayHours(companyId, db = pool) {
  return (await getShiftRule(companyId, db)).spanHours;
}

/**
 * True when the month containing dateStr ('YYYY-MM-DD') has been frozen by a
 * payroll sync. Writing into a frozen month silently changes numbers payroll
 * has already paid on, so every capture path must check before upserting
 * attendance_records.
 *
 * The month is taken from the date string in SQL. The original built a JS
 * `new Date(dateStr)`, which parses a bare date as UTC midnight — correct only
 * while the server sits east of UTC.
 */
export async function isPeriodFrozen(dateStr, companyId, db = pool) {
  try {
    const { rows } = await db.query(`
      SELECT 1 FROM attendance_records
       WHERE date_trunc('month', attendance_date) = date_trunc('month', $1::date)
         AND is_frozen = true AND deleted_at IS NULL
         AND ($2::integer IS NULL OR company_id = $2)
       LIMIT 1
    `, [String(dateStr).slice(0, 10), companyId]);
    return rows.length > 0;
  } catch {
    return false;
  }
}
