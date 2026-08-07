import express from 'express';
import pool from '../shared/db.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import { computeFnf } from './fnf.service.js';

const router = express.Router();

// All routes are mounted under verifyToken in server.js:
//   v1Router.use("/exit", verifyToken, exitRoutes)
// req.scope.company_id is available on every request.

// ── Role gate ──────────────────────────────────────────────────────────────
// Exit management (offboarding, exit interviews, F&F settlement, clearance) is
// confidential HR + financial data with no employee self-service surface, and
// exit-interview feedback is often about line managers — so this module is
// HR-only. Managers / department heads are deliberately excluded (no read).
// Role codes match the Phase 42 role matrix (migration 20260529000001);
// 'hr' is the legacy coarse HR role kept for backward compatibility.
const HR_WRITE_ROLES = new Set(['super_admin', 'admin', 'hr_manager', 'payroll_admin', 'hr']);
const HR_READ_ROLES  = new Set(['super_admin', 'admin', 'hr_manager', 'hr_exec', 'payroll_admin', 'hr']);

function requireHRRead(req, res, next) {
  if (!HR_READ_ROLES.has(req.user?.role ?? '')) {
    return res.status(403).json({ error: 'Exit data is confidential — HR access required' });
  }
  next();
}
function requireHRWrite(req, res, next) {
  if (!HR_WRITE_ROLES.has(req.user?.role ?? '')) {
    return res.status(403).json({ error: 'HR admin access required for this operation' });
  }
  next();
}

// Blanket read gate — blocks employees/non-HR roles from the entire module.
router.use(requireHRRead);

function cid(req) { return req.scope?.company_id ?? null; }

// Scoped employee check — ensures the employee belongs to the caller's company
async function assertEmployeeScope(client, employeeId, companyId) {
  if (!companyId) return; // single-tenant, no check needed
  const { rows } = await client.query(
    `SELECT 1 FROM employees WHERE id=$1 AND company_id=$2`, [employeeId, companyId]
  );
  if (!rows.length) throw Object.assign(new Error('Employee not found'), { status: 404 });
}

// ── Clearance blockers — Exit Clearance Engine ────────────────────────────────
// Final settlement (fnf/:id/pay) is gated on all six of these clearing. The
// first three are computed live from the actual source-of-truth tables (an
// employee can't fake "assets returned" by ticking a checkbox that's
// disconnected from employee_asset_allocations) — only the last three are
// genuine human sign-offs with no system of record to compute them from.
async function computeClearanceBlockers(employeeId) {
  const [assetsRes, advancesRes, accessRes, clearanceRes] = await Promise.allSettled([
    pool.query(
      // 'disposed' (Asset Lifecycle — employee-assets.routes.js) means the
      // asset is written off, no longer anyone's responsibility, so it
      // doesn't block exit the way an unreturned/under-maintenance one does.
      `SELECT id, asset_name, asset_tag FROM employee_asset_allocations
       WHERE employee_id=$1 AND status NOT IN ('returned', 'disposed')`,
      [employeeId]
    ),
    pool.query(
      // travel_advances.employee_id actually stores users.id, not employees.id
      // (see travel.routes.js's GET /advances comment) — resolve through users
      // first, same pattern that route already uses for employee self-scoping,
      // plus a direct employees.id fallback for any legacy row.
      `SELECT COALESCE(SUM(amount - COALESCE(settled_amount,0)), 0) AS outstanding
       FROM travel_advances
       WHERE status NOT IN ('Settled','Rejected','Cancelled')
         AND (
           employee_id IN (SELECT id FROM users WHERE employee_id = $1)
           OR created_by IN (SELECT id FROM users WHERE employee_id = $1)
           OR employee_id = $1
         )`,
      [employeeId]
    ),
    pool.query(
      `SELECT id, email FROM users WHERE employee_id=$1 AND is_active=true`,
      [employeeId]
    ),
    pool.query(`SELECT * FROM exit_clearance WHERE employee_id=$1`, [employeeId]),
  ]);

  const pendingAssets = assetsRes.status === 'fulfilled' ? assetsRes.value.rows : [];
  const outstandingAdvance = advancesRes.status === 'fulfilled'
    ? parseFloat(advancesRes.value.rows[0]?.outstanding || 0) : 0;
  const activeLogins = accessRes.status === 'fulfilled' ? accessRes.value.rows : [];
  const clearance = clearanceRes.status === 'fulfilled' ? (clearanceRes.value.rows[0] || {}) : {};

  const blockers = [
    {
      key: 'assets', label: 'Assets pending return',
      cleared: pendingAssets.length === 0,
      detail: pendingAssets.map(a => a.asset_name + (a.asset_tag ? ` (${a.asset_tag})` : '')),
    },
    {
      key: 'travel_advances', label: 'Travel advances not settled',
      cleared: outstandingAdvance <= 0,
      detail: outstandingAdvance > 0 ? [`₹${outstandingAdvance.toLocaleString('en-IN')} outstanding`] : [],
    },
    {
      key: 'it_access', label: 'IT access not revoked',
      cleared: activeLogins.length === 0,
      detail: activeLogins.map(u => u.email).filter(Boolean),
    },
    { key: 'finance', label: 'Finance clearance pending', cleared: !!clearance.noc_finance, detail: [] },
    { key: 'manager', label: 'Reporting manager approval pending', cleared: !!clearance.noc_manager, detail: [] },
    { key: 'hr', label: 'HR approval pending', cleared: !!clearance.noc_hr, detail: [] },
  ];

  return { employee_id: employeeId, blockers, can_settle: blockers.every(b => b.cleared) };
}

