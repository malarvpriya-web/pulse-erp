import express from 'express';
import pool from '../shared/db.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import { computeFnf } from './fnf.service.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { EXIT_STATUS, NOTICE_STATUS, NOTICE_STATUSES, EXITED_STATUSES } from '../../shared/employeeStatus.js';
import { readScope } from '../../shared/employeeAccess.js';
import { fnfSettlementSuspended, fnfSuspendedBody, FNF_SUSPENDED_MESSAGE } from '../../shared/hrContainment.js';

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

// Company gate (2026-10-20). Every handler below scopes with
// `($n::int IS NULL OR e.company_id = $n)` on cid(req) — and cid() is NULL not
// only for a super admin's deliberate global scope but also for a user whose
// company could not be resolved (auth.middleware sets req.scope = null). For
// that second caller every one of those predicates switched OFF: an HR login
// with no company could withdraw, edit or create exit requests in ANY company.
// readScope() (shared/employeeAccess.js) lets NULL through for super_admin only.
// After this gate, cid(req) === null means "super admin, global" and nothing else.
router.use((req, res, next) => {
  if (readScope(req).refused) {
    return res.status(403).json({ error: 'Your account has no company assignment' });
  }
  next();
});

function cid(req) { return req.scope?.company_id ?? null; }

/**
 * A route-param or body employee id → positive integer, or null.
 * "12abc", "1.5", "0", "-3" are all null (→ 400), never parseInt'd into 12.
 */
function intId(raw) {
  const s = String(raw ?? '').trim();
  return /^[1-9][0-9]{0,9}$/.test(s) && Number(s) <= 2147483647 ? Number(s) : null;
}

