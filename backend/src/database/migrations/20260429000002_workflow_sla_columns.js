/**
 * 20260429000002_workflow_sla_columns.js
 *
 * Adds SLA timestamp tracking columns to workflow_instance_steps.
 *
 * start_time — set when a step becomes active (initiateWorkflow / advanceWorkflow)
 * end_time   — set when a step is actioned (advanceWorkflow)
 *
 * Both are nullable so existing rows remain valid without backfill.
 *
 * KNOWN ISSUE: Shares timestamp prefix (20260429000002) with
 * 20260429000002_rule_validation.js. Safe at runtime (tracked by filename).
 * See that file for the full explanation.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE workflow_instance_steps
      ADD COLUMN IF NOT EXISTS start_time TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS end_time   TIMESTAMPTZ
  `);

  // Index for SLA reporting queries (step duration analysis)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_wf_ist_start ON workflow_instance_steps(start_time);
    CREATE INDEX IF NOT EXISTS idx_wf_ist_end   ON workflow_instance_steps(end_time);
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE workflow_instance_steps
      DROP COLUMN IF EXISTS start_time,
      DROP COLUMN IF EXISTS end_time
  `);
}
