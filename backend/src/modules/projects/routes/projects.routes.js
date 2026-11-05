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
import { getProjectClosureBlockers as getClosureBlockers } from '../services/projectClosure.service.js';
import { projectLifecycleJoinSql, projectStageColumnsSql } from '../../../shared/projectStages.js';
import * as drive from '../../../services/googleDrive.service.js';
import invoiceService from '../../finance/services/invoice.service.js';
import { CLOSED_PROJECT_STATUSES } from '../projectStatus.js';
import { notifyWorkflowEvent } from '../../../services/WorkflowNotificationService.js';
import { resolveRange, dimension } from '../../../shared/dashboardFilters.js';
import { captureBefore } from '../../../middlewares/captureBefore.js';
import { nextWarrantyNumber, peekProjectCode } from '../../../shared/docNumber.js';
import {
  ensureProject, ProjectSetupError, setupErrorBody, projectReferenceError,
} from '../services/projectCreation.service.js';
// Shared Voice-of-Customer derivation — the project-closure mirror below writes
// voc_responses, so it must classify the same way servicedesk does. Was used and
// never imported, which made a project close with a rating answer 500.
import { deriveResponseFields } from '../../servicedesk/services/voc.service.js';

const router = express.Router();
const cid = (req) => req.scope?.company_id ?? null;
const uid = (req) => req.user?.userId ?? req.user?.id ?? null;

/**
 * project_risks.probability / .impact are VARCHAR(20) level labels, not numbers.
 * Maps a level column to an ordinal so a probability x impact score is possible
 * at all. Anything unrecognised scores 0 (NOT 1) so an unclassified risk cannot
 * masquerade as a low one — unmeasured is not the same as low.
 */
const RISK_LEVEL_ORDINAL = (col) => `(CASE LOWER(COALESCE(${col}, ''))
  WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 WHEN 'critical' THEN 4
  ELSE 0 END)`;

/**
 * One risk vocabulary for the whole module.
 *
 * There used to be two, and they disagreed. Reads scored labels through
 * RISK_LEVEL_ORDINAL above (low|medium|high|critical = 1|2|3|4), while writes
 * used a private `{ low: 1, medium: 2, high: 4 }` map with no 'critical' entry
 * at all — so the same risk scored differently depending on which path you came
 * through, and a risk saved as 'critical' fell to the `|| 2` default and was
 * stored as medium. These ordinals now match RISK_LEVEL_ORDINAL exactly, so
 * probability x impact lands in 1..16 either way.
 *
 * Numbers are accepted and banded, not dropped: Project Detail's form posted a
 * 1-5 integer, which matched no key in the old label map, so EVERY risk added
 * from that screen silently became medium x medium regardless of what the user
 * picked. The columns are VARCHAR(20) labels, so a number has to be banded to a
 * label to be stored at all.
 */
const RISK_ORDINAL = { low: 1, medium: 2, high: 3, critical: 4 };

function riskLevelOf(value, fallback = 'medium') {
  if (value == null || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  if (RISK_ORDINAL[raw]) return raw;
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (n <= 1) return 'low';
    if (n <= 2) return 'medium';
    if (n <= 3) return 'high';
    return 'critical';
  }
  return fallback;
}

/** probability x impact on the 1-4 ordinal, so risk_score is always 1..16. */
const riskScoreOf = (probability, impact) =>
  RISK_ORDINAL[riskLevelOf(probability)] * RISK_ORDINAL[riskLevelOf(impact)];

/** Surface a rejected allSettled leg instead of letting it read as "no rows". */
function settledRows(result, label) {
  if (result.status === 'fulfilled') return result.value.rows;
  console.error(`[projects] ${label} query failed:`, result.reason?.code, result.reason?.message);
  return [];
}

/**
 * Translate the dashboard filter contract (?period / ?from / ?to / dimensions)
 * into the repository's filter shape. Dimensions go through `dimension()` so the
 * "all" sentinel and blanks resolve to "unfiltered" rather than matching a
 * literal 'all' row.
 */
function projectListFilters(req) {
  const range = resolveRange(req.query, { defaultPeriod: 'all' });
  return {
    ...req.query,
    company_id: cid(req),
    status: dimension(req.query, 'status'),
    zone: dimension(req.query, 'zone'),
    project_type: dimension(req.query, 'project_type'),
    product_line_id: dimension(req.query, 'product_line_id'),
    date_from: range.from,
    date_to: range.to,
  };
}

