import express from 'express';
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

const role   = req => req.user?.role ?? 'employee';
const getCid = req => req.scope?.company_id ?? companyOf(req);
const isHR   = req => ['hr', 'super_admin', 'admin'].includes(role(req));
const isMgr  = req => ['manager', 'hr', 'super_admin', 'admin'].includes(role(req));

/* GET /performance/feedback — list feedback requests for logged-in user */
router.get('/', async (req, res) => {
  const cid = getCid(req);
  const uid = req.user?.userId;
  const { as, review_id } = req.query;

  const params = [cid];
  let where = 'WHERE pf.company_id = $1';

  if (as === 'reviewer') {
    params.push(uid); where += ` AND pf.feedback_provider_id = $${params.length}`;
  } else if (as === 'reviewee' || !isHR(req)) {
    params.push(uid); where += ` AND pf.employee_id = $${params.length}`;
  }

  if (review_id) { params.push(review_id); where += ` AND pf.review_id = $${params.length}`; }

  try {
    const { rows } = await pool.query(
      `SELECT pf.*,
         e.name  AS employee_name,
         e.department,
         p.name  AS provider_name
       FROM performance_feedback pf
       JOIN employees e ON e.id = pf.employee_id
       LEFT JOIN employees p ON p.id = pf.feedback_provider_id
       ${where}
       ORDER BY pf.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST /performance/feedback — request 360 feedback */
router.post('/', async (req, res) => {
  if (!isMgr(req) && !isHR(req)) {
    return res.status(403).json({ error: 'Manager or HR access required to request feedback' });
  }
  const {
    employee_id, feedback_provider_id, review_id, cycle_id,
    relationship = 'peer', is_anonymous = false, due_date,
  } = req.body;
  if (!employee_id || !feedback_provider_id) {
    return res.status(400).json({ error: 'employee_id and feedback_provider_id required' });
  }
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO performance_feedback
         (employee_id, feedback_provider_id, review_id, cycle_id, company_id,
          relationship, is_anonymous, due_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [employee_id, feedback_provider_id, review_id || null, cycle_id || null, cid,
       relationship, is_anonymous, due_date || null]
    );
    if (!rows.length) return res.status(409).json({ error: 'Feedback request already exists' });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* PATCH /performance/feedback/:id/submit — provider submits feedback */
router.patch('/:id/submit', async (req, res) => {
  const cid = getCid(req);
  const uid = req.user?.userId;
  const { overall_score, feedback_text, strengths, improvements } = req.body;
  if (!overall_score) return res.status(400).json({ error: 'overall_score required' });
  try {
    const check = await pool.query(
      'SELECT * FROM performance_feedback WHERE id = $1 AND company_id = $2',
      [req.params.id, cid]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Feedback not found' });
    const fb = check.rows[0];
    if (String(fb.feedback_provider_id) !== String(uid) && !isHR(req)) {
      return res.status(403).json({ error: 'You can only submit your own feedback' });
    }
    const { rows } = await pool.query(
      `UPDATE performance_feedback SET
         overall_score  = $2,
         feedback_text  = COALESCE($3, feedback_text),
         strengths      = COALESCE($4, strengths),
         improvements   = COALESCE($5, improvements),
         status         = 'submitted',
         submitted_at   = NOW(),
         updated_at     = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, overall_score, feedback_text ?? null, strengths ?? null, improvements ?? null]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* PATCH /performance/feedback/:id/decline */
router.patch('/:id/decline', async (req, res) => {
  const cid = getCid(req);
  const uid = req.user?.userId;
  try {
    const { rows } = await pool.query(
      `UPDATE performance_feedback SET status = 'declined', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND feedback_provider_id = $3 RETURNING *`,
      [req.params.id, cid, uid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Feedback not found or unauthorized' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /performance/feedback/aggregate/:employeeId — aggregated results (HR/manager only) */
router.get('/aggregate/:employeeId', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id, min_submissions = 3 } = req.query;
  const params = [req.params.employeeId, cid];
  let extra = '';
  if (cycle_id) { params.push(cycle_id); extra = ` AND cycle_id = $${params.length}`; }
  try {
    const [submitted, byRelationship] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total_requested,
           COUNT(*) FILTER (WHERE status = 'submitted')::int AS total_submitted,
           ROUND(AVG(overall_score) FILTER (WHERE status = 'submitted')::numeric, 2) AS avg_score
         FROM performance_feedback
         WHERE employee_id = $1 AND company_id = $2${extra}`,
        params
      ),
      pool.query(
        `SELECT
           relationship,
           COUNT(*)::int AS count,
           ROUND(AVG(overall_score)::numeric, 2) AS avg_score
         FROM performance_feedback
         WHERE employee_id = $1 AND company_id = $2 AND status = 'submitted'${extra}
         GROUP BY relationship`,
        params
      ),
    ]);

    const summary = submitted.rows[0];
    const byRel   = byRelationship.rows;

    // Apply anonymity threshold: only show feedback_text if >= min_submissions
    let feedback_comments = [];
    if (parseInt(summary.total_submitted) >= parseInt(min_submissions)) {
      const { rows: comments } = await pool.query(
        `SELECT
           CASE WHEN is_anonymous THEN NULL ELSE provider_name END AS reviewer,
           relationship,
           feedback_text, strengths, improvements, overall_score
         FROM performance_feedback pf
         LEFT JOIN employees e ON e.id = pf.feedback_provider_id
         WHERE pf.employee_id = $1 AND pf.company_id = $2 AND pf.status = 'submitted'${extra}`,
        params
      );
      feedback_comments = comments;
    }

    res.json({
      ...summary,
      by_relationship: byRel,
      feedback_comments,
      anonymity_threshold_met: parseInt(summary.total_submitted) >= parseInt(min_submissions),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* DELETE /performance/feedback/:id — HR only */
router.delete('/:id', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  try {
    await pool.query(
      'DELETE FROM performance_feedback WHERE id = $1 AND company_id = $2 AND status = \'pending\'',
      [req.params.id, cid]
    );
    res.json({ message: 'Feedback request cancelled' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
