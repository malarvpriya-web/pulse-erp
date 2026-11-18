import express from 'express';
import pool from '../../../config/db.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { captureBefore } from '../../../middlewares/captureBefore.js';
import { hasRole } from '../../../middlewares/auth.middleware.js';

const router = express.Router();

/*
 * 2026-11-11. performance_feedback.employee_id and .feedback_provider_id are
 * employees.id values, but every check here compared them with req.user.userId
 * (the LOGIN id) — so nobody ever saw feedback about themselves or to give, and
 * no provider could submit or decline. Ids are now the caller's linked employee
 * (employeeOf). Roles are every role held (hasRole), not the primary one. And an
 * anonymous provider's name is no longer sent to the person being reviewed.
 */
const getCid = req => req.scope?.company_id ?? companyOf(req);
const isHR   = req => hasRole(req, 'hr', 'hr_manager', 'super_admin', 'admin');
const isMgr  = req => hasRole(req, 'manager', 'department_head', 'hr', 'hr_manager', 'super_admin', 'admin');

/* GET /performance/feedback — list feedback requests for logged-in user */
router.get('/', async (req, res) => {
  const cid = getCid(req);
  const { as, review_id } = req.query;

  try {
    const me = await employeeOf(req, pool);
    const params = [cid];
    let where = 'WHERE pf.company_id = $1';
    // Seeing someone else's feedback (no `as`) is HR's; everyone else is
    // limited to their own, as giver or as the person reviewed.
    const asGiver = as === 'reviewer';
    const asReviewee = as === 'reviewee' || (!asGiver && !isHR(req));
    if (asGiver || asReviewee) {
      if (me == null) return res.json([]);
      params.push(me);
      where += asGiver ? ` AND pf.feedback_provider_id = $${params.length}` : ` AND pf.employee_id = $${params.length}`;
    }
    if (review_id) { params.push(review_id); where += ` AND pf.review_id = $${params.length}`; }

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
    // The person reviewed never learns who gave anonymous feedback.
    if (asReviewee) {
      for (const r of rows) if (r.is_anonymous) { r.provider_name = null; r.feedback_provider_id = null; }
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* GET /performance/feedback/people — who can be asked for feedback.
 * Names only (no contact details), for HR and for anyone who manages someone —
 * the people allowed to request feedback (POST below). */
router.get('/people', async (req, res) => {
  const cid = getCid(req);
  try {
    const me = await employeeOf(req, pool);
    if (!isHR(req)) {
      const { rows } = me == null ? { rows: [] } : await pool.query(
        'SELECT 1 FROM employees WHERE reporting_manager_id = $1 AND deleted_at IS NULL LIMIT 1', [me]);
      if (!rows.length) return res.status(403).json({ error: "Only managers and HR request feedback" });
    }
    const { rows } = await pool.query(
      `SELECT id, name, designation, department, reporting_manager_id FROM employees
        WHERE company_id = $1 AND deleted_at IS NULL ORDER BY name`, [cid]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* POST /performance/feedback — request 360 feedback */
router.post('/', async (req, res) => {
  const {
    employee_id, feedback_provider_id, review_id, cycle_id,
    relationship = 'peer', is_anonymous = false, due_date,
  } = req.body;
  if (!employee_id || !feedback_provider_id) {
    return res.status(400).json({ error: 'employee_id and feedback_provider_id required' });
  }
  const cid = getCid(req);
  try {
    // Who may ask: HR, or the employee's reporting manager (2026-11-11 — a
    // team lead on the plain employee role could not ask for feedback on their
    // own report). Both people must be employees of this company; asking
    // someone for feedback about themselves is a 'self' request only.
    const { rows: people } = await pool.query(
      `SELECT id, reporting_manager_id FROM employees
        WHERE id = ANY($1::int[]) AND deleted_at IS NULL AND company_id = $2`,
      [[Number(employee_id), Number(feedback_provider_id)], cid]);
    const about = people.find(p => String(p.id) === String(employee_id));
    if (!about || !people.some(p => String(p.id) === String(feedback_provider_id))) {
      return res.status(400).json({ error: 'Both people must be employees of this company' });
    }
    const me = await employeeOf(req, pool);
    const theirManager = me != null && String(about.reporting_manager_id) === String(me);
    if (!isHR(req) && !theirManager) {
      return res.status(403).json({ error: "Only the employee's manager or HR can request feedback on them" });
    }
    if ((String(employee_id) === String(feedback_provider_id)) !== (relationship === 'self')) {
      return res.status(400).json({ error: "Use relationship 'self' exactly when the employee reviews themselves" });
    }
    // The table has no unique key, so ON CONFLICT below never fired and the
    // same request could be made twice.
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM performance_feedback
        WHERE employee_id = $1 AND feedback_provider_id = $2 AND company_id = $3 AND status = 'pending'
          AND cycle_id IS NOT DISTINCT FROM $4::int`,
      [employee_id, feedback_provider_id, cid, cycle_id || null]);
    if (dup.length) return res.status(409).json({ error: 'This feedback has already been requested' });
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
router.patch('/:id/submit', captureBefore('performance_feedback'), async (req, res) => {
  const cid = getCid(req);
  const { overall_score, feedback_text, strengths, improvements } = req.body;
  if (!overall_score) return res.status(400).json({ error: 'overall_score required' });
  const score = Number(overall_score);
  if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: 'overall_score must be between 1 and 5' });
  try {
    const uid = await employeeOf(req, pool);
    const check = await pool.query(
      'SELECT * FROM performance_feedback WHERE id = $1 AND company_id = $2',
      [req.params.id, cid]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Feedback not found' });
    const fb = check.rows[0];
    if (String(fb.feedback_provider_id) !== String(uid) && !isHR(req)) {
      return res.status(403).json({ error: 'You can only submit your own feedback' });
    }
    // The giver may correct submitted feedback until its appraisal cycle is
    // completed (owner, 2026-11-11); a declined request stays declined.
    if (fb.status === 'declined') {
      return res.status(409).json({ error: 'This request was declined' });
    }
    if (fb.status === 'submitted' && fb.cycle_id != null) {
      const { rows: [cy] } = await pool.query('SELECT status FROM review_cycles WHERE id = $1', [fb.cycle_id]);
      if (cy && ['completed', 'closed'].includes(String(cy.status).toLowerCase())) {
        return res.status(409).json({ error: 'This appraisal cycle is closed; the feedback can no longer be changed' });
      }
    }
    const { rows } = await pool.query(
      `UPDATE performance_feedback SET
         overall_score  = $2,
         feedback_text  = COALESCE($3, feedback_text),
         strengths      = COALESCE($4, strengths),
         improvements   = COALESCE($5, improvements),
         status         = 'submitted',
         submitted_at   = COALESCE(submitted_at, NOW()),
         updated_at     = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, overall_score, feedback_text ?? null, strengths ?? null, improvements ?? null]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* PATCH /performance/feedback/:id/decline */
router.patch('/:id/decline', captureBefore('performance_feedback'), async (req, res) => {
  const cid = getCid(req);
  try {
    const uid = await employeeOf(req, pool);
    const { rows } = await pool.query(
      `UPDATE performance_feedback SET status = 'declined', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND feedback_provider_id = $3 AND status = 'pending' RETURNING *`,
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
           CASE WHEN pf.is_anonymous THEN NULL ELSE e.name END AS reviewer,
           pf.relationship,
           pf.feedback_text, pf.strengths, pf.improvements, pf.overall_score
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
router.delete('/:id', captureBefore('performance_feedback'), async (req, res) => {
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
