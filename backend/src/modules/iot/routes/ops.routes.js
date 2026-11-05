/**
 * ops.routes.js — platform health, data quality, gateway diagnostics, service
 * KPIs, exports and reconciliation.
 *
 * SYSTEM HEALTH IS NOT EQUIPMENT HEALTH. The fleet page answers "is the equipment
 * in trouble"; these endpoints answer "is the MONITORING in trouble" — which is a
 * different question with different owners, and mixing them is how a silent
 * gateway gets read as a healthy machine.
 *
 *   GET /iot/ops/health          platform health
 *   GET /iot/ops/data-quality    expected vs received vs valid vs rejected
 *   GET /iot/ops/gateways        gateway diagnostics
 *   GET /iot/ops/service-kpis    MTTA / MTBF / MTTR / uptime — or INSUFFICIENT_DATA
 *   GET /iot/ops/reconcile       orphans, cross-company references, duplicates
 *   GET /iot/export/telemetry    CSV
 *   GET /iot/export/alerts       CSV
 *   POST /iot/ops/outbox/:id/replay   requeue one dead-letter event
 */

import { Router } from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { iotScope, denyScope, companyPredicate } from '../scope.js';
import { uptimeFromEvents, mtbfFromEvents, mttrFromEvents, mttaFromAlerts } from '../serviceKpis.js';
import { onlinePct, sampleDeliveryPct } from '../ratios.js';
import { replayDead } from '../outbox.js';
import { logAudit } from '../../../services/AuditService.js';
import { toCsvObjects } from '../../../shared/csv.js';

const router = Router();
const LIVE = `('pending_confirmation','active','acknowledged','recovery_pending')`;

