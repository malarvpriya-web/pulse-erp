/**
 * service.routes.js — the §74 ERP loop and the metric/profile registry CRUD.
 *
 * Two gaps from IOT_PHASE4_REPORT.md section L are closed here:
 *
 *   gap 7  — the alert -> ticket -> technician chain now continues through parts,
 *            inventory, serial genealogy and a financial posting
 *   gap 12 — the metric registry and device profiles are editable, which is also
 *            what makes the hardware pilot possible: a register map can be
 *            entered without a SQL console
 *
 * ENDPOINTS
 *   GET    /iot/equipment/:id/genealogy      as-built + as-maintained picture
 *   GET    /iot/equipment/:id/service-parts  parts consumed on this unit
 *   POST   /iot/equipment/:id/service-parts  issue a part (the whole chain)
 *   POST   /iot/service-parts/:id/reverse    reverse an issue
 *   GET    /iot/spare-parts                  pickable spares with stock
 *   GET    /iot/notification-channels        which channels this deployment can deliver
 *   GET    /iot/alerts/:id/deliveries        what was actually delivered, per channel
 *
 *   POST   /iot/metrics   PUT /iot/metrics/:id   DELETE /iot/metrics/:id
 *   POST   /iot/profiles  PUT /iot/profiles/:id  DELETE /iot/profiles/:id
 */

import { Router } from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { iotScope, denyScope, companyPredicate, scopedEquipment, writeCompany } from '../scope.js';
import { issuePart, reverseIssue, equipmentGenealogy, resolveCover } from '../serviceParts.js';
import { channelAvailability } from '../notify.js';
import { invalidateMetricCache } from '../metricRegistry.js';

const router = Router();

// ── GET /iot/equipment/:id/genealogy ──────────────────────────────────────────
router.get('/equipment/:id/genealogy', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'equipment not found' });
    const data = await equipmentGenealogy(pool, { equipmentId: eq.id, companyId: eq.company_id });
    if (!data) return res.status(404).json({ error: 'equipment not found' });
    res.json(data);
  } catch (e) {
    console.error('[iot genealogy]', e.message);
    res.status(500).json({ error: 'failed to load genealogy' });
  }
});

// ── GET /iot/equipment/:id/service-parts ──────────────────────────────────────
router.get('/equipment/:id/service-parts', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'equipment not found' });
    const { rows } = await pool.query(
      `SELECT sp.*, p.part_code, p.name AS part_name, p.unit,
              t.ticket_number, t.status AS ticket_status,
              je.entry_number, je.status AS journal_status,
              u.name AS issued_by_name
         FROM iot_service_parts sp
         JOIN spare_parts p ON p.id = sp.part_id
         LEFT JOIN support_tickets t ON t.id = sp.ticket_id
         LEFT JOIN journal_entries je ON je.id = sp.journal_entry_id
         LEFT JOIN users u ON u.id = sp.issued_by
        WHERE sp.equipment_id = $1 AND sp.company_id = $2
        ORDER BY sp.issued_at DESC LIMIT 200`,
      [eq.id, eq.company_id]);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: 'failed to load service parts' }); }
});

