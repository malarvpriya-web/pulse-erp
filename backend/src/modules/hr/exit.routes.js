import express from 'express';
import pool from '../shared/db.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import { computeFnf, settlementHistory, approveSettlement, paySettlement, SettlementError } from './fnf.service.js';
import { settlementRuleList } from './settlementRules.js';
import { loadRuleRows } from '../payroll/statutoryRules.js';
import { requirePermission, can } from '../../middlewares/auth.middleware.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { EXIT_STATUS, NOTICE_STATUS, NOTICE_STATUSES, EXITED_STATUSES } from '../../shared/employeeStatus.js';
import { readScope } from '../../shared/employeeAccess.js';
import { fnfSettlementSuspended, fnfSuspendedBody, FNF_SUSPENDED_MESSAGE } from '../../shared/hrContainment.js';
import { cleanExitFields, startExitChecks, freshClearance, sendExitError, notifyExitStarted, defaultNoticeDays, ExitInputError, CLOSED_EXIT_STATUSES } from './exitCase.js';
import { fnfDueDates, daysLate } from './fnfDue.js';
import { localTodayIso } from '../../shared/workforcePolicy.js';
import { buildProbationLetterPdf as buildLetterPdf } from '../../utils/probationLetterPdf.js';
import { buildFnfStatementPdf } from '../../utils/fnfStatementPdf.js';
import { exitLetterContent, ExitLetterError } from './exitLetters.js';
import { openChecklistItems } from './exitChecklist.js';
import { vocabularyValues } from '../../shared/masterVocabulary.js';

// Exit-interview reasons: the EXIT_REASON master (Settings → Master Data,
// migration 20261117000001). Old keys are read as their names.
const EXIT_REASON_SEED = ['Better Opportunity', 'Compensation', 'Work Environment', 'Personal', 'Relocation', 'Other'];
const LEGACY_REASON = {
  better_opportunity: 'Better Opportunity', compensation: 'Compensation', work_environment: 'Work Environment',
  personal: 'Personal', relocation: 'Relocation', other: 'Other',
};
const RATING_FIELDS = ['rating_management', 'rating_culture', 'rating_work', 'rating_growth', 'overall_rating'];
/** A rating is a whole number 1–5; null when absent; NaN when invalid. */
function ratingOf(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : NaN;
}

const router = express.Router();

// All routes are mounted under verifyToken in server.js:
//   v1Router.use("/exit", verifyToken, exitRoutes)
// req.scope.company_id is available on every request.

// ── Role gate ──────────────────────────────────────────────────────────────
// Exit management (offboarding, exit interviews, F&F settlement, clearance) is
// confidential HR + financial data with no employee self-service surface, and
// exit-interview feedback is often about line managers — so this module is
// HR-only. Managers / department heads are deliberately excluded (no read).
//
// Access is the permission matrix (HR audit 2026-11-16, B4; migration
// 20261116000005), so Roles Setup changes it and every role a user holds
// counts. It used to be two role lists read from the single req.user.role.
//   exit:view   every route here          exit:edit   every write
//   fnf:view    the settlement steps only (rules, a settlement, approve, pay):
//               how Finance reaches F&F without the rest of this module.
//               Approve and pay still need payroll:approve / payroll_payment:approve.
const FNF_PATH = /^\/fnf\/(rules|settlements\/[^/]+|review\/[^/]+(\/statement)?|[^/]+\/(approve|pay))$/;

async function requireHRRead(req, res, next) {
  if (await can(req, 'exit', 'view')) return next();
  if (FNF_PATH.test(req.path) && await can(req, 'fnf', 'view')) return next();
  return res.status(403).json({ error: 'Exit data is confidential — HR access required' });
}
async function requireHRWrite(req, res, next) {
  if (await can(req, 'exit', 'edit')) return next();
  return res.status(403).json({ error: 'HR admin access required for this operation' });
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

// ── Clearance blockers — Exit Clearance Engine ────────────────────────────────
// Final settlement (fnf/:id/pay) is gated on all seven of these clearing (the company checklist items added 2026-11-17). The
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
       WHERE employee_id=$1 AND status NOT IN ('returned', 'disposed', 'damaged')`,
      [employeeId]
    ),
    pool.query(
      // travel_advances.employee_id actually stores users.id, not employees.id
      // (see travel.routes.js's GET /advances comment) — resolve through users
      // first, same pattern that route already uses for employee self-scoping,
      // plus a direct employees.id fallback for any legacy row.
      `SELECT COALESCE(SUM(amount - COALESCE(settled_amount,0)), 0) AS outstanding
       FROM travel_advances
       -- Only money actually handed over is owed back; an advance still being
       -- approved is withdrawn, not recovered.
       WHERE status IN ('Disbursed','Partially Settled')
         AND (
           employee_id IN (SELECT id FROM users WHERE employee_id = $1)
           OR travel_request_id IN (SELECT id FROM travel_requests WHERE employee_id = $1)
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
  const openItems = await openChecklistItems(pool, employeeId);

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
    // The company's own exit-checklist items (one checklist, owner decision
    // 2026-11-17): every item must be ticked before the F&F is paid.
    {
      key: 'checklist', label: 'Exit checklist items open',
      cleared: openItems.length === 0,
      detail: openItems.map(i => `${i.item_label} (${i.assignee})`),
    },
  ];

  return { employee_id: employeeId, blockers, can_settle: blockers.every(b => b.cleared) };
}

