// backend/src/shared/projectStages.js
//
// The ONE production-lifecycle stage model (P1_PROJECT_LIFECYCLE_PLAN.md
// Phase 4). lifecycle_instances.current_stage + lifecycle_stage_history are the
// authority for where a project is in production. Everything else reads this:
//
//  - projects.status is the ADMINISTRATIVE state (planning / active / on_hold /
//    completed / cancelled). It is not a stage and is never derived from one.
//  - projects.production_stage is a DISPLAY value derived from the lifecycle
//    stage (derivedProductionStage below). Writing it from the lifecycle, and
//    retiring its free edit, is Phase 5 (it needs the legacy reconciliation).
//  - Service / AMC are downstream workflows on the delivered equipment, not
//    stages. 'service' and 'amc' stay valid in the database only so history
//    that used them stays readable; nothing moves into them.
//
// Reserved stages are part of the vocabulary (the database accepts them) but
// are skipped by every transition until the business defines them:
//  - clearing: the MIS "Clearing" screen's meaning is undecided
//    (LEGACY_MIS_TO_PULSE_AUDIT.md §12 Q1 — QA dispatch clearance, customer
//    inspection clearance, or customs/finance clearance). Today it exists only
//    as a Project Master production_stage value with no data or gate.
//  - pre_commissioning: no checklist or acceptance criteria are defined.
//
// The database list (chk_lifecycle_instances_stage) is set by migration
// 20261014000003_lifecycle_stage_model.js and must contain every key here;
// lifecycleStages.test asserts that.

export const LIFECYCLE_STAGES = Object.freeze([
  { key: 'order',             label: 'Order / Handover',                productionStage: 'handover' },
  { key: 'design',            label: 'Design / Engineering',            productionStage: 'dr_approval' },
  { key: 'procurement',       label: 'Procurement',                     productionStage: 'procurement' },
  { key: 'production',        label: 'Production',                      productionStage: 'production' },
  { key: 'testing',           label: 'Testing / FAT',                   productionStage: 'production' },
  { key: 'clearing',          label: 'Clearing',                        productionStage: 'clearing',
    reserved: 'Business definition of Clearing is not decided (audit §12 Q1)' },
  { key: 'dispatch',          label: 'Dispatch',                        productionStage: 'dispatched' },
  { key: 'installation',      label: 'Installation',                    productionStage: 'dispatched' },
  { key: 'pre_commissioning', label: 'Pre-commissioning',               productionStage: 'dispatched',
    reserved: 'Pre-commissioning checklist and acceptance criteria are not defined' },
  { key: 'commissioning',     label: 'Commissioning',                   productionStage: 'dispatched' },
  { key: 'sat',               label: 'SAT (Site Acceptance)',           productionStage: 'dispatched' },
  { key: 'closure',           label: 'Closure',                         productionStage: 'dispatched' },
].map(Object.freeze));

/** Old stage values kept readable for history; never a transition target. */
export const LEGACY_STAGES = Object.freeze(['service', 'amc']);

/** Every value the database accepts for lifecycle_instances.current_stage. */
export const ALL_STAGE_KEYS = Object.freeze([...LIFECYCLE_STAGES.map(s => s.key), ...LEGACY_STAGES]);

/** The path transitions actually walk: the stages, in order, minus reserved ones. */
export const ACTIVE_PATH = Object.freeze(LIFECYCLE_STAGES.filter(s => !s.reserved).map(s => s.key));

/** Lifecycle statuses (chk_lifecycle_instances_status) and which of them are "open". */
export const LIFECYCLE_STATUSES = Object.freeze(['active', 'on_hold', 'completed', 'cancelled']);
export const OPEN_STATUSES = Object.freeze(['active', 'on_hold']);

/** Lifecycle actions written to lifecycle_stage_history.action. */
export const HISTORY_ACTIONS = Object.freeze(['advance', 'rollback', 'hold', 'resume', 'complete', 'cancel', 'reopen']);

/** The final stage; a lifecycle there can be completed. */
export const FINAL_STAGE = 'closure';

/**
 * Gate that must pass to ENTER a stage, by target stage. One map: this is the
 * whole forward-transition rule set (see lifecycleGates.service.js for what
 * each gate checks).
 */
export const ENTRY_GATES = Object.freeze({
  design:        [],
  procurement:   ['engineering_ready'],
  production:    ['bom_materials_received'],
  testing:       ['production_ready'],
  dispatch:      ['fat_passed', 'no_open_ncrs', 'no_open_punch_points'],
  installation:  ['dispatch_recorded'],
  commissioning: ['installation_accepted'],
  sat:           ['commissioning_done'],
  closure:       ['sat_completed'],
});

