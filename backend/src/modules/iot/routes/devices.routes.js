/**
 * devices.routes.js — the operator-facing IoT fleet API (Phase 2).
 *
 * Mounted at /iot WITH verifyToken (after the device-token ingest router, which
 * only claims POST /iot/ingest — everything here falls through to it). All reads
 * and writes are company-scoped via req.scope.company_id.
 *
 * Endpoints:
 *   GET  /iot/devices                     fleet list + latest state + open-alert count
 *   GET  /iot/devices/:id                 one device: registry + latest metrics + recent alerts
 *   GET  /iot/devices/:id/telemetry       time-series history (?metric=&hours=)
 *   POST /iot/devices/:id/provision       mint device_uid (if absent) + token  [token shown ONCE]
 *   POST /iot/devices/:id/rotate-token    new token, invalidates the old one    [token shown ONCE]
 *   GET  /iot/alerts                       alerts across the fleet (?state=)
 *   PUT  /iot/alerts/:id/ack               acknowledge
 *   PUT  /iot/alerts/:id/resolve           resolve (clears the open-alert slot)
 *   GET  /iot/rules  · POST /iot/rules  · PUT /iot/rules/:id  · DELETE /iot/rules/:id
 */

import { Router } from 'express';
import crypto from 'crypto';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';