// ── GET /iot/ops/health ───────────────────────────────────────────────────────
router.get('/ops/health', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 30);

    const gp = []; const gWhere = `WHERE 1=1${companyPredicate(scope, 'company_id', gp)}`;
    // dp starts with `hours` because the SELECT list references $1 for the
    // expected-sample arithmetic. companyPredicate numbers its placeholder from
    // the array it is handed, so the array has to already contain every earlier
    // parameter — building the predicate against an empty array and then
    // prepending hours is what produced "bind message supplies 2 parameters, but
    // prepared statement requires 1".
    const dp = [hours];
    const dWhere = `WHERE device_uid IS NOT NULL${companyPredicate(scope, 'company_id', dp)}`;
    const tp = [String(hours)]; const tWhere = `WHERE received_at > NOW() - ($1 || ' hours')::interval${companyPredicate(scope, 'company_id', tp)}`;
    const rp = [String(hours)]; const rWhere = `WHERE received_at > NOW() - ($1 || ' hours')::interval${companyPredicate(scope, 'company_id', rp)}`;
    const op = []; const oWhere = `WHERE 1=1${companyPredicate(scope, 'company_id', op)}`;
    const ap = []; const aWhere = `WHERE 1=1${companyPredicate(scope, 'company_id', ap)}`;

    const [gw, dev, tel, rej, ob, al, tick] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE last_heartbeat_at > NOW() - INTERVAL '10 minutes')::int AS connected,
               COUNT(*) FILTER (WHERE last_heartbeat_at IS NULL OR last_heartbeat_at <= NOW() - INTERVAL '10 minutes')::int AS disconnected,
               COALESCE(SUM(queue_depth),0)::bigint AS queue_depth,
               COALESCE(SUM(dead_letter_count),0)::bigint AS gateway_dead_letters,
               MIN(oldest_queued_ts) AS oldest_queued_ts
          FROM iot_gateways ${gWhere}`, gp),
      pool.query(`
        SELECT COUNT(*)::int AS provisioned,
               COUNT(*) FILTER (WHERE connection_state='online' AND device_status='active')::int AS online,
               COUNT(*) FILTER (WHERE connection_state='stale')::int   AS stale,
               COUNT(*) FILTER (WHERE connection_state='offline')::int AS offline,
               COUNT(*) FILTER (WHERE last_seen_at IS NULL)::int       AS never_connected,
               COUNT(*) FILTER (WHERE sampling_secs IS NULL)::int      AS no_sampling_config,
               COALESCE(SUM(3600.0 * $1::int / NULLIF(sampling_secs,0)), 0)::bigint AS expected_samples_per_metric
          FROM customer_equipment ${dWhere}`, dp),
      pool.query(`
        SELECT COUNT(*)::int AS received,
               COUNT(*) FILTER (WHERE quality_code='VALID')::int AS valid,
               COUNT(*) FILTER (WHERE quality_code='REPLAY')::int AS replay,
               COUNT(*) FILTER (WHERE quality_code='SUSPECT')::int AS suspect,
               COUNT(DISTINCT equipment_id)::int AS reporting_devices
          FROM device_telemetry ${tWhere}`, tp),
      pool.query(`SELECT COUNT(*)::int AS rejected FROM iot_rejected_samples ${rWhere}`, rp),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE status='pending')::int    AS pending,
               COUNT(*) FILTER (WHERE status='processing')::int  AS processing,
               COUNT(*) FILTER (WHERE status='dead')::int        AS dead,
               COUNT(*) FILTER (WHERE status='done')::int        AS done
          FROM iot_outbox ${oWhere}`, op),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE state IN ${LIVE} AND severity='critical')::int AS open_critical,
               COUNT(*) FILTER (WHERE state IN ${LIVE})::int AS open_total
          FROM device_alerts ${aWhere}`, ap),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE status='dead' AND topic='alert.opened')::int AS ticket_failures
          FROM iot_outbox ${oWhere}`, op),
    ]);

    const d = dev.rows[0], t = tel.rows[0];
    res.json({
      as_of: new Date().toISOString(),
      window_hours: hours,
      gateways: gw.rows[0],
      devices: d,
      telemetry: { ...t, rejected: rej.rows[0].rejected },
      outbox: ob.rows[0],
      alerts: al.rows[0],
      ticket_failures: tick.rows[0].ticket_failures,
      ratios: {
        online: onlinePct({ online: d.online, provisioned: d.provisioned }),
        // Expected is per metric per device; without knowing the metric count per
        // device this is a lower bound, and it says so rather than pretending.
        sample_delivery: sampleDeliveryPct({
          validReceived: t.valid,
          expected: Number(d.expected_samples_per_metric) || null,
          window: `${hours}h`,
        }),
      },
      caveats: [
        d.no_sampling_config > 0
          ? `${d.no_sampling_config} provisioned device(s) have no configured sampling interval and are excluded from the delivery expectation.`
          : null,
        'Sample delivery expectation counts ONE metric per device; a device publishing several metrics will read above 100%.',
      ].filter(Boolean),
    });
  } catch (e) {
    console.error('[iot ops/health]', e.message);
    res.status(500).json({ error: 'failed to load platform health' });
  }
});

