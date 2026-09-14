import { flags } from '../config/featureFlags.js';
import { increment } from '../config/metrics.js';
import { getCorrelationId } from '../middlewares/correlationContext.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import pool from '../config/db.js';

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
    // New 'approval.submitted' rule (see 20260805000003 migration) — no
    // existing seeded rule matched: 'approval.pending' is approver-facing by
    // title/recipient_roles ('Approval Request Waiting' / ['approver']), and
    // this event notifies the submitter instead.
    event_key: 'approval.submitted',
    title: (ctx) => `${ctx.module} Submitted`,
    message: (ctx) =>
      `Your ${ctx.module} request (#${ctx.recordId}) has been submitted and is pending approval.`,
    notify: 'submitter',
  },
  approved: {
    notification_type: 'success',
    // notification_rules' seeded 'approval.approved' rule (channel in_app,email)
    // is generic across modules by design — it targets the same "your request
    // was approved" moment this event already is, regardless of which module
    // raised it. module_name/notification_type stay as-is (human label / UI
    // badge class, both relied on elsewhere) — event_key is the only thing
    // that borrows the generic key.
    event_key: 'approval.approved',
    title: (ctx) => `${ctx.module} Approved`,
    message: (ctx) =>
      `Your ${ctx.module} request (#${ctx.recordId}) has been approved.`,
    notify: 'submitter',
  },
  rejected: {
    notification_type: 'warning',
    event_key: 'approval.rejected', // see 'approved' above
    title: (ctx) => `${ctx.module} Rejected`,
    message: (ctx) =>
      ctx.comments
        ? `Your ${ctx.module} request (#${ctx.recordId}) was rejected. Reason: ${ctx.comments}`
        : `Your ${ctx.module} request (#${ctx.recordId}) has been rejected.`,
    notify: 'submitter',
  },
  escalated: {
    notification_type: 'alert',
    // Reuses 'approval.pending' — approver-facing "you have a pending
    // approval" already covers an escalated item landing in someone's queue;
    // not worth a third near-identical seeded row.
    event_key: 'approval.pending',
    title: (ctx) => `${ctx.module} Escalated to You`,
    message: (ctx) =>
      `A ${ctx.module} request (#${ctx.recordId}) has been escalated to you for approval.`,
    notify: 'approver',
  },
  overdue: {
    notification_type: 'warning',
    event_key: 'approval.pending', // see 'escalated' above
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
  goods_received: {
    notification_type: 'info',
    title: () => 'Goods Received',
    message: (ctx) => {
      const poNumber = ctx.context?.poNumber;
      return `Goods Receipt Note #${ctx.recordId} has been recorded${poNumber ? ` against PO ${poNumber}` : ''}.`;
    },
    notify: 'submitter',
  },
  leave_milestone_conflict: {
    notification_type: 'warning',
    // No seeded notification_rules row matches this — module-specific like
    // order_confirmed/dispatched/amc_created, push-only by the same reasoning.
    event_key: 'leave.milestone_conflict',
    title: () => 'Leave Conflicts With Project Milestone',
    message: (ctx) => {
      const c = ctx.context || {};
      return `${c.employee_name || 'An employee'}'s leave (${c.from || '?'} to ${c.to || '?'}) `
        + `overlaps a milestone on ${c.project_name || 'a project'}: ${c.milestones || ''}`;
    },
    notify: 'approver',
  },
  member_assigned: {
    notification_type: 'info',
    // Module-specific, no seeded notification_rules row — push-only, same as
    // order_confirmed/amc_created/leave_milestone_conflict.
    event_key: 'project.member_assigned',
    title: () => 'Added to Project Team',
    message: (ctx) => {
      const c = ctx.context || {};
      return `You've been added to ${c.projectName || 'a project'}${c.role ? ` as ${c.role}` : ''}.`;
    },
    notify: 'submitter',
  },
  milestone_completed: {
    notification_type: 'success',
    event_key: 'project.milestone_completed',
    title: () => 'Milestone Completed',
    message: (ctx) => {
      const c = ctx.context || {};
      return `Milestone "${c.milestoneTitle || ''}" on ${c.projectName || 'your project'} has been marked complete.`;
    },
    notify: 'submitter',
  },
};

