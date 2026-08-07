import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

// Automation Opportunity Audit §24.2 — finance/assets.routes.js already
// computes `warranty_expiry BETWEEN NOW() AND NOW()+90 days` for its own
// dashboard widget; this ports the identical predicate into a daily push,
// same shape as vendorDocExpiry.cron.js/warrantyExpiry.cron.js.
const REMINDER_DAYS = parseInt(process.env.ASSET_WARRANTY_REMINDER_DAYS || '90', 10);

async function getExpiringAssetsByCompany() {
  const { rows } = await pool.query(
    `SELECT id, company_id, asset_code, name, department, warranty_expiry::date AS warranty_expiry,
            (warranty_expiry::date - CURRENT_DATE) AS days_left
     FROM fixed_assets
     WHERE warranty_expiry IS NOT NULL
       AND warranty_expiry::date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY company_id, warranty_expiry ASC`,
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

// fixed_assets has no owner/assigned_to column — there's no single "asset
// owner" to resolve. Notify whoever holds edit access on the `assets`
// permission module instead (role_permissions: super_admin/admin/
// procurement_manager/store_keeper per the 20260719000001 seed) — the
// practical facilities/procurement equivalent the audit's "asset owner/
// facilities role" phrasing describes in this codebase.
async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'assets' AND rp.can_edit = true
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND COALESCE(e.company_id, u.company_id) = $1`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, asset) {
  const dup = await pool.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1 AND module_name = 'assets' AND reference_id = $2
       AND notification_type = 'asset_warranty_expiring' AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, asset.id]
  );
  if (dup.rows.length) return;

  await notificationsRepository.create({
    user_id: userId,
    title: `Asset Warranty Expiring in ${asset.days_left} Day${asset.days_left === 1 ? '' : 's'}: ${asset.name}`,
    message: `${asset.name} (${asset.asset_code}${asset.department ? `, ${asset.department}` : ''}) warranty expires on ${asset.warranty_expiry}.`,
    module_name: 'assets',
    reference_id: asset.id,
    notification_type: 'asset_warranty_expiring',
  });
}

async function runAssetWarrantyExpiryCheck() {
  const byCompany = await getExpiringAssetsByCompany();
  if (!byCompany.size) return;

  for (const [companyId, assets] of byCompany) {
    const receivers = await getReceivers(companyId);
    if (!receivers.length) continue;
    for (const asset of assets) {
      for (const userId of receivers) {
        await insertReminder(userId, asset);
      }
    }
  }
}

export function startAssetWarrantyExpiryCron() {
  // Daily at 09:40 server local time (staggered with the other 09:xx crons)
  cron.schedule('40 9 * * *', () => {
    runAssetWarrantyExpiryCheck().catch((err) =>
      console.error('[assetWarrantyExpiryCron] failed:', err.message)
    );
  });
  console.log(`🛡️ Asset warranty expiry cron started (daily 09:40, reminder window ${REMINDER_DAYS} days before expiry)`);
}

export { runAssetWarrantyExpiryCheck as runAssetWarrantyExpiryCheckNow };
