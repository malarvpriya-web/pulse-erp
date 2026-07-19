import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';

const router = express.Router();

// ── GET /leave-encashment — list encashment records ───────────────────────────
router.get('/', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const { status, year } = req.query;

    const params = [companyId];
    let filters = '';
    if (status) { filters += ` AND le.status = $${params.length + 1}`; params.push(status); }
    if (year)   { filters += ` AND le.year   = $${params.length + 1}`; params.push(Number(year)); }

    const { rows } = await pool.query(`
      SELECT le.*,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation, e.office_id AS employee_code,
        lt.leave_name,
        COALESCE(a.name, CONCAT(a.first_name,' ',a.last_name)) AS approved_by_name
      FROM leave_encashments le
      JOIN employees e  ON le.employee_id = e.id
      JOIN leave_types lt ON le.leave_type_id = lt.id
      LEFT JOIN employees a ON le.approved_by = a.id
      WHERE ($1::integer IS NULL OR le.company_id = $1)${filters}
      ORDER BY le.created_at DESC
    `, params);
    res.json(rows);
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

    const companyId = req.scope?.company_id ?? null;
    const resolvedYear = Number(year) || new Date().getFullYear();

    // Get employee's basic salary for rate calculation
    const { rows: empRows } = await pool.query(
      `SELECT basic_salary FROM employees WHERE id = $1`, [employee_id]
    );
    const basicSalary = Number(empRows[0]?.basic_salary || 0);
    const ratePerDay  = basicSalary > 0 ? Number((basicSalary / 26).toFixed(2)) : 0;
    const grossAmount = Number((Number(days_encashed) * ratePerDay).toFixed(2));
    // Configurable TDS rate. Pass tds_rate in request body (e.g. 0.05, 0.20, 0.30 per employee's slab).
    // Defaults to 10% if not specified. HR must select the correct rate for the employee's income slab.
    const tdsRate   = Math.min(Math.max(Number(req.body.tds_rate ?? 0.10), 0), 1);
    const tdsAmount = Number((grossAmount * tdsRate).toFixed(2));
    const netAmount   = Number((grossAmount - tdsAmount).toFixed(2));

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
    `, [employee_id, leave_type_id, resolvedYear, Number(days_encashed), ratePerDay, grossAmount,
        tdsAmount, netAmount, encashment_month || null, encashment_year || null, reason || null, companyId]);

    logAudit({ userId: req.user?.userId, module: 'leave_encashment', recordId: rows[0].id, recordType: 'leave_encashment', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /leave-encashment/approve/:id ───────────────────────────────────────
router.post('/approve/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: enc } = await client.query(`SELECT * FROM leave_encashments WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!enc.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Encashment record not found' }); }
    if (enc[0].status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Already processed' }); }

    const e = enc[0];

    // 1. Approve the encashment record
    await client.query(`
      UPDATE leave_encashments
      SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
      WHERE id = $2
    `, [req.user?.employee_id, req.params.id]);

    // 2. Deduct from leave balance (atomic)
    await client.query(`
      UPDATE leave_balances
      SET encashed_days = COALESCE(encashed_days, 0) + $1,
          used_days     = COALESCE(used_days, 0) + $1,
          updated_at    = NOW()
      WHERE employee_id = $2 AND leave_type_id = $3 AND year = $4
    `, [e.days_encashed, e.employee_id, e.leave_type_id, e.year]);

    // 3. Post net_amount to payroll_runs for the encashment month/year
    //    If a pending payroll run exists for this employee, inject the encashment.
    //    If none exists yet, store the amount in a staging column for the next run.
    const encMonth = e.encashment_month || new Date().getMonth() + 1;
    const encYear  = e.encashment_year  || new Date().getFullYear();

    const { rows: runRows } = await client.query(`
      SELECT id FROM payroll_runs
      WHERE employee_id = $1 AND month = $2 AND year = $3 AND status NOT IN ('paid','cancelled')
      LIMIT 1
    `, [e.employee_id, encMonth, encYear]).catch(() => ({ rows: [] }));

    if (runRows.length) {
      await client.query(`
        UPDATE payroll_runs
        SET leave_encashment_amount = COALESCE(leave_encashment_amount, 0) + $1,
            updated_at = NOW()
        WHERE id = $2
      `, [e.net_amount, runRows[0].id]).catch(() => {});
    }

    // 4. Always record the payroll_run_id on the encashment for traceability
    if (runRows.length) {
      await client.query(`
        UPDATE leave_encashments SET payroll_run_id = $1 WHERE id = $2
      `, [runRows[0].id, req.params.id]);
    }

    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId, module: 'leave_encashment', recordId: req.params.id, recordType: 'leave_encashment', action: 'approve', oldData: e, newData: { status: 'approved', net_amount: e.net_amount, payroll_run_id: runRows[0]?.id ?? null }, req });
    // Notify employee (non-blocking)
    import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('approved', {
        module: 'LeaveEncashment',
        recordId: Number(req.params.id),
        submitterId: e.employee_id,
        recipientIds: [e.employee_id],
        comments: `Leave encashment of ₹${e.net_amount} approved`,
      }).catch(() => {});
    }).catch(() => {});
    res.json({ success: true, payroll_run_id: runRows[0]?.id ?? null });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── POST /leave-encashment/reject/:id ────────────────────────────────────────
router.post('/reject/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Rejection reason is required' });

    const { rows } = await pool.query(`
      UPDATE leave_encashments
      SET status = 'rejected', approved_by = $1, approved_at = NOW(),
          reason = $2, updated_at = NOW()
      WHERE id = $3 AND status = 'pending'
      RETURNING id
    `, [req.user?.employee_id, reason, req.params.id]);
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
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const { rows } = await pool.query(`
      SELECT
        lt.id AS leave_type_id, lt.leave_name,
        lt.max_encash_days_per_year,
        COALESCE(lb.allocated_days, 0) AS allocated_days,
        COALESCE(lb.used_days, 0) AS used_days,
        GREATEST(COALESCE(lb.allocated_days,0) - COALESCE(lb.used_days,0), 0) AS balance_days,
        COALESCE(encashed.total, 0) AS already_encashed_this_year,
        GREATEST(
          LEAST(
            GREATEST(COALESCE(lb.allocated_days,0) - COALESCE(lb.used_days,0), 0),
            COALESCE(lt.max_encash_days_per_year, 0) - COALESCE(encashed.total, 0)
          ), 0
        ) AS max_encashable_now
      FROM leave_types lt
      LEFT JOIN leave_balances lb ON lb.leave_type_id = lt.id AND lb.employee_id = $1 AND lb.year = $2
      LEFT JOIN (
        SELECT leave_type_id, SUM(days_encashed) AS total
        FROM leave_encashments
        WHERE employee_id = $1 AND year = $2 AND status != 'cancelled'
        GROUP BY leave_type_id
      ) encashed ON encashed.leave_type_id = lt.id
      WHERE lt.is_encashable = true AND lt.is_active = true AND lt.deleted_at IS NULL
      ORDER BY lt.leave_name
    `, [req.params.employee_id, year]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
