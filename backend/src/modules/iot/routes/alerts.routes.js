/**
 * alerts.routes.js — the fleet-level Alert Centre API and rule management.
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 *  - GET /iot/alerts returned a flat list with no filters beyond `state`, no
 *    customer/project/severity/metric/technician dimension, and no ticket detail,
 *    so the alert → service chain existed only as an integer in a column nobody
 *    displayed.
 *  - PUT /iot/alerts/:id/ack ran `UPDATE device_alerts SET state='acknowledged'`
 *    with NO state predicate, so a RESOLVED alert could be acknowledged and its
 *    acknowledged_at rewritten. Transitions are now checked (see alertEngine).
 *  - POST /iot/rules accepted any equipment_id without proving the caller's
 *    company owned it, so a rule in company A could target company B's device.
 *    Now checked in the application AND enforced by the composite foreign key
 *    fk_rule_equipment_company.
 *  - The whole rules CRUD had no UI caller at all; AlertRules.jsx is that caller.
 */

import { Router } from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { captureBefore } from '../../../middlewares/captureBefore.js';
import { logAudit } from '../../../services/AuditService.js';
import { iotScope, denyScope, companyPredicate, writeCompany } from '../scope.js';
import { transition, ALERT_STATES, ALLOWED_TRANSITIONS } from '../alertEngine.js';
import { getMetric, listMetrics } from '../metricRegistry.js';

const router = Router();
const LIVE = `('pending_confirmation','active','acknowledged','recovery_pending')`;

// ── GET /iot/alerts — the Alert Centre ────────────────────────────────────────
router.get('/alerts', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const {
      state, view, severity, metric, equipment_id, customer_id, project_id,
      assigned_to, amc, from, to, search,
    } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const params = [];
    let q = `
      SELECT da.id, da.incident_uid, da.equipment_id, ce.equipment_name, ce.serial_number,
             ce.model_number, ce.site_location, ce.amc_status, ce.warranty_status,
             da.metric, da.value::float AS value, da.observed_value::float AS observed_value,
             da.worst_value::float AS worst_value, da.threshold::float AS threshold,
             da.clear_threshold::float AS clear_threshold, da.unit, da.quality_code,
             da.severity, da.state, da.message, da.breach_count,
             da.opened_at, da.first_detected_at, da.last_detected_at,
             da.acknowledged_at, da.resolved_at, da.resolution_reason, da.resolution_source,
             ack.name AS acknowledged_by_name, rsv.name AS resolved_by_name,
             da.ticket_id, t.ticket_number, t.status AS ticket_status, t.priority AS ticket_priority,
             t.created_at AS ticket_created_at, t.resolved_at AS ticket_resolved_at,
             t.assigned_to AS technician_id, emp.name AS technician_name,
             a.id AS customer_id, a.name AS customer_name,
             pr.id AS project_id, pr.project_name,
             EXTRACT(EPOCH FROM (COALESCE(da.resolved_at, NOW()) - da.opened_at))::bigint AS duration_secs
        FROM device_alerts da
        JOIN customer_equipment ce ON ce.id = da.equipment_id
        LEFT JOIN support_tickets t ON t.id = da.ticket_id
        LEFT JOIN employees emp ON emp.id = t.assigned_to
        LEFT JOIN users ack ON ack.id = da.acknowledged_by
        LEFT JOIN users rsv ON rsv.id = da.resolved_by
        LEFT JOIN accounts a ON a.id = ce.crm_account_id
        LEFT JOIN projects pr ON pr.id = ce.project_id
       WHERE 1 = 1`;
    q += companyPredicate(scope, 'da.company_id', params);

    // Views are named populations, so the UI never has to assemble one itself.
    const VIEWS = {
      open: ` AND da.state IN ${LIVE}`,
      acknowledged: ` AND da.state = 'acknowledged'`,
      critical: ` AND da.state IN ${LIVE} AND da.severity = 'critical'`,
      unassigned: ` AND da.state IN ${LIVE} AND (da.ticket_id IS NULL OR t.assigned_to IS NULL)`,
      awaiting_service: ` AND da.state IN ${LIVE} AND da.ticket_id IS NOT NULL AND COALESCE(t.status,'') NOT IN ('Closed','Resolved')`,
      resolved: ` AND da.state = 'resolved'`,
      all: '',
    };
    if (view && VIEWS[view] !== undefined) q += VIEWS[view];
    else if (state) { params.push(state); q += ` AND da.state = $${params.length}`; }
    else q += VIEWS.open;

    if (severity) { params.push(severity); q += ` AND da.severity = $${params.length}`; }
    if (metric) { params.push(metric); q += ` AND da.metric = $${params.length}`; }
    if (equipment_id) { params.push(parseInt(equipment_id, 10)); q += ` AND da.equipment_id = $${params.length}`; }
    if (customer_id) { params.push(parseInt(customer_id, 10)); q += ` AND ce.crm_account_id = $${params.length}`; }
    if (project_id) { params.push(parseInt(project_id, 10)); q += ` AND ce.project_id = $${params.length}`; }
    if (assigned_to) { params.push(parseInt(assigned_to, 10)); q += ` AND t.assigned_to = $${params.length}`; }
    if (amc === 'true') q += ` AND LOWER(COALESCE(ce.amc_status,'')) = 'active'`;
    if (amc === 'false') q += ` AND LOWER(COALESCE(ce.amc_status,'')) <> 'active'`;
    if (from) { params.push(from); q += ` AND da.opened_at >= $${params.length}::timestamptz`; }
    if (to) { params.push(to); q += ` AND da.opened_at <= $${params.length}::timestamptz`; }
    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      q += ` AND (ce.equipment_name ILIKE $${p} OR ce.serial_number ILIKE $${p} OR da.message ILIKE $${p} OR t.ticket_number ILIKE $${p})`;
    }

    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM (${q}) c`, params);
    params.push(limit); params.push(offset);
    q += ` ORDER BY CASE da.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                    da.opened_at DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(q, params);
    res.json({ rows, total: countRows[0].total, limit, offset, view: view || (state ? `state=${state}` : 'open') });
  } catch (e) {
    console.error('[iot alerts]', e.message);
    res.status(500).json({ error: 'failed to load alerts' });
  }
});

