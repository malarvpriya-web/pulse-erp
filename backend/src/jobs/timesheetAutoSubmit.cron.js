import cron from 'node-cron';
import pool from '../config/db.js';
import { runJob } from './jobRun.js';
import { todayIST } from '../modules/payroll/payroll.service.js';
import { autoSubmitWeek } from '../modules/timesheets/autoTimesheet.service.js';

/**
 * timesheetAutoSubmit — every Monday 10:00 IST (2026-11-11).
 *
 * Submits LAST week's timesheet for everyone on an active project who did not
 * submit it: their own drafts as they are, otherwise the week pre-filled from
 * attendance (see autoTimesheet.service.js). Submitted, approved and sent-back
 * weeks are left alone. The employee and their reporting manager are told.
 */
export function runTimesheetAutoSubmitNow({ today = todayIST() } = {}) {
  return runJob('timesheetAutoSubmit', async () => {
    const { rows: [w] } = await pool.query(
      `SELECT to_char(date_trunc('week', $1::date) - interval '7 days', 'YYYY-MM-DD') AS last_week`, [today]);
    const { rows } = await pool.query(
      `SELECT DISTINCT p.company_id FROM project_members pm JOIN projects p ON p.id = pm.project_id
        WHERE p.company_id IS NOT NULL AND p.deleted_at IS NULL AND p.status = 'active'`);
    const totals = { week: w.last_week, companies: 0, employees: 0, submitted: 0, prefilled: 0, skipped: 0, empty: 0, failed: 0 };
    for (const { company_id } of rows) {
      try {
        const r = await autoSubmitWeek(company_id, w.last_week);
        totals.companies++;
        for (const k of ['employees', 'submitted', 'prefilled', 'skipped', 'empty', 'failed']) totals[k] += r[k];
      } catch (e) {
        totals.failed++;
        console.error(`[job:timesheetAutoSubmit] company ${company_id}: ${e.message}`);
      }
    }
    return totals;
  });
}

export function startTimesheetAutoSubmitCron() {
  cron.schedule('0 10 * * 1', () => { runTimesheetAutoSubmitNow(); }, { timezone: 'Asia/Kolkata' });
  console.log('🗓️ Timesheet auto-submit cron started (Mondays 10:00 IST, last week)');
}
