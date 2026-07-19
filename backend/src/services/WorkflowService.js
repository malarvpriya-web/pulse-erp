/**
 * WorkflowService — Phase 2 platform layer
 *
 * Manages multi-step approval workflows.
 * Priority: user-configured workflow > passthrough (backward compat).
 *
 * Exported functions:
 *   initiateWorkflow    — start a workflow instance for an entity
 *   advanceWorkflow     — action a step (approve/reject/escalate)
 *   getWorkflowStatus   — current instance for a module+entity
 *   getPendingApprovals — items awaiting action by a role
 *   cancelWorkflow      — void a running instance
 *
 * Exported error classes (all carry .code and .statusHint):
 *   WorkflowError              — base class
 *   InvalidTransitionError     — no valid edge / backward sequence jump (400)
 *   UnauthorizedTransitionError — actor role doesn't match step role_required (403)
 *   WorkflowClosedError        — instance is already approved/rejected/cancelled (409)
 */

import pool from '../config/db.js';
import { logAudit } from './AuditService.js';
import { notifyWorkflowEvent } from './WorkflowNotificationService.js';
import { flags } from '../config/featureFlags.js';
import { increment } from '../config/metrics.js';
import { getCorrelationId } from '../middlewares/correlationContext.js';

// ── Typed error classes ───────────────────────────────────────────────────────

export class WorkflowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

export class InvalidTransitionError extends WorkflowError {
  constructor(message) {
    super(message, 'INVALID_TRANSITION');
    this.name = 'InvalidTransitionError';
    this.statusHint = 400;
  }
}

export class UnauthorizedTransitionError extends WorkflowError {
  constructor(message) {
    super(message, 'UNAUTHORIZED_TRANSITION');
    this.name = 'UnauthorizedTransitionError';
    this.statusHint = 403;
  }
}

export class WorkflowClosedError extends WorkflowError {
  constructor(message) {
    super(message, 'WORKFLOW_CLOSED');
    this.name = 'WorkflowClosedError';
    this.statusHint = 409;
  }
}

// ── Initiate ──────────────────────────────────────────────────────────────────

/**
 * Starts a new workflow instance for the given entity.
 * Finds the active workflow for `module` and creates an instance at step 1.
 * Returns the new instance record, or null if no workflow is configured.
 */
export async function initiateWorkflow(module, entityId, entityType, initiatedBy) {
  if (!flags.WORKFLOW_ENGINE_ENABLED) return null; // passthrough — behaves as "no workflow configured"
  const { rows: wfRows } = await pool.query(
    `SELECT w.id   AS workflow_id,
            ws.id  AS first_step_id
       FROM workflows w
       JOIN workflow_steps ws
         ON ws.workflow_id = w.id
        AND ws.is_initial = true
      WHERE w.module = $1
        AND w.is_active = true
      ORDER BY w.id ASC
      LIMIT 1`,
    [module]
  );

  if (!wfRows.length) return null; // No workflow configured — passthrough

  const { workflow_id, first_step_id } = wfRows[0];

  const { rows: [instance] } = await pool.query(
    `INSERT INTO workflow_instances
       (workflow_id, module, entity_id, entity_type, status, current_step_id, initiated_by)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6)
     RETURNING *`,
    [workflow_id, module, entityId, entityType, first_step_id, initiatedBy || null]
  );

  await pool.query(
    `INSERT INTO workflow_instance_steps (instance_id, step_id, status, start_time)
     VALUES ($1, $2, 'pending', NOW())`,
    [instance.id, first_step_id]
  );

  notifyWorkflowEvent('submitted', {
    module: module,
    recordId: entityId,
    submitterUserId: initiatedBy,
  });

  return instance;
}

// ── Advance ───────────────────────────────────────────────────────────────────

/**
 * Actions the current step of a workflow instance.
 *
 * @param {number}      instanceId  — workflow_instances.id
 * @param {string}      action      — 'approve' | 'reject' | 'escalate'
 * @param {number}      actorUserId — user performing the action
 * @param {string}      comments    — optional note
 * @param {string|null} actorRole   — caller's role code; pass null to skip role
 *                                    enforcement (backward-compat default)
 * @returns {{ status, instanceId, outcome }}
 *
 * @throws {WorkflowClosedError}        — instance is already terminal
 * @throws {InvalidTransitionError}     — no edge from current step + action,
 *                                        or transition goes backward in sequence
 * @throws {UnauthorizedTransitionError}— actorRole doesn't match step assignee_role
 */
