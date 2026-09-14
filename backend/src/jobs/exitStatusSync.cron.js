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

function terminalStatusFor(separationType) {
  if (separationType === 'termination') return 'terminated';
  if (separationType === 'retirement') return 'left';
  return 'resigned';
}

async function runExitStatusSync() {
  console.log(`[Exit Status Sync Cron] Running at ${new Date().toISOString()}`);

  const { rows: due } = await pool.query(`
    SELECT er.id AS exit_request_id, er.employee_id, er.separation_type
    FROM exit_requests er
    JOIN employees e ON e.id = er.employee_id
    WHERE er.status = 'active'
      AND LOWER(e.status) = 'notice'
      AND er.last_working_date IS NOT NULL
      AND er.last_working_date::date <= CURRENT_DATE
  `);

  let updated = 0;
  for (const row of due) {
    try {
      const terminal = terminalStatusFor(row.separation_type);
      const { rowCount } = await pool.query(
        `UPDATE employees SET status=$1 WHERE id=$2 AND LOWER(status)='notice'`,
        [terminal, row.employee_id]
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
