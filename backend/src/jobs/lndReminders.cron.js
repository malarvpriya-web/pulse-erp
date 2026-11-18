/**
 * lndReminders.cron.js — the Learning Center's daily job (2026-11-18).
 *
 * Before this nothing ever ran: certificates past expiry stayed "Active", and
 * the reminder settings on L&D Settings were read by nothing. Daily 09:20 IST:
 *
 *   1. certificates past their expiry date → status 'expired'
 *   2. certificate expiring within cert_expiry_reminder_days → the holder
 *      (and their manager when manager notifications are on); expired → HR
 *   3. training starting in reminder_days_before days → every enrolled person
 *   4. mandatory refreshers overdue / due within 30 days → HR, and the employee
 *   5. learning paths past their due date → the employee (+ manager)
 *
 * Notifications are de-duplicated per user / type / record / day, and e-mail
 * follows only when the company allows it and SMTP is configured.
 */
import cron from 'node-cron';
import pool from '../config/db.js';
import { scheduled } from './jobRun.js';
import { getSettings, loginsFor, lndAdminLogins, notify, venueLine } from '../modules/hr/lnd/lndShared.js';
import { computeCompliance } from '../modules/hr/lnd/lndCompliance.js';
import { expireCertificates } from '../modules/hr/certifications.routes.js';

