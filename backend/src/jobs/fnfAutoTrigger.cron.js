/**
 * F&F Auto-Trigger Cron
 * ──────────────────────────────────────────────────────────────────────────────
 * Runs daily at 09:00.
 *
 * Full & Final settlement previously sat uncomputed indefinitely after an exit
 * was initiated — POST /exit/fnf/compute/:employee_id had to be remembered and
 * called by hand. This job auto-computes it (reusing computeFnf from
 * hr/fnf.service.js, same math the manual endpoint uses) once the employee's
 * last working day is reached, then notifies HR/finance it's ready for review.
 * It does NOT approve or pay F&F — that stays a human decision
 * (PUT /exit/fnf/:id/approve, POST /exit/fnf/:id/pay).
 *
 * Idempotency: exit_requests.fnf_status defaults to 'draft' at row creation
 * (POST /initiate never sets it explicitly), so it is NEVER actually NULL —
 * a fnf_status IS NULL filter would never match anything, ever. net_payable
 * has no default and stays NULL until computeFnf() sets it, so that's the
 * real "not yet computed" signal this job selects on.
 */

import cron from 'node-cron';
import pool from '../modules/shared/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { computeFnf } from '../modules/hr/fnf.service.js';

const HR_ROLES = ['super_admin', 'admin', 'hr_manager', 'payroll_admin', 'hr'];

// users.role is a stale single-value column several real pilot HR accounts
// (e.g. pilot.hrmgr@manifest.in, pilot.payroll@manifest.in) are stuck at
// 'user' on — real role assignment lives in user_roles/roles. Also resolves
// company through the linked employee row: those same pilot accounts have
// users.company_id NULL, company only derivable via employees.company_id
// (same gotcha already fixed in reorderPr.cron.js/leadAssignment.service.js).
async function getHrRecipients(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND r.code = ANY($2)
       AND (COALESCE(e.company_id, u.company_id) = $1 OR $1 IS NULL)`,
    [companyId, HR_ROLES]
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, exitRequestId, employeeName, netPayable) {
  await notificationsRepository.create({
    user_id: userId,
    title: `F&F Ready for Approval — ${employeeName}`,
    message: `Full & Final settlement for ${employeeName} has been auto-computed (net payable ₹${netPayable.toLocaleString('en-IN')}) and is ready for HR review/approval.`,
    module_name: 'hr',
    reference_id: exitRequestId,
    notification_type: 'fnf_ready_for_approval',
  });
}

async function runFnfAutoTrigger() {
  console.log(`[FnF Auto-Trigger Cron] Running at ${new Date().toISOString()}`);

  const { rows: due } = await pool.query(`
    SELECT er.id, er.employee_id, e.company_id,
           COALESCE(e.name, e.first_name || ' ' || e.last_name) AS employee_name
    FROM exit_requests er
    JOIN employees e ON e.id = er.employee_id
    WHERE er.status = 'active'
      AND er.net_payable IS NULL
      AND er.last_working_date IS NOT NULL
      AND er.last_working_date::date <= CURRENT_DATE
  `);

  for (const row of due) {
    try {
      const result = await computeFnf(pool, row.employee_id);
      if (!result) continue;

      const recipients = await getHrRecipients(row.company_id ?? null);
      for (const userId of recipients) {
        await insertReminder(userId, row.id, row.employee_name.trim(), result.net_payable);
      }
      console.log(`[FnF Auto-Trigger Cron] Computed F&F for exit request #${row.id} (employee ${row.employee_id}), notified ${recipients.length} HR user(s)`);
    } catch (err) {
      console.error(`[FnF Auto-Trigger Cron] Failed for exit request #${row.id}:`, err.message);
    }
  }

  console.log(`[FnF Auto-Trigger Cron] Done — ${due.length} exit request(s) processed.`);
}

export function startFnfAutoTriggerCron() {
  cron.schedule('0 9 * * *', () => {
    runFnfAutoTrigger().catch((err) => console.error('[FnF Auto-Trigger Cron] failed:', err.message));
  }, {
    scheduled: true,
    timezone: 'Asia/Kolkata',
  });
  console.log('💰 F&F auto-trigger cron scheduled — runs daily at 09:00 IST');
}

export { runFnfAutoTrigger as runFnfAutoTriggerNow };
