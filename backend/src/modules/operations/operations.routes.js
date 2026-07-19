import { Router } from 'express';
import pool from '../shared/db.js';

const router = Router();

// Extract optional company scope from request (null = no isolation, backward compat)
const cid = (req) => req.scope?.company_id ?? null;

// GET /api/operations/bottlenecks
router.get('/bottlenecks', async (req, res) => {
  try {
    const companyId = cid(req);
    const r = await pool.query(`
      SELECT
        COALESCE(e.department, 'General') AS id,
        COALESCE(e.department, 'General') AS affected_dept,
        COALESCE(e.department, 'General') || ' Queue Backlog' AS title,
        COUNT(t.id)::text || ' tasks in queue — avg '
          || ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - t.created_at))/3600)::numeric, 1)::text
          || 'h wait time' AS description,
        COUNT(t.id) AS queue_depth,
        ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - t.created_at))/3600)::numeric, 1) AS avg_delay_hours,
        MAX(EXTRACT(EPOCH FROM (NOW() - t.created_at))/3600)::int AS max_time,
        CASE WHEN COUNT(t.id) > 15 THEN 'critical'
             WHEN COUNT(t.id) > 8  THEN 'high'
             WHEN COUNT(t.id) > 4  THEN 'medium'
             ELSE 'low' END AS severity
      FROM tasks t
      LEFT JOIN employees e ON t.assigned_to = e.id
      WHERE t.status NOT IN ('completed','done','Completed','Done')
        AND ($1::int IS NULL OR e.company_id = $1)
      GROUP BY e.department
      ORDER BY queue_depth DESC
      LIMIT 10
    `, [companyId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/operations/department-workload
router.get('/department-workload', async (req, res) => {
  try {
    const companyId = cid(req);
    const r = await pool.query(`
      SELECT
        d.id,
        d.name AS department,
        COUNT(DISTINCT e.id) AS employee_count,
        COUNT(t.id) AS active_tasks,
        ROUND(COUNT(t.id)::float / NULLIF(COUNT(DISTINCT e.id), 0), 1) AS avg_tasks_per_employee,
        LEAST(100, ROUND(COUNT(t.id)::float / NULLIF(COUNT(DISTINCT e.id), 0) / 5.0 * 100, 1)) AS utilization_pct
      FROM departments d
      LEFT JOIN employees e ON e.department_id = d.id
        AND e.status IN ('active', 'probation', 'notice')
      LEFT JOIN project_tasks t ON t.assignee_id = e.id
        AND t.status NOT IN ('done', 'completed', 'Completed', 'Done')
      WHERE ($1::int IS NULL OR d.company_id = $1)
      GROUP BY d.id, d.name
      ORDER BY d.name
    `, [companyId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/operations/workload-chart
router.get('/workload-chart', async (req, res) => {
  try {
    const companyId = cid(req);
    const r = await pool.query(`
      SELECT e.department,
             COUNT(DISTINCT t.id) AS task_count,
             COUNT(DISTINCT e.id) AS headcount
      FROM employees e
      LEFT JOIN tasks t ON t.assigned_to = e.id
      WHERE e.status = 'active'
        AND ($1::int IS NULL OR e.company_id = $1)
      GROUP BY e.department ORDER BY task_count DESC
    `, [companyId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/operations/project-tracker
router.get('/project-tracker', async (req, res) => {
  try {
    const { status, manager } = req.query;
    const companyId = cid(req);
    const r = await pool.query(`
      SELECT p.*,
             COUNT(t.id) AS total_tasks,
             COUNT(t.id) FILTER (WHERE t.status IN ('completed','done','Completed','Done')) AS completed_tasks,
             e.first_name || ' ' || e.last_name AS manager_name
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      LEFT JOIN employees e ON p.project_manager_id = e.id
      WHERE ($1::text IS NULL OR p.status = $1)
        AND ($2::text IS NULL OR (e.first_name || ' ' || e.last_name) ILIKE '%' || $2 || '%')
        AND ($3::int IS NULL OR p.company_id = $3)
      GROUP BY p.id, e.first_name, e.last_name
      ORDER BY p.created_at DESC
    `, [status || null, manager || null, companyId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/operations/workflows
router.get('/workflows', async (req, res) => {
  try {
    const companyId = cid(req);
    const r = await pool.query(
      `SELECT * FROM workflows WHERE ($1::int IS NULL OR company_id = $1) ORDER BY created_at DESC`,
      [companyId]
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/operations/workflows
router.post('/workflows', async (req, res) => {
  try {
    const { name, description, trigger_module, trigger_event, is_active } = req.body;
    const companyId = cid(req);
    const code = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Date.now();
    const r = await pool.query(
      `INSERT INTO workflows (name, code, module, trigger_event, description, is_active, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, code, trigger_module || 'general', trigger_event || 'on_submit', description || '', is_active !== false, companyId]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/operations/workflows/:id
router.put('/workflows/:id', async (req, res) => {
  try {
    const { name, description, trigger_module, trigger_event, is_active } = req.body;
    const companyId = cid(req);
    const r = await pool.query(
      `UPDATE workflows SET name=$1, module=$2, trigger_event=$3, description=$4, is_active=$5
       WHERE id=$6 AND ($7::int IS NULL OR company_id = $7) RETURNING *`,
      [name, trigger_module || 'general', trigger_event || 'on_submit', description || '', is_active !== false, req.params.id, companyId]
    );
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/operations/workflows/:id/toggle
router.put('/workflows/:id/toggle', async (req, res) => {
  try {
    const companyId = cid(req);
    const r = await pool.query(
      `UPDATE workflows SET is_active=$1 WHERE id=$2 AND ($3::int IS NULL OR company_id = $3) RETURNING *`,
      [req.body.is_active, req.params.id, companyId]
    );
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
