/**
 * attendanceReminders.cron.js — punch reminders and the managers' monthly
 * team summary (§278.3, owner 2026-11-19).
 *
 *  · FIELD employees only (owner, 2026-11-19) — office staff punch on the machine.
 *  · Punch-in reminder: N minutes before the employee's shift starts
 *    (Settings → Reminders, default 15), to anyone who has not punched yet.
 *  · Punch-out reminder: at shift end, to anyone who punched in and has not
 *    punched out (not for night shifts that end after midnight).
 *  · Monthly team summary: on the 1st at 09:00, each reporting manager gets
 *    last month's leaves, late arrivals (up to 15 / 15–30 / over 30 min),
 *    early exits and geo-fence results for their team.
 *
 * Nobody is reminded on a weekly off, a holiday or a day on approved leave.
 * Each reminder is sent once per employee per day (attendance_reminders_sent).
 * Notifications go through notificationsRepository.create(), so they also
 * reach the mobile app's push channel when that is set up.
 */
import cron from 'node-cron';
import pool from '../config/db.js';
import { scheduled } from './jobRun.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { getAttendanceSettingsRow } from '../shared/attendanceRules.js';
import { getWeekendDays, dayIsWeekend } from '../shared/weekend.js';
import { resolveEmployeeShift, parseTimeToMins } from '../shared/shiftResolve.js';
import { teamSql } from '../modules/attendance/attendance.authz.js';
import { teamMonthlySummary, summaryText } from '../shared/attendanceTeamSummary.js';

const hhmm = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

async function companiesWithEmployees() {
  const { rows } = await pool.query(`
    SELECT DISTINCT company_id FROM employees
     WHERE company_id IS NOT NULL AND deleted_at IS NULL AND LOWER(status) IN ('active','probation','notice')`)
    .catch(() => ({ rows: [] }));
  return rows.map((r) => r.company_id);
}

/** Send once: true when this (employee, day, kind) had not been sent before. */
async function claim(employeeId, day, kind) {
  const { rows } = await pool.query(`
    INSERT INTO attendance_reminders_sent (employee_id, reminder_date, kind) VALUES ($1, $2, $3)
    ON CONFLICT (employee_id, reminder_date, kind) DO NOTHING RETURNING id`, [employeeId, day, kind])
    .catch(() => ({ rows: [] }));
  return rows.length > 0;
}

/**
 * @param {Date} [now] — injectable for tests; companyIds limits the run (tests).
 * @returns {{ punch_in: number, punch_out: number }}
 */
export async function runPunchReminders(now = new Date(), { companyIds } = {}) {
  const out = { punch_in: 0, punch_out: 0 };
  const today = now.toLocaleDateString('en-CA');
  const nowMins = now.getHours() * 60 + now.getMinutes();

  for (const companyId of companyIds ?? await companiesWithEmployees()) {
    const s = await getAttendanceSettingsRow(companyId);
    const inOn = s?.punch_reminder_enabled !== false;
    const outOn = s?.punch_out_reminder_enabled !== false;
    if (!inOn && !outOn) continue;
    if (dayIsWeekend(today, await getWeekendDays(companyId))) continue;
    const { rows: hol } = await pool.query(
      `SELECT 1 FROM holidays WHERE date = $1::date AND (company_id = $2 OR company_id IS NULL) LIMIT 1`, [today, companyId])
      .catch(() => ({ rows: [] }));
    if (hol.length) continue;
    const before = Math.max(5, Number(s?.punch_reminder_minutes ?? 15));

    // FIELD staff only (owner, 2026-11-19: office staff come to the office and
    // punch on the machine, so they need no reminder). With a login, not on
    // approved leave today, with today's record if any.
    const { rows: people } = await pool.query(`
      SELECT e.id, e.is_field_employee, u.id AS user_id,
             ar.check_in_time::text AS cin, ar.check_out_time::text AS cout
        FROM employees e
        JOIN users u ON u.employee_id = e.id AND u.is_active = TRUE
        LEFT JOIN attendance_records ar ON ar.employee_id = e.id AND ar.attendance_date = $1::date AND ar.deleted_at IS NULL
       WHERE e.company_id = $2 AND e.deleted_at IS NULL AND LOWER(e.status) IN ('active','probation','notice')
         AND e.is_field_employee = TRUE
         AND NOT EXISTS (SELECT 1 FROM leave_applications la
                          WHERE la.employee_id = e.id AND LOWER(la.status) = 'approved'
                            AND $1::date BETWEEN la.start_date AND la.end_date)`, [today, companyId])
      .catch(() => ({ rows: [] }));

    for (const p of people) {
      const { shift } = await resolveEmployeeShift(p.id, today).catch(() => ({ shift: null }));
      const start = parseTimeToMins(shift?.start_time || s?.work_start_time || '09:00');
      const end = parseTimeToMins(shift?.end_time || s?.work_end_time || '18:00');
      if (start == null || end == null) continue;
      const where = p.is_field_employee ? 'from My Attendance (camera and location)' : 'on the punch machine';

      if (inOn && !p.cin && nowMins >= start - before && nowMins < start && await claim(p.id, today, 'punch_in')) {
        await notificationsRepository.create({
          user_id: p.user_id, title: 'Punch in reminder',
          message: `Your shift starts at ${hhmm(start)}. Please punch in ${where} when you arrive.`,
          module_name: 'attendance', reference_id: String(p.id), notification_type: 'attendance_reminder',
        }).catch(() => {});
        out.punch_in++;
      }
      const overnight = shift?.is_night_shift || end <= start;
      if (outOn && !overnight && p.cin && !p.cout && nowMins >= end && nowMins < end + 60
          && await claim(p.id, today, 'punch_out')) {
        await notificationsRepository.create({
          user_id: p.user_id, title: 'Punch out reminder',
          message: `Your shift ended at ${hhmm(end)}. Please punch out ${where} before you leave.`,
          module_name: 'attendance', reference_id: String(p.id), notification_type: 'attendance_reminder',
        }).catch(() => {});
        out.punch_out++;
      }
    }
  }
  return out;
}

