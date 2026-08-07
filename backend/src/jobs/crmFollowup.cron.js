/**
 * CRM Follow-up Reminder Cron
 * ──────────────────────────────────────────────────────────────────────────────
 * lead_activities.next_followup_date and opportunities.follow_up_date have been
 * recorded since 20260717000005 / 20260714000001 respectively, but nothing ever
 * read either column outside of on-demand GETs — a follow-up date sat silently
 * ignored unless someone happened to open the record. This closes that gap the
 * same way amcRenewal.cron.js / deliveryFollowup.cron.js do: daily scan, dedup
 * by day, notify the owner.
 *
 * Unlike those two (which broadcast to a role list), a follow-up is personal —
 * it goes to the record's own assigned_to employee. assigned_to FKs employees,
 * not users (see stock_ledger.created_by-style gotcha), so the employee is
 * resolved to a login via users.employee_id (set on every login auto-created
 * by addEmployee since 20260706000001), falling back to the company_email <->
 * email match that migration backfilled for accounts predating the column.
 */

import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

async function resolveUserId(employeeId) {
  if (!employeeId) return null;
  const { rows } = await pool.query(
    `SELECT u.id
       FROM employees e
       JOIN users u ON (u.employee_id = e.id OR LOWER(u.email) = LOWER(e.company_email))
      WHERE e.id = $1 AND u.is_active = true
      ORDER BY (u.employee_id = e.id) DESC
      LIMIT 1`,
    [employeeId]
  );
  return rows[0]?.id || null;
}

async function insertReminder(userId, { referenceId, type, title, message }) {
  // de-dup for the same record / user / day
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

// A lead's "next follow-up" is the most recently logged activity's
// next_followup_date, not a column on leads itself — DISTINCT ON picks that
// latest activity per lead, matching what the followup index was built for.
async function runLeadFollowupCheck() {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (la.lead_id)
           la.lead_id, la.next_followup_date, l.company_name, l.assigned_to, l.iem_no
      FROM lead_activities la
      JOIN leads l ON l.id = la.lead_id
     WHERE la.deleted_at IS NULL
       AND la.next_followup_date IS NOT NULL
       AND la.next_followup_date <= CURRENT_DATE
       AND l.deleted_at IS NULL
       AND LOWER(l.status) NOT IN ('converted', 'lost')
       AND l.assigned_to IS NOT NULL
     ORDER BY la.lead_id, la.activity_date DESC
  `);

  for (const row of rows) {
    const userId = await resolveUserId(row.assigned_to);
    if (!userId) continue;
    await insertReminder(userId, {
      referenceId: row.lead_id,
      type: 'lead_followup_due',
      title: 'Lead Follow-up Due',
      message: `${row.iem_no || 'Lead'} — ${row.company_name || 'Unknown company'} — follow-up was due on ${row.next_followup_date}.`,
    });
  }
}

async function runOpportunityFollowupCheck() {
  const { rows } = await pool.query(`
    SELECT o.id, o.opportunity_number, o.opportunity_name, o.follow_up_date, o.assigned_to,
           l.company_name
      FROM opportunities o
      LEFT JOIN leads l ON l.id = o.lead_id
     WHERE o.deleted_at IS NULL
       AND o.follow_up_date IS NOT NULL
       AND o.follow_up_date <= CURRENT_DATE
       AND LOWER(o.stage) NOT IN ('won', 'lost')
       AND o.assigned_to IS NOT NULL
     ORDER BY o.follow_up_date ASC
  `);

  for (const row of rows) {
    const userId = await resolveUserId(row.assigned_to);
    if (!userId) continue;
    await insertReminder(userId, {
      referenceId: row.id,
      type: 'opportunity_followup_due',
      title: 'Opportunity Follow-up Due',
      message: `${row.opportunity_number || row.opportunity_name} — ${row.company_name || 'Unknown company'} — follow-up was due on ${row.follow_up_date}.`,
    });
  }
}

async function runCrmFollowupCheck() {
  await runLeadFollowupCheck();
  await runOpportunityFollowupCheck();
}

export function startCrmFollowupCron() {
  // Daily at 09:00 server local time
  cron.schedule('0 9 * * *', () => {
    runCrmFollowupCheck().catch((err) =>
      console.error('[crmFollowupCron] failed:', err.message)
    );
  });
  console.log('📇 CRM follow-up reminder cron started (daily 09:00 — leads + opportunities)');
}

export { runCrmFollowupCheck as runCrmFollowupCheckNow };
