import cron from 'node-cron';
import pool from '../config/db.js';
import { notifyWorkflowEvent } from '../services/WorkflowNotificationService.js';

// Automation Opportunity Audit §31.1 — "Generalize N-day escalation onto the
// engine itself." leave.cron.js's escalation sweep is module-specific (reads
// leave_applications.manager_id directly); the generic WorkflowService.js
// engine that Leave and Projects both actually run on had no escalation
// concept of its own. workflow_steps.sla_hours already exists (added by the
// original 20260429000001_workflow_engine.js migration) but nothing anywhere
// reads it — confirmed via grep before writing this file, per the audit's own
// note to "verify it's not already present before building." No schema
// change needed; this is a pure wiring gap, same shape as §7.2/§16.2/§17.1.

// The engine's own tables (workflows/workflow_instances/workflow_steps) carry
// no company_id — company scoping has to be resolved per module via the
// entity the instance actually points at. Each module registered on the
// engine gets one entry here mapping to its own entity table's company_id
// column, rather than duplicating per-module business logic into a generic
// cron. 'travel' added after §30.1 wired travel.routes.js's
// initiateWorkflow('travel', ...) call onto the engine (20260806000005) —
// travel_requests.company_id confirmed live before adding this entry, same
// verification the original leaves/projects entries got.
const ENTITY_COMPANY_TABLE = {
  leaves: 'leave_applications',
  projects: 'projects',
  travel: 'travel_requests',
};

async function getOverdueSteps() {
  const { rows } = await pool.query(
    `SELECT wis.id AS instance_step_id, wi.id AS instance_id, wi.module, wi.entity_id, wi.entity_type,
            ws.step_name, ws.assignee_role, ws.sla_hours, wis.start_time
     FROM workflow_instance_steps wis
     JOIN workflow_instances wi ON wi.id = wis.instance_id
     JOIN workflow_steps ws ON ws.id = wis.step_id
     WHERE wis.status = 'pending'
       AND wi.status NOT IN ('approved', 'rejected', 'cancelled')
       AND ws.sla_hours IS NOT NULL
       AND wis.start_time <= NOW() - (ws.sla_hours * INTERVAL '1 hour')
     ORDER BY wis.start_time ASC`
  );
  return rows;
}

async function resolveCompanyId(module, entityId) {
  const table = ENTITY_COMPANY_TABLE[module];
  if (!table) return null;
  const { rows } = await pool.query(`SELECT company_id FROM ${table} WHERE id = $1`, [entityId]);
  return rows[0]?.company_id ?? null;
}

// Same role_permissions-vs-role-code distinction the engine itself already
// draws: `workflow_steps.assignee_role` is compared directly against a
// `roles.code` value in WorkflowService.advanceWorkflow's own role
// enforcement, not resolved through role_permissions like the module-editor
// crons (§54/§56/§57) — this stays consistent with that, not the other
// pattern, since assignee_role literally *is* a role code here.
async function getEscalationRecipients(roleCode, companyId) {
  if (!roleCode) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT u.employee_id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND u.employee_id IS NOT NULL
       AND r.code = $1
       AND ($2::int IS NULL OR COALESCE(e.company_id, u.company_id) = $2)`,
    [roleCode, companyId]
  );
  return rows.map((r) => r.employee_id).filter(Boolean);
}

// "Escalate once per entity, ever" — same dedup shape as ncrEscalation.cron.js
// (§16.3/§57), not a same-day digest. An hourly sweep re-notifying the same
// still-overdue step every hour would be spam, not escalation.
async function alreadyEscalated(module, entityId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM notifications
     WHERE module_name = $1 AND reference_id = $2 AND notification_type = 'alert'
     LIMIT 1`,
    [module, entityId]
  );
  return rows.length > 0;
}

async function runWorkflowEscalationCheck() {
  const overdue = await getOverdueSteps();
  if (!overdue.length) return;

  for (const step of overdue) {
    try {
      if (await alreadyEscalated(step.module, step.entity_id)) continue;

      const companyId = await resolveCompanyId(step.module, step.entity_id);
      const recipientIds = await getEscalationRecipients(step.assignee_role, companyId);
      if (!recipientIds.length) continue;

      const hoursOpen = Math.floor(
        (Date.now() - new Date(step.start_time).getTime()) / 3600000
      );

      notifyWorkflowEvent('escalated', {
        module: step.module,
        recordId: step.entity_id,
        recipientIds,
        comments: `Step '${step.step_name}' open ${hoursOpen}h, past its ${step.sla_hours}h SLA.`,
      });
    } catch (err) {
      console.error(`[workflowEscalationCron] instance_step ${step.instance_step_id} failed:`, err.message);
    }
  }
}

export function startWorkflowEscalationCron() {
  // Hourly, matching sla_hours' hour-level granularity (same reasoning as
  // esignReminder.cron.js / ncrEscalation.cron.js) — 10 past the hour to
  // avoid the top-of-hour crowd (healthMonitor, iotMonitor, esignReminder,
  // ncrEscalation at :05).
  cron.schedule('10 * * * *', () => {
    runWorkflowEscalationCheck().catch((err) =>
      console.error('[workflowEscalationCron] failed:', err.message)
    );
  });
  console.log('⏰ Workflow Engine escalation cron started (hourly :10, threshold from workflow_steps.sla_hours)');
}

export { runWorkflowEscalationCheck as runWorkflowEscalationCheckNow };
