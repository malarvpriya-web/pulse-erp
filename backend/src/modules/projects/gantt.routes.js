import express from 'express';
import pool from '../shared/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';

const router = express.Router();

// Migrate project_tasks → unified tasks table (add Gantt columns)
// Migration 20260615000010 handles this. We still keep project_tasks for
// backward compat but point new writes at tasks.
(async () => {
  try {
    // Keep project_tasks as legacy table; add company_id and project_id FK if missing
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_tasks (
        id           SERIAL PRIMARY KEY,
        project      TEXT,
        project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        start_date   DATE NOT NULL,
        end_date     DATE NOT NULL,
        assignee     TEXT,
        assignee_id  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        status       TEXT DEFAULT 'on-track',
        progress     INTEGER DEFAULT 0,
        dependencies INTEGER[] DEFAULT '{}',
        is_milestone BOOLEAN DEFAULT FALSE,
        color        VARCHAR(20),
        wbs_number   VARCHAR(30),
        task_type    VARCHAR(30) DEFAULT 'task',
        parent_task_id INTEGER,
        estimated_hours NUMERIC(8,2) DEFAULT 0,
        company_id   INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
      ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;
      ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS assignee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;
      ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS color VARCHAR(20);
      ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS wbs_number VARCHAR(30);
      ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS task_type VARCHAR(30) DEFAULT 'task';
      ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(8,2) DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_project_tasks_project_id ON project_tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_tasks_company ON project_tasks(company_id);
    `);
  } catch (err) {
    console.error('[gantt] table init failed:', err.message);
  }
})();

// GET /api/gantt/tasks
router.get('/tasks', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { project, project_id } = req.query;
    const params = [cid];
    let q = `
      SELECT pt.*,
             e.first_name || ' ' || e.last_name AS assignee_name,
             p.project_name
      FROM project_tasks pt
      LEFT JOIN employees e ON e.id = pt.assignee_id
      LEFT JOIN projects p ON p.id = pt.project_id
      WHERE ($1::int IS NULL OR pt.company_id = $1)
    `;
    if (project_id) { q += ` AND pt.project_id = $${params.push(project_id)}`; }
    else if (project) { q += ` AND pt.project = $${params.push(project)}`; }
    q += ' ORDER BY pt.start_date ASC, pt.id ASC';
    const { rows } = await pool.query(q, params);
    return res.json(rows.map(r => ({ ...r, dependencies: r.dependencies || [] })));
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/gantt/tasks
router.post('/tasks', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const {
      project, project_id, name, start_date, end_date, assignee, assignee_id,
      status = 'on-track', progress = 0, dependencies = [], is_milestone = false,
      color, wbs_number, task_type = 'task', estimated_hours = 0,
    } = req.body;

    if (project_id) {
      const check = await pool.query(
        `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
        [project_id, cid]
      );
      if (!check.rows.length) return res.status(403).json({ success: false, message: 'Project not in your company' });
    }

    const { rows } = await pool.query(
      `INSERT INTO project_tasks
         (project,project_id,name,start_date,end_date,assignee,assignee_id,
          status,progress,dependencies,is_milestone,color,wbs_number,task_type,estimated_hours,company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [project, project_id||null, name, start_date, end_date, assignee||null, assignee_id||null,
       status, progress, dependencies, is_milestone, color||null, wbs_number||null,
       task_type, estimated_hours, cid]
    );
    logAudit({ userId: req.user?.userId, module: 'projects', recordId: rows[0].id, recordType: 'gantt_task', action: 'create', newData: rows[0], req });
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/gantt/tasks/:id
router.put('/tasks/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const {
      name, start_date, end_date, assignee, assignee_id, status, progress,
      dependencies, is_milestone, color, wbs_number, task_type, estimated_hours,
    } = req.body;
    const { rows } = await pool.query(
      `UPDATE project_tasks SET
         name=$1, start_date=$2, end_date=$3, assignee=$4, assignee_id=$5,
         status=$6, progress=$7, dependencies=$8, is_milestone=$9,
         color=$10, wbs_number=$11, task_type=$12, estimated_hours=$13,
         updated_at=NOW()
       WHERE id=$14 AND ($15::int IS NULL OR company_id=$15) RETURNING *`,
      [name, start_date, end_date, assignee||null, assignee_id||null,
       status, progress, dependencies, is_milestone,
       color||null, wbs_number||null, task_type||'task', estimated_hours||0,
       req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    logAudit({ userId: req.user?.userId, module: 'projects', recordId: req.params.id, recordType: 'gantt_task', action: 'update', newData: rows[0], req });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/gantt/tasks/:id
router.delete('/tasks/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rows } = await pool.query(
      `DELETE FROM project_tasks WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    logAudit({ userId: req.user?.userId, module: 'projects', recordId: req.params.id, recordType: 'gantt_task', action: 'delete', req });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/gantt/tasks/:id
router.get('/tasks/:id', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rows } = await pool.query(
      `SELECT pt.*, e.first_name||' '||e.last_name AS assignee_name
       FROM project_tasks pt
       LEFT JOIN employees e ON e.id=pt.assignee_id
       WHERE pt.id=$1 AND ($2::int IS NULL OR pt.company_id=$2)`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/gantt/critical-path/:project_id
router.get('/critical-path/:project_id', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const check = await pool.query(
      `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.project_id, cid]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Project not found' });

    const { rows: tasks } = await pool.query(
      `SELECT id, name, start_date, end_date, dependencies, progress
       FROM project_tasks WHERE project_id=$1 ORDER BY start_date`,
      [req.params.project_id]
    );

    // Simple CPM: tasks with longest path and no float
    res.json({ tasks, critical_path_task_ids: computeCriticalPath(tasks) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function computeCriticalPath(tasks) {
  const map = {};
  tasks.forEach(t => { map[t.id] = t; });

  function duration(t) {
    if (!t.start_date || !t.end_date) return 0;
    return Math.max(0, (new Date(t.end_date) - new Date(t.start_date)) / 86400000);
  }

  function longestPath(id, memo = {}) {
    if (memo[id] !== undefined) return memo[id];
    const t = map[id];
    if (!t) return 0;
    const deps = (t.dependencies || []);
    const depMax = deps.length ? Math.max(...deps.map(d => longestPath(d, memo))) : 0;
    memo[id] = duration(t) + depMax;
    return memo[id];
  }

  const memo = {};
  const maxLen = Math.max(...tasks.map(t => longestPath(t.id, memo)), 0);
  return tasks.filter(t => longestPath(t.id, memo) === maxLen).map(t => t.id);
}

export default router;
