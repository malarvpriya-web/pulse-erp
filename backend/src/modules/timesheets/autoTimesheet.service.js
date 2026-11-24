/**
 * autoTimesheet.service.js — the timesheet that fills itself (2026-11-11).
 *
 * The owner kept My Timesheet for project tracking but asked for it to be
 * simple or automated. Before this, an employee typed hours into a project ×
 * day grid by hand, had a second "Clock In" that duplicated attendance, and
 * nothing happened unless they remembered to submit. Now:
 *
 *   1. A week is PRE-FILLED. Each day's hours come from what attendance already
 *      knows (in order):
 *        punch      attendance_records hours that day (total_hours, else
 *                   check-out − check-in), rounded to ¼ h, capped at 16
 *        holiday    a company holiday                          → 0
 *        leave      approved leave (half day → half the day)   → 0 / half
 *        weekend    the company's weekend days                 → 0
 *        absent     attendance marked absent                   → 0
 *        standard   a working day with no punch                → the configured
 *                   full day (attendance settings, else 8 h)
 *      A punch always wins: a person who came in on a holiday worked it.
 *   2. The day is SPLIT across the employee's projects (project_members, active
 *      projects, membership dates covering the day) by allocation_pct, in ¼ h.
 *      One project → the whole day goes there.
 *   3. The employee may change any figure, then submits the week in one step.
 *   4. Monday morning, autoSubmitWeek() submits LAST week for everyone on a
 *      project who did not: their own drafts as they are, else the pre-fill.
 *      A week already submitted or approved is never touched.
 *
 * Approval is unchanged: submitted entries go to the reporting manager or the
 * project manager (POST /timesheets/approve), and approved hours drive the
 * project labour cost as before.
 *
 * All dates are 'YYYY-MM-DD' strings handled in SQL — never `new Date('Y-M-D')`,
 * which is UTC midnight and a day behind IST before 05:30.
 */
import pool from '../shared/db.js';
import { getShiftRule } from '../../shared/attendanceRules.js';
import { getWeekendDays, dayIsWeekend } from '../../shared/weekend.js';
import { isExitedSql } from '../../shared/employeeStatus.js';
import notificationsRepository from '../notifications/repositories/notifications.repository.js';
import { todayIST } from '../payroll/payroll.service.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAY_HOURS = 24;
const MAX_PUNCH_HOURS = 16;
const quarter = (h) => Math.round(Number(h) * 4) / 4;

export class TimesheetError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/** Monday of the week containing `date` ('YYYY-MM-DD'), and that Sunday. */
export async function weekOf(date, db = pool) {
  if (!DATE.test(String(date || ''))) throw new TimesheetError(400, 'week_start must be a date (YYYY-MM-DD)', 'BAD_WEEK');
  const { rows: [w] } = await db.query(
    `SELECT to_char(date_trunc('week', $1::date), 'YYYY-MM-DD') AS week_start,
            to_char(date_trunc('week', $1::date) + interval '6 days', 'YYYY-MM-DD') AS week_end`, [date]);
  return w;
}

// Weekend days (incl. 2nd/4th-Saturday offs) come from shared/weekend.js.

