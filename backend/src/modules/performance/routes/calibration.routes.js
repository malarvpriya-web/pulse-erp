import express from 'express';
import pool from '../../../config/db.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { captureBefore } from '../../../middlewares/captureBefore.js';
import { ratingProblem } from '../../../shared/ratings.js';
import { hasRole } from '../../../middlewares/auth.middleware.js';

const router = express.Router();

const getCid = req => req.scope?.company_id ?? companyOf(req);
// Over EVERY role the user holds (user_roles), as in performance.routes.js: the
// primary role alone ignored a secondary hr role, and hr_manager was in neither
// list. The boundary is unchanged: HR and administrators only (+ manager for
// the reads).
const HR_ROLES = ['hr', 'hr_manager', 'admin', 'super_admin'];
const isHR   = req => hasRole(req, HR_ROLES);
const isMgr  = req => hasRole(req, ['manager', ...HR_ROLES]);

/* ─── CALIBRATION SESSIONS ───────────────────────────────────────────────── */

router.get('/sessions', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id } = req.query;
  const params = [cid];
  let extra = '';
  if (cycle_id) { params.push(cycle_id); extra = ` AND cs.cycle_id = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT cs.*,
         e.name AS facilitator_name,
         (SELECT COUNT(*) FROM calibration_adjustments ca WHERE ca.session_id = cs.id)::int AS adjustment_count
       FROM calibration_sessions cs
       LEFT JOIN employees e ON e.id = cs.facilitator_id
       WHERE cs.company_id = $1${extra}
       ORDER BY cs.session_date DESC NULLS LAST, cs.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/sessions/:id', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  try {
    const [sessionRes, adjRes] = await Promise.all([
      pool.query(
        `SELECT cs.*, e.name AS facilitator_name
         FROM calibration_sessions cs
         LEFT JOIN employees e ON e.id = cs.facilitator_id
         WHERE cs.id = $1 AND cs.company_id = $2`,
        [req.params.id, cid]
      ),
      pool.query(
        `SELECT ca.*,
           emp.name AS employee_name, emp.department, emp.designation,
           adj.name AS adjusted_by_name
         FROM calibration_adjustments ca
         JOIN employees emp ON emp.id = ca.employee_id
         LEFT JOIN employees adj ON adj.id = ca.adjusted_by
         WHERE ca.session_id = $1
         ORDER BY ca.employee_id`,
        [req.params.id]
      ),
    ]);
    if (!sessionRes.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json({ ...sessionRes.rows[0], adjustments: adjRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sessions', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const {
    cycle_id, department, session_name, session_date,
    facilitator_id, notes, bell_curve_target,
  } = req.body;
  if (!session_name) return res.status(400).json({ error: 'session_name required' });
  const cid = getCid(req);
  if (cid == null) return res.status(403).json({ error: 'Calibration needs a company — this login has none' });
  // created_by references employees(id), not users(id): the caller's linked
  // employee, or NULL for a login with no employee record (admin@). The login
  // itself is in the audit log.
  const createdBy = await employeeOf(req, pool);
  try {
    const { rows } = await pool.query(
      `INSERT INTO calibration_sessions
         (company_id, cycle_id, department, session_name, session_date,
          facilitator_id, notes, bell_curve_target, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [cid, cycle_id || null, department || null, session_name,
       session_date || null, facilitator_id || null,
       notes || null,
       JSON.stringify(bell_curve_target || { bottom: 10, below_avg: 20, average: 40, above_avg: 20, top: 10 }),
       createdBy]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/sessions/:id', captureBefore('calibration_sessions'), async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const { session_name, session_date, status, notes, bell_curve_target } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE calibration_sessions SET
         session_name     = COALESCE($2, session_name),
         session_date     = COALESCE($3, session_date),
         status           = COALESCE($4, status),
         notes            = COALESCE($5, notes),
         bell_curve_target= COALESCE($6::jsonb, bell_curve_target),
         updated_at       = NOW()
       WHERE id = $1 AND company_id = $7 RETURNING *`,
      [req.params.id, session_name || null, session_date ?? null, status || null,
       notes ?? null, bell_curve_target ? JSON.stringify(bell_curve_target) : null, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── CALIBRATION ADJUSTMENTS ───────────────────────────────────────────── */

/*
 * Record (or revise) one review's rating in a calibration session, and write
 * the calibrated rating back to the review. Everything is checked before the
 * first write and runs in one transaction:
 *  - the session and the review are both the caller's company's, and the
 *    employee is the review's employee (they used to be keyed by id alone);
 *  - a completed session or a completed review is not adjusted (the review's
 *    rating was already synced to succession at finalize);
 *  - ratings are numeric(3,2): 1–5 with two decimals, refused rather than
 *    rounded by PostgreSQL;
 *  - adjusted_by / hr_reviewer_id reference employees: the caller's linked
 *    employee, or NULL for a login with no employee record (as in finalize).
 *    The login itself is in the audit log.
 * There is no unique index on (session_id, review_id), so the old ON CONFLICT
 * could never match and every call failed; the session row lock below
 * serialises adjustments instead.
 */
router.post('/sessions/:id/adjust', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  if (cid == null) return res.status(403).json({ error: 'Calibration needs a company — this login has none' });
  const { review_id, employee_id, original_rating, proposed_rating, final_rating, justification } = req.body;
  if (!review_id || !employee_id) {
    return res.status(400).json({ error: 'review_id and employee_id required' });
  }
  for (const [field, label] of [['original_rating', 'Original rating'], ['proposed_rating', 'Proposed rating'], ['final_rating', 'Final rating']]) {
    if (req.body[field] == null || req.body[field] === '') continue;
    const problem = ratingProblem(req.body[field], { label, decimals: 2 });
    if (problem) return res.status(400).json({ error: problem, code: 'INVALID_RATING', field });
  }
  const calibrated = (final_rating === '' ? null : final_rating) ?? (proposed_rating === '' ? null : proposed_rating) ?? null;
  const adjustedBy = await employeeOf(req, pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [session] } = await client.query(
      `SELECT id, status FROM calibration_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE`, [req.params.id, cid]);
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This calibration session is completed and can no longer be adjusted.', code: 'SESSION_COMPLETED' });
    }
    const { rows: [review] } = await client.query(
      `SELECT id, employee_id, status FROM performance_reviews
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL FOR UPDATE`, [review_id, cid]);
    if (!review) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Review not found' });
    }
    if (String(review.employee_id) !== String(employee_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'employee_id is not the employee of this review', code: 'EMPLOYEE_MISMATCH', field: 'employee_id' });
    }
    if (review.status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This review is completed and can no longer be calibrated.', code: 'REVIEW_COMPLETED' });
    }

    const { rows: [existing] } = await client.query(
      `SELECT id FROM calibration_adjustments WHERE session_id = $1 AND review_id = $2 AND company_id = $3
        ORDER BY id LIMIT 1`, [session.id, review.id, cid]);
    const { rows: adj } = existing
      ? await client.query(
        `UPDATE calibration_adjustments SET
           proposed_rating = $2, final_rating = $3, justification = $4,
           adjusted_by = $5, adjusted_at = NOW()
         WHERE id = $1 RETURNING *`,
        [existing.id, proposed_rating ?? null, calibrated, justification || null, adjustedBy])
      : await client.query(
        `INSERT INTO calibration_adjustments
           (session_id, review_id, employee_id, company_id,
            original_rating, proposed_rating, final_rating, justification,
            adjusted_by, adjusted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         RETURNING *`,
        [session.id, review.id, review.employee_id, cid,
         original_rating ?? null, proposed_rating ?? null, calibrated,
         justification || null, adjustedBy]);
    // Write calibrated_rating back to performance_reviews
    if (calibrated != null) {
      await client.query(
        `UPDATE performance_reviews SET
           calibrated_rating = $2,
           hr_reviewer_id    = $3,
           hr_submitted_at   = NOW(),
           updated_at        = NOW()
         WHERE id = $1 AND company_id = $4`,
        [review.id, calibrated, adjustedBy, cid]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(adj[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* ─── BELL CURVE / RATING DISTRIBUTION ─────────────────────────────────── */

router.get('/bell-curve', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id, department } = req.query;
  const params = [cid];
  let where = 'WHERE pr.deleted_at IS NULL AND pr.status IN (\'completed\',\'calibrated\')';
  where += ` AND pr.company_id = $1`;
  if (cycle_id)    { params.push(cycle_id);    where += ` AND pr.review_cycle_id = $${params.length}`; }
  if (department)  { params.push(department);  where += ` AND e.department = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         ROUND(COALESCE(pr.calibrated_rating, pr.final_rating)::numeric, 1) AS rating_band,
         COUNT(*)::int AS count,
         ARRAY_AGG(e.name) AS employees,
         ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER()::numeric, 1) AS percentage
       FROM performance_reviews pr
       JOIN employees e ON e.id = pr.employee_id
       ${where}
         AND COALESCE(pr.calibrated_rating, pr.final_rating) IS NOT NULL
       GROUP BY rating_band
       ORDER BY rating_band`,
      params
    );

    const distribution = rows;
    const total        = distribution.reduce((s, r) => s + r.count, 0);
    const weighted_avg = total > 0
      ? distribution.reduce((s, r) => s + parseFloat(r.rating_band) * r.count, 0) / total
      : 0;

    res.json({ distribution, total, weighted_avg: Math.round(weighted_avg * 100) / 100 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── FINALIZE SESSION ──────────────────────────────────────────────────── */

router.post('/sessions/:id/finalize', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  if (cid == null) return res.status(403).json({ error: 'Calibration needs a company — this login has none' });
  try {
    // One scoped statement: the old follow-up read had no company filter and
    // returned another company's session for its id.
    const { rows } = await pool.query(
      `UPDATE calibration_sessions SET status = 'completed', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
