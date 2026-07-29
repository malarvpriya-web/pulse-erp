import cron from 'node-cron';
import pool from '../config/db.js';

// Renewal Engine (Priority 5) — subscriptions had zero cron jobs of any kind
// (see MODULE_FEATURE_CONNECTION_MANUAL.md §18.1 #8); this is the Reminder
// step, mirroring amcRenewal.cron.js's getReceivers/dedup-by-day pattern.
const REMINDER_DAYS = parseInt(process.env.SUBSCRIPTION_RENEWAL_REMINDER_DAYS || '15', 10);

async function getReceivers() {
  const { rows } = await pool.query(
    `SELECT id
     FROM users
     WHERE is_active = true
       AND LOWER(role) IN ('admin', 'super_admin', 'superadmin', 'manager', 'sales_manager', 'finance')
     ORDER BY id`
  );
  return rows.map((r) => r.id);
}

// notifications.reference_id is `integer`, but subscriptions.id is `uuid`
// (see subscriptions table) — can't be stored there like AMC/service-contract
// ids can in amcRenewal.cron.js. Dedup instead on the exact message text for
// the day, which already embeds the plan/customer/amount/date and is
// therefore unique enough per subscription per day.
async function insertReminder(userId, sub) {
  const overdue = new Date(sub.next_billing_date) < new Date();
  const message = `${sub.plan_name} for ${sub.customer_name || 'customer'} (₹${parseFloat(sub.amount).toLocaleString('en-IN')}/${sub.billing_cycle}) ${overdue ? 'was due' : 'is due'} on ${sub.next_billing_date}. Renew to keep billing continuous.`;

  const dup = await pool.query(
    `SELECT 1
     FROM notifications
     WHERE user_id = $1
       AND module_name = 'sales'
       AND notification_type = 'subscription_renewal'
       AND message = $2
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, message]
  );
  if (dup.rows.length) return;

  await pool.query(
    `INSERT INTO notifications (user_id, title, message, module_name, notification_type)
     VALUES ($1, $2, $3, 'sales', 'subscription_renewal')`,
    [userId, overdue ? 'Subscription Renewal Overdue' : 'Subscription Renewal Due Soon', message]
  );
}
async function runSubscriptionRenewalCheck() {
  const receivers = await getReceivers();
  if (!receivers.length) return;

  const { rows: expiring } = await pool.query(
    `SELECT id, plan_name, customer_name, amount, billing_cycle, next_billing_date
     FROM subscriptions
     WHERE status = 'active'
       AND auto_renew = true
       AND next_billing_date IS NOT NULL
       AND next_billing_date <= CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY next_billing_date ASC`,
    [REMINDER_DAYS]
  );

  for (const sub of expiring) {
    for (const userId of receivers) {
      await insertReminder(userId, sub);
    }
  }
}

export function startSubscriptionRenewalCron() {
  // Daily at 09:15 server local time (staggered from the 09:00 AMC cron)
  cron.schedule('15 9 * * *', () => {
    runSubscriptionRenewalCheck().catch((err) =>
      console.error('[subscriptionRenewalCron] failed:', err.message)
    );
  });
  console.log(`🔧 Subscription renewal cron started (daily 09:15, reminder window ${REMINDER_DAYS} days before due)`);
}
