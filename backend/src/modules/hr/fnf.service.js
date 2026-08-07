// backend/src/modules/hr/fnf.service.js
// Full & Final settlement computation, extracted from the manual
// POST /fnf/compute/:employee_id route so a cron (Automation Opportunity
// Audit §9.3) can auto-trigger it once the last working date is reached,
// instead of depending on HR remembering to call it.

/**
 * Computes notice-period recovery, leave encashment, gratuity and PF/TDS for
 * an employee's most recent active exit request, and writes the draft
 * net_payable onto exit_requests. Accepts a pg Pool or an in-transaction
 * Client — either exposes .query(). Returns null if the employee has no
 * exit_requests row to compute against.
 */
export async function computeFnf(db, employeeId) {
  const { rows: [emp] } = await db.query(
    `SELECT e.*, er.last_working_date, er.id AS exit_id, er.notice_period
     FROM employees e
     JOIN exit_requests er ON er.employee_id = e.id
     WHERE e.id=$1 ORDER BY er.created_at DESC LIMIT 1`,
    [employeeId]
  );
  if (!emp) return null;

  const basicSalary      = parseFloat(emp.basic_salary || 0);
  const dailyBasic       = parseFloat((basicSalary / 26).toFixed(2));
  const joiningDate      = new Date(emp.joining_date || emp.created_at);
  const lwdDate          = emp.last_working_date ? new Date(emp.last_working_date) : new Date();
  const serviceMs        = lwdDate - joiningDate;
  const serviceYears     = Math.max(0, serviceMs / (365.25 * 86400000));
  const serviceYearsComplete = Math.floor(serviceYears);
  const noticePeriodDays = emp.notice_period || 60;
  const servedDays       = Math.min(noticePeriodDays, Math.max(0, Math.round((lwdDate - new Date()) / 86400000) + noticePeriodDays));
  const shortfallDays    = Math.max(0, noticePeriodDays - servedDays);
  const noticeRecovery   = parseFloat((shortfallDays * dailyBasic).toFixed(2));

  // Try to fetch actual leave balance; fall back to 0 if the table doesn't exist
  let leaveBalance = 0;
  try {
    const lbRes = await db.query(
      `SELECT COALESCE(SUM(balance), 0) AS bal
       FROM leave_balances
       WHERE employee_id = $1 AND leave_type ILIKE '%earned%'`,
      [employeeId]
    );
    leaveBalance = parseFloat(lbRes.rows[0]?.bal || 0);
    // If no earned leave row, fall back to the hr_attendance_summary if available
    if (leaveBalance === 0) {
      const attRes = await db.query(
        `SELECT COALESCE(earned_leave_balance, 0) AS bal
         FROM hr_attendance_summary
         WHERE employee_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [employeeId]
      );
      leaveBalance = parseFloat(attRes.rows[0]?.bal || 0);
    }
  } catch (_) { leaveBalance = 0; }
  const leaveEncashment = parseFloat((leaveBalance * dailyBasic).toFixed(2));

  const gratuityEligible = serviceYearsComplete >= 5;
  const gratuityAmount   = gratuityEligible
    ? parseFloat(Math.min((15 / 26) * basicSalary * serviceYearsComplete, 2000000).toFixed(2))
    : 0;

  const months           = Math.round(serviceYears * 12);
  const pfBalance        = parseFloat((basicSalary * 0.24 * months).toFixed(2));
  const pfEligible       = serviceYearsComplete >= 5;
  const tdsOnPf          = pfEligible ? 0 : parseFloat((pfBalance * 0.1).toFixed(2));

  const grossFnf   = leaveEncashment + gratuityAmount;
  const netPayable = parseFloat((grossFnf - noticeRecovery).toFixed(2));

  const { rows: [updated] } = await db.query(
    `UPDATE exit_requests SET fnf_status='draft', net_payable=$1 WHERE id=$2 RETURNING id`,
    [netPayable, emp.exit_id]
  );

  return {
    id:          updated?.id,
    status:      'draft',
    net_payable: netPayable,
    computation_details: {
      basic_salary:  basicSalary,
      daily_basic:   dailyBasic,
      service_years: parseFloat(serviceYears.toFixed(2)),
      service_years_complete: serviceYearsComplete,
      notice: {
        period_days: noticePeriodDays, served_days: servedDays,
        shortfall_days: shortfallDays, recovery: noticeRecovery,
      },
      leave_encashment: {
        balance_days: leaveBalance, amount: leaveEncashment,
        formula: `${leaveBalance} days × (${basicSalary}/26)`,
      },
      gratuity: {
        eligible: gratuityEligible, amount: gratuityAmount,
        formula: gratuityEligible
          ? `(15/26) × ${basicSalary} × ${serviceYearsComplete} years`
          : 'Not eligible (<5 years service)',
        max_limit: 2000000,
      },
      pf: { balance: pfBalance, withdrawal_eligible: pfEligible, tds_applicable: !pfEligible, tds_amount: tdsOnPf },
      tds: { gross_fnf: grossFnf, annual_equivalent: grossFnf * 12, income_tax: 0, tds_on_fnf: tdsOnPf },
      summary: {
        total_payable: leaveEncashment + gratuityAmount,
        total_recoverable: noticeRecovery,
        gross_fnf: grossFnf,
        tds_on_fnf: tdsOnPf,
        net_payable: netPayable,
      },
    },
  };
}
