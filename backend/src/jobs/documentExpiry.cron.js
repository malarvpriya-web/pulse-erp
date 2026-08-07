import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

// Automation Opportunity Audit §25.1 — document_master (Google Drive-backed,
// module_type/linked_entity_type, revision history) had no expiry tracking
// at all; reminders were limited to AMC contracts and e-sign documents.
// 20260806000002_document_master_expiry_date.js added the column, purely
// additive and optional — most rows never set it.
const REMINDER_DAYS = parseInt(process.env.DOCUMENT_EXPIRY_REMINDER_DAYS || '30', 10);

async function getExpiringDocuments() {
  const { rows } = await pool.query(
    `SELECT id, file_name, module_type, linked_entity_type, linked_entity_id,
            expiry_date::date AS expiry_date, (expiry_date::date - CURRENT_DATE) AS days_left,
            uploaded_by, company_id
     FROM document_master
     WHERE deleted_at IS NULL
       AND expiry_date IS NOT NULL
       AND expiry_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY expiry_date ASC`,
    [REMINDER_DAYS]
  );
  return rows;
}

// uploaded_by is written as req.user.userId/id (documentMaster.routes.js's
// own `userId(req)` helper) — a real users.id already, no employees.id
// resolution needed unlike most other crons in this series. Falls back to
// company admins when the uploader account is gone/deactivated, same
// fallback shape amcRenewal.cron.js/campaignLifecycle.cron.js already use.
async function getReceivers(doc) {
  const { rows } = await pool.query(`SELECT id FROM users WHERE id = $1 AND is_active = true`, [doc.uploaded_by]);
  if (rows.length) return [rows[0].id];

  const { rows: admins } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND r.code IN ('admin', 'super_admin')
       AND ($1::int IS NULL OR COALESCE(e.company_id, u.company_id) = $1)`,
    [doc.company_id]
  );
  return admins.map((r) => r.id);
}

async function insertReminder(userId, doc) {
  const dup = await pool.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1 AND module_name = 'documents' AND reference_id = $2
       AND notification_type = 'document_expiring' AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, doc.id]
  );
  if (dup.rows.length) return;

  const overdue = doc.days_left < 0;
  await notificationsRepository.create({
    user_id: userId,
    title: overdue
      ? `Document Expired: ${doc.file_name}`
      : `Document Expiring in ${doc.days_left} Day${doc.days_left === 1 ? '' : 's'}: ${doc.file_name}`,
    message: overdue
      ? `${doc.file_name} (${doc.module_type}) expired on ${doc.expiry_date}.`
      : `${doc.file_name} (${doc.module_type}) expires on ${doc.expiry_date}.`,
    module_name: 'documents',
    reference_id: doc.id,
    notification_type: 'document_expiring',
  });
}

async function runDocumentExpiryCheck() {
  const docs = await getExpiringDocuments();
  if (!docs.length) return;

  for (const doc of docs) {
    const receivers = await getReceivers(doc);
    for (const userId of receivers) {
      await insertReminder(userId, doc);
    }
  }
}

export function startDocumentExpiryCron() {
  // Daily at 09:45... already taken by quotationExpiry — 09:55, tail end of
  // the 09:xx reminder wave.
  cron.schedule('55 9 * * *', () => {
    runDocumentExpiryCheck().catch((err) =>
      console.error('[documentExpiryCron] failed:', err.message)
    );
  });
  console.log(`📄 Document expiry cron started (daily 09:55, reminder window ${REMINDER_DAYS} days before expiry)`);
}

export { runDocumentExpiryCheck as runDocumentExpiryCheckNow };