// ── GET /requests ─────────────────────────────────────────────────────────────
router.get('/requests', async (req, res) => {
  try {
    // A deleted employee's exit is not shown (§274): it listed test rows whose
    // employee had been removed as if they were people still leaving.
    const { rows } = await pool.query(
      `SELECT er.* FROM exit_requests er
         JOIN employees e ON e.id = er.employee_id AND e.deleted_at IS NULL
        WHERE ($1::int IS NULL OR e.company_id = $1::int)
        ORDER BY er.created_at DESC`, [cid(req)]);
    res.json(rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /requests ────────────────────────────────────────────────────────────
// exit_requests has no company_id: the request belongs to whichever company the
// employee does — startExitChecks() proves that, and refuses a deleted or
// departed employee and a second open exit (§274).
router.post('/requests', requireHRWrite, async (req, res) => {
  const empId = intId(req.body?.employee_id);
  if (!empId) return res.status(400).json({ error: 'A valid employee_id is required' });
  const client = await pool.connect();
  try {
    const f = cleanExitFields(req.body);
    await client.query('BEGIN');
    await startExitChecks(client, empId, cid(req));
    const { rows } = await client.query(
      `INSERT INTO exit_requests (employee_id, separation_type, reason, last_working_date, resignation_date, notice_period, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [empId, f.separation_type, f.reason ?? null, f.last_working_date, f.resignation_date ?? null, f.notice_period ?? null]
    );
    await freshClearance(client, empId);
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    sendExitError(res, e);
  } finally { client.release(); }
});

// ── PUT /requests/:id ─────────────────────────────────────────────────────────
// Workflow Dependency Engine (Priority 7) — this generic status-update
// endpoint could previously mark an exit request 'closed' directly, which
// GET /active treats as "done" (WHERE status NOT IN ('closed','paid')) —
// completely bypassing computeClearanceBlockers and the F&F pay gate that
// 'closed' is supposed to mean. Only POST /fnf/:id/pay may set 'closed' now;
// other statuses (pending/active/rejected/cancelled) are untouched.
//
// §274: the exit's own details — exit type, last working day, resignation
// date, notice days, reason — are editable while the exit is open and its F&F
// is not yet approved. Before, only status and remarks could change, so a wrong
// last working day could only be fixed by withdrawing (which restores the
// employee and resets clearance) and starting again. 'cancelled' is refused
// here: withdraw is the path that also restores the employee's status and login.
const EDITABLE_EXIT_FIELDS = ['separation_type', 'last_working_date', 'resignation_date', 'notice_period', 'reason'];
router.put('/requests/:id', requireHRWrite, captureBefore('exit_requests'), async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid exit request id' });
  const body = req.body ?? {};
  const { status, remarks } = body;
  // Scoped through the employee (exit_requests has no company_id). Both the
  // read and the write were `WHERE id=$n` alone, so HR of one company could
  // change another company's exit request by id.
  const companyId = cid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [cur] } = await client.query(
      `SELECT er.id, er.status, er.fnf_status, er.separation_type, er.notice_period, er.reason,
              to_char(er.last_working_date, 'YYYY-MM-DD') AS last_working_date,
              to_char(er.resignation_date, 'YYYY-MM-DD') AS resignation_date
         FROM exit_requests er JOIN employees e ON e.id = er.employee_id AND e.deleted_at IS NULL
        WHERE er.id = $1 AND ($2::int IS NULL OR e.company_id = $2::int)
        FOR UPDATE OF er`, [id, companyId]);
    if (!cur) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

    if (status === 'closed' && cur.fnf_status !== 'paid') {
      throw new ExitInputError(409, 'FNF_NOT_PAID',
        'Cannot close an exit request until F&F is paid — use POST /fnf/:id/pay, which enforces exit clearance first');
    }
    if (status === 'cancelled') {
      throw new ExitInputError(409, 'USE_WITHDRAW', 'Use Withdraw to cancel an exit: it also restores the employee and their login.');
    }

    const editing = EDITABLE_EXIT_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(body, k));
    let f = {};
    if (editing) {
      if (CLOSED_EXIT_STATUSES.includes(cur.status)) {
        throw new ExitInputError(409, 'EXIT_CLOSED', `This exit is ${cur.status}; its details can no longer be changed.`);
      }
      if (['approved', 'paid'].includes(String(cur.fnf_status ?? '').toLowerCase())) {
        throw new ExitInputError(409, 'FNF_APPROVED',
          `The F&F settlement is already ${cur.fnf_status}. Its figures depend on these details, so they can no longer be changed.`);
      }
      f = cleanExitFields(body, { partial: true, current: cur });
    }

    const sets = [];
    const vals = [];
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    for (const k of EDITABLE_EXIT_FIELDS) if (k in f) put(k, f[k]);
    if (status != null) put('status', status);
    if (remarks != null) put('remarks', remarks);
    if (!sets.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nothing to change' }); }
    vals.push(id);
    const { rows: [row] } = await client.query(
      `UPDATE exit_requests SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`, vals);
    const { rows: [{ n: settlements }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM fnf_settlements WHERE exit_request_id = $1`, [id]);
    await client.query('COMMIT');

    const changed = Object.keys(f).filter((k) => String(f[k] ?? '') !== String(cur[k] ?? ''));
    if (changed.length) {
      logAudit({
        userId: req.user?.userId ?? req.user?.id, module: 'hr', recordId: id, recordType: 'exit_request', action: 'edit_details',
        oldData: Object.fromEntries(changed.map((k) => [k, cur[k]])), newData: Object.fromEntries(changed.map((k) => [k, f[k]])), req,
      });
    }
    // A settlement already worked out from the old details must be recalculated.
    res.json({ ...row, fnf_recompute_needed: changed.length > 0 && settlements > 0 });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    sendExitError(res, e);
  } finally { client.release(); }
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
        to_char(er.last_working_date, 'YYYY-MM-DD') AS last_working_date,
        to_char(er.resignation_date, 'YYYY-MM-DD')  AS resignation_date,
        er.notice_period,
        e.notice_period_days                         AS employee_notice_period_days,
        er.reason,
        e.status                                     AS employee_status,
        e.company_id                                 AS employee_company_id,
        e.zone_id                                    AS employee_zone_id,
        er.status,
        er.fnf_status,
        er.net_payable,
        er.interview_done,
        -- Signed (was GREATEST(0, …)): 0 is the last day itself, which the
        -- screen used to call "Overdue"; below 0 the last day has passed.
        (er.last_working_date::date - CURRENT_DATE) AS days_remaining
      FROM exit_requests er
      -- Inner join, live employees only (§274): a LEFT JOIN listed exits of
      -- deleted test employees as people still leaving.
      JOIN employees e ON e.id = er.employee_id AND e.deleted_at IS NULL
      WHERE er.status NOT IN ('closed','paid','cancelled','rejected') ${cidClause}
      ORDER BY er.last_working_date ASC NULLS LAST
    `, params);
    // §276: when the F&F is due (wages: N working days after the last day; gratuity: 30 days).
    const today = localTodayIso();
    for (const r of rows) {
      if (!r.last_working_date) continue;
      try {
        const d = await fnfDueDates(pool, { companyId: r.employee_company_id, lwd: r.last_working_date, zoneId: r.employee_zone_id });
        r.fnf_due_date = d.wages_due;
        r.gratuity_due_date = d.gratuity_due;
        r.fnf_days_late = r.fnf_status === 'paid' ? 0 : daysLate(d.wages_due, today);
      } catch { /* a due date is a hint; the list still loads without it */ }
      delete r.employee_company_id; delete r.employee_zone_id;
    }
    res.json(rows);
  } catch (e) {
    if (e.message.match(/relation .* does not exist/)) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /initiate ────────────────────────────────────────────────────────────
router.post('/initiate', requireHRWrite, async (req, res) => {
  const employee_id = intId(req.body?.employee_id);
  if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
  const client = await pool.connect();
  try {
    // §274: one shared rule set (exitCase.js) — valid type and dates, employee
    // live and still employed, no second open exit. Notice days default to
    // the employee's contractual notice when HR leaves the field empty.
    const f = cleanExitFields(req.body);
    await client.query('BEGIN');
    const emp = await startExitChecks(client, employee_id, cid(req));
    const noticeDays = f.notice_period ?? await defaultNoticeDays(client, emp);

    const { rows } = await client.query(
      `INSERT INTO exit_requests
         (employee_id, separation_type, last_working_date, resignation_date, notice_period, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING *`,
      [employee_id, f.separation_type, f.last_working_date, f.resignation_date ?? null, noticeDays, f.reason ?? null]
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
    // startExitChecks above already proved ownership; the predicate is kept
    // anyway so the statement is safe read in isolation.
    await client.query(
      `UPDATE employees SET status=$1, updated_at=NOW()
        WHERE id=$2 AND ($3::int IS NULL OR company_id=$3)`,
      [NOTICE_STATUS, employee_id, cid(req)]
    );
    const prevClearance = await freshClearance(client, employee_id);

    await client.query('COMMIT');
    logAudit({
      userId: req.user?.userId ?? req.user?.id, module: 'hr', recordId: rows[0].id, recordType: 'exit_request', action: 'initiate',
      oldData: { employee_status: emp.status, ...(prevClearance ? { previous_clearance: prevClearance } : {}) },
      newData: { employee_status: NOTICE_STATUS, separation_type: f.separation_type, last_working_date: f.last_working_date,
                 resignation_date: f.resignation_date ?? null, notice_period: noticeDays },
      req,
    });
    const notified = await notifyExitStarted({ employee: emp, exitRequest: rows[0], actorUserId: req.user?.userId ?? req.user?.id });
    res.status(201).json({ ...rows[0], notified });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    sendExitError(res, e);
  } finally {
    client.release();
  }
});

// ── GET /employee/:employee_id/letter/:kind — relieving / experience letter PDF (§276) ──
// HR read roles (the module's blanket gate). Available once the employee has left.
router.get('/employee/:employee_id/letter/:kind', async (req, res) => {
  const empId = intId(req.params.employee_id);
  if (!empId) return res.status(400).json({ error: 'Invalid employee id' });
  try {
    const actor = req.user?.userId ?? req.user?.id ?? null;
    const content = await exitLetterContent(pool, { companyId: cid(req), employeeId: empId, kind: req.params.kind, signatoryUserId: actor, todayIso: localTodayIso() });
    const pdf = await buildLetterPdf(content);
    logAudit({ userId: actor, module: 'hr', recordId: empId, recordType: 'exit_letter', action: `issue_${content.kind}_letter`,
      newData: { reference: content.reference, kind: content.kind }, req });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${content.filename}"`);
    res.send(pdf);
  } catch (e) {
    if (e instanceof ExitLetterError) return res.status(e.status).json({ error: e.message, code: e.code });
    res.status(500).json({ error: e.message });
  }
});

// ── GET /employee/:employee_id — exit request + clearance for one employee ────
router.get('/employee/:employee_id', async (req, res) => {
  const empId = Number(req.params.employee_id);
  if (!Number.isInteger(empId) || empId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  const companyId = cid(req);
  try {
    // The clearance read below keyed on the id alone (HR audit 2026-11-16).
    if (!await employeeInCompany(pool, empId, companyId)) return res.status(404).json({ error: 'Employee not found' });
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
// An exit interview counts only when it belongs to a real exit: the exit it
// names is this employee's own, not cancelled or rejected, and the employee is
// not deleted (HR audit 2026-11-16, B3). Seed rows pointed at other people's
// exits or at no exit, and the analytics averaged them in. $1 = company (NULL =
// global caller).
const REAL_INTERVIEW_JOIN = `
      JOIN exit_requests er ON er.id = ei.exit_request_id
                           AND er.employee_id = ei.employee_id
                           AND er.status NOT IN ('cancelled', 'rejected')
      JOIN employees e ON e.id = ei.employee_id
                      AND e.deleted_at IS NULL
                      AND ($1::int IS NULL OR e.company_id = $1::int)`;

router.get('/interviews', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(`
      SELECT
        ei.*,
        COALESCE(e.name, e.first_name || ' ' || e.last_name) AS employee_name,
        e.department
      FROM exit_interviews ei
      ${REAL_INTERVIEW_JOIN}
      ORDER BY ei.created_at DESC
    `, [companyId]);
    res.json(rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /interviews/analytics ─────────────────────────────────────────────────
router.get('/interviews/analytics', async (req, res) => {
  try {
    const params = [cid(req)];
    const cidJoin = REAL_INTERVIEW_JOIN;
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
          AND er.status NOT IN ('cancelled', 'rejected')
        ORDER BY er.created_at DESC LIMIT 1`,
      [empId, companyId]
    );
    // B3: an interview with no exit behind it is not an exit interview, and
    // the analytics would never count it. A withdrawn exit is no exit either.
    if (!er) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'NO_EXIT',
        error: 'This employee has no exit in progress. Start the exit in Exit Management first.',
      });
    }
    // One interview per exit (exit review 2026-11-17): a second submission was
    // stored too, and the reason and rating charts counted the leaver twice.
    const { rows: [already] } = await client.query(
      `SELECT id FROM exit_interviews WHERE exit_request_id = $1 LIMIT 1`, [er.id]);
    if (already) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'INTERVIEW_EXISTS', error: 'The exit interview for this exit is already recorded.' });
    }
    // Ratings were pre-filled on the form (4/4/4/3/4), so an untouched form
    // stored scores nobody gave. The overall rating is now required; any other
    // rating sent must be 1–5.
    const ratings = Object.fromEntries(RATING_FIELDS.map(k => [k, ratingOf(req.body?.[k])]));
    if (RATING_FIELDS.some(k => Number.isNaN(ratings[k])) || ratings.overall_rating == null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ code: 'BAD_RATING', error: 'Give the overall rating, and every rating as a whole number from 1 to 5.' });
    }
    const reasons = await vocabularyValues('EXIT_REASON', companyId, EXIT_REASON_SEED);
    const typed = String(reason_category ?? '').trim();
    const reason = reasons.find(r => r.toLowerCase() === (LEGACY_REASON[typed] ?? typed).toLowerCase()) ?? null;
    if (!reason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ code: 'BAD_REASON', error: `Choose an exit reason from the list (${reasons.join(', ')}).` });
    }
    const { rows } = await client.query(
      `INSERT INTO exit_interviews
         (exit_request_id, employee_id, interviewer_id, reason_category, reason_detail,
          would_rejoin, rating_management, rating_culture, rating_work, rating_growth, overall_rating)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [er.id, empId, interviewerId, reason, reason_detail,
       would_rejoin, ratings.rating_management, ratings.rating_culture, ratings.rating_work, ratings.rating_growth, ratings.overall_rating]
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

/**
 * HR decided a leaver's sales incentive in the settlement: tell the company's Finance
 * users (holders of finance:edit by role), who pay the settlement. Never undoes the save.
 */
async function notifyFinanceOfIncentiveDecision(req, employeeId, d) {
  try {
    const { rows: [emp] } = await pool.query(
      `SELECT id, company_id, office_id, first_name, last_name FROM employees WHERE id = $1`, [employeeId]);
    if (!emp) return;
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'finance' AND rp.can_edit = true
        WHERE u.is_active = true AND u.company_id = $1 AND u.id <> $2`,
      [emp.company_id, req.user?.userId ?? req.user?.id ?? -1]);
    if (!rows.length) return;
    const name = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
    notifyWorkflowEvent('fnf_sales_incentive_decided', {
      module: 'Exit', recordId: emp.id, recipientUserIds: rows.map(r => r.id),
      context: {
        employeeLabel: [name, emp.office_id && `(${emp.office_id})`].filter(Boolean).join(' '),
        decision: d.decision, amount: d.amount, reason: d.reason, suggested: d.suggested?.amount ?? null, fy: d.suggested?.fy_label ?? null,
      },
    });
  } catch { /* a notification must never undo a saved settlement */ }
}

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
    const { lop_days, notice_start, waive_notice_days, waive_reason, forfeit_gratuity_reason, bonus_disqualified_reason, asset_recovery_amount, asset_recovery_reason,
      sales_incentive_decision, sales_incentive_amount, sales_incentive_reason } = req.body || {};
    const result = await computeFnf(pool, empId, {
      companyId: cid(req), actorId: req.user?.userId ?? null,
      options: { lop_days, notice_start, waive_notice_days, waive_reason, forfeit_gratuity_reason, bonus_disqualified_reason, asset_recovery_amount, asset_recovery_reason,
        sales_incentive_decision, sales_incentive_amount, sales_incentive_reason },
    });
    if (!result) return res.status(404).json({ error: 'Employee or exit request not found' });
    if (result.sales_incentive_decision_changed) {
      const d = result.sales_incentive_decision_changed;
      logAudit({ userId: req.user?.userId ?? null, module: 'hr', recordId: result.id, recordType: 'fnf_sales_incentive', action: 'decide', newData: { employee_id: empId, decision: d.decision, amount: d.amount, reason: d.reason, version: d.version }, req });
      notifyFinanceOfIncentiveDecision(req, empId, d);
    }
    // Containment: the rules are not yet confirmed and Finance's payment steps are not
    // built, so the output is labelled provisional and the screen offers no approve / pay.
    if (fnfSettlementSuspended()) {
      return res.json({ ...result, provisional: true, settlement_actions_suspended: true, containment_notice: FNF_SUSPENDED_MESSAGE });
    }
    res.json(result);
  } catch (e) {
    if (e?.statusCode === 409 || e?.statusCode === 422) return res.status(e.statusCode).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── GET /fnf/rules — what each settlement rule is, and whether it is confirmed ──
router.get('/fnf/rules', async (req, res) => {
  try {
    const onDate = new Date().toISOString().slice(0, 10);
    // can_edit: saving goes through POST /payroll/statutory-rules, which needs
    // payroll_statutory_config:edit; without it the tab is shown read-only.
    res.json({
      data: settlementRuleList(onDate, await loadRuleRows(pool, cid(req))),
      can_edit: await can(req, 'payroll_statutory_config', 'edit'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /fnf/settlements/:employee_id — every version computed ────────────────
router.get('/fnf/settlements/:employee_id', async (req, res) => {
  const empId = intId(req.params.employee_id);
  if (empId == null) return res.status(400).json({ error: 'Invalid employee id' });
  try {
    res.json({ data: await settlementHistory(pool, empId, cid(req)) });
  } catch (e) {
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
const contained = (req, res, next) => (fnfSettlementSuspended() ? res.status(423).json(fnfSuspendedBody()) : next());
const settlementFailure = (res, e) => (e instanceof SettlementError
  ? res.status(e.statusCode).json({ code: e.code, error: e.message, ...e.extra })
  : res.status(500).json({ error: e.message }));

// ── GET /fnf/review/:exit_id — the LATEST saved settlement, read-only ─────────
// HR audit 2026-11-16: every way of seeing a settlement on screen recomputed
// it (POST /fnf/compute), which wrote a new version with the VIEWER as
// computed_by — so whoever opened it to approve it was then refused
// (SELF_APPROVAL), and Finance (fnf:view, no exit:view) could not open Exit
// Management at all. No settlement could be approved from the UI. This reads
// what was computed, with its approval and payment state and what the caller
// may do with it. Reached with fnf:view (FNF_PATH) as well as exit:view.
router.get('/fnf/review/:exit_id', async (req, res) => {
  const exitId = intId(req.params.exit_id);
  if (exitId == null) return res.status(400).json({ error: 'Invalid exit request id' });
  try {
    const { rows: [er] } = await pool.query(
      `SELECT er.id, er.employee_id, er.status, er.fnf_status, er.separation_type, er.last_working_date,
              e.office_id, e.first_name, e.last_name, e.department, e.designation, e.company_id
         FROM exit_requests er JOIN employees e ON e.id = er.employee_id
        WHERE er.id = $1 AND e.deleted_at IS NULL AND ($2::int IS NULL OR e.company_id = $2::int)`,
      [exitId, cid(req)]);
    if (!er) return res.status(404).json({ error: 'Not found' });
    const { rows: [s] } = await pool.query(
      `SELECT s.*, cu.name AS computed_by_name
         FROM fnf_settlements s LEFT JOIN users cu ON cu.id = s.computed_by
        WHERE s.exit_request_id = $1 ORDER BY s.version DESC LIMIT 1`, [exitId]);
    if (!s) return res.json({ exit: er, settlement: null });
    const { rows: events } = await pool.query(
      `SELECT ev.action, ev.actor_id, ev.amount, ev.utr, ev.value_date, ev.created_at, u.name AS actor_name
         FROM fnf_settlement_events ev LEFT JOIN users u ON u.id = ev.actor_id
        WHERE ev.settlement_id = $1 ORDER BY ev.created_at`, [s.id]);
    const approval = events.find(e => e.action === 'approve') || null;
    const payment = events.find(e => e.action === 'pay') || null;
    const me = req.user?.userId ?? null;
    const own = req.user?.employee_id != null && Number(req.user.employee_id) === Number(er.employee_id);
    const suspended = fnfSettlementSuspended();
    const blockers = payment ? [] : (await computeClearanceBlockers(er.employee_id)).blockers ?? [];
    const notApprovable = s.rules_unconfirmed?.length ? 'Confirm the settlement rules, then HR recalculates.' : null;
    res.json({
      exit: er,
      settlement: {
        id: s.id, version: s.version, separation_type: s.separation_type, last_working_date: s.last_working_date,
        total_payable: s.total_payable, total_recoverable: s.total_recoverable, net_payable: s.net_payable,
        lines: s.lines, warnings: s.warnings, rules_unconfirmed: s.rules_unconfirmed,
        computed_by: s.computed_by, computed_by_name: s.computed_by_name, computed_at: s.computed_at,
        // What HR entered for this version, so Exit Management's calculator can
        // show the saved settlement with its inputs instead of recomputing it.
        options: s.inputs?.options ?? null,
        sales_incentive: s.inputs?.salesIncentive ?? null,
      },
      approval, payment,
      // Payment is refused until these clear (the pay route's own gate).
      clearance_blockers: blockers.filter(b => !b.cleared).map(b => ({ key: b.key, label: b.label, detail: b.detail })),
      suspended,
      can_approve: !suspended && !approval && !own && !notApprovable
        && await can(req, 'payroll', 'approve') && String(s.computed_by) !== String(me),
      can_pay: !suspended && !!approval && !payment && !own
        && await can(req, 'payroll_payment', 'approve') && String(approval.actor_id) !== String(me),
      why_not: suspended ? 'F&F approval and payment are switched off (HR_CONTAINMENT_FNF).'
        : own ? 'This is your own settlement.'
        : (!approval && String(s.computed_by) === String(me)) ? 'You computed this version, so someone else must approve it.'
        : (approval && !payment && String(approval.actor_id) === String(me)) ? 'You approved it, so someone else must record the payment.'
        : notApprovable,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /fnf/review/:exit_id/statement — the leaver's F&F statement (PDF) ────
// Exit review 2026-11-17: there was no statement to hand the employee. It is
// the LATEST saved version as computed (never recomputed), and says DRAFT on
// its face until that version is approved. Reached with fnf:view like the review.
// A DATE column arrives as 'YYYY-MM-DD'; a timestamptz (computed_at) as a Date,
// shown on the business day (IST). String(Date).slice(0, 10) gave "Invalid Date".
const fmtLong = (d) => {
  if (!d) return null;
  const opts = { day: '2-digit', month: 'short', year: 'numeric' };
  if (d instanceof Date) return d.toLocaleDateString('en-GB', { ...opts, timeZone: 'Asia/Kolkata' });
  return new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
};
router.get('/fnf/review/:exit_id/statement', async (req, res) => {
  const exitId = intId(req.params.exit_id);
  if (exitId == null) return res.status(400).json({ error: 'Invalid exit request id' });
  try {
    const { rows: [er] } = await pool.query(
      `SELECT er.id, er.employee_id, er.separation_type, er.last_working_date,
              e.office_id, e.first_name, e.last_name, e.department, e.designation, e.joining_date,
              c.name AS company_name, concat_ws(', ', NULLIF(c.address, ''), NULLIF(c.city, ''), NULLIF(c.state, ''), NULLIF(c.pincode::text, '')) AS company_address
         FROM exit_requests er JOIN employees e ON e.id = er.employee_id
         LEFT JOIN companies c ON c.id = e.company_id
        WHERE er.id = $1 AND e.deleted_at IS NULL AND ($2::int IS NULL OR e.company_id = $2::int)`,
      [exitId, cid(req)]);
    if (!er) return res.status(404).json({ error: 'Not found' });
    const { rows: [s] } = await pool.query(
      `SELECT * FROM fnf_settlements WHERE exit_request_id = $1 ORDER BY version DESC LIMIT 1`, [exitId]);
    if (!s) return res.status(409).json({ code: 'SETTLEMENT_NOT_COMPUTED', error: 'No settlement has been calculated for this exit yet.' });
    const { rows: events } = await pool.query(
      `SELECT action, utr, value_date FROM fnf_settlement_events WHERE settlement_id = $1 ORDER BY created_at`, [s.id]);
    const payment = events.find(e => e.action === 'pay') || null;
    const approved = events.some(e => e.action === 'approve');
    const state = payment ? 'paid' : approved ? 'approved' : 'draft';
    const pdf = await buildFnfStatementPdf({
      company: { name: er.company_name, address: er.company_address },
      employee: {
        name: `${er.first_name || ''} ${er.last_name || ''}`.trim(), office_id: er.office_id,
        designation: er.designation, department: er.department,
        joining_date: fmtLong(er.joining_date), last_working_date: fmtLong(s.last_working_date ?? er.last_working_date),
        separation: String(s.separation_type || er.separation_type || '').replace(/_/g, ' '),
      },
      settlement: {
        version: s.version, computed_on: fmtLong(s.computed_at), lines: s.lines,
        total_payable: s.total_payable, total_recoverable: s.total_recoverable, net_payable: s.net_payable,
      },
      state,
      payment: payment ? { utr: payment.utr, value_date: fmtLong(payment.value_date) } : null,
      issuedOn: fmtLong(localTodayIso()),
    });
    logAudit({ userId: req.user?.userId ?? req.user?.id ?? null, module: 'hr', recordId: er.employee_id, recordType: 'fnf_statement',
      action: 'issue_fnf_statement', newData: { exit_request_id: exitId, settlement_id: s.id, version: s.version, state }, req });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="FnF_${String(er.office_id || er.employee_id).replace(/[^A-Za-z0-9_-]/g, '')}_v${s.version}${state === 'draft' ? '_DRAFT' : ''}.pdf"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/fnf/:id/approve', contained, requirePermission('payroll', 'approve'), async (req, res) => {
  const exitId = intId(req.params.id);
  if (exitId == null) return res.status(400).json({ error: 'Invalid exit request id' });
  const companyId = cid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [oldRecord] } = await client.query(
      `SELECT er.* FROM exit_requests er JOIN employees e ON e.id = er.employee_id
        WHERE er.id = $1 AND ($2::int IS NULL OR e.company_id = $2::int) FOR UPDATE OF er`, [exitId, companyId]
    );
    if (!oldRecord) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (oldRecord.fnf_status === 'paid') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'F&F is already paid' }); }
    const s = await approveSettlement(client, { exitId, settlementId: req.body?.settlement_id, userId: req.user?.userId ?? null, companyId });
    const { rows: [updatedRecord] } = await client.query(
      `UPDATE exit_requests SET fnf_status = 'approved', updated_at = NOW() WHERE id = $1 RETURNING *`, [exitId]);
    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId, module: 'HR', recordId: exitId, recordType: 'fnf_settlement', action: 'approve', oldData: oldRecord, newData: updatedRecord, req });
    // Look up the employee's userId for workflow notification, through the reverse FK.
    pool.query(`SELECT id AS user_id FROM users WHERE employee_id=$1`, [updatedRecord.employee_id])
      .then(({ rows: empRows }) => {
        notifyWorkflowEvent('approved', { module: 'HR', recordId: exitId, submitterUserId: empRows[0]?.user_id, actorId: req.user?.userId, companyId: cid(req) });
      }).catch(() => {});
    res.json({ ...updatedRecord, settlement_id: s.id, version: s.version });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    settlementFailure(res, e);
  } finally {
    client.release();
  }
});

// ── POST /fnf/:id/pay — marks F&F paid and bridges employee to 'left' ─────────
router.post('/fnf/:id/pay', contained, requirePermission('payroll_payment', 'approve'), async (req, res) => {
  const exitId = intId(req.params.id);
  if (exitId == null) return res.status(400).json({ error: 'Invalid exit request id' });
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

    // The bank evidence, the journal and the closed recoveries, or nothing at all.
    const payment = await paySettlement(client, {
      exitId, employeeId: erRows[0].employee_id, companyId: cid(req), userId: req.user?.userId ?? null,
      settlementId: req.body?.settlement_id, utr: req.body?.utr, value_date: req.body?.value_date, bank_account_id: req.body?.bank_account_id,
    });
    const { rows } = await client.query(
      `UPDATE exit_requests SET fnf_status='paid', status='closed', updated_at=NOW() WHERE id=$1 RETURNING *`,
      [exitId]
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
    res.json({ ...er, utr: payment.utr, journal_entry_id: payment.journal_entry_id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    settlementFailure(res, e);
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

// The three clearance reads are company-scoped (HR audit 2026-11-16): they read
// another company's employee's clearance by id alone. Same 404 as the PUT.
router.get('/clearance/:employee_id', async (req, res) => {
  const empId = intId(req.params.employee_id);
  if (empId == null) return res.status(400).json({ error: 'Invalid employee id' });
  try {
    if (!await employeeInCompany(pool, empId, cid(req))) return res.status(404).json({ error: 'Employee not found' });
    const { rows } = await pool.query(`SELECT * FROM exit_clearance WHERE employee_id=$1`, [empId]);
    res.json(rows.length ? rows[0] : { employee_id: empId, ...EMPTY_CLEARANCE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /clearance/:employee_id/history — earlier exits' clearance (B7) ──────
// freshClearance() archives the row before a new exit clears it.
router.get('/clearance/:employee_id/history', async (req, res) => {
  const empId = intId(req.params.employee_id);
  if (empId == null) return res.status(400).json({ error: 'Invalid employee id' });
  try {
    if (!await employeeInCompany(pool, empId, cid(req))) return res.status(404).json({ error: 'Employee not found' });
    const { rows } = await pool.query(
      `SELECT h.id, h.exit_request_id, h.clearance, h.archived_at,
              er.separation_type, er.last_working_date, er.status AS exit_status
         FROM exit_clearance_history h
         LEFT JOIN exit_requests er ON er.id = h.exit_request_id
        WHERE h.employee_id = $1
        ORDER BY h.archived_at DESC, h.id DESC`, [empId]);
    res.json(rows);
  } catch (e) {
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
    if (!await employeeInCompany(pool, empId, cid(req))) return res.status(404).json({ error: 'Employee not found' });
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
