import express from 'express';
import pool from '../../../config/db.js';
import { logAudit } from '../../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../../services/WorkflowNotificationService.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { captureBefore } from '../../../middlewares/captureBefore.js';
import { can } from '../../../middlewares/auth.middleware.js';
import { currentAnnualCtc, createProposal, ProposalError } from '../../payroll/salaryProposals.service.js';
import { normalizePayrollSettings } from '../../payroll/payrollSettings.js';

// CTC-driven increments (PAYROLL_DATA_FLOW_AUDIT.md Part 4) apply only when the
// company has switched ctc_mode on; otherwise the legacy Basic-ratio path runs.
async function ctcModeOn(companyId) {
  const { rows } = await pool.query(
    `SELECT settings FROM company_settings WHERE company_id = $1 AND module = 'payroll' LIMIT 1`, [companyId]);
  return !!normalizePayrollSettings(rows[0]?.settings || {}).settings.ctc_mode;
}

const router = express.Router();

const getCid = req => req.scope?.company_id ?? companyOf(req);

// ── Access (PC-01 D7, 04 Nov 26) ─────────────────────────────────────────────
// The permission matrix decides; these were single-role checks on
// req.user.role (isHR / isMgr) that let ANY `manager` list and create salary
// recommendations for the whole company — every row carries current and
// proposed CTC — and ignored a user's other roles.
//   bands, approve / reject      performance:approve  (admin, hr, super_admin: the old isHR set)
//   recommendations, company-wide  read: performance:approve (HR runs the cycle) or
//                                payroll:edit (pushes approved increments) — not
//                                payroll:view alone: finance_manager reads payroll
//                                but has no increment duty (PC-01 closure decision 2);
//                                create: payroll:edit
//   budget summary               the same company-wide read (a one-person department
//                                gives that person's CTC back)
//   recommendations, own team    increment_team:view / :add — the caller's DIRECT
//                                REPORTS only (employees.reporting_manager_id)
//   push to payroll              payroll:edit, and only through a salary
//                                proposal (CTC mode); never a direct salary write
async function readsAllIncrements(req) {
  return (await can(req, 'performance', 'approve')) || (await can(req, 'payroll', 'edit'));
}

async function recommendationScope(req, action) {
  const companyWide = action === 'add' ? await can(req, 'payroll', 'edit') : await readsAllIncrements(req);
  if (companyWide) return { all: true };
  if (await can(req, 'increment_team', action)) {
    const me = await employeeOf(req, pool);
    if (me == null) return { error: 403, message: 'No employee record is linked to this account' };
    return { all: false, managerId: Number(me) };
  }
  return { error: 403, message: 'You do not have access to salary increment recommendations' };
}

/* ─── INCREMENT BANDS (rating → % matrix) ───────────────────────────────── */