// ── POST /iot/equipment/:id/service-parts ─────────────────────────────────────
// The whole chain in one call. Everything it writes commits together or not at
// all — a part issue that decremented stock but failed to record genealogy would
// be a silent divergence between two sources of truth.
router.post('/equipment/:id/service-parts', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'equipment not found' });

    const b = req.body || {};
    if (b.part_id == null) return res.status(400).json({ error: 'part_id is required' });
    if (b.quantity == null) return res.status(400).json({ error: 'quantity is required' });
    if (b.cover && !['warranty', 'amc', 'chargeable', 'goodwill'].includes(b.cover)) {
      return res.status(400).json({ error: `invalid cover '${b.cover}' — one of warranty, amc, chargeable, goodwill` });
    }

    // A ticket named on the request must belong to this company. Without this a
    // part issue could be costed onto another tenant's job.
    if (b.ticket_id != null) {
      const { rows } = await pool.query(
        `SELECT id FROM support_tickets WHERE id = $1 AND company_id = $2`,
        [b.ticket_id, eq.company_id]);
      if (!rows.length) return res.status(403).json({ error: 'ticket does not belong to this company', code: 'CROSS_COMPANY_TICKET' });
    }
    if (b.alert_id != null) {
      const { rows } = await pool.query(
        `SELECT id FROM device_alerts WHERE id = $1 AND company_id = $2 AND equipment_id = $3`,
        [b.alert_id, eq.company_id, eq.id]);
      if (!rows.length) return res.status(403).json({ error: 'alert does not belong to this equipment', code: 'ALERT_MISMATCH' });
    }

    const result = await issuePart({
      companyId: eq.company_id,
      equipmentId: eq.id,
      partId: parseInt(b.part_id, 10),
      quantity: Number(b.quantity),
      ticketId: b.ticket_id ?? null,
      alertId: b.alert_id ?? null,
      removedSerial: b.removed_serial ?? null,
      fittedSerial: b.fitted_serial ?? null,
      cover: b.cover ?? null,
      reason: b.reason ?? null,
      userId: req.user?.userId ?? null,
    });

    if (!result.ok) {
      const status = result.code === 'INSUFFICIENT_STOCK' ? 409
        : result.code === 'BAD_QUANTITY' ? 400
        : result.code?.endsWith('NOT_FOUND') ? 404 : 500;
      return res.status(status).json({ error: result.error, code: result.code });
    }

    logAudit({
      userId: req.user?.userId, module: 'iot', recordId: result.row.id,
      recordType: 'iot_service_part', action: 'create',
      newData: { ...result.row, chain: result.chain }, req, company_id: eq.company_id,
    });
    res.status(201).json(result);
  } catch (e) {
    console.error('[iot issue part]', e.message);
    res.status(500).json({ error: 'failed to issue part' });
  }
});

// ── POST /iot/service-parts/:id/reverse ───────────────────────────────────────
router.post('/service-parts/:id/reverse', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const target = writeCompany(scope, req.body);
    if (!target.ok) return res.status(403).json({ error: 'company scope required', code: target.reason });
    const result = await reverseIssue({
      servicePartId: parseInt(req.params.id, 10),
      companyId: target.companyId,
      userId: req.user?.userId ?? null,
      reason: req.body?.reason ?? null,
    });
    if (!result.ok) {
      // A refusal to reverse unverifiable records is a conflict with the data,
      // not a server failure.
      const status = result.code === 'NOT_FOUND' ? 404
        : ['ALREADY_REVERSED', 'JOURNAL_ALREADY_REVERSED', 'JOURNAL_ORIGINAL_UNVERIFIED', 'LEDGER_ORIGINAL_UNVERIFIED'].includes(result.code) ? 409
        : 500;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    logAudit({
      userId: req.user?.userId, module: 'iot', recordId: result.row.id,
      recordType: 'iot_service_part', action: 'update',
      newData: { reversal_of: req.params.id, reason: req.body?.reason,
                 stock_ledger_reversal_id: result.stock_ledger_reversal_id, journal_reversal_id: result.journal_reversal_id },
      req, company_id: target.companyId,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: 'reversal failed' }); }
});

// ── GET /iot/spare-parts ──────────────────────────────────────────────────────
// The picker for the parts dialog. Returns stock so an engineer cannot select a
// part that is not there, and flags low stock rather than leaving it to be
// discovered at issue time.
router.get('/spare-parts', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [];
    let sql = `SELECT id, part_code, name, stock_qty::float AS stock_qty, unit, unit_cost::float AS unit_cost,
                      reorder_level::float AS reorder_level, category, location,
                      (stock_qty <= COALESCE(reorder_level, 0)) AS low_stock
                 FROM spare_parts WHERE 1 = 1`;
    if (!scope.isGlobal) { params.push(scope.companyId); sql += ` AND (company_id = $${params.length} OR company_id IS NULL)`; }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      sql += ` AND (part_code ILIKE $${params.length} OR name ILIKE $${params.length})`;
    }
    if (req.query.in_stock === 'true') sql += ` AND stock_qty > 0`;
    sql += ` ORDER BY (stock_qty > 0) DESC, part_code LIMIT 300`;
    const { rows } = await pool.query(sql, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: 'failed to load spare parts' }); }
});