/** Is this (not deleted) employee in the caller's company? NULL = super admin (company gate). */
async function employeeInCompany(db, employeeId, companyId) {
  const { rows } = await db.query(
    `SELECT 1 FROM employees WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2::int)`,
    [employeeId, companyId]
  );
  return rows.length > 0;
}

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
    // exit_requests has no company_id: the request belongs to whichever company
    // the employee does. Verify that is the caller's before writing — this
    // created a request against any company's employee id.
    const empId = Number(employee_id);
    if (!Number.isInteger(empId) || empId < 1) return res.status(400).json({ error: 'A valid employee_id is required' });
    const { rows: own } = await pool.query(
      `SELECT 1 FROM employees WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2::int)`,
      [empId, cid(req)]
    );
    if (!own.length) return res.status(404).json({ error: 'Employee not found' });
    const { rows } = await pool.query(
      `INSERT INTO exit_requests (employee_id, reason, last_working_date, notice_period, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
      [empId, reason, last_working_date, notice_period]
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
router.put('/requests/:id', requireHRWrite, captureBefore('exit_requests'), async (req, res) => {
  try {
    const { status, remarks } = req.body;
    // Scoped through the employee (exit_requests has no company_id). Both the
    // read and the write were `WHERE id=$n` alone, so HR of one company could
    // change another company's exit request by id.
    const companyId = cid(req);
    if (status === 'closed') {
      const { rows: cur } = await pool.query(
        `SELECT er.fnf_status FROM exit_requests er JOIN employees e ON e.id = er.employee_id
          WHERE er.id = $1 AND ($2::int IS NULL OR e.company_id = $2::int)`, [req.params.id, companyId]);
      if (!cur.length) return res.status(404).json({ error: 'Not found' });
      if (cur[0].fnf_status !== 'paid') {
        return res.status(409).json({
          error: "Cannot close an exit request until F&F is paid — use POST /fnf/:id/pay, which enforces exit clearance first",
        });
      }
    }
    const { rows } = await pool.query(
      `UPDATE exit_requests er SET status=COALESCE($1,er.status), remarks=COALESCE($2,er.remarks), updated_at=NOW()
        WHERE er.id=$3
          AND EXISTS (SELECT 1 FROM employees e WHERE e.id = er.employee_id
                        AND ($4::int IS NULL OR e.company_id = $4::int))
        RETURNING er.*`,
      [status, remarks, req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /requests/:id/withdraw — resignation withdrawn, employee retained ────
// Cancelling the exit_request alone left three things behind: the employee
// stuck at 'Notice' (and later flipped to 'Left' by exitStatusSync), a fully
// ticked clearance row that a future exit would inherit, and — when "access
// revoked" had been ticked — a disabled login. This undoes all of it in one
// transaction. Once F&F is paid or the employee has already left, this is a
// rehire (employees/ex/:id/rehire), not a withdrawal.
router.post('/requests/:id/withdraw', requireHRWrite, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid exit request id' });
  const reason = String(req.body?.reason ?? '').trim() || 'Resignation withdrawn';
  const companyId = cid(req);   // NULL only for a super admin (company gate above)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Scope through employees — exit_requests carries no company_id.
    const { rows: [er] } = await client.query(
      `SELECT er.*, e.status AS employee_status, e.probation_end_date, e.confirmation_date,
              ec.access_revoked
         FROM exit_requests er
         JOIN employees e ON e.id = er.employee_id
         LEFT JOIN exit_clearance ec ON ec.employee_id = er.employee_id
        WHERE er.id = $1 AND ($2::int IS NULL OR e.company_id = $2)
        FOR UPDATE OF er`,
      [id, companyId]
    );
    if (!er) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

    const empStatus = String(er.employee_status ?? '').trim().toLowerCase();
    let conflict = null;
    if (['closed', 'cancelled', 'rejected'].includes(er.status)) conflict = `Exit request is already ${er.status}`;
    else if (er.fnf_status === 'paid') conflict = 'F&F is already paid — use Rehire instead';
    else if (EXITED_STATUSES.includes(empStatus)) conflict = 'Employee has already left — use Rehire instead';
    if (conflict) { await client.query('ROLLBACK'); return res.status(409).json({ error: conflict }); }

    const { rows: [cancelled] } = await client.query(
      `UPDATE exit_requests SET status='cancelled', remarks=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [reason, id]
    );

    // Reset rather than delete: the row is keyed by employee_id, so stale
    // ticks would otherwise pre-clear any future exit.
    await client.query(
      `UPDATE exit_clearance
          SET it_assets_returned=false, access_revoked=false, documents_collected=false,
              exit_interview_done=false, noc_it=false, noc_admin=false, noc_finance=false,
              noc_hr=false, noc_manager=false, finance_noc_by=NULL, manager_noc_by=NULL,
              hr_noc_by=NULL, updated_at=NOW()
        WHERE employee_id=$1
          AND employee_id IN (SELECT id FROM employees WHERE id=$1 AND ($2::int IS NULL OR company_id=$2::int))`,
      [er.employee_id, companyId]
    );

    // Notice → back to what they were. No prior status is stored, so infer it:
    // still inside an unconfirmed probation window → Probation, else Active.
    let restoredStatus = null;
    if (NOTICE_STATUSES.includes(empStatus)) {
      const inProbation = !er.confirmation_date && er.probation_end_date
        && new Date(er.probation_end_date) > new Date();
      restoredStatus = inProbation ? 'Probation' : 'Active';
      // The company predicate sits on the mutation itself, not only on the
      // locking read above, and exactly one row must change.
      const upd = await client.query(
        `UPDATE employees SET status=$1, exit_date=NULL, exit_reason=NULL, updated_at=NOW()
          WHERE id=$2 AND ($3::int IS NULL OR company_id=$3::int)`,
        [restoredStatus, er.employee_id, companyId]
      );
      if (upd.rowCount !== 1) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
    }

    // Only undo a revocation this exit made. A login disabled for any other
    // reason (no access_revoked tick) is left alone.
    let reactivated = [];
    if (er.access_revoked) {
      ({ rows: reactivated } = await client.query(
        `UPDATE users SET is_active=true, updated_at=NOW()
          WHERE employee_id=$1 AND is_active=false
            AND employee_id IN (SELECT id FROM employees WHERE id=$1 AND ($2::int IS NULL OR company_id=$2::int))
          RETURNING id`,
        [er.employee_id, companyId]
      ));
    }

    await client.query('COMMIT');
    logAudit({
      userId: req.user?.userId ?? req.user?.id, module: 'hr', recordId: id,
      recordType: 'exit_request', action: 'withdraw',
      oldData: { status: er.status, employee_status: er.employee_status, access_revoked: !!er.access_revoked },
      newData: { status: 'cancelled', reason, employee_status: restoredStatus ?? er.employee_status,
                 reactivated_user_ids: reactivated.map(u => u.id) },
      req,
    });
    res.json({
      exit_request: cancelled,
      employee_status: restoredStatus ?? er.employee_status,
      login_reactivated: reactivated.length > 0,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
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
      WHERE er.status NOT IN ('closed','paid','cancelled','rejected') ${cidClause}
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

    // Move employee into notice period — NOT straight to the terminal status
    // (resigned/terminated/left). Those are set by exitStatusSync.cron.js once
    // last_working_date actually arrives. 'notice' is already recognized as
    // "still working" by payroll (payroll.service.js ACTIVE_STATUSES) and
    // attendance (attendance.repository.js), so pay/attendance continue
    // uninterrupted through the notice period instead of being cut the moment
    // HR clicks "initiate". Immediate login revocation (for terminations that
    // need it) is a separate, already-independent action — see the Exit
    // Clearance Engine's access_revoked toggle further down this file.
    // Capitalized to match the live employees.status convention ('Active'/
    // 'Probation' written at creation — see employee.service.js addEmployee)
    // and the frontend's STATUS_STYLE.Notice badge, which is keyed on the
    // exact string 'Notice'.
    // NOTICE_STATUS, not a hardcoded literal: this exact string is the reason
    // someone serving notice still counts in headcount everywhere else, so it has
    // to come from the same vocabulary those readers use.
    // assertEmployeeScope above already proved ownership; the predicate is kept
    // anyway so the statement is safe read in isolation.
    await client.query(
      `UPDATE employees SET status=$1, updated_at=NOW()
        WHERE id=$2 AND ($3::int IS NULL OR company_id=$3)`,
      [NOTICE_STATUS, employee_id, cid(req)]
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
//
// Tenant scope (2026-10-20). Every statement here keyed on the body's
// employee_id alone, so HR of one company could file an exit interview against
// another company's employee, mark that company's exit request interview_done
// and tick its clearance row. The employee (and an interviewer, if named) must
// now be in the caller's company, every write repeats that predicate, and the
// three writes are one transaction so a refusal changes nothing.
router.post('/interview', requireHRWrite, async (req, res) => {
  const {
    employee_id, interviewer_id, reason_category, reason_detail, would_rejoin,
    rating_management, rating_culture, rating_work, rating_growth, overall_rating,
  } = req.body;
  const empId = intId(employee_id);
  if (empId == null) return res.status(400).json({ error: 'A valid employee_id is required' });
  const interviewerId = interviewer_id == null || interviewer_id === '' ? null : intId(interviewer_id);
  if (interviewer_id != null && interviewer_id !== '' && interviewerId == null) {
    return res.status(400).json({ error: 'interviewer_id must be an employee id' });
  }
  const companyId = cid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!await employeeInCompany(client, empId, companyId)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }
    if (interviewerId != null && !await employeeInCompany(client, interviewerId, companyId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The interviewer is not an employee of your company' });
    }
    const { rows: [er] } = await client.query(
      `SELECT er.id FROM exit_requests er JOIN employees e ON e.id = er.employee_id
        WHERE er.employee_id = $1 AND ($2::int IS NULL OR e.company_id = $2::int)
        ORDER BY er.created_at DESC LIMIT 1`,
      [empId, companyId]
    );
    const { rows } = await client.query(
      `INSERT INTO exit_interviews
         (exit_request_id, employee_id, interviewer_id, reason_category, reason_detail,
          would_rejoin, rating_management, rating_culture, rating_work, rating_growth, overall_rating)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [er?.id ?? null, empId, interviewerId, reason_category, reason_detail,
       would_rejoin, rating_management, rating_culture, rating_work, rating_growth, overall_rating]
    );
    if (er?.id) {
      await client.query(
        `UPDATE exit_requests er SET interview_done=TRUE
          WHERE er.id=$1 AND EXISTS (SELECT 1 FROM employees e WHERE e.id = er.employee_id
                                       AND ($2::int IS NULL OR e.company_id = $2::int))`,
        [er.id, companyId]
      );
    }
    // Also update clearance record — inserted only for the verified employee.
    await client.query(
      `INSERT INTO exit_clearance (employee_id, exit_interview_done)
       SELECT e.id, TRUE FROM employees e
        WHERE e.id = $1 AND ($2::int IS NULL OR e.company_id = $2::int)
       ON CONFLICT (employee_id) DO UPDATE SET exit_interview_done=TRUE, updated_at=NOW()`,
      [empId, companyId]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /fnf/compute/:employee_id ────────────────────────────────────────────
// Computation itself lives in fnf.service.js so the auto-trigger cron
// (fnfAutoTrigger.cron.js, Automation Opportunity Audit §9.3) can call the
// same logic once last_working_date is reached, instead of this needing to
// be invoked by hand.
//
// Tenant scope (2026-10-20): computeFnf read the employee (salary included) and
// wrote fnf_status/net_payable onto their exit request by id alone — another
// company's HR could read the computation and rewrite the draft. The caller's
// company now scopes both, inside computeFnf. An unknown, other-company or
// exit-less employee is the same 404.
router.post('/fnf/compute/:employee_id', requireHRWrite, async (req, res) => {
  const empId = intId(req.params.employee_id);
  if (empId == null) return res.status(400).json({ error: 'Invalid employee id' });
  try {
    const result = await computeFnf(pool, empId, { companyId: cid(req) });
    if (!result) return res.status(404).json({ error: 'Employee or exit request not found' });
    // Containment C1: the calculation is known to be wrong (F-01..F-03), so its
    // output is labelled provisional and the screen offers no approve / pay.
    if (fnfSettlementSuspended()) {
      return res.json({ ...result, provisional: true, settlement_actions_suspended: true, containment_notice: FNF_SUSPENDED_MESSAGE });
    }
    res.json(result);
  } catch (e) {
    if (e?.statusCode === 409) return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /fnf/:id/approve ──────────────────────────────────────────────────────
//
// Tenant scope (2026-10-20): both the before-image read and the UPDATE were by
// exit-request id alone, so another company's F&F could be approved. Both are
// now scoped through the employee (exit_requests has no company_id); unknown and
// other-company ids are the same 404. A PAID settlement is never moved back to
// 'approved' — the UPDATE itself refuses it, so a repeated or late approve
// cannot undo a payment (409).
router.put('/fnf/:id/approve', requireHRWrite, async (req, res) => {
  // Containment C3: no settlement is approved on the current engine's figures.
  if (fnfSettlementSuspended()) return res.status(423).json(fnfSuspendedBody());
  const exitId = intId(req.params.id);
  if (exitId == null) return res.status(400).json({ error: 'Invalid exit request id' });
  const companyId = cid(req);
  try {
    const { rows: [oldRecord] } = await pool.query(
      `SELECT er.* FROM exit_requests er JOIN employees e ON e.id = er.employee_id
        WHERE er.id = $1 AND ($2::int IS NULL OR e.company_id = $2::int)`, [exitId, companyId]
    );
    if (!oldRecord) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      `UPDATE exit_requests er SET fnf_status='approved', updated_at=NOW()
        WHERE er.id = $1
          AND er.fnf_status IS DISTINCT FROM 'paid'
          AND EXISTS (SELECT 1 FROM employees e WHERE e.id = er.employee_id
                        AND ($2::int IS NULL OR e.company_id = $2::int))
        RETURNING er.*`,
      [exitId, companyId]
    );
    if (!rows.length) {
      return oldRecord.fnf_status === 'paid'
        ? res.status(409).json({ error: 'F&F is already paid' })
        : res.status(404).json({ error: 'Not found' });
    }
    const updatedRecord = rows[0];
    logAudit({ userId: req.user?.userId, module: 'HR', recordId: exitId, recordType: 'fnf_settlement', action: 'approve', oldData: oldRecord, newData: updatedRecord, req });
    // Look up the employee's userId for workflow notification. employees has
    // no user_id column (this always 500'd silently into the .catch below,
    // so the F&F-approval notification never fired) — resolve via the
    // reverse FK instead, same fix as promotions.routes.js/increments.routes.js.
    pool.query(`SELECT id AS user_id FROM users WHERE employee_id=$1`, [updatedRecord.employee_id])
      .then(({ rows: empRows }) => {
        notifyWorkflowEvent('approved', { module: 'HR', recordId: exitId, submitterUserId: empRows[0]?.user_id ?? null });
      }).catch(() => {});
    res.json(updatedRecord);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /fnf/:id/pay — marks F&F paid and bridges employee to 'left' ─────────
router.post('/fnf/:id/pay', requireHRWrite, async (req, res) => {
  // Containment C3: HR may not mark a settlement paid (no journal, no payment
  // record, no Finance step — F-05). Checked before a connection is taken.
  if (fnfSettlementSuspended()) return res.status(423).json(fnfSuspendedBody());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ⚠ TENANT SCOPE. This read was `WHERE id=$1` alone, and the UPDATE below was
    // `WHERE id=$2` alone — so an HR user in company A could mark ANY company's
    // exit request as F&F-paid and, through the bridge below, flip that
    // employee's status to exited. A cross-tenant termination, logged as routine.
    // `exit_requests` carries no company_id, so the scope has to come through the
    // employees join, the same way GET /exit/list above derives it.
    const { rows: erRows } = await client.query(
      `SELECT er.employee_id
         FROM exit_requests er
         JOIN employees e ON e.id = er.employee_id
        WHERE er.id = $1 AND ($2::int IS NULL OR e.company_id = $2)`,
      [req.params.id, cid(req)]
    );
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
    // Bridge: move the employee to the canonical exit status and populate
    // exit_date so the Ex-Employees list shows them. EXIT_STATUS rather than the
    // lowercase 'left' this hardcoded — see shared/employeeStatus.js.
    // Scoped as well as id-matched: the SELECT above already proved ownership,
    // but a bare `WHERE id=` in an exit path is exactly the shape of the bug
    // that was here.
    await client.query(
      `UPDATE employees
          SET status = $1,
              exit_date = COALESCE(exit_date, $2),
              updated_at = NOW()
        WHERE id = $3 AND ($4::int IS NULL OR company_id = $4)`,
      [EXIT_STATUS, er.last_working_date || null, er.employee_id, cid(req)]
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
router.put('/clearance/:employee_id', requireHRWrite, captureBefore('exit_clearance', { param: 'employee_id', column: 'employee_id' }), async (req, res) => {
  try {
    const {
      it_assets_returned, access_revoked, documents_collected, exit_interview_done,
      noc_it, noc_admin, noc_finance, noc_hr, noc_manager,
    } = req.body;
    // Who's granting the NOC — only stamped when the flag is actually being
    // set true this call, so an existing sign-off isn't overwritten by a
    // later PUT that leaves the flag unchanged (COALESCE keeps prior value).
    // Tenant scope (2026-10-20). The upsert and — worse — the login
    // deactivation below were keyed on :employee_id alone, so ticking "access
    // revoked" could disable another company's employee's login. The employee
    // must be in the caller's company, and both writes repeat that predicate.
    const empId = intId(req.params.employee_id);
    if (empId == null) return res.status(400).json({ error: 'Invalid employee id' });
    const companyId = cid(req);
    if (!await employeeInCompany(pool, empId, companyId)) return res.status(404).json({ error: 'Employee not found' });
    const actorEmployeeId = req.user?.employee_id ?? null;
    const financeNocBy = noc_finance ? actorEmployeeId : null;
    const managerNocBy = noc_manager ? actorEmployeeId : null;
    const hrNocBy      = noc_hr ? actorEmployeeId : null;
    const { rows } = await pool.query(
      `INSERT INTO exit_clearance
         (employee_id, it_assets_returned, access_revoked, documents_collected, exit_interview_done,
          noc_it, noc_admin, noc_finance, noc_hr, noc_manager,
          finance_noc_by, manager_noc_by, hr_noc_by, updated_at)
       SELECT e.id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()
         FROM employees e WHERE e.id = $1 AND ($14::int IS NULL OR e.company_id = $14::int)
       ON CONFLICT (employee_id) DO UPDATE SET
         it_assets_returned=$2, access_revoked=$3, documents_collected=$4, exit_interview_done=$5,
         noc_it=$6, noc_admin=$7, noc_finance=$8, noc_hr=$9, noc_manager=$10,
         finance_noc_by = CASE WHEN $8  THEN COALESCE(exit_clearance.finance_noc_by, $11) ELSE NULL END,
         manager_noc_by = CASE WHEN $10 THEN COALESCE(exit_clearance.manager_noc_by, $12) ELSE NULL END,
         hr_noc_by      = CASE WHEN $9  THEN COALESCE(exit_clearance.hr_noc_by, $13) ELSE NULL END,
         updated_at=NOW()
       RETURNING *`,
      [empId, it_assets_returned, access_revoked, documents_collected,
       exit_interview_done, noc_it, noc_admin, noc_finance, noc_hr, noc_manager,
       financeNocBy, managerNocBy, hrNocBy, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });

    // Actually revoke the login, not just the checklist checkbox. Previously
    // ticking "access revoked" only wrote this flag — nothing ever set
    // users.is_active, so a resigned/terminated employee's account stayed live.
    if (access_revoked) {
      const { rows: deactivated } = await pool.query(
        `UPDATE users SET is_active = false, updated_at = NOW()
         WHERE employee_id = $1 AND is_active = true
           AND employee_id IN (SELECT id FROM employees WHERE id = $1 AND ($2::int IS NULL OR company_id = $2::int))
         RETURNING id, email`,
        [empId, companyId]
      );
      if (deactivated.length) {
        logAudit({
          userId: req.user?.userId ?? req.user?.id, module: 'hr', recordId: empId,
          recordType: 'exit_clearance', action: 'access_revoked',
          newData: { deactivated_user_ids: deactivated.map(u => u.id) }, req,
        });
      }
    }

    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
