/**
 * Tender Deadline / EMD Refund Reminder Cron
 * ──────────────────────────────────────────────────────────────────────────────
 * tenders.routes.js (GET /tenders, GET /tenders/summary) already computes
 * due_soon (submission_deadline within 14 days), overdue, and EMD-stuck-in-refund
 * inline in its SELECT — but only when someone opens the Tender workspace. This
 * reuses that same predicate on a daily cron so a deadline or a stuck EMD surfaces
 * as a notification instead of staying invisible. Tenders are opportunities
 * carrying a tender marker (see tenders.routes.js's TENDER_PRED), so this reads
 * the same `opportunities` rows that workspace does.
 *
 * Broadcasts to a role list (admin/super_admin/sales_manager/sales_exec), matching
 * amcRenewal.cron.js's broadcast pattern, rather than the single assigned owner —
 * tender deadlines and EMD sign-off are typically a shared sales-desk concern,
 * and the audit that flagged this gap specified "sales/tender-desk role", not a
 * single assignee. Roles are many-to-many (user_roles/roles), not the legacy flat
 * users.role column older crons still read — this uses the same junction-table
 * resolution anomalyDetection.cron.js does. Company-scoped (opportunities.company_id)
 * since a tender's deadline is not something another tenant's sales team should see.
 */

import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

const TENDER_ROLES = ['admin', 'super_admin', 'sales_manager', 'sales_exec'];

async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = true
        AND LOWER(r.code) = ANY($1)
        AND (u.company_id = $2 OR u.company_id IS NULL)
      ORDER BY u.id`,
    [TENDER_ROLES, companyId]
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, { referenceId, type, title, message }) {
  const dup = await pool.query(
    `SELECT 1
       FROM notifications
      WHERE user_id = $1
        AND module_name = 'crm'
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
    module_name: 'crm',
    reference_id: referenceId,
    notification_type: type,
  });
}

// Same TENDER_PRED / due_soon / overdue logic as tenders.routes.js — a row
// qualifies as a tender when it carries a tender_number, bid_type, or EMD.
async function runDeadlineCheck() {
  const { rows } = await pool.query(`
    SELECT o.id, o.opportunity_number, o.opportunity_name, o.tender_number,
           o.submission_deadline::date AS submission_deadline, o.company_id,
           CASE WHEN o.submission_deadline < CURRENT_DATE THEN 'overdue' ELSE 'due_soon' END AS bucket
      FROM opportunities o
     WHERE o.deleted_at IS NULL
       AND (o.tender_number IS NOT NULL OR o.bid_type IS NOT NULL OR o.emd_amount IS NOT NULL)
       AND o.submission_deadline IS NOT NULL
       AND LOWER(o.stage) NOT IN ('won', 'lost')
       AND o.submission_deadline < CURRENT_DATE + INTERVAL '14 days'
  `);

  const receiverCache = new Map();
  for (const row of rows) {
    if (!receiverCache.has(row.company_id)) {
      receiverCache.set(row.company_id, await getReceivers(row.company_id));
    }
    const receivers = receiverCache.get(row.company_id);
    const label = row.tender_number || row.opportunity_number || row.opportunity_name;
    const type = row.bucket === 'overdue' ? 'tender_deadline_overdue' : 'tender_deadline_due_soon';
    const title = row.bucket === 'overdue' ? 'Tender Deadline Overdue' : 'Tender Deadline Approaching';
    const message = row.bucket === 'overdue'
      ? `${label} — submission deadline (${row.submission_deadline}) has passed with the tender still open.`
      : `${label} — submission deadline is ${row.submission_deadline} (within 14 days).`;

    for (const userId of receivers) {
      await insertReminder(userId, { referenceId: row.id, type, title, message });
    }
  }
}

// Mirrors tenders.routes.js's /summary emd_blocked filter exactly: an EMD is
// "stuck" once it has no refund date and its status isn't a terminal one.
async function runEmdRefundCheck() {
  const { rows } = await pool.query(`
    SELECT o.id, o.opportunity_number, o.opportunity_name, o.tender_number,
           o.emd_amount, o.emd_status, o.company_id
      FROM opportunities o
     WHERE o.deleted_at IS NULL
       AND o.emd_amount IS NOT NULL AND o.emd_amount > 0
       AND o.emd_refund_date IS NULL
       AND COALESCE(LOWER(o.emd_status), '') NOT IN ('refunded', 'returned', 'forfeited')
  `);

  const receiverCache = new Map();
  for (const row of rows) {
    if (!receiverCache.has(row.company_id)) {
      receiverCache.set(row.company_id, await getReceivers(row.company_id));
    }
    const receivers = receiverCache.get(row.company_id);
    const label = row.tender_number || row.opportunity_number || row.opportunity_name;

    for (const userId of receivers) {
      await insertReminder(userId, {
        referenceId: row.id,
        type: 'tender_emd_stuck',
        title: 'EMD Refund Pending',
        message: `${label} — EMD of ₹${Number(row.emd_amount).toLocaleString('en-IN')} has no refund date recorded (status: ${row.emd_status || 'unknown'}).`,
      });
    }
  }
}

async function runTenderDeadlineCheck() {
  await runDeadlineCheck();
  await runEmdRefundCheck();
}

export function startTenderDeadlineCron() {
  // Daily at 09:00 server local time
  cron.schedule('0 9 * * *', () => {
    runTenderDeadlineCheck().catch((err) =>
      console.error('[tenderDeadlineCron] failed:', err.message)
    );
  });
  console.log('📋 Tender deadline / EMD refund reminder cron started (daily 09:00)');
}

export { runTenderDeadlineCheck as runTenderDeadlineCheckNow };