// ── GET /iot/notification-channels ────────────────────────────────────────────
// So the rule editor offers only channels this deployment can actually deliver,
// instead of a switch that silently does nothing.
router.get('/notification-channels', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  // scope.companyId is this module's own tenant helper (iot/scope.js) — null for
  // a global super-admin scope, which reports the deployment's own availability.
  res.json({ channels: await channelAvailability(scope.companyId) });
});

// ── GET /iot/alerts/:id/deliveries ────────────────────────────────────────────
router.get('/alerts/:id/deliveries', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [parseInt(req.params.id, 10)];
    let sql = `SELECT l.id, l.event_key, l.channel, l.destination, l.status, l.detail, l.created_at,
                      u.name AS recipient_name
                 FROM iot_notification_log l
                 LEFT JOIN users u ON u.id = l.user_id
                WHERE l.alert_id = $1`;
    sql += companyPredicate(scope, 'l.company_id', params);
    sql += ` ORDER BY l.created_at`;
    const { rows } = await pool.query(sql, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: 'failed to load delivery log' }); }
});

// ══ METRIC REGISTRY CRUD (gap 12) ════════════════════════════════════════════
// A tenant metric previously needed a SQL insert. That is also what blocked the
// hardware pilot: a register map could not be entered through the application.

const AGGREGATIONS = new Set(['avg', 'min', 'max', 'sum', 'last', 'counter', 'pf_energy']);
const QUALITY_POLICIES = new Set(['valid_only', 'include_suspect', 'history', 'all']);

function validateMetric(b, { partial = false } = {}) {
  const need = (k) => !partial && (b[k] == null || b[k] === '');
  if (need('metric_code')) return 'metric_code is required';
  if (need('display_name')) return 'display_name is required';
  if (need('unit')) return 'unit is required';
  if (b.metric_code && !/^[A-Z0-9_]{1,40}$/.test(b.metric_code)) {
    return "metric_code must be UPPER_SNAKE_CASE, 1-40 characters (the gateway sends it verbatim, so a stray space or case difference becomes an UNKNOWN_METRIC rejection)";
  }
  if (b.aggregation && !AGGREGATIONS.has(b.aggregation)) {
    return `invalid aggregation '${b.aggregation}' — one of ${[...AGGREGATIONS].join(', ')}`;
  }
  if (b.quality_policy && !QUALITY_POLICIES.has(b.quality_policy)) {
    return `invalid quality_policy '${b.quality_policy}'`;
  }
  const min = b.min_physical == null ? null : Number(b.min_physical);
  const max = b.max_physical == null ? null : Number(b.max_physical);
  if (min != null && max != null && min >= max) {
    return `min_physical (${min}) must be below max_physical (${max}), or every reading is rejected as out of range`;
  }
  return null;
}