// ── GET /iot/alerts/:id — Alert 360 ───────────────────────────────────────────
router.get('/alerts/:id', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [parseInt(req.params.id, 10)];
    let sql = `
      SELECT da.*, ce.equipment_name, ce.serial_number, ce.model_number, ce.site_location,
             ce.amc_status, ce.warranty_status, ce.amc_contract_id, ce.project_id, ce.crm_account_id,
             a.name AS customer_name, pr.project_name,
             t.ticket_number, t.status AS ticket_status, t.priority AS ticket_priority,
             t.created_at AS ticket_created_at, t.resolved_at AS ticket_resolved_at,
             t.assigned_to AS technician_id, emp.name AS technician_name,
             r.name AS rule_name, r.operator, r.persistence_secs, r.recovery_secs, r.cooldown_secs,
             ack.name AS acknowledged_by_name, rsv.name AS resolved_by_name
        FROM device_alerts da
        JOIN customer_equipment ce ON ce.id = da.equipment_id
        LEFT JOIN device_alert_rules r ON r.id = da.rule_id
        LEFT JOIN support_tickets t ON t.id = da.ticket_id
        LEFT JOIN employees emp ON emp.id = t.assigned_to
        LEFT JOIN users ack ON ack.id = da.acknowledged_by
        LEFT JOIN users rsv ON rsv.id = da.resolved_by
        LEFT JOIN accounts a ON a.id = ce.crm_account_id
        LEFT JOIN projects pr ON pr.id = ce.project_id
       WHERE da.id = $1`;
    sql += companyPredicate(scope, 'da.company_id', params);
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: 'alert not found' });
    const alert = rows[0];

    // Telemetry evidence: the samples around the detection window, so the
    // operator can see the breach rather than taking the row's word for it.
    const { rows: evidence } = await pool.query(
      `SELECT ts, value::float AS value, quality_code, received_at
         FROM device_telemetry
        WHERE equipment_id = $1 AND metric = $2
          AND ts BETWEEN COALESCE($3::timestamptz, $4::timestamptz) - INTERVAL '30 minutes'
                     AND COALESCE($5::timestamptz, NOW()) + INTERVAL '30 minutes'
        ORDER BY ts LIMIT 500`,
      [alert.equipment_id, alert.metric, alert.first_detected_at, alert.opened_at, alert.last_detected_at]);

    const { rows: events } = await pool.query(
      `SELECT event_type, occurred_at, source, ticket_id, detail
         FROM iot_device_events WHERE alert_id = $1 ORDER BY occurred_at`, [alert.id]);

    const { rows: outbox } = await pool.query(
      `SELECT topic, status, attempts, last_error, created_at, processed_at
         FROM iot_outbox WHERE dedupe_key LIKE $1 ORDER BY created_at`, [`%:${alert.id}`]);

    res.json({
      ...alert,
      duration_secs: Math.round((new Date(alert.resolved_at || Date.now()) - new Date(alert.opened_at)) / 1000),
      allowed_transitions: ALLOWED_TRANSITIONS[alert.state] || [],
      evidence, events,
      delivery: outbox,
    });
  } catch (e) {
    console.error('[iot alert 360]', e.message);
    res.status(500).json({ error: 'failed to load alert' });
  }
});

