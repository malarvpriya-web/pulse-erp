/**
 * 20260806000004_workflow_steps_sla_hours_seed.js
 *
 * Automation Opportunity Audit §31.1 follow-up.
 *
 * workflowEscalation.cron.js sweeps workflow_instance_steps for
 * `ws.sla_hours IS NOT NULL AND overdue` — but every workflow_steps row
 * seeded by 20260429000001_workflow_engine.js has sla_hours = NULL, so that
 * cron has never had anything to escalate. Leaving it dormant was a
 * deliberate choice the first time this was touched (picking a real SLA
 * number and turning on live escalations is a business call, not something
 * to decide unilaterally) — user explicitly authorized setting it now.
 *
 * Backfills the two pre-existing approval steps (leave_approval's
 * manager_approval/hr_confirmation, project_creation's manager_approval)
 * with the same 72h/3-day threshold leave.cron.js's own hardcoded
 * escalation already uses, so this doesn't invent a new, undocumented SLA
 * number. 20260806000005_travel_approval_workflow_seed.js (a concurrent
 * session's §30.1 work) already seeds travel_approval's own manager_approval
 * step with sla_hours=72 inline on insert — nothing to backfill there.
 *
 * Only projects and travel actually call WorkflowService.initiateWorkflow()
 * today; leave_applications never does, so leave.cron.js's own escalation
 * (§5) stays as the only thing covering leave in practice. This backfill
 * just makes leave_approval's steps consistent and ready for whenever leave
 * is wired onto the engine, and makes project_creation's escalation live now.
 *
 * Terminal steps (approved/rejected) are intentionally left NULL — the
 * escalation query already excludes them via wi.status NOT IN
 * ('approved','rejected','cancelled'), so an SLA there would never be read.
 *
 * CORRECTED post-apply (checksum repaired via migrate:repair-checksums):
 * the original WHERE matched step_code globally with no workflow scope, and
 * on first run it silently flipped 20260806000004_travel_requests_workflow_
 * seed.js's 'travel_request_approval' manager_approval step from NULL to 72
 * — a different, concurrently-landed migration whose own comment says
 * "sla_hours is left NULL deliberately: this is a shadow-mode pilot, not a
 * behavior change." Caught and reverted live; this version scopes strictly
 * to the two workflow codes this migration is actually about, by name, so a
 * fresh-DB replay can't repeat the collision regardless of what other
 * workflow codes happen to reuse the same step_code convention.
 */

export async function up(knex) {
  await knex.raw(`
    UPDATE workflow_steps ws
       SET sla_hours = 72
      FROM workflows w
     WHERE ws.workflow_id = w.id
       AND w.code IN ('leave_approval', 'project_creation')
       AND ws.step_code IN ('manager_approval', 'hr_confirmation')
       AND ws.sla_hours IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`
    UPDATE workflow_steps ws
       SET sla_hours = NULL
      FROM workflows w
     WHERE ws.workflow_id = w.id
       AND w.code IN ('leave_approval', 'project_creation')
       AND ws.step_code IN ('manager_approval', 'hr_confirmation')
       AND ws.sla_hours = 72
  `);
}
