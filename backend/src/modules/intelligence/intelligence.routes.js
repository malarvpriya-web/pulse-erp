/**
 * intelligence.routes.js
 * All 13 system APIs — Rule Engine, Permissions, Workflow, SLA,
 * Notifications, Dashboard Builder, Documents, Audit, Finance,
 * Masters, Multi-company, Insights, Validation
 */
import { Router } from 'express';
import pool from '../../config/db.js';

const router = Router();


// ════════════════════════════════════════════════════════════
// 1. RULE ENGINE
// ════════════════════════════════════════════════════════════
router.get('/rules', async (req, res) => {
  try {
    const { module } = req.query;
    const r = await pool.query(
      `SELECT * FROM rules_master
       WHERE ($1::text IS NULL OR module_name = $1) AND is_active = true
       ORDER BY priority, module_name`,
      [module || null]
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

router.put('/rules/:id', async (req, res) => {
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

router.delete('/rules/:id', async (req, res) => {
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
    const r = await pool.query('SELECT * FROM roles ORDER BY id');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/role-permissions', async (req, res) => {
  try {
    const { role } = req.query;
    const r = await pool.query(
      'SELECT * FROM role_permissions WHERE ($1::text IS NULL OR role_name=$1) ORDER BY module, action',
      [role || null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/role-permissions', async (req, res) => {
  try {
    const { role_name, module, action, is_allowed } = req.body;
    const r = await pool.query(
      `INSERT INTO role_permissions (role_name, module, action, is_allowed)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (role_name, module, action) DO UPDATE SET is_allowed=$4
       RETURNING *`,
      [role_name, module, action, is_allowed]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/field-permissions', async (req, res) => {
  try {
    const { role, module } = req.query;
    const r = await pool.query(
      `SELECT * FROM field_permissions
       WHERE ($1::text IS NULL OR role_name=$1) AND ($2::text IS NULL OR module=$2)`,
      [role || null, module || null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/field-permissions', async (req, res) => {
  try {
    const { role_name, module, field_name, is_visible, is_editable } = req.body;
    const r = await pool.query(
      `INSERT INTO field_permissions (role_name, module, field_name, is_visible, is_editable)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (role_name, module, field_name)
       DO UPDATE SET is_visible=$4, is_editable=$5 RETURNING *`,
      [role_name, module, field_name, is_visible, is_editable]
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
       LEFT JOIN workflow_steps ws ON wi.current_step = ws.id
       LEFT JOIN users u ON wi.started_by = u.id
       WHERE ($1::text IS NULL OR wi.module=$1)
         AND ($2::int  IS NULL OR wi.record_id=$2)
         AND ($3::text IS NULL OR wi.status=$3)
       ORDER BY wi.started_at DESC`,
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
      `INSERT INTO workflow_instances (workflow_id, module, record_id, current_step, started_by)
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
      [inst.rows[0].workflow_id, inst.rows[0].current_step, action]
    );

    if (!transition.rows.length) return res.status(400).json({ error: `No transition found for action: ${action}` });

    const next = transition.rows[0];
    await pool.query('UPDATE workflow_instances SET current_step=$1 WHERE id=$2', [next.next_id, req.params.id]);
    await pool.query(
      `INSERT INTO workflow_instance_history (instance_id, step_id, action, actor_id, comment)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, inst.rows[0].current_step, action, req.user?.userId, comment || '']
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
    const r = await pool.query('SELECT * FROM notification_rules WHERE is_active=true ORDER BY module, event_name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/notification-rules/:id', async (req, res) => {
  try {
    const { is_active, template, channel } = req.body;
    const r = await pool.query(
      'UPDATE notification_rules SET is_active=$1, template=$2, channel=$3 WHERE id=$4 RETURNING *',
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
      'SELECT * FROM notification_rules WHERE event_name=$1 AND is_active=true',
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
          `INSERT INTO notifications (user_id, message, module, record_id, is_read, created_at)
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
router.get('/widgets', async (req, res) => {
  try {
    const role = req.user?.role || 'employee';
    const userId = req.user?.userId;
    const r = await pool.query(
      `SELECT * FROM dashboard_widgets
       WHERE (user_id=$1 OR role_default=$2) AND is_visible=true
       ORDER BY position_y, position_x`,
      [userId, role]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/widgets', async (req, res) => {
  try {
    const { widget_type, widget_name, query_config, position_x, position_y, width, height } = req.body;
    const r = await pool.query(
      `INSERT INTO dashboard_widgets (user_id, widget_type, widget_name, query_config, position_x, position_y, width, height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user?.userId, widget_type, widget_name, query_config, position_x||0, position_y||0, width||4, height||2]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/widgets/:id', async (req, res) => {
  try {
    const { widget_name, query_config, position_x, position_y, width, height, is_visible } = req.body;
    const r = await pool.query(
      `UPDATE dashboard_widgets
       SET widget_name=$1, query_config=$2, position_x=$3, position_y=$4,
           width=$5, height=$6, is_visible=$7, updated_at=NOW()
       WHERE id=$8 AND user_id=$9 RETURNING *`,
      [widget_name, query_config, position_x, position_y, width, height, is_visible, req.params.id, req.user?.userId]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/widgets/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM dashboard_widgets WHERE id=$1 AND user_id=$2', [req.params.id, req.user?.userId]);
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

router.put('/documents/:id/verify', async (req, res) => {
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
       WHERE ($1::text IS NULL OR al.module=$1)
         AND ($2::int  IS NULL OR al.user_id=$2)
         AND ($3::text IS NULL OR al.action=$3)
         AND ($4::text IS NULL OR al.timestamp >= $4::timestamptz)
         AND ($5::text IS NULL OR al.timestamp <= $5::timestamptz)
       ORDER BY al.timestamp DESC
       LIMIT $6`,
      [module||null, user_id?parseInt(user_id):null, action||null,
       from_date||null, to_date||null, parseInt(limit||100)]
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
    await pool.query(
      `INSERT INTO audit_logs (user_id, user_name, user_role, module, record_id, action, old_data, new_data, changed_fields, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.user?.userId, req.user?.name||'System', req.user?.role||'system',
       module, record_id||null, action, old_data?JSON.stringify(old_data):null,
       new_data?JSON.stringify(new_data):null, changed, req.ip]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/audit-logs/summary', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT action, module, COUNT(*) as count
      FROM audit_logs
      WHERE timestamp >= NOW() - INTERVAL '7 days'
      GROUP BY action, module ORDER BY count DESC LIMIT 20
    `);
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

router.delete('/masters/:id', async (req, res) => {
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
      SELECT c.*, COUNT(b.id) as branch_count
      FROM companies c LEFT JOIN branches b ON b.company_id=c.id
      WHERE c.is_active=true GROUP BY c.id ORDER BY c.company_name
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/companies', async (req, res) => {
  try {
    const { company_name, company_code, address, city, country, gst_number, pan_number, email, phone } = req.body;
    const r = await pool.query(
      `INSERT INTO companies (company_name, company_code, address, city, country, gst_number, pan_number, email, phone)
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
      `SELECT b.*, c.company_name, COUNT(e.id) as employee_count
       FROM branches b
       JOIN companies c ON b.company_id = c.id
       LEFT JOIN employees e ON e.branch_id = b.id AND e.status IN ('active', 'probation', 'notice')
       WHERE ($1::int IS NULL OR b.company_id=$1) AND b.is_active=true
       GROUP BY b.id, c.company_name ORDER BY c.company_name, b.branch_name`,
      [company_id ? parseInt(company_id) : null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/branches', async (req, res) => {
  try {
    const { company_id, branch_name, branch_code, city, address, is_head_office } = req.body;
    const r = await pool.query(
      `INSERT INTO branches (company_id, branch_name, branch_code, city, address, is_head_office)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [company_id, branch_name, branch_code, city||'', address||'', is_head_office||false]
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
    try {
      const tkt = await pool.query(`
        SELECT AVG(EXTRACT(EPOCH FROM (updated_at-created_at))/3600) as avg_hours,
               COUNT(*) FILTER (WHERE status='open' AND created_at < NOW()-INTERVAL '24h') as sla_breach
        FROM service_tickets WHERE status IN ('resolved','closed')
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
       ORDER BY module, field_name, priority`,
      [module || null]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/validation-rules', async (req, res) => {
  try {
    const { module, field_name, rule_type, rule_value, error_message, priority } = req.body;
    const r = await pool.query(
      `INSERT INTO validation_rules (module, field_name, rule_type, rule_value, error_message, priority)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (module, field_name, rule_type) DO UPDATE
       SET rule_value=$4, error_message=$5 RETURNING *`,
      [module, field_name, rule_type, rule_value||null, error_message||'', priority||10]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Validate a payload against rules for a module
router.post('/validation-rules/validate', async (req, res) => {
  try {
    const { module, data } = req.body;
    const rules = await pool.query(
      'SELECT * FROM validation_rules WHERE module=$1 AND is_active=true ORDER BY field_name, priority',
      [module]
    );
    const errors = {};
    for (const rule of rules.rows) {
      const { field_name, rule_type, rule_value, error_message } = rule;
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
