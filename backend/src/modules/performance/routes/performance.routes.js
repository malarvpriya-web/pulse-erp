import express from 'express';
import performanceRepository from '../repositories/performance.repository.js';
import pool from '../../shared/db.js';
import { logAudit } from '../../../services/AuditService.js';

const router = express.Router();

/* ── helpers ───────────────────────────────────────────────────────── */
const cid = req => req.scope?.company_id ?? null;
const uid = req => req.user?.userId ?? req.user?.id ?? null;
const role = req => req.user?.role ?? 'employee';

const isManagerPlus = req => ['manager', 'hr', 'super_admin', 'admin'].includes(role(req));
const isHRPlus      = req => ['hr', 'super_admin', 'admin'].includes(role(req));

function forbidden(res, msg = 'Forbidden') { return res.status(403).json({ error: msg }); }

/* ── Current review for logged-in employee ── */
router.get('/review/current', async (req, res) => {
  try {
    const companyId  = cid(req);
    const employeeId = uid(req);
    const params = [];
    let where = 'WHERE pr.deleted_at IS NULL';
    if (companyId)  { params.push(companyId);  where += ` AND pr.company_id = $${params.length}`; }
    if (employeeId) { params.push(employeeId); where += ` AND pr.employee_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT pr.*,
         e.name  AS employee_name,
         m.name  AS manager_name,
         rc.name AS cycle_name,
         rc.start_date  AS cycle_start,
         rc.end_date    AS cycle_end,
         rc.self_review_deadline,
         rc.manager_review_deadline,
         rc.calibration_deadline
       FROM performance_reviews pr
       JOIN employees e ON pr.employee_id = e.id
       LEFT JOIN employees m ON pr.manager_id = m.id
       LEFT JOIN review_cycles rc ON pr.review_cycle_id = rc.id
       ${where}
       ORDER BY pr.created_at DESC LIMIT 1`,
      params
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Past review history ── */
router.get('/history', async (req, res) => {
  try {
    const { employee_id } = req.query;
    const companyId = cid(req);
    const callerRole = role(req);
    const params = [];
    let q = `SELECT pr.*,
               e.name AS employee_name,
               m.name AS manager_name,
               rc.name AS cycle_name
             FROM performance_reviews pr
             JOIN employees e ON pr.employee_id = e.id
             LEFT JOIN employees m ON pr.manager_id = m.id
             LEFT JOIN review_cycles rc ON pr.review_cycle_id = rc.id
             WHERE pr.deleted_at IS NULL AND pr.status = 'completed'`;
    if (companyId)  { params.push(companyId);  q += ` AND pr.company_id = $${params.length}`; }

    // Employees can only see their own history
    if (!isManagerPlus(req)) {
      params.push(uid(req)); q += ` AND pr.employee_id = $${params.length}`;
    } else if (employee_id) {
      params.push(employee_id); q += ` AND pr.employee_id = $${params.length}`;
    }
    q += ` ORDER BY pr.created_at DESC LIMIT 50`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Competency scores ── */
router.get('/competencies', async (req, res) => {
  try {
    const { review_id, employee_id } = req.query;
    const companyId = cid(req);
    const params = [];
    let q = `SELECT pc.*,
               COALESCE(cd.competency_type, 'general') AS competency_type,
               COALESCE(cd.expected_score, 3) AS expected_score
             FROM performance_competencies pc
             LEFT JOIN competency_definitions cd ON cd.name = pc.competency_name
               AND cd.company_id = pc.company_id
             WHERE TRUE`;
    if (companyId)   { params.push(companyId);   q += ` AND pc.company_id = $${params.length}`; }
    if (review_id)   { params.push(review_id);   q += ` AND pc.review_id = $${params.length}`; }
    if (employee_id) { params.push(employee_id); q += ` AND pc.employee_id = $${params.length}`; }
    q += ` ORDER BY pc.competency_name`;
    const { rows } = await pool.query(q, params);
    const shaped = rows.map(r => ({
      subject:        r.competency_name,
      self:           Number(r.self_score)     || 0,
      manager:        Number(r.manager_score)  || 0,
      expected:       Number(r.expected_score) || 3,
      gap:            Number(r.manager_score || r.self_score || 0) - Number(r.expected_score || 3),
      competency_type: r.competency_type,
      fullMark:       5,
    }));
    res.json(shaped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Save competency self-scores ── */
router.post('/competencies', async (req, res) => {
  try {
    const { review_id, employee_id, scores } = req.body;
    const companyId = cid(req);
    for (const s of scores || []) {
      await pool.query(
        `INSERT INTO performance_competencies
           (review_id, employee_id, competency_name, self_score, company_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (review_id, competency_name)
         DO UPDATE SET self_score=$4, updated_at=NOW()`,
        [review_id, employee_id, s.competency_name, s.self_score, companyId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Save competency manager-scores ── */
router.post('/competencies/manager', async (req, res) => {
  if (!isManagerPlus(req)) return forbidden(res);
  try {
    const { review_id, employee_id, scores } = req.body;
    const companyId = cid(req);
    for (const s of scores || []) {
      await pool.query(
        `INSERT INTO performance_competencies
           (review_id, employee_id, competency_name, manager_score, company_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (review_id, competency_name)
         DO UPDATE SET manager_score=$4, updated_at=NOW()`,
        [review_id, employee_id, s.competency_name, s.manager_score, companyId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Goal check-in ── */
router.post('/goals/:id/checkin', async (req, res) => {
  try {
    const { achieved_value, note } = req.body;
    const pct_q = await pool.query(
      `SELECT target_value FROM performance_goals WHERE id=$1`,
      [req.params.id]
    );
    const target = Number(pct_q.rows[0]?.target_value || 1);
    const pct    = Math.min(100, Math.round((Number(achieved_value) / target) * 100));
    const status = pct >= 100 ? 'achieved' : pct < 30 ? 'at_risk' : 'active';
    await pool.query(
      `UPDATE performance_goals
       SET achieved_value=$1, progress_pct=$2, status=$3, updated_at=NOW()
       WHERE id=$4`,
      [achieved_value, pct, status, req.params.id]
    );
    await pool.query(
      `INSERT INTO goal_checkins (goal_id, achieved_value, note, checked_in_by)
       VALUES ($1,$2,$3,$4)`,
      [req.params.id, achieved_value, note || null, uid(req)]
    );
    const { rows } = await pool.query(
      `SELECT * FROM performance_goals WHERE id=$1`, [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Delete goal (soft) ── */
router.delete('/goals/:id', async (req, res) => {
  try {
    const companyId = cid(req);
    const params    = [req.params.id];
    let q = `UPDATE performance_goals SET deleted_at=NOW() WHERE id=$1`;
    if (companyId) { params.push(companyId); q += ` AND company_id=$2`; }
    await pool.query(q, params);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Team members stats ── */
router.get('/team/members', async (req, res) => {
  if (!isManagerPlus(req)) return forbidden(res);
  try {
    const { department } = req.query;
    const companyId = cid(req);
    const params = [];
    let where = 'WHERE e.deleted_at IS NULL';
    if (companyId) { params.push(companyId); where += ` AND e.company_id = $${params.length}`; }
    if (department){ params.push(department); where += ` AND e.department = $${params.length}`; }
    const q = `
      SELECT
        e.id, e.name, e.department, e.designation, e.profile_picture,
        COUNT(DISTINCT pg.id) FILTER (WHERE pg.deleted_at IS NULL)                               AS total_goals,
        COUNT(DISTINCT pg.id) FILTER (WHERE pg.status='achieved' AND pg.deleted_at IS NULL)       AS achieved_goals,
        ROUND(AVG(pg.progress_pct) FILTER (WHERE pg.deleted_at IS NULL), 1)                       AS avg_goal_pct,
        pr.status         AS review_status,
        pr.self_rating,
        pr.manager_rating,
        pr.final_rating,
        pr.review_period,
        pr.id             AS review_id
      FROM employees e
      LEFT JOIN performance_goals pg ON e.id = pg.employee_id
      LEFT JOIN LATERAL (
        SELECT * FROM performance_reviews
        WHERE employee_id = e.id AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      ) pr ON TRUE
      ${where}
      GROUP BY e.id, e.name, e.department, e.designation, e.profile_picture,
               pr.status, pr.self_rating, pr.manager_rating, pr.final_rating,
               pr.review_period, pr.id
      ORDER BY e.name`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Self-review submit ── */
router.post('/reviews/:id/self-review', async (req, res) => {
  try {
    const companyId = cid(req);
    const { self_rating, self_comments, achievements, challenges, learnings, next_goals } = req.body;

    // RBAC: only the employee who owns the review can submit self-review
    const { rows: check } = await pool.query(
      `SELECT employee_id FROM performance_reviews WHERE id=$1${companyId ? ' AND company_id=$2' : ''}`,
      companyId ? [req.params.id, companyId] : [req.params.id]
    );
    if (!check.length) return res.status(404).json({ error: 'Review not found' });
    const callerRole = role(req);
    if (callerRole === 'employee' && String(check[0].employee_id) !== String(uid(req))) {
      return forbidden(res, 'You can only submit your own self-review');
    }

    const result = await pool.query(
      `UPDATE performance_reviews
       SET self_rating=$1, self_comments=$2, achievements=$3,
           challenges=$4, learnings=$5, next_goals=$6,
           self_submitted_at=NOW(), status='self_submitted', updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [self_rating, self_comments, achievements, challenges, learnings, next_goals, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Manager review submit ── */
router.post('/reviews/:id/manager-review', async (req, res) => {
  if (!isManagerPlus(req)) return forbidden(res);
  try {
    const { manager_rating, manager_comments, kra_score, behavioral_score,
            final_rating, promotion_recommendation, salary_revision_percentage } = req.body;
    const companyId = cid(req);

    const result = await pool.query(
      `UPDATE performance_reviews
       SET manager_id=$1, manager_rating=$2, manager_comments=$3,
           kra_score=$4, behavioral_score=$5,
           final_rating=$6,
           promotion_recommendation=$7,
           salary_revision_percentage=$8,
           manager_submitted_at=NOW(),
           status='manager_submitted', updated_at=NOW()
       WHERE id=$9${companyId ? ' AND company_id=$10' : ''} RETURNING *`,
      companyId
        ? [uid(req), manager_rating, manager_comments, kra_score || null,
           behavioral_score || null, final_rating, promotion_recommendation || false,
           salary_revision_percentage || 0, req.params.id, companyId]
        : [uid(req), manager_rating, manager_comments, kra_score || null,
           behavioral_score || null, final_rating, promotion_recommendation || false,
           salary_revision_percentage || 0, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Review not found' });

    // Auto-sync to talent_assessments
    const rev = result.rows[0];
    if (rev.final_rating) {
      await pool.query(
        `INSERT INTO talent_assessments (employee_id, performance_score, company_id, assessment_date)
         VALUES ($1,$2,$3,CURRENT_DATE)
         ON CONFLICT (employee_id) DO UPDATE
           SET performance_score = $2, assessment_date = CURRENT_DATE`,
        [rev.employee_id, rev.final_rating, companyId]
      );
    }
    res.json(rev);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── HR/L2 finalize review ── */
router.post('/reviews/:id/finalize', async (req, res) => {
  if (!isHRPlus(req)) return forbidden(res);
  try {
    const { calibrated_rating, hr_comments } = req.body;
    const companyId = cid(req);
    const result = await pool.query(
      `UPDATE performance_reviews
       SET calibrated_rating=$1, hr_comments=$2,
           hr_reviewer_id=$3, hr_submitted_at=NOW(),
           status='completed', updated_at=NOW()
       WHERE id=$4${companyId ? ' AND company_id=$5' : ''} RETURNING *`,
      companyId
        ? [calibrated_rating, hr_comments, uid(req), req.params.id, companyId]
        : [calibrated_rating, hr_comments, uid(req), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Review not found' });

    // Sync calibrated rating to succession
    const rev = result.rows[0];
    const finalForSuccession = calibrated_rating || rev.final_rating;
    if (finalForSuccession) {
      await pool.query(
        `INSERT INTO talent_assessments (employee_id, performance_score, company_id, assessment_date)
         VALUES ($1,$2,$3,CURRENT_DATE)
         ON CONFLICT (employee_id) DO UPDATE
           SET performance_score=$2, assessment_date=CURRENT_DATE`,
        [rev.employee_id, finalForSuccession, companyId]
      );
    }
    logAudit({ userId: uid(req), module: 'Performance', recordId: req.params.id, recordType: 'review', action: 'finalize', newData: rev, req });
    res.json(rev);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Goals ── */
router.get('/goals', async (req, res) => {
  try {
    const filters = { ...req.query, company_id: cid(req) };
    // Non-managers can only see their own goals
    if (!isManagerPlus(req)) filters.employee_id = uid(req);
    const goals = await performanceRepository.findGoals(filters);
    res.json(goals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/goals', async (req, res) => {
  try {
    const goal = await performanceRepository.createGoal({ ...req.body, company_id: cid(req) });
    res.status(201).json(goal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/goals/:id', async (req, res) => {
  try {
    const goal = await performanceRepository.updateGoal(req.params.id, req.body);
    res.json(goal);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ── Reviews ── */
router.get('/reviews', async (req, res) => {
  try {
    const filters = { ...req.query, company_id: cid(req) };
    if (!isManagerPlus(req)) filters.employee_id = uid(req);
    const reviews = await performanceRepository.findReviews(filters);
    res.json(reviews);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reviews/:id', async (req, res) => {
  try {
    const review = await performanceRepository.findReviewById(req.params.id, cid(req));
    if (!review) return res.status(404).json({ error: 'Review not found' });
    // Employees can only view their own review
    if (!isManagerPlus(req) && String(review.employee_id) !== String(uid(req))) {
      return forbidden(res);
    }
    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reviews', async (req, res) => {
  if (!isHRPlus(req)) return forbidden(res, 'Only HR can create reviews');
  try {
    const review = await performanceRepository.createReview({ ...req.body, company_id: cid(req) });
    res.status(201).json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/reviews/:id', async (req, res) => {
  if (!isHRPlus(req)) return forbidden(res);
  try {
    const review = await performanceRepository.updateReview(req.params.id, req.body);
    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ── Analytics ── */
router.get('/analytics/top-performers', async (req, res) => {
  if (!isManagerPlus(req)) return forbidden(res);
  try {
    const performers = await performanceRepository.getTopPerformers(req.query.limit || 10, cid(req));
    res.json(performers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/department-performance', async (req, res) => {
  if (!isManagerPlus(req)) return forbidden(res);
  try {
    const data = await performanceRepository.getDepartmentPerformance(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/goal-completion', async (req, res) => {
  if (!isManagerPlus(req)) return forbidden(res);
  try {
    const data = await performanceRepository.getGoalCompletionRate(cid(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ── Rating distribution (bell curve data) ── */
router.get('/analytics/rating-distribution', async (req, res) => {
  if (!isManagerPlus(req)) return forbidden(res);
  try {
    const companyId = cid(req);
    const { cycle_id, department } = req.query;
    const params = [];
    let where = `WHERE pr.status = 'completed' AND pr.deleted_at IS NULL`;
    if (companyId)  { params.push(companyId);  where += ` AND pr.company_id=$${params.length}`; }
    if (cycle_id)   { params.push(cycle_id);   where += ` AND pr.review_cycle_id=$${params.length}`; }
    if (department) { params.push(department); where += ` AND e.department=$${params.length}`; }

    const { rows } = await pool.query(`
      SELECT
        ROUND(COALESCE(pr.calibrated_rating, pr.final_rating)) AS rating_band,
        COUNT(*)::int AS employee_count,
        ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS pct,
        array_agg(e.name ORDER BY e.name) AS employees
      FROM performance_reviews pr
      JOIN employees e ON e.id = pr.employee_id
      ${where}
      GROUP BY ROUND(COALESCE(pr.calibrated_rating, pr.final_rating))
      ORDER BY rating_band DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Dashboard summary (HR) ── */
router.get('/analytics/dashboard', async (req, res) => {
  if (!isManagerPlus(req)) return forbidden(res);
  try {
    const companyId = cid(req);
    const params = [];
    const cWhere = companyId ? `AND company_id=$${(params.push(companyId), params.length)}` : '';

    const [totals, goalStats, topPerf, pending] = await Promise.allSettled([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='completed')::int AS completed,
          COUNT(*) FILTER (WHERE status='self_submitted' OR status='manager_submitted')::int AS in_progress,
          COUNT(*) FILTER (WHERE status='draft')::int AS not_started,
          COUNT(*)::int AS total,
          ROUND(AVG(COALESCE(calibrated_rating, final_rating)),2) AS avg_rating
        FROM performance_reviews
        WHERE deleted_at IS NULL ${cWhere}`, params),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='achieved')::int AS achieved,
          COUNT(*) FILTER (WHERE status='at_risk')::int AS at_risk,
          COUNT(*) FILTER (WHERE status='overdue')::int AS overdue,
          COUNT(*) FILTER (WHERE status='active')::int  AS active,
          COUNT(*)::int AS total
        FROM performance_goals
        WHERE deleted_at IS NULL ${cWhere}`, params),
      performanceRepository.getTopPerformers(5, companyId),
      pool.query(`
        SELECT COUNT(*)::int AS pending_self,
               COUNT(*) FILTER (WHERE status='self_submitted')::int AS pending_manager
        FROM performance_reviews
        WHERE status IN ('draft','self_submitted') AND deleted_at IS NULL ${cWhere}`, params),
    ]);

    res.json({
      reviews:     totals.value?.rows[0]  || {},
      goals:       goalStats.value?.rows[0] || {},
      top_performers: topPerf.value        || [],
      pending:     pending.value?.rows[0]  || {},
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