export async function advanceWorkflow(instanceId, action, actorUserId, comments = '', actorRole = null) {
  if (!flags.WORKFLOW_ENGINE_ENABLED) return { status: 'passthrough', instanceId, outcome: 'passthrough' };
  // 1. Fetch instance + current step details in one query
  const { rows: [inst] } = await pool.query(
    `SELECT wi.*,
            ws.assignee_role  AS current_step_role,
            ws.sequence_order AS current_step_order,
            ws.step_name      AS current_step_name
       FROM workflow_instances wi
       LEFT JOIN workflow_steps ws ON ws.id = wi.current_step_id
      WHERE wi.id = $1`,
    [instanceId]
  );

  if (!inst) throw new Error(`Workflow instance ${instanceId} not found`);

  if (['approved', 'rejected', 'cancelled'].includes(inst.status)) {
    throw new WorkflowClosedError(
      `Workflow instance ${instanceId} is already ${inst.status}`
    );
  }

  // 2. Look up the transition — scoped to this workflow to prevent cross-workflow misuse
  const { rows: [trans] } = await pool.query(
    `SELECT wt.*,
            to_ws.sequence_order AS to_step_order
       FROM workflow_transitions wt
       LEFT JOIN workflow_steps to_ws ON to_ws.id = wt.to_step_id
      WHERE wt.from_step_id = $1
        AND wt.action       = $2
        AND wt.workflow_id  = $3`,
    [inst.current_step_id, action, inst.workflow_id]
  );

  if (!trans) {
    throw new InvalidTransitionError(
      `No transition found for action '${action}' from step ${inst.current_step_id}`
    );
  }

  // 3. Sequence integrity — to_step must be strictly later than from_step
  //    (prevents backward jumps; terminal steps can have any order >= from_step)
  if (
    trans.to_step_id != null &&
    inst.current_step_order != null &&
    trans.to_step_order != null &&
    trans.to_step_order <= inst.current_step_order
  ) {
    throw new InvalidTransitionError(
      `Transition '${action}' would move backward: ` +
      `to sequence_order ${trans.to_step_order} is not after ${inst.current_step_order}`
    );
  }

  // 4. Role enforcement — skipped when actorRole is null (backward compat)
  if (actorRole !== null && inst.current_step_role && actorRole !== inst.current_step_role) {
    throw new UnauthorizedTransitionError(
      `Step '${inst.current_step_name}' requires role '${inst.current_step_role}'; ` +
      `actor has role '${actorRole}'`
    );
  }

  // 5. Execute within a transaction — record SLA timestamps
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const stepStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action;

    // Close current step: record end_time for SLA duration calculation
    await client.query(
      `UPDATE workflow_instance_steps
          SET status      = $1,
              actioned_by = $2,
              actioned_at = NOW(),
              end_time    = NOW(),
              comments    = $3
        WHERE instance_id = $4
          AND step_id     = $5
          AND status      = 'pending'`,
      [stepStatus, actorUserId, comments, instanceId, inst.current_step_id]
    );

    let newStatus;
    if (trans.to_step_id) {
      // Open next step: record start_time so SLA clock starts immediately
      await client.query(
        `INSERT INTO workflow_instance_steps (instance_id, step_id, status, start_time)
         VALUES ($1, $2, 'pending', NOW())`,
        [instanceId, trans.to_step_id]
      );
      await client.query(
        `UPDATE workflow_instances
            SET current_step_id = $1,
                status          = $2
          WHERE id = $3`,
        [trans.to_step_id, trans.outcome, instanceId]
      );
      newStatus = trans.outcome;
    } else {
      // Terminal step — complete the instance
      newStatus = trans.outcome;
      await client.query(
        `UPDATE workflow_instances
            SET status          = $1,
                current_step_id = NULL,
                completed_at    = NOW()
          WHERE id = $2`,
        [newStatus, instanceId]
      );
    }

    await client.query('COMMIT');

    // Notify originator of the outcome — fire-and-forget, never fails the transaction
    if (action === 'approve' || action === 'reject') {
      notifyWorkflowEvent(action === 'approve' ? 'approved' : 'rejected', {
        module: inst.module,
        recordId: inst.entity_id,
        submitterUserId: inst.initiated_by,
        comments,
      });
    }

    logAudit({
      userId    : actorUserId,
      module    : inst.module ?? 'workflow',
      recordId  : inst.entity_id ?? instanceId,
      recordType: inst.entity_type ?? 'workflow_instance',
      action    : 'workflow_transition',
      oldData   : { step_id: inst.current_step_id, step_name: inst.current_step_name, status: inst.status },
      newData   : { action, outcome: trans.outcome, to_step_id: trans.to_step_id, new_status: newStatus, instance_id: instanceId },
    });
    return { status: newStatus, instanceId, outcome: trans.outcome };
  } catch (err) {
    await client.query('ROLLBACK');
    increment('workflow_transition_failures');
    console.error(`[WorkflowService] transition failed instanceId=${instanceId} action=${action} cid=${getCorrelationId()} error=${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * Returns the most recent workflow instance for a module+entity pair.
 * Includes the current step name and assignee role.
 */
export async function getWorkflowStatus(module, entityId) {
  if (!flags.WORKFLOW_ENGINE_ENABLED) return null;
  const { rows: [inst] } = await pool.query(
    `SELECT wi.*,
            ws.step_name     AS current_step_name,
            ws.assignee_role AS current_step_role,
            ws.step_type     AS current_step_type,
            wf.name          AS workflow_name
       FROM workflow_instances wi
       JOIN workflows          wf ON wf.id = wi.workflow_id
       LEFT JOIN workflow_steps ws ON ws.id = wi.current_step_id
      WHERE wi.module    = $1
        AND wi.entity_id = $2
      ORDER BY wi.created_at DESC
      LIMIT 1`,
    [module, entityId]
  );
  return inst || null;
}

// ── Pending approvals ─────────────────────────────────────────────────────────

/**
 * Returns all pending workflow steps assigned to a given role.
 * Route handlers enrich the entity details (leave / project / etc.) separately.
 */
export async function getPendingApprovals(roleCode) {
  if (!flags.WORKFLOW_ENGINE_ENABLED) return [];
  const { rows } = await pool.query(
    `SELECT
       wis.id          AS instance_step_id,
       wi.id           AS instance_id,
       wi.module,
       wi.entity_id,
       wi.entity_type,
       wi.status       AS instance_status,
       ws.step_name,
       ws.assignee_role,
       ws.sequence_order,
       wi.created_at   AS initiated_at,
       wis.created_at  AS step_assigned_at
     FROM workflow_instance_steps wis
     JOIN workflow_instances wi ON wi.id  = wis.instance_id
     JOIN workflow_steps     ws ON ws.id  = wis.step_id
    WHERE wis.status        = 'pending'
      AND ws.assignee_role  = $1
      AND wi.status NOT IN  ('approved', 'rejected', 'cancelled')
    ORDER BY wis.created_at ASC`,
    [roleCode]
  );
  return rows;
}

// ── Cancel ────────────────────────────────────────────────────────────────────

/**
 * Cancels a running workflow instance (e.g. when the leave is withdrawn).
 */
export async function cancelWorkflow(module, entityId, cancelledBy = null) {
  if (!flags.WORKFLOW_ENGINE_ENABLED) return false;
  const { rows } = await pool.query(
    `UPDATE workflow_instances
        SET status       = 'cancelled',
            completed_at = NOW()
      WHERE module    = $1
        AND entity_id = $2
        AND status NOT IN ('approved', 'rejected', 'cancelled')
     RETURNING id`,
    [module, entityId]
  );
  if (rows.length > 0) {
    logAudit({
      userId    : cancelledBy,
      module,
      recordId  : entityId,
      recordType: 'workflow_instance',
      action    : 'workflow_transition',
      oldData   : { status: 'pending' },
      newData   : { status: 'cancelled', instance_id: rows[0].id },
    });
  }
  return rows.length > 0;
}
