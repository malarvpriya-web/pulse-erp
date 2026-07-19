import express from 'express';
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

const role   = req => req.user?.role ?? 'employee';
const getCid = req => req.scope?.company_id ?? companyOf(req);
const isHR   = req => ['hr', 'super_admin', 'admin'].includes(role(req));
const isMgr  = req => ['manager', 'hr', 'super_admin', 'admin'].includes(role(req));

/* ─── OKR OBJECTIVES ─────────────────────────────────────────────────────── */

router.get('/objectives', async (req, res) => {
  const cid = getCid(req);
  const uid = req.user?.userId;
  const { level, department, cycle_id, owner_id } = req.query;
  const params = [cid];
  let where = 'WHERE o.company_id = $1 AND o.status != \'cancelled\'';

  // Employees only see their own + company/department OKRs
  if (!isMgr(req)) {
    params.push(uid);
    where += ` AND (o.owner_id = $${params.length} OR o.level IN ('company','department'))`;
  }

  if (level)      { params.push(level);      where += ` AND o.level = $${params.length}`; }
  if (department) { params.push(department); where += ` AND o.department = $${params.length}`; }
  if (cycle_id)   { params.push(cycle_id);   where += ` AND o.cycle_id = $${params.length}`; }
  if (owner_id && isMgr(req)) { params.push(owner_id); where += ` AND o.owner_id = $${params.length}`; }

  try {
    const { rows } = await pool.query(
      `SELECT o.*,
         e.name AS owner_name, e.department AS owner_department,
         (SELECT COUNT(*) FROM okr_key_results kr WHERE kr.objective_id = o.id)::int AS kr_count,
         (SELECT ROUND(AVG(kr.progress_pct)::numeric, 1) FROM okr_key_results kr WHERE kr.objective_id = o.id) AS progress_pct
       FROM okr_objectives o
       JOIN employees e ON e.id = o.owner_id
       ${where}
       ORDER BY o.level, o.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/objectives/:id', async (req, res) => {
  const cid = getCid(req);
  const uid = req.user?.userId;
  try {
    const { rows: objs } = await pool.query(
      `SELECT o.*, e.name AS owner_name
       FROM okr_objectives o
       JOIN employees e ON e.id = o.owner_id
       WHERE o.id = $1 AND o.company_id = $2`,
      [req.params.id, cid]
    );
    if (!objs.length) return res.status(404).json({ error: 'Objective not found' });
    const obj = objs[0];
    if (!isMgr(req) && String(obj.owner_id) !== String(uid) &&
        !['company', 'department'].includes(obj.level)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows: krs } = await pool.query(
      `SELECT kr.*, e.name AS owner_name
       FROM okr_key_results kr
       LEFT JOIN employees e ON e.id = kr.owner_id
       WHERE kr.objective_id = $1
       ORDER BY kr.created_at`,
      [req.params.id]
    );
    res.json({ ...obj, key_results: krs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/objectives', async (req, res) => {
  const {
    owner_id, parent_id, cycle_id, title, description,
    level = 'individual', department, start_date, end_date,
  } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const cid = getCid(req);
  const uid = req.user?.userId;

  // Only HR/manager can create company/department OKRs
  if (['company', 'department'].includes(level) && !isMgr(req)) {
    return res.status(403).json({ error: 'Manager+ required for company/department OKRs' });
  }

  const effectiveOwner = owner_id || uid;
  try {
    const { rows } = await pool.query(
      `INSERT INTO okr_objectives
         (company_id, owner_id, parent_id, cycle_id, title, description,
          level, department, start_date, end_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [cid, effectiveOwner, parent_id || null, cycle_id || null,
       title, description || null, level, department || null,
       start_date || null, end_date || null, uid]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/objectives/:id', async (req, res) => {
  const cid = getCid(req);
  const uid = req.user?.userId;
  const { title, description, status, end_date, department } = req.body;
  try {
    const check = await pool.query(
      'SELECT owner_id FROM okr_objectives WHERE id = $1 AND company_id = $2',
      [req.params.id, cid]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Objective not found' });
    if (String(check.rows[0].owner_id) !== String(uid) && !isMgr(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query(
      `UPDATE okr_objectives SET
         title       = COALESCE($2, title),
         description = COALESCE($3, description),
         status      = COALESCE($4, status),
         end_date    = COALESCE($5, end_date),
         department  = COALESCE($6, department),
         updated_at  = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, title || null, description ?? null,
       status || null, end_date ?? null, department ?? null]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/objectives/:id', async (req, res) => {
  const cid = getCid(req);
  const uid = req.user?.userId;
  try {
    const check = await pool.query(
      'SELECT owner_id FROM okr_objectives WHERE id = $1 AND company_id = $2',
      [req.params.id, cid]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    if (String(check.rows[0].owner_id) !== String(uid) && !isHR(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await pool.query(
      `UPDATE okr_objectives SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ message: 'Objective cancelled' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── KEY RESULTS ──────────────────────────────────────────────────────────── */

router.post('/objectives/:id/key-results', async (req, res) => {
  const cid = getCid(req);
  const uid = req.user?.userId;
  const {
    title, description, unit, start_value = 0, target_value,
    kr_type = 'metric', owner_id, due_date,
  } = req.body;
  if (!title || target_value == null) {
    return res.status(400).json({ error: 'title and target_value required' });
  }
  try {
    const check = await pool.query(
      'SELECT owner_id FROM okr_objectives WHERE id = $1 AND company_id = $2',
      [req.params.id, cid]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Objective not found' });
    if (String(check.rows[0].owner_id) !== String(uid) && !isMgr(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query(
      `INSERT INTO okr_key_results
         (objective_id, company_id, title, description, unit,
          start_value, target_value, current_value, kr_type, owner_id, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10)
       RETURNING *`,
      [req.params.id, cid, title, description || null, unit || null,
       start_value, target_value, kr_type, owner_id || uid, due_date || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/key-results/:id', async (req, res) => {
  const { current_value, title, status, due_date } = req.body;
  const uid = req.user?.userId;
  try {
    const { rows } = await pool.query(
      `UPDATE okr_key_results SET
         current_value = COALESCE($2, current_value),
         title         = COALESCE($3, title),
         status        = COALESCE($4, status),
         due_date      = COALESCE($5, due_date),
         updated_at    = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, current_value ?? null, title || null, status || null, due_date ?? null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Key result not found' });

    // Recalculate objective overall_progress
    await pool.query(
      `UPDATE okr_objectives SET
         overall_progress = (
           SELECT ROUND(AVG(progress_pct)::numeric, 1)
           FROM okr_key_results WHERE objective_id = (SELECT objective_id FROM okr_key_results WHERE id = $1)
         ),
         updated_at = NOW()
       WHERE id = (SELECT objective_id FROM okr_key_results WHERE id = $1)`,
      [req.params.id]
    );

    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/key-results/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM okr_key_results WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── OKR ANALYTICS ────────────────────────────────────────────────────────── */

router.get('/analytics', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id } = req.query;
  const params = [cid];
  let extra = '';
  if (cycle_id) { params.push(cycle_id); extra = ` AND o.cycle_id = $${params.length}`; }
  try {
    const [summary, byLevel, byDept] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total_objectives,
           COUNT(*) FILTER (WHERE status='active')::int AS active,
           COUNT(*) FILTER (WHERE status='completed')::int AS completed,
           ROUND(AVG(overall_progress)::numeric, 1) AS avg_progress
         FROM okr_objectives o
         WHERE o.company_id = $1${extra}`,
        params
      ),
      pool.query(
        `SELECT level,
           COUNT(*)::int AS count,
           ROUND(AVG(overall_progress)::numeric, 1) AS avg_progress
         FROM okr_objectives o
         WHERE company_id = $1${extra}
         GROUP BY level`,
        params
      ),
      pool.query(
        `SELECT o.department,
           COUNT(*)::int AS objective_count,
           ROUND(AVG(overall_progress)::numeric, 1) AS avg_progress
         FROM okr_objectives o
         WHERE company_id = $1${extra} AND department IS NOT NULL
         GROUP BY o.department
         ORDER BY avg_progress DESC`,
        params
      ),
    ]);
    res.json({
      summary: summary.rows[0],
      by_level: byLevel.rows,
      by_department: byDept.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
