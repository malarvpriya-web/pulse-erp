import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { runJob } from './jobRun.js';
import { fetchPayrollSettings, todayIST, FINAL_STATUSES } from '../modules/payroll/payroll.service.js';
import { payCycleFor } from '../modules/payroll/payrollSettings.js';
import { statutoryDues } from '../modules/payroll/payrollCompliance.service.js';
import { getMonthName } from '../modules/payroll/payrollEngine.js';
import { emailMonthPayslips } from '../modules/payroll/payroll.controller.js';
import { isEmailConfigured } from '../utils/mailer.js';

/**
 * payrollReminders — every morning, per company (manual §262).
 *
 * Payroll had no scheduled job at all: a month was approved, paid and remitted
 * only if someone remembered. Each reminder fires on a few chosen days, never
 * every day, and once per person (deduplicated on the notifications table by
 * its title, which names the day):
 *
 *   attendance  the attendance cutoff day has come and the month's attendance is
 *               not synced to payroll (only while "Payroll uses attendance" is on);
 *               on the cutoff day and 3 / 1 / 0 days before the pay date
 *   approve     the month is not yet approved: 3 / 1 / 0 days before the pay date,
 *               and 1 / 3 / 7 days after it
 *   pay         approved but not marked paid: on the pay date and 1 / 3 / 7 days after
 *   dues        PF / ESI / PT / LWF / TDS of an approved month not yet paid:
 *               3 / 1 / 0 days before the due date, and 1 / 3 / 7 days after
 *
 * Who: approve and attendance go to holders of payroll edit or approve; pay and
 * dues to holders of payroll_payment approve — read from role_permissions, never
 * a fixed list of role names, and only users of that company.
 *
 * With "Email payslips once paid" on, payslips of runs paid in the last 7 days
 * that were never emailed are sent (PDF attached). A failed send is retried the
 * next morning until the 7 days pass.
 *
 * Switched off per company by the payroll setting `payroll_reminders`.
 */

const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const addMonths = (m, y, k) => { const t = y * 12 + (m - 1) + k; return [(t % 12) + 1, Math.floor(t / 12)]; };
const BEFORE = new Set([3, 1, 0]);
const AFTER = new Set([1, 3, 7]);
const KIND = { pf: 'PF', esi: 'ESI', pt: 'Professional tax', lwf: 'Labour welfare fund', tds: 'TDS' };

async function receivers(companyId, module, column) {
  const { rows } = await pool.query(`
    SELECT DISTINCT u.id FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.module = $2
      LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true AND COALESCE(e.company_id, u.company_id) = $1
       AND (CASE WHEN $3 = 'approve' THEN rp.can_approve ELSE (rp.can_edit OR rp.can_approve) END)`,
  [companyId, module, column]);
  return rows.map(r => r.id);
}

// Each title names its day ("due in 3 days", "2 days late"), so the same title
// for the same month is the same reminder: it is never sent twice.
async function notify(userIds, { type, ref, title, message }) {
  let sent = 0;
  for (const user_id of userIds) {
    const { rows } = await pool.query(`
      SELECT 1 FROM notifications WHERE user_id = $1 AND module_name = 'payroll' AND notification_type = $2
         AND reference_id = $3 AND title = $4 LIMIT 1`,
    [user_id, type, ref, title]);
    if (rows.length) continue;
    await notificationsRepository.create({ user_id, title, message, module_name: 'payroll', reference_id: ref, notification_type: type });
    sent++;
  }
  return sent;
}