const router = Router();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Resolve a device the caller is allowed to see; returns null if out of scope.
async function scopedEquipment(id, companyId) {
  const params = [id];
  let sql = `SELECT * FROM customer_equipment WHERE id = $1`;
  if (companyId != null) { params.push(companyId); sql += ` AND company_id = $2`; }
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

// ── GET /iot/devices ──────────────────────────────────────────────────────────
router.get('/devices', requirePermission('iot', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const { search, state } = req.query;
    const params = [];
    let q = `
      SELECT ce.id, ce.equipment_name, ce.model_number, ce.serial_number,
             ce.gps_lat, ce.gps_lng, ce.connection_state, ce.last_seen_at,
             ce.warranty_status, ce.amc_status, ce.status,
             (ce.device_uid IS NOT NULL)                       AS provisioned,
             COALESCE(a.open_alerts, 0)::int                   AS open_alerts,
             a.max_severity
        FROM customer_equipment ce
        LEFT JOIN (
          SELECT equipment_id,
                 COUNT(*) AS open_alerts,
                 MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END) AS sev
            FROM device_alerts
           WHERE state <> 'resolved'
           GROUP BY equipment_id
        ) oa ON oa.equipment_id = ce.id
        LEFT JOIN LATERAL (
          SELECT oa.open_alerts,
                 CASE oa.sev WHEN 3 THEN 'critical' WHEN 2 THEN 'warning' ELSE 'info' END AS max_severity
        ) a ON TRUE
       WHERE 1 = 1`;
    if (companyId != null) { params.push(companyId); q += ` AND ce.company_id = $${params.length}`; }
    if (state)  { params.push(state);  q += ` AND ce.connection_state = $${params.length}`; }
    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      q += ` AND (ce.equipment_name ILIKE $${p} OR ce.serial_number ILIKE $${p} OR ce.model_number ILIKE $${p})`;
    }
    q += ` ORDER BY open_alerts DESC, ce.equipment_name ASC LIMIT 500`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /iot/devices/:id ──────────────────────────────────────────────────────
router.get('/devices/:id', requirePermission('iot', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const eq = await scopedEquipment(req.params.id, companyId);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    delete eq.telemetry_token_hash;          // never leak the credential
    eq.provisioned = eq.device_uid != null;  // what the UI toggles provision/rotate on

    const [{ rows: latest }, { rows: alerts }] = await Promise.all([
      pool.query(
        `SELECT metric, value::float AS value, ts, quality
           FROM device_latest WHERE equipment_id = $1 ORDER BY metric`,
        [eq.id]),
      pool.query(
        `SELECT id, metric, value::float AS value, severity, state, message,
                opened_at, acknowledged_at, resolved_at
           FROM device_alerts WHERE equipment_id = $1
          ORDER BY (state <> 'resolved') DESC, opened_at DESC LIMIT 20`,
        [eq.id]),
    ]);
    res.json({ ...eq, latest, alerts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /iot/devices/:id/telemetry?metric=&hours= ─────────────────────────────
router.get('/devices/:id/telemetry', requirePermission('iot', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const eq = await scopedEquipment(req.params.id, companyId);
    if (!eq) return res.status(404).json({ error: 'device not found' });

    const metric = String(req.query.metric || '').trim();
    if (!metric) return res.status(400).json({ error: 'metric is required' });
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 90);

    // Downsample by bucketing so a long window returns a chartable number of points.
    const bucketMins = hours <= 6 ? 1 : hours <= 48 ? 15 : hours <= 24 * 14 ? 60 : 360;
    const { rows } = await pool.query(
      `SELECT to_timestamp(floor(extract(epoch FROM ts) / ($3 * 60)) * ($3 * 60)) AS bucket,
              AVG(value)::float AS value,
              MIN(value)::float AS min_value,
              MAX(value)::float AS max_value
         FROM device_telemetry
        WHERE equipment_id = $1 AND metric = $2
          AND ts >= NOW() - ($4 || ' hours')::interval
        GROUP BY 1 ORDER BY 1`,
      [eq.id, metric, bucketMins, String(hours)]);
    res.json({ metric, hours, bucket_mins: bucketMins, points: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /iot/devices/:id/provision ───────────────────────────────────────────
async function issueToken(res, eq, { regenUid }) {
  const token = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  const deviceUid = (!eq.device_uid || regenUid)
    ? `PULSE-${eq.id}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
    : eq.device_uid;
  await pool.query(
    `UPDATE customer_equipment
        SET device_uid = $2, telemetry_token_hash = $3,
            connection_state = CASE WHEN connection_state = 'never' THEN 'never' ELSE connection_state END,
            updated_at = NOW()
      WHERE id = $1`,
    [eq.id, deviceUid, sha256(token)]);
  // The raw token is returned exactly once — it is never stored or recoverable.
  res.json({ device_uid: deviceUid, token, ingest_url: '/api/v1/iot/ingest',
             note: 'Store this token now — it cannot be retrieved again.' });
}

router.post('/devices/:id/provision', requirePermission('iot', 'edit'), async (req, res) => {
  try {
    const eq = await scopedEquipment(req.params.id, req.scope?.company_id ?? null);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    await issueToken(res, eq, { regenUid: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/devices/:id/rotate-token', requirePermission('iot', 'edit'), async (req, res) => {
  try {
    const eq = await scopedEquipment(req.params.id, req.scope?.company_id ?? null);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    await issueToken(res, eq, { regenUid: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Alerts ────────────────────────────────────────────────────────────────────
router.get('/alerts', requirePermission('iot', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const { state } = req.query;
    const params = [];
    let q = `
      SELECT da.id, da.equipment_id, ce.equipment_name, da.metric, da.value::float AS value,
             da.severity, da.state, da.message, da.opened_at, da.acknowledged_at, da.resolved_at
        FROM device_alerts da
        JOIN customer_equipment ce ON ce.id = da.equipment_id
       WHERE 1 = 1`;
    if (companyId != null) { params.push(companyId); q += ` AND da.company_id = $${params.length}`; }
    if (state) { params.push(state); q += ` AND da.state = $${params.length}`; }
    else       { q += ` AND da.state <> 'resolved'`; }
    q += ` ORDER BY da.opened_at DESC LIMIT 200`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function transitionAlert(req, res, toState, tsCol) {
  const companyId = req.scope?.company_id ?? null;
  const params = [req.params.id];
  let sql = `UPDATE device_alerts SET state = '${toState}', ${tsCol} = NOW() WHERE id = $1`;
  if (companyId != null) { params.push(companyId); sql += ` AND company_id = $2`; }
  sql += ` RETURNING id, state`;
  const { rows } = await pool.query(sql, params);
  if (!rows.length) return res.status(404).json({ error: 'alert not found' });
  res.json(rows[0]);
}
router.put('/alerts/:id/ack',     requirePermission('iot', 'edit'), (req, res) =>
  transitionAlert(req, res, 'acknowledged', 'acknowledged_at').catch(e => res.status(500).json({ error: e.message })));
router.put('/alerts/:id/resolve', requirePermission('iot', 'edit'), (req, res) =>
  transitionAlert(req, res, 'resolved', 'resolved_at').catch(e => res.status(500).json({ error: e.message })));

// ── Alert rules CRUD ──────────────────────────────────────────────────────────
router.get('/rules', requirePermission('iot', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const params = [];
    let q = `SELECT r.*, ce.equipment_name
               FROM device_alert_rules r
               LEFT JOIN customer_equipment ce ON ce.id = r.equipment_id
              WHERE 1 = 1`;
    if (companyId != null) { params.push(companyId); q += ` AND r.company_id = $${params.length}`; }
    q += ` ORDER BY r.created_at DESC`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const OPERATORS = new Set(['>', '<', '>=', '<=', '=', 'stale']);
router.post('/rules', requirePermission('iot', 'add'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? 1;
    const { equipment_id = null, name, metric, operator = '>', threshold = null,
            stale_secs = null, severity = 'warning' } = req.body || {};
    if (!name || !metric) return res.status(400).json({ error: 'name and metric are required' });
    if (!OPERATORS.has(operator)) return res.status(400).json({ error: `invalid operator: ${operator}` });
    if (operator !== 'stale' && (threshold == null || !Number.isFinite(Number(threshold))))
      return res.status(400).json({ error: 'a numeric threshold is required for this operator' });
    const { rows } = await pool.query(
      `INSERT INTO device_alert_rules
         (company_id, equipment_id, name, metric, operator, threshold, stale_secs, severity, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [companyId, equipment_id, name, metric, operator,
       operator === 'stale' ? null : Number(threshold),
       operator === 'stale' ? (stale_secs ?? 900) : null, severity, req.user?.userId ?? null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/rules/:id', requirePermission('iot', 'edit'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const allowed = ['name', 'metric', 'operator', 'threshold', 'stale_secs', 'severity', 'is_active'];
    const sets = [], params = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        if (k === 'operator' && !OPERATORS.has(req.body[k]))
          return res.status(400).json({ error: `invalid operator: ${req.body[k]}` });
        params.push(req.body[k]); sets.push(`${k} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    params.push(req.params.id);
    let sql = `UPDATE device_alert_rules SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`;
    if (companyId != null) { params.push(companyId); sql += ` AND company_id = $${params.length}`; }
    sql += ` RETURNING *`;
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: 'rule not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/rules/:id', requirePermission('iot', 'delete'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const params = [req.params.id];
    let sql = `DELETE FROM device_alert_rules WHERE id = $1`;
    if (companyId != null) { params.push(companyId); sql += ` AND company_id = $2`; }
    const { rowCount } = await pool.query(sql, params);
    if (!rowCount) return res.status(404).json({ error: 'rule not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
