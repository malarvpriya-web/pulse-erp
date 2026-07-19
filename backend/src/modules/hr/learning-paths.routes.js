// backend/src/modules/hr/learning-paths.routes.js
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

/* ── GET /learning-paths ───────────────────────────────────── */
router.get('/', async (req, res) => {
  const companyId = cid(req);
  const { path_type, target_role, target_department } = req.query;
  let where = `WHERE lp.is_active=true${sc(companyId,'lp')}`;
  if (path_type)          where += ` AND lp.path_type='${path_type.replace(/'/g,"''")}'`;
  if (target_role)        where += ` AND lp.target_role='${target_role.replace(/'/g,"''")}'`;
  if (target_department)  where += ` AND lp.target_department='${target_department.replace(/'/g,"''")}'`;
  try {
    const { rows } = await pool.query(`
      SELECT lp.*,
             COUNT(DISTINCT lpi.id)                        AS total_items,
             COUNT(DISTINCT CASE WHEN lpi.is_mandatory THEN lpi.id END) AS mandatory_items,
             COALESCE(SUM(tp.duration_hours),0)            AS total_hours
      FROM   learning_paths lp
      LEFT JOIN learning_path_items lpi ON lpi.path_id=lp.id
      LEFT JOIN training_programs   tp  ON tp.id=lpi.program_id AND tp.deleted_at IS NULL
      ${where}
      GROUP  BY lp.id ORDER BY lp.name`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST /learning-paths ──────────────────────────────────── */
router.post('/', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { name, description, path_type = 'role', target_role, target_department, thumbnail_url } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(`
      INSERT INTO learning_paths (name,description,path_type,target_role,target_department,thumbnail_url,company_id,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, description||null, path_type, target_role||null, target_department||null,
       thumbnail_url||null, companyId, req.user?.userId||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /learning-paths/:id ───────────────────────────────── */
router.get('/:id', async (req, res) => {
  try {
    const [pathRes, itemsRes] = await Promise.all([
      pool.query(`SELECT * FROM learning_paths WHERE id=$1 AND is_active=true`, [req.params.id]),
      pool.query(`
        SELECT lpi.*, tp.title, tp.category, tp.mode, tp.duration_hours,
               tp.status AS program_status, tp.scheduled_date, tp.trainer
        FROM   learning_path_items lpi
        JOIN   training_programs tp ON tp.id=lpi.program_id
        WHERE  lpi.path_id=$1 AND tp.deleted_at IS NULL
        ORDER  BY lpi.sequence_order`, [req.params.id]),
    ]);
    if (!pathRes.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...pathRes.rows[0], items: itemsRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /learning-paths/:id ───────────────────────────────── */
router.put('/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { name, description, path_type, target_role, target_department, thumbnail_url, is_active } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE learning_paths SET
        name               = COALESCE($1,name),
        description        = COALESCE($2,description),
        path_type          = COALESCE($3,path_type),
        target_role        = COALESCE($4,target_role),
        target_department  = COALESCE($5,target_department),
        thumbnail_url      = COALESCE($6,thumbnail_url),
        is_active          = COALESCE($7,is_active)
      WHERE id=$8 RETURNING *`,
      [name, description, path_type, target_role, target_department, thumbnail_url, is_active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── DELETE /learning-paths/:id ────────────────────────────── */
router.delete('/:id', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    await pool.query(`UPDATE learning_paths SET is_active=false WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Learning path archived' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT /learning-paths/:id/items ─────────────────────────── */
router.put('/:id/items', async (req, res) => {
  if (!HR.includes(role(req))) return res.status(403).json({ error: 'Forbidden' });
  const { items = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM learning_path_items WHERE path_id=$1`, [req.params.id]);
    for (const item of items) {
      await client.query(`
        INSERT INTO learning_path_items (path_id,program_id,sequence_order,is_mandatory,prerequisite_item_id)
        VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, item.program_id, item.sequence_order ?? 1,
         item.is_mandatory ?? true, item.prerequisite_item_id || null]
      );
    }
    // Update estimated hours
    await client.query(`
      UPDATE learning_paths SET estimated_hours=(
        SELECT COALESCE(SUM(tp.duration_hours),0) FROM learning_path_items lpi
        JOIN training_programs tp ON tp.id=lpi.program_id WHERE lpi.path_id=$1
      ) WHERE id=$1`, [req.params.id]
    );
    await client.query('COMMIT');
    res.json({ message: 'Items updated', count: items.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

/* ── POST /learning-paths/:id/assign ──────────────────────── */
router.post('/:id/assign', async (req, res) => {
  const { employee_ids = [], due_date } = req.body;
  if (!employee_ids.length) return res.status(400).json({ error: 'employee_ids required' });
  const companyId = cid(req);
  try {
    let assigned = 0;
    for (const eid of employee_ids) {
      await pool.query(`
        INSERT INTO employee_learning_paths (employee_id,path_id,assigned_by,due_date,company_id)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (employee_id,path_id) DO UPDATE SET
          assigned_by=EXCLUDED.assigned_by, due_date=EXCLUDED.due_date`,
        [eid, req.params.id, req.user?.userId||null, due_date||null, companyId]
      );
      // Auto-enroll into each program in the path
      const { rows: pathItems } = await pool.query(
        `SELECT program_id FROM learning_path_items WHERE path_id=$1`, [req.params.id]
      );
      for (const pi of pathItems) {
        await pool.query(`
          INSERT INTO training_enrollments (program_id,employee_id,company_id)
          VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [pi.program_id, eid, companyId]
        );
      }
      assigned++;
    }
    res.json({ assigned, message: `Path assigned to ${assigned} employee(s)` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /learning-paths/:id/progress ─────────────────────── */
router.get('/:id/progress', async (req, res) => {
  const companyId = cid(req);
  const sc2 = companyId != null ? ` AND elp.company_id=${companyId}` : '';
  try {
    const { rows } = await pool.query(`
      SELECT elp.*, e.name AS employee_name, e.department,
             COUNT(DISTINCT lpi.id)                                                    AS total_items,
             COUNT(DISTINCT CASE WHEN te.status='completed' THEN lpi.id END)          AS completed_items,
             ROUND(100.0*COUNT(DISTINCT CASE WHEN te.status='completed' THEN lpi.id END)
               /NULLIF(COUNT(DISTINCT lpi.id),0),0)                                   AS progress_pct
      FROM   employee_learning_paths elp
      JOIN   employees e ON e.id=elp.employee_id
      JOIN   learning_path_items lpi ON lpi.path_id=elp.path_id
      LEFT JOIN training_enrollments te ON te.program_id=lpi.program_id AND te.employee_id=elp.employee_id
      WHERE  elp.path_id=$1${sc2}
      GROUP  BY elp.id, e.name, e.department
      ORDER  BY e.name`, [req.params.id]
    );
    // Auto-update status to completed where 100%
    for (const r of rows) {
      if (parseInt(r.progress_pct) === 100 && r.status !== 'completed') {
        await pool.query(
          `UPDATE employee_learning_paths SET status='completed',completed_at=NOW() WHERE id=$1`,
          [r.id]
        );
        r.status = 'completed';
      }
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── GET /learning-paths/employee/:employee_id ─────────────── */
router.get('/employee/:employee_id', async (req, res) => {
  const companyId = cid(req);
  const sc2 = companyId != null ? ` AND elp.company_id=${companyId}` : '';
  try {
    const { rows } = await pool.query(`
      SELECT elp.*, lp.name, lp.description, lp.path_type, lp.estimated_hours,
             COUNT(DISTINCT lpi.id)                                                    AS total_items,
             COUNT(DISTINCT CASE WHEN te.status='completed' THEN lpi.id END)          AS completed_items,
             ROUND(100.0*COUNT(DISTINCT CASE WHEN te.status='completed' THEN lpi.id END)
               /NULLIF(COUNT(DISTINCT lpi.id),0),0)                                   AS progress_pct
      FROM   employee_learning_paths elp
      JOIN   learning_paths lp ON lp.id=elp.path_id
      JOIN   learning_path_items lpi ON lpi.path_id=lp.id
      LEFT JOIN training_enrollments te ON te.program_id=lpi.program_id AND te.employee_id=elp.employee_id
      WHERE  elp.employee_id=$1${sc2}
      GROUP  BY elp.id, lp.name, lp.description, lp.path_type, lp.estimated_hours
      ORDER  BY elp.status, lp.name`, [req.params.employee_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
