import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

// Automation Opportunity Audit §3.2 — validity_date sat unread; quotations
// stayed 'sent' forever past their own expiry, misrepresenting the pipeline.
async function insertReminder(quotation) {
  if (!quotation.created_by) return;

  const dup = await pool.query(
    `SELECT 1
     FROM notifications
     WHERE user_id = $1
       AND module_name = 'sales'
       AND reference_id = $2
       AND notification_type = 'quotation_expired'
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [quotation.created_by, quotation.id]
  );
  if (dup.rows.length) return;

  await notificationsRepository.create({
    user_id: quotation.created_by,
    title: 'Quotation Expired',
    message: `Quotation ${quotation.quotation_number} for ${quotation.customer_name || 'the customer'} passed its validity date (${quotation.validity_date}) and has been marked expired.`,
    module_name: 'sales',
    reference_id: quotation.id,
    notification_type: 'quotation_expired',
  });
}

async function runQuotationExpiryCheck() {
  const { rows: expired } = await pool.query(
    `UPDATE quotations
     SET status = 'expired', updated_at = NOW()
     WHERE status = 'sent'
       AND validity_date < CURRENT_DATE
       AND deleted_at IS NULL
     RETURNING id, quotation_number, customer_name, validity_date, created_by`
  );

  for (const quotation of expired) {
    await insertReminder(quotation);
  }
}

export function startQuotationExpiryCron() {
  // Daily at 09:45 server local time (staggered after the other 09:xx reminder crons)
  cron.schedule('45 9 * * *', () => {
    runQuotationExpiryCheck().catch((err) =>
      console.error('[quotationExpiryCron] failed:', err.message)
    );
  });
  console.log('📄 Quotation auto-expiry cron started (daily 09:45)');
}

export { runQuotationExpiryCheck };
