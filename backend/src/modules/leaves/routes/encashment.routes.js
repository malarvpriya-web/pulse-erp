import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission, can } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { hasRole } from '../../../middlewares/auth.middleware.js';
import { employeeOf, companyOf } from '../../../shared/scope.js';
import { leaveSettingsOf } from './leaves.routes.js';

// Ownership (PAYROLL_DATA_FLOW_AUDIT.md Part 10): a claim belongs to the company
// of its EMPLOYEE. Every route needs a company context and acts only on claims
// and employees of that company; anything else is "not found", with no detail.
const requireCompanyCtx = (req, res) => {
  const cid = companyOf(req);
  if (cid == null) { res.status(400).json({ error: 'Company context required' }); return null; }
  return cid;
};
const employeeInCompany = async (db, employeeId, cid) =>
  (await db.query('SELECT 1 FROM employees WHERE id = $1 AND company_id = $2', [employeeId, cid])).rows.length > 0;

// ── Money on a claim (PC-01 closure decision 3, 04 Nov 26) ──────────────────
// rate_per_day is the employee's Basic / 26, so every amount on a claim is
// salary data. It goes out only to payroll:view holders — and to the claimant
// on their own claim, the same rule as the master Basic (salaryVisibility.js).
// The amounts are computed here, never taken from the request.
const MONEY_FIELDS = ['rate_per_day', 'gross_amount', 'tds_amount', 'net_amount'];
async function withoutMoney(req, rows, me) {
  if (await can(req, 'payroll', 'view')) return rows;
  return rows.map(r => {
    if (me != null && Number(r.employee_id) === Number(me)) return r;
    const out = { ...r };
    for (const k of MONEY_FIELDS) delete out[k];
    return out;
  });
}

// Who decides a claim (2026-11-24). Approving one writes a payroll EARNING, so
// it is HR / payroll work — leaves:approve alone (held by every line manager
// and department head) let a manager approve money for their team, and their
// OWN claim. Never the claimant themself.
export const ENCASHMENT_DECIDER_ROLES = ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'finance_manager'];
async function refuseDecider(req, claimEmployeeId) {
  if (!hasRole(req, ...ENCASHMENT_DECIDER_ROLES)) {
    return { status: 403, body: { code: 'ENCASHMENT_DECIDER_ONLY', error: 'Only HR or payroll can approve or cancel a leave encashment claim.' } };
  }
  const me = await employeeOf(req, pool);
  if (me != null && Number(me) === Number(claimEmployeeId)) {
    return { status: 403, body: { code: 'ENCASHMENT_SELF_DECISION', error: 'You cannot decide your own encashment claim — another HR or payroll person must.' } };
  }
  return null;
}

const router = express.Router();

// ── GET /leave-encashment — list encashment records ───────────────────────────
/**
 * Leave encashment claims.
 *
 * This is compensation: an amount of money paid to a named person. `employee`
 * holds `leaves`.`view` by design — people need to see their own claim — so the
 * permission gate does not scope it, and a live probe on 2026-09-04 returned
 * five different people's claims to a plain employee.
 *
 * Scoped rather than gated, for the same reason /leaves/allocations was: closing
 * it would take away access to the caller's own claim. HR and administrators see
 * everyone, a manager sees their reports, everyone else sees themselves.
 */
