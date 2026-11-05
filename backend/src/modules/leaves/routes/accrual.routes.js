/**
 * accrual.routes.js — Factories Act compliant leave accrual engine
 *
 * POST /leave-accrual/run           — trigger accrual for a given month/year
 * POST /leave-accrual/carry-forward — year-end carry-forward
 * POST /leave-accrual/expire        — expire balances past their carry-forward expiry
 *
 * ⚠ THESE HANDLERS NO LONGER CONTAIN THE ACCRUAL LOGIC. They used to hold a
 * copy-paste twin of `jobs/leave.cron.js`, and both twins shared a defect that
 * neither could see from inside itself: the
 * `ON CONFLICT (employee_id, leave_type_id, year) DO UPDATE SET allocated_days =
 * allocated_days + $4` statement is idempotent about the balance ROW and purely
 * ADDITIVE about the days, so re-running a month credited it again. Since `month`
 * and `year` come from THIS request's body, that was one double-submit away.
 *
 * `modules/leaves/services/leaveAccrual.service.js` is now the one owner; read its
 * header for the full defect and for the `leave_accrual_log`-as-lock mechanism
 * (`uq_accrual_log_period`, migration 20260926000012) that makes a repeat run a
 * no-op rather than a second credit.
 *
 * API compatibility is preserved exactly: same paths, same auth, same response
 * keys. `records_accrued` now counts only what this call actually credited, and a
 * new `records_skipped` reports the periods that were already accrued — additive,
 * so no existing client breaks, and it is the number that tells an HR user "this
 * month was already done" instead of silently appearing to work twice.
 */
import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission, allowRoles } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import {
  runMonthlyAccrual as accrueMonth,
  runCarryForward as carryForwardYear,
} from '../services/leaveAccrual.service.js';

const router = express.Router();

// Accrual mutates allocated_days directly — HR/admin only. The 'leaves.add'
// permission alone is not enough because employees hold it for Apply Leave.
const requireLeaveAdmin = allowRoles('super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec');

// ── POST /leave-accrual/run ───────────────────────────────────────────────────
// Runs monthly accrual for leave types with accrual_type = 'monthly'.
// 1 day EL per 20 days worked (Factories Act) is handled automatically when
// accrual_type = 'monthly' and accrual_days_per_month = 1.
router.post('/run', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const now = new Date();
    const month = Number(req.body.month) || now.getMonth() + 1;
    const year  = Number(req.body.year)  || now.getFullYear();

    const outcome = await accrueMonth({
      companyId,
      month,
      year,
      runMode: 'manual',
      // `leave_accrual_log.run_by` FKs employees(id), so this must be an
      // employees.id. The old code read `req.user?.employee_id` directly, which is
      // absent from legacy and demo tokens — employeeOf() falls back to the users
      // row rather than silently recording NULL for those accounts.
      runBy: await employeeOf(req, pool),
    });

    if (!outcome.leave_types) {
      return res.json({ success: true, accrued: 0, message: 'No monthly accrual types configured' });
    }

    logAudit({
      userId: req.user?.userId, module: 'leave_accrual', recordId: null,
      recordType: 'leave_accrual', action: 'run',
      newData: {
        month, year, employees: outcome.employees, accrued: outcome.credited,
        skipped: outcome.skipped, failed: outcome.failed, leaveTypes: outcome.leave_types,
      }, req,
    });

    res.json({
      success: true,
      month,
      year,
      employees_processed: outcome.employees,
      records_accrued: outcome.credited,
      // Additive. A second run of the same month now reports
      // records_accrued: 0 with every row here, instead of quietly crediting again.
      records_skipped: outcome.skipped,
      records_failed: outcome.failed,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── POST /leave-accrual/carry-forward ─────────────────────────────────────────
// Year-end carry-forward: for each employee, carry forward eligible balance
// to next year (capped at max_carry_forward_days).
//
// ⚠ THIS ENDPOINT HAD NEVER CARRIED ANYTHING FORWARD FOR ANYONE. Its employee
// filter read `e.status IN ('active', 'probation', 'notice')` — lowercase, against
// a Capitalized column. Live values are 'Active' (30), 'Probation' (12), 'Notice'
// (1), so the predicate matched 0 of 44 employees and the endpoint returned
// `records_carried: 0` every time, indistinguishable from "nobody was eligible".
// The cron twin used `status IS DISTINCT FROM 'Left'` and worked. Consolidating on
// the service fixes this as a consequence of there being one implementation.
router.post('/carry-forward', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const fromYear  = Number(req.body.from_year) || (new Date().getFullYear() - 1);

    const outcome = await carryForwardYear({
      companyId, fromYear, runMode: 'manual', runBy: await employeeOf(req, pool),
    });

    if (!outcome.leave_types) {
      return res.json({ success: true, message: 'No carry-forward types configured' });
    }

    logAudit({
      userId: req.user?.userId, module: 'leave_accrual', recordId: null,
      recordType: 'leave_carry_forward', action: 'run',
      newData: {
        from_year: outcome.from_year, to_year: outcome.to_year,
        records_carried: outcome.credited, skipped: outcome.skipped, failed: outcome.failed,
      }, req,
    });

    res.json({
      success: true,
      from_year: outcome.from_year,
      to_year: outcome.to_year,
      records_carried: outcome.credited,
      records_skipped: outcome.skipped,
      records_failed: outcome.failed,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── POST /leave-accrual/expire ─────────────────────────────────────────────────
// Expire carry-forward balances that have passed their expiry.
//
// ⚠ This UPDATE had NO company predicate. `leave_balances` has no company_id of
// its own, so the boundary runs through `employees.company_id`, and it was absent:
// one HR user pressing this button DEBITED EVERY COMPANY'S carried-forward days,
// not just their own. It is the only destructive statement in this file and it was
// the only unscoped one. The predicate is added through the employee.
//
// The idempotency work in this batch does not apply here and is not claimed:
// `carried_forward_days = 0` makes this statement naturally idempotent — a second
// run matches nothing because `carried_forward_days > 0` no longer holds. That is
// why it needed no accrual-log gate, and why it is corrected in place rather than
// moved into leaveAccrual.service.js.
router.post('/expire', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    // Carried-forward days from previous year that have expired
    const now = new Date();
    const expiryYear  = now.getFullYear();
    const expiryMonth = now.getMonth() + 1;
    const companyId   = companyOf(req);

    // For each carry-forward type, zero out carried_forward_days where
    // carry_forward_expiry_months months have passed since Jan 1 of the year
    const { rows: expired } = await pool.query(`
      UPDATE leave_balances lb
      SET allocated_days       = allocated_days - COALESCE(carried_forward_days, 0),
          carried_forward_days = 0,
          updated_at           = NOW()
      FROM leave_types lt
      WHERE lb.leave_type_id = lt.id
        AND lt.carry_forward_allowed = true
        AND lt.carry_forward_expiry_months IS NOT NULL
        AND lb.carried_forward_days > 0
        AND lb.year = $1
        AND $2 > lt.carry_forward_expiry_months
        AND EXISTS (SELECT 1 FROM employees e
                     WHERE e.id = lb.employee_id
                       AND ($3::integer IS NULL OR e.company_id = $3))
      RETURNING lb.employee_id, lb.leave_type_id, lb.carried_forward_days AS expired_days
    `, [expiryYear, expiryMonth, companyId]);

    logAudit({
      userId: req.user?.userId, module: 'leave_accrual', recordId: null,
      recordType: 'leave_expiry', action: 'run',
      newData: { year: expiryYear, records_expired: expired.length }, req,
    });

    res.json({ success: true, records_expired: expired.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
