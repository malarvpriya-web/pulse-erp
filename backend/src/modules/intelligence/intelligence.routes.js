/**
 * intelligence.routes.js
 * All 13 system APIs — Rule Engine, Permissions, Workflow, SLA,
 * Notifications, Dashboard Builder, Documents, Audit, Finance,
 * Masters, Multi-company, Insights, Validation
 */
import { Router } from 'express';
import auditRepository from '../audit/repositories/audit.repository.js';
import { companyOf } from '../../shared/scope.js';
import pool from '../../config/db.js';
import { sqlEmployeeActive } from '../../shared/statusSets.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { validateQueryConfig, getMetric, CHART_TYPES } from '../../shared/metricRegistry.js';
import {
  catalogFor, executeConfig, listDashboards, loadDashboard,
} from './services/dashboardBuilder.service.js';

const router = Router();

/**
 * Endpoints whose backing table has never existed.
 *
 * `sla_config`, `sla_tracking`, `dashboard_widgets`, `documents`,
 * `project_costs`, `budget_vs_actual`, `profit_tracker`, `masters` and
 * `insights_cache` appear in no migration in the repository's history, so these
 * handlers have never returned data in any environment. Until this was found
 * they answered with a 500 carrying the raw Postgres text
 * ("relation \"masters\" does not exist"), which reads to a caller as a server
 * fault and, outside production, discloses schema internals.
 *
 * 501 is the honest code: the route is recognised, the capability is not
 * implemented. It is deliberately a short-circuit in front of the handlers
 * rather than a deletion of them — the query bodies are the only surviving
 * record of the intended schema, and whoever builds these tables will want them.
 *
 * Removing these routes outright, or building the nine tables, is a product
 * decision rather than a correctness one. See ANALYTICS_AI_FINAL_HARDENING_REPORT.md.
 */
const UNBACKED_PREFIXES = [
  ['/sla-config',       'sla_config'],
  ['/sla-tracking',     'sla_tracking'],
  // '/widgets' / 'dashboard_widgets' was here until 10 Sep 2026. The table now
  // exists (migration 20260910000002_dashboard_builder) and the routes below
  // execute against it through the metric registry, so the short-circuit would
  // now be hiding a working feature. Removed here, in the checker's
  // UNIMPLEMENTED_TABLES, and in analytics.intelligenceContract.test.js —
  // all three together, as that test requires.
  ['/documents',        'documents'],
  ['/project-costs',    'project_costs'],
  ['/budget-vs-actual', 'budget_vs_actual'],
  ['/profit-tracker',   'profit_tracker'],
  ['/masters',          'masters'],
  ['/insights',         'insights_cache'],
];

router.use((req, res, next) => {
  const p = req.path || '/';
  const hit = UNBACKED_PREFIXES.find(([prefix]) => p === prefix || p.startsWith(prefix + '/'));
  if (!hit) return next();
  return res.status(501).json({
    error: 'This capability is not implemented — it has no backing table in the schema.',
    capability: hit[0].slice(1),
    available: false,
  });
});


