/**
 * In-process operational counters.
 *
 * Counters are process-lifetime integers (reset on restart).
 * They are safe to increment from concurrent async operations because
 * Node.js executes JavaScript on a single thread.
 *
 * Exposed counters
 * ─────────────────────────────────────────────────────────────
 * workflow_transition_failures  WorkflowService.advanceWorkflow ROLLBACK
 * validation_failures           ValidationEngineService.validate — any field error
 * rules_triggered               RuleEngineService.evaluateRules — per triggered rule
 * notification_failures         WorkflowNotificationService._insert catch
 */

const _counters = {
  workflow_transition_failures: 0,
  validation_failures:          0,
  rules_triggered:              0,
  notification_failures:        0,
};

/**
 * Increment a named counter by `by` (default 1).
 * Silently no-ops for unknown counter names — callers never need to guard.
 */
export function increment(name, by = 1) {
  if (Object.prototype.hasOwnProperty.call(_counters, name)) {
    _counters[name] += by;
  }
}

/**
 * Returns a shallow copy of all counters plus collection metadata.
 * Safe to serialize directly into a JSON response.
 */
export function snapshot() {
  return {
    ..._counters,
    process_uptime_s: Math.floor(process.uptime()),
    collected_at:     new Date().toISOString(),
  };
}
