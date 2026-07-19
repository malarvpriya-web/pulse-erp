import express from 'express';
import pool from '../shared/db.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';

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
router.put('/requests/:id', requireHRWrite, async (req, res) => {
  try {
    const { status, remarks } = req.body;
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
router.post('/fnf/compute/:employee_id', requireHRWrite, async (req, res) => {
  try {
    const empId = req.params.employee_id;
    const { rows: [emp] } = await pool.query(
      `SELECT e.*, er.last_working_date, er.id AS exit_id, er.notice_period
       FROM employees e
       JOIN exit_requests er ON er.employee_id = e.id
       WHERE e.id=$1 ORDER BY er.created_at DESC LIMIT 1`,
      [empId]
    );
    if (!emp) return res.status(404).json({ error: 'Employee or exit request not found' });

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
      const lbRes = await pool.query(
        `SELECT COALESCE(SUM(balance), 0) AS bal
         FROM leave_balances
         WHERE employee_id = $1 AND leave_type ILIKE '%earned%'`,
        [empId]
      );
      leaveBalance = parseFloat(lbRes.rows[0]?.bal || 0);
      // If no earned leave row, fall back to the hr_attendance_summary if available
      if (leaveBalance === 0) {
        const attRes = await pool.query(
          `SELECT COALESCE(earned_leave_balance, 0) AS bal
           FROM hr_attendance_summary
           WHERE employee_id = $1
           ORDER BY created_at DESC LIMIT 1`,
          [empId]
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

    const grossFnf  = leaveEncashment + gratuityAmount;
    const netPayable = parseFloat((grossFnf - noticeRecovery).toFixed(2));

    const { rows: [updated] } = await pool.query(
      `UPDATE exit_requests SET fnf_status='draft', net_payable=$1 WHERE id=$2 RETURNING id`,
      [netPayable, emp.exit_id]
    );

    res.json({
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
    });
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
    // Look up the employee's userId for workflow notification
    pool.query(`SELECT user_id FROM employees WHERE id=$1`, [updatedRecord.employee_id])
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

// ── PUT /clearance/:employee_id ───────────────────────────────────────────────
router.put('/clearance/:employee_id', requireHRWrite, async (req, res) => {
  try {
    const {
      it_assets_returned, access_revoked, documents_collected, exit_interview_done,
      noc_it, noc_admin, noc_finance, noc_hr, noc_manager,
    } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO exit_clearance
         (employee_id, it_assets_returned, access_revoked, documents_collected, exit_interview_done,
          noc_it, noc_admin, noc_finance, noc_hr, noc_manager, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (employee_id) DO UPDATE SET
         it_assets_returned=$2, access_revoked=$3, documents_collected=$4, exit_interview_done=$5,
         noc_it=$6, noc_admin=$7, noc_finance=$8, noc_hr=$9, noc_manager=$10, updated_at=NOW()
       RETURNING *`,
      [req.params.employee_id, it_assets_returned, access_revoked, documents_collected,
       exit_interview_done, noc_it, noc_admin, noc_finance, noc_hr, noc_manager]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