router.post('/metrics', requirePermission('iot', 'add'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  const target = writeCompany(scope, req.body);
  if (!target.ok) return res.status(400).json({ error: 'company scope required', code: target.reason });
  try {
    const err = validateMetric(req.body);
    if (err) return res.status(400).json({ error: err });
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO iot_metric_definitions
         (company_id, metric_code, display_name, unit, data_type, description, device_types,
          min_physical, max_physical, precision_digits, sampling_expect_s, aggregation,
          quality_policy, rising_is_bad, is_counter, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [target.companyId, b.metric_code, b.display_name, b.unit, b.data_type || 'number',
       b.description ?? null, b.device_types || [], b.min_physical ?? null, b.max_physical ?? null,
       b.precision_digits ?? 3, b.sampling_expect_s ?? null, b.aggregation || 'avg',
       b.quality_policy || 'valid_only', !!b.rising_is_bad, !!b.is_counter, b.enabled !== false]);
    invalidateMetricCache();
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: rows[0].id, recordType: 'iot_metric_definition', action: 'create', newData: rows[0], req, company_id: target.companyId });
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'a metric with this code already exists for this company', code: 'DUPLICATE_METRIC' });
    console.error('[iot metric create]', e.message);
    res.status(500).json({ error: 'failed to create metric' });
  }
});

