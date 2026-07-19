import express from 'express';
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

const role   = req => req.user?.role ?? 'employee';
const getCid = req => req.scope?.company_id ?? companyOf(req);
const isHR   = req => ['hr', 'super_admin', 'admin'].includes(role(req));
const isMgr  = req => ['manager', 'hr', 'super_admin', 'admin'].includes(role(req));

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
       req.user?.userId ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/sessions/:id', async (req, res) => {
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

router.post('/sessions/:id/adjust', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const { review_id, employee_id, original_rating, proposed_rating, final_rating, justification } = req.body;
  if (!review_id || !employee_id) {
    return res.status(400).json({ error: 'review_id and employee_id required' });
  }
  const adjustedBy = req.user?.userId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: adj } = await client.query(
      `INSERT INTO calibration_adjustments
         (session_id, review_id, employee_id, company_id,
          original_rating, proposed_rating, final_rating, justification,
          adjusted_by, adjusted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (session_id, review_id) DO UPDATE SET
         proposed_rating = $6,
         final_rating    = $7,
         justification   = $8,
         adjusted_by     = $9,
         adjusted_at     = NOW()
       RETURNING *`,
      [req.params.id, review_id, employee_id, cid,
       original_rating, proposed_rating, final_rating || proposed_rating,
       justification || null, adjustedBy]
    );
    // Write calibrated_rating back to performance_reviews
    if (final_rating || proposed_rating) {
      await client.query(
        `UPDATE performance_reviews SET
           calibrated_rating = $2,
           hr_reviewer_id    = $3,
           hr_submitted_at   = NOW(),
           updated_at        = NOW()
         WHERE id = $1`,
        [review_id, final_rating || proposed_rating, adjustedBy]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(adj[0]);
  } catch (err) {
    await client.query('ROLLBACK');
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
  try {
    await pool.query(
      `UPDATE calibration_sessions SET status = 'completed', updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid]
    );
    const { rows } = await pool.query('SELECT * FROM calibration_sessions WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