// ── GET /requests ─────────────────────────────────────────────────────────────
router.get('/requests', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = companyId != null
      ? await pool.query(
          `SELECT er.* FROM exit_requests er
           JOIN employees e ON e.id = er.employee_id
           WHERE e.company_id = $1
           ORDER BY er.created_at DESC`, [companyId])
      : await pool.query(`SELECT * FROM exit_requests ORDER BY created_at DESC`);
    res.json(rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /requests ────────────────────────────────────────────────────────────
router.post('/requests', requireHRWrite, async (req, res) => {
  try {
    const { employee_id, reason, last_working_date, notice_period } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO exit_requests (employee_id, reason, last_working_date, notice_period, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
      [employee_id, reason, last_working_date, notice_period]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /requests/:id ─────────────────────────────────────────────────────────
// Workflow Dependency Engine (Priority 7) — this generic status-update
// endpoint could previously mark an exit request 'closed' directly, which
// GET /active treats as "done" (WHERE status NOT IN ('closed','paid')) —
// completely bypassing computeClearanceBlockers and the F&F pay gate that
// 'closed' is supposed to mean. Only POST /fnf/:id/pay may set 'closed' now;
// other statuses (pending/active/rejected/cancelled) are untouched.
router.put('/requests/:id', requireHRWrite, async (req, res) => {
  try {
    const { status, remarks } = req.body;
    if (status === 'closed') {
      const { rows: cur } = await pool.query(`SELECT fnf_status FROM exit_requests WHERE id=$1`, [req.params.id]);
      if (!cur.length) return res.status(404).json({ error: 'Not found' });
      if (cur[0].fnf_status !== 'paid') {
        return res.status(409).json({
          error: "Cannot close an exit request until F&F is paid — use POST /fnf/:id/pay, which enforces exit clearance first",
        });
      }
    }
    const { rows } = await pool.query(
      `UPDATE exit_requests SET status=COALESCE($1,status), remarks=COALESCE($2,remarks), updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [status, remarks, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /active ───────────────────────────────────────────────────────────────
router.get('/active', async (req, res) => {
  try {
    const companyId = cid(req);
    const params = [];
    let cidClause = '';
    if (companyId != null) { params.push(companyId); cidClause = `AND e.company_id = $${params.length}`; }
    const { rows } = await pool.query(`
      SELECT
        er.id,
        er.employee_id,
        COALESCE(e.name, e.first_name || ' ' || e.last_name) AS employee_name,
        e.office_id                                           AS employee_code,
        e.designation,
        e.department,
        er.separation_type,
        er.last_working_date,
        er.status,
        er.fnf_status,
        er.net_payable,
        er.interview_done,
        GREATEST(0, (er.last_working_date::date - CURRENT_DATE)) AS days_remaining
      FROM exit_requests er
      LEFT JOIN employees e ON e.id = er.employee_id
      WHERE er.status NOT IN ('closed','paid') ${cidClause}
      ORDER BY er.last_working_date ASC NULLS LAST
    `, params);
    res.json(rows);
  } catch (e) {
    if (e.message.match(/relation .* does not exist/)) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /initiate ────────────────────────────────────────────────────────────
router.post('/initiate', requireHRWrite, async (req, res) => {
  const client = await pool.connect();
  try {
    const { employee_id, separation_type = 'resignation', last_working_date, notice_period, reason } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

    await client.query('BEGIN');
    await assertEmployeeScope(client, employee_id, cid(req));

    const { rows } = await client.query(
      `INSERT INTO exit_requests
         (employee_id, separation_type, last_working_date, notice_period, reason, status)
       VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
      [employee_id, separation_type, last_working_date, notice_period, reason]
    );

    // Update employee status to match separation type
    const newStatus = separation_type === 'termination' ? 'terminated'
                    : separation_type === 'retirement'  ? 'left'
                    : 'resigned';
    await client.query(
      `UPDATE employees SET status=$1 WHERE id=$2`,
      [newStatus, employee_id]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /employee/:employee_id — exit request + clearance for one employee ────
router.get('/employee/:employee_id', async (req, res) => {
  const empId = Number(req.params.employee_id);
  if (!Number.isInteger(empId) || empId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  const companyId = cid(req);
  try {
    const params = [empId];
    let cidClause = '';
    if (companyId != null) { params.push(companyId); cidClause = `AND e.company_id = $${params.length}`; }
    const [erRes, clRes] = await Promise.allSettled([
      pool.query(
        `SELECT er.* FROM exit_requests er
         JOIN employees e ON e.id = er.employee_id
         WHERE er.employee_id = $1 ${cidClause}
         AND er.status NOT IN ('rejected','cancelled')
         ORDER BY er.created_at DESC LIMIT 1`, params
      ),
      pool.query(`SELECT * FROM exit_clearance WHERE employee_id = $1`, [empId]),
    ]);
    res.json({
      exit_request: erRes.status === 'fulfilled' ? (erRes.value.rows[0] || null) : null,
      clearance:    clRes.status === 'fulfilled' ? (clRes.value.rows[0] || null) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /interviews ───────────────────────────────────────────────────────────
router.get('/interviews', async (req, res) => {
  try {
    const companyId = cid(req);
    const params = [];
    let cidClause = '';
    if (companyId != null) { params.push(companyId); cidClause = `AND e.company_id = $${params.length}`; }
    const { rows } = await pool.query(`
      SELECT
        ei.*,
        COALESCE(e.name, e.first_name || ' ' || e.last_name) AS employee_name,
        e.department
      FROM exit_interviews ei
      LEFT JOIN employees e ON e.id = ei.employee_id
      WHERE 1=1 ${cidClause}
      ORDER BY ei.created_at DESC
    `, params);
    res.json(rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /interviews/analytics ─────────────────────────────────────────────────
router.get('/interviews/analytics', async (req, res) => {
  try {
    const companyId = cid(req);
    const params = companyId != null ? [companyId] : [];
    const cidJoin = companyId != null
      ? `JOIN employees e ON e.id = ei.employee_id AND e.company_id = $1`
      : '';
    const [reasons, ratings] = await Promise.allSettled([
      pool.query(
        `SELECT ei.reason_category, COUNT(*) AS count
         FROM exit_interviews ei ${cidJoin}
         GROUP BY ei.reason_category ORDER BY count DESC`, params
      ),
      pool.query(
        `SELECT
           AVG(ei.rating_management) AS avg_management,
           AVG(ei.rating_culture)    AS avg_culture,
           AVG(ei.rating_work)       AS avg_work,
           AVG(ei.rating_growth)     AS avg_growth,
           AVG(ei.overall_rating)    AS avg_overall
         FROM exit_interviews ei ${cidJoin}`, params
      ),
    ]);
    res.json({
      reasons: reasons.status === 'fulfilled' ? reasons.value.rows : [],
      ratings: ratings.status === 'fulfilled' ? ratings.value.rows[0] : {},
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /interview ───────────────────────────────────────────────────────────
router.post('/interview', requireHRWrite, async (req, res) => {
  try {
    const {
      employee_id, interviewer_id, reason_category, reason_detail, would_rejoin,
      rating_management, rating_culture, rating_work, rating_growth, overall_rating,
    } = req.body;
    const { rows: [er] } = await pool.query(
      `SELECT id FROM exit_requests WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [employee_id]
    );
    const { rows } = await pool.query(
      `INSERT INTO exit_interviews
         (exit_request_id, employee_id, interviewer_id, reason_category, reason_detail,
          would_rejoin, rating_management, rating_culture, rating_work, rating_growth, overall_rating)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [er?.id, employee_id, interviewer_id, reason_category, reason_detail,
       would_rejoin, rating_management, rating_culture, rating_work, rating_growth, overall_rating]
    );
    if (er?.id) {
      await pool.query(`UPDATE exit_requests SET interview_done=TRUE WHERE id=$1`, [er.id]);
    }
    // Also update clearance record
    await pool.query(
      `INSERT INTO exit_clearance (employee_id, exit_interview_done)
       VALUES ($1, TRUE)
       ON CONFLICT (employee_id) DO UPDATE SET exit_interview_done=TRUE, updated_at=NOW()`,
      [employee_id]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /fnf/compute/:employee_id ────────────────────────────────────────────
// Computation itself lives in fnf.service.js so the auto-trigger cron
// (fnfAutoTrigger.cron.js, Automation Opportunity Audit §9.3) can call the
// same logic once last_working_date is reached, instead of this needing to
// be invoked by hand.
router.post('/fnf/compute/:employee_id', requireHRWrite, async (req, res) => {
  try {
    const result = await computeFnf(pool, req.params.employee_id);
    if (!result) return res.status(404).json({ error: 'Employee or exit request not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /fnf/:id/approve ──────────────────────────────────────────────────────
router.put('/fnf/:id/approve', requireHRWrite, async (req, res) => {
  try {
    const { rows: [oldRecord] } = await pool.query(
      `SELECT * FROM exit_requests WHERE id=$1`, [req.params.id]
    );
    const { rows } = await pool.query(
      `UPDATE exit_requests SET fnf_status='approved', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const updatedRecord = rows[0];
    logAudit({ userId: req.user?.userId, module: 'HR', recordId: req.params.id, recordType: 'fnf_settlement', action: 'approve', oldData: oldRecord, newData: updatedRecord, req });
    // Look up the employee's userId for workflow notification. employees has
    // no user_id column (this always 500'd silently into the .catch below,
    // so the F&F-approval notification never fired) — resolve via the
    // reverse FK instead, same fix as promotions.routes.js/increments.routes.js.
    pool.query(`SELECT id AS user_id FROM users WHERE employee_id=$1`, [updatedRecord.employee_id])
      .then(({ rows: empRows }) => {
        notifyWorkflowEvent('approved', { module: 'HR', recordId: req.params.id, submitterUserId: empRows[0]?.user_id ?? null });
      }).catch(() => {});
    res.json(updatedRecord);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /fnf/:id/pay — marks F&F paid and bridges employee to 'left' ─────────
router.post('/fnf/:id/pay', requireHRWrite, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: erRows } = await client.query(`SELECT employee_id FROM exit_requests WHERE id=$1`, [req.params.id]);
    if (!erRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

    // Exit Clearance Engine gate — final settlement cannot be disbursed while
    // any of assets/travel-advances/IT-access/finance/manager/HR clearance is
    // still outstanding. See computeClearanceBlockers above.
    const clearanceStatus = await computeClearanceBlockers(erRows[0].employee_id);
    if (!clearanceStatus.can_settle) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Cannot mark F&F as paid — exit clearance is incomplete',
        blockers: clearanceStatus.blockers.filter(b => !b.cleared),
      });
    }

    const { rows } = await client.query(
      `UPDATE exit_requests SET fnf_status='paid', status='closed', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const er = rows[0];
    // Bridge: mark employee as 'left' and populate exit_date so ExEmployees list shows them
    await client.query(
      `UPDATE employees
          SET status = 'left',
              exit_date = COALESCE(exit_date, $1)
        WHERE id = $2`,
      [er.last_working_date || null, er.employee_id]
    );
    await client.query('COMMIT');
    res.json(er);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── GET /clearance/:employee_id ───────────────────────────────────────────────
const EMPTY_CLEARANCE = {
  it_assets_returned: false, access_revoked: false, documents_collected: false,
  exit_interview_done: false, noc_it: false, noc_admin: false,
  noc_finance: false, noc_hr: false, noc_manager: false,
};

router.get('/clearance/:employee_id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM exit_clearance WHERE employee_id=$1`, [req.params.employee_id]
    );
    res.json(rows.length ? rows[0] : { employee_id: req.params.employee_id, ...EMPTY_CLEARANCE });
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json({ employee_id: req.params.employee_id, ...EMPTY_CLEARANCE });
    res.status(500).json({ error: e.message });
  }
});

// ── GET /clearance/:employee_id/status — computed blockers for the Clearance
// Status dashboard. Unlike GET /clearance above (raw stored flags), this
// cross-checks the three system-of-record tables so a stale/never-updated
// checkbox can't misreport an employee as clear. ─────────────────────────────
router.get('/clearance/:employee_id/status', async (req, res) => {
  const empId = Number(req.params.employee_id);
  if (!Number.isInteger(empId) || empId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  try {
    res.json(await computeClearanceBlockers(empId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /clearance/:employee_id ───────────────────────────────────────────────
router.put('/clearance/:employee_id', requireHRWrite, async (req, res) => {
  try {
    const {
      it_assets_returned, access_revoked, documents_collected, exit_interview_done,
      noc_it, noc_admin, noc_finance, noc_hr, noc_manager,
    } = req.body;
    // Who's granting the NOC — only stamped when the flag is actually being
    // set true this call, so an existing sign-off isn't overwritten by a
    // later PUT that leaves the flag unchanged (COALESCE keeps prior value).
    const actorEmployeeId = req.user?.employee_id ?? null;
    const financeNocBy = noc_finance ? actorEmployeeId : null;
    const managerNocBy = noc_manager ? actorEmployeeId : null;
    const hrNocBy      = noc_hr ? actorEmployeeId : null;
    const { rows } = await pool.query(
      `INSERT INTO exit_clearance
         (employee_id, it_assets_returned, access_revoked, documents_collected, exit_interview_done,
          noc_it, noc_admin, noc_finance, noc_hr, noc_manager,
          finance_noc_by, manager_noc_by, hr_noc_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (employee_id) DO UPDATE SET
         it_assets_returned=$2, access_revoked=$3, documents_collected=$4, exit_interview_done=$5,
         noc_it=$6, noc_admin=$7, noc_finance=$8, noc_hr=$9, noc_manager=$10,
         finance_noc_by = CASE WHEN $8  THEN COALESCE(exit_clearance.finance_noc_by, $11) ELSE NULL END,
         manager_noc_by = CASE WHEN $10 THEN COALESCE(exit_clearance.manager_noc_by, $12) ELSE NULL END,
         hr_noc_by      = CASE WHEN $9  THEN COALESCE(exit_clearance.hr_noc_by, $13) ELSE NULL END,
         updated_at=NOW()
       RETURNING *`,
      [req.params.employee_id, it_assets_returned, access_revoked, documents_collected,
       exit_interview_done, noc_it, noc_admin, noc_finance, noc_hr, noc_manager,
       financeNocBy, managerNocBy, hrNocBy]
    );

    // Actually revoke the login, not just the checklist checkbox. Previously
    // ticking "access revoked" only wrote this flag — nothing ever set
    // users.is_active, so a resigned/terminated employee's account stayed live.
    if (access_revoked) {
      const { rows: deactivated } = await pool.query(
        `UPDATE users SET is_active = false, updated_at = NOW()
         WHERE employee_id = $1 AND is_active = true
         RETURNING id, email`,
        [req.params.employee_id]
      );
      if (deactivated.length) {
        logAudit({
          userId: req.user?.userId ?? req.user?.id, module: 'hr', recordId: req.params.employee_id,
          recordType: 'exit_clearance', action: 'access_revoked',
          newData: { deactivated_user_ids: deactivated.map(u => u.id) }, req,
        });
      }
    }

    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
