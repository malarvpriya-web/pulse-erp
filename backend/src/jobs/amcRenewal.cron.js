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

async function insertReminder(userId, contract, notificationType) {
  // de-dup for the same contract / user / day
  const dup = await pool.query(
    `SELECT 1
     FROM notifications
     WHERE user_id = $1
       AND module_name = 'service'
       AND reference_id = $2
       AND notification_type = $3
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, contract.id, notificationType]
  );
  if (dup.rows.length) return;

  await pool.query(
    `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
     VALUES ($1, $2, $3, 'service', $4, $5)`,
    [
      userId,
      `AMC Renewal Due in ${contract.days_left} Day${contract.days_left === 1 ? '' : 's'}`,
      `${contract.contract_type || 'AMC'} contract ${contract.contract_number ? `${contract.contract_number} ` : ''}for ${contract.customer_name} expires on ${contract.end_date}. Renew soon.`,
      contract.id,
      notificationType,
    ]
  );
}

// `service_contracts` (manual-entry, ServiceContracts.jsx) and `amc_contracts`
// (the lifecycle/commissioning-driven system-of-record, linked to
// sales_order_id/project_id/commissioning_workflow_id) are two disconnected
// AMC stores — see [[project_enterprise_workflow_audit]]. Checking only one
// would silently miss whichever the caller didn't populate, so both are
// checked here with distinct notification_type values (their integer ids
// aren't unique across the two tables, so the types must differ to dedup
// correctly).
async function runServiceContractsCheck(receivers) {
  const { rows: expiring } = await pool.query(
    `SELECT id, customer_name, contract_type, end_date::date AS end_date,
            (end_date::date - CURRENT_DATE) AS days_left
     FROM service_contracts
     WHERE status = 'Active'
       AND end_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY end_date ASC`,
    [REMINDER_DAYS]
  );

  for (const contract of expiring) {
    for (const userId of receivers) {
      await insertReminder(userId, contract, 'amc_renewal');
    }
  }
}

async function runAmcContractsCheck(receivers) {
  const { rows: expiring } = await pool.query(
    `SELECT ac.id, ac.contract_number,
            COALESCE(p.customer_name, ac.product_name, 'Unknown customer') AS customer_name,
            'AMC' AS contract_type, ac.end_date::date AS end_date,
            (ac.end_date::date - CURRENT_DATE) AS days_left
     FROM amc_contracts ac
     LEFT JOIN projects p ON p.id = ac.project_id
     WHERE ac.status = 'active'
       AND ac.deleted_at IS NULL
       AND ac.end_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY ac.end_date ASC`,
    [REMINDER_DAYS]
  );

  for (const contract of expiring) {
    for (const userId of receivers) {
      await insertReminder(userId, contract, 'amc_contract_renewal');
    }
  }
}

async function runAmcRenewalCheck() {
  const receivers = await getReceivers();
  if (!receivers.length) return;

  await runServiceContractsCheck(receivers);
  await runAmcContractsCheck(receivers);
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
