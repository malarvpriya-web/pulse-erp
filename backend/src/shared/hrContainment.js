/**
 * HR P0 containment switches — HR_P0_REMEDIATION_DESIGN_2026-11-03.md, Appendix A.
 *
 * Each switch is ON (contained) unless its environment variable is set to
 * "off", so a deployment that never heard of these variables is contained,
 * and reversing a step is one variable plus a restart — no code change.
 * The switches are read on every call (not at import), so tests and a
 * running process see the same value.
 *
 *   HR_CONTAINMENT_FNF=off          C1 + C3: F&F auto-compute, approve and pay
 *   HR_CONTAINMENT_EXIT_STATUS=off  C6: exit status only through the exit workflow
 *
 * These are temporary. They are removed when the permanent fixes in the design
 * (P0-1/P0-3 F&F engine and Finance lifecycle, P0-6 exit state machine) ship.
 */
const isOff = (name) => String(process.env[name] ?? '').trim().toLowerCase() === 'off';

/** C1 + C3: the F&F engine's figures are wrong (F-01..F-03) and HR alone can pay (F-05). */
export const fnfSettlementSuspended = () => !isOff('HR_CONTAINMENT_FNF');

/** C6: an employee reaches an exit status only through the exit workflow (F-08). */
export const exitStatusWorkflowOnly = () => !isOff('HR_CONTAINMENT_EXIT_STATUS');

export const FNF_SUSPENDED_MESSAGE =
  'F&F settlement approval and payment are suspended while the settlement calculation is corrected. ' +
  'Figures shown are provisional and must not be used for payment.';

/** The 423 body every suspended F&F action returns. */
export const fnfSuspendedBody = () => ({
  error: FNF_SUSPENDED_MESSAGE,
  code: 'FNF_SETTLEMENT_SUSPENDED',
});
