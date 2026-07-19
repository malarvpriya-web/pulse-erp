import express from 'express';
import projectRepository from '../repositories/project.repository.js';
import taskRepository from '../repositories/task.repository.js';
import projectCostRepository from '../repositories/projectCost.repository.js';
import pool from '../../shared/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { initiateWorkflow } from '../../../services/WorkflowService.js';
import { validate } from '../../../services/ValidationEngineService.js';
import { evaluateRules } from '../../../services/RuleEngineService.js';
import { logAudit } from '../../../services/AuditService.js';
import { recalculateProjectCost } from '../services/projectCostRollup.service.js';
import * as drive from '../../../services/googleDrive.service.js';

const router = express.Router();
const cid = (req) => req.scope?.company_id ?? null;
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

// projects.created_by / tasks.created_by FK to employees(id) — resolve the
// acting user's employee id (uid() is a users.id, a different namespace).
// Returns null when the login isn't linked to an employee (column is nullable).
async function actingEmployeeId(req) {
  if (req.user?.employee_id != null) return req.user.employee_id;
  const email = req.user?.email;
  if (!email) return null;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM employees WHERE company_email = $1 AND deleted_at IS NULL LIMIT 1`,
      [email]
    );
    return rows[0]?.id ?? null;
  } catch { return null; }
}

// ── one-time inline DDL (idempotent safety net) ───────────────────────────────
(async () => {
  try {
    await pool.query(`
      ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS billing_milestone BOOLEAN DEFAULT FALSE;
      ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS amount            NUMERIC(15,2) DEFAULT 0;
      ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS owner_id          INTEGER REFERENCES employees(id) ON DELETE SET NULL;
      ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS completed_date    DATE;
      ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS invoice_id        INTEGER;
      ALTER TABLE project_milestones ADD COLUMN IF NOT EXISTS invoice_created   BOOLEAN DEFAULT FALSE;
    `);
  } catch (e) { console.error('[projects] milestone migration error:', e.message); }
})();

// ── Employees dropdown ────────────────────────────────────────────────────────
router.get('/employees', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, designation, department,
              0 AS billing_rate
       FROM employees
       WHERE ($1::int IS NULL OR company_id = $1)
         AND LOWER(COALESCE(status,'active')) NOT IN ('left','terminated','resigned','inactive','ex-employee','notice_period')
       ORDER BY first_name ASC`,
      [cid(req)]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Root redirect — GET /api/v1/projects → forward to /api/v1/projects/projects ─
// Mounted at /projects, so this handles GET /api/v1/projects (no sub-path).
router.get('/', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const projects = await projectRepository.findAll({ ...req.query, company_id: cid(req) });
    res.json(projects);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Projects CRUD ─────────────────────────────────────────────────────────────
router.get('/projects', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const projects = await projectRepository.findAll({ ...req.query, company_id: cid(req) });
    res.json(projects);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/dashboard', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const dashboard = await projectRepository.getDashboard(cid(req));
    res.json(dashboard);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/next-code', async (req, res) => {
  try {
    const code = await projectRepository.getNextProjectCode();
    res.json({ code });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/analytics/profitability', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const data = await projectCostRepository.getProjectProfitability(cid(req));
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const project = await projectRepository.findById(req.params.id, cid(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── product lines ─────────────────────────────────────────────────────────────
// The master behind Project Master's Product Type picker (20260716000003).
// `projects` owns product line; IPS inherits it through support_tickets.project_id
// rather than carrying its own, so this is the single place it is authored.
router.get('/product-lines', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, line_name, voltage, voltage_class, display_name
         FROM product_lines
        WHERE deleted_at IS NULL
          AND is_active = TRUE
          AND ($1::int IS NULL OR company_id = $1)
        ORDER BY line_name, voltage`,
      [cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Authoring lives in Product Setup (/admin/product-lines), which also owns the
// ratings child. This create path is kept for API compatibility and is subject to
// the same rules; nothing in the UI calls it.
router.post('/product-lines', requirePermission('projects', 'add'), async (req, res) => {
  try {
    const line_name = String(req.body.line_name ?? '').trim();
    // Optional since 20260716000007: ACB, MBheem AHF and MV-VAJRA carry no
    // voltage. '' would defeat uq_product_lines_line_voltage (NULLS NOT
    // DISTINCT), which treats two missing voltages as the same row, so store NULL.
    const voltage   = String(req.body.voltage ?? '').trim() || null;
    const voltage_class = String(req.body.voltage_class ?? '').trim().toUpperCase();
    if (!line_name) return res.status(400).json({ error: 'line_name is required' });
    if (!['LV', 'MV', 'HV'].includes(voltage_class)) {
      return res.status(400).json({ error: 'voltage_class must be LV, MV or HV' });
    }
    const { rows } = await pool.query(
      `INSERT INTO product_lines (line_name, voltage, voltage_class, description, company_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, line_name, voltage, voltage_class, display_name`,
      [line_name, voltage, voltage_class, req.body.description ?? null, cid(req)]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: rows[0].id, recordType: 'product_line', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) {
    // uq_product_lines_line_voltage — one (line, voltage) per company.
    if (err.code === '23505') return res.status(409).json({ error: 'That product line and voltage already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/projects', requirePermission('projects', 'add'), async (req, res) => {
  try {
    const { valid, errors } = await validate('projects', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', errors });
    const project = await projectRepository.create({
      ...req.body,
      created_by: await actingEmployeeId(req),
      company_id: cid(req),
    });
    logAudit({ userId: uid(req), module: 'projects', recordId: project.id, recordType: 'project', action: 'create', newData: project, req });
    initiateWorkflow('projects', project.id, 'project', uid(req)).catch(e =>
      console.error('[workflow] project initiation failed:', e.message)
    );
    const ruleAlerts = (await evaluateRules('projects', project).catch(() => [])).filter(r => r.triggered);
    res.status(201).json({ ...project, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const { valid, errors } = await validate('projects', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', errors });
    const oldProject = await projectRepository.findById(req.params.id, cid(req));
    // findById is company-scoped, so a miss means the project is another tenant's
    // (or gone). This previously fell through to an unscoped update — the write
    // landed on the other tenant's row. Fail closed, and scope the update too.
    if (!oldProject) return res.status(404).json({ error: 'Project not found' });
    const project = await projectRepository.update(req.params.id, req.body, cid(req));
    if (oldProject?.status !== 'completed' && project?.status === 'completed') {
      await recalculateProjectCost(req.params.id).catch(e =>
        console.error('[projects] cost rollup failed:', e.message)
      );
    }
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'project', action: 'update', oldData: oldProject, newData: project, req });
    const ruleAlerts = (await evaluateRules('projects', project).catch(() => [])).filter(r => r.triggered);
    res.json({ ...project, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lightweight stage move for the Project Pipeline kanban (drag-drop / arrow
// buttons). Deliberately NOT the full PUT: it skips validate('projects', …),
// which requires the whole project shape and would 422 a minimal payload.
// Company-scoped via findById; auto-stamps actual_delivery_date on 'dispatched'.
const PIPELINE_STAGES = ['created', 'handover', 'dr_approval', 'procurement', 'production', 'clearing', 'dispatched'];
router.patch('/projects/:id/stage', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const { production_stage } = req.body;
    if (!PIPELINE_STAGES.includes(production_stage)) {
      return res.status(400).json({ error: 'Invalid production_stage' });
    }
    const oldProject = await projectRepository.findById(req.params.id, cid(req));
    if (!oldProject) return res.status(404).json({ error: 'Project not found' });

    const patch = { production_stage };
    // Stamp the actual delivery date when a project first reaches the terminal
    // 'dispatched' stage, unless one was already recorded.
    if (production_stage === 'dispatched' && !oldProject.actual_delivery_date) {
      patch.actual_delivery_date = new Date().toISOString().slice(0, 10);
    }
    const project = await projectRepository.update(req.params.id, patch, cid(req));
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'project', action: 'update', oldData: oldProject, newData: project, req });
    res.json(project);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const old = await projectRepository.findById(req.params.id, cid(req));
    if (!old) return res.status(404).json({ error: 'Project not found' });
    await projectRepository.delete(req.params.id, cid(req));
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'project', action: 'delete', oldData: old, req });
    res.json({ message: 'Project deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tasks ─────────────────────────────────────────────────────────────────────
router.get('/tasks', async (req, res) => {
  try {
    const authEmail = req.user?.email;
    let empId = null;
    if (authEmail) {
      const r = await pool.query(`SELECT id FROM employees WHERE company_email=$1 LIMIT 1`, [authEmail]);
      if (r.rows.length) empId = r.rows[0].id;
    }
    const viewer = { ...req.user, id: empId };
    const filters = { ...req.query, company_id: cid(req) };
    if (req.query.mine === 'true') {
      if (!empId) return res.json([]);
      filters.assigned_to = empId;
    }
    const tasks = await taskRepository.findAll(filters, viewer);
    res.json(tasks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tasks/overdue', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const tasks = await taskRepository.getOverdueTasks(cid(req));
    res.json(tasks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tasks/kanban/:project_id', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const board = await taskRepository.getKanbanBoard(req.params.project_id, cid(req));
    res.json(board);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tasks/:id', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const task = await taskRepository.findById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tasks', requirePermission('projects', 'add'), async (req, res) => {
  try {
    const task = await taskRepository.create({ ...req.body, created_by: await actingEmployeeId(req) });
    logAudit({ userId: uid(req), module: 'projects', recordId: task.id, recordType: 'task', action: 'create', newData: task, req });
    res.status(201).json(task);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/tasks/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const old = await taskRepository.findById(req.params.id);
    const task = await taskRepository.update(req.params.id, req.body);
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'task', action: 'update', oldData: old, newData: task, req });
    res.json(task);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tasks/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const old = await taskRepository.findById(req.params.id);
    if (!old) return res.status(404).json({ error: 'Task not found' });
    await taskRepository.delete(req.params.id);
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'task', action: 'delete', oldData: old, req });
    res.json({ message: 'Task deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Project Costs ─────────────────────────────────────────────────────────────
router.get('/projects/:id/costs', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const costs = await projectCostRepository.findByProject(req.params.id);
    res.json(costs || { labour_cost: 0, material_cost: 0, expense_cost: 0, total_cost: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Alias for frontend that calls /costing instead of /costs
router.get('/projects/:id/costing', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const costs = await projectCostRepository.findByProject(req.params.id);
    res.json(costs || { labour_cost: 0, material_cost: 0, expense_cost: 0, total_cost: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cost-to-date for active/in-progress projects (shown in Project Costing page below completed list)
router.get('/costing/in-progress', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id, p.project_code, p.project_name, p.status,
        COALESCE(p.budget_amount, p.budget, 0) AS budget_amount,
        COALESCE(pcs.material_cost, 0)     AS material_cost,
        COALESCE(pcs.labour_cost, 0)       AS labour_cost,
        COALESCE(pcs.travel_cost, 0)       AS travel_cost,
        COALESCE(pcs.manufacturing_cost, 0) AS manufacturing_cost,
        COALESCE(pcs.expense_cost, 0)      AS expense_cost,
        COALESCE(pcs.total_cost, p.actual_cost, 0) AS total_cost
      FROM projects p
      LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
      WHERE ($1::int IS NULL OR p.company_id = $1)
        AND p.status IN ('active','planning','in_progress','in-progress')
      ORDER BY COALESCE(p.budget_amount, p.budget, 0) DESC
    `, [cid(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/costs/recalculate', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const costs = await recalculateProjectCost(req.params.id);
    await projectCostRepository.updateEVMMetrics(req.params.id);
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'project_cost', action: 'recalculate', newData: costs, req });
    res.json(costs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/costs', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const costs = await projectCostRepository.upsert(req.params.id, req.body);
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'project_cost', action: 'update', newData: costs, req });
    res.json(costs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Budget Lines (WBS-level) ──────────────────────────────────────────────────
router.get('/projects/:id/budget-lines', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM project_budget_lines WHERE project_id=$1 ORDER BY sequence, id`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/budget-lines', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const { wbs_code, category, description, budgeted_amount, sequence } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO project_budget_lines
         (project_id, company_id, wbs_code, category, description, budgeted_amount, sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, cid(req), wbs_code, category, description, budgeted_amount||0, sequence||0]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'budget_line', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/budget-lines/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const { wbs_code, category, description, budgeted_amount, actual_amount, sequence } = req.body;
    const { rows } = await pool.query(
      `UPDATE project_budget_lines SET
         wbs_code=$1, category=$2, description=$3, budgeted_amount=$4,
         actual_amount=$5, variance=$4-$5, sequence=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [wbs_code, category, description, budgeted_amount||0, actual_amount||0, sequence||0, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/budget-lines/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM project_budget_lines WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Budget line deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Team members ──────────────────────────────────────────────────────────────
router.get('/projects/:id/members', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pm.*, pm.role_in_project AS role, pm.allocation_pct AS allocation_percentage,
              e.first_name || ' ' || e.last_name AS name, e.designation, e.department
       FROM project_members pm
       LEFT JOIN employees e ON e.id = pm.employee_id
       WHERE pm.project_id = $1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id = $1 AND ($2::int IS NULL OR p.company_id = $2))
       ORDER BY pm.created_at`,
      [req.params.id, cid(req)]
    );
    res.json({ members: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/resources', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Project not found in your company' });
    const { employee_id, role, allocation_pct, billing_rate, is_billable, start_date, end_date } = req.body;
    // project_members is the canonical team table (role_in_project / allocation_pct);
    // the old `project_resources` twin was never created in this schema.
    const { rows } = await pool.query(
      `INSERT INTO project_members
         (company_id, project_id, employee_id, role_in_project, allocation_pct, billing_rate, is_billable, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (project_id, employee_id) DO UPDATE SET
         role_in_project=EXCLUDED.role_in_project, allocation_pct=EXCLUDED.allocation_pct,
         billing_rate=EXCLUDED.billing_rate, is_billable=EXCLUDED.is_billable,
         start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date, updated_at=NOW()
       RETURNING *`,
      [cid(req), req.params.id, employee_id, role || 'Member', allocation_pct||100, billing_rate||0, is_billable??true, start_date||null, end_date||null]
    );

    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'project_member', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/:id/resources/:employee_id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM project_members WHERE project_id=$1 AND employee_id=$2 AND ($3::int IS NULL OR company_id=$3)`,
      [req.params.id, req.params.employee_id, cid(req)]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'project_member', action: 'delete', req });
    res.json({ message: 'Member removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Milestones ────────────────────────────────────────────────────────────────
router.get('/projects/:id/milestones', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pm.*, e.first_name||' '||e.last_name AS owner_name
       FROM project_milestones pm
       LEFT JOIN employees e ON e.id = pm.owner_id
       WHERE pm.project_id = $1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2))
       ORDER BY pm.due_date`,
      [req.params.id, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/milestones', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Project not found in your company' });
    const { name, due_date, billing_milestone, amount, owner_id, description } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO project_milestones
         (project_id, title, due_date, status, description, billing_milestone, amount, owner_id)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7) RETURNING *`,
      [req.params.id, name, due_date||null, description||null,
       billing_milestone||false, amount||0, owner_id||null]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'milestone', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/milestones/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const { title, due_date, billing_milestone, amount, owner_id, description, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE project_milestones
       SET title=$1, due_date=$2, billing_milestone=$3, amount=$4,
           owner_id=$5, description=$6, status=COALESCE($7,status), updated_at=NOW()
       WHERE id=$8
         AND EXISTS (
           SELECT 1 FROM projects p WHERE p.id=project_id AND ($9::int IS NULL OR p.company_id=$9)
         )
       RETURNING *`,
      [title, due_date||null, billing_milestone||false, amount||0,
       owner_id||null, description||null, status||null, req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Milestone not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/milestones/:id/complete', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE project_milestones pm SET status='completed', completed_date=CURRENT_DATE
       WHERE pm.id=$1
         AND EXISTS (
           SELECT 1 FROM projects p WHERE p.id=pm.project_id AND ($2::int IS NULL OR p.company_id=$2)
         )
       RETURNING *`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Milestone not found' });
    const milestone = rows[0];

    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'milestone', action: 'complete', newData: milestone, req });

    let invoice_created = false;
    let invoice = null;

    // Auto-create sales invoice for billing milestones
    if (milestone.billing_milestone && parseFloat(milestone.amount) > 0) {
      try {
        const projectRes = await pool.query(
          `SELECT p.*, c.client_name AS customer_name_alt FROM projects p
           LEFT JOIN clients c ON c.id=p.client_id
           WHERE p.id=$1`,
          [milestone.project_id]
        );
        const project = projectRes.rows[0];
        const customerName = project?.customer_name || project?.client_name || project?.customer_name_alt || 'Customer';

        // Generate invoice number
        const invoiceNoRes = await pool.query(
          `SELECT COALESCE(MAX(CAST(NULLIF(REGEXP_REPLACE(invoice_number,'[^0-9]','','g'),'') AS INT)),0)+1 AS next
           FROM sales_invoices WHERE ($1::int IS NULL OR company_id=$1)`,
          [cid(req)]
        );
        const invoiceNo = `INV-${String(invoiceNoRes.rows[0]?.next || 1).padStart(5, '0')}`;

        const invoiceRes = await pool.query(
          `INSERT INTO sales_invoices
             (invoice_number, project_id, milestone_id, customer_name, invoice_date,
              due_date, subtotal, total_amount, status, notes, company_id, created_by)
           VALUES ($1,$2,$3,$4,CURRENT_DATE,CURRENT_DATE+30,$5,$5,'draft',
                   $6,$7,$8) RETURNING *`,
          [invoiceNo, milestone.project_id, milestone.id, customerName,
           milestone.amount,
           `Milestone: ${milestone.title} — Project: ${project?.project_name || ''}`,
           cid(req), uid(req)]
        ).catch(() => null);

        if (invoiceRes?.rows[0]) {
          invoice = invoiceRes.rows[0];
          invoice_created = true;
          await pool.query(
            `UPDATE project_milestones SET invoice_id=$1, invoice_created=true WHERE id=$2`,
            [invoice.id, milestone.id]
          );
        }
      } catch (e) {
        console.error('[milestone] invoice creation failed:', e.message);
      }
    }

    res.json({ milestone, invoice_created, invoice });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/milestones/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM project_milestones pm WHERE pm.id=$1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=pm.project_id AND ($2::int IS NULL OR p.company_id=$2))
       RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Milestone not found' });
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'milestone', action: 'delete', req });
    res.json({ message: 'Milestone deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Risks ─────────────────────────────────────────────────────────────────────
router.get('/projects/:id/risks', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, e.first_name||' '||e.last_name AS owner_name
       FROM project_risks pr
       LEFT JOIN employees e ON e.id=pr.owner_id
       WHERE pr.project_id=$1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2))
       ORDER BY pr.risk_score DESC, pr.created_at DESC`,
      [req.params.id, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/risks', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Project not found in your company' });
    const PROB = { low: 1, medium: 2, high: 4 };
    const IMP  = { low: 1, medium: 2, high: 4 };
    const { title, description, category, probability, impact, mitigation_plan, contingency_plan, owner_id, review_date } = req.body;
    const score = (PROB[probability] || 2) * (IMP[impact] || 2);
    const riskCode = `RSK-${Date.now().toString().slice(-6)}`;
    const { rows } = await pool.query(
      `INSERT INTO project_risks
         (project_id, company_id, risk_code, title, description, category,
          probability, impact, risk_score, mitigation_plan, contingency_plan, owner_id, review_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.params.id, cid(req), riskCode, title, description||null, category||'technical',
       probability||'medium', impact||'medium', score, mitigation_plan||null,
       contingency_plan||null, owner_id||null, review_date||null]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'risk', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/risks/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const PROB = { low: 1, medium: 2, high: 4 };
    const IMP  = { low: 1, medium: 2, high: 4 };
    const { title, description, category, probability, impact, status, mitigation_plan, contingency_plan, owner_id, review_date, closed_date } = req.body;
    const score = (PROB[probability] || 2) * (IMP[impact] || 2);
    const { rows } = await pool.query(
      `UPDATE project_risks SET
         title=$1, description=$2, category=$3, probability=$4, impact=$5,
         risk_score=$6, status=$7, mitigation_plan=$8, contingency_plan=$9,
         owner_id=$10, review_date=$11, closed_date=$12, updated_at=NOW()
       WHERE id=$13
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=project_id AND ($14::int IS NULL OR p.company_id=$14))
       RETURNING *`,
      [title, description||null, category||'technical', probability||'medium', impact||'medium',
       score, status||'open', mitigation_plan||null, contingency_plan||null,
       owner_id||null, review_date||null, closed_date||null, req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Risk not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/risks/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM project_risks pr WHERE pr.id=$1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=pr.project_id AND ($2::int IS NULL OR p.company_id=$2))
       RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Risk not found' });
    res.json({ message: 'Risk deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Issues (full issue management) ───────────────────────────────────────────
router.get('/projects/:id/issues', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { status } = req.query;
    const params = [req.params.id, cid(req)];
    let q = `
      SELECT pi.*,
             rb.first_name||' '||rb.last_name AS raised_by_name,
             at.first_name||' '||at.last_name AS assigned_to_name
      FROM project_issues pi
      LEFT JOIN employees rb ON rb.id=pi.raised_by
      LEFT JOIN employees at ON at.id=pi.assigned_to
      WHERE pi.project_id=$1
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2))
    `;
    if (status) { q += ` AND pi.status=$${params.push(status)}`; }
    q += ' ORDER BY pi.severity DESC, pi.created_at DESC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/issues', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Project not found in your company' });
    const {
      title, description, issue_type, severity, priority,
      assigned_to, task_id, due_date, is_blocker, root_cause,
    } = req.body;
    const issueCode = `ISS-${Date.now().toString().slice(-6)}`;
    const { rows } = await pool.query(
      `INSERT INTO project_issues
         (project_id, company_id, issue_code, title, description, issue_type,
          severity, priority, raised_by, assigned_to, task_id, due_date,
          is_blocker, root_cause)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.params.id, cid(req), issueCode, title, description||null,
       issue_type||'general', severity||'medium', priority||'medium',
       uid(req), assigned_to||null, task_id||null, due_date||null,
       is_blocker||false, root_cause||null]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'issue', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/issues/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const {
      title, description, issue_type, severity, priority, status,
      assigned_to, due_date, resolution, root_cause, is_blocker, ncr_raised, ncr_reference,
    } = req.body;
    const resolved_date = ['resolved', 'closed'].includes(status) ? new Date().toISOString().slice(0, 10) : null;
    const { rows } = await pool.query(
      `UPDATE project_issues SET
         title=$1, description=$2, issue_type=$3, severity=$4, priority=$5, status=$6,
         assigned_to=$7, due_date=$8, resolution=$9, root_cause=$10, is_blocker=$11,
         ncr_raised=$12, ncr_reference=$13, resolved_date=COALESCE($14,resolved_date), updated_at=NOW()
       WHERE id=$15
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=project_id AND ($16::int IS NULL OR p.company_id=$16))
       RETURNING *`,
      [title, description||null, issue_type||'general', severity||'medium', priority||'medium',
       status||'open', assigned_to||null, due_date||null, resolution||null, root_cause||null,
       is_blocker||false, ncr_raised||false, ncr_reference||null, resolved_date,
       req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Issue not found' });
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'issue', action: 'update', newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/issues/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM project_issues pi WHERE pi.id=$1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=pi.project_id AND ($2::int IS NULL OR p.company_id=$2))
       RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Issue not found' });
    res.json({ message: 'Issue deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FAT Tracker ───────────────────────────────────────────────────────────────
router.get('/projects/:id/fat', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ft.*, e.first_name||' '||e.last_name AS engineer_display_name
       FROM fat_trackers ft
       LEFT JOIN employees e ON e.id=ft.created_by
       WHERE ft.project_id=$1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2))
       ORDER BY ft.scheduled_date DESC`,
      [req.params.id, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/fat', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Project not found in your company' });
    const {
      serial_number, product_name, scheduled_date, actual_date, status,
      test_location, client_witness, engineer_name, test_parameters, punch_points, remarks,
      production_order_id,
    } = req.body;
    const fatNo = `FAT-${Date.now().toString().slice(-6)}`;
    const { rows } = await pool.query(
      `INSERT INTO fat_trackers
         (project_id, company_id, production_order_id, fat_number, serial_number, product_name,
          scheduled_date, actual_date, status, test_location, client_witness, engineer_name,
          test_parameters, punch_points, remarks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [req.params.id, cid(req), production_order_id||null, fatNo, serial_number||null,
       product_name||null, scheduled_date||null, actual_date||null, status||'scheduled',
       test_location||null, client_witness||null, engineer_name||null,
       JSON.stringify(test_parameters||[]), JSON.stringify(punch_points||[]),
       remarks||null, uid(req)]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'fat', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/fat/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const {
      serial_number, product_name, scheduled_date, actual_date, status,
      test_location, client_witness, engineer_name, test_parameters, punch_points, remarks,
      failure_description, retest_date, certificate_number, certificate_date,
    } = req.body;
    const { rows } = await pool.query(
      `UPDATE fat_trackers SET
         serial_number=$1, product_name=$2, scheduled_date=$3, actual_date=$4,
         status=$5, test_location=$6, client_witness=$7, engineer_name=$8,
         test_parameters=$9, punch_points=$10, remarks=$11,
         failure_description=$12, retest_date=$13, certificate_number=$14,
         certificate_date=$15, updated_at=NOW()
       WHERE id=$16
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=project_id AND ($17::int IS NULL OR p.company_id=$17))
       RETURNING *`,
      [serial_number||null, product_name||null, scheduled_date||null, actual_date||null,
       status||'scheduled', test_location||null, client_witness||null, engineer_name||null,
       JSON.stringify(test_parameters||[]), JSON.stringify(punch_points||[]), remarks||null,
       failure_description||null, retest_date||null, certificate_number||null, certificate_date||null,
       req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'FAT not found' });

    // Notify on FAT pass/fail
    if (['passed','failed','fail'].includes((status||'').toLowerCase())) {
      import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
        const event = ['passed','completed'].includes((status||'').toLowerCase()) ? 'approved' : 'rejected';
        notifyWorkflowEvent(event, { module: 'FAT', recordId: rows[0].id, submitterId: uid(req), recipientIds: [] }).catch(() => {});
      }).catch(() => {});
    }

    // Auto-upload FAT report to Drive when status is passed/completed
    if (drive.isDriveConfigured() && ['passed','completed'].includes((status||'').toLowerCase())) {
      const projRes = await pool.query(
        `SELECT COALESCE(customer_name, client_name) AS cname FROM projects WHERE id=$1`,
        [rows[0].project_id]
      );
      const customerName = projRes.rows[0]?.cname;
      if (customerName) {
        drive.uploadJsonRecord({
          data:         rows[0],
          fileName:     `FAT-Report-${rows[0].id}-${rows[0].certificate_number || Date.now()}.json`,
          customerName,
          docType:      drive.DOC_TYPES.FAT_REPORT,
          companyId:    cid(req),
        }).then(driveRes =>
          pool.query(
            `UPDATE fat_trackers SET drive_file_id=$1, drive_link=$2, updated_at=NOW() WHERE id=$3`,
            [driveRes.drive_file_id, driveRes.drive_link, rows[0].id]
          )
        ).catch(e => console.error('[FAT/drive]', e.message));
      }
    }

    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SAT Tracker ───────────────────────────────────────────────────────────────
router.get('/projects/:id/sat', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM sat_trackers
       WHERE project_id=$1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2))
       ORDER BY scheduled_date DESC`,
      [req.params.id, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/sat', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Project not found in your company' });
    const {
      serial_number, product_name, site_name, site_address, scheduled_date, actual_date,
      status, client_representative, client_witness_designation, engineer_name,
      test_parameters, punch_points, remarks, commissioning_report_id,
    } = req.body;
    const satNo = `SAT-${Date.now().toString().slice(-6)}`;
    const { rows } = await pool.query(
      `INSERT INTO sat_trackers
         (project_id, company_id, commissioning_report_id, sat_number, serial_number, product_name,
          site_name, site_address, scheduled_date, actual_date, status,
          client_representative, client_witness_designation, engineer_name,
          test_parameters, punch_points, remarks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [req.params.id, cid(req), commissioning_report_id||null, satNo, serial_number||null,
       product_name||null, site_name||null, site_address||null, scheduled_date||null,
       actual_date||null, status||'scheduled', client_representative||null,
       client_witness_designation||null, engineer_name||null,
       JSON.stringify(test_parameters||[]), JSON.stringify(punch_points||[]),
       remarks||null, uid(req)]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'sat', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/sat/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const {
      serial_number, product_name, site_name, site_address, scheduled_date, actual_date,
      status, client_representative, client_witness_designation, engineer_name,
      test_parameters, punch_points, remarks, failure_description, retest_date,
      certificate_number, certificate_date, client_signed_off, client_signoff_date,
    } = req.body;
    const { rows } = await pool.query(
      `UPDATE sat_trackers SET
         serial_number=$1, product_name=$2, site_name=$3, site_address=$4,
         scheduled_date=$5, actual_date=$6, status=$7,
         client_representative=$8, client_witness_designation=$9, engineer_name=$10,
         test_parameters=$11, punch_points=$12, remarks=$13,
         failure_description=$14, retest_date=$15,
         certificate_number=$16, certificate_date=$17,
         client_signed_off=$18, client_signoff_date=$19, updated_at=NOW()
       WHERE id=$20
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=project_id AND ($21::int IS NULL OR p.company_id=$21))
       RETURNING *`,
      [serial_number||null, product_name||null, site_name||null, site_address||null,
       scheduled_date||null, actual_date||null, status||'scheduled',
       client_representative||null, client_witness_designation||null, engineer_name||null,
       JSON.stringify(test_parameters||[]), JSON.stringify(punch_points||[]), remarks||null,
       failure_description||null, retest_date||null,
       certificate_number||null, certificate_date||null,
       client_signed_off||false, client_signoff_date||null,
       req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'SAT not found' });

    // Notify on SAT pass/fail
    if (['passed','failed','fail'].includes((status||'').toLowerCase())) {
      import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
        const event = ['passed','completed'].includes((status||'').toLowerCase()) ? 'approved' : 'rejected';
        notifyWorkflowEvent(event, { module: 'SAT', recordId: rows[0].id, submitterId: uid(req), recipientIds: [] }).catch(() => {});
      }).catch(() => {});
    }

    // Auto-upload SAT report to Drive when client signs off or status is passed
    if (drive.isDriveConfigured() && (client_signed_off || ['passed','completed'].includes((status||'').toLowerCase()))) {
      const projRes = await pool.query(
        `SELECT COALESCE(customer_name, client_name) AS cname FROM projects WHERE id=$1`,
        [rows[0].project_id]
      );
      const customerName = projRes.rows[0]?.cname;
      if (customerName) {
        drive.uploadJsonRecord({
          data:         rows[0],
          fileName:     `SAT-Report-${rows[0].id}-${rows[0].certificate_number || Date.now()}.json`,
          customerName,
          docType:      drive.DOC_TYPES.SAT_REPORT,
          companyId:    cid(req),
        }).then(driveRes =>
          pool.query(
            `UPDATE sat_trackers SET drive_file_id=$1, drive_link=$2, updated_at=NOW() WHERE id=$3`,
            [driveRes.drive_file_id, driveRes.drive_link, rows[0].id]
          )
        ).catch(e => console.error('[SAT/drive]', e.message));
      }
    }

    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Warranties ────────────────────────────────────────────────────────────────
router.get('/projects/:id/warranties', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pw.*,
              CASE WHEN pw.warranty_end_date >= CURRENT_DATE THEN 'active' ELSE 'expired' END AS computed_status
       FROM project_warranties pw
       WHERE pw.project_id=$1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2))
       ORDER BY pw.warranty_end_date DESC`,
      [req.params.id, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/warranties', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Project not found in your company' });
    const {
      serial_number, product_name, commissioning_date, warranty_start_date,
      warranty_months, warranty_type, warranty_terms, exclusions,
    } = req.body;
    const months = parseInt(warranty_months) || 12;
    const startDate = warranty_start_date || commissioning_date || new Date().toISOString().slice(0, 10);
    const endDate = new Date(new Date(startDate).setMonth(new Date(startDate).getMonth() + months))
      .toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `INSERT INTO project_warranties
         (project_id, company_id, serial_number, product_name, commissioning_date,
          warranty_start_date, warranty_end_date, warranty_months, warranty_type,
          warranty_terms, exclusions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, cid(req), serial_number||null, product_name||null,
       commissioning_date||null, startDate, endDate, months,
       warranty_type||'standard', warranty_terms||null, exclusions||null]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'warranty', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Documents ─────────────────────────────────────────────────────────────────
router.get('/projects/:id/documents', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pd.*, e.first_name||' '||e.last_name AS uploaded_by_name
       FROM project_documents pd
       LEFT JOIN employees e ON e.id=pd.uploaded_by
       WHERE pd.project_id=$1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2))
       ORDER BY pd.created_at DESC`,
      [req.params.id, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/documents', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const {
      document_name, document_type, document_number, revision,
      file_url, file_name, mime_type, file_size, description,
    } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO project_documents
         (project_id, company_id, document_name, document_type, document_number,
          revision, file_url, file_name, mime_type, file_size, description, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.params.id, cid(req), document_name, document_type||'general',
       document_number||null, revision||null, file_url||null, file_name||null,
       mime_type||null, file_size||0, description||null, uid(req)]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'document', action: 'upload', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/documents/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM project_documents WHERE id=$1`, [req.params.id]);
    res.json({ message: 'Document deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Project Timesheets ─────────────────────────────────────────────────────────
router.get('/projects/:id/timesheets', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT te.*,
              e.first_name||' '||e.last_name AS employee_name,
              e.designation,
              COALESCE(pm.billing_rate, 0) AS billing_rate,
              COALESCE(te.hours, te.hours_worked, 0) * COALESCE(pm.billing_rate, 500) AS billable_amount
       FROM timesheet_entries te
       LEFT JOIN employees e ON e.id=te.employee_id
       LEFT JOIN project_members pm ON pm.project_id=$1 AND pm.employee_id=te.employee_id
       WHERE te.project_id=$1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2))
       ORDER BY te.created_at DESC`,
      [req.params.id, cid(req)]
    );
    const totalHours = rows.reduce((s, r) => s + parseFloat(r.hours || r.hours_worked || 0), 0);
    const totalBillable = rows.reduce((s, r) => s + parseFloat(r.billable_amount || 0), 0);
    res.json({ entries: rows, summary: { total_entries: rows.length, total_hours: totalHours, total_billable: totalBillable } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Project Invoices ──────────────────────────────────────────────────────────
router.get('/projects/:id/invoices', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT si.*, pm.title AS milestone_title
       FROM sales_invoices si
       LEFT JOIN project_milestones pm ON pm.id=si.milestone_id
       WHERE si.project_id=$1
         AND ($2::int IS NULL OR si.company_id=$2)
       ORDER BY si.invoice_date DESC`,
      [req.params.id, cid(req)]
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Capacity overview ─────────────────────────────────────────────────────────
router.get('/capacity/overview', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { week_start } = req.query;
    const weekStart = week_start ? new Date(week_start) : new Date();
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const { rows } = await pool.query(`
      SELECT
        e.id AS employee_id,
        e.first_name||' '||e.last_name AS employee_name,
        e.designation,
        e.department AS department,
        COALESCE(SUM(pr.allocation_pct), 0)::int AS total_allocation,
        COUNT(DISTINCT pr.project_id)::int AS project_count,
        CASE
          WHEN COALESCE(SUM(pr.allocation_pct), 0) > 100 THEN 'over'
          WHEN COALESCE(SUM(pr.allocation_pct), 0) = 100  THEN 'full'
          WHEN COALESCE(SUM(pr.allocation_pct), 0) > 0    THEN 'partial'
          ELSE 'available'
        END AS status,
        COALESCE(json_agg(
          json_build_object(
            'project_name', p.project_name,
            'allocation_pct', pr.allocation_pct,
            'start_date', pr.start_date,
            'end_date', pr.end_date
          )
        ) FILTER (WHERE pr.project_id IS NOT NULL), '[]') AS projects,
        COALESCE(MAX(pr.billing_rate), 0) AS billing_rate
      FROM employees e
      LEFT JOIN project_members pr ON pr.employee_id=e.id
        AND (pr.start_date IS NULL OR pr.start_date <= $2::date)
        AND (pr.end_date IS NULL OR pr.end_date >= $1::date)
      LEFT JOIN projects p ON p.id=pr.project_id
      WHERE e.deleted_at IS NULL
        -- match the same "active workforce" definition as GET /projects/employees
        -- (case-insensitive, NULL-safe) instead of a case-sensitive whitelist
        AND LOWER(COALESCE(e.status,'active')) NOT IN ('left','terminated','resigned','inactive','ex-employee','notice_period')
        AND ($3::int IS NULL OR e.company_id=$3)
      GROUP BY e.id, e.first_name, e.last_name, e.designation, e.department
      ORDER BY total_allocation DESC
    `, [weekStart.toISOString().slice(0, 10), weekEnd.toISOString().slice(0, 10), cid(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── S-Curve data ──────────────────────────────────────────────────────────────
router.get('/projects/:id/scurve', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM project_scurve_data WHERE project_id=$1 ORDER BY period ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Installation dashboard (enhanced) ─────────────────────────────────────────
router.get('/installation-dashboard', requirePermission('projects', 'view'), async (req, res) => {
  try {
    // ── Shared WHERE builder ────────────────────────────────────────────────
    // $1 is always company_id (NULL = superadmin cross-company). Optional filters
    // (customer / zone / project_type / financial year) append positional params
    // so the main and fallback queries stay in lock-step and never drift.
    const params = [cid(req)];
    const conds = [
      `($1::int IS NULL OR p.company_id=$1)`,
      `(p.project_type IN ('EPC','Installation','Commissioning','HVDC','STATCOM','SST','O&M')
        OR p.status IN ('active','planning'))`,
    ];

    const { customer, zone, project_type, fy } = req.query;
    if (customer && customer !== 'all') {
      params.push(customer);
      conds.push(`COALESCE(p.customer_name, p.client_name) = $${params.length}`);
    }
    if (zone && zone !== 'all') {
      params.push(zone);
      conds.push(`p.zone = $${params.length}`);
    }
    if (project_type && project_type !== 'all') {
      params.push(project_type);
      conds.push(`p.project_type = $${params.length}`);
    }
    // Indian FY: `fy=2026` means 01 Apr 2026 → 31 Mar 2027. Overlap semantics,
    // NULL-date tolerant (a project with no dates is never filtered out).
    if (fy && /^\d{4}$/.test(String(fy))) {
      const y = Number(fy);
      params.push(`${y}-04-01`);       const fyStart = params.length;
      params.push(`${y + 1}-03-31`);   const fyEnd = params.length;
      conds.push(`(p.start_date IS NULL OR p.start_date <= $${fyEnd})
                  AND (p.end_date IS NULL OR p.end_date >= $${fyStart})`);
    }
    const whereSql = conds.join('\n        AND ');

    const { rows } = await pool.query(`
      SELECT
        p.id, p.project_code, p.project_name, p.status, p.start_date, p.end_date,
        COALESCE(p.budget_amount, p.budget, 0) AS contract_value,
        COALESCE(p.actual_cost, 0) AS actual_cost,
        COALESCE(p.customer_name, p.client_name) AS customer_name,
        COALESCE(p.progress_percentage, 0) AS completion_percentage,
        p.project_type,
        p.zone, p.site_city, p.site_address, p.latitude, p.longitude,
        li.current_stage AS lifecycle_stage,
        (SELECT COUNT(*) FROM sat_trackers st WHERE st.project_id=p.id) AS sat_count,
        (SELECT COUNT(*) FROM sat_trackers st WHERE st.project_id=p.id AND st.status='passed') AS sat_passed,
        (SELECT COUNT(*) FROM fat_trackers ft WHERE ft.project_id=p.id) AS fat_count,
        (SELECT COUNT(*) FROM fat_trackers ft WHERE ft.project_id=p.id AND ft.status='passed') AS fat_passed,
        cr.status AS commissioning_status,
        cr.commissioning_date
      FROM projects p
      LEFT JOIN lifecycle_instances li ON li.project_id=p.id AND li.status='active'
      LEFT JOIN commissioning_reports cr ON cr.project_id=p.id
      WHERE ${whereSql}
      ORDER BY p.created_at DESC LIMIT 100
    `, params).catch(() => pool.query(
      // Degraded mode if the tracker/lifecycle joins are unavailable — same
      // filters and geo columns, just without the commissioning/SAT/FAT enrich.
      `SELECT p.id, p.project_code, p.project_name, p.status, p.start_date, p.end_date,
              COALESCE(p.budget_amount, p.budget, 0) AS contract_value,
              COALESCE(p.customer_name, p.client_name) AS customer_name,
              COALESCE(p.progress_percentage, 0) AS completion_percentage,
              p.project_type, p.zone, p.site_city, p.site_address, p.latitude, p.longitude
       FROM projects p
       WHERE ${whereSql}
       ORDER BY p.created_at DESC LIMIT 100`,
      params
    ));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Installation dashboard filter options ─────────────────────────────────────
// Distinct customers / zones / types present in the installation set, so the
// filter dropdowns stay stable regardless of which filter is currently applied
// (deriving them from the filtered rows would make options vanish as you filter).
router.get('/installation-dashboard/filters', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const scope = `($1::int IS NULL OR p.company_id=$1)
      AND (p.project_type IN ('EPC','Installation','Commissioning','HVDC','STATCOM','SST','O&M')
       OR p.status IN ('active','planning'))`;
    const [cust, zones, types] = await Promise.all([
      pool.query(`SELECT DISTINCT COALESCE(p.customer_name, p.client_name) AS v FROM projects p
                   WHERE ${scope} AND COALESCE(p.customer_name, p.client_name) IS NOT NULL
                   ORDER BY v`, [cid(req)]).catch(() => ({ rows: [] })),
      pool.query(`SELECT DISTINCT p.zone AS v FROM projects p
                   WHERE ${scope} AND p.zone IS NOT NULL AND TRIM(p.zone) <> ''
                   ORDER BY v`, [cid(req)]).catch(() => ({ rows: [] })),
      pool.query(`SELECT DISTINCT p.project_type AS v FROM projects p
                   WHERE ${scope} AND p.project_type IS NOT NULL
                   ORDER BY v`, [cid(req)]).catch(() => ({ rows: [] })),
    ]);
    res.json({
      customers: cust.rows.map(r => r.v),
      zones: zones.rows.map(r => r.v),
      project_types: types.rows.map(r => r.v),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Project master (categories/types lookup) ──────────────────────────────────
// ── Status Report ─────────────────────────────────────────────────────────────
router.get('/projects/:id/status-report', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const [projRes, mileRes, riskRes, costRes] = await Promise.allSettled([
      pool.query(`SELECT * FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`, [req.params.id, cid(req)]),
      pool.query(`SELECT name, status, due_date FROM project_milestones WHERE project_id=$1 ORDER BY due_date DESC LIMIT 5`, [req.params.id]).catch(() => ({ rows: [] })),
      pool.query(`SELECT risk_code, description, status, probability*impact AS score FROM project_risks WHERE project_id=$1 AND status='open' ORDER BY probability*impact DESC LIMIT 5`, [req.params.id]).catch(() => ({ rows: [] })),
      pool.query(`SELECT total_budget, actual_cost, labour_cost, material_cost, revenue, profit, margin_pct, planned_value, earned_value, cost_performance_index, schedule_performance_index FROM project_cost_summary WHERE project_id=$1`, [req.params.id]).catch(() => ({ rows: [] })),
    ]);
    const project  = projRes.status === 'fulfilled'  ? projRes.value.rows[0]  : null;
    const recent_milestones = mileRes.status === 'fulfilled' ? mileRes.value.rows : [];
    const risks    = riskRes.status === 'fulfilled'  ? riskRes.value.rows   : [];
    const costing  = costRes.status === 'fulfilled'  ? costRes.value.rows[0] : null;

    if (!project) return res.status(404).json({ error: 'Project not found' });

    const liRes = await pool.query(
      `SELECT current_stage FROM lifecycle_instances WHERE project_id=$1 AND status='active' LIMIT 1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));

    res.json({
      report: {
        project_id: req.params.id,
        current_stage: liRes.rows[0]?.current_stage || project.current_stage || 'N/A',
        progress_percentage: project.progress_percentage || 0,
        budget_utilization: project.budget_amount > 0
          ? Math.round((project.actual_cost || 0) / project.budget_amount * 100)
          : 0,
        recent_milestones,
        risks,
        costing,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Global warranties list (all projects) ─────────────────────────────────────
router.get('/warranties', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pw.*,
              p.project_code, p.project_name,
              CASE
                WHEN pw.status IS NOT NULL THEN pw.status
                WHEN pw.warranty_end_date >= CURRENT_DATE THEN 'active'
                ELSE 'expired'
              END AS computed_status
       FROM project_warranties pw
       JOIN projects p ON p.id = pw.project_id
       WHERE ($1::int IS NULL OR pw.company_id = $1)
       ORDER BY pw.warranty_end_date ASC`,
      [cid(req)]
    ).catch(() => ({ rows: [] }));
    res.json({ warranties: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Global warranty update ────────────────────────────────────────────────────
router.put('/warranties/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const { product_name, serial_number, commissioning_date, warranty_start_date,
            warranty_end_date, warranty_type, coverage_description, exclusions, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE project_warranties
       SET product_name=$1, serial_number=$2, commissioning_date=$3,
           warranty_start_date=$4, warranty_end_date=$5, warranty_type=$6,
           coverage_description=$7, exclusions=$8, status=$9, updated_at=NOW()
       WHERE id=$10 AND ($11::int IS NULL OR company_id=$11)
       RETURNING *`,
      [product_name, serial_number||null, commissioning_date||null,
       warranty_start_date||null, warranty_end_date||null, warranty_type||'comprehensive',
       coverage_description||null, exclusions||null, status||'active',
       req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Warranty not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Upload BOM list ───────────────────────────────────────────────────────────
router.get('/upload-bom', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, project_code, project_name, status FROM projects
       WHERE ($1::int IS NULL OR company_id=$1) ORDER BY project_name LIMIT 200`,
      [cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Project settings ──────────────────────────────────────────────────────────
router.get('/settings', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT settings_data FROM module_settings WHERE module_name='projects' AND ($1::int IS NULL OR company_id=$1) LIMIT 1`,
      [cid(req)]
    );
    res.json(rows[0]?.settings_data || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO module_settings (module_name, settings_data, company_id)
       VALUES ('projects', $1, $2)
       ON CONFLICT (module_name, company_id) DO UPDATE SET settings_data=$1, updated_at=NOW()`,
      [JSON.stringify(req.body), cid(req)]
    );
    res.json({ message: 'Settings saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