// ── Transitions ───────────────────────────────────────────────────────────────
async function doTransition(req, res, toState) {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    // A global caller must still act within one company; resolve it from the row.
    const alertId = parseInt(req.params.id, 10);
    const { rows: owner } = await pool.query(`SELECT company_id FROM device_alerts WHERE id = $1`, [alertId]);
    if (!owner.length) return res.status(404).json({ error: 'alert not found' });
    const companyId = scope.isGlobal ? owner[0].company_id : scope.companyId;
    if (!scope.isGlobal && owner[0].company_id !== scope.companyId) {
      return res.status(404).json({ error: 'alert not found' });
    }

    const result = await transition(pool, {
      alertId, companyId, toState,
      userId: req.user?.userId ?? null,
      reason: req.body?.reason ?? null,
      source: toState === ALERT_STATES.RESOLVED ? (req.body?.source || 'operator') : 'operator',
    });
    if (!result.ok) {
      if (result.code === 'NOT_FOUND') return res.status(404).json({ error: 'alert not found' });
      return res.status(409).json({
        error: 'Illegal state transition',
        code: result.code, from: result.from, to: result.to,
        allowed: ALLOWED_TRANSITIONS[result.from] || [],
        message: `An alert in state '${result.from}' cannot move to '${result.to}'.`,
      });
    }
    logAudit({
      userId: req.user?.userId, module: 'iot', recordId: alertId, recordType: 'device_alert',
      action: 'workflow_transition', newData: { state: toState, reason: req.body?.reason ?? null },
      req, company_id: companyId,
    });
    res.json(result.alert);
  } catch (e) {
    console.error('[iot alert transition]', e.message);
    res.status(500).json({ error: 'transition failed' });
  }
}

router.put('/alerts/:id/ack', requirePermission('iot', 'edit'), (req, res) => doTransition(req, res, ALERT_STATES.ACKNOWLEDGED));
router.put('/alerts/:id/resolve', requirePermission('iot', 'edit'), (req, res) => doTransition(req, res, ALERT_STATES.RESOLVED));

// ── Alert rules CRUD ──────────────────────────────────────────────────────────
router.get('/rules', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [];
    let q = `SELECT r.*, ce.equipment_name, ce.serial_number,
                    m.unit, m.display_name AS metric_name,
                    (SELECT COUNT(*) FROM device_alerts da
                      WHERE da.rule_id = r.id AND da.state IN ${LIVE})::int AS live_alerts
               FROM device_alert_rules r
               LEFT JOIN customer_equipment ce ON ce.id = r.equipment_id
               LEFT JOIN iot_metric_definitions m
                      ON m.metric_code = r.metric AND (m.company_id = r.company_id OR m.company_id IS NULL)
              WHERE 1 = 1`;
    q += companyPredicate(scope, 'r.company_id', params);
    if (req.query.equipment_id) {
      params.push(parseInt(req.query.equipment_id, 10));
      q += ` AND (r.equipment_id = $${params.length} OR r.equipment_id IS NULL)`;
    }
    q += ` ORDER BY r.is_active DESC, r.created_at DESC`;
    const { rows } = await pool.query(q, params);
    res.json({ rows });
  } catch (e) {
    console.error('[iot rules]', e.message);
    res.status(500).json({ error: 'failed to load rules' });
  }
});

const OPERATORS = new Set(['>', '<', '>=', '<=', '=', 'stale']);
const SEVERITIES = new Set(['info', 'warning', 'critical']);
const CHANNELS = new Set(['in_app', 'email', 'sms', 'push']);

/**
 * Validate a rule body. Returns {ok, error} — every rejection names the field,
 * because a rule silently saved with a mistyped metric fires against nothing and
 * looks exactly like a rule that is simply not breaching.
 */