// ── GET /iot/ops/data-quality ─────────────────────────────────────────────────
router.get('/ops/data-quality', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 30);
    const groupBy = ['device', 'metric', 'gateway'].includes(req.query.group_by) ? req.query.group_by : 'device';

    const params = [String(hours)];
    const scopeSql = companyPredicate(scope, 't.company_id', params);

    const dims = {
      device: { select: 'ce.id AS key_id, ce.equipment_name AS key_label', group: 'ce.id, ce.equipment_name' },
      metric: { select: 't.metric AS key_id, t.metric AS key_label', group: 't.metric' },
      gateway: { select: "COALESCE(t.batch_uid, 'unknown') AS key_id, COALESCE(g.gateway_uid, 'unassigned') AS key_label", group: 't.batch_uid, g.gateway_uid' },
    }[groupBy];

    const { rows } = await pool.query(`
      SELECT ${dims.select},
             COUNT(*)::int AS received,
             COUNT(*) FILTER (WHERE t.quality_code = 'VALID')::int    AS valid,
             COUNT(*) FILTER (WHERE t.quality_code = 'SUSPECT')::int  AS suspect,
             COUNT(*) FILTER (WHERE t.quality_code = 'REPLAY')::int   AS late,
             COUNT(*) FILTER (WHERE t.quality_code NOT IN ('VALID','SUSPECT','REPLAY'))::int AS other,
             MIN(t.ts) AS first_event, MAX(t.ts) AS last_event,
             MAX(t.received_at) AS last_received
        FROM device_telemetry t
        JOIN customer_equipment ce ON ce.id = t.equipment_id
        LEFT JOIN iot_gateways g ON g.id = ce.gateway_id
       WHERE t.received_at > NOW() - ($1 || ' hours')::interval ${scopeSql}
       GROUP BY ${dims.group}
       ORDER BY received DESC
       LIMIT 200`, params);

    const rp = [String(hours)];
    const rScope = companyPredicate(scope, 'company_id', rp);
    const { rows: rejections } = await pool.query(`
      SELECT reason, COUNT(*)::int AS n, MAX(received_at) AS last_seen
        FROM iot_rejected_samples
       WHERE received_at > NOW() - ($1 || ' hours')::interval ${rScope}
       GROUP BY reason ORDER BY n DESC`, rp);

    // Duplicate arrivals: batches whose accepted count was less than their sample
    // count are retries the unique index absorbed. That number is the proof the
    // idempotency guard is doing work.
    const bp = [String(hours)];
    const bScope = companyPredicate(scope, 'company_id', bp);
    const { rows: dup } = await pool.query(`
      SELECT COALESCE(SUM(duplicates),0)::bigint AS duplicate_samples,
             COUNT(*) FILTER (WHERE duplicates > 0)::int AS batches_with_duplicates,
             COUNT(*)::int AS batches
        FROM iot_ingest_batches
       WHERE received_at > NOW() - ($1 || ' hours')::interval ${bScope}`, bp);

    res.json({
      window_hours: hours, group_by: groupBy,
      rows, rejections, deduplication: dup[0],
      legend: {
        valid: 'measured, in range, on time',
        suspect: 'measured but flagged by the gateway or a range check',
        late: 'accepted as historical replay — excluded from current state',
        other: 'invalid / stale / communication error — excluded from calculations',
      },
    });
  } catch (e) {
    console.error('[iot ops/data-quality]', e.message);
    res.status(500).json({ error: 'failed to load data quality' });
  }
});

// ── GET /iot/ops/gateways ─────────────────────────────────────────────────────
router.get('/ops/gateways', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [];
    let sql = `
      SELECT g.*,
             (SELECT COUNT(*) FROM customer_equipment ce WHERE ce.gateway_id = g.id)::int AS linked_devices,
             EXTRACT(EPOCH FROM (NOW() - g.last_heartbeat_at))::bigint AS heartbeat_age_secs,
             CASE
               WHEN g.last_heartbeat_at IS NULL                              THEN 'never_connected'
               WHEN g.last_heartbeat_at > NOW() - INTERVAL '10 minutes'      THEN 'online'
               WHEN g.last_heartbeat_at > NOW() - INTERVAL '1 hour'          THEN 'stale'
               ELSE 'offline'
             END AS live_status
        FROM iot_gateways g
       WHERE 1 = 1`;
    sql += companyPredicate(scope, 'g.company_id', params);
    sql += ` ORDER BY g.last_heartbeat_at DESC NULLS LAST`;
    const { rows } = await pool.query(sql, params);
    res.json({
      rows,
      note: 'A gateway that stops reporting means missing telemetry that is NOT an equipment fault. Check live_status before dispatching an engineer.',
    });
  } catch (e) {
    res.status(500).json({ error: 'failed to load gateway diagnostics' });
  }
});

