/**
 * attendance.cron.js — Auto-absent marking + auto-checkout for Pulse ERP
 * Runs:
 *   - Auto-absent: daily at 23:45 IST
 *   - Auto-checkout: checks every 30 minutes for employees past their auto_checkout_time
 */
import cron from 'node-cron';
import pool from '../modules/shared/db.js';

// ── Helper: write to attendance_audit_logs ──────────────────────────────────
async function auditLog(companyId, employeeId, action, data) {
  try {
    await pool.query(
      `INSERT INTO attendance_audit_logs (company_id, employee_id, action, after_data, performed_by)
       VALUES ($1,$2,$3,$4,NULL)`,
      [companyId, employeeId, action, JSON.stringify(data)]
    );
  } catch { /* non-blocking */ }
}

// ── Auto-absent: mark all employees without a record for today as absent ────
async function runAutoAbsent() {
  const today = new Date().toISOString().split('T')[0];
  const dowName = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date().getDay()];
  console.log(`[attendance.cron] Auto-absent run for ${today}`);
  try {
    // Get all companies
    const companies = await pool.query(
      `SELECT DISTINCT company_id FROM attendance_general_settings WHERE company_id IS NOT NULL`
    ).catch(() => ({ rows: [] }));
    // Also process company_id=NULL (global)
    const companyIds = [null, ...companies.rows.map(r => r.company_id)];

    for (const companyId of companyIds) {
      // Get settings for this company
      const settingsRow = await pool.query(
        `SELECT working_days FROM attendance_general_settings WHERE company_id=$1 LIMIT 1`,
        [companyId]
      ).catch(() => ({ rows: [] }));
      const settings = settingsRow.rows[0];
      let workingDays = ['monday','tuesday','wednesday','thursday','friday'];
      if (settings?.working_days) {
        try { workingDays = typeof settings.working_days === 'string' ? JSON.parse(settings.working_days) : settings.working_days; } catch {}
      }

      // Skip if today is not a working day
      if (!workingDays.includes(dowName)) continue;

      // Skip if today is a holiday
      const holidayCheck = await pool.query(
        `SELECT 1 FROM holidays WHERE date=$1::date AND (company_id=$2 OR company_id IS NULL) LIMIT 1`,
        [today, companyId]
      ).catch(() => ({ rows: [] }));
      if (holidayCheck.rows.length > 0) continue;

      const cidClause = companyId != null ? `AND e.company_id = ${parseInt(companyId)}` : '';

      // Find active employees who have no attendance record today
      const { rows: unmarked } = await pool.query(`
        SELECT e.id AS employee_id, e.company_id
          FROM employees e
          LEFT JOIN attendance_records ar
            ON ar.employee_id = e.id AND ar.attendance_date = $1 AND ar.deleted_at IS NULL
         WHERE ar.id IS NULL
           AND e.deleted_at IS NULL
           AND LOWER(e.status) IN ('active','probation')
           ${cidClause}
           -- Skip employees on approved leave
           AND NOT EXISTS (
             SELECT 1 FROM leave_applications la
              WHERE la.employee_id = e.id AND la.status = 'approved'
                AND $1::date BETWEEN la.from_date AND la.to_date
           )
      `, [today]).catch(() => ({ rows: [] }));

      for (const emp of unmarked) {
        await pool.query(`
          INSERT INTO attendance_records
            (employee_id, attendance_date, status, company_id, source)
          VALUES ($1,$2,'absent',$3,'auto_absent')
          ON CONFLICT (employee_id, attendance_date) DO NOTHING
        `, [emp.employee_id, today, emp.company_id]).catch(() => {});
        await auditLog(emp.company_id, emp.employee_id, 'auto_absent', { date: today, source: 'cron' });
      }
      if (unmarked.length > 0) {
        console.log(`[attendance.cron] Marked ${unmarked.length} employees absent for ${today} (company: ${companyId})`);
      }
    }
  } catch (err) {
    console.error('[attendance.cron] Auto-absent error:', err.message);
  }
}