// ════════════════════════════════════════════════════════════
// 1. RULE ENGINE
// ════════════════════════════════════════════════════════════
router.get('/rules', async (req, res) => {
  try {
    const { module } = req.query;
    const r = await pool.query(
      `SELECT * FROM rules_master
       WHERE ($1::text IS NULL OR module_name = $1) AND is_active = true
         AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
       ORDER BY priority, module_name`,
      [module || null, companyOf(req) ?? null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/rules', async (req, res) => {
  try {
    const { module_name, rule_name, description, condition_json, action_json, priority } = req.body;
    const r = await pool.query(
      `INSERT INTO rules_master (module_name, rule_name, description, condition_json, action_json, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [module_name, rule_name, description || '', condition_json, action_json, priority || 10, req.user?.userId]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/rules/:id', captureBefore('rules_master'), async (req, res) => {
  try {
    const { rule_name, description, condition_json, action_json, priority, is_active } = req.body;
    const r = await pool.query(
      `UPDATE rules_master SET rule_name=$1, description=$2, condition_json=$3,
       action_json=$4, priority=$5, is_active=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [rule_name, description, condition_json, action_json, priority, is_active, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/rules/:id', captureBefore('rules_master'), async (req, res) => {
  try {
    await pool.query('UPDATE rules_master SET is_active=false WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Evaluate rules for a given module + data payload
router.post('/rules/evaluate', async (req, res) => {
  try {
    const { module, data } = req.body;
    const rules = await pool.query(
      'SELECT * FROM rules_master WHERE module_name=$1 AND is_active=true ORDER BY priority',
      [module]
    );
    const triggered = [];
    for (const rule of rules.rows) {
      const cond = rule.condition_json;
      let match = true;
      for (const [field, check] of Object.entries(cond)) {
        const val = parseFloat(data[field]);
        if (typeof check === 'object' && check.op) {
          const ref = check.field ? parseFloat(data[check.field]) : parseFloat(check.value);
          if (check.op === '>'  && !(val >  ref)) match = false;
          if (check.op === '>=' && !(val >= ref)) match = false;
          if (check.op === '<'  && !(val <  ref)) match = false;
          if (check.op === '<=' && !(val <= ref)) match = false;
          if (check.op === '==' && !(val === ref)) match = false;
        } else if (data[field] !== check) {
          match = false;
        }
      }
      if (match) triggered.push({ rule_name: rule.rule_name, action: rule.action_json });
    }
    res.json({ triggered, count: triggered.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 2. PERMISSION ENGINE
// ════════════════════════════════════════════════════════════
router.get('/roles', async (req, res) => {
  try {
    // `roles` carries company_id. Rows with a NULL company_id are the built-in
    // global role catalogue and stay visible to everyone; anything a tenant has
    // defined for itself must not appear in another tenant's list.
    const r = await pool.query(
      'SELECT * FROM roles WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL) ORDER BY id',
      [companyOf(req) ?? null]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/role-permissions', async (req, res) => {
  try {
    const { role } = req.query;
        // `role_permissions` is (role_id, module, can_view/can_add/can_edit/
    // can_delete/can_approve/can_export) joined to `roles` — the shape
    // PermissionService and auth.middleware actually enforce. This endpoint
    // used a (role_name, action, is_allowed) model that has never existed, so
    // every call threw. Roles are identified by code, not by a free-text name.
    const r = await pool.query(
      `SELECT rp.id, r.code AS role_name, rp.role_id, rp.module,
              rp.can_view, rp.can_add, rp.can_edit,
              rp.can_delete, rp.can_approve, rp.can_export
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE ($1::text IS NULL OR LOWER(r.code) = LOWER($1))
        ORDER BY rp.module`,
      [role || null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/role-permissions', async (req, res) => {
  try {
        const { role_name, module, action, is_allowed } = req.body;

    // `action` selects one of the boolean columns. Whitelisted: this value
    // reaches the SQL as an identifier, and a permission grant is exactly the
    // place not to interpolate free text.
    const ACTION_COLUMN = {
      view: 'can_view', add: 'can_add', create: 'can_add', edit: 'can_edit',
      update: 'can_edit', delete: 'can_delete', approve: 'can_approve',
      export: 'can_export',
    };
    const col = ACTION_COLUMN[String(action || '').toLowerCase()];
    if (!col) {
      return res.status(400).json({
        error: `action must be one of: ${Object.keys(ACTION_COLUMN).join(', ')}`,
      });
    }
    if (!role_name || !module) {
      return res.status(400).json({ error: 'role_name and module are required' });
    }

    const roleRes = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = LOWER($1)`, [role_name]);
    if (!roleRes.rows[0]) return res.status(404).json({ error: `Unknown role: ${role_name}` });

    const r = await pool.query(
      `INSERT INTO role_permissions (role_id, module, ${col})
       VALUES ($1,$2,$3)
       ON CONFLICT (role_id, module) DO UPDATE SET ${col} = $3
       RETURNING *`,
      [roleRes.rows[0].id, module, Boolean(is_allowed)]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/field-permissions', async (req, res) => {
  try {
    const { role, module } = req.query;
        // Same drift: field_permissions keys on role_id, not a role_name string.
    const r = await pool.query(
      `SELECT fp.*, r.code AS role_name
         FROM field_permissions fp
         JOIN roles r ON r.id = fp.role_id
        WHERE ($1::text IS NULL OR LOWER(r.code) = LOWER($1))
          AND ($2::text IS NULL OR fp.module = $2)`,
      [role || null, module || null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/field-permissions', async (req, res) => {
  try {
        const { role_name, module, field_name, is_visible, is_editable } = req.body;
    if (!role_name || !module || !field_name) {
      return res.status(400).json({ error: 'role_name, module and field_name are required' });
    }
    const roleRes = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = LOWER($1)`, [role_name]);
    if (!roleRes.rows[0]) return res.status(404).json({ error: `Unknown role: ${role_name}` });

    const r = await pool.query(
      `INSERT INTO field_permissions (role_id, module, field_name, is_visible, is_editable)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (role_id, module, field_name)
       DO UPDATE SET is_visible=$4, is_editable=$5 RETURNING *`,
      [roleRes.rows[0].id, module, field_name, is_visible, is_editable]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 3. WORKFLOW ENGINE
// ════════════════════════════════════════════════════════════
router.get('/workflows', async (req, res) => {
  try {
    const { module } = req.query;
    const wfs = await pool.query(
      `SELECT wm.*,
         (SELECT json_agg(ws ORDER BY ws.sequence) FROM workflow_steps ws WHERE ws.workflow_id=wm.id) AS steps,
         (SELECT json_agg(wt) FROM workflow_transitions wt WHERE wt.workflow_id=wm.id) AS transitions
       FROM workflow_master wm
       WHERE ($1::text IS NULL OR wm.module=$1) AND wm.is_active=true
       ORDER BY wm.module, wm.name`,
      [module || null]
    );
    res.json(wfs.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/workflow-instances', async (req, res) => {
  try {
    const { module, record_id, status } = req.query;
    const r = await pool.query(
      `SELECT wi.*, wm.name as workflow_name, ws.step_name as current_step_name,
              u.name as started_by_name
       FROM workflow_instances wi
       JOIN workflow_master wm ON wi.workflow_id = wm.id
       LEFT JOIN workflow_steps ws ON wi.current_step_id = ws.id
       LEFT JOIN users u ON wi.initiated_by = u.id
       WHERE ($1::text IS NULL OR wi.module=$1)
         AND ($2::int  IS NULL OR wi.entity_id=$2)
         AND ($3::text IS NULL OR wi.status=$3)
       ORDER BY wi.created_at DESC`,
      [module || null, record_id ? parseInt(record_id) : null, status || null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/workflow-instances', async (req, res) => {
  try {
    const { workflow_id, module, record_id } = req.body;
    const firstStep = await pool.query(
      'SELECT id FROM workflow_steps WHERE workflow_id=$1 ORDER BY sequence LIMIT 1',
      [workflow_id]
    );
    const r = await pool.query(
      `INSERT INTO workflow_instances (workflow_id, module, entity_id, current_step_id, initiated_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [workflow_id, module, record_id, firstStep.rows[0]?.id || null, req.user?.userId]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/workflow-instances/:id/advance', async (req, res) => {
  try {
    const { action, comment } = req.body;
    const inst = await pool.query('SELECT * FROM workflow_instances WHERE id=$1', [req.params.id]);
    if (!inst.rows.length) return res.status(404).json({ error: 'Instance not found' });

    const transition = await pool.query(
      `SELECT wt.*, ws.id as next_id, ws.step_name
       FROM workflow_transitions wt
       JOIN workflow_steps ws ON wt.to_step_id = ws.id
       WHERE wt.workflow_id=$1 AND wt.from_step_id=$2 AND wt.action_label=$3`,
      [inst.rows[0].workflow_id, inst.rows[0].current_step_id, action]
    );

    if (!transition.rows.length) return res.status(400).json({ error: `No transition found for action: ${action}` });

    const next = transition.rows[0];
    await pool.query('UPDATE workflow_instances SET current_step_id=$1 WHERE id=$2', [next.next_id, req.params.id]);
    await pool.query(
      `INSERT INTO workflow_instance_history (instance_id, step_id, action, actor_id, comment)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, inst.rows[0].current_step_id, action, req.user?.userId, comment || '']
    );
    res.json({ success: true, next_step: next.step_name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 4. SLA / TAT TRACKING
// ════════════════════════════════════════════════════════════
router.get('/sla-config', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM sla_config WHERE is_active=true ORDER BY module, expected_hours');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/sla-config', async (req, res) => {
  try {
    const { module, stage, expected_hours, escalation_hours, escalate_to_role } = req.body;
    const r = await pool.query(
      `INSERT INTO sla_config (module, stage, expected_hours, escalation_hours, escalate_to_role)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (module, stage) DO UPDATE
       SET expected_hours=$3, escalation_hours=$4, escalate_to_role=$5
       RETURNING *`,
      [module, stage, expected_hours, escalation_hours || null, escalate_to_role || null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sla-tracking', async (req, res) => {
  try {
    const { module, status } = req.query;
    const r = await pool.query(
      `SELECT st.*,
         CASE WHEN st.end_time IS NULL
              THEN EXTRACT(EPOCH FROM (NOW() - st.start_time))/3600
              ELSE st.duration_hours END AS current_duration,
         sc.expected_hours,
         CASE WHEN st.end_time IS NULL AND NOW() > st.expected_by THEN true ELSE false END AS is_breached
       FROM sla_tracking st
       LEFT JOIN sla_config sc ON sc.module=st.module AND sc.stage=st.stage
       WHERE ($1::text IS NULL OR st.module=$1)
         AND ($2::text IS NULL OR st.status=$2)
       ORDER BY st.start_time DESC
       LIMIT 200`,
      [module || null, status || null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start SLA tracking for a record
router.post('/sla-tracking/start', async (req, res) => {
  try {
    const { module, record_id, stage, assigned_to } = req.body;
    const config = await pool.query('SELECT * FROM sla_config WHERE module=$1 AND stage=$2', [module, stage]);
    const expected = config.rows[0]
      ? new Date(Date.now() + config.rows[0].expected_hours * 3600000)
      : null;
    const r = await pool.query(
      `INSERT INTO sla_tracking (module, record_id, stage, expected_by, assigned_to)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [module, record_id, stage, expected, assigned_to || null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Close SLA tracking
router.post('/sla-tracking/:id/close', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE sla_tracking
       SET end_time=NOW(),
           duration_hours=EXTRACT(EPOCH FROM (NOW()-start_time))/3600,
           status=CASE WHEN NOW() <= expected_by THEN 'on_time' ELSE 'delayed' END
       WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SLA breach summary
router.get('/sla-tracking/breaches', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT module, stage, COUNT(*) as breach_count,
             AVG(EXTRACT(EPOCH FROM (NOW()-start_time))/3600 - expected_hours) as avg_delay_hours
      FROM sla_tracking st
      JOIN sla_config sc USING(module, stage)
      WHERE st.status='running' AND NOW() > st.expected_by
      GROUP BY module, stage ORDER BY breach_count DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 5. NOTIFICATION ENGINE
// ════════════════════════════════════════════════════════════
router.get('/notification-rules', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM notification_rules WHERE enabled=true
         AND ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
       ORDER BY event_key`,
      [companyOf(req) ?? null]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/notification-rules/:id', captureBefore('notification_rules'), async (req, res) => {
  try {
    const { is_active, template, channel } = req.body;
    const r = await pool.query(
      'UPDATE notification_rules SET enabled=$1, template=$2, channel=$3 WHERE id=$4 RETURNING *',
      [is_active, template, channel, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fire a notification event
router.post('/notification-rules/fire', async (req, res) => {
  try {
    const { event_name, module, record_id, data, target_user_ids } = req.body;
    const rules = await pool.query(
      'SELECT * FROM notification_rules WHERE event_key=$1 AND enabled=true',
      [event_name]
    );
    let created = 0;
    for (const rule of rules.rows) {
      const msg = rule.template
        ? rule.template.replace(/\{(\w+)\}/g, (_, k) => data?.[k] || `{${k}}`)
        : `${event_name} triggered for ${module} #${record_id}`;

      const userIds = target_user_ids || [];
      if (!userIds.length) {
        const users = await pool.query("SELECT id FROM users WHERE role=$1 AND is_active=true", [rule.notify_role]);
        userIds.push(...users.rows.map(u => u.id));
      }
      for (const uid of userIds) {
        await pool.query(
          `INSERT INTO notifications (user_id, message, module_name, reference_id, is_read, created_at)
           VALUES ($1,$2,$3,$4,false,NOW())`,
          [uid, msg, module, record_id]
        );
        created++;
      }
    }
    res.json({ success: true, notifications_created: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 6. DASHBOARD BUILDER
// ════════════════════════════════════════════════════════════
// Was four CRUD handlers over a `query_config` column nothing executed, on a
// table that never existed, behind a 501. Now: a board, widgets on it, and an
// executor that resolves each widget's config against `shared/metricRegistry.js`.
//
// `query_config` NAMES a metric and never describes one — see the registry for
// why executing client SQL here would defeat tenant scoping and RBAC at once.
// Every widget's metric permission is re-checked PER VIEWER, so sharing a board
// shares the layout, never the authority.

// The metric catalog, filtered to what this caller could actually chart.
router.get('/metrics', async (req, res) => {
  try {
    res.json({ metrics: await catalogFor(req), chart_types: CHART_TYPES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Run a config without saving it — the builder's live preview.
router.post('/metrics/preview', async (req, res) => {
  try {
    const result = await executeConfig(req, req.body?.query_config ?? req.body, {
      companyId: companyOf(req),
    });
    // A config the registry refuses is the caller's error, not a server fault.
    if (!result.ok && result.permitted === false) return res.status(403).json(result);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── boards ──────────────────────────────────────────────────────────────────
router.get('/dashboards', async (req, res) => {
  try {
    res.json(await listDashboards(req, {
      companyId: companyOf(req), userId: req.user?.userId,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/dashboards/:id', async (req, res) => {
  try {
    const board = await loadDashboard(req, parseInt(req.params.id, 10), {
      companyId: companyOf(req), userId: req.user?.userId,
    });
    if (!board) return res.status(404).json({ error: 'Dashboard not found' });
    res.json(board);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/dashboards', async (req, res) => {
  try {
    const companyId = companyOf(req);
    // dashboards.company_id is NOT NULL by design: a board with no tenant is
    // invisible to every scoped user and visible to a global admin, which is
    // the NULL-scoping trap rather than a feature.
    if (!companyId) {
      return res.status(400).json({ error: 'A dashboard must belong to a company.' });
    }
    const { name, description, visibility } = req.body ?? {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (visibility != null && !['private', 'company'].includes(visibility)) {
      return res.status(400).json({ error: "visibility must be 'private' or 'company'" });
    }
    const r = await pool.query(
      `INSERT INTO dashboards (company_id, owner_user_id, name, description, visibility)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [companyId, req.user?.userId ?? null, String(name).trim(),
       description ?? null, visibility ?? 'private']
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/dashboards/:id', captureBefore('dashboards'), async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE dashboards SET deleted_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
          AND ($2::INTEGER IS NULL OR company_id = $2::INTEGER)
          AND owner_user_id = $3
        RETURNING id`,
      [req.params.id, companyOf(req) ?? null, req.user?.userId ?? null]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Dashboard not found, or not yours to delete' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── widgets ─────────────────────────────────────────────────────────────────
router.post('/dashboards/:id/widgets', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const boardId = parseInt(req.params.id, 10);

    // Only the OWNER may add a tile. A company-visible board is readable by
    // colleagues; it is not writable by them.
    const { rows: owned } = await pool.query(
      `SELECT id, company_id FROM dashboards
        WHERE id = $1 AND deleted_at IS NULL AND owner_user_id = $2
          AND ($3::INTEGER IS NULL OR company_id = $3::INTEGER)`,
      [boardId, req.user?.userId ?? null, companyId ?? null]
    );
    if (!owned.length) return res.status(404).json({ error: 'Dashboard not found, or not yours to edit' });

    const { title, query_config, position_x, position_y, width, height } = req.body ?? {};
    const v = validateQueryConfig(query_config);
    if (!v.ok) return res.status(400).json({ error: v.error });

    // Refuse to SAVE a tile the author cannot read. Otherwise a board becomes a
    // way to park a metric now and have someone else's session run it later.
    const metric = getMetric(v.config.metric);
    const preview = await executeConfig(req, v.config, { companyId });
    if (preview.permitted === false) {
      return res.status(403).json({
        error: `You cannot chart '${metric.label}' — it requires ${metric.permission[0]}:${metric.permission[1]}.`,
      });
    }

    const r = await pool.query(
      `INSERT INTO dashboard_widgets
         (dashboard_id, company_id, title, chart_type, query_config,
          position_x, position_y, width, height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [boardId, owned[0].company_id, String(title || metric.label).trim(),
       v.config.chart_type, JSON.stringify(v.config),
       position_x ?? 0, position_y ?? 0, width ?? 4, height ?? 3]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/widgets/:id', captureBefore('dashboard_widgets'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { rows: owned } = await pool.query(
      `SELECT w.id FROM dashboard_widgets w
         JOIN dashboards d ON d.id = w.dashboard_id
        WHERE w.id = $1 AND d.deleted_at IS NULL AND d.owner_user_id = $2
          AND ($3::INTEGER IS NULL OR w.company_id = $3::INTEGER)`,
      [req.params.id, req.user?.userId ?? null, companyId ?? null]
    );
    if (!owned.length) return res.status(404).json({ error: 'Widget not found, or not yours to edit' });

    const { title, query_config, position_x, position_y, width, height, is_visible } = req.body ?? {};

    // A geometry-only update (dragging a tile) must not require the whole
    // config to be resent, so query_config is optional here.
    let configJson = null;
    if (query_config !== undefined) {
      const v = validateQueryConfig(query_config);
      if (!v.ok) return res.status(400).json({ error: v.error });
      const preview = await executeConfig(req, v.config, { companyId });
      if (preview.permitted === false) {
        return res.status(403).json({ error: preview.error });
      }
      configJson = JSON.stringify(v.config);
    }

    const r = await pool.query(
      `UPDATE dashboard_widgets
          SET title        = COALESCE($1, title),
              query_config = COALESCE($2::jsonb, query_config),
              chart_type   = COALESCE($2::jsonb ->> 'chart_type', chart_type),
              position_x   = COALESCE($3, position_x),
              position_y   = COALESCE($4, position_y),
              width        = COALESCE($5, width),
              height       = COALESCE($6, height),
              is_visible   = COALESCE($7, is_visible),
              updated_at   = NOW()
        WHERE id = $8 RETURNING *`,
      [title ?? null, configJson, position_x ?? null, position_y ?? null,
       width ?? null, height ?? null, is_visible ?? null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/widgets/:id', captureBefore('dashboard_widgets'), async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM dashboard_widgets w
        USING dashboards d
        WHERE w.dashboard_id = d.id AND w.id = $1
          AND d.owner_user_id = $2
          AND ($3::INTEGER IS NULL OR w.company_id = $3::INTEGER)
        RETURNING w.id`,
      [req.params.id, req.user?.userId ?? null, companyOf(req) ?? null]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Widget not found, or not yours to delete' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 7. DOCUMENT MANAGEMENT
// ════════════════════════════════════════════════════════════
router.get('/documents', async (req, res) => {
  try {
    const { module, record_id } = req.query;
    const r = await pool.query(
      `SELECT d.*, u.name as uploaded_by_name
       FROM documents d LEFT JOIN users u ON d.uploaded_by = u.id
       WHERE ($1::text IS NULL OR d.module=$1)
         AND ($2::int  IS NULL OR d.record_id=$2)
       ORDER BY d.created_at DESC`,
      [module || null, record_id ? parseInt(record_id) : null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/documents', async (req, res) => {
  try {
    const { module, record_id, document_name, document_type, file_path, is_mandatory, tags, expires_at } = req.body;
    const r = await pool.query(
      `INSERT INTO documents (module, record_id, document_name, document_type, file_path,
                              is_mandatory, tags, expires_at, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [module, record_id || null, document_name, document_type || 'general',
       file_path || '#', is_mandatory || false, tags || [], expires_at || null, req.user?.userId]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/documents/:id/verify', captureBefore('documents'), async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE documents SET is_verified=true, verified_by=$1, verified_at=NOW() WHERE id=$2 RETURNING *',
      [req.user?.userId, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 8. AUDIT LOG
// ════════════════════════════════════════════════════════════
router.get('/audit-logs', async (req, res) => {
  try {
    const { module, user_id, action, from_date, to_date, limit } = req.query;
    const r = await pool.query(
      `SELECT al.*, u.name as user_name_resolved
       FROM audit_logs al LEFT JOIN users u ON al.user_id = u.id
       WHERE ($1::text IS NULL OR al.module_name=$1)
         AND ($2::int  IS NULL OR al.user_id=$2)
         AND ($3::text IS NULL OR al.action_type=$3)
         AND ($4::text IS NULL OR al.created_at >= $4::timestamptz)
         AND ($5::text IS NULL OR al.created_at <= $5::timestamptz)
         AND ($7::int  IS NULL OR al.company_id = $7)
       ORDER BY al.created_at DESC
       LIMIT $6`,
      [module||null, user_id?parseInt(user_id):null, action||null,
       from_date||null, to_date||null, parseInt(limit||100), companyOf(req) ?? null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/audit-logs', async (req, res) => {
  try {
    const { module, record_id, action, old_data, new_data } = req.body;
    const changed = old_data && new_data
      ? Object.keys(new_data).filter(k => JSON.stringify(old_data[k]) !== JSON.stringify(new_data[k]))
      : [];
    // Was a second, hand-rolled INSERT writing eight columns that do not exist
    // on audit_logs (user_name, user_role, module, record_id, action, old_data,
    // new_data, changed_fields) — so every write through this endpoint threw and
    // nothing was ever audited by it. The canonical writer is
    // audit/repositories/audit.repository.js; using it means one shape, one place.
    //
    // `changed_fields` has no column, so the computed diff is carried inside
    // new_data_json where it stays queryable rather than being dropped.
    await auditRepository.create({
      user_id:        req.user?.userId ?? null,
      module_name:    module,
      action_type:    action,
      reference_id:   record_id || null,
      reference_type: req.body.reference_type || null,
      old_data_json:  old_data || null,
      new_data_json:  new_data ? { ...new_data, __changed_fields: changed } : null,
      ip_address:     req.ip,
      user_agent:     req.headers['user-agent'] || null,
      company_id:     companyOf(req),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/audit-logs/summary', async (req, res) => {
  try {
    const r = await pool.query(`
      -- audit_logs carries company_id. Unscoped, this summary reported another
      -- tenant's activity mix to anyone who opened the page.
      SELECT action_type AS action, module_name AS module, COUNT(*) as count
      FROM audit_logs
      WHERE created_at >= NOW() - INTERVAL '7 days'
        AND ($1::int IS NULL OR company_id = $1)
      GROUP BY action_type, module_name ORDER BY count DESC LIMIT 20
    `, [companyOf(req) ?? null]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 9. FINANCIAL LAYER
// ════════════════════════════════════════════════════════════
router.get('/project-costs', async (req, res) => {
  try {
    const { project_id } = req.query;
    const r = await pool.query(
      `SELECT pc.*, u.name as recorded_by_name,
              p.project_name
       FROM project_costs pc
       LEFT JOIN users u ON pc.recorded_by = u.id
       LEFT JOIN projects p ON pc.project_id = p.id
       WHERE ($1::int IS NULL OR pc.project_id=$1)
       ORDER BY pc.cost_date DESC`,
      [project_id ? parseInt(project_id) : null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/project-costs', async (req, res) => {
  try {
    const { project_id, cost_type, description, amount, cost_date } = req.body;
    const r = await pool.query(
      `INSERT INTO project_costs (project_id, cost_type, description, amount, cost_date, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [project_id, cost_type, description||'', amount, cost_date||new Date(), req.user?.userId]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/budget-vs-actual', async (req, res) => {
  try {
    const { module, period } = req.query;
    const r = await pool.query(
      `SELECT * FROM budget_vs_actual
       WHERE ($1::text IS NULL OR module=$1)
         AND ($2::text IS NULL OR period=$2)
       ORDER BY period DESC, department`,
      [module||null, period||null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/profit-tracker', async (req, res) => {
  try {
    const { project_id, period } = req.query;
    const r = await pool.query(
      `SELECT pt.*, p.project_name
       FROM profit_tracker pt LEFT JOIN projects p ON pt.project_id = p.id
       WHERE ($1::int  IS NULL OR pt.project_id=$1)
         AND ($2::text IS NULL OR pt.period=$2)
       ORDER BY pt.period DESC`,
      [project_id?parseInt(project_id):null, period||null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 10. MASTER DATA ENGINE
// ════════════════════════════════════════════════════════════
router.get('/masters', async (req, res) => {
  try {
    const { type } = req.query;
    const r = await pool.query(
      `SELECT * FROM masters WHERE ($1::text IS NULL OR type=$1) AND is_active=true
       ORDER BY type, sort_order, value`,
      [type || null]
    );
    // Group by type
    const grouped = {};
    for (const row of r.rows) {
      if (!grouped[row.type]) grouped[row.type] = [];
      grouped[row.type].push(row);
    }
    res.json(type ? r.rows : grouped);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/masters', async (req, res) => {
  try {
    const { type, code, value, label, parent_id, sort_order } = req.body;
    const r = await pool.query(
      `INSERT INTO masters (type, code, value, label, parent_id, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (type, value) DO UPDATE SET label=$4, is_active=true
       RETURNING *`,
      [type, code||null, value, label||value, parent_id||null, sort_order||0, req.user?.userId]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/masters/:id', captureBefore('masters'), async (req, res) => {
  try {
    await pool.query('UPDATE masters SET is_active=false WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 11. MULTI-COMPANY / BRANCH
// ════════════════════════════════════════════════════════════
router.get('/companies', async (req, res) => {
  try {
    const r = await pool.query(`
      -- A scoped caller sees only their own company. companies has no
      -- company_id of its own, so the predicate is on the primary key; an
      -- unassigned super admin (companyOf === null) still sees every tenant,
      -- which is the established convention across this surface.
      SELECT c.*, COUNT(b.id) as branch_count
      FROM companies c LEFT JOIN branches b ON b.company_id=c.id
      WHERE c.is_active=true AND ($1::int IS NULL OR c.id = $1)
      GROUP BY c.id ORDER BY c.name
    `, [companyOf(req) ?? null]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/companies', async (req, res) => {
  try {
    const { company_name, company_code, address, city, country, gst_number, pan_number, email, phone } = req.body;
    const r = await pool.query(
      `INSERT INTO companies (name, code, address, city, country, gstin, pan, email, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [company_name, company_code, address||'', city||'', country||'India', gst_number||'', pan_number||'', email||'', phone||'']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/branches', async (req, res) => {
  try {
    const { company_id } = req.query;
    const r = await pool.query(
      `SELECT b.*, c.name AS company_name, COUNT(e.id) as employee_count
       FROM branches b
       JOIN companies c ON b.company_id = c.id
       LEFT JOIN employees e ON e.branch_id = b.id AND ${sqlEmployeeActive('e.status')}
       -- The caller's own company always wins over the ?company_id query param,
       -- so the parameter can narrow the result but never widen it past the
       -- caller's tenant.
       WHERE ($1::int IS NULL OR b.company_id=$1) AND b.is_active=true
       GROUP BY b.id, c.name ORDER BY c.name, b.name`,
      [companyOf(req) ?? (company_id ? parseInt(company_id) : null)]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/branches', async (req, res) => {
  try {
    const { company_id, branch_name, branch_code, city, address, is_head_office } = req.body;
    const r = await pool.query(
      `INSERT INTO branches (company_id, name, code, city, address, branch_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [company_id, branch_name, branch_code, city||'', address||'',
       is_head_office ? 'head_office' : 'branch']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 12. SMART INSIGHTS
// ════════════════════════════════════════════════════════════
router.get('/insights', async (req, res) => {
  try {
    const { category } = req.query;
    const r = await pool.query(
      'SELECT * FROM insights_cache WHERE ($1::text IS NULL OR category=$1) ORDER BY category, metric_name',
      [category || null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Refresh insights by computing from live data
router.post('/insights/refresh', async (req, res) => {
  try {
    const updates = [];

    // HR: Most delayed department (from tasks)
    try {
      const dept = await pool.query(`
        SELECT e.department,
               AVG(EXTRACT(EPOCH FROM (NOW()-t.created_at))/3600) as avg_hours
        FROM tasks t JOIN employees e ON t.assigned_to=e.id
        WHERE t.status NOT IN ('completed','done')
        GROUP BY e.department ORDER BY avg_hours DESC LIMIT 1
      `);
      if (dept.rows[0]) {
        await pool.query(
          `UPDATE insights_cache SET value=$1, last_updated=NOW()
           WHERE metric_key='hr.most_delayed_dept'`,
          [JSON.stringify({ department: dept.rows[0].department, avg_delay_hours: parseFloat(dept.rows[0].avg_hours||0).toFixed(1) })]
        );
        updates.push('hr.most_delayed_dept');
      }
    } catch (_) {}

    // Finance: Overdue invoices
    try {
      const inv = await pool.query(`
        SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as total
        FROM invoices WHERE status IN ('Overdue','overdue')
          OR (due_date < CURRENT_DATE AND status NOT IN ('Paid','paid','Cancelled','cancelled'))
      `);
      await pool.query(
        `UPDATE insights_cache SET value=$1, last_updated=NOW() WHERE metric_key='finance.overdue_invoices'`,
        [JSON.stringify({ count: parseInt(inv.rows[0].count), total_amount: parseFloat(inv.rows[0].total).toFixed(2) })]
      );
      updates.push('finance.overdue_invoices');
    } catch (_) {}

    // Ops: Average ticket resolution
    // service_tickets doesn't exist — real table is support_tickets, real status values
    // are Title-case ('Open'/'Resolved'/'In Progress', confirmed live).
    try {
      const tkt = await pool.query(`
        SELECT AVG(EXTRACT(EPOCH FROM (updated_at-created_at))/3600) as avg_hours,
               COUNT(*) FILTER (WHERE status='Open' AND created_at < NOW()-INTERVAL '24h') as sla_breach
        FROM support_tickets WHERE status IN ('Resolved','Closed')
          AND updated_at >= NOW()-INTERVAL '30d'
      `);
      await pool.query(
        `UPDATE insights_cache SET value=$1, last_updated=NOW() WHERE metric_key='ops.avg_ticket_resolution'`,
        [JSON.stringify({ avg_hours: parseFloat(tkt.rows[0].avg_hours||0).toFixed(1), sla_breach_count: parseInt(tkt.rows[0].sla_breach||0) })]
      );
      updates.push('ops.avg_ticket_resolution');
    } catch (_) {}

    res.json({ success: true, updated: updates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// 13. DATA VALIDATION ENGINE
// ════════════════════════════════════════════════════════════
router.get('/validation-rules', async (req, res) => {
  try {
    const { module } = req.query;
    const r = await pool.query(
      `SELECT * FROM validation_rules
       WHERE ($1::text IS NULL OR module=$1) AND is_active=true
         AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
       ORDER BY module, field_name`,
      [module || null, companyOf(req) ?? null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/validation-rules', async (req, res) => {
  try {
    const { module, field_name, rule_type, rule_value, error_message } = req.body;
    const r = await pool.query(
      `INSERT INTO validation_rules (module, field_name, rule_type, rule_expr, error_message)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (module, field_name, rule_type) DO UPDATE
       SET rule_expr=$4, error_message=$5 RETURNING *`,
      [module, field_name, rule_type, rule_value||null, error_message||'']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Validate a payload against rules for a module
router.post('/validation-rules/validate', async (req, res) => {
  try {
    const { module, data } = req.body;
    const rules = await pool.query(
      'SELECT * FROM validation_rules WHERE module=$1 AND is_active=true ORDER BY field_name',
      [module]
    );
    const errors = {};
    for (const rule of rules.rows) {
      // The stored expression lives in rule_expr; `rule_value` is the request-side name.
      const { field_name, rule_type, rule_expr: rule_value, error_message } = rule;
      const val = data[field_name];
      let fail = false;

      if (rule_type === 'required')    fail = val === null || val === undefined || val === '';
      if (rule_type === 'min')         fail = parseFloat(val) < parseFloat(rule_value);
      if (rule_type === 'max')         fail = parseFloat(val) > parseFloat(rule_value);
      if (rule_type === 'min_length')  fail = !val || String(val).length < parseInt(rule_value);
      if (rule_type === 'max_length')  fail = val && String(val).length > parseInt(rule_value);
      if (rule_type === 'regex')       fail = val && !new RegExp(rule_value).test(String(val));

      if (fail && !errors[field_name]) errors[field_name] = error_message;
    }
    res.json({ valid: Object.keys(errors).length === 0, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
