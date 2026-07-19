// backend/src/modules/hr/competency.routes.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();
const cid  = req => { const n = Number.parseInt(req.scope?.company_id, 10); return Number.isInteger(n) ? n : null; };
const role = req => req.user?.role ?? '';
const HR   = ['admin','super_admin','hr','hr_manager','lnd_admin','HR','Admin','SuperAdmin'];

function sc(companyId, alias = '') {
  const col = alias ? `${alias}.company_id` : 'company_id';
  return companyId != null ? ` AND (${col} IS NULL OR ${col}=${companyId})` : '';
}

/* ── GET /competencies ─────────────────────────────────────── */
router.get('/', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM competency_framework WHERE 1=1${sc(companyId)} ORDER BY category, name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /competencies ────────────────────────────────────── */
router.post('/', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { name, category, description, level_1_descriptor, level_2_descriptor,
          level_3_descriptor, level_4_descriptor, level_5_descriptor } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      INSERT INTO competency_framework
        (name,category,description,level_1_descriptor,level_2_descriptor,
         level_3_descriptor,level_4_descriptor,level_5_descriptor,company_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name,category||null,description||null,
       level_1_descriptor||null,level_2_descriptor||null,level_3_descriptor||null,
       level_4_descriptor||null,level_5_descriptor||null,companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /competencies/:id ─────────────────────────────────── */
router.put('/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { name,category,description,level_1_descriptor,level_2_descriptor,
          level_3_descriptor,level_4_descriptor,level_5_descriptor } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE competency_framework SET
        name=COALESCE($1,name), category=COALESCE($2,category),
        description=COALESCE($3,description),
        level_1_descriptor=COALESCE($4,level_1_descriptor),
        level_2_descriptor=COALESCE($5,level_2_descriptor),
        level_3_descriptor=COALESCE($6,level_3_descriptor),
        level_4_descriptor=COALESCE($7,level_4_descriptor),
        level_5_descriptor=COALESCE($8,level_5_descriptor)
      WHERE id=$9 RETURNING *`,
      [name,category,description,level_1_descriptor,level_2_descriptor,
       level_3_descriptor,level_4_descriptor,level_5_descriptor,req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── DELETE /competencies/:id ──────────────────────────────── */
router.delete('/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query(`DELETE FROM competency_framework WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /competencies/employee/:employee_id ───────────────── */
router.get('/employee/:employee_id', async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      SELECT cf.*, eca.assessed_level, eca.required_level,
             (COALESCE(eca.required_level,3) - COALESCE(eca.assessed_level,0)) AS gap,
             eca.assessed_date, eca.notes
      FROM   competency_framework cf
      LEFT JOIN employee_competency_assessments eca
             ON eca.competency_id=cf.id AND eca.employee_id=$1
      WHERE  1=1${sc(companyId,'cf')}
      ORDER  BY cf.category, cf.name`, [req.params.employee_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /competencies/employee/:employee_id/assess ──────── */
router.post('/employee/:employee_id/assess', async (req, res) => {
  const { assessments = [] } = req.body; // [{competency_id, assessed_level, notes}]
  const companyId = cid(req);
  const assessedBy = req.user?.employee_id || null;
  try {
    for (const a of assessments) {
      await pool.query(`
        INSERT INTO employee_competency_assessments
          (employee_id,competency_id,assessed_level,required_level,assessed_by,notes,company_id)
        VALUES ($1,$2,$3,
          COALESCE((SELECT required_level FROM role_competencies WHERE role_title=(
            SELECT designation FROM employees WHERE id=$1) AND competency_id=$2 LIMIT 1),3),
          $4,$5,$6)
        ON CONFLICT (employee_id,competency_id) DO UPDATE SET
          assessed_level=EXCLUDED.assessed_level, assessed_by=EXCLUDED.assessed_by,
          notes=EXCLUDED.notes, assessed_date=CURRENT_DATE`,
        [req.params.employee_id, a.competency_id, a.assessed_level, assessedBy, a.notes||null, companyId]
      );
    }
    res.json({ message: `${assessments.length} competencies assessed` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /competencies/gaps/department ─────────────────────── */
router.get('/gaps/department', async (req, res) => {
  const companyId = cid(req);
  const sc2 = companyId != null ? ` AND eca.company_id=${companyId}` : '';
  try {
    const { rows } = await pool.query(`
      SELECT e.department, cf.name AS competency, cf.category,
             ROUND(AVG(eca.assessed_level),1)  AS avg_assessed,
             ROUND(AVG(eca.required_level),1)  AS avg_required,
             ROUND(AVG(eca.required_level - eca.assessed_level),1) AS avg_gap,
             COUNT(*) AS employee_count
      FROM   employee_competency_assessments eca
      JOIN   employees e ON e.id=eca.employee_id
      JOIN   competency_framework cf ON cf.id=eca.competency_id
      WHERE  1=1${sc2}
      GROUP  BY e.department, cf.id, cf.name, cf.category
      HAVING AVG(eca.required_level - eca.assessed_level) > 0
      ORDER  BY avg_gap DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