export const stageOf = (key) => LIFECYCLE_STAGES.find(s => s.key === key) || null;
export const isLegacyStage = (key) => LEGACY_STAGES.includes(key);

const ORDER = LIFECYCLE_STAGES.map(s => s.key);

/**
 * The only stage a lifecycle may advance to from `current`, or null (final,
 * legacy or unknown). Reserved stages are skipped; a lifecycle that somehow
 * sits on one moves on to the next active stage.
 */
export function nextStage(current) {
  const i = ORDER.indexOf(current);
  if (i < 0) return null;
  return ORDER.slice(i + 1).find(k => ACTIVE_PATH.includes(k)) ?? null;
}

/** Active-path stages before `current` (valid rollback targets), nearest last. */
export function earlierStages(current) {
  const i = ORDER.indexOf(current);
  return i <= 0 ? [] : ORDER.slice(0, i).filter(k => ACTIVE_PATH.includes(k));
}

/** Project Master's display value for a lifecycle stage (null for unknown / legacy). */
export function derivedProductionStage(stage) {
  return stageOf(stage)?.productionStage ?? null;
}

// ── Project Master stage, derived (Phase 5) ─────────────────────────────────
//
// projects.production_stage is no longer an authority: every read that shows
// a project's stage derives it from the project's lifecycle with the mapping
// above, in SQL generated from LIFECYCLE_STAGES so there is one mapping.
//
// The lifecycle that represents a project is its open one (at most one —
// ux_lifecycle_open_per_project), else its most recent closed one; only a
// lifecycle in the project's OWN company counts. With none, the stage is
// unavailable: production_stage NULL and stage_source 'unavailable' — never a
// guessed stage. The old stored column is returned as stored_production_stage
// so nothing is hidden while the history is reconciled.

/** stage_source values on project payloads. */
export const STAGE_SOURCES = Object.freeze({
  LIFECYCLE: 'lifecycle',                 // from the open lifecycle
  LIFECYCLE_CLOSED: 'lifecycle_closed',   // from the latest completed / cancelled lifecycle
  UNAVAILABLE: 'unavailable',             // no lifecycle in the project's company
});

/** SQL: the derived Project Master stage for a lifecycle stage expression. */
export function productionStageCaseSql(stageExpr) {
  return `(CASE ${stageExpr} ${LIFECYCLE_STAGES.map(s => `WHEN '${s.key}' THEN '${s.productionStage}'`).join(' ')} ELSE NULL END)`;
}

/** SQL: LEFT JOIN LATERAL of the lifecycle that represents project `p` (alias `as`). */
export function projectLifecycleJoinSql(p = 'p', as = 'plc') {
  return `LEFT JOIN LATERAL (
      SELECT l.id, l.current_stage, l.status
        FROM lifecycle_instances l
       WHERE l.project_id = ${p}.id AND l.company_id IS NOT DISTINCT FROM ${p}.company_id
       ORDER BY (l.status IN (${OPEN_STATUSES.map(s => `'${s}'`).join(',')})) DESC, l.id DESC
       LIMIT 1) ${as} ON true`;
}

/**
 * SQL select-list: lifecycle_id, lifecycle_stage, lifecycle_status,
 * stored_production_stage, stage_source and the derived production_stage.
 * Put it AFTER `p.*`: the derived production_stage then replaces the stored
 * column in the row object (node-pg keeps the last column of a name).
 */
export function projectStageColumnsSql(p = 'p', as = 'plc') {
  return `${as}.id AS lifecycle_id, ${as}.current_stage AS lifecycle_stage, ${as}.status AS lifecycle_status,
      ${p}.production_stage AS stored_production_stage,
      (CASE WHEN ${as}.id IS NULL THEN '${STAGE_SOURCES.UNAVAILABLE}'
            WHEN ${as}.status IN (${OPEN_STATUSES.map(s => `'${s}'`).join(',')}) THEN '${STAGE_SOURCES.LIFECYCLE}'
            ELSE '${STAGE_SOURCES.LIFECYCLE_CLOSED}' END) AS stage_source,
      ${productionStageCaseSql(`${as}.current_stage`)} AS production_stage`;
}

/** The model as served by GET /lifecycle/stages. */
export function stageModel() {
  return {
    stages: LIFECYCLE_STAGES.map(s => ({
      key: s.key, label: s.label, reserved: Boolean(s.reserved), reserved_reason: s.reserved || null,
      derived_production_stage: s.productionStage, entry_gates: ENTRY_GATES[s.key] || [],
    })),
    active_path: ACTIVE_PATH,
    legacy_stages: LEGACY_STAGES,
    statuses: LIFECYCLE_STATUSES,
    open_statuses: OPEN_STATUSES,
    final_stage: FINAL_STAGE,
  };
}
