import express from 'express';
import pool from '../shared/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { CLOSED_PROJECT_STATUSES } from './projectStatus.js';
import taskRepository from './repositories/task.repository.js';

const router = express.Router();

// Gantt used to read/write its own `project_tasks` table — a dead end migration
// 20260615000010 already fixed the schema for (it added every Gantt column
// straight onto the real `tasks` table Task List/Kanban use) but nothing ever
// repointed this route file at it. Aliases below (task_title AS name,
// schedule_status AS status, employee name AS assignee, project_name AS project)
// keep the existing frontend (GanttChart.jsx) working against the same response
// shape as before, with zero frontend changes required. `schedule_status` is a
// separate column from `tasks.status` on purpose — Kanban's `status` is a
// workflow stage (todo/in_progress/review/done), Gantt's is schedule health
// (on_track/at_risk/delayed); they are not the same concept and must not share
// a column. See migration 20260811000003 and MODULE_FEATURE_CONNECTION_MANUAL.md §95/96.
const SELECT_COLUMNS = `
  t.id, t.project_id, t.task_title AS name, t.start_date, t.end_date,
  t.assigned_to AS assignee_id, t.schedule_status AS status, t.progress,
  t.dependencies, t.is_milestone, t.color, t.wbs_number, t.task_type,
  t.parent_task_id, t.estimated_hours, t.created_at, t.updated_at,
  CONCAT(e.first_name, ' ', e.last_name) AS assignee,
  p.project_name AS project
`;

async function findClosedProjectStatus(projectId) {
  if (!projectId) return null;
  const { rows } = await pool.query('SELECT status FROM projects WHERE id = $1', [projectId]);
  return CLOSED_PROJECT_STATUSES.includes(rows[0]?.status) ? rows[0].status : null;
}

// GET /api/gantt/tasks
router.get('/tasks', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { project, project_id } = req.query;
    const params = [cid];
    let q = `
      SELECT ${SELECT_COLUMNS}
      FROM tasks t
      LEFT JOIN employees e ON e.id = t.assigned_to
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.deleted_at IS NULL AND ($1::int IS NULL OR p.company_id = $1)
    `;
    if (project_id) { q += ` AND t.project_id = $${params.push(project_id)}`; }
    else if (project) { q += ` AND p.project_name = $${params.push(project)}`; }
    q += ' ORDER BY t.start_date ASC NULLS LAST, t.id ASC';
    const { rows } = await pool.query(q, params);
    return res.json(rows.map(r => ({ ...r, dependencies: r.dependencies || [] })));
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/gantt/tasks/:id
router.get('/tasks/:id', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLUMNS}
       FROM tasks t
       LEFT JOIN employees e ON e.id = t.assigned_to
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id=$1 AND t.deleted_at IS NULL AND ($2::int IS NULL OR p.company_id=$2)`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/gantt/tasks
router.post('/tasks', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const {
      project_id, name, start_date, end_date, assignee_id,
      status = 'on_track', progress = 0, dependencies = [], is_milestone = false,
      color, wbs_number, task_type = 'task', estimated_hours = 0,
    } = req.body;

    if (!name || !start_date || !end_date) {
      return res.status(400).json({ success: false, message: 'name, start_date and end_date are required' });
    }

    if (project_id) {
      const check = await pool.query(
        `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
        [project_id, cid]
      );
      if (!check.rows.length) return res.status(403).json({ success: false, message: 'Project not in your company' });
      const closedStatus = await findClosedProjectStatus(project_id);
      if (closedStatus) {
        return res.status(400).json({ success: false, message: `Cannot add a task — project is ${closedStatus}` });
      }
    }

    const created = await taskRepository.create({
      project_id: project_id || null,
      task_title: name,
      assigned_to: assignee_id || null,
      start_date, end_date, progress, dependencies, is_milestone,
      color, wbs_number, task_type, estimated_hours,
      schedule_status: status,
    });

    const { rows } = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM tasks t
       LEFT JOIN employees e ON e.id = t.assigned_to
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id=$1`,
      [created.id]
    );
    logAudit({ userId: req.user?.userId, module: 'projects', recordId: created.id, recordType: 'gantt_task', action: 'create', newData: rows[0], req });
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/gantt/tasks/:id
router.put('/tasks/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const owned = await pool.query(
      `SELECT t.id FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id=$1 AND t.deleted_at IS NULL AND ($2::int IS NULL OR p.company_id=$2)`,
      [req.params.id, cid]
    );
    if (!owned.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });

    const {
      name, start_date, end_date, assignee_id, status, progress,
      dependencies, is_milestone, color, wbs_number, task_type, estimated_hours,
    } = req.body;

    const mapped = {};
    if (name !== undefined) mapped.task_title = name;
    if (start_date !== undefined) mapped.start_date = start_date;
    if (end_date !== undefined) mapped.end_date = end_date;
    if (assignee_id !== undefined) mapped.assigned_to = assignee_id;
    if (status !== undefined) mapped.schedule_status = status;
    if (progress !== undefined) mapped.progress = progress;
    if (dependencies !== undefined) mapped.dependencies = dependencies;
    if (is_milestone !== undefined) mapped.is_milestone = is_milestone;
    if (color !== undefined) mapped.color = color;
    if (wbs_number !== undefined) mapped.wbs_number = wbs_number;
    if (task_type !== undefined) mapped.task_type = task_type;
    if (estimated_hours !== undefined) mapped.estimated_hours = estimated_hours;

    await taskRepository.update(req.params.id, mapped);

    const { rows } = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM tasks t
       LEFT JOIN employees e ON e.id = t.assigned_to
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id=$1`,
      [req.params.id]
    );
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
    const owned = await pool.query(
      `SELECT t.id FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id=$1 AND t.deleted_at IS NULL AND ($2::int IS NULL OR p.company_id=$2)`,
      [req.params.id, cid]
    );
    if (!owned.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    await taskRepository.delete(req.params.id);
    logAudit({ userId: req.user?.userId, module: 'projects', recordId: req.params.id, recordType: 'gantt_task', action: 'delete', req });
    res.json({ success: true });
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
      `SELECT id, task_title AS name, start_date, end_date, dependencies, progress
       FROM tasks WHERE project_id=$1 AND deleted_at IS NULL ORDER BY start_date`,
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
