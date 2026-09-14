import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission, allowRoles, hasRole } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import {
  COMP_OFF_EXPIRY_MONTHS,
  HALF_DAY_HOURS,
  NO_COMP_OFF_TYPE_MESSAGE,
  checkEligibility,
  compOffLeaveTypeId,
  creditDaysFor,
} from '../../../shared/compOff.js';

const router = express.Router();

// Who sees the whole company's queue vs. only their own requests.
// hasRole() unions the many-to-many user_roles rows; reading req.user.role sees
// only the PRIMARY role, so an approver whose approver role was secondary got
// served their own records and could never see anything to approve.
const ADMIN_ROLES    = ['admin', 'super_admin', 'hr', 'hr_manager', 'hr_exec'];
const APPROVER_ROLES = ['manager', 'department_head', 'l2_approver'];
// Manual expiry reverses leave balances. Not something a requester may trigger.
const EXPIRY_ROLES   = [...ADMIN_ROLES];

const VALID_STATUSES = ['pending', 'approved', 'rejected', 'used'];

const todayISO = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

// ── GET /comp-off/eligibility?date=YYYY-MM-DD ────────────────────────────────
// The request form asks before it submits, so the employee sees "Saturday —
// weekend" or "Wednesday is a working day" while picking the date, instead of
// filling the whole form and losing it to a 422 on submit.
router.get('/eligibility', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    const result = await checkEligibility(pool, date, companyOf(req));
    if (date > todayISO()) {
      return res.json({
        ...result,
        eligible: false,
        reason: 'That date is in the future — comp off is claimed for work already done.',
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Which comp-off rows this caller may see, as a SQL fragment + binds.
 *
 * Shared by the list and the summary so the KPI strip can never describe a
 * different set of rows than the table under it. They used to disagree
 * visibly: the strip was fed by /balance/:employee_id (always ONE employee)
 * while the table showed the whole company, so an admin with no employees row
 * saw "Pending Requests 0" directly above a chip reading "Pending (2)".
 *
 * `visible: false` means show nothing — never fall through unfiltered, which
 * would hand a caller with no employee record the whole company.
 */
async function visibleScope(req) {
  const companyId  = companyOf(req);
  const empId      = await employeeOf(req, pool);
  const isAdmin    = hasRole(req, ADMIN_ROLES);
  const isApprover = isAdmin || hasRole(req, APPROVER_ROLES);

  const params = [companyId];
  if (isAdmin) {
    return { visible: true, scope: 'company', params, clause: '' };
  }
  if (isApprover && empId != null) {
    // Own requests plus their direct reports' — the queue the Approve/Reject
    // buttons act on. Without this a manager saw only their own rows, so the
    // approval column the page renders for them was permanently empty.
    params.push(empId);
    return { visible: true, scope: 'team', params, clause: ` AND (co.employee_id = $${params.length} OR e.reporting_manager_id = $${params.length})` };
  }
  if (empId == null) return { visible: false, scope: 'none', params, clause: '' };
  params.push(empId);
  return { visible: true, scope: 'self', params, clause: ` AND co.employee_id = $${params.length}` };
}

// ── GET /comp-off/summary — KPI strip, over exactly the rows the list returns ─
router.get('/summary', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const s = await visibleScope(req);
    const empty = { scope: s.scope, available_days: 0, available_credits: 0, pending_requests: 0, expired_credits: 0 };
    if (!s.visible) return res.json(empty);

    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN co.status = 'approved' AND co.credited = true AND co.expires_on >= CURRENT_DATE
                 THEN CASE WHEN co.hours_worked >= 8 THEN 1 WHEN co.hours_worked >= 4 THEN 0.5 ELSE 0 END
                 ELSE 0 END), 0)                                                              AS available_days,
        COUNT(*) FILTER (WHERE co.status = 'approved' AND co.credited = true AND co.expires_on >= CURRENT_DATE) AS available_credits,
        COUNT(*) FILTER (WHERE co.status = 'pending')                                          AS pending_requests,
        COUNT(*) FILTER (WHERE co.expires_on < CURRENT_DATE AND co.status IN ('approved','used')) AS expired_credits
      FROM compensatory_off co
      JOIN employees e ON co.employee_id = e.id
      WHERE ($1::integer IS NULL OR co.company_id = $1)${s.clause}
    `, s.params);
    res.json({ scope: s.scope, ...rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /comp-off — list comp off records ────────────────────────────────────
router.get('/', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const s = await visibleScope(req);
    if (!s.visible) return res.json([]);
    const params = [...s.params];
    const scopeClause = s.clause;

    // The page's status chips have always sent ?status=; nothing read it and
    // nothing filtered client-side either, so every chip showed the same list.
    let statusClause = '';
    const status = String(req.query.status || '').toLowerCase();
    if (status) {
      if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status filter' });
      params.push(status);
      statusClause = ` AND co.status = $${params.length}`;
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
      WHERE ($1::integer IS NULL OR co.company_id = $1)${scopeClause}${statusClause}
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

    const date = String(work_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'work_date must be YYYY-MM-DD' });
    if (date > todayISO()) {
      return res.status(422).json({ error: 'Comp off is claimed for work already done — pick a date on or before today.' });
    }

    // employeeOf() falls back to the users row; req.user.employee_id alone is
    // undefined for legacy logins, and an undefined bind becomes NULL, which
    // this NOT NULL column rejects as an opaque 500.
    const empId = await employeeOf(req, pool);
    if (empId == null) {
      return res.status(400).json({ error: 'Your login is not linked to an employee record, so comp off cannot be filed against it.' });
    }
    const companyId = companyOf(req);

    const hours = Number(hours_worked ?? 8);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      return res.status(400).json({ error: 'hours_worked must be between 1 and 24' });
    }
    if (creditDaysFor(hours) === 0) {
      return res.status(422).json({ error: `Comp off needs at least ${HALF_DAY_HOURS} hours of work — ${hours}h earns no credit.` });
    }

    const eligibility = await checkEligibility(pool, date, companyId);
    if (!eligibility.eligible) return res.status(422).json({ error: eligibility.reason });

    // Check for duplicate
    const { rows: dup } = await pool.query(
      `SELECT id FROM compensatory_off WHERE employee_id = $1 AND work_date = $2::date AND status != 'rejected'`,
      [empId, date]
    );
    if (dup.length) return res.status(409).json({ error: 'A comp off request for this date already exists' });

    // expires_on in SQL, not JS. Date#setMonth mutates in LOCAL time while
    // toISOString() reads back UTC, so the old code filed every expiry a day
    // early east of UTC, and 30 Nov + 3 months rolled through Feb 30 to 2 Mar.
    const { rows } = await pool.query(`
      INSERT INTO compensatory_off (employee_id, work_date, hours_worked, holiday_id, reason, expires_on, company_id, project_id)
      VALUES ($1, $2::date, $3, $4, $5, ($2::date + ($6 || ' months')::interval)::date, $7, $8)
      RETURNING *
    `, [
      empId, date, hours,
      holiday_id || eligibility.holiday?.id || null,
      reason || null,
      String(COMP_OFF_EXPIRY_MONTHS),
      companyId,
      project_id || null,
    ]);

    logAudit({ userId: req.user?.userId, module: 'comp_off', recordId: rows[0].id, recordType: 'compensatory_off', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /comp-off/approve/:id — manager approves → credits leave balance ────
router.post('/approve/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { comments } = req.body;
    const approverId = await employeeOf(req, pool);

    const { rows: existing } = await client.query(
      `SELECT * FROM compensatory_off WHERE id = $1`, [req.params.id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Comp off request not found' });
    if (existing[0].status !== 'pending') return res.status(409).json({ error: 'Request already processed' });

    const co = existing[0];

    // Resolve the destination BEFORE promising a credit. The old route credited
    // inside `if (ltRows.length)` and then answered `{ credited: true }` either
    // way — on a database where no leave type carries is_comp_off_type (the
    // shipped seed flags none) it marked the record credited, told the employee
    // their balance had risen, and moved nothing.
    const leaveTypeId = await compOffLeaveTypeId(client, co.company_id);
    if (leaveTypeId == null) return res.status(409).json({ error: NO_COMP_OFF_TYPE_MESSAGE });

    const creditDays = creditDaysFor(co.hours_worked);
    if (creditDays === 0) {
      return res.status(422).json({ error: `${co.hours_worked}h earns no comp off — the minimum is ${HALF_DAY_HOURS} hours.` });
    }

    await client.query('BEGIN');
    await client.query(`
      UPDATE compensatory_off
      SET status = 'approved', approved_by = $1, approved_at = NOW(), comments = $2, credited = true, updated_at = NOW()
      WHERE id = $3
    `, [approverId, comments || null, req.params.id]);

    // work_date is a DATE, which config/db.js hands back as 'YYYY-MM-DD'.
    // new Date(...).getFullYear() on that string reads UTC-parsed midnight in
    // local time — a 1 Jan work date books the credit against the prior year
    // west of UTC. Slice the string instead.
    const year = Number(String(co.work_date).slice(0, 4));
    await client.query(`
      INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
      VALUES ($1, $2, $3, $4, 0)
      ON CONFLICT (employee_id, leave_type_id, year)
      DO UPDATE SET allocated_days = leave_balances.allocated_days + $4, updated_at = NOW()
    `, [co.employee_id, leaveTypeId, year, creditDays]);
    await client.query('COMMIT');

    logAudit({ userId: req.user?.userId, module: 'comp_off', recordId: req.params.id, recordType: 'compensatory_off', action: 'approve', oldData: co, newData: { status: 'approved', approved_by: approverId, credited: true, credit_days: creditDays }, req });
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
    res.json({ success: true, credited: true, credit_days: creditDays, leave_type_id: leaveTypeId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
    `, [await employeeOf(req, pool), comments, req.params.id]);
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

// ── POST /comp-off/expire — expire old credits, reversing the leave balance ──
// leave.cron.js runs this nightly; the route is the manual re-run. It was gated
// on leaves:add — the permission every employee holds to file their OWN request
// — and its query carried no company predicate, so any logged-in employee could
// reverse leave balances for every tenant in the database. HR/admin only now,
// and scoped to the caller's company.
router.post('/expire', requirePermission('leaves', 'approve'), allowRoles(...EXPIRY_ROLES), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { rows: expiring } = await pool.query(`
      SELECT co.*, lt.id AS comp_lt_id
      FROM compensatory_off co
      LEFT JOIN leave_types lt
        ON lt.is_comp_off_type = true AND lt.is_active = true AND lt.deleted_at IS NULL
        AND (lt.company_id IS NULL OR lt.company_id = co.company_id)
      WHERE co.status = 'approved' AND co.credited = true AND co.expires_on < CURRENT_DATE
        AND ($1::integer IS NULL OR co.company_id = $1)
    `, [companyId]);

    if (!expiring.length) return res.json({ success: true, expired: 0, records: [] });

    const expired = [];
    for (const co of expiring) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // credited=false as well as status='used': the balance has been taken
        // back, so leaving credited=true both misreports the record and makes
        // it a candidate for this same sweep on every subsequent run.
        await client.query(`
          UPDATE compensatory_off
          SET status = 'used', credited = false,
              comments = 'Expired — comp off not utilised within validity period', updated_at = NOW()
          WHERE id = $1
        `, [co.id]);
        if (co.comp_lt_id) {
          const creditDays = creditDaysFor(co.hours_worked);
          const year = Number(String(co.work_date).slice(0, 4));
          await client.query(`
            UPDATE leave_balances
            SET allocated_days = GREATEST(COALESCE(allocated_days,0) - $1, 0), updated_at = NOW()
            WHERE employee_id = $2 AND leave_type_id = $3 AND year = $4
          `, [creditDays, co.employee_id, co.comp_lt_id, year]);
        }
        await client.query('COMMIT');
        expired.push({ id: co.id, employee_id: co.employee_id });
      } catch {
        await client.query('ROLLBACK').catch(() => {});
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
    const empId = parseInt(req.params.employee_id, 10);
    if (!Number.isInteger(empId)) {
      return res.json({ available_credits: 0, available_days: 0, pending_requests: 0, expired_credits: 0 });
    }

    // Anyone holding leaves:view could read any employee's comp-off balance by
    // walking the id in the URL. Own record unless the caller approves for others.
    const callerEmpId = await employeeOf(req, pool);
    const privileged  = hasRole(req, ADMIN_ROLES) || hasRole(req, APPROVER_ROLES);
    if (!privileged && empId !== callerEmpId) return res.status(403).json({ error: 'Access denied' });

    // The half-day band matches creditDaysFor(): under 4h earns nothing, so the
    // old `hours_worked >= 8 THEN 1 ELSE 0.5` paid half a day for a one-hour
    // stint and the card disagreed with what approval actually credited.
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'approved' AND credited = true AND expires_on >= CURRENT_DATE) AS available_credits,
        COALESCE(SUM(CASE WHEN status = 'approved' AND credited = true AND expires_on >= CURRENT_DATE
                 THEN CASE WHEN hours_worked >= 8 THEN 1 WHEN hours_worked >= 4 THEN 0.5 ELSE 0 END
                 ELSE 0 END), 0) AS available_days,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_requests,
        COUNT(*) FILTER (WHERE expires_on < CURRENT_DATE AND status IN ('approved','used')) AS expired_credits
      FROM compensatory_off
      WHERE employee_id = $1 AND ($2::integer IS NULL OR company_id = $2)
    `, [empId, companyOf(req)]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
