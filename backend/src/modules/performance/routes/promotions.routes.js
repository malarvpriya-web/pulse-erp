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

/* GET /performance/promotions — list promotions */
router.get('/', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id, status, department } = req.query;
  const params = [cid];
  let where = 'WHERE pr.company_id = $1';
  if (cycle_id)   { params.push(cycle_id);   where += ` AND pr.cycle_id = $${params.length}`; }
  if (status)     { params.push(status);     where += ` AND pr.status = $${params.length}`; }
  if (department) { params.push(department); where += ` AND e.department = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT pr.*,
         e.name AS employee_name, e.department, e.designation, e.office_id AS employee_code,
         e.joining_date AS date_of_joining, e.grade,
         sub.name AS submitted_by_name,
         apv.name AS approved_by_name
       FROM promotion_recommendations pr
       JOIN employees e ON e.id = pr.employee_id
       LEFT JOIN employees sub ON sub.id = pr.submitted_by
       LEFT JOIN employees apv ON apv.id = pr.approved_by
       ${where}
       ORDER BY e.department, e.name`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT pr.*,
         e.name AS employee_name, e.department, e.designation, e.office_id AS employee_code,
         e.joining_date AS date_of_joining, e.grade,
         sub.name AS submitted_by_name, apv.name AS approved_by_name
       FROM promotion_recommendations pr
       JOIN employees e ON e.id = pr.employee_id
       LEFT JOIN employees sub ON sub.id = pr.submitted_by
       LEFT JOIN employees apv ON apv.id = pr.approved_by
       WHERE pr.id = $1 AND pr.company_id = $2`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Recommendation not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const {
    employee_id, review_id, cycle_id,
    proposed_designation, current_designation,
    proposed_grade, current_grade,
    proposed_department, current_department,
    effective_date, justification, performance_rating, years_in_role,
  } = req.body;
  if (!employee_id || !proposed_designation) {
    return res.status(400).json({ error: 'employee_id and proposed_designation required' });
  }
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO promotion_recommendations
         (company_id, employee_id, review_id, cycle_id,
          current_designation, proposed_designation,
          current_grade, proposed_grade,
          current_department, proposed_department,
          effective_date, justification, performance_rating, years_in_role,
          submitted_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'submitted')
       RETURNING *`,
      [cid, employee_id, review_id || null, cycle_id || null,
       current_designation || null, proposed_designation,
       current_grade || null, proposed_grade || null,
       current_department || null, proposed_department || null,
       effective_date || null, justification || null,
       performance_rating || null, years_in_role || null,
       req.user?.userId ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const {
    proposed_designation, proposed_grade, proposed_department,
    effective_date, justification,
  } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE promotion_recommendations SET
         proposed_designation = COALESCE($2, proposed_designation),
         proposed_grade       = COALESCE($3, proposed_grade),
         proposed_department  = COALESCE($4, proposed_department),
         effective_date       = COALESCE($5, effective_date),
         justification        = COALESCE($6, justification),
         updated_at           = NOW()
       WHERE id = $1 AND company_id = $7 AND status IN ('draft','submitted')
       RETURNING *`,
      [req.params.id, proposed_designation || null, proposed_grade ?? null,
       proposed_department ?? null, effective_date ?? null, justification ?? null, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Recommendation not found or cannot be edited' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/approve', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const { effective_date, proposed_grade, proposed_designation } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE promotion_recommendations SET
         status               = 'approved',
         approved_by          = $2,
         approved_at          = NOW(),
         effective_date       = COALESCE($3, effective_date),
         proposed_grade       = COALESCE($4, proposed_grade),
         proposed_designation = COALESCE($5, proposed_designation),
         updated_at           = NOW()
       WHERE id = $1 AND company_id = $6 RETURNING *`,
      [req.params.id, req.user?.userId ?? null, effective_date ?? null,
       proposed_grade ?? null, proposed_designation ?? null, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const rec = rows[0];
    logAudit({ userId: req.user?.userId, module: 'Performance', recordId: req.params.id, recordType: 'promotion', action: 'approve', newData: rec, req });
    pool.query(`SELECT id AS user_id FROM users WHERE employee_id=$1`, [rec.employee_id])
      .then(({ rows: empRows }) => {
        notifyWorkflowEvent('approved', { module: 'Promotion', recordId: req.params.id, submitterUserId: empRows[0]?.user_id ?? null });
      }).catch(() => {});
    res.json(rec);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/reject', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const { rejection_reason } = req.body;
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE promotion_recommendations SET
         status           = 'rejected',
         rejection_reason = $2,
         approved_by      = $3,
         approved_at      = NOW(),
         updated_at       = NOW()
       WHERE id = $1 AND company_id = $4 RETURNING *`,
      [req.params.id, rejection_reason || null, req.user?.userId ?? null, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const rec = rows[0];
    logAudit({ userId: req.user?.userId, module: 'Performance', recordId: req.params.id, recordType: 'promotion', action: 'reject', newData: rec, req });
    pool.query(`SELECT id AS user_id FROM users WHERE employee_id=$1`, [rec.employee_id])
      .then(({ rows: empRows }) => {
        notifyWorkflowEvent('rejected', { module: 'Promotion', recordId: req.params.id, submitterUserId: empRows[0]?.user_id ?? null });
      }).catch(() => {});
    res.json(rec);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST /promotions/:id/process — apply grade change to employee record */
router.post('/:id/process', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: recs } = await client.query(
      `SELECT * FROM promotion_recommendations
       WHERE id = $1 AND company_id = $2 AND status = 'approved'`,
      [req.params.id, cid]
    );
    if (!recs.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Not found or not approved' });
    }
    const rec = recs[0];
    // Apply designation and grade change to employee
    await client.query(
      `UPDATE employees SET
         designation  = COALESCE($2, designation),
         grade        = COALESCE($3, grade),
         department   = COALESCE($4, department),
         updated_at   = NOW()
       WHERE id = $1`,
      [rec.employee_id,
       rec.proposed_designation || null,
       rec.proposed_grade || null,
       rec.proposed_department || null]
    );
    // Mark recommendation as processed
    await client.query(
      `UPDATE promotion_recommendations SET
         status           = 'processed',
         grade_updated    = TRUE,
         grade_updated_at = NOW(),
         updated_at       = NOW()
       WHERE id = $1`,
      [req.params.id]
    );
    await client.query('COMMIT');
    res.json({ message: 'Promotion applied to employee record', employee_id: rec.employee_id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* GET /promotions/eligibility — employees eligible for promotion (HR only) */
router.get('/eligibility/check', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const { min_rating = 4, min_years_in_role = 2, cycle_id } = req.query;
  const params = [cid, parseFloat(min_rating)];
  let reviewFilter = '';
  if (cycle_id) { params.push(cycle_id); reviewFilter = ` AND pr.review_cycle_id = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.id, e.name, e.department, e.designation, e.grade,
         e.joining_date AS date_of_joining,
         DATE_PART('year', AGE(NOW(), e.joining_date)) AS years_with_company,
         ROUND(AVG(COALESCE(pr.calibrated_rating, pr.final_rating))::numeric, 2) AS avg_rating,
         COUNT(pr.id)::int AS review_count,
         EXISTS(
           SELECT 1 FROM promotion_recommendations pm
           WHERE pm.employee_id = e.id AND pm.company_id = $1
             AND pm.status IN ('submitted','approved','processed')
         ) AS already_recommended
       FROM employees e
       JOIN performance_reviews pr ON pr.employee_id = e.id
         AND pr.status = 'completed' AND pr.deleted_at IS NULL${reviewFilter}
       WHERE e.company_id = $1 AND e.deleted_at IS NULL
       GROUP BY e.id, e.name, e.department, e.designation, e.grade, e.joining_date
       HAVING AVG(COALESCE(pr.calibrated_rating, pr.final_rating)) >= $2
       ORDER BY avg_rating DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
