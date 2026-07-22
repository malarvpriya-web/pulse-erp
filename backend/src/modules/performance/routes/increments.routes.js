import express from 'express';
import pool from '../../../config/db.js';
import { logAudit } from '../../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../../services/WorkflowNotificationService.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

const role   = req => req.user?.role ?? 'employee';
const getCid = req => req.scope?.company_id ?? companyOf(req);
const isHR   = req => ['hr', 'super_admin', 'admin'].includes(role(req));
const isMgr  = req => ['manager', 'hr', 'super_admin', 'admin'].includes(role(req));

/* ─── INCREMENT BANDS (rating → % matrix) ───────────────────────────────── */

router.get('/bands', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
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
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
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

router.patch('/bands/:id', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
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

router.delete('/bands/:id', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
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
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id, status, department } = req.query;
  const params = [cid];
  let where = 'WHERE ir.company_id = $1';
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
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
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
       WHERE ir.id = $1 AND ir.company_id = $2`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Recommendation not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/recommendations', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const {
    employee_id, review_id, cycle_id,
    current_ctc, recommended_increment_pct, effective_date, justification,
  } = req.body;
  if (!employee_id || !recommended_increment_pct) {
    return res.status(400).json({ error: 'employee_id and recommended_increment_pct required' });
  }
  const cid = getCid(req);
  const recommended_new_ctc = current_ctc
    ? Math.round(parseFloat(current_ctc) * (1 + parseFloat(recommended_increment_pct) / 100))
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
       current_ctc || null, recommended_increment_pct, recommended_new_ctc,
       effective_date || null, justification || null, req.user?.userId ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/recommendations/:id/approve', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
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
       effective_date ?? null, req.user?.userId ?? null, cid]
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

router.patch('/recommendations/:id/reject', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
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
      [req.params.id, rejection_reason || null, req.user?.userId ?? null, cid]
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
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: recs } = await client.query(
      `SELECT ir.*, e.id AS emp_id
       FROM increment_recommendations ir
       JOIN employees e ON e.id = ir.employee_id
       WHERE ir.id = $1 AND ir.company_id = $2 AND ir.status = 'approved'`,
      [req.params.id, cid]
    );
    if (!recs.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Recommendation not found or not approved' });
    }
    const rec = recs[0];
    // Write the effective new pay into the table payroll actually reads
    // (payroll.service.js's generatePayroll COALESCEs the latest
    // employee_salary_assignments.basic_salary with employees.basic_salary).
    // `salary_structures` is a shared component-template table with no
    // employee_id/ctc/effective_date/is_active columns at all — the previous
    // version of this UPDATE always failed against that schema, so an approved
    // increment never actually changed what an employee got paid.
    const { rows: [latestAssignment] } = await client.query(
      `SELECT basic_salary, structure_id FROM employee_salary_assignments
       WHERE employee_id = $1 ORDER BY effective_from DESC NULLS LAST, created_at DESC LIMIT 1`,
      [rec.emp_id]
    );
    const { rows: [empRow] } = await client.query(`SELECT basic_salary FROM employees WHERE id = $1`, [rec.emp_id]);
    const currentBasic = parseFloat(latestAssignment?.basic_salary ?? empRow?.basic_salary ?? 0);
    const currentCtc = parseFloat(rec.current_ctc || 0);
    const newCtc = parseFloat(rec.final_new_ctc || 0);
    // Scale basic_salary by the same ratio as the CTC change; if we don't have
    // enough information to compute a ratio, carry the current basic forward
    // unchanged rather than guessing.
    const newBasic = (currentCtc > 0 && newCtc > 0)
      ? Math.round(currentBasic * (newCtc / currentCtc))
      : currentBasic;
    const effectiveFrom = rec.effective_date || new Date().toISOString().split('T')[0];

    await client.query(
      `INSERT INTO employee_salary_assignments (employee_id, structure_id, effective_from, basic_salary)
       VALUES ($1,$2,$3,$4)`,
      [rec.emp_id, latestAssignment?.structure_id || null, effectiveFrom, newBasic]
    );
    await client.query(`UPDATE employees SET basic_salary = $2 WHERE id = $1`, [rec.emp_id, newBasic]);
    // Mark as processed
    await client.query(
      `UPDATE increment_recommendations SET
         payroll_synced    = TRUE,
         payroll_synced_at = NOW(),
         status            = 'processed',
         updated_at        = NOW()
       WHERE id = $1`,
      [req.params.id]
    );
    await client.query('COMMIT');
    res.json({ message: 'Increment pushed to payroll', employee_id: rec.emp_id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* GET /increments/budget-summary — aggregate budget view (HR only) */
router.get('/budget-summary', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
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
