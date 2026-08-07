import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

// Automation Opportunity Audit §23.1 — compliance.routes.js already computes
// is_expired/expiring_soon (standards) and is_overdue/audits_due_30d (audits)
// as read-time query flags (GET /compliance/standards, GET /compliance/summary)
// but nothing surfaces them until someone opens the dashboard. Compliance was
// flagged as the audit's worst gap by domain risk — zero automation of any
// kind on a module where "nobody happened to check" is the costliest failure
// mode. This ports the same predicates verbatim into a daily push, same
// shape as warrantyExpiry/vendorDocExpiry.
const STANDARD_WINDOW_DAYS = parseInt(process.env.COMPLIANCE_STANDARD_REMINDER_DAYS || '90', 10);
const AUDIT_WINDOW_DAYS    = parseInt(process.env.COMPLIANCE_AUDIT_REMINDER_DAYS || '30', 10);

async function getExpiringStandardsByCompany() {
  const { rows } = await pool.query(
    `SELECT id, company_id, code, title, expiry_date::date AS expiry_date,
            (expiry_date::date - CURRENT_DATE) AS days_left,
            (expiry_date::date < CURRENT_DATE) AS is_expired
     FROM compliance_standards
     WHERE deleted_at IS NULL
       AND expiry_date IS NOT NULL
       AND expiry_date::date < CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY company_id, expiry_date ASC`,
    [STANDARD_WINDOW_DAYS]
  );
  const byCompany = new Map();
  for (const row of rows) {
    if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, []);
    byCompany.get(row.company_id).push(row);
  }
  return byCompany;
}

async function getDueAuditsByCompany() {
  const { rows } = await pool.query(
    `SELECT a.id, a.company_id, a.audit_type, a.scheduled_date::date AS scheduled_date,
            s.code AS standard_code, s.title AS standard_title,
            (a.scheduled_date::date - CURRENT_DATE) AS days_left,
            (a.scheduled_date::date < CURRENT_DATE) AS is_overdue
     FROM compliance_audits a
     LEFT JOIN compliance_standards s ON s.id = a.standard_id
     WHERE a.status = 'scheduled'
       AND a.scheduled_date IS NOT NULL
       AND a.scheduled_date::date < CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY a.company_id, a.scheduled_date ASC`,
    [AUDIT_WINDOW_DAYS]
  );
  const byCompany = new Map();
  for (const row of rows) {
    if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, []);
    byCompany.get(row.company_id).push(row);
  }
  return byCompany;
}

// Who gets notified: whoever actually holds edit access on the `compliance`
// permission module for that company (super_admin/admin/qc_manager/
// qc_engineer/production_manager per the 20260719000001 seed) — read off
// role_permissions directly instead of hardcoding role codes, so this stays
// correct if that seed ever changes.
async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'compliance' AND rp.can_edit = true
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND COALESCE(e.company_id, u.company_id) = $1`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, notificationType, referenceId, title, message) {
  const dup = await pool.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1
       AND module_name = 'compliance'
       AND reference_id = $2
       AND notification_type = $3
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, referenceId, notificationType]
  );
  if (dup.rows.length) return;

  await notificationsRepository.create({
    user_id: userId,
    title,
    message,
    module_name: 'compliance',
    reference_id: referenceId,
    notification_type: notificationType,
  });
}

async function runComplianceReminders() {
  const [standardsByCompany, auditsByCompany] = await Promise.all([
    getExpiringStandardsByCompany(),
    getDueAuditsByCompany(),
  ]);
  if (!standardsByCompany.size && !auditsByCompany.size) return;

  const companyIds = new Set([...standardsByCompany.keys(), ...auditsByCompany.keys()]);
  for (const companyId of companyIds) {
    const receivers = await getReceivers(companyId);
    if (!receivers.length) continue;

    for (const std of standardsByCompany.get(companyId) || []) {
      const title = std.is_expired
        ? `Compliance Standard Expired: ${std.code}`
        : `Compliance Standard Expiring in ${std.days_left} Day${std.days_left === 1 ? '' : 's'}: ${std.code}`;
      const message = std.is_expired
        ? `${std.title} (${std.code}) expired on ${std.expiry_date}. Renew certification to stay compliant.`
        : `${std.title} (${std.code}) expires on ${std.expiry_date}. Start renewal before it lapses.`;
      for (const userId of receivers) {
        await insertReminder(userId, 'compliance_standard_expiring', std.id, title, message);
      }
    }

    for (const audit of auditsByCompany.get(companyId) || []) {
      const label = audit.standard_code ? `${audit.audit_type} audit (${audit.standard_code})` : `${audit.audit_type} audit`;
      const title = audit.is_overdue
        ? `Compliance Audit Overdue: ${label}`
        : `Compliance Audit Due in ${audit.days_left} Day${audit.days_left === 1 ? '' : 's'}: ${label}`;
      const message = audit.is_overdue
        ? `Scheduled ${label} was due on ${audit.scheduled_date} and is still open. Reschedule or complete it.`
        : `Scheduled ${label} is due on ${audit.scheduled_date}.`;
      for (const userId of receivers) {
        await insertReminder(userId, 'compliance_audit_due', audit.id, title, message);
      }
    }
  }
}

export function startComplianceRemindersCron() {
  // Daily at 09:10 server local time (staggered with the other 09:xx crons)
  cron.schedule('10 9 * * *', () => {
    runComplianceReminders().catch((err) =>
      console.error('[complianceRemindersCron] failed:', err.message)
    );
  });
  console.log(`📜 Compliance reminder cron started (daily 09:10, standard window ${STANDARD_WINDOW_DAYS}d / audit window ${AUDIT_WINDOW_DAYS}d)`);
}

export { runComplianceReminders as runComplianceRemindersNow };