async function validateRule(body, companyId, { partial = false } = {}) {
  const b = body || {};
  const need = (k) => !partial && (b[k] == null || b[k] === '');

  if (need('name')) return { ok: false, error: 'name is required' };
  if (need('metric')) return { ok: false, error: 'metric is required' };

  const operator = b.operator ?? (partial ? undefined : '>');
  if (operator !== undefined && !OPERATORS.has(operator)) {
    return { ok: false, error: `invalid operator '${operator}' — one of ${[...OPERATORS].join(', ')}` };
  }
  const severity = b.severity ?? (partial ? undefined : 'warning');
  if (severity !== undefined && !SEVERITIES.has(severity)) {
    return { ok: false, error: `invalid severity '${severity}' — one of ${[...SEVERITIES].join(', ')}` };
  }

  if (b.metric != null) {
    const def = await getMetric(companyId, b.metric);
    // 'heartbeat' is the engine's own pseudo-metric for stale rules; it has no
    // physical definition and is allowed through deliberately.
    if (!def && b.metric !== 'heartbeat') {
      return { ok: false, error: `metric '${b.metric}' is not in the metric registry` };
    }
  }

  if (operator !== 'stale' && !partial) {
    if (b.threshold == null || !Number.isFinite(Number(b.threshold))) {
      return { ok: false, error: 'a numeric threshold is required for this operator' };
    }
  }

  // Hysteresis sanity: a clear threshold on the wrong side of the trigger means
  // the incident can never clear, which looks like a stuck alert.
  if (b.clear_threshold != null && b.threshold != null) {
    const t = Number(b.threshold), c = Number(b.clear_threshold);
    if ((operator === '>' || operator === '>=') && c >= t) {
      return { ok: false, error: `clear_threshold (${c}) must be BELOW threshold (${t}) for a '${operator}' rule, or the alert can never clear` };
    }
    if ((operator === '<' || operator === '<=') && c <= t) {
      return { ok: false, error: `clear_threshold (${c}) must be ABOVE threshold (${t}) for a '${operator}' rule, or the alert can never clear` };
    }
  }

  for (const k of ['persistence_secs', 'recovery_secs', 'cooldown_secs', 'stale_secs', 'escalation_mins', 'repeat_mins']) {
    if (b[k] != null && (!Number.isFinite(Number(b[k])) || Number(b[k]) < 0)) {
      return { ok: false, error: `${k} must be a non-negative number` };
    }
  }
  if (Array.isArray(b.notify_channels)) {
    const bad = b.notify_channels.find((c) => !CHANNELS.has(c));
    if (bad) return { ok: false, error: `unknown notification channel '${bad}'` };
  }
  return { ok: true };
}

/**
 * Prove the caller's company owns the equipment a rule targets.
 *
 * This is the application half of the check; the composite FK
 * fk_rule_equipment_company is the database half. Both exist on purpose — the FK
 * cannot produce a helpful error message, and an application check alone can be
 * bypassed by any other writer.
 */
async function assertEquipmentOwned(equipmentId, companyId) {
  if (equipmentId == null) return { ok: true };          // company-wide rule
  const { rows } = await pool.query(
    `SELECT id FROM customer_equipment WHERE id = $1 AND company_id = $2`,
    [equipmentId, companyId]);
  return rows.length ? { ok: true } : { ok: false, error: 'equipment_id does not belong to this company' };
}

