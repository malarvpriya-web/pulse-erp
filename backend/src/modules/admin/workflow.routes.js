import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();


// Maps trigger_module display name → approver_config.module key
const TRIGGER_MODULE_MAP = {
  'Leave': 'leave', 'Expense': 'expense', 'Purchase Order': 'purchase',
  'Invoice': 'finance', 'Recruitment': 'recruitment', 'Travel': 'general',
};

function sampleWorkflows() {
  return [
    { id:1, name:'Leave Auto-Approval', description:'Auto-approve leave < 2 days for employees with 0 pending leaves', trigger_module:'Leave', trigger_event:'Created', conditions:[{field:'duration_days',operator:'less_than',value:'2',logic:'AND'},{field:'pending_leaves',operator:'equals',value:'0',logic:'AND'}], actions:[{type:'Send Notification',config:{to_role:'manager',body:'{{employee_name}}\'s 1-day leave on {{start_date}} was auto-approved. No action needed.'}},{type:'Update Field',config:{field:'status',value:'approved'}}], approval_chain:[], is_active:true, last_triggered_at:'2026-03-28T10:00:00Z', trigger_count:24 },
    { id:2, name:'High-Value PO Escalation', description:'Escalate POs > ₹10L to Finance Head', trigger_module:'Purchase Order', trigger_event:'Created', conditions:[{field:'amount',operator:'greater_than',value:'1000000',logic:'AND'}], actions:[{type:'Send Email',config:{to_role:'Finance Head',subject:'High-Value PO Requires Approval',body:'A purchase order for ₹{{amount}} has been raised by {{created_by}} and requires your approval.'}},{type:'Escalate To',config:{role:'Finance Head',after_hours:2}}], approval_chain:[{level:1,approver_role:'Manager',type:'any one',escalate_after_hours:4,on_reject:'notify manager'},{level:2,approver_role:'Finance Head',type:'all must approve',escalate_after_hours:8,on_reject:'stop'}], is_active:true, last_triggered_at:'2026-03-27T14:30:00Z', trigger_count:7 },
    { id:3, name:'Leave Approval Reminder', description:'Remind manager when a leave request is pending for 48+ hours; escalate to HR after 96 hours', trigger_module:'Leave', trigger_event:'Status Changed', conditions:[{field:'status',operator:'equals',value:'pending',logic:'AND'},{field:'pending_hours',operator:'greater_than',value:'48',logic:'AND'}], actions:[{type:'Send Notification',config:{to_role:'Manager',body:'Leave request from {{employee_name}} ({{leave_type}}, {{start_date}} – {{end_date}}) has been pending approval for {{pending_hours}} hours. Please review.'}},{type:'Escalate To',config:{role:'HR Head',after_hours:96}}], approval_chain:[], is_active:true, last_triggered_at:null, trigger_count:0 },
    { id:4, name:'Invoice Overdue Reminder', description:'Send reminder when invoice is overdue by 7+ days', trigger_module:'Invoice', trigger_event:'Status Changed', conditions:[{field:'status',operator:'equals',value:'overdue',logic:'AND'},{field:'days_overdue',operator:'greater_than',value:'7',logic:'AND'}], actions:[{type:'Send Email',config:{to_role:'Finance Head',subject:'Invoice Overdue Alert',body:'Invoice {{invoice_number}} for ₹{{amount}} is {{days_overdue}} days overdue. Client: {{client_name}}'}},{type:'Create Task',config:{assignee_role:'Finance Head',title:'Follow up on overdue invoice',due_date_offset:1}}], approval_chain:[], is_active:false, last_triggered_at:'2026-03-20T09:00:00Z', trigger_count:15 },
  ];
}

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

function augmentWithApproverLevels(workflows, approverLevelMap) {
  return workflows.map(wf => {
    const chain = Array.isArray(wf.approval_chain) ? wf.approval_chain
      : (wf.approval_chain ? JSON.parse(wf.approval_chain) : []);
    if (chain.length > 0) return { ...wf, _global_approver_levels: null };
    const moduleKey = TRIGGER_MODULE_MAP[wf.trigger_module] || (wf.trigger_module || '').toLowerCase();
    return { ...wf, _global_approver_levels: approverLevelMap[moduleKey] ?? 0 };
  });
}

// GET /api/workflows
router.get('/', async (req, res) => {
  try {
    const [{ rows }, approverLevelMap] = await Promise.all([
      pool.query('SELECT * FROM workflow_rules ORDER BY created_at DESC'),
      fetchApproverLevelMap(),
    ]);
    const workflows = rows.length ? rows : sampleWorkflows();
    res.json(augmentWithApproverLevels(workflows, approverLevelMap));
  } catch {
    res.json(sampleWorkflows().map(wf => ({ ...wf, _global_approver_levels: null })));
  }
});

// POST /api/workflows
router.post('/', async (req, res) => {
  try {
    const { name, description, trigger_module, trigger_event, conditions = [], actions = [], approval_chain = [], created_by } = req.body;
    if (!name || !trigger_module || !trigger_event)
      return res.status(400).json({ success: false, message: 'name, trigger_module and trigger_event are required' });
    const { rows } = await pool.query(
      `INSERT INTO workflow_rules (name,description,trigger_module,trigger_event,conditions,actions,approval_chain,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, description, trigger_module, trigger_event, JSON.stringify(conditions), JSON.stringify(actions), JSON.stringify(approval_chain), created_by]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/workflows/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, description, trigger_module, trigger_event, conditions, actions, approval_chain } = req.body;
    const { rows } = await pool.query(
      `UPDATE workflow_rules SET name=$1,description=$2,trigger_module=$3,trigger_event=$4,
       conditions=$5,actions=$6,approval_chain=$7,updated_at=NOW() WHERE id=$8 RETURNING *`,
      [name, description, trigger_module, trigger_event, JSON.stringify(conditions), JSON.stringify(actions), JSON.stringify(approval_chain), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/workflows/:id/toggle
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE workflow_rules SET is_active = NOT is_active, updated_at=NOW() WHERE id=$1 RETURNING id, is_active`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/workflows/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM workflow_rules WHERE id=$1', [req.params.id]);
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
router.get('/:id/runs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, triggered_at, status, entity_id, entity_module, duration_ms, error_message
       FROM workflow_run_logs WHERE workflow_id = $1 ORDER BY triggered_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
});

// GET /api/workflows/:id  — must be after all fixed-path GET routes to avoid shadowing
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM workflow_rules WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/workflows/:id/trigger
router.post('/:id/trigger', async (req, res) => {
  const startMs = Date.now();
  try {
    const { rows } = await pool.query(
      `UPDATE workflow_rules SET last_triggered_at=NOW(), trigger_count=trigger_count+1 WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });

    // Record run log — silent fail if table not yet migrated
    const { entity_id, entity_module } = req.body || {};
    try {
      await pool.query(
        `INSERT INTO workflow_run_logs (workflow_id, status, entity_id, entity_module, duration_ms)
         VALUES ($1, 'completed', $2, $3, $4)`,
        [req.params.id, entity_id || null, entity_module || rows[0].trigger_module, Date.now() - startMs]
      );
    } catch { /* table not yet created — safe to ignore */ }

    res.json({ success: true, message: `Workflow "${rows[0].name}" triggered successfully`, simulated_actions: rows[0].actions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