// ── GET /iot/ops/service-kpis ─────────────────────────────────────────────────
router.get('/ops/service-kpis', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 730);
    const equipmentId = req.query.equipment_id ? parseInt(req.query.equipment_id, 10) : null;
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - days * 86400000);

    const ep = [windowStart.toISOString()];
    let eSql = `SELECT event_type, occurred_at FROM iot_device_events WHERE occurred_at >= $1`;
    eSql += companyPredicate(scope, 'company_id', ep);
    if (equipmentId) { ep.push(equipmentId); eSql += ` AND equipment_id = $${ep.length}`; }
    eSql += ` ORDER BY occurred_at`;

    const ap = [windowStart.toISOString()];
    // Rows whose state is outside the declared vocabulary are legacy seed data
    // (see the NOT VALID constraints in 20260914000001). They are excluded here
    // for the same reason they are excluded from the open counts: including them
    // produced an MTTA of 66,240 minutes computed from placeholder timestamps.
    // The reconciliation check reports them so they are visible rather than lost.
    let aSql = `SELECT opened_at, acknowledged_at, resolved_at, severity, state, ticket_id, equipment_id
                  FROM device_alerts
                 WHERE opened_at >= $1
                   AND state IN ('pending_confirmation','active','acknowledged','recovery_pending','resolved','suppressed')
` ;
    aSql += companyPredicate(scope, 'company_id', ap);
    if (equipmentId) { ap.push(equipmentId); aSql += ` AND equipment_id = $${ap.length}`; }

    const mp = [windowStart.toISOString()];
    let mSql = `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(ends_at, NOW()) - starts_at))), 0)::bigint AS maint_secs
                  FROM iot_maintenance_windows WHERE cancelled_at IS NULL AND ends_at >= $1`;
    mSql += companyPredicate(scope, 'company_id', mp);
    if (equipmentId) { mp.push(equipmentId); mSql += ` AND equipment_id = $${mp.length}`; }

    const [ev, al, mt] = await Promise.all([
      pool.query(eSql, ep), pool.query(aSql, ap), pool.query(mSql, mp),
    ]);

    const alerts = al.rows;
    const openIncidents = alerts.filter((a) => ['pending_confirmation', 'active', 'acknowledged', 'recovery_pending'].includes(a.state));

    res.json({
      window_days: days,
      equipment_id: equipmentId,
      counts: {
        open_incidents: openIncidents.length,
        critical_incidents: openIncidents.filter((a) => a.severity === 'critical').length,
        incidents_in_window: alerts.length,
        with_ticket: alerts.filter((a) => a.ticket_id).length,
      },
      mtta: mttaFromAlerts(alerts),
      mtbf: mtbfFromEvents(ev.rows),
      mttr: mttrFromEvents(ev.rows),
      uptime: equipmentId
        ? uptimeFromEvents(ev.rows, windowStart, windowEnd, Number(mt.rows[0].maint_secs))
        : { code: 'UPTIME_PCT', label: 'Monitoring uptime', value: null, state: 'INSUFFICIENT_DATA',
            note: 'Uptime is computed per device — pass equipment_id. A fleet-wide average of device uptimes would weight a one-device site the same as a fifty-device one.' },
      event_count: ev.rows.length,
      note: 'Every figure here is derived from iot_device_events, not from the current connection_state. Where the history is too short the value is null and the reason is stated.',
    });
  } catch (e) {
    console.error('[iot ops/service-kpis]', e.message);
    res.status(500).json({ error: 'failed to compute service KPIs' });
  }
});

