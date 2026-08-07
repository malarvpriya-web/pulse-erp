import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

// Renewal Engine (Priority 5) — subscriptions had zero cron jobs of any kind
// (see MODULE_FEATURE_CONNECTION_MANUAL.md §18.1 #8); this is the Reminder
// step, mirroring amcRenewal.cron.js's getReceivers/dedup-by-day pattern.
//
// Automation Opportunity Audit §20.2 pass (2026-08-06): the original
// getReceivers() read the legacy single-value `users.role` column —
// 'admin'/'superadmin'/'manager'/'finance' aren't even real role codes (the
// live `roles` seed has `admin`/`super_admin`/`finance_manager`/
// `sales_manager`), and several real accounts are stuck on `role='user'`
// regardless of their actual `user_roles` grants (same stale-column gotcha
// documented in fnfAutoTrigger.cron.js and [[project_roles_many_to_many]]).
// Also: `subscriptions.company_id` was queried and stored but never used to
// scope either the subscriptions read or the receiver list, so every
// finance/sales/admin user in every company was notified about every
// company's subscriptions — a real cross-tenant leak, not just a role bug.
const REMINDER_DAYS = parseInt(process.env.SUBSCRIPTION_RENEWAL_REMINDER_DAYS || '15', 10);
const RECEIVER_ROLES = ['super_admin', 'admin', 'finance_manager', 'sales_manager'];

async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND r.code = ANY($2)
       AND (COALESCE(e.company_id, u.company_id) = $1 OR $1 IS NULL)`,
    [companyId, RECEIVER_ROLES]
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
  // `auto_renew` has no downstream executor anywhere in this codebase (no
  // payment-gateway auto-charge cron reads it) — /renew is always a manual
  // click regardless of the flag, so auto_renew=false subscriptions need
  // this reminder MORE, not less. Differentiate the message instead of
  // filtering them out (see §58).
  const actionNote = sub.auto_renew
    ? 'Renew to keep billing continuous.'
    : 'Auto-renew is OFF — it will lapse unless renewed manually.';
  const message = `${sub.plan_name} for ${sub.customer_name || 'customer'} (₹${parseFloat(sub.amount).toLocaleString('en-IN')}/${sub.billing_cycle}) ${overdue ? 'was due' : 'is due'} on ${sub.next_billing_date}. ${actionNote}`;

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

  await notificationsRepository.create({
    user_id: userId,
    title: overdue ? 'Subscription Renewal Overdue' : 'Subscription Renewal Due Soon',
    message,
    module_name: 'sales',
    notification_type: 'subscription_renewal',
  });
}
async function runSubscriptionRenewalCheck() {
  const { rows: expiring } = await pool.query(
    `SELECT id, plan_name, customer_name, amount, billing_cycle, next_billing_date, company_id, auto_renew
     FROM subscriptions
     WHERE status = 'active'
       AND next_billing_date IS NOT NULL
       AND next_billing_date <= CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY next_billing_date ASC`,
    [REMINDER_DAYS]
  );
  if (!expiring.length) return;

  const receiversByCompany = new Map();
  for (const sub of expiring) {
    const key = sub.company_id ?? null;
    if (!receiversByCompany.has(key)) {
      receiversByCompany.set(key, await getReceivers(key));
    }
    for (const userId of receiversByCompany.get(key)) {
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

export { runSubscriptionRenewalCheck as runSubscriptionRenewalCheckNow };
