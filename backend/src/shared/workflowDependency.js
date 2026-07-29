// workflowDependency.js — Workflow Dependency Engine (Priority 7).
//
// "No step should be skippable if a required predecessor is incomplete."
// Deliberately not a generic declarative rules/config system — this project
// has enough of those already (WorkflowService.js + the Approval Center both
// under-adopted per the automation audit). Just a consistent 409 error shape
// so every dependency check in the app looks the same to a caller, the same
// way travelApprovalAuthz.js/renewalApproval.js gave the last two priorities
// a shared primitive instead of a bespoke check per call site.
export function dependencyBlocked(res, { label, reason }) {
  return res.status(409).json({
    error: `Cannot proceed — ${label} is not complete: ${reason}`,
    code: 'PREREQUISITE_INCOMPLETE',
  });
}
