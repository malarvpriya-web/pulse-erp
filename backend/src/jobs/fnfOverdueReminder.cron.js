/**
 * F&F overdue reminder (§276). Daily 10:00 IST.
 *
 * Final wages are due within 2 working days of the last working day (Code on
 * Wages s.17(2); the figure is the settlement.wage_payment rule) and gratuity
 * within 30 days. Nothing told anyone when a leaver's settlement went past
 * that. For every open exit whose last working day has passed and whose F&F
 * is not paid, once the wage due date (modules/hr/fnfDue.js) is past, this
 * notifies the people who can act: holders of payroll:approve or
 * payroll_payment:approve (Finance) and hr:edit (HR) in the company.
 *
 * One notification per exit per person per day (deduplicated on
 * notification_type + reference_id + today). Never throws.
 * `today` and `onlyEmployeeIds` are for tests.
 */
import cron from 'node-cron';
import pool from '../modules/shared/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { fnfDueDates, daysLate } from '../modules/hr/fnfDue.js';
import { localTodayIso } from '../shared/workforcePolicy.js';

export const FNF_OVERDUE_TYPE = 'fnf_overdue';

const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });

/** Finance and HR logins of a company who can act on a settlement. Runtime company = user_scope. */
async function recipients(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE u.is_active = true
        AND ((rp.module IN ('payroll', 'payroll_payment') AND rp.can_approve) OR (rp.module = 'hr' AND rp.can_edit))
        AND (u.company_id = $1
             OR EXISTS (SELECT 1 FROM user_scope s WHERE s.user_id = u.id AND s.company_id = $1)
             OR EXISTS (SELECT 1 FROM employees e WHERE e.id = u.employee_id AND e.company_id = $1))`, [companyId]);
  return rows.map((r) => r.id);
}

export async function runFnfOverdueReminder({ today = localTodayIso(), onlyEmployeeIds = null } = {}) {
  const { rows: due } = await pool.query(
    `SELECT er.id, er.employee_id, er.fnf_status, er.net_payable, e.company_id, e.zone_id,
            COALESCE(e.name, e.first_name || ' ' || e.last_name) AS name, e.office_id,
            to_char(er.last_working_date, 'YYYY-MM-DD') AS lwd
       FROM exit_requests er JOIN employees e ON e.id = er.employee_id AND e.deleted_at IS NULL
      WHERE er.status NOT IN ('closed', 'paid', 'cancelled', 'rejected')
        AND COALESCE(er.fnf_status, 'draft') <> 'paid'
        AND er.last_working_date IS NOT NULL AND er.last_working_date < $1::date
        AND ($2::int[] IS NULL OR er.employee_id = ANY($2::int[]))`, [today, onlyEmployeeIds]);

  let sent = 0;
  const byCompany = new Map();
  for (const x of due) {
    try {
      const d = await fnfDueDates(pool, { companyId: x.company_id, lwd: x.lwd, zoneId: x.zone_id });
      const late = daysLate(d.wages_due, today);
      if (late === 0) continue;
      if (!byCompany.has(x.company_id)) byCompany.set(x.company_id, await recipients(x.company_id));
      const stage = x.fnf_status === 'approved' ? 'approved, payment not recorded'
        : x.net_payable == null ? 'not yet calculated' : 'calculated, not approved';
      const title = `F&F overdue: ${x.name}`;
      const message = `${x.name}${x.office_id ? ` (${x.office_id})` : ''} left on ${fmt(x.lwd)}. Final wages were due by ${fmt(d.wages_due)} `
        + `(${d.working_days} working days) and are ${late} day${late === 1 ? '' : 's'} late. Settlement: ${stage}.`
        + (today > d.gratuity_due ? ` Gratuity was due by ${fmt(d.gratuity_due)}.` : ` Any gratuity is due by ${fmt(d.gratuity_due)}.`)
        + ' Open Exit Management → F&F Calculator.';
      for (const userId of byCompany.get(x.company_id)) {
        const { rows: dup } = await pool.query(
          // Sent today already? "Today" is the day of sending, not the evaluation date a
          // test may pass. created_at has no time zone and is written in the business zone.
          `SELECT 1 FROM notifications WHERE user_id = $1 AND notification_type = $2 AND reference_id = $3
              AND created_at::date = CURRENT_DATE LIMIT 1`,
          [userId, FNF_OVERDUE_TYPE, x.id]);
        if (dup.length) continue;
        await notificationsRepository.create({
          user_id: userId, title, message, module_name: 'hr', reference_id: x.id,
          notification_type: FNF_OVERDUE_TYPE, company_id: x.company_id,
        });
        sent += 1;
      }
    } catch (err) {
      console.error(`[F&F Overdue] exit #${x.id} failed:`, err.message);
    }
  }
  if (sent) console.log(`[F&F Overdue] ${sent} reminder(s) sent for ${due.length} unpaid exit(s).`);
  return { checked: due.length, sent };
}

export function startFnfOverdueReminderCron() {
  cron.schedule('0 10 * * *', () => {
    runFnfOverdueReminder().catch((err) => console.error('[F&F Overdue] failed:', err.message));
  }, { scheduled: true, timezone: 'Asia/Kolkata' });
  console.log('⏰ F&F overdue reminder cron scheduled — runs daily at 10:00 IST');
}
