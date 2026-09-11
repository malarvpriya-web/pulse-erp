import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { sqlPoOpen } from '../shared/statusSets.js';
import { scheduled } from './jobRun.js';

const REMINDER_DAYS = parseInt(process.env.PO_DELIVERY_REMINDER_DAYS || '7', 10);

/**
 * Receivers for one company.
 *
 * users.role is a stale single-value column — real role assignment lives in
 * user_roles, which is why reorderPr resolves receivers from there. This cron
 * was one of the "older reminder crons" that comment refers to: it read
 * `LOWER(role) IN ('admin','super_admin','superadmin','manager','procurement')`,
 * and 'procurement' is not a role code in this system at all (the codes are
 * procurement_manager and procurement_exec), so the one team whose job this
 * reminder describes never received it.
 *
 * The company predicate is the other half. Without it this query returned every
 * active admin/manager in every tenant, and the caller then sent each of them a
 * reminder naming another tenant's PO number and supplier.
 */
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
  if (dup.rows.length) return false;

  await notificationsRepository.create({
    user_id: userId,
    title: `PO Follow-up Due in ${REMINDER_DAYS} Days`,
    message: `PO ${po.po_number} for ${po.supplier_name} is expected on ${po.expected_delivery_date}. Follow up this week.`,
    module_name: 'procurement',
    reference_id: po.id,
    notification_type: 'delivery_followup',
  });
  return true;
}

/**
 * Orders still awaiting delivery, grouped by the tenant that owns them.
 *
 * The status predicate is sqlPoOpen, not a hand-written exclusion. The previous
 * one was `status NOT IN ('completed', 'cancelled')` — and 'completed' is not a
 * value purchase_orders.status ever holds. The state an arrived order reaches is
 * 'received', which that list does not name, so a fully-received order stayed
 * eligible and the buyer was chased for goods already in stock. Both live orders
 * in this database are 'received'; neither was excluded.
 */
async function getUpcomingPosByCompany() {
  const { rows } = await pool.query(
    `SELECT po.id, po.po_number, po.company_id,
            po.expected_delivery_date::date AS expected_delivery_date,
            COALESCE(v.vendor_name, '') AS supplier_name
     FROM purchase_orders po
     LEFT JOIN vendors v ON v.id = po.supplier_id
     WHERE po.deleted_at IS NULL
       AND ${sqlPoOpen('po.status')}
       AND po.expected_delivery_date::date = CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY po.company_id, po.expected_delivery_date ASC`,
    [REMINDER_DAYS]
  );

  const byCompany = new Map();
  let unattributed = 0;
  for (const po of rows) {
    // A PO with no company_id cannot be routed to a tenant's staff, and routing
    // it to everyone is the leak this function exists to close. Counted and
    // skipped, the same stance the price-book predicate takes on an
    // unattributable row.
    if (po.company_id === null || po.company_id === undefined) {
      unattributed++;
      continue;
    }
    if (!byCompany.has(po.company_id)) byCompany.set(po.company_id, []);
    byCompany.get(po.company_id).push(po);
  }
  return { byCompany, unattributed };
}

async function runDeliveryFollowupCheck() {
  const { byCompany, unattributed } = await getUpcomingPosByCompany();
  // Counters, not row content — see jobRun.js.
  const counters = { companies: byCompany.size, pos: 0, notified: 0, skipped: unattributed };
  if (unattributed) {
    console.warn(`[deliveryFollowupCron] ${unattributed} upcoming PO(s) have no company_id — not routed`);
  }
  if (!byCompany.size) return counters;

  for (const [companyId, pos] of byCompany) {
    counters.pos += pos.length;
    const receivers = await getReceivers(companyId);
    if (!receivers.length) {
      console.warn(
        `[deliveryFollowupCron] company ${companyId}: no active procurement/admin receiver — skipping ${pos.length} upcoming PO(s)`
      );
      counters.skipped += pos.length;
      continue;
    }
    for (const po of pos) {
      for (const userId of receivers) {
        if (await insertReminder(userId, po)) counters.notified++;
      }
    }
  }
  return counters;
}

export function startDeliveryFollowupCron() {
  // Daily at 09:00 server local time
  cron.schedule('0 9 * * *', scheduled('deliveryFollowup', runDeliveryFollowupCheck));
  console.log(`📦 Delivery follow-up cron started (daily 09:00, reminder ${REMINDER_DAYS} days before expected delivery date)`);
}

export { runDeliveryFollowupCheck as runDeliveryFollowupCheckNow };