// ── GET /iot/ops/reconcile ────────────────────────────────────────────────────
// The integrity queries §55 asks for, runnable from the app instead of by hand.
router.get('/ops/reconcile', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const q = async (label, sql, params = []) => {
      try { const { rows } = await pool.query(sql, params); return { label, ...rows[0] }; }
      catch (e) { return { label, error: e.message }; }
    };
    const results = await Promise.all([
      q('orphan_telemetry', `SELECT COUNT(*)::int AS n FROM device_telemetry t
          LEFT JOIN customer_equipment ce ON ce.id = t.equipment_id WHERE ce.id IS NULL`),
      q('orphan_alerts', `SELECT COUNT(*)::int AS n FROM device_alerts da
          LEFT JOIN customer_equipment ce ON ce.id = da.equipment_id WHERE ce.id IS NULL`),
      q('orphan_rules', `SELECT COUNT(*)::int AS n FROM device_alert_rules r
          WHERE r.equipment_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM customer_equipment ce WHERE ce.id = r.equipment_id)`),
      q('cross_company_rules', `SELECT COUNT(*)::int AS n FROM device_alert_rules r
          JOIN customer_equipment ce ON ce.id = r.equipment_id WHERE ce.company_id <> r.company_id`),
      q('cross_company_alerts', `SELECT COUNT(*)::int AS n FROM device_alerts da
          JOIN customer_equipment ce ON ce.id = da.equipment_id WHERE ce.company_id <> da.company_id`),
      q('cross_company_telemetry', `SELECT COUNT(*)::int AS n FROM device_telemetry t
          JOIN customer_equipment ce ON ce.id = t.equipment_id WHERE ce.company_id <> t.company_id`),
      q('duplicate_samples', `SELECT COUNT(*)::int AS n FROM (
            SELECT equipment_id, sample_uid, ts FROM device_telemetry
             WHERE sample_uid IS NOT NULL
             GROUP BY 1,2,3 HAVING COUNT(*) > 1) d`),
      q('invalid_alert_state', `SELECT COUNT(*)::int AS n FROM device_alerts
          WHERE state NOT IN ('pending_confirmation','active','acknowledged','recovery_pending','resolved','suppressed')`),
      q('invalid_alert_severity', `SELECT COUNT(*)::int AS n FROM device_alerts
          WHERE severity NOT IN ('info','warning','critical')`),
      q('invalid_rule_operator', `SELECT COUNT(*)::int AS n FROM device_alert_rules
          WHERE operator NOT IN ('>','<','>=','<=','=','stale')`),
      q('undeclared_metrics', `SELECT COUNT(DISTINCT t.metric)::int AS n FROM device_telemetry t
          WHERE NOT EXISTS (SELECT 1 FROM iot_metric_definitions m
                             WHERE m.metric_code = t.metric AND (m.company_id IS NULL OR m.company_id = t.company_id))`),
      q('default_partition_rows', `SELECT COUNT(*)::int AS n FROM device_telemetry_default`),
      q('dead_outbox', `SELECT COUNT(*)::int AS n FROM iot_outbox WHERE status = 'dead'`),
      q('alerts_without_ticket', `SELECT COUNT(*)::int AS n FROM device_alerts da
          JOIN device_alert_rules r ON r.id = da.rule_id
          WHERE da.severity='critical' AND da.ticket_id IS NULL AND r.create_ticket
            AND da.opened_at < NOW() - INTERVAL '15 minutes'`),
    ]);
    const problems = results.filter((r) => (r.n ?? 0) > 0 || r.error);
    res.json({
      as_of: new Date().toISOString(),
      checks: results,
      clean: problems.length === 0,
      problems,
      note: 'invalid_alert_state / invalid_alert_severity / invalid_rule_operator count rows written before the CHECK constraints were added (NOT VALID, so legacy rows survive). They are excluded from every state-filtered query and must be corrected or removed deliberately.',
    });
  } catch (e) {
    res.status(500).json({ error: 'reconciliation failed' });
  }
});

// ── Exports ───────────────────────────────────────────────────────────────────
// Delegates to the shared writer, which additionally neutralises values a
// spreadsheet would EVALUATE as formulas (a leading = + - @). See shared/csv.js.
// Dates keep their ISO rendering; everything else goes through the writer.
const csv = (rows, headers) => toCsvObjects(
  rows.map(r => Object.fromEntries(headers.map(h => [h, r[h] instanceof Date ? r[h].toISOString() : r[h]]))),
  { columns: headers, minimal: true }
);

