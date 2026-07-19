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
  auditRepository.create({
    user_id       : userId ?? null,
    module_name   : module,
    action_type   : action,
    reference_id  : recordId != null ? String(recordId) : null,
    reference_type: recordType,
    old_data_json : oldData,
    new_data_json : newData,
    ip_address    : req?.ip ?? null,
    user_agent    : req?.get?.('user-agent') ?? null,
    company_id    : company_id ?? req?.scope?.company_id ?? null,
  }).catch(err => console.error('[audit]', action, module, recordId, '—', err.message));
}