router.get('/', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = requireCompanyCtx(req, res);
    if (companyId == null) return;
    const { status, year } = req.query;

    // An approved claim becomes Paid when the payroll that carries it (its
    // month, this employee) is approved or paid. Kept in step on every read.
    await pool.query(`
      UPDATE leave_encashments le SET status = 'paid', paid_at = COALESCE(le.paid_at, NOW()), updated_at = NOW()
        FROM payroll_adjustments pa
        JOIN payroll_runs pr ON pr.employee_id = pa.employee_id AND pr.month = pa.month AND pr.year = pa.year
                            AND pr.is_test = false AND pr.status IN ('approved', 'paid')
       WHERE le.status = 'approved' AND le.payroll_adjustment_id = pa.id AND le.company_id = $1`, [companyId]);

    const isAdmin   = hasRole(req, 'super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec', 'payroll_admin', 'finance_manager');
    const isManager = hasRole(req, 'manager', 'department_head');
    const me        = await employeeOf(req, pool);
    const requested = req.query.employee_id ? Number(req.query.employee_id) : null;

    const params = [companyId];
    let filters = '';
    if (status) { filters += ` AND le.status = $${params.length + 1}`; params.push(status); }
    if (year)   { filters += ` AND le.year   = $${params.length + 1}`; params.push(Number(year)); }

    // Resolved server-side. A caller who may not see others cannot widen their
    // own scope by naming someone else in the query string.
    if (isAdmin) {
      if (Number.isInteger(requested)) {
        filters += ` AND le.employee_id = $${params.length + 1}`; params.push(requested);
      }
    } else if (isManager) {
      if (me == null) return res.json([]);
      filters += ` AND (le.employee_id = $${params.length + 1} OR e.reporting_manager_id = $${params.length + 1})`;
      params.push(me);
    } else {
      // No employee record means no claim of one's own to show. Returning
      // everything would be the fail-open this endpoint just had.
      if (me == null) return res.json([]);
      filters += ` AND le.employee_id = $${params.length + 1}`; params.push(me);
    }

    const { rows } = await pool.query(`
      SELECT le.*,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation, e.office_id AS employee_code,
        lt.leave_name,
        COALESCE(a.name, CONCAT(a.first_name,' ',a.last_name)) AS approved_by_name,
        pa.month AS payroll_month, pa.year AS payroll_year, pr.status AS payroll_status
      FROM leave_encashments le
      JOIN employees e  ON le.employee_id = e.id
      JOIN leave_types lt ON le.leave_type_id = lt.id
      LEFT JOIN employees a ON le.approved_by = a.id
      LEFT JOIN payroll_adjustments pa ON pa.id = le.payroll_adjustment_id
      LEFT JOIN payroll_runs pr ON pr.employee_id = pa.employee_id AND pr.month = pa.month AND pr.year = pa.year AND pr.is_test = false
      WHERE e.company_id = $1${filters}
      ORDER BY le.created_at DESC
    `, params);
    res.json(await withoutMoney(req, rows, me));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /leave-encashment — HR creates encashment request ────────────────────
router.post('/', requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const { employee_id, leave_type_id, year, days_encashed, encashment_month, encashment_year, reason } = req.body;
    if (!employee_id || !leave_type_id || !days_encashed) {
      return res.status(400).json({ error: 'employee_id, leave_type_id, and days_encashed are required' });
    }

    const companyId = requireCompanyCtx(req, res);
    if (companyId == null) return;
    // Amounts are derived from the salary here; a request that carries one is
    // refused rather than having it silently ignored.
    const sentMoney = MONEY_FIELDS.filter(k => k in (req.body || {}));
    if (sentMoney.length) {
      return res.status(400).json({ code: 'ENCASHMENT_AMOUNT_COMPUTED', error: `${sentMoney.join(', ')} cannot be supplied — the amounts are computed from the salary.` });
    }
    // An employee claims for themself. A claim for anyone else — or a chosen
    // TDS rate — is payroll work: payroll:edit (PC-01 closure decision 3).
    const me = await employeeOf(req, pool);
    const forSelf = me != null && Number(employee_id) === Number(me);
    const payroll = await can(req, 'payroll', 'edit');
    if (!forSelf && !payroll) {
      return res.status(403).json({ code: 'ENCASHMENT_FOR_OTHERS', error: 'You can create an encashment claim only for yourself. A claim for another employee needs payroll edit permission.' });
    }
    // PC-01 decision 3: tax on the claim is Payroll's business. (Since
    // 2026-11-23 the tax is deducted in payroll at the employee's slab, so a
    // rate sent by Payroll no longer changes the claim — but nobody else may
    // send one.)
    if (req.body.tds_rate !== undefined && !payroll) {
      return res.status(403).json({ code: 'ENCASHMENT_TDS_RATE', error: 'Tax on an encashment is deducted by Payroll at the employee\'s slab. Leave the TDS rate out.' });
    }
    if (!(await employeeInCompany(pool, employee_id, companyId))) return res.status(404).json({ error: 'Employee not found' });
    const resolvedYear = Number(year) || new Date().getFullYear();
    const days = Number(days_encashed);
    if (!(days > 0) || days > 366) return res.status(400).json({ error: 'Enter the number of days to encash (more than 0).' });

    // Basic in force today, exactly as payroll and F&F read it: the latest
    // approved salary assignment, else the employee master.
    const { rows: [sal] } = await pool.query(`
      SELECT COALESCE(
        (SELECT basic_salary FROM employee_salary_assignments
          WHERE employee_id = $1 AND effective_from <= CURRENT_DATE
          ORDER BY effective_from DESC, created_at DESC LIMIT 1),
        (SELECT basic_salary FROM employees WHERE id = $1)) AS basic`, [employee_id]);
    const basicSalary = Number(sal?.basic || 0);
    if (!(basicSalary > 0)) {
      return res.status(422).json({ code: 'NO_SALARY', error: 'This employee has no Basic salary on record, so the encashment cannot be valued. Set the salary first.' });
    }
    const ratePerDay  = Number((basicSalary / 26).toFixed(2));
    const grossAmount = Number((days * ratePerDay).toFixed(2));
    // Income tax: a flat % — Leave Settings → Leave rules (default 20%, owner
    // 2026-11-23), or the rate Payroll sets on this claim. Payroll deducts
    // exactly this when it pays the claim (payroll_adjustments.tds_rate).
    const { encashment_tds_pct } = await leaveSettingsOf(companyId);
    const tdsPct = req.body.tds_rate !== undefined
      ? Math.min(Math.max(Number(req.body.tds_rate) <= 1 ? Number(req.body.tds_rate) * 100 : Number(req.body.tds_rate), 0), 100)
      : Number(encashment_tds_pct);
    const tdsAmount = Number((grossAmount * tdsPct / 100).toFixed(2));
    const netAmount = Number((grossAmount - tdsAmount).toFixed(2));

    // Days available: allocated + carried forward − approved leave − pending − already encashed.
    const { rows: [bal] } = await pool.query(`
      SELECT COALESCE(lb.allocated_days, 0) + COALESCE(lb.carried_forward_days, 0) - COALESCE(lb.encashed_days, 0)
             - COALESCE((SELECT SUM(number_of_days) FROM leave_applications la
                          WHERE la.employee_id = $1 AND la.leave_type_id = $2 AND la.status IN ('approved','pending')
                            AND EXTRACT(YEAR FROM la.start_date) = $3 AND la.deleted_at IS NULL), 0)
             - COALESCE((SELECT SUM(days_encashed) FROM leave_encashments x
                          WHERE x.employee_id = $1 AND x.leave_type_id = $2 AND x.year = $3 AND x.status = 'pending'), 0)
             AS available
        FROM leave_balances lb WHERE lb.employee_id = $1 AND lb.leave_type_id = $2 AND lb.year = $3`,
      [employee_id, leave_type_id, resolvedYear]);
    const available = Number(bal?.available || 0);
    if (days > available) {
      return res.status(422).json({ code: 'INSUFFICIENT_BALANCE', error: `Only ${Math.max(available, 0)} day(s) can be encashed from this balance for ${resolvedYear}.` });
    }

    // Check leave type is encashable
    const { rows: ltRows } = await pool.query(
      `SELECT is_encashable, max_encash_days_per_year FROM leave_types WHERE id = $1`, [leave_type_id]
    );
    if (!ltRows.length) return res.status(404).json({ error: 'Leave type not found' });
    if (!ltRows[0].is_encashable) return res.status(422).json({ error: 'This leave type is not encashable' });

    // Check max days limit
    if (ltRows[0].max_encash_days_per_year) {
      const { rows: prevRows } = await pool.query(`
        SELECT COALESCE(SUM(days_encashed), 0) AS total
        FROM leave_encashments
        WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3 AND status != 'cancelled'
      `, [employee_id, leave_type_id, resolvedYear]);
      const alreadyEncashed = Number(prevRows[0]?.total || 0);
      if (alreadyEncashed + Number(days_encashed) > ltRows[0].max_encash_days_per_year) {
        return res.status(422).json({
          error: `Max encashable days for this year: ${ltRows[0].max_encash_days_per_year}. Already encashed: ${alreadyEncashed}.`,
        });
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO leave_encashments
        (employee_id, leave_type_id, year, days_encashed, rate_per_day, gross_amount,
         tds_amount, net_amount, encashment_month, encashment_year, reason, company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [employee_id, leave_type_id, resolvedYear, days, ratePerDay, grossAmount,
        tdsAmount, netAmount,
        Number(encashment_month) || new Date().getMonth() + 1,
        Number(encashment_year) || new Date().getFullYear(),
        reason || null, companyId]);

    logAudit({ userId: req.user?.userId, module: 'leave_encashment', recordId: rows[0].id, recordType: 'leave_encashment', action: 'create', newData: rows[0], req });
    res.status(201).json((await withoutMoney(req, rows, me))[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /leave-encashment/approve/:id ───────────────────────────────────────
router.post('/approve/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  const cid = requireCompanyCtx(req, res);
  if (cid == null) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: enc } = await client.query(
      `SELECT le.* FROM leave_encashments le JOIN employees e ON e.id = le.employee_id
        WHERE le.id = $1 AND e.company_id = $2 FOR UPDATE OF le`, [req.params.id, cid]);
    if (!enc.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Encashment record not found' }); }
    if (enc[0].status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Already processed' }); }
    const refused = await refuseDecider(req, enc[0].employee_id);
    if (refused) { await client.query('ROLLBACK'); return res.status(refused.status).json(refused.body); }

    const e = enc[0];

    // 1. Approve the encashment record
    await client.query(`
      UPDATE leave_encashments
      SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
      WHERE id = $2
    `, [req.user?.employee_id, req.params.id]);

    // 2. Deduct from leave balance (atomic). encashed_days only: the balance
    //    (getLeaveBalance) subtracts it; adding it to used_days as well made
    //    every encashed day count twice.
    await client.query(`
      UPDATE leave_balances
      SET encashed_days = COALESCE(encashed_days, 0) + $1,
          updated_at    = NOW()
      WHERE employee_id = $2 AND leave_type_id = $3 AND year = $4
    `, [e.days_encashed, e.employee_id, e.leave_type_id, e.year]);

    // 3. Pay it: a one-time EARNING in payroll for the payout month. Generate
    //    Payroll adds it to gross and taxes it at the employee's slab. (It used
    //    to write payroll_runs.leave_encashment_amount, which payroll never read.)
    const encMonth = Number(req.body?.payout_month) || e.encashment_month || new Date().getMonth() + 1;
    const encYear  = Number(req.body?.payout_year)  || e.encashment_year  || new Date().getFullYear();
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`payroll:${cid}:${encYear}:${encMonth}`]);
    const { rows: [run] } = await client.query(
      `SELECT status FROM payroll_runs WHERE employee_id = $1 AND month = $2 AND year = $3 AND is_test = false`,
      [e.employee_id, encMonth, encYear]);
    if (run && ['approved', 'paid'].includes(run.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'PERIOD_FINALISED',
        error: `Payroll for ${encMonth}/${encYear} is already ${run.status} for this employee. Choose a later payout month.`,
      });
    }
    const amount = Math.round(Number(e.gross_amount) || Number(e.net_amount) || 0);
    if (!(amount >= 1)) {
      await client.query('ROLLBACK');
      return res.status(422).json({ code: 'NO_AMOUNT', error: 'This claim has no amount (the employee had no Basic salary when it was made). Cancel it and create it again after the salary is set.' });
    }
    const { rows: [lt] } = await client.query('SELECT leave_name FROM leave_types WHERE id = $1', [e.leave_type_id]);
    // Flat TDS at the claim's rate (tds ÷ gross), and outside PF/ESI wages.
    const gross = Number(e.gross_amount) || 0;
    const tdsRate = gross > 0 ? Math.round((Number(e.tds_amount || 0) / gross) * 10000) / 100 : 0;
    const { rows: [adj] } = await client.query(`
      INSERT INTO payroll_adjustments (company_id, employee_id, month, year, kind, label, amount, reason, created_by, tds_rate, in_wages)
      VALUES ($1, $2, $3, $4, 'earning', $5, $6, $7, $8, $9, false) RETURNING id`,
      [cid, e.employee_id, encMonth, encYear,
        `Leave encashment — ${lt?.leave_name || 'leave'} ${Number(e.days_encashed)} day(s)`.slice(0, 80),
        amount,
        `Leave encashment #${e.id} for ${e.year}`, req.user?.userId ?? null, tdsRate]);
    await client.query(
      `UPDATE leave_encashments SET payroll_adjustment_id = $1, encashment_month = $2, encashment_year = $3 WHERE id = $4`,
      [adj.id, encMonth, encYear, req.params.id]);

    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId, module: 'leave_encashment', recordId: req.params.id, recordType: 'leave_encashment', action: 'approve', oldData: e, newData: { status: 'approved', gross_amount: e.gross_amount, payroll_adjustment_id: adj.id, payout: `${encMonth}/${encYear}` }, req });
    // Notify employee (non-blocking)
    import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('approved', {
        module: 'LeaveEncashment',
        recordId: Number(req.params.id),
        submitterId: e.employee_id,
        recipientIds: [e.employee_id],
        comments: `Leave encashment of ₹${e.gross_amount} approved — paid with the ${encMonth}/${encYear} salary; TDS ${tdsRate}% (₹${Number(e.tds_amount || 0)}) deducted there`,
      }).catch(() => {});
    }).catch(() => {});
    res.json({ success: true, payroll_adjustment_id: adj.id, payout_month: encMonth, payout_year: encYear });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── POST /leave-encashment/reject/:id ────────────────────────────────────────
router.post('/reject/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  const cid = requireCompanyCtx(req, res);
  if (cid == null) return;
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
    // Cancelling is HR / payroll's call, as approving is. The claimant cannot
    // hit this route at all (employees hold no leaves:approve).
    {
      const { rows: [c] } = await pool.query(
        `SELECT le.employee_id FROM leave_encashments le JOIN employees e ON e.id = le.employee_id
          WHERE le.id = $1 AND e.company_id = $2`, [req.params.id, cid]);
      if (!c) return res.status(404).json({ error: 'Encashment record not found' });
      const refused = await refuseDecider(req, c.employee_id);
      if (refused) return res.status(refused.status).json(refused.body);
    }

    const { rows } = await pool.query(`
      -- 'cancelled', not 'rejected': the table's CHECK allows pending / approved /
      -- paid / cancelled (and the Encashment page shows those). 'rejected' made
      -- every rejection fail with a 500. The rejection reason is kept in the reason column.
      UPDATE leave_encashments
      SET status = 'cancelled', approved_by = $1, approved_at = NOW(),
          reason = $2, updated_at = NOW()
      WHERE id = $3 AND status = 'pending'
        AND employee_id IN (SELECT id FROM employees WHERE company_id = $4)
      RETURNING id, employee_id
    `, [req.user?.employee_id, reason, req.params.id, cid]);
    if (!rows.length) return res.status(409).json({ error: 'Not found or already processed' });

    logAudit({ userId: req.user?.userId, module: 'leave_encashment', recordId: req.params.id, recordType: 'leave_encashment', action: 'reject', newData: { status: 'rejected', reason }, req });
    // Notify employee (non-blocking)
    import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('rejected', {
        module: 'LeaveEncashment',
        recordId: Number(req.params.id),
        submitterId: rows[0]?.employee_id,
        recipientIds: [rows[0]?.employee_id],
        comments: reason,
      }).catch(() => {});
    }).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /leave-encashment/eligible/:employee_id ───────────────────────────────
