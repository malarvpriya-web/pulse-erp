/**
 * 20261124000001 — Leave escalation (Leaves review, 2026-11-24).
 *
 * A request that waits longer than Leave Settings → "escalate after N days"
 * at one approval step is escalated once per step (leaveEscalation.service.js):
 * the next level up and HR are told, and once the MANAGER step is escalated HR
 * may decide it (the manager may be away). These record which step was
 * escalated and when, so a step is escalated once and the screens can say so.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE leave_applications
      ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS escalation_step VARCHAR(10)`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_leave_applications_pending_escalation
      ON leave_applications (company_id) WHERE status = 'pending' AND deleted_at IS NULL`);
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_leave_applications_pending_escalation');
  await knex.raw(`
    ALTER TABLE leave_applications
      DROP COLUMN IF EXISTS escalated_at, DROP COLUMN IF EXISTS escalation_step`);
}
