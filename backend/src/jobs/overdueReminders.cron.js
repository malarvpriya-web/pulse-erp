import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

async function getReceivers() {
  const { rows } = await pool.query(
    `SELECT id
     FROM users
     WHERE is_active = true
       AND LOWER(role) IN ('admin', 'super_admin', 'superadmin', 'finance', 'finance_manager')
     ORDER BY id`
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, { type, referenceId, title, message }) {
  // de-dup for the same record / user / day
  const dup = await pool.query(
    `SELECT 1
     FROM notifications
     WHERE user_id = $1
       AND module_name = 'finance'
       AND reference_id = $2
       AND notification_type = $3
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, referenceId, type]
  );
  if (dup.rows.length) return;

  await notificationsRepository.create({
    user_id: userId,
    title,
    message,
    module_name: 'finance',
    reference_id: referenceId,
    notification_type: type,
  });
}

async function runArOverdueCheck(receivers) {
  const { rows: overdue } = await pool.query(
    `SELECT id, invoice_number, COALESCE(party_name, 'Unknown customer') AS party_name,
            due_date::date AS due_date, COALESCE(balance, 0) AS balance
     FROM invoices
     WHERE deleted_at IS NULL
       AND LOWER(status) NOT IN ('paid', 'cancelled')
       AND due_date::date < CURRENT_DATE
       AND COALESCE(balance, 0) > 0
     ORDER BY due_date ASC`
  );

  for (const inv of overdue) {
    for (const userId of receivers) {
      await insertReminder(userId, {
        type: 'ar_overdue',
        referenceId: inv.id,
        title: 'Receivable Overdue',
        message: `Invoice ${inv.invoice_number} for ${inv.party_name} is ₹${Number(inv.balance).toLocaleString('en-IN')} overdue (due ${inv.due_date}).`,
      });
    }
  }
}

async function runApOverdueCheck(receivers) {
  const { rows: overdue } = await pool.query(
    `SELECT id, bill_number, COALESCE(party_name, 'Unknown vendor') AS party_name,
            due_date::date AS due_date, COALESCE(balance, 0) AS balance
     FROM bills
     WHERE deleted_at IS NULL
       AND LOWER(status) NOT IN ('paid', 'cancelled')
       AND due_date::date < CURRENT_DATE
       AND COALESCE(balance, 0) > 0
     ORDER BY due_date ASC`
  );

  for (const bill of overdue) {
    for (const userId of receivers) {
      await insertReminder(userId, {
        type: 'ap_overdue',
        referenceId: bill.id,
        title: 'Payable Overdue',
        message: `Bill ${bill.bill_number} for ${bill.party_name} is ₹${Number(bill.balance).toLocaleString('en-IN')} overdue (due ${bill.due_date}).`,
      });
    }
  }
}

async function runOverdueCheck() {
  const receivers = await getReceivers();
  if (!receivers.length) return;
  await runArOverdueCheck(receivers);
  await runApOverdueCheck(receivers);
}

export function startOverdueRemindersCron() {
  // Daily at 09:00 server local time
  cron.schedule('0 9 * * *', () => {
    runOverdueCheck().catch((err) =>
      console.error('[overdueRemindersCron] failed:', err.message)
    );
  });
  console.log('💰 AR/AP overdue reminder cron started (daily 09:00)');
}
