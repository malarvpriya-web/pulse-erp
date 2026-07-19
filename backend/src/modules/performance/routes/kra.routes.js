import express from 'express';
import pool from '../../../config/db.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

const role   = req => req.user?.role ?? 'employee';
const getCid = req => req.scope?.company_id ?? companyOf(req);
const isHR   = req => ['hr', 'super_admin', 'admin'].includes(role(req));
const isMgr  = req => ['manager', 'hr', 'super_admin', 'admin'].includes(role(req));

/* ─── KRA DEFINITIONS (master library) ─────────────────────────────────── */

router.get('/definitions', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM kra_definitions WHERE company_id = $1 AND is_active = TRUE ORDER BY name`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/definitions', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const { name, description, weightage = 100, department, role_level } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO kra_definitions (company_id, name, description, weightage, department, role_level)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [cid, name, description || null, weightage, department || null, role_level || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/definitions/:id', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  const { name, description, weightage, department, role_level, is_active } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE kra_definitions SET
         name        = COALESCE($2, name),
         description = COALESCE($3, description),
         weightage   = COALESCE($4, weightage),
         department  = COALESCE($5, department),
         role_level  = COALESCE($6, role_level),
         is_active   = COALESCE($7, is_active),
         updated_at  = NOW()
       WHERE id = $1 AND company_id = $8 RETURNING *`,
      [req.params.id, name || null, description ?? null, weightage ?? null,
       department ?? null, role_level ?? null, is_active ?? null, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'KRA definition not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/definitions/:id', async (req, res) => {
  if (!isHR(req)) return res.status(403).json({ error: 'HR access required' });
  const cid = getCid(req);
  try {
    await pool.query(
      `UPDATE kra_definitions SET is_active = FALSE WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid]
    );
    res.json({ message: 'KRA definition deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── EMPLOYEE KRA ASSIGNMENTS ───────────────────────────────────────────── */

router.get('/employee/:employeeId', async (req, res) => {
  const cid = getCid(req);
  const uid = req.user?.userId;
  if (!isMgr(req) && String(uid) !== req.params.employeeId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { cycle_id } = req.query;
  const params = [req.params.employeeId, cid];
  let extra = '';
  if (cycle_id) { params.push(cycle_id); extra = ` AND ek.cycle_id = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT ek.*, kd.name AS kra_name, kd.description AS kra_description
       FROM employee_kras ek
       LEFT JOIN kra_definitions kd ON kd.id = ek.kra_id
       WHERE ek.employee_id = $1 AND ek.company_id = $2${extra}
       ORDER BY ek.created_at`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/employee/:employeeId', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const {
    kra_id, review_id, cycle_id, custom_name, description,
    target, weightage = 25,
  } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO employee_kras
         (employee_id, kra_id, review_id, cycle_id, company_id,
          custom_name, description, target, weightage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.employeeId, kra_id || null, review_id || null, cycle_id || null, cid,
       custom_name || null, description || null, target || null, weightage]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/self-score', async (req, res) => {
  const { self_score, evidence } = req.body;
  const cid = getCid(req);
  const uid = req.user?.userId;
  try {
    const check = await pool.query(
      'SELECT employee_id FROM employee_kras WHERE id = $1 AND company_id = $2',
      [req.params.id, cid]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'KRA not found' });
    if (String(check.rows[0].employee_id) !== String(uid) && !isMgr(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows } = await pool.query(
      `UPDATE employee_kras SET self_score = $2, evidence = COALESCE($3, evidence), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, self_score, evidence ?? null]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/manager-score', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const { manager_score, final_score } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE employee_kras SET
         manager_score = $2,
         final_score   = COALESCE($3, $2),
         updated_at    = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, manager_score, final_score ?? null]
    );
    if (!rows.length) return res.status(404).json({ error: 'KRA not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  try {
    await pool.query(
      'DELETE FROM employee_kras WHERE id = $1 AND company_id = $2',
      [req.params.id, cid]
    );
    res.json({ message: 'KRA removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── KRA ANALYTICS ──────────────────────────────────────────────────────── */

router.get('/analytics/summary', async (req, res) => {
  if (!isMgr(req)) return res.status(403).json({ error: 'Manager+ access required' });
  const cid = getCid(req);
  const { cycle_id } = req.query;
  const params = [cid];
  let extra = '';
  if (cycle_id) { params.push(cycle_id); extra = ` AND ek.cycle_id = $${params.length}`; }
  try {
    const { rows } = await pool.query(
      `SELECT
         e.department,
         COUNT(DISTINCT ek.employee_id)::int AS employees_with_kras,
         ROUND(AVG(ek.final_score)::numeric, 2) AS avg_kra_score,
         ROUND(AVG(ek.weightage)::numeric, 2) AS avg_weightage,
         COUNT(ek.id)::int AS total_kras
       FROM employee_kras ek
       JOIN employees e ON e.id = ek.employee_id
       WHERE ek.company_id = $1${extra}
       GROUP BY e.department
       ORDER BY avg_kra_score DESC NULLS LAST`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
