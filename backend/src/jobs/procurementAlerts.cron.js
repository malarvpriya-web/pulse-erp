/**
 * procurementAlerts.cron.js — the consumer for the two procurement alert toggles.
 *
 * `procurement_settings.alert_overdue_delivery` and `alert_vendor_rating_drop`
 * have been offered in the Procurement Settings screen, validated, and persisted
 * correctly since the settings table was created. Nothing had ever read either
 * one. Grepping the backend for both names returned only the migration that
 * creates the column, the defaults object, and the INSERT/UPDATE that stores it
 * — no consumer, no job, no query. Turning "Alert on overdue delivery" on did
 * exactly nothing, and there was no way for a buyer to discover that except by
 * waiting for an alert that was never coming.
 *
 * This job is that consumer. It respects the toggles per company — a company
 * that leaves them off gets nothing, which is the setting doing its job — and it
 * is deliberately conservative about repeat notifications: one per user per
 * subject per day, matched on the same (module, reference, type, date) key the
 * other reminder crons use.
 *
 * Recipients are the people who hold the procurement grant that matches the
 * alert, resolved from role_permissions rather than a hardcoded role list, so
 * the matrix stays the single source of truth for who is in procurement.
 */
import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { scheduled } from './jobRun.js';

/** Companies with a given alert toggle switched on. */
async function companiesWithAlert(column) {
  const { rows } = await pool.query(
    `SELECT company_id FROM procurement_settings
      WHERE ${column} = true AND company_id IS NOT NULL`
  );
  return rows.map(r => r.company_id);
}

/**
 * Users who should receive a procurement alert for a company.
 *
 * `can_view` is the right grant: an alert is information, and the roles that can
 * see procurement are exactly the ones for whom a late delivery is news. Scoping
 * falls back to users.company_id for accounts with no employees row (admins).
 */
async function receiversFor(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       JOIN role_permissions rp
         ON rp.role_id = r.id AND rp.module = 'procurement' AND rp.can_view = true
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.is_active = true
        AND COALESCE(e.company_id, u.company_id) = $1`,
    [companyId]
  );
  return rows.map(r => r.id);
}

/** One notification per user per subject per day. */
async function notifyOnce(userId, { title, message, referenceId, type }) {
  const { rows } = await pool.query(
    `SELECT 1 FROM notifications
      WHERE user_id = $1 AND module_name = 'procurement' AND reference_id = $2
        AND notification_type = $3 AND created_at::date = CURRENT_DATE
      LIMIT 1`,
    [userId, referenceId, type]
  );
  if (rows.length) return;
  await notificationsRepository.create({
    user_id: userId,
    title,
    message,
    module_name: 'procurement',
    reference_id: referenceId,
    notification_type: type,
  });
}

/**
 * Purchase orders past their promised delivery date and not yet closed.
 *
 * Mirrors poRepo.getLateDeliveries' predicate so the alert and the dashboard
 * panel can never disagree about what "overdue" means.
 */
async function runOverdueDeliveryAlerts() {
  const companies = await companiesWithAlert('alert_overdue_delivery');
  const counters = { companies: companies.length, overdue: 0, notified: 0 };
  for (const companyId of companies) {
    const { rows: late } = await pool.query(
      `SELECT po.id, po.po_number, po.expected_delivery_date,
              COALESCE(v.vendor_name, 'the vendor') AS vendor_name,
              (CURRENT_DATE - po.expected_delivery_date)::int AS days_late
         FROM purchase_orders po
         LEFT JOIN vendors v ON v.id = po.supplier_id
        WHERE po.company_id = $1
          AND po.deleted_at IS NULL
          AND po.expected_delivery_date IS NOT NULL
          AND po.expected_delivery_date < CURRENT_DATE
          AND po.status NOT IN ('received', 'completed', 'cancelled', 'closed')
        ORDER BY po.expected_delivery_date`,
      [companyId]
    );
    counters.overdue += late.length;
    if (!late.length) continue;

    const receivers = await receiversFor(companyId);
    for (const po of late) {
      for (const userId of receivers) {
        counters.notified++;
        await notifyOnce(userId, {
          title: `Delivery Overdue: ${po.po_number}`,
          message: `${po.po_number} from ${po.vendor_name} was due on ${po.expected_delivery_date} and is ${po.days_late} day${po.days_late === 1 ? '' : 's'} late.`,
          referenceId: po.id,
          type: 'po_overdue_delivery',
        });
      }
    }
  }
  return counters;
}

/**
 * Vendors whose rating has fallen below the configured minimum.
 *
 * `min_vendor_rating` is the same threshold PO approval already enforces, so the
 * alert warns about exactly the vendors who are about to start failing approval
 * rather than inventing a second definition of "bad".
 *
 * A vendor with no ratings at all is skipped, not alerted: every vendors.*_rating
 * column defaults to 0, so a never-rated vendor and a genuinely zero-rated one
 * are indistinguishable by value alone — the same trap PO approval documents.
 * Alerting on the unmeasured would bury the real drops in noise.
 */
async function runVendorRatingDropAlerts() {
  const companies = await companiesWithAlert('alert_vendor_rating_drop');
  const counters = { companies: companies.length, below_threshold: 0, notified: 0 };
  for (const companyId of companies) {
    const { rows: dropped } = await pool.query(
      `SELECT v.id, v.vendor_name, s.min_vendor_rating,
              ROUND(AVG(vr.overall_score)::numeric, 1) AS avg_rating,
              COUNT(vr.id)::int AS rating_count
         FROM vendors v
         JOIN vendor_ratings vr ON vr.vendor_id = v.id
         JOIN procurement_settings s ON s.company_id = $1
        WHERE v.company_id = $1
          AND v.deleted_at IS NULL
          AND COALESCE(v.status, 'active') = 'active'
        GROUP BY v.id, v.vendor_name, s.min_vendor_rating
       HAVING COUNT(vr.id) > 0
          AND AVG(vr.overall_score) < s.min_vendor_rating`,
      [companyId]
    );
    counters.below_threshold += dropped.length;
    if (!dropped.length) continue;

    const receivers = await receiversFor(companyId);
    for (const v of dropped) {
      for (const userId of receivers) {
        counters.notified++;
        await notifyOnce(userId, {
          title: `Vendor Rating Below Threshold: ${v.vendor_name}`,
          message: `${v.vendor_name} is averaging ${v.avg_rating} across ${v.rating_count} rating${v.rating_count === 1 ? '' : 's'}, below the minimum of ${v.min_vendor_rating}. New purchase orders for this vendor will fail approval.`,
          referenceId: v.id,
          type: 'vendor_rating_drop',
        });
      }
    }
  }
  return counters;
}

export async function runProcurementAlerts() {
  const overdue = await runOverdueDeliveryAlerts();
  const ratings = await runVendorRatingDropAlerts();
  return {
    overdue_companies: overdue.companies, overdue_pos: overdue.overdue, overdue_notified: overdue.notified,
    rating_companies: ratings.companies, vendors_below_threshold: ratings.below_threshold, rating_notified: ratings.notified,
  };
}

export function startProcurementAlertsCron() {
  // Daily 09:15, staggered between the vendor-health (09:10) and calibration
  // (09:25) jobs so the 09:xx crons do not contend for the pool at once.
  cron.schedule('15 9 * * *', scheduled('procurementAlerts', runProcurementAlerts));
  console.log('📥 Procurement alerts cron started (daily 09:15 — overdue deliveries + vendor rating drops, per procurement_settings toggles)');
}

export { runProcurementAlerts as runProcurementAlertsNow };
