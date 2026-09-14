import express from 'express';
import pool from '../../config/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { logAudit } from '../../services/AuditService.js';
import { runRule, evaluateConditions } from '../../services/workflowEngine.js';
import { captureBefore } from '../../middlewares/captureBefore.js';

const router = express.Router();

/**
 * Workflow RULE management is administrator configuration.
 *
 * The router is mounted `v1Router.use("/workflows", verifyToken, workflowRoutes)`
 * and carried no further gate, so a plain `employee` token could create, edit,
 * toggle and DELETE automation rules — confirmed live on 2026-09-03 with a
 * successful POST / (201) from an `employee` account.
 *
 * Two endpoints are deliberately left open to any authenticated caller:
 * GET /instance-status and POST /batch-status. Those return the workflow badge
 * for records the caller is already looking at (AllLeaves.jsx and Projects.jsx
 * both call batch-status for the rows they just fetched), so gating them to
 * admins would blank the badge for every ordinary user.
 */
const canConfigure = allowRoles('admin', 'super_admin');


// Maps trigger_module display name → approver_config.module key
const TRIGGER_MODULE_MAP = {
  'Leave': 'leave', 'Expense': 'expense', 'Purchase Order': 'purchase',
  'Invoice': 'finance', 'Recruitment': 'recruitment', 'Travel': 'general',
};

// sampleWorkflows() lived here: four hardcoded rules ("Leave Auto-Approval",
// "High-Value PO Escalation", ...) that GET / returned whenever the table was
// empty or the query threw. They were not rows, could not be edited, and never
// executed — an empty automation list rendered as four healthy-looking
// automations. Removed 2026-09-03 with the engine that made the real ones run.

async function fetchApproverLevelMap() {
  try {
    const { rows } = await pool.query(
      `SELECT module, COUNT(*) AS levels FROM approver_config WHERE is_active = true GROUP BY module`
    );
    const map = {};
    rows.forEach(r => { map[r.module] = parseInt(r.levels, 10); });
    return map;
  } catch { return {}; }
}

/**
 * `approval_chain` is jsonb, and the driver hands back whatever shape is stored:
 * an ARRAY for a real chain, a STRING only for legacy text rows, and an OBJECT
 * for the seeder's rows (which hold `{"i":0,"seed":"SEED"}`). The previous code
 * did `Array.isArray(x) ? x : (x ? JSON.parse(x) : [])`, so an object took the
 * parse branch and threw `"[object Object]" is not valid JSON` on every request.
 *
 * It never surfaced because GET / caught everything and returned four hardcoded
 * sample workflows instead — the endpoint reported healthy fixture data for a
 * query that was crashing. Removing that fallback (2026-09-03) is what exposed
 * this. Anything that is not an array is now treated as "no chain", which is
 * what a malformed value means for the only thing this function does with it.
 */