/** Projects the employee may book to during [from, to]. */
export async function projectsFor(employeeId, companyId, from, to, db = pool) {
  const { rows } = await db.query(
    `SELECT p.id, p.project_name, p.project_code,
            COALESCE(pm.allocation_pct, 0)::float AS allocation_pct,
            COALESCE(pm.is_billable, true) AS is_billable,
            to_char(pm.start_date, 'YYYY-MM-DD') AS member_from,
            to_char(pm.end_date, 'YYYY-MM-DD') AS member_to
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
      WHERE pm.employee_id = $1
        AND p.deleted_at IS NULL
        AND p.status = 'active'          -- the rule My Timesheet always used
        AND ($2::int IS NULL OR p.company_id = $2)
        AND (pm.start_date IS NULL OR pm.start_date <= $4::date)
        AND (pm.end_date IS NULL OR pm.end_date >= $3::date)
      ORDER BY pm.allocation_pct DESC NULLS LAST, p.project_name`,
    [employeeId, companyId ?? null, from, to]);
  // One row per project even if someone was added twice.
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

/** What attendance, leave and holidays say about each day of [from, to]. */
async function dayFacts(employeeId, companyId, from, to, db) {
  const { rows } = await db.query(
    `WITH days AS (
       SELECT d::date AS day FROM generate_series($3::date, $4::date, interval '1 day') d
     )
     SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
            trim(to_char(days.day, 'day')) AS weekday,
            a.status AS att_status,
            COALESCE(NULLIF(a.total_hours, 0),
                     CASE WHEN a.check_in_time IS NOT NULL AND a.check_out_time IS NOT NULL
                               AND a.check_out_time > a.check_in_time
                          THEN EXTRACT(EPOCH FROM (a.check_out_time - a.check_in_time)) / 3600 END)::float AS punched,
            h.name AS holiday,
            (l.found IS NOT NULL) AS on_leave,
            COALESCE(l.half_day, false) AS leave_half
       FROM days
       LEFT JOIN LATERAL (
         SELECT status, total_hours, check_in_time, check_out_time FROM attendance_records
          WHERE employee_id = $1 AND attendance_date = days.day AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 1) a ON true
       LEFT JOIN LATERAL (
         SELECT name FROM holidays
          WHERE date = days.day AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
            AND (zone_id IS NULL OR zone_id = (SELECT zone_id FROM employees WHERE id = $1))
          LIMIT 1) h ON true
       LEFT JOIN LATERAL (
         SELECT 1 AS found, half_day FROM leave_applications
          WHERE employee_id = $1 AND status = 'approved' AND deleted_at IS NULL
            AND days.day BETWEEN start_date AND end_date
          ORDER BY half_day ASC NULLS FIRST LIMIT 1) l ON true
      ORDER BY days.day`,
    [employeeId, companyId ?? null, from, to]);
  return rows;
}

/** Hours for one day and why (see the header). */
function hoursFor(f, weekend, fullDay) {
  if (f.punched != null && f.punched > 0) {
    return { hours: Math.min(MAX_PUNCH_HOURS, quarter(f.punched)), source: 'punch' };
  }
  if (f.holiday) return { hours: 0, source: 'holiday', note: f.holiday };
  if (f.on_leave && f.leave_half) return { hours: quarter(fullDay / 2), source: 'half_leave' };
  if (f.on_leave) return { hours: 0, source: 'leave' };
  if (dayIsWeekend(f.date, weekend)) return { hours: 0, source: 'weekend' };
  if (/absent/i.test(f.att_status || '')) return { hours: 0, source: 'absent' };
  return { hours: quarter(fullDay), source: 'standard' };
}

/** Split `hours` over projects by allocation, in ¼ h; the remainder goes to the largest share. */
export function splitHours(hours, projects) {
  const out = {};
  if (!projects.length || !(hours > 0)) return out;
  const weights = projects.map(p => (p.allocation_pct > 0 ? p.allocation_pct : 1));
  const total = weights.reduce((s, w) => s + w, 0);
  let given = 0;
  projects.forEach((p, i) => {
    const share = Math.floor(((hours * weights[i]) / total) * 4) / 4;
    out[p.id] = share; given += share;
  });
  const rest = quarter(hours - given);
  if (rest > 0) {
    const top = projects[weights.indexOf(Math.max(...weights))];
    out[top.id] = quarter(out[top.id] + rest);
  }
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}

/** The pre-filled week: one row per day with its hours, source and project split. */
export async function suggestWeek(employeeId, companyId, weekStart, db = pool) {
  const w = await weekOf(weekStart, db);
  const [projects, facts, rule, weekend] = await Promise.all([
    projectsFor(employeeId, companyId, w.week_start, w.week_end, db),
    dayFacts(employeeId, companyId, w.week_start, w.week_end, db),
    getShiftRule(companyId, db),
    getWeekendDays(companyId),
  ]);
  const today = todayIST();
  const days = facts.map(f => {
    // A day that has not happened yet has no hours to book (seen live: a
    // Wednesday showed Thursday and Friday pre-filled with a standard day).
    const h = f.date > today ? { hours: 0, source: 'future' } : hoursFor(f, weekend, rule.workHours);
    // A project counts on a day only inside its membership dates.
    const onDay = projects.filter(p => (!p.member_from || p.member_from <= f.date) && (!p.member_to || p.member_to >= f.date));
    return { date: f.date, weekday: f.weekday, ...h, split: splitHours(h.hours, onDay) };
  });
  return { ...w, projects, days, full_day_hours: rule.workHours };
}

async function weekEntries(employeeId, companyId, w, db) {
  const { rows } = await db.query(
    `SELECT id, to_char(work_date, 'YYYY-MM-DD') AS work_date, project_id, hours_worked::float AS hours_worked,
            status, rejection_reason, description
       FROM timesheet_entries
      WHERE employee_id = $1 AND deleted_at IS NULL
        AND work_date BETWEEN $3::date AND $4::date
        AND ($2::int IS NULL OR company_id = $2)
      ORDER BY work_date, project_id`,
    [employeeId, companyId ?? null, w.week_start, w.week_end]);
  return rows;
}

export function weekStatus(entries) {
  if (!entries.length) return { status: 'not_started' };
  const s = new Set(entries.map(e => e.status));
  if (s.has('rejected')) {
    return { status: 'rejected', rejection_reason: entries.find(e => e.status === 'rejected')?.rejection_reason || null };
  }
  if (s.has('submitted')) return { status: 'submitted' };
  if ([...s].every(x => x === 'approved')) return { status: 'approved' };
  if (s.has('approved')) return { status: 'part_approved' };
  return { status: 'draft' };
}

/** GET my week: pre-fill + whatever is already saved, and the week's status. */
export async function getWeek(employeeId, companyId, weekStart, db = pool) {
  const sug = await suggestWeek(employeeId, companyId, weekStart, db);
  const entries = await weekEntries(employeeId, companyId, sug, db);
  const { rows: [next] } = await db.query(
    `SELECT to_char($1::date + interval '7 days', 'YYYY-MM-DD') AS d`, [sug.week_start]);
  return { ...sug, entries, ...weekStatus(entries), auto_submit_on: next.d };
}

/**
 * Replace the employee's open (draft / rejected) entries for the week with
 * `rows` = [{ work_date, project_id, hours, description? }], optionally
 * submitting them. Refused once any entry of the week is submitted or approved.
 */
export async function saveWeek(employeeId, companyId, weekStart, rows, { submit = false, auto = false } = {}, db = pool) {
  const w = await weekOf(weekStart, db);
  if (!Array.isArray(rows)) throw new TimesheetError(400, 'rows must be a list', 'BAD_ROWS');
  if (rows.length > 7 * 20) throw new TimesheetError(400, 'Too many rows for one week', 'BAD_ROWS');
  const projects = await projectsFor(employeeId, companyId, w.week_start, w.week_end, db);
  const byId = new Map(projects.map(p => [Number(p.id), p]));
  const perDay = {};
  const clean = [];
  const today = todayIST();
  for (const r of rows) {
    const date = String(r?.work_date || '');
    const pid = Number(r?.project_id);
    const hours = quarter(r?.hours);
    if (!DATE.test(date) || date < w.week_start || date > w.week_end) {
      throw new TimesheetError(400, `${date || 'A date'} is not in the week of ${w.week_start}`, 'BAD_DATE');
    }
    if (!Number.isFinite(hours) || hours < 0) throw new TimesheetError(400, 'Hours must be zero or more', 'BAD_HOURS');
    if (hours === 0) continue;
    if (date > today) throw new TimesheetError(400, `${date} has not happened yet`, 'FUTURE_DATE');
    const p = byId.get(pid);
    if (!p) throw new TimesheetError(403, 'You can book time only to projects you are on', 'NOT_ON_PROJECT');
    if ((p.member_from && p.member_from > date) || (p.member_to && p.member_to < date)) {
      throw new TimesheetError(400, `You were not on ${p.project_name} on ${date}`, 'OUTSIDE_MEMBERSHIP');
    }
    perDay[date] = (perDay[date] || 0) + hours;
    if (perDay[date] > MAX_DAY_HOURS) throw new TimesheetError(400, `More than ${MAX_DAY_HOURS} hours on ${date}`, 'DAY_TOO_LONG');
    clean.push({ date, pid, hours, billable: p.is_billable, description: r.description ? String(r.description).slice(0, 500) : null });
  }
  if (submit && !clean.length) throw new TimesheetError(400, 'There are no hours to submit for this week', 'EMPTY_WEEK');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: locked } = await client.query(
      `SELECT id, status FROM timesheet_entries
        WHERE employee_id = $1 AND deleted_at IS NULL AND work_date BETWEEN $3::date AND $4::date
          AND ($2::int IS NULL OR company_id = $2)
        FOR UPDATE`, [employeeId, companyId ?? null, w.week_start, w.week_end]);
    if (locked.some(e => e.status === 'submitted' || e.status === 'approved')) {
      throw new TimesheetError(409, 'This week is already submitted. Ask your manager to send it back to change it.', 'WEEK_LOCKED');
    }
    await client.query(
      `UPDATE timesheet_entries SET deleted_at = NOW() WHERE id = ANY($1::int[])`, [locked.map(e => e.id)]);
    const status = submit ? 'submitted' : 'draft';
    const defaultNote = auto ? 'Submitted automatically from attendance' : 'From My Timesheet';
    for (const c of clean) {
      await client.query(
        `INSERT INTO timesheet_entries
           (employee_id, project_id, work_date, entry_date, hours_worked, description, is_billable, status, submitted_at, company_id)
         VALUES ($1, $2, $3::date, $3::date, $4, $5, $6, $7, $8, $9)`,
        [employeeId, c.pid, c.date, c.hours, c.description || defaultNote, c.billable, status,
         submit ? new Date() : null, companyId ?? null]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return getWeek(employeeId, companyId, w.week_start, db);
}

/** Is this employee on any bookable project right now (drives the menu row)? */
export async function onAProject(employeeId, companyId, today, db = pool) {
  if (employeeId == null) return false;
  const w = await weekOf(today, db);
  return (await projectsFor(employeeId, companyId, w.week_start, w.week_end, db)).length > 0;
}

async function userIdOf(employeeId, db) {
  const { rows } = await db.query(
    `SELECT id FROM users WHERE employee_id = $1 AND is_active = true ORDER BY id LIMIT 1`, [employeeId]);
  return rows[0]?.id ?? null;
}

async function notify(employeeId, title, message, db) {
  const uid = employeeId == null ? null : await userIdOf(employeeId, db);
  if (!uid) return false;
  await notificationsRepository.create({
    user_id: uid, title, message, module_name: 'timesheets', reference_id: null, notification_type: 'info',
  }).catch(() => null);
  return true;
}

/**
 * Submit the week of `weekStart` for everyone in `companyId` who is on a
 * project and has not submitted it. Own drafts are submitted as they are;
 * with no entries, the pre-fill is. Returns counts, never content.
 */
export async function autoSubmitWeek(companyId, weekStart, db = pool) {
  const w = await weekOf(weekStart, db);
  const { rows: people } = await db.query(
    `SELECT DISTINCT e.id, e.reporting_manager_id
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       JOIN employees e ON e.id = pm.employee_id
      WHERE p.company_id = $1 AND e.company_id = $1
        AND e.deleted_at IS NULL AND NOT (${isExitedSql('e.status')})
        AND (pm.start_date IS NULL OR pm.start_date <= $3::date)
        AND (pm.end_date IS NULL OR pm.end_date >= $2::date)`,
    [companyId, w.week_start, w.week_end]);
  const out = { employees: people.length, submitted: 0, prefilled: 0, skipped: 0, empty: 0, failed: 0 };
  for (const person of people) {
    try {
      const entries = await weekEntries(person.id, companyId, w, db);
      const st = weekStatus(entries).status;
      if (['submitted', 'approved', 'part_approved'].includes(st)) { out.skipped++; continue; }
      let rows;
      if (entries.length && st === 'draft') {
        // Only drafts booked to a project: a draft with none can't be approved
        // against anything, and saveWeek would refuse the whole week for it.
        rows = entries.filter(e => e.project_id)
          .map(e => ({ work_date: e.work_date, project_id: e.project_id, hours: e.hours_worked, description: e.description }));
      } else if (st === 'rejected') {
        out.skipped++; continue;                      // sent back: the employee must correct it
      } else {
        const sug = await suggestWeek(person.id, companyId, w.week_start, db);
        rows = sug.days.flatMap(d => Object.entries(d.split).map(([pid, h]) => ({ work_date: d.date, project_id: Number(pid), hours: h })));
        out.prefilled++;
      }
      if (!rows.filter(r => r.hours > 0 && r.project_id).length) { out.empty++; continue; }
      await saveWeek(person.id, companyId, w.week_start, rows, { submit: true, auto: true }, db);
      out.submitted++;
      await notify(person.id, `Timesheet submitted — week of ${w.week_start}`,
        `Your timesheet for the week of ${w.week_start} was submitted automatically from your attendance. Open My Timesheet to review it.`, db);
      await notify(person.reporting_manager_id, `Timesheet to approve — week of ${w.week_start}`,
        `A timesheet for the week of ${w.week_start} is waiting for your approval in the Approval Center.`, db);
    } catch (e) {
      out.failed++;
      console.error(`[job:timesheetAutoSubmit] company ${companyId} employee ${person.id}: ${e.message}`);
    }
  }
  return out;
}
