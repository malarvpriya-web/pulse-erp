import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

// Automation Opportunity Audit §5.5 — vendorHealth.service.js's
// computeAndSave() already derives docsExpiringSoon/expiredDocs off
// vendor_documents.expiry_date (30-day window, same one used here) but only
// as an aggregate COUNT folded into a per-vendor health score, computed
// on-demand via POST /vendor-health/recalculate-all — no cron ever calls it
// and even when it runs, it doesn't say WHICH document is expiring or
// notify anyone. There's no separate exported query to import (the SELECT
// is inlined in that function's Promise.all), so this ports the same
// predicate directly rather than reusing a non-existent standalone function.
const REMINDER_DAYS = parseInt(process.env.VENDOR_DOC_EXPIRY_REMINDER_DAYS || '30', 10);

async function getExpiringDocsByCompany() {
  const { rows } = await pool.query(
    `SELECT vd.id, vd.vendor_id, vd.doc_type, vd.expiry_date::date AS expiry_date,
            (vd.expiry_date::date - CURRENT_DATE) AS days_left, vd.company_id,
            v.vendor_name
     FROM vendor_documents vd
     JOIN vendors v ON v.id = vd.vendor_id
     WHERE vd.expiry_date IS NOT NULL
       AND vd.expiry_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')
       AND v.deleted_at IS NULL
     ORDER BY vd.company_id NULLS LAST, vd.expiry_date ASC`,
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

// Same junction-based resolution as reorderPr.cron.js — users.role is stale
// on real accounts (pilot procurement logins are stuck at 'user') and some
// have users.company_id NULL with the real company only resolvable via their
// linked employee row.
async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND r.code IN ('procurement_manager', 'procurement_exec', 'admin', 'super_admin')
       AND COALESCE(e.company_id, u.company_id) = $1`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, doc) {
  const dup = await pool.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1
       AND module_name = 'procurement'
       AND reference_id = $2
       AND notification_type = 'vendor_doc_expiring'
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, doc.id]
  );
  if (dup.rows.length) return;

  await notificationsRepository.create({
    user_id: userId,
    title: `Vendor Document Expiring in ${doc.days_left} Day${doc.days_left === 1 ? '' : 's'}`,
    message: `${doc.doc_type || 'Document'} for ${doc.vendor_name || 'vendor'} expires on ${doc.expiry_date}. Request a renewed copy before it lapses.`,
    module_name: 'procurement',
    reference_id: doc.id,
    notification_type: 'vendor_doc_expiring',
  });
}

async function runVendorDocExpiryCheck() {
  const byCompany = await getExpiringDocsByCompany();
  if (!byCompany.size) return;

  for (const [companyId, docs] of byCompany) {
    const receivers = await getReceivers(companyId);
    if (!receivers.length) continue;

    for (const doc of docs) {
      for (const userId of receivers) {
        await insertReminder(userId, doc);
      }
    }
  }
}

export function startVendorDocExpiryCron() {
  // Daily at 09:20 server local time (staggered with the other 09:xx crons)
  cron.schedule('20 9 * * *', () => {
    runVendorDocExpiryCheck().catch((err) =>
      console.error('[vendorDocExpiryCron] failed:', err.message)
    );
  });
  console.log(`📑 Vendor document expiry cron started (daily 09:20, reminder window ${REMINDER_DAYS} days before expiry)`);
}

export { runVendorDocExpiryCheck as runVendorDocExpiryCheckNow };
