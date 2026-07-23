import cron from 'node-cron';
import pool from '../config/db.js';

const REMINDER_DAYS = parseInt(process.env.AMC_RENEWAL_REMINDER_DAYS || '30', 10);

async function getReceivers() {
  const { rows } = await pool.query(
    `SELECT id
     FROM users
     WHERE is_active = true
       AND LOWER(role) IN ('admin', 'super_admin', 'superadmin', 'manager', 'service_manager')
     ORDER BY id`
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, contract) {
  // de-dup for the same contract / user / day
  const dup = await pool.query(
    `SELECT 1
     FROM notifications
     WHERE user_id = $1
       AND module_name = 'service'
       AND reference_id = $2
       AND notification_type = 'amc_renewal'
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, contract.id]
  );
  if (dup.rows.length) return;

  await pool.query(
    `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
     VALUES ($1, $2, $3, 'service', $4, 'amc_renewal')`,
    [
      userId,
      `AMC Renewal Due in ${contract.days_left} Day${contract.days_left === 1 ? '' : 's'}`,
      `${contract.contract_type || 'AMC'} contract for ${contract.customer_name} expires on ${contract.end_date}. Renew soon.`,
      contract.id,
    ]
  );
}

async function runAmcRenewalCheck() {
  const { rows: expiring } = await pool.query(
    `SELECT id, customer_name, contract_type, end_date::date AS end_date,
            (end_date::date - CURRENT_DATE) AS days_left
     FROM service_contracts
     WHERE status = 'Active'
       AND end_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY end_date ASC`,
    [REMINDER_DAYS]
  );

  if (!expiring.length) return;

  const receivers = await getReceivers();
  if (!receivers.length) return;

  for (const contract of expiring) {
    for (const userId of receivers) {
      await insertReminder(userId, contract);
    }
  }
}

export function startAmcRenewalCron() {
  // Daily at 09:00 server local time
  cron.schedule('0 9 * * *', () => {
    runAmcRenewalCheck().catch((err) =>
      console.error('[amcRenewalCron] failed:', err.message)
    );
  });
  console.log(`🔧 AMC renewal cron started (daily 09:00, reminder window ${REMINDER_DAYS} days before expiry)`);
}