router.get('/bands', async (req, res) => {
  if (!(await can(req, 'performance', 'approve'))) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const { cycle_id } = req.query;
  const params = [cid];
  let extra = '';
  if (cycle_id) { params.push(cycle_id); extra = ` AND cycle_id = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT * FROM increment_bands
       WHERE company_id = $1 AND is_active = TRUE${extra}
       ORDER BY rating_from`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/bands', async (req, res) => {
  if (!(await can(req, 'performance', 'approve'))) return res.status(403).json({ error: 'HR access required' });
  const {
    cycle_id, band_name, rating_from, rating_to,
    increment_pct_min, increment_pct_max, increment_pct_default, budget_pct,
  } = req.body;
  if (!band_name || rating_from == null || rating_to == null) {
    return res.status(400).json({ error: 'band_name, rating_from, rating_to required' });
  }
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO increment_bands
         (company_id, cycle_id, band_name, rating_from, rating_to,
          increment_pct_min, increment_pct_max, increment_pct_default, budget_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [cid, cycle_id || null, band_name, rating_from, rating_to,
       increment_pct_min || 0, increment_pct_max || 0,
       increment_pct_default || 0, budget_pct || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/bands/:id', captureBefore('increment_bands'), async (req, res) => {
  if (!(await can(req, 'performance', 'approve'))) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const {
    band_name, rating_from, rating_to,
    increment_pct_min, increment_pct_max, increment_pct_default, budget_pct,
  } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE increment_bands SET
         band_name              = COALESCE($2, band_name),
         rating_from            = COALESCE($3, rating_from),
         rating_to              = COALESCE($4, rating_to),
         increment_pct_min      = COALESCE($5, increment_pct_min),
         increment_pct_max      = COALESCE($6, increment_pct_max),
         increment_pct_default  = COALESCE($7, increment_pct_default),
         budget_pct             = COALESCE($8, budget_pct),
         updated_at             = NOW()
       WHERE id = $1 AND company_id = $9 RETURNING *`,
      [req.params.id, band_name || null, rating_from ?? null, rating_to ?? null,
       increment_pct_min ?? null, increment_pct_max ?? null,
       increment_pct_default ?? null, budget_pct ?? null, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Band not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/bands/:id', captureBefore('increment_bands'), async (req, res) => {
  if (!(await can(req, 'performance', 'approve'))) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  try {
    await pool.query(
      'UPDATE increment_bands SET is_active = FALSE WHERE id = $1 AND company_id = $2',
      [req.params.id, cid]
    );
    res.json({ message: 'Band removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── INCREMENT RECOMMENDATIONS ─────────────────────────────────────────── */

router.get('/recommendations', async (req, res) => {
  const scope = await recommendationScope(req, 'view'); if (scope.error) return res.status(scope.error).json({ error: scope.message });
  const cid = getCid(req);
  const { cycle_id, status, department } = req.query;
  const params = [cid];
  let where = 'WHERE ir.company_id = $1';
  if (!scope.all) { params.push(scope.managerId); where += ` AND e.reporting_manager_id = $${params.length}`; }
  if (cycle_id)   { params.push(cycle_id);   where += ` AND ir.cycle_id = $${params.length}`; }
  if (status)     { params.push(status);     where += ` AND ir.status = $${params.length}`; }
  if (department) { params.push(department); where += ` AND e.department = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT ir.*,
         e.name AS employee_name, e.department, e.designation, e.office_id AS employee_code,
         sub.name AS submitted_by_name,
         apv.name AS approved_by_name
       FROM increment_recommendations ir
       JOIN employees e ON e.id = ir.employee_id
       LEFT JOIN employees sub ON sub.id = ir.submitted_by
       LEFT JOIN employees apv ON apv.id = ir.approved_by
       ${where}
       ORDER BY e.department, e.name`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/recommendations/:id', async (req, res) => {
  const scope = await recommendationScope(req, 'view'); if (scope.error) return res.status(scope.error).json({ error: scope.message });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT ir.*,
         e.name AS employee_name, e.department, e.designation,
         sub.name AS submitted_by_name, apv.name AS approved_by_name
       FROM increment_recommendations ir
       JOIN employees e ON e.id = ir.employee_id
       LEFT JOIN employees sub ON sub.id = ir.submitted_by
       LEFT JOIN employees apv ON apv.id = ir.approved_by
       WHERE ir.id = $1 AND ir.company_id = $2
         AND ($3::int IS NULL OR e.reporting_manager_id = $3::int)`,
      [req.params.id, cid, scope.all ? null : scope.managerId]
    );
    // Not a direct report → the same 404 as a missing id (no existence hint).
    if (!rows.length) return res.status(404).json({ error: 'Recommendation not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/recommendations', async (req, res) => {
  const scope = await recommendationScope(req, 'add'); if (scope.error) return res.status(scope.error).json({ error: scope.message });
  const {
    employee_id, review_id, cycle_id,
    current_ctc, recommended_increment_pct, effective_date, justification,
  } = req.body;
  if (!employee_id || !recommended_increment_pct) {
    return res.status(400).json({ error: 'employee_id and recommended_increment_pct required' });
  }
  const cid = getCid(req);
  // Team scope: only a direct report. Anyone else is the same 404 as an
  // unknown id — in CTC mode the response would otherwise disclose the
  // employee's current annual CTC.
  const { rows: own } = await pool.query(
    `SELECT 1 FROM employees WHERE id = $1 AND company_id = $2
       AND ($3::int IS NULL OR reporting_manager_id = $3::int)`,
    [employee_id, cid, scope.all ? null : scope.managerId]);
  if (!own.length) return res.status(404).json({ error: 'Employee not found' });
  let baseCtc = current_ctc;
  let currentAnnual = null;
  if (await ctcModeOn(cid)) {
    // The base is the annual CTC of the revision in force on the effective
    // date — never a typed figure.
    const on = effective_date || (await pool.query('SELECT CURRENT_DATE::text AS d')).rows[0].d;   // DB date, not UTC
    const cur = await currentAnnualCtc({ company_id: cid, employee_id, on_date: on });
    if (!cur || cur.annual_ctc == null) {
      return res.status(422).json({ error: `No annual CTC can be derived for this employee on ${on}${cur?.reason ? `: ${cur.reason}` : ' (no salary revision in force)'}` });
    }
    currentAnnual = cur.annual_ctc;
    baseCtc = cur.annual_ctc;
  }
  const recommended_new_ctc = baseCtc
    ? Math.round(parseFloat(baseCtc) * (1 + parseFloat(recommended_increment_pct) / 100))
    : null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO increment_recommendations
         (company_id, employee_id, review_id, cycle_id,
          current_ctc, recommended_increment_pct, recommended_new_ctc,
          effective_date, justification, submitted_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitted')
       ON CONFLICT (employee_id, cycle_id) DO UPDATE SET
         recommended_increment_pct = $6,
         recommended_new_ctc       = $7,
         effective_date            = $8,
         justification             = $9,
         submitted_by              = $10,
         status                    = 'submitted',
         updated_at                = NOW()
       RETURNING *`,
      [cid, employee_id, review_id || null, cycle_id || null,
       baseCtc || null, recommended_increment_pct, recommended_new_ctc,
       effective_date || null, justification || null, await employeeOf(req, pool)]
    );
    if (currentAnnual != null) {
      await pool.query(`UPDATE increment_recommendations SET current_annual_ctc = $2, new_annual_ctc = $3 WHERE id = $1`,
        [rows[0].id, currentAnnual, recommended_new_ctc]);
      rows[0].current_annual_ctc = currentAnnual; rows[0].new_annual_ctc = recommended_new_ctc;
    }
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/recommendations/:id/approve', captureBefore('increment_recommendations'), async (req, res) => {
  if (!(await can(req, 'performance', 'approve'))) return res.status(403).json({ error: 'HR access required' });
  const { final_increment_pct, final_new_ctc, effective_date } = req.body;
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE increment_recommendations SET
         final_increment_pct = COALESCE($2, recommended_increment_pct),
         final_new_ctc       = COALESCE($3, recommended_new_ctc),
         effective_date      = COALESCE($4, effective_date),
         approved_by         = $5,
         approved_at         = NOW(),
         status              = 'approved',
         updated_at          = NOW()
       WHERE id = $1 AND company_id = $6 RETURNING *`,
      [req.params.id, final_increment_pct ?? null, final_new_ctc ?? null,
       effective_date ?? null, await employeeOf(req, pool), cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Recommendation not found' });
    const rec = rows[0];
    logAudit({ userId: req.user?.userId, module: 'Performance', recordId: req.params.id, recordType: 'increment_recommendation', action: 'approve', newData: rec, req });
    pool.query(`SELECT id AS user_id FROM users WHERE employee_id=$1`, [rec.employee_id])
      .then(({ rows: empRows }) => {
        notifyWorkflowEvent('approved', { module: 'Increment', recordId: req.params.id, submitterUserId: empRows[0]?.user_id ?? null });
      }).catch(() => {});
    res.json(rec);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/recommendations/:id/reject', captureBefore('increment_recommendations'), async (req, res) => {
  if (!(await can(req, 'performance', 'approve'))) return res.status(403).json({ error: 'HR access required' });
  const { rejection_reason } = req.body;
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE increment_recommendations SET
         status           = 'rejected',
         rejection_reason = $2,
         approved_by      = $3,
         approved_at      = NOW(),
         updated_at       = NOW()
       WHERE id = $1 AND company_id = $4 RETURNING *`,
      [req.params.id, rejection_reason || null, await employeeOf(req, pool), cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Recommendation not found' });
    const rec = rows[0];
    logAudit({ userId: req.user?.userId, module: 'Performance', recordId: req.params.id, recordType: 'increment_recommendation', action: 'reject', newData: rec, req });
    pool.query(`SELECT id AS user_id FROM users WHERE employee_id=$1`, [rec.employee_id])
      .then(({ rows: empRows }) => {
        notifyWorkflowEvent('rejected', { module: 'Increment', recordId: req.params.id, submitterUserId: empRows[0]?.user_id ?? null });
      }).catch(() => {});
    res.json(rec);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST /increments/recommendations/:id/push-payroll — write approved increment to salary_structures */
router.post('/recommendations/:id/push-payroll', async (req, res) => {
  if (!(await can(req, 'payroll', 'edit'))) return res.status(403).json({ error: 'Payroll edit permission required' });
  const cid = getCid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: recs } = await client.query(
      `SELECT ir.*, e.id AS emp_id
       FROM increment_recommendations ir
       JOIN employees e ON e.id = ir.employee_id
       WHERE ir.id = $1 AND ir.company_id = $2 AND ir.status = 'approved'
         -- the EMPLOYEE must be this company's too: the salary revision below
         -- is written to it, and nothing checked that it was not another tenant's.
         AND e.company_id = $2`,
      [req.params.id, cid]
    );
    if (!recs.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Recommendation not found or not approved' });
    }
    const rec = recs[0];
    if (await ctcModeOn(cid)) {
      // CTC mode: a DRAFT salary proposal on the increment's effective date,
      // priced from the approved annual CTC with a full component breakdown.
      // Nothing changes until an approver approves it (maker-checker per the
      // company's CTC policy); previous revisions are never edited.
      await client.query('ROLLBACK');
      const eff = rec.effective_date ? (rec.effective_date instanceof Date ? rec.effective_date.toISOString() : String(rec.effective_date)).slice(0, 10) : null;
      if (!eff) return res.status(422).json({ error: 'The increment has no effective date' });
      const newCtc = parseFloat(rec.final_new_ctc || rec.recommended_new_ctc || 0);
      if (!(newCtc > 0)) return res.status(422).json({ error: 'The increment has no new annual CTC' });
      const { rows: [inForce] } = await pool.query(
        `SELECT structure_id FROM employee_salary_assignments WHERE employee_id = $1 AND effective_from <= $2::date
          ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [rec.emp_id, eff]);
      try {
        const r = await createProposal({ company_id: cid, employee_id: rec.emp_id, structure_id: inForce?.structure_id ?? null,
          effective_from: eff, annual_ctc: newCtc, source_type: 'increment', source_id: rec.id, userId: req.user?.userId ?? null, req });
        await pool.query(`UPDATE increment_recommendations SET proposal_id = $2, new_annual_ctc = $3, updated_at = NOW() WHERE id = $1`,
          [rec.id, r.proposal.id, newCtc]);
        return res.status(201).json({ success: true, mode: 'ctc', proposal: r.proposal, preview: r.preview });
      } catch (e) {
        if (e instanceof ProposalError) return res.status(e.status).json({ error: e.message, ...e.extra });
        throw e;
      }
    }
    // PC-01 D7 / Q6 (04 Nov 26): outside CTC mode there is no salary proposal
    // workflow, and the path below wrote the salary revision (and the master
    // Basic) directly — a salary change with no approval. It is refused before
    // anything is written; the salary is changed through Payroll Center →
    // Salary Structures (payroll:edit) or, in CTC mode, a proposal. The old
    // direct-write branch (revision + employees.basic_salary) was removed.
    await client.query('ROLLBACK');
    return res.status(409).json({
      code: 'SALARY_PROPOSAL_REQUIRED',
      error: 'Increments are pushed to payroll only as a salary proposal, which needs CTC mode. Change the salary in Payroll Center → Salary Structures instead.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* GET /increments/budget-summary — aggregate budget view (HR only) */
router.get('/budget-summary', async (req, res) => {
  if (!(await readsAllIncrements(req))) return res.status(403).json({ error: 'Company-wide increment access required' });
  const cid = getCid(req);
  const { cycle_id } = req.query;
  const params = [cid];
  let extra = '';
  if (cycle_id) { params.push(cycle_id); extra = ` AND ir.cycle_id = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.department,
         COUNT(ir.id)::int AS headcount,
         ROUND(AVG(ir.recommended_increment_pct)::numeric, 2) AS avg_increment_pct,
         ROUND(SUM(ir.current_ctc)::numeric, 0) AS total_current_ctc,
         ROUND(SUM(ir.recommended_new_ctc)::numeric, 0) AS total_new_ctc,
         ROUND((SUM(ir.recommended_new_ctc) - SUM(ir.current_ctc))::numeric, 0) AS total_increment_cost
       FROM increment_recommendations ir
       JOIN employees e ON e.id = ir.employee_id
       WHERE ir.company_id = $1${extra}
       GROUP BY e.department
       ORDER BY total_increment_cost DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
