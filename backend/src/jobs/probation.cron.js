/**
 * Probation Cron Job
 * ──────────────────────────────────────────────────────────────────────────────
 * Runs daily at 09:00.
 *
 * Rule: Every new employee starts on Probation. The probation period is 6 months
 * (180 days) from joining_date.
 *
 * This job does two things:
 *  1. WARNING  — 15 days before the end of probation (day 165 from joining):
 *               Notify the reporting manager AND all super_admin users so they
 *               can decide to confirm or extend.
 *
 *  2. REMINDER — On the last day of probation (day 180 from joining):
 *               Send a final reminder to manager + super_admin that probation
 *               has ended and the employee's status needs a decision.
 *
 * Notification deduplication: a "probation_warning" or "probation_due" notif
 * is only created once per employee (checked via reference_id + module_name +
 * notification_type in the notifications table).
 */

import cron from 'node-cron';
import pool from '../modules/shared/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

// ── helpers ───────────────────────────────────────────────────────────────────

async function getSuperAdminIds() {
  const res = await pool.query(
    `SELECT id, name FROM users WHERE role = 'super_admin' AND is_active = true`
  );
  return res.rows;
}

async function getManagerUserId(managerName) {
  if (!managerName) return null;
  const res = await pool.query(
    `SELECT id FROM users
     WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND is_active = true
     LIMIT 1`,
    [managerName]
  );
  return res.rows[0]?.id || null;
}

async function alreadyNotified(employeeId, notifType) {
  const res = await pool.query(
    `SELECT id FROM notifications
     WHERE reference_id = $1
       AND module_name  = 'probation'
       AND notification_type = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [employeeId, notifType]
  );
  return res.rowCount > 0;
}

async function createForRecipients(recipientIds, payload) {
  for (const userId of recipientIds) {
    if (!userId) continue;
    await notificationsRepository.create({ ...payload, user_id: userId });
  }
}

// ── core logic ────────────────────────────────────────────────────────────────

async function runProbationCheck() {
  console.log(`[Probation Cron] Running at ${new Date().toISOString()}`);

  try {
    // ── 1. 15-day warning (day 165 since joining) ──────────────────────────
    const warningRes = await pool.query(`
      SELECT id, first_name, last_name, joining_date, reporting_manager, office_id
      FROM employees
      WHERE LOWER(status) = 'probation'
        AND joining_date IS NOT NULL
        AND CURRENT_DATE = (joining_date::date + INTERVAL '165 days')::date
    `);

    for (const emp of warningRes.rows) {
      const notifType = 'probation_warning';
      if (await alreadyNotified(emp.id, notifType)) continue;

      const name     = `${emp.first_name} ${emp.last_name}`.trim();
      const dueDate  = new Date(new Date(emp.joining_date).getTime() + 180 * 86400000)
                         .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

      const payload = {
        title           : `Probation Ending Soon — ${name}`,
        message         : `${name} (${emp.office_id || 'N/A'}) has 15 days left on probation. Review and confirm / extend before ${dueDate}.`,
        module_name     : 'probation',
        reference_id    : emp.id,
        notification_type: notifType,
      };

      const superAdmins   = await getSuperAdminIds();
      const managerUserId = await getManagerUserId(emp.reporting_manager);
      const recipients    = [...superAdmins.map(u => u.id), managerUserId];

      await createForRecipients(recipients, payload);
      console.log(`[Probation Cron] ⚠️  Warning sent for employee #${emp.id} (${name})`);
    }

    // ── 2. Probation-due reminder (day 180 since joining) ─────────────────
    const dueRes = await pool.query(`
      SELECT id, first_name, last_name, joining_date, reporting_manager, office_id
      FROM employees
      WHERE LOWER(status) = 'probation'
        AND joining_date IS NOT NULL
        AND CURRENT_DATE = (joining_date::date + INTERVAL '180 days')::date
    `);

    for (const emp of dueRes.rows) {
      const notifType = 'probation_due';
      if (await alreadyNotified(emp.id, notifType)) continue;

      const name = `${emp.first_name} ${emp.last_name}`.trim();

      const payload = {
        title           : `Probation Period Ended — ${name}`,
        message         : `${name} (${emp.office_id || 'N/A'}) has completed 6 months. Please update their employment status (Confirm / Extend / Terminate).`,
        module_name     : 'probation',
        reference_id    : emp.id,
        notification_type: notifType,
      };

      const superAdmins   = await getSuperAdminIds();
      const managerUserId = await getManagerUserId(emp.reporting_manager);
      const recipients    = [...superAdmins.map(u => u.id), managerUserId];

      await createForRecipients(recipients, payload);
      console.log(`[Probation Cron] 🔔  Due-reminder sent for employee #${emp.id} (${name})`);
    }

    const totalWarnings = warningRes.rowCount;
    const totalDue      = dueRes.rowCount;
    console.log(`[Probation Cron] Done — ${totalWarnings} warning(s), ${totalDue} due-reminder(s).`);

  } catch (err) {
    console.error('[Probation Cron] Error:', err.message);
  }
}

// ── schedule ──────────────────────────────────────────────────────────────────

export function startProbationCron() {
  // Run daily at 09:00 server time
  cron.schedule('0 9 * * *', runProbationCheck, {
    scheduled : true,
    timezone  : 'Asia/Kolkata',
  });
  console.log('✅ Probation cron scheduled — runs daily at 09:00 IST');
}

// Allow manual trigger via: node -e "import('./src/jobs/probation.cron.js').then(m => m.runProbationCheckNow())"
export { runProbationCheck as runProbationCheckNow };
