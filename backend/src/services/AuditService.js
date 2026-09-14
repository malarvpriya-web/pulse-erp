/**
 * AuditService — Phase 2 platform layer
 *
 * Central writer for immutable audit log entries.
 * All calls are fire-and-forget: a failure in the audit pipeline
 * never surfaces to the caller or breaks the primary write path.
 *
 * Exported:
 *   logAudit   — write one audit entry
 *
 * Standard action values:
 *   'create' | 'update' | 'delete' | 'approve' | 'reject' | 'workflow_transition'
 */

import auditRepository from '../modules/audit/repositories/audit.repository.js';

/**
 * Write an audit log entry (non-blocking).
 *
 * @param {object}            params
 * @param {number|null}       params.userId      — actor's user ID (req.user.userId)
 * @param {string}            params.module      — module name ('leaves', 'projects', …)
 * @param {number|string|null} params.recordId   — PK of the affected record
 * @param {string}            params.recordType  — entity label ('leave_application', 'project', …)
 * @param {string}            params.action      — 'create' | 'update' | 'delete' | 'approve' | 'reject' | 'workflow_transition'
 * @param {object|null}       [params.oldData]   — full record snapshot before change (null for create)
 * @param {object|null}       [params.newData]   — full record snapshot after change (null for delete)
 * @param {object|null}       [params.req]       — Express request (for ip/user-agent); optional
 */
export function logAudit({
  userId,
  module,
  recordId,
  recordType,
  action,
  oldData    = null,
  newData    = null,
  req        = null,
  company_id = null,
}) {
  // The module name is the key every audit query groups by, and it had drifted:
  // audit_logs holds `CRM` next to `crm`, `Finance` next to `finance`,
  // `Announcements`, `Commissioning` — and twelve rows whose module_name is a
  // NUMBER (3, 5, 6, 8, 9, 10, 12), written by a caller that passed arguments
  // positionally into an options-object signature. Normalising here means one
  // spelling per module from now on, and a non-string is caught rather than
  // stored.
  const moduleName = typeof module === 'string' && module.trim()
    ? module.trim().toLowerCase()
    : null;
  if (moduleName === null) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN', event: 'audit_bad_module',
      received: module, action, recordId,
      message: 'logAudit called with a non-string module — check for a positional call.',
    }));
  }

  // Lets auditMutations() stand down for handlers that log explicitly, so a
  // careful write is not counted twice while a careless one is counted once.
  if (req) req._auditLogged = true;

  // The before-image, if a `captureBefore(table)` on this route fetched one and
  // the caller did not supply its own. A handler that already snapshots the row
  // keeps its version — it usually has more context than a bare SELECT *; one
  // that passes nothing now still records what the value changed FROM, which is
  // the half of an audit trail that answers "what happened".
  const before = oldData ?? req?._auditBefore ?? null;

  auditRepository.create({
    user_id       : userId ?? null,
    module_name   : moduleName ?? 'unknown',
    action_type   : action,
    reference_id  : recordId != null ? String(recordId) : null,
    reference_type: recordType,
    old_data_json : before,
    new_data_json : newData,
    ip_address    : req?.ip ?? null,
    user_agent    : req?.get?.('user-agent') ?? null,
    company_id    : company_id ?? req?.scope?.company_id ?? null,
  }).catch(err => console.error('[audit]', action, module, recordId, '—', err.message));
}