router.post('/rules', requirePermission('iot', 'add'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  const target = writeCompany(scope, req.body);
  if (!target.ok) {
    return res.status(target.reason === 'COMPANY_REQUIRED' ? 400 : 403)
      .json({ error: 'company scope required for this write', code: target.reason });
  }
  try {
    const v = await validateRule(req.body, target.companyId);
    if (!v.ok) return res.status(400).json({ error: v.error });

    const equipmentId = req.body.equipment_id ?? null;
    const owned = await assertEquipmentOwned(equipmentId, target.companyId);
    if (!owned.ok) return res.status(403).json({ error: owned.error, code: 'CROSS_COMPANY_EQUIPMENT' });

    const b = req.body;
    const operator = b.operator || '>';
    const { rows } = await pool.query(
      `INSERT INTO device_alert_rules
         (company_id, equipment_id, name, metric, operator, threshold, clear_threshold, stale_secs,
          severity, persistence_secs, recovery_secs, cooldown_secs, suppress_in_maintenance,
          notify_channels, notify_roles, notify_user_ids, escalation_mins, repeat_mins,
          create_ticket, active_from, active_to, quality_policy, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING *`,
      [target.companyId, equipmentId, b.name, b.metric, operator,
       operator === 'stale' ? null : Number(b.threshold),
       b.clear_threshold == null ? null : Number(b.clear_threshold),
       operator === 'stale' ? (b.stale_secs ?? 900) : null,
       b.severity || 'warning',
       b.persistence_secs ?? 0, b.recovery_secs ?? 0, b.cooldown_secs ?? 0,
       b.suppress_in_maintenance !== false,
       b.notify_channels ?? ['in_app'], b.notify_roles ?? [], b.notify_user_ids ?? [],
       b.escalation_mins ?? null, b.repeat_mins ?? null,
       b.create_ticket !== false, b.active_from ?? null, b.active_to ?? null,
       b.quality_policy || 'valid_only', req.user?.userId ?? null]);
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: rows[0].id, recordType: 'device_alert_rule', action: 'create', newData: rows[0], req, company_id: target.companyId });
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23503') {
      return res.status(403).json({ error: 'equipment_id does not belong to this company', code: 'CROSS_COMPANY_EQUIPMENT' });
    }
    console.error('[iot rule create]', e.message);
    res.status(500).json({ error: 'failed to create rule' });
  }
});

router.put('/rules/:id', requirePermission('iot', 'edit'), captureBefore('device_alert_rules'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [parseInt(req.params.id, 10)];
    let findSql = `SELECT * FROM device_alert_rules WHERE id = $1`;
    findSql += companyPredicate(scope, 'company_id', params);
    const { rows: existing } = await pool.query(findSql, params);
    if (!existing.length) return res.status(404).json({ error: 'rule not found' });
    const rule = existing[0];

    const merged = { ...rule, ...req.body };
    const v = await validateRule(merged, rule.company_id, { partial: false });
    if (!v.ok) return res.status(400).json({ error: v.error });

    if (req.body.equipment_id !== undefined) {
      const owned = await assertEquipmentOwned(req.body.equipment_id, rule.company_id);
      if (!owned.ok) return res.status(403).json({ error: owned.error, code: 'CROSS_COMPANY_EQUIPMENT' });
    }

    const allowed = [
      'name', 'metric', 'operator', 'threshold', 'clear_threshold', 'stale_secs', 'severity',
      'is_active', 'equipment_id', 'persistence_secs', 'recovery_secs', 'cooldown_secs',
      'suppress_in_maintenance', 'notify_channels', 'notify_roles', 'notify_user_ids',
      'escalation_mins', 'repeat_mins', 'create_ticket', 'active_from', 'active_to', 'quality_policy',
    ];
    const sets = [], up = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { up.push(req.body[k]); sets.push(`${k} = $${up.length + 1}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    up.push(req.user?.userId ?? null); sets.push(`updated_by = $${up.length + 1}`);

    const { rows } = await pool.query(
      `UPDATE device_alert_rules SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [rule.id, ...up]);

    // A changed threshold invalidates the runtime state that was tracking the old
    // one — otherwise a breach timer started against the previous threshold keeps
    // counting toward an incident nobody configured.
    if (req.body.threshold !== undefined || req.body.operator !== undefined || req.body.clear_threshold !== undefined) {
      await pool.query(`DELETE FROM iot_rule_state WHERE rule_id = $1`, [rule.id]);
    }
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: rule.id, recordType: 'device_alert_rule', action: 'update', oldData: rule, newData: rows[0], req, company_id: rule.company_id });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23503') return res.status(403).json({ error: 'equipment_id does not belong to this company', code: 'CROSS_COMPANY_EQUIPMENT' });
    console.error('[iot rule update]', e.message);
    res.status(500).json({ error: 'failed to update rule' });
  }
});

router.delete('/rules/:id', requirePermission('iot', 'delete'), captureBefore('device_alert_rules'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [parseInt(req.params.id, 10)];
    let sql = `DELETE FROM device_alert_rules WHERE id = $1`;
    sql += companyPredicate(scope, 'company_id', params);
    const { rows } = await pool.query(sql + ' RETURNING *', params);
    if (!rows.length) return res.status(404).json({ error: 'rule not found' });
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: rows[0].id, recordType: 'device_alert_rule', action: 'delete', oldData: rows[0], req, company_id: rows[0].company_id });
    res.json({ ok: true });
  } catch (e) {
    console.error('[iot rule delete]', e.message);
    res.status(500).json({ error: 'failed to delete rule' });
  }
});

export default router;
