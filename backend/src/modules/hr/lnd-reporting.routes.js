// backend/src/modules/hr/lnd-reporting.routes.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();
const cid = req => { const n = Number.parseInt(req.scope?.company_id, 10); return Number.isInteger(n) ? n : null; };

function sc(companyId, alias = '') {
  const col = alias ? `${alias}.company_id` : 'company_id';
  return companyId != null ? ` AND (${col} IS NULL OR ${col}=${companyId})` : '';
}

/* ── 1. Training Hours by Department ───────────────────────── */
router.get('/training-hours', async (req, res) => {
  const companyId = cid(req);
  const { fy_start, fy_end } = req.query;
  const dateFilter = fy_start && fy_end
    ? ` AND te.completion_date BETWEEN '${fy_start}' AND '${fy_end}'` : '';
  try {
    const { rows } = await pool.query(`
      SELECT e.department,
             COUNT(DISTINCT te.employee_id)               AS employees_trained,
             COUNT(DISTINCT te.id)                        AS enrollments,
             COALESCE(SUM(tp.duration_hours),0)           AS total_hours,
             ROUND(AVG(tp.duration_hours),1)              AS avg_hours_per_training
      FROM   training_enrollments te
      JOIN   employees e            ON e.id=te.employee_id
      JOIN   training_programs tp   ON tp.id=te.program_id AND tp.deleted_at IS NULL
      WHERE  te.status='completed'${sc(companyId,'te')}${dateFilter}
      GROUP  BY e.department ORDER BY total_hours DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 2. Completion Rate by Program ─────────────────────────── */
router.get('/completion-rates', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT tp.id, tp.title, tp.category, tp.mode, tp.scheduled_date,
             COUNT(te.id)                                               AS total_enrolled,
             COUNT(CASE WHEN te.status='completed' THEN 1 END)         AS completed,
             COUNT(CASE WHEN te.status='in_progress' THEN 1 END)       AS in_progress,
             COUNT(CASE WHEN te.status='not_started' THEN 1 END)       AS not_started,
             ROUND(100.0*COUNT(CASE WHEN te.status='completed' THEN 1 END)
               /NULLIF(COUNT(te.id),0),1)                              AS completion_pct
      FROM   training_programs tp
      LEFT JOIN training_enrollments te ON te.program_id=tp.id${sc(companyId,'te')}
      WHERE  tp.deleted_at IS NULL${sc(companyId,'tp')}
      GROUP  BY tp.id ORDER BY completion_pct DESC NULLS LAST`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 3. Certification Status Report ───────────────────────── */
router.get('/certification-status', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT c.name AS certification, c.category, c.is_mandatory,
             COUNT(ec.id)                                           AS total_issued,
             COUNT(CASE WHEN ec.status='active' THEN 1 END)        AS active,
             COUNT(CASE WHEN ec.status='expired' THEN 1 END)       AS expired,
             COUNT(CASE WHEN ec.expiry_date <= CURRENT_DATE+30
                        AND ec.status='active' THEN 1 END)         AS expiring_30d
      FROM   certifications c
      LEFT JOIN employee_certifications ec ON ec.certification_id=c.id${sc(companyId,'ec')}
      WHERE  1=1${sc(companyId,'c')}
      GROUP  BY c.id ORDER BY c.is_mandatory DESC, c.name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 4. Skill Gap by Department ─────────────────────────────── */
router.get('/skill-gap/department', async (req, res) => {
  const companyId = cid(req);
  const { department } = req.query;
  const deptFilter = department ? ` AND e.department='${department.replace(/'/g,"''")}'` : '';
  try {
    const { rows } = await pool.query(`
      SELECT e.department, sm.skill_name, sm.category,
             ROUND(AVG(sm.proficiency_level),1)   AS avg_proficiency,
             COUNT(sm.id)                         AS employees_with_skill,
             COUNT(DISTINCT e.id)                 AS total_employees,
             COUNT(CASE WHEN sm.proficiency_level < 3 THEN 1 END) AS below_target
      FROM   employees e
      LEFT JOIN skill_matrix sm ON sm.employee_id=e.id${sc(companyId,'sm')}
      WHERE  e.status='active'${deptFilter}
      GROUP  BY e.department, sm.skill_name, sm.category
      HAVING sm.skill_name IS NOT NULL
      ORDER  BY e.department, avg_proficiency ASC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 5. Skill Gap by Role/Designation ──────────────────────── */
router.get('/skill-gap/role', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT e.designation AS role, sm.skill_name,
             ROUND(AVG(sm.proficiency_level),1)   AS avg_proficiency,
             COUNT(sm.id)                         AS employee_count,
             COUNT(CASE WHEN sm.proficiency_level < 3 THEN 1 END) AS below_target
      FROM   employees e
      JOIN   skill_matrix sm ON sm.employee_id=e.id${sc(companyId,'sm')}
      WHERE  e.status='active'
      GROUP  BY e.designation, sm.skill_name
      ORDER  BY e.designation, avg_proficiency ASC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 6. Assessment Results Summary ──────────────────────────── */
router.get('/assessment-results', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT a.id, a.title AS assessment,
             tp.title AS program, a.pass_score,
             COUNT(aa.id)                                           AS total_attempts,
             COUNT(DISTINCT aa.employee_id)                        AS unique_takers,
             COUNT(CASE WHEN aa.passed THEN 1 END)                 AS passed,
             ROUND(100.0*COUNT(CASE WHEN aa.passed THEN 1 END)
               /NULLIF(COUNT(aa.id),0),1)                         AS pass_rate_pct,
             ROUND(AVG(aa.score_pct),1)                           AS avg_score
      FROM   assessments a
      LEFT JOIN training_programs tp ON tp.id=a.program_id
      LEFT JOIN assessment_attempts aa ON aa.assessment_id=a.id
                AND aa.submitted_at IS NOT NULL${sc(companyId,'aa')}
      WHERE  a.is_active=true${sc(companyId,'a')}
      GROUP  BY a.id, tp.title ORDER BY pass_rate_pct ASC NULLS LAST`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 7. Overdue Training ─────────────────────────────────────── */
router.get('/overdue-training', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT te.id, e.name AS employee_name, e.department, e.designation,
             tp.title AS program, tp.scheduled_date, tp.is_mandatory,
             te.status, (CURRENT_DATE - tp.scheduled_date) AS days_overdue
      FROM   training_enrollments te
      JOIN   employees e           ON e.id=te.employee_id
      JOIN   training_programs tp  ON tp.id=te.program_id AND tp.deleted_at IS NULL
      WHERE  te.status IN ('not_started','in_progress')
        AND  tp.scheduled_date < CURRENT_DATE${sc(companyId,'te')}
      ORDER  BY tp.is_mandatory DESC, days_overdue DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 8. Budget vs Actual ────────────────────────────────────── */
router.get('/budget-vs-actual', async (req, res) => {
  const companyId = cid(req);
  const { fy_start, fy_end } = req.query;
  const dateFilter = fy_start && fy_end ? ` AND tc.cost_date BETWEEN '${fy_start}' AND '${fy_end}'` : '';
  try {
    const { rows } = await pool.query(`
      SELECT tp.category,
             COALESCE(SUM(tp.budget),0)                           AS budgeted,
             COALESCE(SUM(tc.amount),0)                           AS actual,
             COALESCE(SUM(tp.budget),0) - COALESCE(SUM(tc.amount),0) AS variance,
             COUNT(DISTINCT tp.id)                                AS programs
      FROM   training_programs tp
      LEFT JOIN training_costs tc ON tc.program_id=tp.id${dateFilter}
      WHERE  tp.deleted_at IS NULL${sc(companyId,'tp')}
      GROUP  BY tp.category ORDER BY actual DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 9. Training ROI ────────────────────────────────────────── */
router.get('/training-roi', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT tp.id, tp.title, tp.category,
             COALESCE(SUM(tc.amount),0)                               AS total_cost,
             COUNT(te.id)                                             AS enrollments,
             COUNT(CASE WHEN te.status='completed' THEN 1 END)       AS completions,
             ROUND(AVG(te.feedback_rating),1)                        AS avg_satisfaction,
             ROUND(COALESCE(SUM(tc.amount),0)
               /NULLIF(COUNT(CASE WHEN te.status='completed' THEN 1 END),0),0) AS cost_per_completion
      FROM   training_programs tp
      LEFT JOIN training_costs tc ON tc.program_id=tp.id
      LEFT JOIN training_enrollments te ON te.program_id=tp.id${sc(companyId,'te')}
      WHERE  tp.deleted_at IS NULL${sc(companyId,'tp')}
      GROUP  BY tp.id ORDER BY avg_satisfaction DESC NULLS LAST`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 10. Trainer Effectiveness ─────────────────────────────── */
router.get('/trainer-effectiveness', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name AS trainer, t.trainer_type, t.specialization,
             COUNT(DISTINCT tp.id)                                  AS programs_delivered,
             COUNT(DISTINCT te.employee_id)                        AS employees_trained,
             ROUND(AVG(te.feedback_rating),2)                     AS avg_rating,
             COUNT(CASE WHEN te.status='completed' THEN 1 END)    AS completions,
             ROUND(100.0*COUNT(CASE WHEN te.status='completed' THEN 1 END)
               /NULLIF(COUNT(te.id),0),1)                         AS completion_pct
      FROM   trainers t
      JOIN   training_programs tp ON tp.trainer_id=t.id AND tp.deleted_at IS NULL${sc(companyId,'tp')}
      LEFT JOIN training_enrollments te ON te.program_id=tp.id${sc(companyId,'te')}
      WHERE  t.is_active=true
      GROUP  BY t.id ORDER BY avg_rating DESC NULLS LAST`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 11. Mandatory Compliance ──────────────────────────────── */
router.get('/mandatory-compliance', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT tp.id, tp.title, tp.category,
             COUNT(DISTINCT e.id)                                         AS total_employees,
             COUNT(DISTINCT CASE WHEN te.status='completed' THEN e.id END) AS compliant,
             COUNT(DISTINCT CASE WHEN te.status!='completed' OR te.id IS NULL THEN e.id END) AS non_compliant,
             ROUND(100.0*COUNT(DISTINCT CASE WHEN te.status='completed' THEN e.id END)
               /NULLIF(COUNT(DISTINCT e.id),0),1)                        AS compliance_pct
      FROM   training_programs tp
      CROSS JOIN employees e
      LEFT JOIN training_enrollments te ON te.program_id=tp.id AND te.employee_id=e.id
      WHERE  tp.is_mandatory=true AND tp.deleted_at IS NULL${sc(companyId,'tp')}
        AND  e.status='active'
      GROUP  BY tp.id ORDER BY compliance_pct ASC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 12. Employee Training History ─────────────────────────── */
router.get('/employee-history/:employee_id', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT te.*, tp.title, tp.category, tp.mode, tp.duration_hours,
             tp.is_mandatory, tp.trainer, t.name AS trainer_name_linked,
             aa.score_pct AS latest_score, aa.passed AS assessment_passed
      FROM   training_enrollments te
      JOIN   training_programs tp ON tp.id=te.program_id AND tp.deleted_at IS NULL
      LEFT JOIN trainers t ON t.id=tp.trainer_id
      LEFT JOIN LATERAL (
        SELECT score_pct, passed FROM assessment_attempts
        WHERE employee_id=$1 AND assessment_id IN (
          SELECT id FROM assessments WHERE program_id=tp.id)
        ORDER BY submitted_at DESC LIMIT 1
      ) aa ON true
      WHERE  te.employee_id=$1${sc(companyId,'te')}
      ORDER  BY te.enrollment_date DESC`, [req.params.employee_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 13. Learning Path Completion ──────────────────────────── */
router.get('/learning-path-completion', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT lp.id, lp.name AS path, lp.path_type, lp.target_role,
             COUNT(elp.id)                                                AS assigned,
             COUNT(CASE WHEN elp.status='completed' THEN 1 END)          AS completed,
             ROUND(100.0*COUNT(CASE WHEN elp.status='completed' THEN 1 END)
               /NULLIF(COUNT(elp.id),0),1)                               AS completion_pct,
             ROUND(AVG(
               100.0*COUNT(DISTINCT CASE WHEN te.status='completed' THEN lpi.id END)
               /NULLIF(COUNT(DISTINCT lpi.id),0)
             ),0)                                                         AS avg_progress_pct
      FROM   learning_paths lp
      LEFT JOIN employee_learning_paths elp ON elp.path_id=lp.id${sc(companyId,'elp')}
      LEFT JOIN learning_path_items lpi ON lpi.path_id=lp.id
      LEFT JOIN training_enrollments te ON te.program_id=lpi.program_id AND te.employee_id=elp.employee_id
      WHERE  lp.is_active=true${sc(companyId,'lp')}
      GROUP  BY lp.id ORDER BY completion_pct ASC NULLS LAST`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 14. Feedback & Satisfaction ───────────────────────────── */
router.get('/feedback-analysis', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT tp.category,
             COUNT(te.id)                                           AS total_completed,
             ROUND(AVG(te.feedback_rating),2)                      AS avg_rating,
             COUNT(CASE WHEN te.feedback_rating=5 THEN 1 END)      AS five_star,
             COUNT(CASE WHEN te.feedback_rating=4 THEN 1 END)      AS four_star,
             COUNT(CASE WHEN te.feedback_rating<=3 THEN 1 END)     AS low_rating,
             COUNT(CASE WHEN te.feedback_comments IS NOT NULL THEN 1 END) AS with_comments
      FROM   training_enrollments te
      JOIN   training_programs tp ON tp.id=te.program_id AND tp.deleted_at IS NULL${sc(companyId,'tp')}
      WHERE  te.status='completed' AND te.feedback_rating IS NOT NULL${sc(companyId,'te')}
      GROUP  BY tp.category ORDER BY avg_rating DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── 15. Competency Gap Summary ─────────────────────────────── */
router.get('/competency-gaps', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT cf.name AS competency, cf.category,
             e.department,
             ROUND(AVG(eca.assessed_level),1)                     AS avg_assessed,
             ROUND(AVG(eca.required_level),1)                     AS avg_required,
             ROUND(AVG(eca.required_level - eca.assessed_level),1) AS avg_gap,
             COUNT(CASE WHEN eca.required_level - eca.assessed_level > 1 THEN 1 END) AS critical_gaps
      FROM   employee_competency_assessments eca
      JOIN   competency_framework cf ON cf.id=eca.competency_id${sc(companyId,'cf')}
      JOIN   employees e ON e.id=eca.employee_id
      WHERE  eca.required_level > eca.assessed_level${sc(companyId,'eca')}
      GROUP  BY cf.name, cf.category, e.department
      ORDER  BY avg_gap DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