router.get('/eligible/:employee_id', requirePermission('leaves', 'view'), async (req, res) => {
  const cid = requireCompanyCtx(req, res);
  if (cid == null) return;
  try {
    if (!(await employeeInCompany(pool, req.params.employee_id, cid))) return res.status(404).json({ error: 'Employee not found' });
    const year = Number(req.query.year) || new Date().getFullYear();
    // Balance = allocated + carried forward − approved/pending leave − encashed
    // (approved) − encashment claims still pending. No yearly cap set = no cap
    // (it used to read as 0, so a type without a cap could never be encashed).
    const { rows } = await pool.query(`
      WITH b AS (
        SELECT lt.id AS leave_type_id, lt.leave_name, lt.max_encash_days_per_year,
               COALESCE(lb.allocated_days, 0) AS allocated_days,
               COALESCE(lb.carried_forward_days, 0) AS carried_forward_days,
               COALESCE((SELECT SUM(la.number_of_days) FROM leave_applications la
                          WHERE la.employee_id = $1 AND la.leave_type_id = lt.id AND la.status IN ('approved','pending')
                            AND EXTRACT(YEAR FROM la.start_date) = $2 AND la.deleted_at IS NULL), 0) AS used_days,
               COALESCE(lb.encashed_days, 0)
                 + COALESCE((SELECT SUM(days_encashed) FROM leave_encashments x
                              WHERE x.employee_id = $1 AND x.leave_type_id = lt.id AND x.year = $2 AND x.status = 'pending'), 0) AS encashed_days,
               COALESCE((SELECT SUM(days_encashed) FROM leave_encashments x
                          WHERE x.employee_id = $1 AND x.leave_type_id = lt.id AND x.year = $2 AND x.status <> 'cancelled'), 0) AS already_encashed_this_year
          FROM leave_types lt
          LEFT JOIN leave_balances lb ON lb.leave_type_id = lt.id AND lb.employee_id = $1 AND lb.year = $2
         WHERE lt.is_encashable = true AND lt.is_active = true AND lt.deleted_at IS NULL
           AND (lt.company_id = $3 OR lt.company_id IS NULL)
      )
      SELECT *, GREATEST(allocated_days + carried_forward_days - used_days - encashed_days, 0) AS balance_days,
             GREATEST(LEAST(
               GREATEST(allocated_days + carried_forward_days - used_days - encashed_days, 0),
               COALESCE(NULLIF(max_encash_days_per_year, 0) - already_encashed_this_year, 100000)
             ), 0) AS max_encashable_now
        FROM b ORDER BY leave_name
    `, [req.params.employee_id, year, cid]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
