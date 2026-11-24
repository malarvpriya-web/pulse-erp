/**
 * Leave escalation (2026-11-24).
 *
 * A pending leave that has waited longer than the company's
 * `escalation_days` (Leave Settings → Leave Rules; default 3, 0 = never) at
 * the step it is on is escalated ONCE for that step:
 *   - manager step (L1): the manager is reminded; their own manager and HR
 *     are told — and from then on HR may take the L1 decision
 *     (leaves.routes.js authorizeL1), so a request never stays stuck because
 *     the manager is away;
 *   - department-head step (L2): the department's heads / L2 approvers and HR;
 *   - HR step: HR and admins.
 * The step's clock starts when the request reached it (applied, manager
 * approved, department head approved). It replaces the old weekday sweep that
 * re-notified the same manager every morning and never moved the request.
 */
import pool from '../../../config/db.js';
import { notifyWorkflowEvent } from '../../../services/WorkflowNotificationService.js';
import { isExitedSql } from '../../../shared/employeeStatus.js';

const HR_ROLES = ['hr', 'hr_manager', 'hr_exec', 'hr_admin'];
const ADMIN_ROLES = ['admin', 'super_admin'];
const HEAD_ROLES = ['department_head', 'l2_approver'];
const STEP_NAME = { l1: 'the manager', l2: 'the department head', hr: 'HR' };

/** Active logins of a company holding any of these roles (users.id). */
async function usersWithRoles(companyId, roles, { department = null } = {}) {
  const { rows } = await pool.query(`
    SELECT DISTINCT u.id
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = TRUE AND LOWER(r.code) = ANY($2)
       AND COALESCE(e.company_id,
                    (SELECT us.company_id FROM user_scope us WHERE us.user_id = u.id
                      ORDER BY us.is_primary DESC NULLS LAST, us.id LIMIT 1),
                    u.company_id) = $1
       AND ($3::text IS NULL OR e.department = $3)`, [companyId, roles, department]);
  return rows.map(r => r.id);
}

/** users.id of an employee's active login, or null. */
async function loginOf(employeeId) {
  if (employeeId == null) return null;
  const { rows: [u] } = await pool.query(
    'SELECT id FROM users WHERE employee_id = $1 AND is_active = TRUE ORDER BY id LIMIT 1', [employeeId]);
  return u?.id ?? null;
}

/**
 * Escalate what is overdue. `companyId` limits the run to one company (tests,
 * a manual run); `now` lets a test move the clock.
 * → { escalated: [{ id, step, recipients }] }
 */
export async function runLeaveEscalation({ companyId = null, now = null } = {}) {
  const { rows: companies } = await pool.query(`
    SELECT c.id, COALESCE((cs.settings->>'escalation_days')::int, 3) AS days
      FROM companies c
      LEFT JOIN company_settings cs ON cs.company_id = c.id AND cs.module = 'leaves'
     WHERE ($1::int IS NULL OR c.id = $1)
       AND EXISTS (SELECT 1 FROM leave_applications la JOIN employees e ON e.id = la.employee_id
                    WHERE e.company_id = c.id AND la.status = 'pending' AND la.deleted_at IS NULL)`, [companyId]);
  const escalated = [];
  for (const co of companies) {
    if (!(co.days > 0)) continue;
    const { rows: due } = await pool.query(`
      WITH p AS (
        SELECT la.id, la.employee_id, la.escalation_step, e.department, e.reporting_manager_id,
               COALESCE(e.name, CONCAT_WS(' ', e.first_name, e.last_name)) AS employee_name,
               lt.leave_name, la.start_date::text AS start_date, la.number_of_days,
               CASE WHEN la.manager_status = 'pending' THEN 'l1'
                    WHEN COALESCE(lt.l2_required, false) AND COALESCE(la.l2_status, 'pending') = 'pending' THEN 'l2'
                    ELSE 'hr' END AS step,
               CASE WHEN la.manager_status = 'pending' THEN COALESCE(la.applied_at, la.created_at)
                    WHEN COALESCE(lt.l2_required, false) AND COALESCE(la.l2_status, 'pending') = 'pending' THEN la.manager_approved_at
                    ELSE COALESCE(la.l2_approved_at, la.manager_approved_at) END AS step_since
          FROM leave_applications la
          JOIN employees e ON e.id = la.employee_id
          JOIN leave_types lt ON lt.id = la.leave_type_id
         WHERE la.status = 'pending' AND la.deleted_at IS NULL AND e.company_id = $1
      )
      SELECT p.*, m.reporting_manager_id AS managers_manager_id
        FROM p
        LEFT JOIN employees m ON m.id = p.reporting_manager_id AND NOT (${isExitedSql('m.status')})
       WHERE p.step_since IS NOT NULL
         AND p.step_since <= COALESCE($3::timestamptz, NOW()) - make_interval(days => $2::int)
         AND p.escalation_step IS DISTINCT FROM p.step
       ORDER BY p.step_since`, [co.id, co.days, now]);

    for (const r of due) {
      // Claim the step first, so two runs never escalate it twice.
      const { rowCount } = await pool.query(
        `UPDATE leave_applications
            SET escalated_at = COALESCE($3::timestamptz, NOW()), escalation_step = $2::varchar, updated_at = NOW()
          WHERE id = $1 AND status = 'pending' AND escalation_step IS DISTINCT FROM $2::varchar`, [r.id, r.step, now]);
      if (!rowCount) continue;
      const hr = await usersWithRoles(co.id, HR_ROLES);
      let recipients;
      if (r.step === 'l1') {
        recipients = [await loginOf(r.reporting_manager_id), await loginOf(r.managers_manager_id), ...hr];
      } else if (r.step === 'l2') {
        recipients = [...await usersWithRoles(co.id, HEAD_ROLES, { department: r.department }), ...hr];
      } else {
        recipients = [...hr, ...await usersWithRoles(co.id, ADMIN_ROLES)];
      }
      const requester = await loginOf(r.employee_id);
      recipients = [...new Set(recipients.filter(id => id != null && id !== requester))];
      if (recipients.length) {
        notifyWorkflowEvent('leave_escalated', {
          module: 'Leave', recordId: r.id, recipientUserIds: recipients,
          context: {
            employee_name: r.employee_name, leave_type: r.leave_name, days: Number(r.number_of_days),
            start_date: String(r.start_date).slice(0, 10), step: STEP_NAME[r.step],
            waited_days: co.days, hr_may_decide: r.step === 'l1',
          },
        });
      }
      escalated.push({ id: r.id, step: r.step, recipients: recipients.length });
    }
  }
  return { escalated };
}
