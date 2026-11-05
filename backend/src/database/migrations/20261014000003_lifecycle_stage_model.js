/**
 * 20261014000003_lifecycle_stage_model.js
 *
 * The lifecycle stage model (P1_PROJECT_LIFECYCLE_PLAN.md, Phase 4 /
 * Migration B). Two CHECK constraints are widened; nothing else changes.
 *
 *   chk_lifecycle_instances_stage    + clearing, pre_commissioning, commissioning, sat, closure
 *       The route already advanced installation -> commissioning, and the old
 *       check refused it, so no lifecycle could ever reach Commissioning, SAT
 *       or AMC. 'service' and 'amc' stay allowed: they are no longer stages
 *       (Service / AMC are downstream workflows) but history may use them.
 *       clearing and pre_commissioning are allowed but RESERVED — the
 *       application never moves a lifecycle into them until they are defined
 *       (shared/projectStages.js).
 *   chk_lifecycle_stage_history_action + cancel, reopen
 *       Authorised cancellation and reopening, recorded like every other move.
 *
 * Unchanged on purpose:
 *   chk_lifecycle_instances_status (active / on_hold / completed / cancelled),
 *   so the Phase 3 partial unique indexes on open lifecycles
 *   (status IN ('active','on_hold')) stay exactly right.
 *   lifecycle_stage_history.to_stage has no check and keeps its historical
 *   values. No row is updated or deleted; orphaned lifecycles are untouched.
 *
 * The value lists are frozen here (not imported from the application) so the
 * migration means the same thing forever; lifecycleStages.test checks that
 * shared/projectStages.js stays inside them.
 *
 * Safety: both directions first check the data. Widening cannot conflict, but
 * the check still lists any row outside the new list (a row the old
 * constraint should never have allowed) and stops. Rollback narrows the
 * lists again, so it refuses — naming the lifecycle and history ids — while
 * any row uses a stage or action the old lists did not have. Nothing is ever
 * rewritten to make a constraint fit.
 */

const STAGES_V1 = ['order', 'design', 'procurement', 'production', 'testing', 'dispatch', 'installation', 'service', 'amc'];
const STAGES_V2 = ['order', 'design', 'procurement', 'production', 'testing', 'clearing', 'dispatch', 'installation',
  'pre_commissioning', 'commissioning', 'sat', 'closure', 'service', 'amc'];
const ACTIONS_V1 = ['advance', 'rollback', 'hold', 'resume', 'complete'];
const ACTIONS_V2 = [...ACTIONS_V1, 'cancel', 'reopen'];

const list = (values) => values.map(v => `'${v}'`).join(', ');

/** Rows a stage / action list would reject. Read-only. */
export async function outsideOf(knex, stages, actions) {
  const { rows: lifecycles } = await knex.raw(
    `SELECT id, current_stage FROM lifecycle_instances
      WHERE current_stage IS NULL OR current_stage NOT IN (${list(stages)}) ORDER BY id`);
  const { rows: history } = await knex.raw(
    `SELECT id, lifecycle_instance_id, action FROM lifecycle_stage_history
      WHERE action IS NULL OR action NOT IN (${list(actions)}) ORDER BY id`);
  return { lifecycles, history };
}

async function setChecks(knex, stages, actions, direction) {
  await knex.raw(`LOCK TABLE lifecycle_instances, lifecycle_stage_history IN SHARE ROW EXCLUSIVE MODE`);
  const { lifecycles, history } = await outsideOf(knex, stages, actions);
  if (lifecycles.length || history.length) {
    throw new Error(
      `Lifecycle stage model ${direction} NOT applied — these rows use values the target lists do not allow `
      + '(no record was changed):\n'
      + (lifecycles.length ? `  chk_lifecycle_instances_stage: ${lifecycles.map(r => `lifecycle ${r.id} (${r.current_stage})`).join(', ')}\n` : '')
      + (history.length ? `  chk_lifecycle_stage_history_action: ${history.map(r => `history ${r.id} of lifecycle ${r.lifecycle_instance_id} (${r.action})`).join(', ')}` : ''));
  }
  await knex.raw(`ALTER TABLE lifecycle_instances DROP CONSTRAINT IF EXISTS chk_lifecycle_instances_stage`);
  await knex.raw(
    `ALTER TABLE lifecycle_instances ADD CONSTRAINT chk_lifecycle_instances_stage
       CHECK (current_stage IN (${list(stages)}))`);
  await knex.raw(`ALTER TABLE lifecycle_stage_history DROP CONSTRAINT IF EXISTS chk_lifecycle_stage_history_action`);
  await knex.raw(
    `ALTER TABLE lifecycle_stage_history ADD CONSTRAINT chk_lifecycle_stage_history_action
       CHECK (action IN (${list(actions)}))`);
}

export async function up(knex) {
  await setChecks(knex, STAGES_V2, ACTIONS_V2, 'upgrade');
}

export async function down(knex) {
  await setChecks(knex, STAGES_V1, ACTIONS_V1, 'rollback');
}

export const STAGE_LISTS = { STAGES_V1, STAGES_V2, ACTIONS_V1, ACTIONS_V2 };
