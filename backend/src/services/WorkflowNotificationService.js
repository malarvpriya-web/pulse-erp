import pool from '../config/db.js';
import { flags } from '../config/featureFlags.js';
import { increment } from '../config/metrics.js';
import { getCorrelationId } from '../middlewares/correlationContext.js';

/**
 * Event-to-notification mapping.
 *
 * Each entry defines:
 *   notification_type — display class for the UI badge/icon
 *   title             — short heading (function of context)
 *   message           — body text (function of context)
 *   notify            — which party receives it: 'submitter' or 'approver'
 *
 * | Event     | Recipient  | Trigger point                             |
 * |-----------|------------|-------------------------------------------|
 * | submitted | submitter  | workflow instance created / approval sent |
 * | approved  | submitter  | step actioned as 'approve'                |
 * | rejected  | submitter  | step actioned as 'reject'                 |
 * | escalated | approver   | step actioned as 'escalate'               |
 * | overdue   | approver   | SLA cron detects past-due instance        |
 */
export const EVENT_MAP = {
  submitted: {
    notification_type: 'approval',
    title: (ctx) => `${ctx.module} Submitted`,
    message: (ctx) =>
      `Your ${ctx.module} request (#${ctx.recordId}) has been submitted and is pending approval.`,
    notify: 'submitter',
  },
  approved: {
    notification_type: 'success',
    title: (ctx) => `${ctx.module} Approved`,
    message: (ctx) =>
      `Your ${ctx.module} request (#${ctx.recordId}) has been approved.`,
    notify: 'submitter',
  },
  rejected: {
    notification_type: 'warning',
    title: (ctx) => `${ctx.module} Rejected`,
    message: (ctx) =>
      ctx.comments
        ? `Your ${ctx.module} request (#${ctx.recordId}) was rejected. Reason: ${ctx.comments}`
        : `Your ${ctx.module} request (#${ctx.recordId}) has been rejected.`,
    notify: 'submitter',
  },
  escalated: {
    notification_type: 'alert',
    title: (ctx) => `${ctx.module} Escalated to You`,
    message: (ctx) =>
      `A ${ctx.module} request (#${ctx.recordId}) has been escalated to you for approval.`,
    notify: 'approver',
  },
  overdue: {
    notification_type: 'warning',
    title: (ctx) => `${ctx.module} Overdue`,
    message: (ctx) =>
      `A ${ctx.module} request (#${ctx.recordId}) is overdue and awaiting your action.`,
    notify: 'approver',
  },
  order_confirmed: {
    notification_type: 'success',
    title: () => 'Sales Order Confirmed',
    message: (ctx) => `Sales Order #${ctx.recordId} has been confirmed and is ready for processing.`,
    notify: 'submitter',
  },
  dispatched: {
    notification_type: 'info',
    title: () => 'Order Dispatched',
    message: (ctx) => `Sales Order #${ctx.recordId} has been dispatched.`,
    notify: 'submitter',
  },
  lifecycle_advanced: {
    notification_type: 'info',
    title: (ctx) => `Lifecycle Stage: ${ctx.comments || 'Advanced'}`,
    message: (ctx) => `Lifecycle #${ctx.recordId} has moved to the next stage.`,
    notify: 'submitter',
  },
  amc_created: {
    notification_type: 'success',
    title: () => 'AMC Contract Created',
    message: (ctx) => `AMC Contract #${ctx.recordId} has been created successfully.`,
    notify: 'submitter',
  },
};

async function _insert(userId, title, message, moduleName, recordId, notificationType) {
  try {
    await pool.query(
      `INSERT INTO notifications
         (user_id, title, message, module_name, reference_id, notification_type, is_read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, NOW())`,
      [userId, title, message, moduleName, recordId, notificationType]
    );
  } catch (err) {
    increment('notification_failures');
    console.error(`[WorkflowNotification] insert failed cid=${getCorrelationId()} user=${userId} module=${moduleName} error=${err.message}`);
  }
}

/**
 * Fire-and-forget workflow event notification.
 *
 * Guaranteed not to throw or delay the calling transaction.
 * Uses setImmediate so the DB insert runs after the current call stack unwinds.
 *
 * @param {string} event - 'submitted' | 'approved' | 'rejected' | 'escalated' | 'overdue'
 * @param {object} ctx
 * @param {string}  ctx.module            - human-readable module label (e.g. 'Leave', 'Purchase Order')
 * @param {number}  ctx.recordId          - entity / record id
 * @param {number}  [ctx.submitterUserId] - user who originated the request
 * @param {number}  [ctx.approverUserId]  - target approver (for escalated / overdue)
 * @param {string}  [ctx.comments]        - rejection reason
 */
export function notifyWorkflowEvent(event, ctx) {
  if (!flags.NOTIFICATION_ENGINE_ENABLED) return; // notifications suppressed
  const def = EVENT_MAP[event];
  if (!def) return;

  setImmediate(async () => {
    if (!flags.NOTIFICATION_ENGINE_ENABLED) return; // re-check: flag may have changed since scheduling
    const targetUserId =
      def.notify === 'approver' ? ctx.approverUserId : ctx.submitterUserId;
    if (!targetUserId) return;

    await _insert(
      targetUserId,
      def.title(ctx),
      def.message(ctx),
      ctx.module,
      ctx.recordId,
      def.notification_type
    );
  });
}