async function monthState(companyId, m, y) {
  const { rows: [r] } = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE pr.status = 'pending')::int AS pending,
           COUNT(*) FILTER (WHERE pr.status = ANY($4::text[]))::int AS final,
           COUNT(*) FILTER (WHERE pr.status = 'paid')::int AS paid
      FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
     WHERE e.company_id = $1 AND pr.month = $2 AND pr.year = $3 AND pr.is_test = false`, [companyId, m, y, FINAL_STATUSES]);
  const { rows: [a] } = await pool.query(`
    SELECT COUNT(*)::int AS n FROM payroll_attendance_summary s JOIN employees e ON e.id = s.employee_id
     WHERE e.company_id = $1 AND s.month = $2 AND s.year = $3`, [companyId, m, y]);
  return { ...r, attendance_synced: a.n > 0 };
}

/** One company, one morning. Returns counters. */
export async function remindCompany(companyId, today) {
  const { settings } = await fetchPayrollSettings(companyId);
  const out = { notified: 0, payslips_emailed: 0 };
  const [cm, cy] = [parseInt(today.slice(5, 7)), parseInt(today.slice(0, 4))];
  const ref = (m, y) => y * 100 + m;

  if (settings.payroll_reminders !== false) {
    const runners = await receivers(companyId, 'payroll', 'edit');
    const payers = await receivers(companyId, 'payroll_payment', 'approve');

    // Wage months whose pay date is near: this month and the two before it.
    for (const k of [-2, -1, 0]) {
      const [m, y] = addMonths(cm, cy, k);
      const label = `${getMonthName(m)} ${y}`;
      const cycle = payCycleFor(settings, m, y, { today: new Date(`${today}T00:00:00Z`) });
      const toPay = days(today, cycle.pay_date);
      if (toPay > 31 || toPay < -7) continue;
      const st = await monthState(companyId, m, y);
      const allFinal = st.total > 0 && st.pending === 0;
      if (settings.require_attendance_sync !== false && !st.attendance_synced && st.final === 0 && today >= cycle.attendance_cutoff_date
          && (today === cycle.attendance_cutoff_date || BEFORE.has(toPay))) {
        out.notified += await notify(runners, { type: 'reminder_attendance', ref: ref(m, y),
          title: `Sync attendance for ${label}: ${BEFORE.has(toPay) ? `pay date ${toPay === 0 ? 'today' : `in ${toPay} day${toPay === 1 ? '' : 's'}`}` : 'cutoff day today'}`,
          message: `The attendance cutoff (${cycle.attendance_cutoff_date}) has passed and ${label} attendance is not synced to payroll. Sync it (Attendance → Payroll Sync), then generate payroll. Pay date: ${cycle.pay_date}.` });
      }
      if (!allFinal && (BEFORE.has(toPay) || AFTER.has(-toPay))) {
        const what = st.total === 0 ? 'has not been generated' : `has ${st.pending} draft${st.pending === 1 ? '' : 's'} awaiting approval`;
        out.notified += await notify(runners, { type: 'reminder_approve', ref: ref(m, y),
          title: toPay >= 0 ? `Payroll for ${label}: pay date ${toPay === 0 ? 'today' : `in ${toPay} day${toPay === 1 ? '' : 's'}`}` : `Payroll for ${label} is ${-toPay} day${toPay === -1 ? '' : 's'} late`,
          message: `${label} payroll ${what}. Salaries are due on ${cycle.pay_date} (Payroll Center → Payroll Processing).` });
      }
      if (st.final > st.paid && toPay <= 0 && (toPay === 0 || AFTER.has(-toPay))) {
        out.notified += await notify(payers, { type: 'reminder_pay', ref: ref(m, y),
          title: `${label} salaries not marked paid: pay date ${toPay === 0 ? 'today' : `${-toPay} day${toPay === -1 ? '' : 's'} ago`}`,
          message: `${st.final - st.paid} approved salar${st.final - st.paid === 1 ? 'y is' : 'ies are'} not marked paid; the pay date was ${cycle.pay_date}. Pay them and record the bank reference (Payroll Center → Payroll Processing).` });
      }
    }

    // Statutory dues of the last 12 approved months.
    const { rows: months } = await pool.query(`
      SELECT DISTINCT pr.month, pr.year FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
       WHERE e.company_id = $1 AND pr.is_test = false AND pr.status = ANY($2::text[])
         AND (pr.year * 12 + pr.month) >= $3 ORDER BY pr.year, pr.month`, [companyId, FINAL_STATUSES, cy * 12 + cm - 12]);
    for (const { month, year } of months) {
      const dues = await statutoryDues({ company_id: companyId, month, year });
      for (const i of dues.items) {
        if (!(i.amount > 0) || i.status === 'paid' || !i.due_date) continue;
        const left = days(today, i.due_date);
        if (!(BEFORE.has(left) || AFTER.has(-left))) continue;
        out.notified += await notify(payers, { type: `reminder_dues_${i.kind}`, ref: ref(month, year),
          title: left >= 0 ? `${KIND[i.kind]} for ${dues.period} due ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`}`
            : `${KIND[i.kind]} for ${dues.period} is ${-left} day${left === -1 ? '' : 's'} overdue`,
          message: `₹${Math.round(i.amount).toLocaleString('en-IN')} due by ${i.due_date} (${i.due_basis}). ${i.kind === 'tds' ? 'Record the deposit in Finance → TDS.' : 'Pay it and record the challan in Payroll Center → Tax & Statutory → Dues.'}` });
      }
    }
  }

  if (settings.email_payslips_on_payment === true && await isEmailConfigured(companyId)) {
    const { rows: paidMonths } = await pool.query(`
      SELECT DISTINCT pr.month, pr.year FROM payroll_runs pr JOIN employees e ON e.id = pr.employee_id
        LEFT JOIN payslip_email_log l ON l.employee_id = pr.employee_id AND l.month = pr.month AND l.year = pr.year
       WHERE e.company_id = $1 AND pr.is_test = false AND pr.status = 'paid'
         AND pr.paid_at >= ($2::date - 7) AND COALESCE(l.status, '') <> 'sent'`, [companyId, today]);
    for (const { month, year } of paidMonths) {
      // Approved-but-unpaid colleagues of the same month wait until they are paid.
      const r = await emailMonthPayslips({ company_id: companyId, month, year, onlyPaid: true });
      out.payslips_emailed += r.sent;
    }
  }
  return out;
}

export function runPayrollRemindersNow({ today = todayIST() } = {}) {
  return runJob('payrollReminders', async () => {
    const { rows } = await pool.query(`
      SELECT DISTINCT e.company_id FROM employees e
       WHERE e.company_id IS NOT NULL AND e.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM employee_salary_assignments a WHERE a.employee_id = e.id)`);
    const totals = { companies: 0, notified: 0, payslips_emailed: 0, failed: 0 };
    for (const { company_id } of rows) {
      try {
        const r = await remindCompany(company_id, today);
        totals.companies++; totals.notified += r.notified; totals.payslips_emailed += r.payslips_emailed;
      } catch (e) {
        totals.failed++;
        console.error(`[job:payrollReminders] company ${company_id}: ${e.message}`);
      }
    }
    return totals;
  });
}

export function startPayrollRemindersCron() {
  cron.schedule('20 9 * * *', () => { runPayrollRemindersNow(); }, { timezone: 'Asia/Kolkata' });
  console.log('💰 Payroll reminder cron started (daily 09:20 IST)');
}