/**
 * Last month's team summary to every reporting manager.
 * @returns {{ managers: number }}
 */
export async function runTeamSummaries(month, year, { companyIds } = {}) {
  const ref = new Date(); ref.setDate(1); ref.setMonth(ref.getMonth() - 1);
  const m = month ?? ref.getMonth() + 1;
  const y = year ?? ref.getFullYear();
  const label = new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  let managers = 0;
  for (const companyId of companyIds ?? await companiesWithEmployees()) {
    const s = await getAttendanceSettingsRow(companyId);
    if (s?.team_summary_enabled === false) continue;
    // Everyone who has a direct report (either source), with a login.
    const { rows: mgrs } = await pool.query(`
      SELECT DISTINCT mgr.id, u.id AS user_id
        FROM employees mgr
        JOIN users u ON u.employee_id = mgr.id AND u.is_active = TRUE
       WHERE mgr.company_id = $1 AND mgr.deleted_at IS NULL AND LOWER(mgr.status) IN ('active','probation','notice')
         AND (EXISTS (SELECT 1 FROM employees r WHERE r.reporting_manager_id = mgr.id AND r.id <> mgr.id AND r.deleted_at IS NULL)
              OR EXISTS (SELECT 1 FROM org_relationships o WHERE o.manager_id = mgr.id AND o.employee_id <> mgr.id))`, [companyId])
      .catch(() => ({ rows: [] }));
    for (const mgr of mgrs) {
      const { members } = await teamMonthlySummary({
        companyId, month: m, year: y,
        employeeWhere: ` AND e.id <> ${Number(mgr.id)} AND ${teamSql('e', mgr.id, { departmentHeads: false })}`,
      });
      if (!members.length) continue;
      await notificationsRepository.create({
        user_id: mgr.user_id, title: `Team attendance — ${label}`,
        message: summaryText(members, label),
        module_name: 'attendance', reference_id: `${y}-${String(m).padStart(2, '0')}`, notification_type: 'attendance_team_summary',
      }).catch(() => {});
      managers++;
    }
  }
  return { managers };
}

export function startAttendanceReminderCrons() {
  cron.schedule('*/5 * * * *', scheduled('attendancePunchReminders', () => runPunchReminders()), { timezone: 'Asia/Kolkata' });
  cron.schedule('0 9 1 * *', scheduled('attendanceTeamSummary', () => runTeamSummaries()), { timezone: 'Asia/Kolkata' });
  console.log('✅ Attendance reminders scheduled — punch in/out every 5 min, team summary 1st 09:00');
}
