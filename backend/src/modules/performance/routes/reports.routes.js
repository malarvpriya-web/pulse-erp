import express from 'express';
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

const role   = req => req.user?.role ?? 'employee';
const getCid = req => req.scope?.company_id ?? companyOf(req);
const isHR   = req => ['hr', 'super_admin', 'admin'].includes(role(req));
const isMgr  = req => ['manager', 'hr', 'super_admin', 'admin'].includes(role(req));

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

function sendReport(res, rows, filename, format) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(toCSV(rows));
  }
  res.json(rows);
}

/* ── 1. Performance Summary Report ────────────────────────────────────────── */
router.get('/summary', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id, department, format } = req.query;
  const params = [cid];
  let where = 'WHERE pr.company_id = $1 AND pr.deleted_at IS NULL';
  if (cycle_id)   { params.push(cycle_id);   where += ` AND pr.review_cycle_id = $${params.length}`; }
  if (department) { params.push(department); where += ` AND e.department = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.employee_code, e.name AS employee_name, e.department, e.designation,
         e.grade, e.date_of_joining,
         pr.review_period, pr.review_type,
         pr.self_rating, pr.manager_rating, pr.final_rating,
         pr.calibrated_rating,
         COALESCE(pr.calibrated_rating, pr.final_rating) AS effective_rating,
         pr.kra_score, pr.behavioral_score,
         pr.promotion_recommendation, pr.salary_revision_percentage,
         pr.pip_recommended, pr.status,
         m.name AS manager_name,
         rc.name AS cycle_name
       FROM performance_reviews pr
       JOIN employees e ON e.id = pr.employee_id
       LEFT JOIN employees m ON m.id = pr.manager_id
       LEFT JOIN review_cycles rc ON rc.id = pr.review_cycle_id
       ${where}
       ORDER BY e.department, e.name`,
      params
    );
    sendReport(res, rows, 'performance_summary', format || 'json');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 2. Pending Reviews Report ────────────────────────────────────────────── */
router.get('/pending', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id, format } = req.query;
  const params = [cid];
  let extra = '';
  if (cycle_id) { params.push(cycle_id); extra = ` AND pr.review_cycle_id = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.employee_code, e.name AS employee_name, e.department, e.designation,
         pr.review_period, pr.status,
         CASE WHEN pr.self_rating IS NOT NULL THEN 'Done' ELSE 'Pending' END AS self_review,
         CASE WHEN pr.manager_rating IS NOT NULL THEN 'Done' ELSE 'Pending' END AS manager_review,
         m.name AS manager_name,
         rc.name AS cycle_name,
         rc.manager_review_deadline
       FROM performance_reviews pr
       JOIN employees e ON e.id = pr.employee_id
       LEFT JOIN employees m ON m.id = pr.manager_id
       LEFT JOIN review_cycles rc ON rc.id = pr.review_cycle_id
       WHERE pr.company_id = $1 AND pr.deleted_at IS NULL
         AND pr.status NOT IN ('completed','calibrated')${extra}
       ORDER BY e.department, m.name, e.name`,
      params
    );
    sendReport(res, rows, 'pending_reviews', format || 'json');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 3. Rating Distribution Report ──────────────────────────────────────── */
router.get('/rating-distribution', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id, department, format } = req.query;
  const params = [cid];
  let where = 'WHERE pr.company_id = $1 AND pr.deleted_at IS NULL AND pr.status IN (\'completed\',\'calibrated\')';
  if (cycle_id)   { params.push(cycle_id);   where += ` AND pr.review_cycle_id = $${params.length}`; }
  if (department) { params.push(department); where += ` AND e.department = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.department,
         CASE
           WHEN COALESCE(pr.calibrated_rating, pr.final_rating) >= 4.5 THEN 'Outstanding (4.5-5.0)'
           WHEN COALESCE(pr.calibrated_rating, pr.final_rating) >= 3.5 THEN 'Exceeds (3.5-4.4)'
           WHEN COALESCE(pr.calibrated_rating, pr.final_rating) >= 2.5 THEN 'Meets (2.5-3.4)'
           WHEN COALESCE(pr.calibrated_rating, pr.final_rating) >= 1.5 THEN 'Below (1.5-2.4)'
           ELSE 'Unsatisfactory (<1.5)'
         END AS rating_category,
         COALESCE(pr.calibrated_rating, pr.final_rating) AS rating,
         e.employee_code, e.name AS employee_name, e.designation
       FROM performance_reviews pr
       JOIN employees e ON e.id = pr.employee_id
       ${where}
         AND COALESCE(pr.calibrated_rating, pr.final_rating) IS NOT NULL
       ORDER BY e.department, rating DESC`,
      params
    );
    sendReport(res, rows, 'rating_distribution', format || 'json');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 4. Increment Planning Report ────────────────────────────────────────── */
