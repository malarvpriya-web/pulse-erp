/**
 * 20260806000005_travel_approval_workflow_seed.js
 *
 * Automation Opportunity Audit §30.1 — Travel pilot.
 *
 * Seeds a 'travel_approval' workflow (module='travel') so
 * WorkflowService.initiateWorkflow('travel', ...) has something to attach
 * to. Mirrors the existing 'project_creation' seed in
 * 20260429000001_workflow_engine.js exactly (single manager_approval step,
 * two terminal steps) — the only difference is sla_hours=72 is set directly
 * on the seed row here, since 20260806000004_workflow_steps_sla_hours_seed.js
 * (which backfilled the same 72h value onto leave/project steps) already
 * ran and won't retroactively touch a row created after it.
 *
 * Purely additive: new workflow/steps/transitions rows only, nothing existing
 * is altered. travel.routes.js still owns travel_requests.status as the
 * source of truth for every read path — this just gives Travel's approve/
 * reject flow a workflow_instances ledger to advance through, same pattern
 * already proven for Leaves (leaves.routes.js's /:id/workflow/advance).
 */

export async function up(knex) {
  await knex.raw(`
    INSERT INTO workflows (name, code, module, trigger_event, is_active, description)
    VALUES (
      'Travel Approval', 'travel_approval', 'travel', 'on_submit', true,
      'Single-step reporting-manager approval for travel requests'
    )
    ON CONFLICT (code) DO NOTHING
  `);

  await knex.raw(`
    INSERT INTO workflow_steps
      (workflow_id, step_code, step_name, step_type, assignee_role, sequence_order, is_initial, is_terminal, sla_hours)
    SELECT w.id, s.step_code, s.step_name, s.step_type, s.assignee_role, s.seq, s.is_initial, s.is_terminal, s.sla_hours
    FROM workflows w
    CROSS JOIN (VALUES
      ('manager_approval', 'Manager Approval', 'approval', 'manager', 1, true,  false, 72),
      ('approved',         'Approved',         'terminal', null,      2, false, true,  null),
      ('rejected',         'Rejected',         'terminal', null,      3, false, true,  null)
    ) AS s(step_code, step_name, step_type, assignee_role, seq, is_initial, is_terminal, sla_hours)
    WHERE w.code = 'travel_approval'
    ON CONFLICT (workflow_id, step_code) DO NOTHING
  `);

  await knex.raw(`
    DO $$
    DECLARE
      v_wf_id    INTEGER;
      v_mgr_id   INTEGER;
      v_appr_id  INTEGER;
      v_rej_id   INTEGER;
    BEGIN
      SELECT id INTO v_wf_id   FROM workflows      WHERE code        = 'travel_approval';
      IF v_wf_id IS NULL THEN RETURN; END IF;
      SELECT id INTO v_mgr_id  FROM workflow_steps WHERE workflow_id = v_wf_id AND step_code = 'manager_approval';
      SELECT id INTO v_appr_id FROM workflow_steps WHERE workflow_id = v_wf_id AND step_code = 'approved';
      SELECT id INTO v_rej_id  FROM workflow_steps WHERE workflow_id = v_wf_id AND step_code = 'rejected';

      INSERT INTO workflow_transitions (workflow_id, from_step_id, to_step_id, action, outcome)
      VALUES
        (v_wf_id, v_mgr_id, v_appr_id, 'approve', 'approved'),
        (v_wf_id, v_mgr_id, v_rej_id,  'reject',  'rejected')
      ON CONFLICT (from_step_id, action) DO NOTHING;
    END;
    $$
  `);
}

export async function down(knex) {
  await knex.raw(`
    DELETE FROM workflow_transitions WHERE workflow_id = (SELECT id FROM workflows WHERE code = 'travel_approval');
    DELETE FROM workflow_steps       WHERE workflow_id = (SELECT id FROM workflows WHERE code = 'travel_approval');
    DELETE FROM workflows            WHERE code = 'travel_approval';
  `);
}
