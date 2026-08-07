import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

// Automation Opportunity Audit §17.1 — rd_patents.expiry_date is a real,
// fully-populated column (rd.routes.js) with zero proactive consumers. A
// lapsed patent is exactly the kind of expensive, silent miss this audit
// series exists to catch. Same shape as amcRenewal.cron.js — cheapest
// possible port, per the audit's own note.
const REMINDER_DAYS = parseInt(process.env.PATENT_RENEWAL_REMINDER_DAYS || '90', 10);

async function getExpiringPatentsByCompany() {
  const { rows } = await pool.query(
    `SELECT id, company_id, title, ip_type, application_no, expiry_date::date AS expiry_date,
            (expiry_date::date - CURRENT_DATE) AS days_left
     FROM rd_patents
     WHERE deleted_at IS NULL
       AND expiry_date IS NOT NULL
       AND status NOT IN ('lapsed', 'abandoned')
       AND expiry_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY company_id, expiry_date ASC`,
    [REMINDER_DAYS]
  );
  const byCompany = new Map();
  for (const row of rows) {
    if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, []);
    byCompany.get(row.company_id).push(row);
  }
  return byCompany;
}

// No dedicated "R&D/legal" role exists in this codebase — notify whoever
// actually holds edit access on the `rd` permission module (role_permissions,
// super_admin/admin/production_manager/design_engineer per the
// 20260719000001 seed), same resolution approach as §54's Compliance cron.
async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'rd' AND rp.can_edit = true
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND COALESCE(e.company_id, u.company_id) = $1`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, patent) {
  const dup = await pool.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1 AND module_name = 'rd' AND reference_id = $2
       AND notification_type = 'patent_expiring' AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, patent.id]
  );
  if (dup.rows.length) return;

  await notificationsRepository.create({
    user_id: userId,
    title: `${patent.ip_type || 'Patent'} Expiring in ${patent.days_left} Day${patent.days_left === 1 ? '' : 's'}: ${patent.title}`,
    message: `${patent.title}${patent.application_no ? ` (${patent.application_no})` : ''} expires on ${patent.expiry_date}. Start the renewal process before it lapses.`,
    module_name: 'rd',
    reference_id: patent.id,
    notification_type: 'patent_expiring',
  });
}

async function runPatentRenewalCheck() {
  const byCompany = await getExpiringPatentsByCompany();
  if (!byCompany.size) return;

  for (const [companyId, patents] of byCompany) {
    const receivers = await getReceivers(companyId);
    if (!receivers.length) continue;
    for (const patent of patents) {
      for (const userId of receivers) {
        await insertReminder(userId, patent);
      }
    }
  }
}

export function startPatentRenewalCron() {
  // Daily at 09:35 server local time (staggered with the other 09:xx crons)
  cron.schedule('35 9 * * *', () => {
    runPatentRenewalCheck().catch((err) =>
      console.error('[patentRenewalCron] failed:', err.message)
    );
  });
  console.log(`🧾 Patent/IP renewal reminder cron started (daily 09:35, reminder window ${REMINDER_DAYS} days before expiry)`);
}

export { runPatentRenewalCheck as runPatentRenewalCheckNow };
