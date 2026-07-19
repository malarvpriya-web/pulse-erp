/**
 * ingest.routes.js — the device-facing telemetry write path (Phase 1).
 *
 * Mounted WITHOUT verifyToken (like /sign and /customer-portal): devices have no
 * user session. Auth is a per-device token, verified inside `deviceAuth` below.
 * Every write is scoped to the equipment row the token resolves to, so a leaked
 * token can only write ITS OWN device's telemetry — never another tenant's.
 *
 *   POST /iot/ingest
 *     headers: X-Device-Token: <raw token>   (or Authorization: Bearer <token>)
 *     body:    { "device_uid": "AHF-TN-0007",
 *                "samples": [ { "metric":"thd_i", "value":4.2, "ts":"..."?, "quality":0? }, ... ] }
 *
 * Provisioning (issuing device_uid + token) lands in Phase 2's devices.routes.js;
 * this file only assumes customer_equipment.device_uid and .telemetry_token_hash
 * have been set (hash = sha256(rawToken), hex).
 */

import { Router } from 'express';
import crypto from 'crypto';
import pool from '../../../config/db.js';
import { raiseAlert } from '../alertActions.js';

const router = Router();

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ── device-token auth ─────────────────────────────────────────────────────────
async function deviceAuth(req, res, next) {
  try {
    const raw =
      req.get('X-Device-Token') ||
      (req.get('Authorization') || '').replace(/^Bearer\s+/i, '') ||
      req.body?.token;
    const deviceUid = req.body?.device_uid;
    if (!raw || !deviceUid) {
      return res.status(401).json({ error: 'device_uid and device token are required' });
    }
    const { rows } = await pool.query(
      `SELECT id, company_id, telemetry_token_hash
         FROM customer_equipment
        WHERE device_uid = $1`,
      [deviceUid],
    );
    const eq = rows[0];
    // Constant-time compare; treat unknown device and bad token identically so the
    // endpoint doesn't leak which device_uids exist.
    const expected = eq?.telemetry_token_hash || '';
    const supplied = sha256(raw);
    const ok =
      expected.length === supplied.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
    if (!eq || !expected || !ok) {
      return res.status(401).json({ error: 'invalid device credentials' });
    }
    req.device = { equipment_id: eq.id, company_id: eq.company_id ?? 1 };
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── POST /iot/ingest ──────────────────────────────────────────────────────────
router.post('/ingest', deviceAuth, async (req, res) => {
  const { equipment_id, company_id } = req.device;
  const samples = Array.isArray(req.body?.samples) ? req.body.samples : null;
  if (!samples || samples.length === 0) {
    return res.status(400).json({ error: 'samples must be a non-empty array' });
  }
  if (samples.length > 5000) {
    return res.status(413).json({ error: 'batch too large (max 5000 samples)' });
  }

  // Validate + normalise before opening a transaction.
  const clean = [];
  for (const s of samples) {
    const metric = typeof s?.metric === 'string' ? s.metric.trim().slice(0, 40) : '';
    if (!metric) return res.status(400).json({ error: 'each sample needs a metric' });
    const value = s?.value == null ? null : Number(s.value);
    if (value != null && !Number.isFinite(value)) {
      return res.status(400).json({ error: `non-numeric value for metric ${metric}` });
    }
    const ts = s?.ts ? new Date(s.ts) : new Date();
    if (Number.isNaN(ts.getTime())) return res.status(400).json({ error: `bad ts for metric ${metric}` });
    const quality = Number.isInteger(s?.quality) ? s.quality : 0;
    clean.push({ metric, value, ts: ts.toISOString(), quality });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. bulk insert raw samples (single multi-row INSERT)
    const cols = [];
    const vals = [];
    clean.forEach((s, i) => {
      const b = i * 6;
      cols.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
      vals.push(company_id, equipment_id, s.ts, s.metric, s.value, s.quality);
    });
    await client.query(
      `INSERT INTO device_telemetry (company_id, equipment_id, ts, metric, value, quality)
       VALUES ${cols.join(',')}`,
      vals,
    );

    // 2. upsert the latest-value cache — keep only the newest ts per metric
    const latest = new Map();
    for (const s of clean) {
      const prev = latest.get(s.metric);
      if (!prev || s.ts > prev.ts) latest.set(s.metric, s);
    }
    for (const s of latest.values()) {
      await client.query(
        `INSERT INTO device_latest (equipment_id, company_id, metric, ts, value, quality)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (equipment_id, metric) DO UPDATE
           SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality
         WHERE device_latest.ts < EXCLUDED.ts`,
        [equipment_id, company_id, s.metric, s.ts, s.value, s.quality],
      );
    }

    // 3. mark the device seen / online
    const newestTs = clean.reduce((m, s) => (s.ts > m ? s.ts : m), clean[0].ts);
    await client.query(
      `UPDATE customer_equipment
          SET last_seen_at = GREATEST(COALESCE(last_seen_at, $2::timestamptz), $2::timestamptz),
              connection_state = 'online'
        WHERE id = $1`,
      [equipment_id, newestTs],
    );

    // 4. evaluate threshold rules against this batch's latest values
    const alerts = await evaluateRules(client, { equipment_id, company_id }, latest);

    await client.query('COMMIT');
    res.json({ ok: true, accepted: clean.length, alerts });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/**
 * Rule evaluation: numeric-threshold rules only, checked against the latest
 * value seen in THIS batch. On breach, raiseAlert() opens one alert per
 * (equipment,rule) idempotently and, for critical alerts, spawns a service
 * ticket (see alertActions.js). Stale-device rules are handled by the monitor
 * cron, not here — a device that stopped reporting sends no batch to react to.
 */
async function evaluateRules(client, { equipment_id, company_id }, latestByMetric) {
  const metrics = [...latestByMetric.keys()];
  if (metrics.length === 0) return 0;

  const { rows: rules } = await client.query(
    `SELECT id, metric, operator, threshold, severity
       FROM device_alert_rules
      WHERE is_active = TRUE
        AND company_id = $1
        AND operator <> 'stale'
        AND threshold IS NOT NULL
        AND metric = ANY($2)
        AND (equipment_id = $3 OR equipment_id IS NULL)`,
    [company_id, metrics, equipment_id],
  );

  const breaches = (op, v, t) =>
    op === '>'  ? v >  t :
    op === '<'  ? v <  t :
    op === '>=' ? v >= t :
    op === '<=' ? v <= t :
    op === '='  ? v === t : false;

  let opened = 0;
  for (const r of rules) {
    const s = latestByMetric.get(r.metric);
    if (!s || s.value == null) continue;
    if (!breaches(r.operator, Number(s.value), Number(r.threshold))) continue;

    const { opened: n } = await raiseAlert(client, {
      companyId: company_id, equipmentId: equipment_id, ruleId: r.id,
      metric: r.metric, value: s.value, severity: r.severity,
      message: `${r.metric} ${r.operator} ${r.threshold} (read ${s.value})`,
    });
    opened += n;
  }
  return opened;
}

export default router;