// ── Auto-checkout: checkout employees past their auto_checkout_time ──────────
async function runAutoCheckout() {
  const today = new Date().toISOString().split('T')[0];
  const nowTime = new Date().toTimeString().slice(0,5); // HH:MM
  try {
    const companies = await pool.query(
      `SELECT company_id, auto_checkout_time FROM attendance_general_settings
        WHERE auto_checkout = TRUE AND auto_checkout_time IS NOT NULL`
    ).catch(() => ({ rows: [] }));

    for (const cfg of companies.rows) {
      const checkoutTime = String(cfg.auto_checkout_time).slice(0,5);
      if (nowTime < checkoutTime) continue; // Not yet checkout time

      const cidClause = cfg.company_id != null ? `AND e.company_id = ${parseInt(cfg.company_id)}` : '';

      // Find employees who are still checked in (no check_out_time)
      const { rows: stillIn } = await pool.query(`
        SELECT ar.id, ar.employee_id, ar.check_in_time, ar.company_id
          FROM attendance_records ar
          JOIN employees e ON e.id = ar.employee_id
         WHERE ar.attendance_date = $1
           AND ar.check_in_time IS NOT NULL
           AND ar.check_out_time IS NULL
           AND ar.deleted_at IS NULL
           ${cidClause}
      `, [today]).catch(() => ({ rows: [] }));

      for (const rec of stillIn) {
        const hours = await pool.query(
          `SELECT EXTRACT(EPOCH FROM ($1::time - $2::time)) / 3600 AS h`,
          [checkoutTime, String(rec.check_in_time).slice(0,5)]
        ).catch(() => ({ rows: [{ h: 0 }] }));
        const totalHours = Math.max(0, parseFloat(hours.rows[0]?.h || 0));
        const otHours = Math.max(0, totalHours - 9);

        await pool.query(`
          UPDATE attendance_records
             SET check_out_time=$1::time, total_hours=$2, ot_hours=$3, updated_at=NOW()
           WHERE id=$4 AND check_out_time IS NULL
        `, [checkoutTime, totalHours.toFixed(2), otHours.toFixed(2), rec.id]).catch(() => {});

        await auditLog(rec.company_id, rec.employee_id, 'auto_checkout', {
          check_out: checkoutTime, total_hours: totalHours.toFixed(2), source: 'auto_checkout_cron'
        });
      }
    }
  } catch (err) {
    console.error('[attendance.cron] Auto-checkout error:', err.message);
  }
}

// ── Schedule ─────────────────────────────────────────────────────────────────
// Auto-absent: 23:45 IST (18:15 UTC) every day
cron.schedule('45 23 * * *', runAutoAbsent, { timezone: 'Asia/Kolkata' });

// Auto-checkout: every 30 minutes
cron.schedule('*/30 * * * *', runAutoCheckout, { timezone: 'Asia/Kolkata' });

// Monthly attendance freeze reminder: 1st of each month at 09:00 IST
cron.schedule('0 9 1 * *', async () => {
  try {
    const prevMonth = new Date();
    prevMonth.setDate(0);
    const m = prevMonth.getMonth() + 1;
    const y = prevMonth.getFullYear();
    // Notify HR users to freeze attendance
    await pool.query(`
      INSERT INTO notifications (user_id, title, message, module_name, notification_type)
      SELECT u.id,
             'Attendance Freeze Reminder',
             'Please freeze attendance for ' || TO_CHAR(make_date($1,$2,1), 'Month YYYY') || ' before processing payroll.',
             'attendance',
             'system_reminder'
        FROM users u
       WHERE LOWER(COALESCE(u.role,'')) IN ('hr','hr_admin','hr_manager','admin')
         AND u.is_active = TRUE
    `, [y, m]).catch(() => {});
  } catch { /* non-blocking */ }
}, { timezone: 'Asia/Kolkata' });

export default { runAutoAbsent, runAutoCheckout };
