/**
 * accrual.routes.js — Factories Act compliant leave accrual engine
 *
 * POST /leave-accrual/run      — manually trigger accrual for a given month/year
 * POST /leave-accrual/carry-forward — year-end carry-forward for all employees
 * POST /leave-accrual/expire   — expire balances past their carry-forward expiry
 */
import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission, allowRoles } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';

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
    const companyId = req.scope?.company_id ?? null;
    const now = new Date();
    const month = Number(req.body.month) || now.getMonth() + 1;
    const year  = Number(req.body.year)  || now.getFullYear();

    // Fetch all accrual-based leave types
    const { rows: leaveTypes } = await pool.query(`
      SELECT id, leave_name, accrual_days_per_month, annual_quota
      FROM leave_types
      WHERE accrual_type = 'monthly'
        AND is_active = true AND deleted_at IS NULL
        AND accrual_days_per_month > 0
        AND (company_id IS NULL OR company_id = $1)
    `, [companyId]);

    if (!leaveTypes.length) return res.json({ success: true, accrued: 0, message: 'No monthly accrual types configured' });

    // Fetch active employees
    const { rows: employees } = await pool.query(`
      SELECT id, joining_date FROM employees
      WHERE status IS DISTINCT FROM 'Left'
        AND ($1::integer IS NULL OR company_id = $1)
    `, [companyId]);

    let accrued = 0;
    const log = [];

    for (const emp of employees) {
      // Pro-rate for employees who joined mid-month
      let factor = 1;
      if (emp.joining_date) {
        const jd = new Date(emp.joining_date);
        if (jd.getFullYear() === year && jd.getMonth() + 1 === month) {
          const daysInMonth = new Date(year, month, 0).getDate();
          const daysWorked  = daysInMonth - jd.getDate() + 1;
          factor = daysWorked / daysInMonth;
        } else if (jd > new Date(year, month - 1, 1)) {
          continue; // Not yet joined
        }
      }

      for (const lt of leaveTypes) {
        const days = Number((lt.accrual_days_per_month * factor).toFixed(2));
        if (days <= 0) continue;

        await pool.query(`
          INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
          VALUES ($1, $2, $3, $4, 0)
          ON CONFLICT (employee_id, leave_type_id, year)
          DO UPDATE SET allocated_days = leave_balances.allocated_days + $4, updated_at = NOW()
        `, [emp.id, lt.id, year, days]);

        // Write per-event accrual log for audit trail
        pool.query(`
          INSERT INTO leave_accrual_log (employee_id, leave_type_id, year, month, days_accrued, accrual_type, run_by, run_mode, company_id)
          VALUES ($1, $2, $3, $4, $5, 'monthly', $6, 'manual', $7)
        `, [emp.id, lt.id, year, month, days, req.user?.employee_id ?? null, companyId]).catch(() => {});

        log.push({ employee_id: emp.id, leave_type_id: lt.id, days });
        accrued++;
      }
    }

    logAudit({
      userId: req.user?.userId, module: 'leave_accrual', recordId: null,
      recordType: 'leave_accrual', action: 'run',
      newData: { month, year, employees: employees.length, accrued, leaveTypes: leaveTypes.length }, req,
    });

    res.json({ success: true, month, year, employees_processed: employees.length, records_accrued: accrued });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /leave-accrual/carry-forward ─────────────────────────────────────────
// Year-end carry-forward: for each employee, carry forward eligible balance
// to next year (capped at max_carry_forward_days).
router.post('/carry-forward', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const fromYear  = Number(req.body.from_year) || (new Date().getFullYear() - 1);
    const toYear    = fromYear + 1;

    // Fetch carry-forward eligible types
    const { rows: leaveTypes } = await pool.query(`
      SELECT id, leave_name, max_carry_forward_days, carry_forward_expiry_months
      FROM leave_types
      WHERE carry_forward_allowed = true AND is_active = true AND deleted_at IS NULL
        AND (company_id IS NULL OR company_id = $1)
    `, [companyId]);

    if (!leaveTypes.length) return res.json({ success: true, message: 'No carry-forward types configured' });

    let carried = 0;
    for (const lt of leaveTypes) {
      // Get all balances for fromYear with remaining days
      const { rows: balances } = await pool.query(`
        SELECT lb.employee_id,
               GREATEST(COALESCE(lb.allocated_days,0) - COALESCE(lb.used_days,0) - COALESCE(lb.encashed_days,0), 0) AS remaining
        FROM leave_balances lb
        JOIN employees e ON lb.employee_id = e.id
        WHERE lb.leave_type_id = $1 AND lb.year = $2
          AND e.status IN ('active', 'probation', 'notice')
          AND ($3::integer IS NULL OR e.company_id = $3)
          AND GREATEST(COALESCE(lb.allocated_days,0) - COALESCE(lb.used_days,0) - COALESCE(lb.encashed_days,0), 0) > 0
      `, [lt.id, fromYear, companyId]);

      for (const bal of balances) {
        const carryDays = Math.min(Number(bal.remaining), lt.max_carry_forward_days || 0);
        if (carryDays <= 0) continue;

        await pool.query(`
          INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, carried_forward_days, opening_balance, used_days)
          VALUES ($1, $2, $3, $4, $4, $4, 0)
          ON CONFLICT (employee_id, leave_type_id, year)
          DO UPDATE SET
            allocated_days       = leave_balances.allocated_days + $4,
            carried_forward_days = COALESCE(leave_balances.carried_forward_days,0) + $4,
            opening_balance      = COALESCE(leave_balances.opening_balance,0) + $4,
            updated_at           = NOW()
        `, [bal.employee_id, lt.id, toYear, carryDays]);

        carried++;
      }
    }

    logAudit({
      userId: req.user?.userId, module: 'leave_accrual', recordId: null,
      recordType: 'leave_carry_forward', action: 'run',
      newData: { from_year: fromYear, to_year: toYear, records_carried: carried }, req,
    });

    res.json({ success: true, from_year: fromYear, to_year: toYear, records_carried: carried });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /leave-accrual/expire ─────────────────────────────────────────────────
// Expire carry-forward balances that have passed their expiry.
router.post('/expire', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    // Carried-forward days from previous year that have expired
    const now = new Date();
    const expiryYear  = now.getFullYear();
    const expiryMonth = now.getMonth() + 1;

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
      RETURNING lb.employee_id, lb.leave_type_id, lb.carried_forward_days AS expired_days
    `, [expiryYear, expiryMonth]);

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
