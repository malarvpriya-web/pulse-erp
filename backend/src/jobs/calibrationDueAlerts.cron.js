import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

// Automation Opportunity Audit §16.2 — GET /calibration/due-alerts
// (quality.routes.js) already computes exactly this list, gated by
// quality_settings.calibration_alert_days, but it's a pull-only dashboard
// query. This ports the same predicate into a daily push, reading the
// per-company alert-window setting the live GET endpoint itself doesn't
// actually read (it hardcodes a `days=30` query-param default instead) —
// the cron honours the setting's actual purpose.
const DEFAULT_ALERT_DAYS = 30;

async function getDueEquipmentByCompany() {
  const { rows } = await pool.query(
    `SELECT e.id, e.company_id, e.equipment_id, e.name, e.next_calibration_date::date AS next_calibration_date,
            (e.next_calibration_date::date - CURRENT_DATE) AS days_left,
            COALESCE(qs.calibration_alert_days, $1) AS alert_days
     FROM calibration_equipment e
     LEFT JOIN quality_settings qs ON qs.company_id = e.company_id
     WHERE e.deleted_at IS NULL
       AND e.status = 'active'
       AND e.next_calibration_date IS NOT NULL
       AND e.next_calibration_date::date <= CURRENT_DATE + (COALESCE(qs.calibration_alert_days, $1) * INTERVAL '1 day')
     ORDER BY e.company_id, e.next_calibration_date ASC`,
    [DEFAULT_ALERT_DAYS]
  );
  const byCompany = new Map();
  for (const row of rows) {
    if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, []);
    byCompany.get(row.company_id).push(row);
  }
  return byCompany;
}

// QC's own permission grants (role_permissions, module='quality', can_edit) —
// super_admin/admin/production_manager/qc_manager/qc_engineer as seeded by
// 20260719000001_seed_role_permission_gaps.js.
async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'quality' AND rp.can_edit = true
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND COALESCE(e.company_id, u.company_id) = $1`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, equipment) {
  const dup = await pool.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1 AND module_name = 'quality' AND reference_id = $2
       AND notification_type = 'calibration_due' AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, equipment.id]
  );
  if (dup.rows.length) return;

  const overdue = equipment.days_left < 0;
  await notificationsRepository.create({
    user_id: userId,
    title: overdue
      ? `Calibration Overdue: ${equipment.name}`
      : `Calibration Due in ${equipment.days_left} Day${equipment.days_left === 1 ? '' : 's'}: ${equipment.name}`,
    message: overdue
      ? `${equipment.name} (${equipment.equipment_id}) was due for calibration on ${equipment.next_calibration_date} and is now overdue.`
      : `${equipment.name} (${equipment.equipment_id}) is due for calibration on ${equipment.next_calibration_date}.`,
    module_name: 'quality',
    reference_id: equipment.id,
    notification_type: 'calibration_due',
  });
}

async function runCalibrationDueAlerts() {
  const byCompany = await getDueEquipmentByCompany();
  if (!byCompany.size) return;

  for (const [companyId, items] of byCompany) {
    const receivers = await getReceivers(companyId);
    if (!receivers.length) continue;
    for (const item of items) {
      for (const userId of receivers) {
        await insertReminder(userId, item);
      }
    }
  }
}

export function startCalibrationDueAlertsCron() {
  // Daily at 09:25 server local time (staggered with the other 09:xx crons)
  cron.schedule('25 9 * * *', () => {
    runCalibrationDueAlerts().catch((err) =>
      console.error('[calibrationDueAlertsCron] failed:', err.message)
    );
  });
  console.log('🔬 Calibration due-alerts cron started (daily 09:25, window from quality_settings.calibration_alert_days)');
}

export { runCalibrationDueAlerts as runCalibrationDueAlertsNow };