router.get('/export/telemetry', requirePermission('iot', 'export'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 90);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50000, 1), 200000);
    const params = [String(hours)];
    let sql = `
      SELECT c.name AS company, ce.site_location AS site, a.name AS customer,
             ce.equipment_name AS equipment, ce.serial_number AS serial,
             t.metric, t.ts AS event_ts, t.received_at, t.value::float AS value,
             COALESCE(t.unit, m.unit) AS unit, t.quality_code AS quality
        FROM device_telemetry t
        JOIN customer_equipment ce ON ce.id = t.equipment_id
        LEFT JOIN companies c ON c.id = t.company_id
        LEFT JOIN accounts a ON a.id = ce.crm_account_id
        LEFT JOIN iot_metric_definitions m ON m.metric_code = t.metric AND (m.company_id = t.company_id OR m.company_id IS NULL)
       WHERE t.ts > NOW() - ($1 || ' hours')::interval`;
    sql += companyPredicate(scope, 't.company_id', params);
    if (req.query.equipment_id) { params.push(parseInt(req.query.equipment_id, 10)); sql += ` AND t.equipment_id = $${params.length}`; }
    if (req.query.metric) { params.push(req.query.metric); sql += ` AND t.metric = $${params.length}`; }
    params.push(limit);
    sql += ` ORDER BY t.ts DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(sql, params);
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: null, recordType: 'telemetry_export', action: 'export', newData: { rows: rows.length, hours }, req, company_id: scope.companyId });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="iot-telemetry-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv(rows, ['company', 'site', 'customer', 'equipment', 'serial', 'metric', 'event_ts', 'received_at', 'value', 'unit', 'quality']));
  } catch (e) {
    console.error('[iot export telemetry]', e.message);
    res.status(500).json({ error: 'export failed' });
  }
});

router.get('/export/alerts', requirePermission('iot', 'export'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 730);
    const params = [String(days)];
    let sql = `
      SELECT da.id AS alert_id, da.incident_uid, ce.equipment_name AS equipment, ce.serial_number AS serial,
             a.name AS customer, pr.project_name AS project,
             da.metric, da.observed_value::float AS observed, da.threshold::float AS threshold,
             da.unit, da.severity, da.state, da.opened_at AS detected,
             da.acknowledged_at AS acknowledged, da.resolved_at AS resolved,
             da.resolution_source, t.ticket_number AS ticket, t.status AS ticket_status
        FROM device_alerts da
        JOIN customer_equipment ce ON ce.id = da.equipment_id
        LEFT JOIN support_tickets t ON t.id = da.ticket_id
        LEFT JOIN accounts a ON a.id = ce.crm_account_id
        LEFT JOIN projects pr ON pr.id = ce.project_id
       WHERE da.opened_at > NOW() - ($1 || ' days')::interval`;
    sql += companyPredicate(scope, 'da.company_id', params);
    sql += ` ORDER BY da.opened_at DESC LIMIT 50000`;
    const { rows } = await pool.query(sql, params);
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: null, recordType: 'alert_export', action: 'export', newData: { rows: rows.length, days }, req, company_id: scope.companyId });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="iot-alerts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv(rows, ['alert_id', 'incident_uid', 'equipment', 'serial', 'customer', 'project', 'metric', 'observed', 'threshold', 'unit', 'severity', 'state', 'detected', 'acknowledged', 'resolved', 'resolution_source', 'ticket', 'ticket_status']));
  } catch (e) {
    console.error('[iot export alerts]', e.message);
    res.status(500).json({ error: 'export failed' });
  }
});

// ── POST /iot/ops/outbox/:id/replay ───────────────────────────────────────────
router.post('/ops/outbox/:id/replay', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [parseInt(req.params.id, 10)];
    let sql = `SELECT id, company_id FROM iot_outbox WHERE id = $1 AND status = 'dead'`;
    sql += companyPredicate(scope, 'company_id', params);
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: 'dead-letter event not found' });
    const ok = await replayDead(pool, rows[0].id);
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: rows[0].id, recordType: 'iot_outbox', action: 'update', newData: { status: 'pending', replayed: true }, req, company_id: rows[0].company_id });
    res.json({ ok });
  } catch (e) { res.status(500).json({ error: 'replay failed' }); }
});

export default router;
