import cron from 'node-cron';
import pool from '../config/db.js';
import { notifyWorkflowEvent } from '../services/WorkflowNotificationService.js';

// Automation Opportunity Audit §16.3 — "NCR critical-escalation config: wire
// the consumer". quality_settings.ncr_escalate_critical_mins is a real,
// per-company, configurable escalation threshold (default 60 minutes) with
// zero code anywhere that reads it and actually escalates. The audit names
// leave.cron.js's escalation sweep (§12.1, lines 264-312) as the template —
// same notifyWorkflowEvent('escalated', ...) call shape, same recipientIds
// pattern (now correctly delivered — see WorkflowNotificationService.js's
// employees.id -> users.id resolution fixed this same day for §12.1).
//
// Scoped to ncr_reports only (the Quality module's own NCR table, the one
// quality_settings actually governs) — not non_conformance_reports, a
// separate, still-live table Procurement's GRN-rejection flow and CRM's
// Customer360 view use for a different purpose; ncr_escalate_critical_mins
// has no relationship to that table.
//
// Threshold granularity (minutes, default 60) means a once-daily cron would
// give a next-day-at-best SLA on a "critical" item — runs hourly instead,
// matching esignReminder.cron.js's precedent for this codebase. Dedup is
// "escalate once per NCR" (checked via a prior notification referencing the
// NCR's id), not once-per-day like the daily reminder crons — an hourly scan
// re-notifying the same still-open critical NCR every hour would be spam,
// not escalation.

async function getOverdueCriticalNcrs() {
  const { rows } = await pool.query(`
    SELECT n.id, n.ncr_number, n.title, n.severity, n.status, n.detected_at, n.company_id,
           COALESCE(qs.ncr_escalate_critical_mins, 60) AS escalate_mins
    FROM ncr_reports n
    LEFT JOIN quality_settings qs ON qs.company_id = n.company_id
    WHERE n.severity = 'critical'
      AND n.status IN ('open', 'under-review')
      AND n.detected_at IS NOT NULL
      AND n.detected_at <= NOW() - (COALESCE(qs.ncr_escalate_critical_mins, 60) * INTERVAL '1 minute')
    ORDER BY n.company_id, n.detected_at ASC
  `);
  return rows;
}

// role_permissions-based resolution (module='quality', can_edit=true) — same
// approach §54 (Compliance) and §16.2 (calibration due-alerts) already use
// for this exact permission set. notifyWorkflowEvent's recipientIds expects
// employees.id values (it resolves to a login internally), so this selects
// u.employee_id rather than u.id — accounts with no linked employee row
// can't be reached this way, same limitation every recipientIds-based caller
// already has.
async function getEscalationRecipients(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.employee_id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'quality' AND rp.can_edit = true
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND u.employee_id IS NOT NULL
       AND (COALESCE(e.company_id, u.company_id) = $1 OR $1 IS NULL)`,
    [companyId]
  );
  return rows.map((r) => r.employee_id);
}

async function alreadyEscalated(ncrId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM notifications
     WHERE module_name = 'Quality NCR' AND reference_id = $1 AND notification_type = 'alert'
     LIMIT 1`,
    [ncrId]
  );
  return rows.length > 0;
}

async function runNcrEscalationCheck() {
  const overdue = await getOverdueCriticalNcrs();
  if (!overdue.length) return;

  for (const ncr of overdue) {
    try {
      if (await alreadyEscalated(ncr.id)) continue;

      const recipientIds = await getEscalationRecipients(ncr.company_id);
      if (!recipientIds.length) continue;

      const minutesOpen = Math.floor(
        (Date.now() - new Date(ncr.detected_at).getTime()) / 60000
      );

      await notifyWorkflowEvent('escalated', {
        module: 'Quality NCR',
        recordId: ncr.id,
        actorId: null,
        actorName: 'System',
        context: {
          ncr_number: ncr.ncr_number,
          title: ncr.title,
          severity: ncr.severity,
          minutes_open: minutesOpen,
          threshold_mins: ncr.escalate_mins,
        },
        recipientIds,
      });
    } catch (err) {
      console.error(`[ncrEscalationCron] NCR ${ncr.id} failed:`, err.message);
    }
  }
}

export function startNcrEscalationCron() {
  // Hourly, on the hour — matched to ncr_escalate_critical_mins' minute-level
  // granularity (default 60), per the audit's own note.
  cron.schedule('0 * * * *', () => {
    runNcrEscalationCheck().catch((err) => console.error('[ncrEscalationCron] failed:', err.message));
  });
  console.log('🚨 NCR critical-escalation cron started (hourly, threshold from quality_settings.ncr_escalate_critical_mins)');
}

export { runNcrEscalationCheck as runNcrEscalationCheckNow };
