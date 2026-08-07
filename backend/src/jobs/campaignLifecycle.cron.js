import cron from 'node-cron';
import pool from '../modules/shared/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

async function getOwnerUserId(ownerEmployeeId) {
  if (!ownerEmployeeId) return null;
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE employee_id = $1 AND is_active = true LIMIT 1`,
    [ownerEmployeeId]
  );
  return rows[0]?.id || null;
}

// Falls back to the campaign's own company admins/managers when it has no
// owner_id (or the owner has no linked login) so the reminder isn't dropped.
async function getCompanyFallbackReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT id
     FROM users
     WHERE is_active = true
       AND company_id = $1
       AND LOWER(role) IN ('admin', 'super_admin', 'superadmin', 'manager', 'sales_manager')
     ORDER BY id`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, campaign) {
  // de-dup for the same campaign / user / day
  const dup = await pool.query(
    `SELECT 1
     FROM notifications
     WHERE user_id = $1
       AND module_name = 'marketing'
       AND reference_id = $2
       AND notification_type = 'campaign_close_out'
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, campaign.id]
  );
  if (dup.rows.length) return;

  await notificationsRepository.create({
    user_id: userId,
    title: `Campaign "${campaign.name}" Needs Close-Out`,
    message: `${campaign.name} ended on ${campaign.end_date} but is still marked "${campaign.status}". Update its status or extend the end date.`,
    module_name: 'marketing',
    reference_id: campaign.id,
    notification_type: 'campaign_close_out',
  });
}

async function runCampaignLifecycleCheck() {
  const { rows: stale } = await pool.query(
    `SELECT id, name, status, owner_id, company_id, end_date::date AS end_date
     FROM marketing_campaigns
     WHERE end_date IS NOT NULL
       AND end_date::date < CURRENT_DATE
       AND status NOT IN ('completed', 'cancelled')
     ORDER BY end_date ASC`
  );

  if (!stale.length) return;

  for (const campaign of stale) {
    const ownerUserId = await getOwnerUserId(campaign.owner_id);
    const recipients = ownerUserId ? [ownerUserId] : await getCompanyFallbackReceivers(campaign.company_id);
    for (const userId of recipients) {
      await insertReminder(userId, campaign);
    }
  }
}

export function startCampaignLifecycleCron() {
  // Daily at 09:00 server local time
  cron.schedule('0 9 * * *', () => {
    runCampaignLifecycleCheck().catch((err) =>
      console.error('[campaignLifecycleCron] failed:', err.message)
    );
  });
  console.log('📣 Campaign lifecycle cron started (daily 09:00, flags campaigns past end_date not yet closed out)');
}

export { runCampaignLifecycleCheck as runCampaignLifecycleCheckNow };
