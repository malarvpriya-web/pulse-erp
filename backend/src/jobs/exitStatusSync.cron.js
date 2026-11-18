/**
 * Exit Status Sync Cron
 * ──────────────────────────────────────────────────────────────────────────────
 * Runs daily at 08:45 (before fnfAutoTrigger's 09:00 run, though the two are
 * independent — F&F computation never reads employees.status).
 *
 * exit.routes.js POST /initiate and employees/:id/offboard move an employee to
 * status='notice' the moment HR starts an exit, not straight to the terminal
 * status (resigned/terminated/left). 'notice' is recognized as "still working"
 * by payroll (payroll ACTIVE_STATUSES) and attendance, so pay and attendance
 * marking continue uninterrupted through the notice period. This job is the
 * one place that finalizes the terminal status — once last_working_date has
 * actually arrived — so payroll/attendance/roster queries correctly stop
 * treating the employee as current starting the day after their last day.
 *
 * Idempotent: only touches employees still sitting at 'notice'; once flipped
 * to a terminal status the WHERE clause no longer matches them.
 */

import cron from 'node-cron';
import pool from '../modules/shared/db.js';
import { EXIT_STATUS } from '../shared/employeeStatus.js';

function terminalStatusFor(separationType) {
  if (separationType === 'termination') return 'terminated';
  // Every separation ends in the same employment status. See EXIT_STATUS in
  // shared/employeeStatus.js: the separation TYPE is already recorded on the
  // exit_request this cron is reading, and duplicating it into `status` is what
  // let this mapping and hr.routes.js's copy of it disagree about 'retirement'.
  return EXIT_STATUS;
}

/**
 * §275: runs the morning AFTER the last working day (`<` today, not `<=`): at
 * 08:45 on the last day the person is still at work, and flipping them then
 * dropped that day from attendance and the final month from payroll. It also
 * records the exit date (the last working day) — only F&F payment used to, so
 * until then headcount history counted the person as still employed and
 * attrition was dated by the record's last edit. Deleted employees are skipped.
 * `today` is the business date (APP_TIMEZONE); tests pass their own, and
 * `onlyEmployeeIds` so a test run cannot touch other suites' rows.
 */
export async function runExitStatusSync({ today = null, onlyEmployeeIds = null } = {}) {
  console.log(`[Exit Status Sync Cron] Running at ${new Date().toISOString()}`);

  const { rows: due } = await pool.query(`
    SELECT er.id AS exit_request_id, er.employee_id, er.separation_type,
           to_char(er.last_working_date, 'YYYY-MM-DD') AS last_working_date
    FROM exit_requests er
    JOIN employees e ON e.id = er.employee_id AND e.deleted_at IS NULL
    WHERE er.status = 'active'
      AND LOWER(e.status) = 'notice'
      AND er.last_working_date IS NOT NULL
      AND er.last_working_date::date < COALESCE($1::date, CURRENT_DATE)
      AND ($2::int[] IS NULL OR er.employee_id = ANY($2::int[]))
  `, [today, onlyEmployeeIds]);

  let updated = 0;
  for (const row of due) {
    try {
      const terminal = terminalStatusFor(row.separation_type);
      const { rowCount } = await pool.query(
        `UPDATE employees SET status=$1, exit_date = COALESCE(exit_date, $3::date), updated_at = NOW()
          WHERE id=$2 AND LOWER(status)='notice'`,
        [terminal, row.employee_id, row.last_working_date]
      );
      updated += rowCount;
      if (rowCount) {
        console.log(`[Exit Status Sync Cron] Employee #${row.employee_id} -> '${terminal}' (exit request #${row.exit_request_id})`);
      }
    } catch (err) {
      console.error(`[Exit Status Sync Cron] Failed for employee #${row.employee_id}:`, err.message);
    }
  }

  console.log(`[Exit Status Sync Cron] Done — ${updated}/${due.length} employee status(es) finalized.`);
  return { updated, due: due.length };
}

export function startExitStatusSyncCron() {
  cron.schedule('45 8 * * *', () => {
    runExitStatusSync().catch((err) => console.error('[Exit Status Sync Cron] failed:', err.message));
  }, {
    scheduled: true,
    timezone: 'Asia/Kolkata',
  });
  console.log('🚪 Exit status sync cron scheduled — runs daily at 08:45 IST');
}

export { runExitStatusSync as runExitStatusSyncNow };