router.get('/increments', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const { cycle_id, department, format } = req.query;
  const params = [cid];
  let where = 'WHERE ir.company_id = $1';
  if (cycle_id)   { params.push(cycle_id);   where += ` AND ir.cycle_id = $${params.length}`; }
  if (department) { params.push(department); where += ` AND e.department = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.employee_code, e.name AS employee_name, e.department, e.designation, e.grade,
         ir.current_ctc,
         ir.recommended_increment_pct, ir.recommended_new_ctc,
         ir.final_increment_pct, ir.final_new_ctc,
         ir.effective_date, ir.justification, ir.status,
         COALESCE(ir.final_increment_pct, ir.recommended_increment_pct) AS increment_pct,
         COALESCE(ir.final_new_ctc, ir.recommended_new_ctc) AS new_ctc,
         apv.name AS approved_by_name
       FROM increment_recommendations ir
       JOIN employees e ON e.id = ir.employee_id
       LEFT JOIN employees apv ON apv.id = ir.approved_by
       ${where}
       ORDER BY e.department, e.name`,
      params
    );
    sendReport(res, rows, 'increment_recommendations', format || 'json');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 5. Promotion Pipeline Report ────────────────────────────────────────── */
router.get('/promotions', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const { cycle_id, department, format } = req.query;
  const params = [cid];
  let where = 'WHERE pm.company_id = $1';
  if (cycle_id)   { params.push(cycle_id);   where += ` AND pm.cycle_id = $${params.length}`; }
  if (department) { params.push(department); where += ` AND e.department = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.employee_code, e.name AS employee_name, e.department,
         pm.current_designation, pm.proposed_designation,
         pm.current_grade, pm.proposed_grade,
         pm.years_in_role, pm.performance_rating,
         pm.effective_date, pm.justification, pm.status,
         sub.name AS submitted_by_name, apv.name AS approved_by_name
       FROM promotion_recommendations pm
       JOIN employees e ON e.id = pm.employee_id
       LEFT JOIN employees sub ON sub.id = pm.submitted_by
       LEFT JOIN employees apv ON apv.id = pm.approved_by
       ${where}
       ORDER BY e.department, e.name`,
      params
    );
    sendReport(res, rows, 'promotion_pipeline', format || 'json');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 6. Goal Completion Report ───────────────────────────────────────────── */
router.get('/goals', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id, department, format } = req.query;
  const params = [cid];
  let where = 'WHERE pg.company_id = $1 AND pg.deleted_at IS NULL';
  if (cycle_id)   { params.push(cycle_id);   where += ` AND pg.cycle_id = $${params.length}`; }
  if (department) { params.push(department); where += ` AND e.department = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.employee_code, e.name AS employee_name, e.department,
         pg.goal_title, pg.goal_type, pg.category,
         pg.target_value, pg.achieved_value, pg.unit,
         pg.status, pg.progress_pct, pg.weightage,
         pg.due_date, pg.review_period
       FROM performance_goals pg
       JOIN employees e ON e.id = pg.employee_id
       ${where}
       ORDER BY e.department, e.name, pg.goal_title`,
      params
    );
    sendReport(res, rows, 'goal_completion', format || 'json');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 7. KRA Score Report ────────────────────────────────────────────────── */
router.get('/kra-scores', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id, department, format } = req.query;
  const params = [cid];
  let where = 'WHERE ek.company_id = $1';
  if (cycle_id)   { params.push(cycle_id);   where += ` AND ek.cycle_id = $${params.length}`; }
  if (department) { params.push(department); where += ` AND e.department = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.employee_code, e.name AS employee_name, e.department, e.designation,
         COALESCE(ek.custom_name, kd.name) AS kra_name,
         ek.weightage, ek.target, ek.self_score, ek.manager_score, ek.final_score,
         ek.evidence
       FROM employee_kras ek
       JOIN employees e ON e.id = ek.employee_id
       LEFT JOIN kra_definitions kd ON kd.id = ek.kra_id
       ${where}
       ORDER BY e.department, e.name`,
      params
    );
    sendReport(res, rows, 'kra_scores', format || 'json');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 8. 360 Feedback Summary ────────────────────────────────────────────── */
router.get('/feedback360', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const { cycle_id, format } = req.query;
  const params = [cid];
  let extra = '';
  if (cycle_id) { params.push(cycle_id); extra = ` AND pf.cycle_id = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.employee_code, e.name AS employee_name, e.department,
         COUNT(pf.id)::int AS total_requested,
         COUNT(*) FILTER (WHERE pf.status = 'submitted')::int AS submitted,
         COUNT(*) FILTER (WHERE pf.status = 'pending')::int AS pending,
         ROUND(AVG(pf.overall_score) FILTER (WHERE pf.status='submitted')::numeric, 2) AS avg_score
       FROM employees e
       LEFT JOIN performance_feedback pf ON pf.employee_id = e.id
         AND pf.company_id = $1${extra}
       WHERE e.company_id = $1 AND e.deleted_at IS NULL
       GROUP BY e.employee_code, e.name, e.department
       HAVING COUNT(pf.id) > 0
       ORDER BY e.department, e.name`,
      params
    );
    sendReport(res, rows, '360_feedback_summary', format || 'json');
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