router.put('/metrics/:id', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const { rows: existing } = await pool.query(
      `SELECT * FROM iot_metric_definitions WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!existing.length) return res.status(404).json({ error: 'metric not found' });
    const m = existing[0];

    // The GLOBAL catalogue is shared by every tenant. Letting one company edit it
    // would silently change the meaning of a metric for all of them — the tenant
    // route is to create an override row with the same code.
    if (m.company_id == null) {
      return res.status(403).json({
        error: 'This is a global catalogue metric and cannot be edited by a tenant.',
        code: 'GLOBAL_METRIC_READONLY',
        hint: `Create a company metric with the same code (${m.metric_code}) — a tenant definition overrides the global one for your company only.`,
      });
    }
    if (!scope.isGlobal && m.company_id !== scope.companyId) {
      return res.status(404).json({ error: 'metric not found' });
    }

    const err = validateMetric({ ...m, ...req.body }, { partial: true });
    if (err) return res.status(400).json({ error: err });

    const allowed = ['display_name', 'unit', 'data_type', 'description', 'device_types',
                     'min_physical', 'max_physical', 'precision_digits', 'sampling_expect_s',
                     'aggregation', 'quality_policy', 'rising_is_bad', 'is_counter', 'enabled'];
    const sets = [], up = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { up.push(req.body[k]); sets.push(`${k} = $${up.length + 1}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    const { rows } = await pool.query(
      `UPDATE iot_metric_definitions SET ${sets.join(', ')}, version = version + 1, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [m.id, ...up]);
    invalidateMetricCache();
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: m.id, recordType: 'iot_metric_definition', action: 'update', oldData: m, newData: rows[0], req, company_id: m.company_id });
    res.json(rows[0]);
  } catch (e) { console.error('[iot metric update]', e.message); res.status(500).json({ error: 'failed to update metric' }); }
});

router.delete('/metrics/:id', requirePermission('iot', 'delete'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const { rows: existing } = await pool.query(`SELECT * FROM iot_metric_definitions WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!existing.length) return res.status(404).json({ error: 'metric not found' });
    const m = existing[0];
    if (m.company_id == null) return res.status(403).json({ error: 'global catalogue metrics cannot be deleted', code: 'GLOBAL_METRIC_READONLY' });
    if (!scope.isGlobal && m.company_id !== scope.companyId) return res.status(404).json({ error: 'metric not found' });

    // Refuse while telemetry or a rule depends on it. Deleting the definition
    // would not delete the data; it would make the data uninterpretable, and the
    // next sample would be rejected as UNKNOWN_METRIC with no obvious cause.
    const { rows: deps } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM device_alert_rules WHERE metric = $1 AND company_id = $2)::int AS rules,
              (SELECT COUNT(*) FROM device_latest l JOIN customer_equipment ce ON ce.id = l.equipment_id
                WHERE l.metric = $1 AND ce.company_id = $2)::int AS live_metrics`,
      [m.metric_code, m.company_id]);
    if (deps[0].rules > 0 || deps[0].live_metrics > 0) {
      return res.status(409).json({
        error: `'${m.metric_code}' is in use`,
        code: 'METRIC_IN_USE',
        detail: `${deps[0].rules} alert rule(s) and ${deps[0].live_metrics} reporting device(s) reference it. Disable the metric instead of deleting it.`,
      });
    }
    await pool.query(`DELETE FROM iot_metric_definitions WHERE id = $1`, [m.id]);
    invalidateMetricCache();
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: m.id, recordType: 'iot_metric_definition', action: 'delete', oldData: m, req, company_id: m.company_id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'failed to delete metric' }); }
});

// ══ DEVICE PROFILE CRUD ══════════════════════════════════════════════════════
// This is what makes the hardware pilot runnable: a real register map can be
// entered, verified and committed without a SQL console.

const ADDRESSING = new Set(['one_based', 'zero_based']);
const ORDERS = new Set(['big', 'little']);
const REGISTER_TYPES = new Set(['int16', 'uint16', 'int32', 'uint32', 'float32', 'float64']);

async function validateProfile(b, companyId, { partial = false } = {}) {
  const need = (k) => !partial && (b[k] == null || b[k] === '');
  if (need('profile_code')) return 'profile_code is required';
  if (need('device_type')) return 'device_type is required';
  if (b.addressing_mode && !ADDRESSING.has(b.addressing_mode)) return `addressing_mode must be one of ${[...ADDRESSING].join(', ')}`;
  if (b.byte_order && !ORDERS.has(b.byte_order)) return `byte_order must be one of ${[...ORDERS].join(', ')}`;
  if (b.word_order && !ORDERS.has(b.word_order)) return `word_order must be one of ${[...ORDERS].join(', ')}`;

  if (b.register_map !== undefined) {
    const map = b.register_map;
    if (!Array.isArray(map)) return 'register_map must be an array';
    const seen = new Set();
    for (const [i, r] of map.entries()) {
      if (!r || typeof r !== 'object') return `register_map[${i}] must be an object`;
      if (!r.metric) return `register_map[${i}] has no metric`;
      if (seen.has(r.metric)) return `register_map has two entries for '${r.metric}'`;
      seen.add(r.metric);
      if (r.address == null || !Number.isFinite(Number(r.address))) return `register_map[${i}] (${r.metric}) has no numeric address`;
      if (!REGISTER_TYPES.has(r.type)) return `register_map[${i}] (${r.metric}) has type '${r.type}' — one of ${[...REGISTER_TYPES].join(', ')}`;
      if (r.register && !['holding', 'input'].includes(r.register)) return `register_map[${i}] (${r.metric}) register must be 'holding' or 'input'`;
      if (r.scale != null && !Number.isFinite(Number(r.scale))) return `register_map[${i}] (${r.metric}) scale must be numeric`;
      // A register mapped to a metric nobody declared produces UNKNOWN_METRIC on
      // every poll — catch it here rather than in the quarantine table.
      const { rows } = await pool.query(
        `SELECT 1 FROM iot_metric_definitions
          WHERE metric_code = $1 AND (company_id IS NULL OR company_id = $2) LIMIT 1`,
        [r.metric, companyId]);
      if (!rows.length) return `register_map[${i}] maps to '${r.metric}', which is not in the metric registry`;
    }
  }

  if (b.capabilities !== undefined) {
    if (!Array.isArray(b.capabilities)) return 'capabilities must be an array of metric codes';
    for (const code of b.capabilities) {
      const { rows } = await pool.query(
        `SELECT 1 FROM iot_metric_definitions
          WHERE metric_code = $1 AND (company_id IS NULL OR company_id = $2) LIMIT 1`,
        [code, companyId]);
      if (!rows.length) return `capability '${code}' is not in the metric registry`;
    }
  }
  return null;
}

router.post('/profiles', requirePermission('iot', 'add'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  const target = writeCompany(scope, req.body);
  if (!target.ok) return res.status(400).json({ error: 'company scope required', code: target.reason });
  try {
    const err = await validateProfile(req.body, target.companyId);
    if (err) return res.status(400).json({ error: err });
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO iot_device_profiles
         (company_id, profile_code, device_type, manufacturer, model, firmware, register_map_ver,
          protocol, addressing_mode, byte_order, word_order, default_sampling_s,
          capabilities, register_map, is_template, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,FALSE,$15) RETURNING *`,
      [target.companyId, b.profile_code, b.device_type, b.manufacturer ?? null, b.model ?? null,
       b.firmware ?? null, b.register_map_ver ?? null, b.protocol || 'modbus_tcp',
       b.addressing_mode || 'one_based', b.byte_order || 'big', b.word_order || 'big',
       b.default_sampling_s ?? 60, b.capabilities || [],
       JSON.stringify(b.register_map || []), b.enabled !== false]);
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: rows[0].id, recordType: 'iot_device_profile', action: 'create', newData: rows[0], req, company_id: target.companyId });
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'a profile with this code already exists for this company', code: 'DUPLICATE_PROFILE' });
    console.error('[iot profile create]', e.message);
    res.status(500).json({ error: 'failed to create profile' });
  }
});

