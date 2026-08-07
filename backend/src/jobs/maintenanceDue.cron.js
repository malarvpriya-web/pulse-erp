import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

// Automation Opportunity Audit §26.3 — maintenance.routes.js's dashboard
// already computes "due within 7 days" (~line 602) and "overdue" (~line 623)
// off maintenance_schedules.next_due_date, surfaced only when someone opens
// the Maintenance page. This ports the same window into a daily push.
const REMINDER_DAYS = parseInt(process.env.MAINTENANCE_DUE_REMINDER_DAYS || '7', 10);

async function getDueSchedulesByCompany() {
  const { rows } = await pool.query(
    `SELECT s.id, s.company_id, s.maintenance_type, s.assigned_to, s.next_due_date::date AS next_due_date,
            (s.next_due_date::date - CURRENT_DATE) AS days_left,
            a.asset_code, a.name AS asset_name
     FROM maintenance_schedules s
     LEFT JOIN assets_register a ON a.id = s.asset_id
     WHERE (s.is_active IS NULL OR s.is_active = TRUE)
       AND s.next_due_date IS NOT NULL
       AND s.next_due_date::date <= CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY s.company_id, s.next_due_date ASC`,
    [REMINDER_DAYS]
  );
  const byCompany = new Map();
  for (const row of rows) {
    const key = row.company_id ?? 0;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(row);
  }
  return byCompany;
}

// maintenance_schedules.assigned_to is free text, not a resolvable user/
// employee id — included in the message body for context, but the actual
// recipients are whoever holds edit access on the `maintenance` permission
// module (role_permissions: super_admin/admin/store_keeper/
// production_manager/production_engineer/service_manager/service_engineer
// per the 20260719000001 seed).
async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'maintenance' AND rp.can_edit = true
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND COALESCE(e.company_id, u.company_id) = $1`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, sched) {
  const dup = await pool.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1 AND module_name = 'maintenance' AND reference_id = $2
       AND notification_type = 'maintenance_due' AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, sched.id]
  );
  if (dup.rows.length) return;

  const assetLabel = sched.asset_name ? `${sched.asset_name} (${sched.asset_code})` : `asset #${sched.id}`;
  const overdue = sched.days_left < 0;
  await notificationsRepository.create({
    user_id: userId,
    title: overdue
      ? `Maintenance Overdue: ${assetLabel}`
      : `Maintenance Due in ${sched.days_left} Day${sched.days_left === 1 ? '' : 's'}: ${assetLabel}`,
    message: overdue
      ? `${sched.maintenance_type || 'Scheduled'} maintenance for ${assetLabel} was due on ${sched.next_due_date} and is now overdue.${sched.assigned_to ? ` Assigned to: ${sched.assigned_to}.` : ''}`
      : `${sched.maintenance_type || 'Scheduled'} maintenance for ${assetLabel} is due on ${sched.next_due_date}.${sched.assigned_to ? ` Assigned to: ${sched.assigned_to}.` : ''}`,
    module_name: 'maintenance',
    reference_id: sched.id,
    notification_type: 'maintenance_due',
  });
}

async function runMaintenanceDueCheck() {
  const byCompany = await getDueSchedulesByCompany();
  if (!byCompany.size) return;

  for (const [companyId, schedules] of byCompany) {
    const receivers = await getReceivers(companyId);
    if (!receivers.length) continue;
    for (const sched of schedules) {
      for (const userId of receivers) {
        await insertReminder(userId, sched);
      }
    }
  }
}

export function startMaintenanceDueCron() {
  // Daily at 09:50 server local time (staggered with the other 09:xx crons)
  cron.schedule('50 9 * * *', () => {
    runMaintenanceDueCheck().catch((err) =>
      console.error('[maintenanceDueCron] failed:', err.message)
    );
  });
  console.log(`🛠️ Preventive maintenance due-alerts cron started (daily 09:50, window ${REMINDER_DAYS} days)`);
}

export { runMaintenanceDueCheck as runMaintenanceDueCheckNow };