function normaliseChain(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function augmentWithApproverLevels(workflows, approverLevelMap) {
  return workflows.map(wf => {
    const chain = normaliseChain(wf.approval_chain);
    if (chain.length > 0) return { ...wf, _global_approver_levels: null };
    const moduleKey = TRIGGER_MODULE_MAP[wf.trigger_module] || (wf.trigger_module || '').toLowerCase();
    return { ...wf, _global_approver_levels: approverLevelMap[moduleKey] ?? 0 };
  });
}

// GET /api/workflows
//
// Two changes from the version this replaces, both deliberate:
//
//  1. SCOPED. The old query was a bare SELECT over workflow_rules with no
//     company predicate. The table had no company_id at all until migration
//     20260903000023; now that rules actually execute, showing (and letting an
//     admin edit) another tenant's automation is not acceptable.
//  2. NO SAMPLE FALLBACK. It used to return four hardcoded sampleWorkflows()
//     rows — 'Leave Auto-Approval', 'High-Value PO Escalation' and two more,
//     complete with invented trigger_count and last_triggered_at — whenever the
//     table was empty OR the query threw. Those rules do not exist, cannot be
//     edited and never ran. An empty automation list now reads as empty, and a
//     failure reads as a failure.
router.get('/', canConfigure, async (req, res) => {
  try {
    const cid = companyOf(req);
    const [{ rows }, approverLevelMap] = await Promise.all([
      pool.query(
        `SELECT * FROM workflow_rules
          WHERE ($1::int IS NULL OR company_id = $1)
          ORDER BY priority ASC, created_at DESC`,
        [cid]
      ),
      fetchApproverLevelMap(),
    ]);
    res.json(augmentWithApproverLevels(rows, approverLevelMap));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/workflows
router.post('/', canConfigure, async (req, res) => {
  try {
    const cid = companyOf(req);
    if (cid == null) {
      return res.status(400).json({ success: false, message: 'A company scope is required to create a workflow rule' });
    }
    const { name, description, trigger_module, trigger_event, conditions = [], actions = [],
            approval_chain = [], created_by, priority } = req.body;
    if (!name || !trigger_module || !trigger_event)
      return res.status(400).json({ success: false, message: 'name, trigger_module and trigger_event are required' });

    // Reject a rule whose conditions the engine cannot evaluate, at SAVE time.
    // Storing one that throws on every dispatch produces a rule that looks
    // active in the builder and only ever writes failures to the run log.
    try {
      evaluateConditions(conditions, { record: {} });
    } catch (e) {
      return res.status(400).json({ success: false, message: `Invalid conditions: ${e.message}` });
    }

    const { rows } = await pool.query(
      `INSERT INTO workflow_rules
         (company_id,name,description,trigger_module,trigger_event,conditions,actions,approval_chain,created_by,priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [cid, name, description, trigger_module, trigger_event,
       JSON.stringify(conditions), JSON.stringify(actions), JSON.stringify(approval_chain),
       created_by ?? req.user?.email ?? null,
       Number.isFinite(Number(priority)) ? Number(priority) : 100]
    );
    logAudit({ userId: req.user?.userId, module: 'admin', recordId: rows[0].id,
               recordType: 'workflow_rule', action: 'create', newData: rows[0], req, company_id: cid });
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/workflows/:id
router.put('/:id', canConfigure, async (req, res) => {
  try {
    const cid = companyOf(req);
    const { name, description, trigger_module, trigger_event, conditions, actions,
            approval_chain, priority } = req.body;
    try {
      evaluateConditions(conditions, { record: {} });
    } catch (e) {
      return res.status(400).json({ success: false, message: `Invalid conditions: ${e.message}` });
    }
    const { rows: [before] } = await pool.query(
      `SELECT * FROM workflow_rules WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]
    );
    if (!before) return res.status(404).json({ success: false, message: 'Not found' });
    const { rows } = await pool.query(
      `UPDATE workflow_rules SET name=$1,description=$2,trigger_module=$3,trigger_event=$4,
       conditions=$5,actions=$6,approval_chain=$7,priority=$8,updated_at=NOW()
       WHERE id=$9 AND ($10::int IS NULL OR company_id=$10) RETURNING *`,
      [name, description, trigger_module, trigger_event, JSON.stringify(conditions),
       JSON.stringify(actions), JSON.stringify(approval_chain),
       Number.isFinite(Number(priority)) ? Number(priority) : (before.priority ?? 100),
       req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    logAudit({ userId: req.user?.userId, module: 'admin', recordId: req.params.id,
               recordType: 'workflow_rule', action: 'update', oldData: before, newData: rows[0], req, company_id: cid });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/workflows/:id/toggle
router.patch('/:id/toggle', canConfigure, captureBefore('workflow_rules'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE workflow_rules SET is_active = NOT is_active, updated_at=NOW()
        WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id, is_active`,
      [req.params.id, companyOf(req)]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/workflows/:id
router.delete('/:id', canConfigure, async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows: [before] } = await pool.query(
      `SELECT * FROM workflow_rules WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]
    );
    if (!before) return res.status(404).json({ success: false, message: 'Not found' });
    await pool.query(
      `DELETE FROM workflow_rules WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]
    );
    logAudit({ userId: req.user?.userId, module: 'admin', recordId: req.params.id,
               recordType: 'workflow_rule', action: 'delete', oldData: before, req, company_id: cid });
    res.json({ success: true, message: 'Workflow deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/workflows/instance-status?module=Leave&entity_id=5
// Returns the latest workflow instance for a single entity.
router.get('/instance-status', async (req, res) => {
  try {
    const { module: mod, entity_id } = req.query;
    if (!mod || !entity_id) return res.status(400).json({ error: 'module and entity_id required' });
    const { rows: [inst] } = await pool.query(
      `SELECT wi.entity_id, wi.status,
              ws.step_name      AS current_step_name,
              ws.assignee_role  AS current_step_role,
              wf.name           AS workflow_name
         FROM workflow_instances wi
         JOIN workflows          wf ON wf.id  = wi.workflow_id
         LEFT JOIN workflow_steps ws ON ws.id = wi.current_step_id
        WHERE wi.module = $1 AND wi.entity_id = $2
        ORDER BY wi.created_at DESC LIMIT 1`,
      [mod, parseInt(entity_id, 10)]
    );
    res.json(inst || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/workflows/batch-status
// Body: { module: "Leave", entity_ids: [1,2,3] }
// Returns a map: { "1": { status, current_step_name, current_step_role, workflow_name }, ... }
router.post('/batch-status', async (req, res) => {
  try {
    const { module: mod, entity_ids } = req.body;
    if (!mod || !Array.isArray(entity_ids) || entity_ids.length === 0) {
      return res.status(400).json({ error: 'module and entity_ids[] required' });
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (wi.entity_id)
              wi.entity_id, wi.status,
              ws.step_name      AS current_step_name,
              ws.assignee_role  AS current_step_role,
              wf.name           AS workflow_name
         FROM workflow_instances wi
         JOIN workflows          wf ON wf.id  = wi.workflow_id
         LEFT JOIN workflow_steps ws ON ws.id = wi.current_step_id
        WHERE wi.module = $1 AND wi.entity_id = ANY($2::int[])
        ORDER BY wi.entity_id, wi.created_at DESC`,
      [mod, entity_ids.map(Number)]
    );
    const result = {};
    rows.forEach(r => { result[r.entity_id] = r; });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workflows/:id/runs  — run history for a specific workflow
router.get('/:id/runs', canConfigure, async (req, res) => {
  try {
    // matched / actions_result / attempt are what make a run inspectable:
    // 'skipped' with matched=false is a rule correctly declining to fire, while
    // 'failed' is a rule breaking, and a single status column cannot say both.
    const { rows } = await pool.query(
      `SELECT id, triggered_at, status, matched, entity_id, entity_module,
              duration_ms, attempt, actions_result, error_message
       FROM workflow_run_logs WHERE workflow_id = $1
          AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
        ORDER BY triggered_at DESC LIMIT 50`,
      [req.params.id, companyOf(req)]
    );
    res.json(rows);
  } catch (err) {
    // This used to be `catch { res.json([]) }`. A query error and "this rule has
    // never run" are different answers, and collapsing them meant a broken run
    // history rendered as an empty one — which is exactly how the missing $2
    // binding added alongside the company filter went unnoticed until an
    // end-to-end run asserted on it.
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/workflows/:id  — must be after all fixed-path GET routes to avoid shadowing
router.get('/:id', canConfigure, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM workflow_rules WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyOf(req)]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/workflows/:id/trigger — run the rule for real.
//
// WHAT THIS USED TO DO, in full: increment trigger_count, write a run log with
// a HARDCODED status of 'completed', and return the rule's actions under the
// key `simulated_actions`. It read no conditions and performed no action, so
// every rule accumulated a clean execution history for work that never
// happened — including rules whose conditions did not hold.
//
// It now evaluates the conditions against the supplied record and executes the
// actions through the engine's registry, recording per-action outcomes. A rule
// whose conditions do not hold is logged as 'skipped' with matched=false: a
// correct decision not to fire, which is a different answer from a failure.
router.post('/:id/trigger', canConfigure, async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT * FROM workflow_rules WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    const rule = rows[0];

    const { entity_id, entity_module, table, record, previous } = req.body || {};
    const log = await runRule(rule, {
      companyId: cid ?? rule.company_id,
      module: entity_module || rule.trigger_module,
      event: rule.trigger_event,
      entityId: entity_id ?? null,
      table: table ?? null,
      record: record ?? {},
      previous: previous ?? {},
      actorUserId: req.user?.userId ?? null,
    });

    logAudit({ userId: req.user?.userId, module: 'admin', recordId: rule.id,
               recordType: 'workflow_rule', action: 'trigger',
               newData: { status: log.status, matched: log.matched }, req, company_id: cid });

    res.json({
      success: log.status !== 'failed',
      matched: log.matched,
      status:  log.status,
      message: log.matched
        ? `Workflow "${rule.name}" ran: ${log.status}`
        : `Workflow "${rule.name}" evaluated but its conditions did not match — no action taken`,
      actions_result: log.actions_result,
      error: log.error_message,
      duration_ms: log.duration_ms,
      run_log_id: log.id,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
