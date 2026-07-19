import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';

const router = express.Router();

const COMP_OFF_EXPIRY_MONTHS = 3; // Default: comp off expires 3 months after earning

// ── GET /comp-off — list comp off records ────────────────────────────────────
router.get('/', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const role = (req.user?.role || '').toLowerCase();
    const isAdmin = ['admin','super_admin','hr','hr_manager'].includes(role);

    const params = [companyId];
    let empClause = '';
    if (!isAdmin) {
      empClause = ` AND co.employee_id = $2`;
      params.push(req.user?.employee_id);
    }

    const { rows } = await pool.query(`
      SELECT co.*,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department,
        COALESCE(a.name, CONCAT(a.first_name,' ',a.last_name)) AS approved_by_name,
        h.name AS holiday_name
      FROM compensatory_off co
      JOIN employees e ON co.employee_id = e.id
      LEFT JOIN employees a ON co.approved_by = a.id
      LEFT JOIN holidays h ON co.holiday_id = h.id
      WHERE ($1::integer IS NULL OR co.company_id = $1)${empClause}
      ORDER BY co.work_date DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /comp-off — employee submits worked-on-holiday request ──────────────
router.post('/', requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const { work_date, hours_worked, holiday_id, reason, project_id } = req.body;
    if (!work_date) return res.status(400).json({ error: 'work_date is required' });

    const empId = req.user?.employee_id;
    const companyId = req.scope?.company_id ?? null;

    // Calculate expiry: work_date + COMP_OFF_EXPIRY_MONTHS months
    const expiryDate = new Date(work_date);
    expiryDate.setMonth(expiryDate.getMonth() + COMP_OFF_EXPIRY_MONTHS);

    // Validate work_date is a weekend or declared holiday
    const workDay = new Date(work_date).getDay();
    const isWeekend = workDay === 0 || workDay === 6;
    if (!isWeekend) {
      const { rows: holRows } = await pool.query(
        `SELECT 1 FROM holidays WHERE date = $1::date AND (company_id = $2 OR company_id IS NULL) LIMIT 1`,
        [work_date, companyId]
      );
      if (!holRows.length) {
        return res.status(422).json({ error: 'Comp off can only be claimed for work done on a weekend or declared holiday.' });
      }
    }

    // Check for duplicate
    const { rows: dup } = await pool.query(
      `SELECT id FROM compensatory_off WHERE employee_id = $1 AND work_date = $2 AND status != 'rejected'`,
      [empId, work_date]
    );
    if (dup.length) return res.status(409).json({ error: 'A comp off request for this date already exists' });

    const { rows } = await pool.query(`
      INSERT INTO compensatory_off (employee_id, work_date, hours_worked, holiday_id, reason, expires_on, company_id, project_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [empId, work_date, hours_worked || 8, holiday_id || null, reason || null, expiryDate.toISOString().slice(0,10), companyId, project_id || null]);

    logAudit({ userId: req.user?.userId, module: 'comp_off', recordId: rows[0].id, recordType: 'compensatory_off', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /comp-off/approve/:id — manager approves → credits leave balance ────
router.post('/approve/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const { comments } = req.body;
    const approverId = req.user?.employee_id;

    const { rows: existing } = await pool.query(
      `SELECT * FROM compensatory_off WHERE id = $1`, [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Comp off request not found' });
    if (existing[0].status !== 'pending') return res.status(409).json({ error: 'Request already processed' });

    const co = existing[0];

    // Update comp_off record
    await pool.query(`
      UPDATE compensatory_off
      SET status = 'approved', approved_by = $1, approved_at = NOW(), comments = $2, credited = true, updated_at = NOW()
      WHERE id = $3
    `, [approverId, comments || null, req.params.id]);

    // Credit leave balance — find compensatory leave type
    const { rows: ltRows } = await pool.query(`
      SELECT id FROM leave_types
      WHERE is_comp_off_type = true AND is_active = true AND deleted_at IS NULL
        AND (company_id IS NULL OR company_id = $1)
      ORDER BY id LIMIT 1
    `, [co.company_id]);

    if (ltRows.length) {
      const year = new Date(co.work_date).getFullYear();
      const creditDays = co.hours_worked >= 8 ? 1 : 0.5;
      await pool.query(`
        INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
        VALUES ($1, $2, $3, $4, 0)
        ON CONFLICT (employee_id, leave_type_id, year)
        DO UPDATE SET allocated_days = leave_balances.allocated_days + $4, updated_at = NOW()
      `, [co.employee_id, ltRows[0].id, year, creditDays]);
    }

    logAudit({ userId: req.user?.userId, module: 'comp_off', recordId: req.params.id, recordType: 'compensatory_off', action: 'approve', oldData: co, newData: { status: 'approved', approved_by: approverId, credited: true }, req });
    // Notify employee (non-blocking)
    import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('approved', {
        module: 'CompOff',
        recordId: Number(req.params.id),
        submitterId: co.employee_id,
        recipientIds: [co.employee_id],
        comments: comments || '',
      }).catch(() => {});
    }).catch(() => {});
    res.json({ success: true, credited: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /comp-off/reject/:id ─────────────────────────────────────────────────
router.post('/reject/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const { comments } = req.body;
    if (!comments?.trim()) return res.status(400).json({ error: 'Rejection reason is required' });

    const { rows } = await pool.query(`
      UPDATE compensatory_off
      SET status = 'rejected', approved_by = $1, approved_at = NOW(), comments = $2, updated_at = NOW()
      WHERE id = $3 AND status = 'pending'
      RETURNING *
    `, [req.user?.employee_id, comments, req.params.id]);
    if (!rows.length) return res.status(409).json({ error: 'Request not found or already processed' });

    logAudit({ userId: req.user?.userId, module: 'comp_off', recordId: req.params.id, recordType: 'compensatory_off', action: 'reject', newData: { status: 'rejected', comments }, req });
    // Notify employee (non-blocking)
    import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('rejected', {
        module: 'CompOff',
        recordId: Number(req.params.id),
        submitterId: rows[0].employee_id,
        recipientIds: [rows[0].employee_id],
        comments,
      }).catch(() => {});
    }).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /comp-off/expire — expire old unprocessed credits, reverses leave balance ─
router.post('/expire', requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const { rows: expiring } = await pool.query(`
      SELECT co.*, lt.id AS comp_lt_id
      FROM compensatory_off co
      LEFT JOIN leave_types lt
        ON lt.is_comp_off_type = true AND lt.is_active = true AND lt.deleted_at IS NULL
        AND (lt.company_id IS NULL OR lt.company_id = co.company_id)
      WHERE co.status = 'approved' AND co.credited = true AND co.expires_on < CURRENT_DATE
    `);

    if (!expiring.length) return res.json({ success: true, expired: 0, records: [] });

    const expired = [];
    for (const co of expiring) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          UPDATE compensatory_off
          SET status = 'used', comments = 'Expired — comp off not utilised within validity period', updated_at = NOW()
          WHERE id = $1
        `, [co.id]);
        if (co.comp_lt_id) {
          const creditDays = co.hours_worked >= 8 ? 1 : 0.5;
          const year = new Date(co.work_date).getFullYear();
          await client.query(`
            UPDATE leave_balances
            SET allocated_days = GREATEST(COALESCE(allocated_days,0) - $1, 0), updated_at = NOW()
            WHERE employee_id = $2 AND leave_type_id = $3 AND year = $4
          `, [creditDays, co.employee_id, co.comp_lt_id, year]);
        }
        await client.query('COMMIT');
        expired.push({ id: co.id, employee_id: co.employee_id });
      } catch (err) {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }

    logAudit({ userId: req.user?.userId, module: 'comp_off', recordId: null, recordType: 'comp_off_expiry', action: 'manual_expire', newData: { records_expired: expired.length }, req });
    res.json({ success: true, expired: expired.length, records: expired });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /comp-off/balance/:employee_id ───────────────────────────────────────
router.get('/balance/:employee_id', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const empId = req.params.employee_id;
    if (!empId || empId === 'null' || empId === 'undefined' || isNaN(parseInt(empId, 10))) {
      return res.json({ available_credits: 0, available_days: 0, pending_requests: 0, expired_credits: 0 });
    }
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'approved' AND credited = true AND expires_on >= CURRENT_DATE) AS available_credits,
        SUM(CASE WHEN status = 'approved' AND credited = true AND expires_on >= CURRENT_DATE
                 THEN CASE WHEN hours_worked >= 8 THEN 1 ELSE 0.5 END ELSE 0 END)                    AS available_days,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_requests,
        COUNT(*) FILTER (WHERE expires_on < CURRENT_DATE AND status = 'approved')                     AS expired_credits
      FROM compensatory_off
      WHERE employee_id = $1
    `, [req.params.employee_id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