// projects.created_by / tasks.created_by FK to employees(id) — resolve the
// acting user's employee id (uid() is a users.id, a different namespace).
// Returns null when the login isn't linked to an employee (column is nullable).
//
// The token's employee_id only. A company_email = login-email lookup used to
// back this up (unscoped, LIMIT 1), which let an HR edit of someone's company
// email decide whose name went on records this user created (2026-10-12).
function actingEmployeeId(req) {
  return req.user?.employee_id ?? null;
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
    const projects = await projectRepository.findAll(projectListFilters(req));
    res.json(projects);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Projects CRUD ─────────────────────────────────────────────────────────────
router.get('/projects', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const projects = await projectRepository.findAll(projectListFilters(req));
    res.json(projects);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/dashboard', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const dashboard = await projectRepository.getDashboard(cid(req));
    res.json(dashboard);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Preview for the create form. Gated like the create it serves, and does NOT
// consume the number: it used to call nextval() on every drawer open, burning
// a project code each time. The real code is assigned by POST /projects.
router.get('/projects/next-code', requirePermission('projects', 'add'), async (req, res) => {
  try {
    res.json({ code: await peekProjectCode() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Linked records a project may point at must be in the project's company.
 * Returns an error message, or null when the links are acceptable.
 *  - opportunity_id: must be an opportunity of `companyId`.
 *  - sales_order_ref: free text (it also holds MIS / customer PO references),
 *    so text that names no order is fine — but it must not name ANOTHER
 *    company's order, which Order History would then follow.
 * A null companyId (global caller on a company-less row) checks nothing.
 */
async function foreignProjectLink(companyId, { opportunity_id, sales_order_ref } = {}) {
  if (companyId == null) return null;
  if (opportunity_id !== undefined && opportunity_id !== null && opportunity_id !== '') {
    const { rows } = await pool.query(
      `SELECT 1 FROM opportunities WHERE id = $1 AND company_id = $2`,
      [parseInt(opportunity_id, 10) || 0, companyId]);
    if (!rows.length) return 'Opportunity not found in your company';
  }
  if (sales_order_ref !== undefined && sales_order_ref !== null && String(sales_order_ref).trim() !== '') {
    const { rows } = await pool.query(
      `SELECT 1 FROM sales_orders WHERE order_number = $1 AND company_id IS DISTINCT FROM $2 LIMIT 1`,
      [String(sales_order_ref).trim(), companyId]);
    if (rows.length) return 'Sales order not found in your company';
  }
  return null;
}

// Dimension options for the dashboard filter bar. Must stay ABOVE
// `/projects/:id` — Express matches in declaration order and the param route
// would otherwise swallow "filter-options" as an id.
// Distinct values are taken across ALL projects in scope, not the currently
// filtered set, so picking a zone doesn't empty the zone dropdown.
router.get('/projects/filter-options', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const scope = `p.deleted_at IS NULL AND ($1::int IS NULL OR p.company_id=$1)`;
    const distinct = (col) => pool
      .query(`SELECT DISTINCT ${col} AS v FROM projects p
               WHERE ${scope} AND ${col} IS NOT NULL AND TRIM(${col}) <> ''
               ORDER BY v`, [cid(req)])
      .catch(() => ({ rows: [] }));
    const [statuses, zones, types] = await Promise.all([
      distinct('p.status'), distinct('p.zone'), distinct('p.project_type'),
    ]);
    res.json({
      statuses: statuses.rows.map(r => r.v),
      zones: zones.rows.map(r => r.v),
      project_types: types.rows.map(r => r.v),
    });
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
    const { valid, errors } = await validate('projects', req.body, { partial: false });
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', errors });
    const foreign = await foreignProjectLink(cid(req), { opportunity_id: req.body.opportunity_id });
    if (foreign) return res.status(400).json({ error: foreign });
    if (cid(req) == null && req.scope?.isGlobal !== true) {
      return res.status(403).json({ error: 'No company is assigned to this login.' });
    }
    // Through the one project creator (projects/services/projectCreation.service.js),
    // in one transaction with the project's lifecycle. It assigns the code
    // (a custom code is kept), takes the company from the opportunity or the
    // caller (a global super admin names one), checks the project manager and
    // product line belong to it, requires a linked opportunity to be Won, and
    // refuses (409) a second project for the same opportunity.
    let project;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      ({ project } = await ensureProject(client, {
        opportunityId: req.body.opportunity_id || null,
        scopeCompanyId: cid(req),
        requestedCompanyId: req.body.company_id ?? null,
        attrs: req.body,
        actor: { userId: uid(req), employeeId: actingEmployeeId(req), name: req.user?.name || req.user?.email || null },
        onExistingProject: 'conflict',
      }));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err instanceof ProjectSetupError) return res.status(err.status).json(setupErrorBody(err));
      if (err.code === '23505' && err.constraint === 'projects_project_code_key') {
        return res.status(409).json({ error: `Project code ${req.body.project_code} is already in use` });
      }
      throw err;
    } finally {
      client.release();
    }
    // The same shape as GET /projects/:id, with the stage derived from the
    // lifecycle created with the project.
    project = (await projectRepository.findById(project.id, project.company_id)) || project;
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
    const { valid, errors } = await validate('projects', req.body, { partial: true });
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', errors });
    const oldProject = await projectRepository.findById(req.params.id, cid(req));
    // findById is company-scoped, so a miss means the project is another tenant's
    // (or gone). This previously fell through to an unscoped update — the write
    // landed on the other tenant's row. Fail closed, and scope the update too.
    if (!oldProject) return res.status(404).json({ error: 'Project not found' });
    // Only links that change are checked, so an unchanged legacy value can
    // still be saved back by the edit form.
    const changedLinks = {};
    if (req.body.opportunity_id !== undefined && String(req.body.opportunity_id ?? '') !== String(oldProject.opportunity_id ?? '')) {
      changedLinks.opportunity_id = req.body.opportunity_id;
    }
    if (req.body.sales_order_ref !== undefined && String(req.body.sales_order_ref ?? '') !== String(oldProject.sales_order_ref ?? '')) {
      changedLinks.sales_order_ref = req.body.sales_order_ref;
    }
    const foreign = await foreignProjectLink(oldProject.company_id ?? cid(req), changedLinks);
    if (foreign) return res.status(400).json({ error: foreign });
    // A changed project manager / product line must be in the project's company.
    const changedRefs = {};
    for (const k of ['project_manager_id', 'product_line_id']) {
      if (req.body[k] !== undefined && String(req.body[k] ?? '') !== String(oldProject[k] ?? '')) changedRefs[k] = req.body[k];
    }
    const refError = await projectReferenceError(pool, oldProject.company_id ?? null, changedRefs);
    if (refError) return res.status(400).json({ error: refError });
    // One project per opportunity: re-pointing this project at an opportunity
    // that already has another live project would make a duplicate.
    if (changedLinks.opportunity_id) {
      const { rows: taken } = await pool.query(
        `SELECT id, project_code FROM projects
          WHERE opportunity_id = $1 AND deleted_at IS NULL AND id <> $2 LIMIT 1`,
        [parseInt(changedLinks.opportunity_id, 10) || 0, oldProject.id]);
      if (taken.length) {
        return res.status(409).json({
          error: `Opportunity already has project ${taken[0].project_code}`, code: 'PROJECT_EXISTS', project_id: taken[0].id,
        });
      }
    }
    if (oldProject.status !== 'completed' && req.body.status === 'completed' && !req.body.force_complete) {
      const blockers = await getProjectClosureBlockers(req.params.id);
      if (blockers.length) {
        const parts = blockers.map(b => `${b.count} ${b.type.replace(/_/g, ' ')}`);
        return res.status(400).json({
          error: `Project is not ready to close: ${parts.join(', ')}.`,
          code: 'CLOSURE_NOT_READY',
          blockers,
        });
      }
    }
    const project = await projectRepository.update(req.params.id, req.body, cid(req));
    if (oldProject?.status !== 'completed' && project?.status === 'completed') {
      await recalculateProjectCost(req.params.id).catch(e =>
        console.error('[projects] cost rollup failed:', e.message)
      );
      // Last of voc.routes.js's three documented trigger events to actually
      // fire ('commissioning' and 'service_visit'/'amc_visit' wired
      // separately). Only mirrors when the caller actually included a
      // rating on this same closing request — projects has no other form
      // that collects one, so this is opt-in, not a second required step.
      // project.customer_name has no real parties FK (free-text, same as
      // client_name) — voc_responses.customer_name is free-text too, so no
      // resolution is needed here.
      if (req.body.customer_rating) {
        pool.query(
          // See voc.service.js — a rating-only response used to be invisible to
          // every Voice-of-Customer KPI.
          `INSERT INTO voc_responses
             (company_id, trigger_event, trigger_ref_id, customer_name, project_id, rating, suggestions,
              sentiment, classification, submitted_at)
           VALUES ($1,'project_closure',$2,$3,$2,$4,$5,$6,$7,NOW())`,
          [cid(req), req.params.id, project.customer_name || project.client_name || null,
           req.body.customer_rating, req.body.customer_feedback || null,
           ...(({ sentiment, classification }) => [sentiment, classification])(
             deriveResponseFields({ rating: req.body.customer_rating, suggestions: req.body.customer_feedback }))]
        ).catch(e => console.error('[projects/:id] voc_responses mirror failed:', e.message));
      }
    }
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'project', action: 'update', oldData: oldProject, newData: project, req });
    const ruleAlerts = (await evaluateRules('projects', project).catch(() => [])).filter(r => r.triggered);
    res.json({ ...project, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Project Pipeline kanban stage move — retired (P1 Phase 5): a project's stage is its lifecycle's stage, moved only
// through the gated, audited lifecycle transitions. This free move used to set
// projects.production_stage directly — any column, either direction, no gate,
// no history. It now changes nothing and says where the stage lives.
router.patch('/projects/:id/stage', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const project = await projectRepository.findById(req.params.id, cid(req));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.status(409).json({
      error: 'The project stage follows its lifecycle and cannot be set directly. '
        + (project.lifecycle_id
          ? `Advance lifecycle ${project.lifecycle_id} through its gates instead.`
          : 'This project has no lifecycle yet.'),
      code: 'STAGE_FOLLOWS_LIFECYCLE',
      lifecycle_id: project.lifecycle_id ?? null,
      lifecycle_stage: project.lifecycle_stage ?? null,
      production_stage: project.production_stage ?? null,
      stage_source: project.stage_source,
    });
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
    // Who the viewer IS comes from the login link, not from matching the login
    // email against company_email (unscoped, LIMIT 1) — an editable HR field.
    const empId = await actingEmployeeId(req);
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
    const task = await taskRepository.findById(req.params.id, cid(req));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A closed/completed project had no guard at all — tasks, timesheets, and
// member assignments could all still be posted against it after closure.
async function findClosedProjectStatus(projectId) {
  if (!projectId) return null;
  const { rows } = await pool.query('SELECT status FROM projects WHERE id = $1', [projectId]);
  return CLOSED_PROJECT_STATUSES.includes(rows[0]?.status) ? rows[0].status : null;
}

// A project could be marked 'completed' with open tasks, unbilled milestones,
// or timesheets still awaiting approval — the write-guard above only stops
// activity AFTER closure, nothing checked readiness BEFORE it. Only gates the
// 'completed' transition, not 'cancelled' (cancelling is exactly for projects
// that will never finish their open items, so blocking on the same grounds
// would be backwards). Pass force_complete:true to close anyway.
// Closure blockers live in services/projectClosure.service.js, shared with the
// lifecycle's Closure-stage completion (P1 Phase 4).
const getProjectClosureBlockers = (projectId) => getClosureBlockers(pool, projectId);

router.post('/tasks', requirePermission('projects', 'add'), async (req, res) => {
  try {
    // A task's tenant is its project's (tasks has no company_id of its own), so
    // an unscoped project_id let a caller plant a task inside another company's
    // project. Same guard the /resources and /risks POSTs already carry.
    if (req.body.project_id) {
      const owned = await pool.query(
        `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
        [req.body.project_id, cid(req)]
      );
      if (!owned.rows.length) return res.status(403).json({ error: 'Project not found in your company' });
    }
    const closedStatus = await findClosedProjectStatus(req.body.project_id);
    if (closedStatus) return res.status(400).json({ error: `Cannot add a task — project is ${closedStatus}` });
    const task = await taskRepository.create({ ...req.body, created_by: await actingEmployeeId(req) });
    logAudit({ userId: uid(req), module: 'projects', recordId: task.id, recordType: 'task', action: 'create', newData: task, req });
    res.status(201).json(task);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/tasks/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const old = await taskRepository.findById(req.params.id, cid(req));
    if (!old) return res.status(404).json({ error: 'Task not found' });
    const task = await taskRepository.update(req.params.id, req.body, cid(req));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'task', action: 'update', oldData: old, newData: task, req });
    res.json(task);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tasks/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const old = await taskRepository.findById(req.params.id, cid(req));
    if (!old) return res.status(404).json({ error: 'Task not found' });
    const removed = await taskRepository.delete(req.params.id, cid(req));
    if (!removed) return res.status(404).json({ error: 'Task not found' });
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'task', action: 'delete', oldData: old, req });
    res.json({ message: 'Task deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Project Costs ─────────────────────────────────────────────────────────────
router.get('/projects/:id/costs', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const costs = await projectCostRepository.findByProject(req.params.id, cid(req));
    res.json(costs || { labour_cost: 0, material_cost: 0, expense_cost: 0, total_cost: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Alias for frontend that calls /costing instead of /costs
router.get('/projects/:id/costing', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const costs = await projectCostRepository.findByProject(req.params.id, cid(req));
    res.json(costs || { labour_cost: 0, material_cost: 0, expense_cost: 0, total_cost: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Cost-sensitivity drivers (tornado diagram basis).
 *
 * The nine categories recalculateProjectCost() actually rolls up from source
 * tables — deliberately NOT project_cost_summary.expense_cost (a legacy
 * travel+manufacturing duplicate) or subcontractor_cost (never written by the
 * rollup), which would double-count.
 *
 * low_pct/high_pct are DEFAULT estimating ranges, not measurements. They are
 * shipped to the client, shown on the chart and editable there: a tornado is
 * only honest when the assumed range is visible next to the bar it produced.
 */
const SENSITIVITY_DRIVERS = [
  { key: 'material_cost',        label: 'Material',           low_pct: -8,  high_pct: 15 },
  { key: 'labour_cost',          label: 'Labour',             low_pct: -5,  high_pct: 20 },
  { key: 'manufacturing_cost',   label: 'Manufacturing',      low_pct: -5,  high_pct: 15 },
  { key: 'procurement_overhead', label: 'Procurement',        low_pct: -10, high_pct: 12 },
  { key: 'installation_cost',    label: 'Installation',       low_pct: -10, high_pct: 25 },
  { key: 'commissioning_cost',   label: 'Commissioning',      low_pct: -10, high_pct: 25 },
  { key: 'quality_cost',         label: 'Quality / rework',   low_pct: -10, high_pct: 30 },
  { key: 'service_cost',         label: 'Service / warranty', low_pct: -15, high_pct: 30 },
  { key: 'travel_cost',          label: 'Travel',             low_pct: -10, high_pct: 25 },
];

router.get('/projects/:id/cost-sensitivity', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.project_code, p.project_name,
              COALESCE(p.budget_amount, p.budget, 0) AS budget_amount,
              pcs.project_id AS has_summary,
              COALESCE(pcs.total_revenue, pcs.revenue, 0) AS total_revenue,
              COALESCE(pcs.revenue, 0)     AS invoice_revenue,
              COALESCE(pcs.amc_revenue, 0) AS amc_revenue,
              COALESCE(pcs.total_cost, 0)  AS total_cost_stored,
              pcs.last_calculated_at,
              ${SENSITIVITY_DRIVERS.map(d => `COALESCE(pcs.${d.key}, 0) AS ${d.key}`).join(',\n              ')}
       FROM projects p
       LEFT JOIN project_cost_summary pcs ON pcs.project_id = p.id
       WHERE p.id = $1 AND ($2::int IS NULL OR p.company_id = $2)`,
      [req.params.id, cid(req)]
    );

    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Project not found' });

    const drivers = SENSITIVITY_DRIVERS.map(d => {
      const amount = parseFloat(row[d.key] || 0);
      return {
        key: d.key,
        label: d.label,
        amount,
        // A zero here means "no cost has been booked against this category",
        // which is not the same as "this category costs nothing". The client
        // lists these separately instead of drawing a zero-swing bar.
        measured: amount > 0,
        default_low_pct: d.low_pct,
        default_high_pct: d.high_pct,
      };
    });

    const driverSum    = drivers.reduce((s, d) => s + d.amount, 0);
    const totalRevenue = parseFloat(row.total_revenue || 0);
    const storedCost   = parseFloat(row.total_cost_stored || 0);

    // Integrity gate. The rollup writes total_cost as exactly the sum of these
    // nine drivers, so a mismatch means the row did NOT come from the rollup —
    // seeded or hand-written values would otherwise render as a confident chart.
    let integrity = { state: 'ok', message: null };
    if (!row.has_summary) {
      integrity = {
        state: 'never_calculated',
        message: 'No cost rollup has been run for this project yet. Run Recalculate EVM to build one.',
      };
    } else if (Math.abs(driverSum - storedCost) > Math.max(1, storedCost * 0.005)) {
      integrity = {
        state: 'inconsistent',
        message: `Stored total cost (${storedCost.toFixed(2)}) does not equal the sum of its cost drivers (${driverSum.toFixed(2)}). This row was not written by the cost rollup — run Recalculate EVM before trusting a sensitivity read.`,
      };
    }

    res.json({
      project: {
        id: row.id,
        project_code: row.project_code,
        project_name: row.project_name,
        budget_amount: parseFloat(row.budget_amount || 0),
      },
      basis: {
        total_revenue:     totalRevenue,
        invoice_revenue:   parseFloat(row.invoice_revenue || 0),
        amc_revenue:       parseFloat(row.amc_revenue || 0),
        driver_sum:        driverSum,
        total_cost_stored: storedCost,
        net_margin:        totalRevenue - driverSum,
        // Guard the zero denominator explicitly: a 0-revenue project has an
        // UNDEFINED margin %, not a 0.0% one.
        net_margin_pct:    totalRevenue > 0 ? ((totalRevenue - driverSum) / totalRevenue) * 100 : null,
        last_calculated_at: row.last_calculated_at,
      },
      integrity,
      drivers,
    });
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
        -- 'in_progress' / 'in-progress' were also listed here and can NEVER
        -- match: projects_status_check permits exactly
        -- planning | active | on_hold | completed | cancelled.
        -- Harmless in this particular query (active/planning still match), but
        -- they encode a belief about the vocabulary that is wrong, and the next
        -- person to copy this list inherits it.
        AND p.status IN ('active','planning')
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
      `SELECT * FROM project_budget_lines bl
        WHERE bl.project_id=$1
          AND EXISTS (SELECT 1 FROM projects p
                       WHERE p.id=bl.project_id AND ($2::int IS NULL OR p.company_id=$2))
        ORDER BY bl.sequence, bl.id`,
      [req.params.id, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/budget-lines', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const owned = await pool.query(
      `SELECT id FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!owned.rows.length) return res.status(403).json({ error: 'Project not found in your company' });
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

router.put('/projects/budget-lines/:id', requirePermission('projects', 'edit'), captureBefore('project_budget_lines'), async (req, res) => {
  try {
    const { wbs_code, category, description, budgeted_amount, actual_amount, sequence } = req.body;
    // $4 and $5 arrive untyped, so `variance=$4-$5` asked Postgres to subtract
    // unknown from unknown and every call to this endpoint died on
    // `42725 operator is not unique` — for its own tenant as much as anyone
    // else's. The casts are what make the expression resolvable.
    const { rows } = await pool.query(
      `UPDATE project_budget_lines SET
         wbs_code=$1, category=$2, description=$3, budgeted_amount=$4::numeric,
         actual_amount=$5::numeric, variance=$4::numeric-$5::numeric, sequence=$6, updated_at=NOW()
       WHERE id=$7
         AND EXISTS (SELECT 1 FROM projects p
                      WHERE p.id=project_id AND ($8::int IS NULL OR p.company_id=$8))
       RETURNING *`,
      [wbs_code, category, description, budgeted_amount||0, actual_amount||0, sequence||0, req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Budget line not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/budget-lines/:id', requirePermission('projects', 'delete'), captureBefore('project_budget_lines'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM project_budget_lines bl WHERE bl.id=$1
         AND EXISTS (SELECT 1 FROM projects p
                      WHERE p.id=bl.project_id AND ($2::int IS NULL OR p.company_id=$2))
       RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Budget line not found' });
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
    const closedStatus = await findClosedProjectStatus(req.params.id);
    if (closedStatus) return res.status(400).json({ error: `Cannot assign team members — project is ${closedStatus}` });
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

    const projectRow = await pool.query(`SELECT project_name FROM projects WHERE id=$1`, [req.params.id]);
    notifyWorkflowEvent('member_assigned', {
      module: 'Projects',
      recordId: req.params.id,
      recipientIds: [employee_id],
      context: { projectName: projectRow.rows[0]?.project_name, role: rows[0].role_in_project },
    });

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

router.put('/projects/milestones/:id', requirePermission('projects', 'edit'), captureBefore('project_milestones'), async (req, res) => {
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

router.put('/projects/milestones/:id/complete', requirePermission('projects', 'edit'), captureBefore('project_milestones'), async (req, res) => {
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

    // Fetched once, unconditionally — needed for the completion notification
    // below regardless of billing_milestone, and reused by the invoice block
    // (previously fetched a second time, only inside that block).
    const projectRes = await pool.query(
      // Neither a clients table nor projects.client_id exists, so the previous
      // LEFT JOIN threw and this lookup failed outright. The project already
      // carries the customer as denormalised text.
      `SELECT p.*, COALESCE(p.customer_name, p.client_name) AS customer_name_alt
         FROM projects p
        WHERE p.id=$1`,
      [milestone.project_id]
    );
    const project = projectRes.rows[0];

    const notifyRecipients = [...new Set([project?.project_manager_id, milestone.owner_id].filter(Boolean))];
    if (notifyRecipients.length) {
      notifyWorkflowEvent('milestone_completed', {
        module: 'Projects',
        recordId: milestone.id,
        recipientIds: notifyRecipients,
        context: { milestoneTitle: milestone.title, projectName: project?.project_name },
      });
    }

    let invoice_created = false;
    let invoice = null;

    // Auto-create a REAL finance invoice for billing milestones. This used to
    // insert into `sales_invoices`, a table with no Finance-side reader anywhere
    // in the app (no route, no page) — milestones were marked "invoiced" but
    // Finance had no way to ever collect on them. Routed through
    // invoiceService.createInvoice so it lands in the real `invoices` table with
    // a posted journal entry, same as every other invoice in the system.
    if (milestone.billing_milestone && parseFloat(milestone.amount) > 0) {
      try {
        const customerName = project?.customer_name || project?.client_name || project?.customer_name_alt || 'Customer';

        // Best-effort match to a real Finance party by name — projects only
        // store a free-text customer_name, not a parties.id FK.
        const partyMatch = await pool.query(
          `SELECT id FROM parties WHERE LOWER(name) = LOWER($1) AND deleted_at IS NULL LIMIT 1`,
          [customerName]
        ).catch(() => ({ rows: [] }));
        const customerId = partyMatch.rows[0]?.id ?? null;

        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 30);
        const createdInvoice = await invoiceService.createInvoice({
          customer_id: customerId,
          party_name: customerId ? null : customerName,
          invoice_date: new Date().toISOString().split('T')[0],
          due_date: dueDate.toISOString().split('T')[0],
          subtotal: milestone.amount,
          tax_amount: 0,
          total_amount: milestone.amount,
          company_id: cid(req),
          notes: `Milestone: ${milestone.title} — Project: ${project?.project_name || ''}`,
          items: [{
            description: `Milestone: ${milestone.title} — Project: ${project?.project_name || ''}`,
            quantity: 1,
            unit_price: milestone.amount,
            tax_rate: 0,
            amount: milestone.amount,
          }],
        }, req.user?.employee_id ?? null).catch((e) => { console.error('[milestone] invoice creation failed:', e.message); return null; });

        if (createdInvoice) {
          invoice = createdInvoice;
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

router.delete('/projects/milestones/:id', requirePermission('projects', 'delete'), captureBefore('project_milestones'), async (req, res) => {
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
    const { title, description, category, probability, impact, mitigation_plan, contingency_plan, owner_id, review_date } = req.body;
    // project_risks.title is NOT NULL. Project Detail's risk form only ever
    // collected a description, so this INSERT raised 23502 and the screen's
    // catch swallowed it — every "Add Risk" from that page failed silently and
    // the risk register stayed empty. Answer the contract breach as a 400
    // instead of a 500, and say which field is missing.
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    const prob = riskLevelOf(probability);
    const imp = riskLevelOf(impact);
    const score = riskScoreOf(prob, imp);
    const riskCode = `RSK-${Date.now().toString().slice(-6)}`;
    const { rows } = await pool.query(
      `INSERT INTO project_risks
         (project_id, company_id, risk_code, title, description, category,
          probability, impact, risk_score, mitigation_plan, contingency_plan, owner_id, review_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.params.id, cid(req), riskCode, String(title).trim(), description||null, category||'technical',
       prob, imp, score, mitigation_plan||null,
       contingency_plan||null, owner_id||null, review_date||null]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'risk', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/risks/:id', requirePermission('projects', 'edit'), captureBefore('project_risks'), async (req, res) => {
  try {
    const { title, description, category, probability, impact, status, mitigation_plan, contingency_plan, owner_id, review_date, closed_date } = req.body;
    // Same NOT NULL column as the POST — this full-field UPDATE would null it.
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    const prob = riskLevelOf(probability);
    const imp = riskLevelOf(impact);
    const score = riskScoreOf(prob, imp);
    const { rows } = await pool.query(
      // NO `updated_at` here: project_risks genuinely has no such column, and
      // setting it made every risk edit fail with 42703. Third table in this
      // module to inherit that line from one that does have it.
      `UPDATE project_risks SET
         title=$1, description=$2, category=$3, probability=$4, impact=$5,
         risk_score=$6, status=$7, mitigation_plan=$8, contingency_plan=$9,
         owner_id=$10, review_date=$11, closed_date=$12
       WHERE id=$13
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=project_id AND ($14::int IS NULL OR p.company_id=$14))
       RETURNING *`,
      [String(title).trim(), description||null, category||'technical', prob, imp,
       score, status||'open', mitigation_plan||null, contingency_plan||null,
       owner_id||null, review_date||null, closed_date||null, req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Risk not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/risks/:id', requirePermission('projects', 'delete'), captureBefore('project_risks'), async (req, res) => {
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
    // raised_by FKs employees(id); uid() is a users.id, a different namespace.
    const raisedBy = await actingEmployeeId(req);
    const issueCode = `ISS-${Date.now().toString().slice(-6)}`;
    const { rows } = await pool.query(
      `INSERT INTO project_issues
         (project_id, company_id, issue_code, title, description, issue_type,
          severity, priority, raised_by, assigned_to, task_id, due_date,
          is_blocker, root_cause)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.params.id, cid(req), issueCode, title, description||null,
       issue_type||'general', severity||'medium', priority||'medium',
       raisedBy, assigned_to||null, task_id||null, due_date||null,
       is_blocker||false, root_cause||null]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'issue', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/issues/:id', requirePermission('projects', 'edit'), captureBefore('project_issues'), async (req, res) => {
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

router.delete('/projects/issues/:id', requirePermission('projects', 'delete'), captureBefore('project_issues'), async (req, res) => {
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
    // created_by FKs employees(id), so uid() (a users.id) violated the FK and
    // every FAT save answered 500 — for admin accounts in particular, whose
    // users.id rarely collides with a valid employees.id.
    const createdBy = await actingEmployeeId(req);
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
       remarks||null, createdBy]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'fat', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/fat/:id', requirePermission('projects', 'edit'), captureBefore('fat_trackers'), async (req, res) => {
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
    // created_by FKs employees(id) — same trap as the FAT insert above.
    const createdBy = await actingEmployeeId(req);
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
       remarks||null, createdBy]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'sat', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/sat/:id', requirePermission('projects', 'edit'), captureBefore('sat_trackers'), async (req, res) => {
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
// Unified Warranty Engine (Priority 3) — reads/writes warranty_registrations
// (the same table Commissioning and Operations/Lifecycle write to) instead of
// the old project-only `project_warranties` table, so a project's warranties
// show up in Customer 360/AMC/the Warranty Expiry dashboards too. Column
// names are aliased to match this page's existing contract
// (WarrantyManagement.jsx) so the frontend needed no changes.
const WARRANTY_SELECT = `
  wr.id, wr.project_id, wr.company_id, wr.serial_number, wr.product_name,
  wr.commissioning_date, wr.warranty_start AS warranty_start_date,
  wr.warranty_end AS warranty_end_date, wr.warranty_months,
  wr.manufacturer_warranty_months, wr.extended_warranty_months,
  wr.warranty_type, wr.coverage_description, wr.exclusions, wr.status,
  wr.created_at, wr.updated_at`;

router.get('/projects/:id/warranties', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${WARRANTY_SELECT},
              CASE WHEN wr.warranty_end >= CURRENT_DATE THEN 'active' ELSE 'expired' END AS computed_status
       FROM warranty_registrations wr
       WHERE wr.project_id=$1
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2))
       ORDER BY wr.warranty_end DESC`,
      [req.params.id, cid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/warranties', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const check = await pool.query(
      `SELECT id, customer_name FROM projects WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid(req)]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'Project not found in your company' });
    const {
      serial_number, product_name, commissioning_date, warranty_start_date, warranty_end_date,
      warranty_months, warranty_type, coverage_description, exclusions,
      manufacturer_warranty_months, extended_warranty_months,
    } = req.body;
    const months = parseInt(warranty_months) || 12;
    const startDate = warranty_start_date || commissioning_date || new Date().toISOString().slice(0, 10);
    const endDate = warranty_end_date
      || new Date(new Date(startDate).setMonth(new Date(startDate).getMonth() + months)).toISOString().slice(0, 10);
    const companyId = cid(req);
    const warrantyNumber = await nextWarrantyNumber();
    const { rows } = await pool.query(
      `INSERT INTO warranty_registrations AS wr
         (warranty_number, project_id, company_id, serial_number, product_name, customer_name,
          commissioning_date, warranty_start, warranty_end, warranty_months, warranty_type,
          coverage_description, exclusions, manufacturer_warranty_months, extended_warranty_months, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Active')
       RETURNING ${WARRANTY_SELECT}`,
      [warrantyNumber, req.params.id, companyId, serial_number || null, product_name || serial_number || 'Unspecified',
       check.rows[0].customer_name || 'Unknown', commissioning_date || null, startDate, endDate, months,
       warranty_type || 'standard', coverage_description || null, exclusions || null,
       parseInt(manufacturer_warranty_months) || months, parseInt(extended_warranty_months) || null]
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
    // uploaded_by FKs employees(id) — and the GET joins employees on it to show
    // uploaded_by_name, so a users.id here is both an FK risk and a wrong name.
    const uploadedBy = await actingEmployeeId(req);
    const { rows } = await pool.query(
      `INSERT INTO project_documents
         (project_id, company_id, document_name, document_type, document_number,
          revision, file_url, file_name, mime_type, file_size, description, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.params.id, cid(req), document_name, document_type||'general',
       document_number||null, revision||null, file_url||null, file_name||null,
       mime_type||null, file_size||0, description||null, uploadedBy]
    );
    logAudit({ userId: uid(req), module: 'projects', recordId: req.params.id, recordType: 'document', action: 'upload', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/documents/:id', requirePermission('projects', 'delete'), captureBefore('project_documents'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM project_documents pd WHERE pd.id=$1
         AND EXISTS (SELECT 1 FROM projects p
                      WHERE p.id=pd.project_id AND ($2::int IS NULL OR p.company_id=$2))
       RETURNING id`,
      [req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
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
    // Milestone invoices are real Finance invoices (see PUT /milestones/:id/complete)
    // linked back via project_milestones.invoice_id -> invoices.id.
    const { rows } = await pool.query(
      `SELECT i.*, pm.title AS milestone_title
       FROM project_milestones pm
       JOIN invoices i ON i.id = pm.invoice_id
       WHERE pm.project_id=$1
         AND ($2::int IS NULL OR i.company_id=$2)
       ORDER BY i.invoice_date DESC`,
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
      -- Both joins are 1:N (a project legitimately has several commissioning
      -- reports). Joining them plainly fanned one project out into several rows:
      -- the grid repeated it, the KPI count and average completion counted it
      -- twice, and the React key collided. LATERAL ... LIMIT 1 keeps it 1:1 on
      -- the newest record of each.
      LEFT JOIN LATERAL (
        SELECT li.current_stage
        FROM lifecycle_instances li
        WHERE li.project_id = p.id AND li.status = 'active'
        ORDER BY li.created_at DESC NULLS LAST, li.id DESC
        LIMIT 1
      ) li ON TRUE
      LEFT JOIN LATERAL (
        SELECT cr.status, cr.commissioning_date
        FROM commissioning_reports cr
        WHERE cr.project_id = p.id
        ORDER BY cr.commissioning_date DESC NULLS LAST, cr.id DESC
        LIMIT 1
      ) cr ON TRUE
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
      // The stage comes from the shared derivation (shared/projectStages.js):
      // the project's open lifecycle, else its latest closed one, in the
      // project's own company only. The old lookup took any 'active' lifecycle
      // pointing at the id (another company's included), ignored on-hold ones,
      // and answered 'N/A' when there was none.
      pool.query(
        `SELECT p.*, ${projectStageColumnsSql('p', 'plc')}
           FROM projects p ${projectLifecycleJoinSql('p', 'plc')}
          WHERE p.id=$1 AND ($2::int IS NULL OR p.company_id=$2)`,
        [req.params.id, cid(req)]),
      pool.query(`SELECT name, status, due_date FROM project_milestones WHERE project_id=$1 ORDER BY due_date DESC LIMIT 5`, [req.params.id]),
      // project_risks.probability/impact are VARCHAR level labels ('low'/'medium'/
      // 'high'), never numbers — the previous `probability*impact` threw 42883 on
      // every call and the .catch() served it as an empty risk list. Score comes
      // from the real risk_score column, falling back to a level-ordinal product.
      pool.query(
        `SELECT pr.risk_code, pr.title, pr.description, pr.status,
                COALESCE(
                  NULLIF(pr.risk_score, 0),
                  ${RISK_LEVEL_ORDINAL('pr.probability')} * ${RISK_LEVEL_ORDINAL('pr.impact')}
                ) AS score
         FROM project_risks pr
         WHERE pr.project_id = $1
           AND LOWER(COALESCE(pr.status, 'open')) NOT IN ('closed', 'resolved', 'mitigated', 'accepted')
         ORDER BY score DESC NULLS LAST
         LIMIT 5`,
        [req.params.id]
      ),
      // project_cost_summary has no total_budget/actual_cost columns (42703 on
      // every call, swallowed the same way). Budget lives on projects; the
      // rolled-up actual is total_cost. Output names kept for the response shape.
      pool.query(
        `SELECT COALESCE(p.budget_amount, p.budget, 0) AS total_budget,
                pcs.total_cost      AS actual_cost,
                pcs.labour_cost, pcs.material_cost,
                pcs.revenue, pcs.total_revenue, pcs.profit, pcs.margin_pct,
                pcs.planned_value, pcs.earned_value, pcs.actual_cost_evm,
                pcs.cost_performance_index, pcs.schedule_performance_index,
                pcs.last_calculated_at
         FROM project_cost_summary pcs
         JOIN projects p ON p.id = pcs.project_id
         WHERE pcs.project_id = $1`,
        [req.params.id]
      ),
    ]);
    const project  = settledRows(projRes, 'status-report/project')[0] || null;
    const recent_milestones = settledRows(mileRes, 'status-report/milestones');
    const risks    = settledRows(riskRes, 'status-report/risks');
    const costing  = settledRows(costRes, 'status-report/costing')[0] || null;

    if (!project) return res.status(404).json({ error: 'Project not found' });

    res.json({
      report: {
        project_id: req.params.id,
        // The representative lifecycle's own stage; null (never a guess) when
        // the project has no lifecycle in its company — stage_source says so.
        current_stage: project.lifecycle_stage ?? null,
        lifecycle_id: project.lifecycle_id ?? null,
        lifecycle_stage: project.lifecycle_stage ?? null,
        lifecycle_status: project.lifecycle_status ?? null,
        production_stage: project.production_stage ?? null,
        stage_source: project.stage_source,
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
// Unified Warranty Engine — same warranty_registrations table as above, scoped
// to rows that have a project_id (this screen is project-centric; commissioning-
// or operations-only warranties without a project_id don't belong on this list).
router.get('/warranties', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${WARRANTY_SELECT},
              p.project_code, p.project_name,
              CASE
                WHEN wr.status IS NOT NULL THEN wr.status
                WHEN wr.warranty_end >= CURRENT_DATE THEN 'active'
                ELSE 'expired'
              END AS computed_status
       FROM warranty_registrations wr
       JOIN projects p ON p.id = wr.project_id
       WHERE wr.project_id IS NOT NULL AND ($1::int IS NULL OR wr.company_id = $1)
       ORDER BY wr.warranty_end ASC`,
      [cid(req)]
    ).catch(() => ({ rows: [] }));
    res.json({ warranties: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Global warranty update ────────────────────────────────────────────────────
// `coverage_description` used to be referenced here against `project_warranties`,
// which never had that column (a live 500-on-edit bug — 0 rows ever existed to
// trigger it in practice). warranty_registrations now has a real column for it.
router.put('/warranties/:id', requirePermission('projects', 'edit'), captureBefore('warranty_registrations'), async (req, res) => {
  try {
    const { product_name, serial_number, commissioning_date, warranty_start_date,
            warranty_end_date, warranty_type, coverage_description, exclusions, status,
            manufacturer_warranty_months, extended_warranty_months } = req.body;
    const { rows } = await pool.query(
      `UPDATE warranty_registrations AS wr
       SET product_name=COALESCE($1, product_name), serial_number=COALESCE($2, serial_number),
           commissioning_date=COALESCE($3, commissioning_date),
           warranty_start=COALESCE($4, warranty_start), warranty_end=COALESCE($5, warranty_end),
           warranty_type=COALESCE($6, warranty_type),
           coverage_description=COALESCE($7, coverage_description), exclusions=COALESCE($8, exclusions),
           status=COALESCE($9, status),
           manufacturer_warranty_months=COALESCE($10, manufacturer_warranty_months),
           extended_warranty_months=COALESCE($11, extended_warranty_months),
           updated_at=NOW()
       WHERE id=$12 AND project_id IS NOT NULL AND ($13::int IS NULL OR company_id=$13)
       RETURNING ${WARRANTY_SELECT}`,
      [product_name||null, serial_number||null, commissioning_date||null,
       warranty_start_date||null, warranty_end_date||null, warranty_type||null,
       coverage_description||null, exclusions||null, status||null,
       manufacturer_warranty_months != null ? parseInt(manufacturer_warranty_months) : null,
       extended_warranty_months != null ? parseInt(extended_warranty_months) : null,
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
