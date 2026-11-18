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
import { getWeekendDays, dayIsWeekend } from './weekend.js';

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

/**
 * The company's Attendance Settings row: the company's own row when there is
 * one, else the global row (company_id IS NULL). Every reader uses this one
 * lookup. ⚠ The settings screen used `WHERE company_id = $1`, which never
 * matched the global row, so it always showed hardcoded defaults and every
 * save inserted ANOTHER global row (the unique index treats NULLs as
 * distinct) — two contradicting global rows existed until §278.
 */
export async function getAttendanceSettingsRow(companyId, db = pool) {
  try {
    const { rows: [s] } = await db.query(
      `SELECT * FROM attendance_general_settings
        WHERE ($1::int IS NULL AND company_id IS NULL) OR company_id = $1 OR company_id IS NULL
        ORDER BY (company_id IS NULL), id LIMIT 1`,
      [companyId ?? null]
    );
    return s || null;
  } catch {
    return null;
  }
}

/**
 * Switches the owner turns on later (§278): overtime and comp off are kept as
 * features but OFF until configured. Regularisation is limited per employee
 * per month (default 3) and can need HR after the manager.
 */
export async function getAttendanceSwitches(companyId, db = pool) {
  const s = await getAttendanceSettingsRow(companyId, db);
  const lim = parseInt(s?.regularization_monthly_limit, 10);
  return {
    otEnabled: s?.ot_enabled === true,
    compOffEnabled: s?.comp_off_enabled === true,
    regularizationLimit: Number.isFinite(lim) && lim >= 0 ? lim : 3,
    regularizationNeedsHr: s?.regularization_needs_hr === true,
  };
}

/**
 * Record overtime for one employee-day — the ONE place an OT request is made.
 *
 * Used by the in-app clock-out, an approved regularisation and the punch
 * machine sync/import. Before §278 each had its own copy (the machine path had
 * none, so machine punchers could never earn OT). Does nothing while overtime
 * is switched off in Attendance Settings.
 *
 * `opts.status` forces a status (regularisation always asks for approval);
 * otherwise the overtime policy's requires_approval decides.
 * Returns the hours recorded, or 0.
 */
export async function recordOvertime(db, { companyId, employeeId, date, otHours, isNightShift = false, status = null }) {
  const sw = await getAttendanceSwitches(companyId, db);
  if (!sw.otEnabled) return 0;
  let hours = Math.max(0, Number(otHours) || 0);
  if (hours < 0.5) return 0;

  const { rows: [pol] } = await db.query(
    `SELECT rules FROM attendance_policies
      WHERE policy_type = 'overtime' AND is_active = true
        AND (company_id = $1 OR company_id IS NULL)
      ORDER BY company_id DESC NULLS LAST LIMIT 1`, [companyId ?? null]
  ).catch(() => ({ rows: [] }));
  const rules = pol?.rules || { requires_approval: true, weekday_multiplier: 2.0 };

  const maxDaily = parseFloat(rules.max_daily_ot_hours || 0);
  if (maxDaily > 0) hours = Math.min(hours, maxDaily);
  if (rules.max_monthly_ot_hours) {
    const { rows: [u] } = await db.query(
      `SELECT COALESCE(SUM(ot_hours), 0) AS used FROM attendance_ot_records
        WHERE employee_id = $1 AND attendance_date >= date_trunc('month', $2::date)
          AND attendance_date < $2::date AND status IN ('approved', 'auto_approved')`,
      [employeeId, date]
    ).catch(() => ({ rows: [{ used: 0 }] }));
    hours = Math.min(hours, Math.max(0, parseFloat(rules.max_monthly_ot_hours) - parseFloat(u?.used || 0)));
  }
  if (hours < 0.5) return 0;

  const weekend = dayIsWeekend(date, await getWeekendDays(companyId));
  const { rows: hol } = await db.query(
    'SELECT 1 FROM holidays WHERE date = $1::date AND (company_id = $2 OR company_id IS NULL) LIMIT 1',
    [date, companyId ?? null]
  ).catch(() => ({ rows: [] }));
  let type = 'weekday';
  let mult = parseFloat(rules.weekday_multiplier || 2.0);
  if (hol.length) { type = 'holiday'; mult = parseFloat(rules.holiday_multiplier || 2.0); }
  else if (weekend) { type = 'weekend'; mult = parseFloat(rules.weekend_multiplier || 2.0); }
  else if (isNightShift) { type = 'night'; mult = parseFloat(rules.night_multiplier || 2.0); }

  const st = status || (rules.requires_approval === false ? 'auto_approved' : 'pending');
  await db.query(
    `INSERT INTO attendance_ot_records
       (company_id, employee_id, attendance_date, ot_hours, ot_type, multiplier, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (employee_id, attendance_date) DO UPDATE
       SET ot_hours = $4, ot_type = $5, multiplier = $6, status = $7, updated_at = NOW()
     WHERE attendance_ot_records.status NOT IN ('approved', 'rejected')`,
    [companyId ?? null, employeeId, date, hours.toFixed(2), type, mult, st]
  );
  return hours;
}

// Late-arrival alert to the reporting manager (employees.reporting_manager_id).
// Shared by the in-app clock-in and the punch machine sync.
export async function notifyLateArrival(employeeId, lateMinutes, how = 'punched in') {
  const { rows: [row] } = await pool.query(`
    SELECT COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS emp_name,
           mu.id AS mgr_user_id
      FROM employees e
      JOIN employees m ON m.id = e.reporting_manager_id AND m.deleted_at IS NULL
      JOIN users mu ON mu.employee_id = m.id AND mu.is_active = true
     WHERE e.id = $1
     ORDER BY mu.id LIMIT 1`, [employeeId]);
  if (!row?.mgr_user_id) return;
  const delay = lateMinutes > 0 ? `${lateMinutes} minute${lateMinutes !== 1 ? 's' : ''} late` : 'late (within grace)';
  await pool.query(`
    INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
    VALUES ($1, 'Late Arrival Alert', $2, 'attendance', $3, 'late_arrival')`,
    [row.mgr_user_id, `${row.emp_name} ${how} ${delay} today.`, employeeId]);
}
