// backend/src/jobs/slaEscalation.cron.js
//
// Automation Opportunity Audit §19.2 — SLA escalation: config exists, nothing
// executes it. sla_policies.escalation_hours (servicedesk.routes.js) is a
// real, per-priority, per-company, configurable field — set via POST/PUT
// /sla-policies, joined into GET /sla/breaches for display — but that
// breach-dashboard query only ever computes first_response/resolution
// breach, never escalation_hours itself. No cron or route reads it. Same
// shape as §16.3 (ncrEscalation.cron.js): a stored threshold with zero
// consumers, closed the same way — notifyWorkflowEvent('escalated', ...) per
// the audit's own cited leave.cron.js template, broadcasting to everyone
// with can_edit on the module (support_tickets has an `assigned_to`, but
// that's the current handler, not a "next tier" to escalate to — there's no
// hierarchy column to walk, so this notifies the servicedesk-edit group as a
// whole, same design as §16.3's ncr_reports).

import cron from 'node-cron';
import pool from '../config/db.js';
import { notifyWorkflowEvent } from '../services/WorkflowNotificationService.js';

const DEFAULT_ESCALATION_HOURS = 8;

async function getOverdueTickets() {
  const { rows } = await pool.query(`
    SELECT t.id, t.ticket_number, t.title, t.priority, t.status, t.created_at, t.company_id,
           ROUND(CAST(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 AS NUMERIC), 1) AS elapsed_hours,
           COALESCE(p.escalation_hours, $1) AS escalation_hours
    FROM support_tickets t
    LEFT JOIN sla_policies p ON LOWER(p.priority) = LOWER(t.priority) AND p.company_id = t.company_id
    WHERE t.status NOT IN ('Resolved', 'Closed')
      AND t.deleted_at IS NULL
      AND EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 > COALESCE(p.escalation_hours, $1)
    ORDER BY t.company_id, t.created_at ASC
  `, [DEFAULT_ESCALATION_HOURS]);
  return rows;
}

// Same shape as ncrEscalation.cron.js's getEscalationRecipients —
// role_permissions can_edit on 'servicedesk', selecting employee_id since
// notifyWorkflowEvent's recipientIds resolves employees.id -> users.id.
async function getEscalationRecipients(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.employee_id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'servicedesk' AND rp.can_edit = true
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND u.employee_id IS NOT NULL
       AND (COALESCE(e.company_id, u.company_id) = $1 OR $1 IS NULL)`,
    [companyId]
  );
  return rows.map((r) => r.employee_id);
}

async function alreadyEscalated(ticketId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM notifications
     WHERE module_name = 'Service Ticket' AND reference_id = $1 AND notification_type = 'alert'
     LIMIT 1`,
    [ticketId]
  );
  return rows.length > 0;
}

async function runSlaEscalationCheck() {
  const overdue = await getOverdueTickets();
  if (!overdue.length) return;

  for (const ticket of overdue) {
    try {
      if (await alreadyEscalated(ticket.id)) continue;

      const recipientIds = await getEscalationRecipients(ticket.company_id);
      if (!recipientIds.length) continue;

      await notifyWorkflowEvent('escalated', {
        module: 'Service Ticket',
        recordId: ticket.id,
        actorId: null,
        actorName: 'System',
        context: {
          ticket_number: ticket.ticket_number,
          title: ticket.title,
          priority: ticket.priority,
          elapsed_hours: ticket.elapsed_hours,
          threshold_hours: ticket.escalation_hours,
        },
        recipientIds,
      });
    } catch (err) {
      console.error(`[slaEscalationCron] ticket ${ticket.id} failed:`, err.message);
    }
  }
}

export function startSlaEscalationCron() {
  // Hourly, on the half-hour — matches escalation_hours' hour-level
  // granularity per the audit's own note; offset to avoid the top-of-hour
  // crowd (esignReminder, ncrEscalation, healthMonitor, iotMonitor).
  cron.schedule('30 * * * *', () => {
    runSlaEscalationCheck().catch((err) => console.error('[slaEscalationCron] failed:', err.message));
  });
  console.log('🎫 SLA escalation cron started (hourly :30, threshold from sla_policies.escalation_hours)');
}

export { runSlaEscalationCheck as runSlaEscalationCheckNow };