router.put('/profiles/:id', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const { rows: existing } = await pool.query(`SELECT * FROM iot_device_profiles WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!existing.length) return res.status(404).json({ error: 'profile not found' });
    const p = existing[0];
    if (p.company_id == null) {
      return res.status(403).json({
        error: 'This is a shipped template and cannot be edited.',
        code: 'TEMPLATE_READONLY',
        hint: 'Copy it to a company profile (POST /iot/profiles) and edit that. Templates deliberately carry no register map so they cannot be mistaken for verified mappings.',
      });
    }
    if (!scope.isGlobal && p.company_id !== scope.companyId) return res.status(404).json({ error: 'profile not found' });

    const err = await validateProfile({ ...p, ...req.body }, p.company_id, { partial: true });
    if (err) return res.status(400).json({ error: err });

    const allowed = ['profile_code', 'device_type', 'manufacturer', 'model', 'firmware',
                     'register_map_ver', 'protocol', 'addressing_mode', 'byte_order', 'word_order',
                     'default_sampling_s', 'capabilities', 'enabled'];
    const sets = [], up = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { up.push(req.body[k]); sets.push(`${k} = $${up.length + 1}`); }
    }
    if (req.body.register_map !== undefined) {
      up.push(JSON.stringify(req.body.register_map));
      sets.push(`register_map = $${up.length + 1}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    const { rows } = await pool.query(
      `UPDATE iot_device_profiles SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [p.id, ...up]);
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: p.id, recordType: 'iot_device_profile', action: 'update', oldData: p, newData: rows[0], req, company_id: p.company_id });
    res.json(rows[0]);
  } catch (e) { console.error('[iot profile update]', e.message); res.status(500).json({ error: 'failed to update profile' }); }
});

router.delete('/profiles/:id', requirePermission('iot', 'delete'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const { rows: existing } = await pool.query(`SELECT * FROM iot_device_profiles WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!existing.length) return res.status(404).json({ error: 'profile not found' });
    const p = existing[0];
    if (p.company_id == null) return res.status(403).json({ error: 'shipped templates cannot be deleted', code: 'TEMPLATE_READONLY' });
    if (!scope.isGlobal && p.company_id !== scope.companyId) return res.status(404).json({ error: 'profile not found' });

    const { rows: used } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM customer_equipment WHERE device_profile_id = $1`, [p.id]);
    if (used[0].n > 0) {
      return res.status(409).json({
        error: `${used[0].n} device(s) use this profile`,
        code: 'PROFILE_IN_USE',
        detail: 'Detach it from those devices first, or disable the profile instead of deleting it.',
      });
    }
    await pool.query(`DELETE FROM iot_device_profiles WHERE id = $1`, [p.id]);
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: p.id, recordType: 'iot_device_profile', action: 'delete', oldData: p, req, company_id: p.company_id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'failed to delete profile' }); }
});

export default router;
export { resolveCover };