// assigned_to/employee_id/manager_id/prepared_by etc. across this codebase FK
// employees, not users — notifications.user_id FKs users. Resolve the same way
// crm.routes.js's resolveEmployeeUserId() already does: users.employee_id first,
// falling back to a company_email match for logins that predate that column.
// Never rejects. This runs inside the detached setImmediate below, where a
// rejection has no request to fail and no caller to catch it — it surfaced only
// as an anonymous `[process] unhandledRejection` from server.js's process-level
// handler, with no correlation id, user, or module. It also ran under
// Promise.all, so one unresolvable recipient silently cost EVERY other
// recipient their notification. Degrading to null instead keeps the rest of the
// batch intact and routes the failure into the same counter healthMonitor
// already watches.
async function resolveEmployeeUserId(employeeId) {
  if (!employeeId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT u.id
         FROM employees e
         JOIN users u ON (u.employee_id = e.id OR LOWER(u.email) = LOWER(e.company_email))
        WHERE e.id = $1 AND u.is_active = true
        ORDER BY (u.employee_id = e.id) DESC
        LIMIT 1`,
      [employeeId]
    );
    return rows[0]?.id || null;
  } catch (err) {
    increment('notification_failures');
    console.error(`[WorkflowNotification] recipient resolve failed cid=${getCorrelationId()} employee=${employeeId} error=${err.message}`);
    return null;
  }
}

async function _insert(userId, title, message, moduleName, recordId, notificationType, eventKey) {
  try {
    await notificationsRepository.create({
      user_id: userId,
      title,
      message,
      module_name: moduleName,
      reference_id: recordId,
      notification_type: notificationType,
      event_key: eventKey,
    });
  } catch (err) {
    increment('notification_failures');
    console.error(`[WorkflowNotification] insert failed cid=${getCorrelationId()} user=${userId} module=${moduleName} error=${err.message}`);
  }
}

/**
 * Fire-and-forget workflow event notification.
 *
 * Guaranteed not to throw or delay the calling transaction — every layer inside
 * the setImmediate (recipient resolution, insert, and a catch-all around both)
 * swallows its own errors into the `notification_failures` counter, which
 * healthMonitor.cron.js alerts on. Delivery is therefore best-effort and
 * observable, never fatal: callers must not rely on a notification having been
 * created, and must not await this.
 * Uses setImmediate so the DB insert runs after the current call stack unwinds.
 * NOTE for tests: that deferral outlives the HTTP response, so any test file
 * exercising a route that calls this MUST mock this module — otherwise the
 * trailing pool.query lands during the *next* test and consumes its mocks.
 *
 * @param {string} event - one of EVENT_MAP's keys, e.g. 'submitted' | 'approved' |
 *                          'rejected' | 'escalated' | 'overdue' | 'goods_received'.
 *                          An unrecognized key is a silent no-op (see `def` check
 *                          below) — always verify the key exists in EVENT_MAP.
 * @param {object} ctx
 * @param {string}  ctx.module            - human-readable module label (e.g. 'Leave', 'Purchase Order')
 * @param {number}  ctx.recordId          - entity / record id
 * @param {number}  [ctx.submitterUserId] - user who originated the request
 * @param {number}  [ctx.approverUserId]  - target approver (for escalated / overdue)
 * @param {number[]} [ctx.recipientIds]   - explicit recipient list (employees.id
 *                                          values, as module records carry them —
 *                                          resolved to a login below). When given,
 *                                          this overrides submitterUserId/approverUserId
 *                                          entirely, since the caller already knows
 *                                          exactly who should be notified.
 * @param {string}  [ctx.comments]        - rejection reason
 */
export function notifyWorkflowEvent(event, ctx) {
  if (!flags.NOTIFICATION_ENGINE_ENABLED) return; // notifications suppressed
  const def = EVENT_MAP[event];
  if (!def) return;

  // Backstop. Nothing outside this callback can catch it: setImmediate detaches
  // it from the request, and every caller invokes notifyWorkflowEvent
  // fire-and-forget. Without this, a throw from def.title()/def.message() on a
  // malformed ctx escaped as an anonymous unhandled rejection. _insert and
  // resolveEmployeeUserId guard themselves, so this should stay unreachable —
  // if it fires, the template functions are the thing to look at.
  setImmediate(async () => {
    try {
      if (!flags.NOTIFICATION_ENGINE_ENABLED) return; // re-check: flag may have changed since scheduling

      let targetUserIds;
      if (Array.isArray(ctx.recipientIds) && ctx.recipientIds.length) {
        const resolved = await Promise.all(ctx.recipientIds.filter(Boolean).map(resolveEmployeeUserId));
        targetUserIds = [...new Set(resolved.filter(Boolean))];
      } else {
        const single = def.notify === 'approver' ? ctx.approverUserId : ctx.submitterUserId;
        targetUserIds = single ? [single] : [];
      }
      if (!targetUserIds.length) return;

      for (const targetUserId of targetUserIds) {
        await _insert(
          targetUserId,
          def.title(ctx),
          def.message(ctx),
          ctx.module,
          ctx.recordId,
          def.notification_type,
          def.event_key
        );
      }
    } catch (err) {
      // Count first: it is the part healthMonitor reads, and it cannot throw.
      increment('notification_failures');
      // Then log defensively. Whatever made the body throw may well be a getter
      // on ctx itself, and a catch block that re-throws converts a logged
      // failure straight back into the unhandled rejection this backstop exists
      // to prevent — which is exactly what the first version of this handler
      // did, by interpolating ctx.recordId here.
      try {
        let where = '';
        try { where = ` module=${ctx?.module} record=${ctx?.recordId}`; }
        catch { where = ' ctx=unreadable'; }
        console.error(`[WorkflowNotification] dispatch failed cid=${getCorrelationId()} event=${event}${where} error=${err?.message ?? err}`);
      } catch { /* logging must never be the thing that breaks delivery */ }
    }
  });
}
