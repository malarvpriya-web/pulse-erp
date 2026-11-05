// frontend/src/features/projects/shared/projectStage.js
//
// How a project's stage is shown (P1_PROJECT_LIFECYCLE_PLAN.md Phase 6).
//
// The backend derives every project's stage from its lifecycle
// (backend/src/shared/projectStages.js). Pages here only DISPLAY it: there is
// no client-side stage edit. A project with no lifecycle in its company has
// no stage — production_stage null, stage_source 'unavailable' — and is shown
// as "Unavailable stage", never placed in a stage column by guesswork.

/** Project Master stages, in order. 'created' is gone: a derived stage is never 'created'. */
export const PROJECT_STAGES = ['handover', 'dr_approval', 'procurement', 'production', 'clearing', 'dispatched'];

/** The filter / column key for projects whose stage cannot be derived. */
export const UNAVAILABLE = 'unavailable';

export const STAGE_META = {
  handover:    { label: 'Handover',          bg: '#dbeafe', color: '#2563eb' },
  dr_approval: { label: 'DR Approval',       bg: '#ede9fe', color: '#7c3aed' },
  procurement: { label: 'Procurement',       bg: '#ede9fe', color: '#6d28d9' },
  production:  { label: 'Production',        bg: '#e0e7ff', color: '#4338ca' },
  clearing:    { label: 'Clearing',          bg: '#e0f2fe', color: '#0891b2' },
  dispatched:  { label: 'Dispatched',        bg: '#d1fae5', color: '#16a34a' },
  [UNAVAILABLE]: { label: 'Unavailable stage', bg: '#f3f4f6', color: '#6b7280' },
};

/** The stage a project row shows: key, label, colours, and why. */
export function projectStageOf(row) {
  const key = row?.stage_source === UNAVAILABLE || !STAGE_META[row?.production_stage] || !row?.production_stage
    ? UNAVAILABLE : row.production_stage;
  const meta = STAGE_META[key];
  const why = key === UNAVAILABLE
    ? 'This project has no lifecycle in its company, so its stage cannot be shown. It is not guessed.'
    : row?.stage_source === 'lifecycle_closed'
      ? `From the project's last lifecycle (${row?.lifecycle_status || 'closed'})`
      : 'From the project\'s lifecycle';
  return { key, label: meta.label, bg: meta.bg, color: meta.color, why };
}

/** Labels for lifecycle gate keys (backend lifecycleGates.service.js). */
export const GATE_LABELS = {
  engineering_ready:      'Design released (active BOM, no open ECN)',
  bom_materials_received: 'BOM materials received on project POs',
  production_ready:       'All production orders completed',
  fat_passed:             'FAT passed for every production order',
  no_open_ncrs:           'No open NCRs',
  no_open_punch_points:   'No open punch points',
  dispatch_recorded:      'Delivered shipment recorded',
  installation_accepted:  'Installation completed and customer-accepted',
  commissioning_done:     'Commissioning signed off and certified',
  sat_completed:          'SAT passed and client signed off',
};
export const gateLabel = (k) => GATE_LABELS[k] || k.replace(/_/g, ' ');

const BLOCKER_LABELS = {
  open_tasks: 'open task(s)',
  unbilled_milestones: 'unbilled billing milestone(s)',
  pending_timesheets: 'pending timesheet(s)',
};
export const blockerText = (b) => `${b.count} ${BLOCKER_LABELS[b.type] || b.type.replace(/_/g, ' ')}`;

/**
 * A useful message for a failed project / lifecycle request, keyed on the
 * backend's codes. `what` names the action ("advance", "save"...).
 */
export function lifecycleErrorMessage(err, what = 'complete this action') {
  const status = err?.response?.status;
  const d = err?.response?.data || {};
  switch (d.code) {
    case 'STAGE_FOLLOWS_LIFECYCLE':
      return 'The project stage follows its lifecycle and cannot be set here. Open the lifecycle and advance it through its gates.';
    case 'GATE_NOT_SATISFIED':
      return `Not ready to move on — still needed: ${(d.failing || []).map(gateLabel).join('; ') || 'gate evidence'}.`;
    case 'INVALID_TRANSITION':
      return d.error || 'That stage change is not allowed.';
    case 'REASON_REQUIRED':
      return d.error || 'A reason is required.';
    case 'PROJECT_CLOSED':
      return d.error || 'The project is closed; reopen the project first.';
    case 'NOT_ON_HOLD':
    case 'NOT_ACTIVE':
    case 'NOT_OPEN':
    case 'NOT_CLOSED':
    case 'NOT_AT_CLOSURE':
    case 'FINAL_STAGE':
    case 'LEGACY_STAGE':
      return d.error;
    case 'LIFECYCLE_EXISTS':
      return d.error || 'Another lifecycle is already open for this project or order.';
    case 'CLOSURE_BLOCKED':
      return `The project is not ready to close: ${(d.blockers || []).map(blockerText).join(', ')}.`;
    default:
      break;
  }
  if (status === 403) return `You don't have permission to ${what}.`;
  if (status === 404) return 'Not found — it may belong to another company or have been removed.';
  if (d.errors?.[0]?.message) return d.errors[0].message;
  return d.error || d.message || `Could not ${what}. Please try again.`;
}