async function managerLogins(employeeIds) {
  if (!employeeIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT e.id AS employee_id, u.id AS user_id FROM employees e
       JOIN users u ON u.employee_id = e.reporting_manager_id AND u.is_active WHERE e.id = ANY($1::int[])`, [employeeIds]);
  return new Map(rows.map(r => [r.employee_id, r.user_id]));
}

export async function runLndRemindersNow() {
  const counters = { companies: 0, expired: 0, cert_reminders: 0, training_reminders: 0, refresher_alerts: 0, path_alerts: 0 };
  const { rows: companies } = await pool.query(`SELECT id FROM companies`);
  for (const { id: companyId } of companies) {
    counters.companies++;
    const s = await getSettings(companyId);
    const admins = await lndAdminLogins(companyId);

    // 1 + 2. certificates
    counters.expired += await expireCertificates(pool, companyId);
    const { rows: certs } = await pool.query(`
      SELECT ec.id, ec.employee_id, ec.status, ec.expiry_date::text AS expiry_date, c.name, (ec.expiry_date - CURRENT_DATE)::int AS days_left
        FROM employee_certifications ec JOIN certifications c ON c.id = ec.certification_id
        JOIN employees e ON e.id = ec.employee_id AND e.deleted_at IS NULL
       WHERE ec.company_id = $1 AND (
             (ec.status = 'active' AND ec.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::int)
          OR (ec.status = 'expired' AND ec.expiry_date = CURRENT_DATE - 1))`, [companyId, s.cert_expiry_reminder_days]);
    const certLogins = await loginsFor([...new Set(certs.map(c => c.employee_id))]);
    const mgr = s.enable_manager_notifications ? await managerLogins(certs.map(c => c.employee_id)) : new Map();
    for (const c of certs) {
      const own = certLogins.filter(l => l.employee_id === c.employee_id);
      const expired = c.status === 'expired';
      // Remind at the window start, 7 days out and on the last day — not every day.
      if (!expired && ![s.cert_expiry_reminder_days, 7, 1, 0].includes(c.days_left)) continue;
      counters.cert_reminders += await notify({
        userIds: [...own.map(l => l.user_id), mgr.get(c.employee_id), ...(expired ? admins : [])], type: expired ? 'lnd_cert_expired' : 'lnd_cert_expiring',
        referenceId: c.id, companyId,
        title: expired ? `Certificate expired: ${c.name}` : `Certificate expiring in ${c.days_left} day(s): ${c.name}`,
        message: expired ? `${c.name} expired on ${c.expiry_date}.` : `${c.name} expires on ${c.expiry_date}. Arrange the renewal with HR.`,
        email: expired ? null : { trigger: 'lnd_cert_expiry', to: own, data: { cert_name: c.name, expiry_date: c.expiry_date } },
      });
    }

    // 3. upcoming trainings
    if (s.reminder_days_before > 0) {
      const { rows: progs } = await pool.query(`
        SELECT p.* FROM training_programs p
         WHERE p.company_id = $1 AND p.deleted_at IS NULL AND p.status IN ('planned','ongoing')
           AND p.scheduled_date = CURRENT_DATE + $2::int`, [companyId, s.reminder_days_before]);
      for (const p of progs) {
        const { rows: en } = await pool.query(`SELECT employee_id FROM training_enrollments WHERE program_id = $1 AND status IN ('enrolled','in_progress')`, [p.id]);
        const logins = await loginsFor(en.map(r => r.employee_id));
        const date = String(p.scheduled_date).slice(0, 10);
        counters.training_reminders += await notify({
          userIds: logins.map(l => l.user_id), type: 'lnd_training_reminder', referenceId: p.id, companyId,
          title: `Reminder: ${p.title} on ${date}`, message: `${p.title} starts on ${date}${venueLine(p)}.`,
          email: { trigger: 'lnd_training_reminder', to: logins, data: { program_title: p.title, scheduled_date: date, venue_line: venueLine(p) } },
        });
      }
    }

    // 4. refreshers — HR gets one summary per series, the employee their own line (on Mondays, to stay quiet).
    const comp = await computeCompliance(pool, companyId, { dueSoonDays: 30 });
    for (const series of comp.series.filter(x => x.overdue || x.due_soon)) {
      counters.refresher_alerts += await notify({
        userIds: admins, type: 'lnd_refresher_due', referenceId: series.series_id, companyId,
        title: `Refresher due: ${series.title}`,
        message: `${series.overdue} overdue and ${series.due_soon} due within 30 days (${series.scheduled} already scheduled). Schedule the next round from Trainings.`,
      });
    }
    if (new Date().getDay() === 1) {
      const due = comp.rows.filter(r => r.status === 'overdue' || r.status === 'due_soon');
      const logins = await loginsFor([...new Set(due.map(r => r.employee_id))]);
      for (const r of due) {
        counters.refresher_alerts += await notify({
          userIds: logins.filter(l => l.employee_id === r.employee_id).map(l => l.user_id), type: 'lnd_refresher_due_me',
          referenceId: r.series_id, companyId,
          title: `Refresher ${r.status === 'overdue' ? 'overdue' : 'due soon'}: ${r.title}`,
          message: `Your ${r.title} was valid until ${r.valid_until}.${r.next_scheduled ? ` You are enrolled for ${r.next_scheduled}.` : ' HR will schedule the next round.'}`,
        });
      }
    }

    // 5. overdue learning paths (on Mondays)
    if (new Date().getDay() === 1) {
      const { rows: paths } = await pool.query(`
        SELECT elp.id, elp.employee_id, lp.name, elp.due_date::text AS due_date FROM employee_learning_paths elp
          JOIN learning_paths lp ON lp.id = elp.path_id
         WHERE elp.company_id = $1 AND elp.status = 'in_progress' AND elp.due_date < CURRENT_DATE`, [companyId]);
      const logins = await loginsFor([...new Set(paths.map(p => p.employee_id))]);
      const pm = s.enable_manager_notifications ? await managerLogins(paths.map(p => p.employee_id)) : new Map();
      for (const p of paths) {
        counters.path_alerts += await notify({
          userIds: [...logins.filter(l => l.employee_id === p.employee_id).map(l => l.user_id), pm.get(p.employee_id)],
          type: 'lnd_path_overdue', referenceId: p.id, companyId,
          title: `Learning path overdue: ${p.name}`, message: `${p.name} was due on ${p.due_date}.`,
        });
      }
    }
  }
  return counters;
}

export function startLndRemindersCron() {
  cron.schedule('20 9 * * *', scheduled('lndReminders', () => runLndRemindersNow()), { scheduled: true, timezone: 'Asia/Kolkata' });
  console.log('✅ L&D reminders cron scheduled — daily 09:20 IST');
}
