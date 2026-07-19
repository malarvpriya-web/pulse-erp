import cron from 'node-cron';
import pool from '../config/db.js';

const REMINDER_DAYS = parseInt(process.env.PO_DELIVERY_REMINDER_DAYS || '7', 10);

async function getReceivers() {
  const { rows } = await pool.query(
    `SELECT id
     FROM users
     WHERE is_active = true
       AND LOWER(role) IN ('admin', 'super_admin', 'superadmin', 'manager', 'procurement')
     ORDER BY id`
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, po) {
  // de-dup for the same PO / user / day
  const dup = await pool.query(
    `SELECT 1
     FROM notifications
     WHERE user_id = $1
       AND module_name = 'procurement'
       AND reference_id = $2
       AND notification_type = 'delivery_followup'
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, po.id]
  );
  if (dup.rows.length) return;

  await pool.query(
    `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
     VALUES ($1, $2, $3, 'procurement', $4, 'delivery_followup')`,
    [
      userId,
      `PO Follow-up Due in ${REMINDER_DAYS} Days`,
      `PO ${po.po_number} for ${po.supplier_name} is expected on ${po.expected_delivery_date}. Follow up this week.`,
      po.id,
    ]
  );
}

async function runDeliveryFollowupCheck() {
  const { rows: upcomingPos } = await pool.query(
    `SELECT po.id, po.po_number, po.expected_delivery_date::date AS expected_delivery_date,
            COALESCE(v.vendor_name, '') AS supplier_name
     FROM purchase_orders po
     LEFT JOIN vendors v ON v.id = po.supplier_id
     WHERE po.deleted_at IS NULL
       AND po.status NOT IN ('completed', 'cancelled')
       AND po.expected_delivery_date::date = CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY po.expected_delivery_date ASC`,
    [REMINDER_DAYS]
  );

  if (!upcomingPos.length) return;

  const receivers = await getReceivers();
  if (!receivers.length) return;

  for (const po of upcomingPos) {
    for (const userId of receivers) {
      await insertReminder(userId, po);
    }
  }
}

export function startDeliveryFollowupCron() {
  // Daily at 09:00 server local time
  cron.schedule('0 9 * * *', () => {
    runDeliveryFollowupCheck().catch((err) =>
      console.error('[deliveryFollowupCron] failed:', err.message)
    );
  });
  console.log(`📦 Delivery follow-up cron started (daily 09:00, reminder ${REMINDER_DAYS} days before expected delivery date)`);
}

