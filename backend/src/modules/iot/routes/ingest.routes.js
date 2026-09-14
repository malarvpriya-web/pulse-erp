/**
 * ingest.routes.js — the device-facing telemetry write path.
 *
 * Mounted WITHOUT verifyToken: devices have no user session. Auth is a per-device
 * token verified in `deviceAuth`, and every write is scoped to the equipment row
 * that token resolves to, so a leaked token can only write ITS OWN device's
 * telemetry.
 *
 *   POST /iot/ingest
 *     X-Device-Token: <raw token>
 *     {
 *       "device_uid":  "PULSE-42-AB12CD",
 *       "gateway_uid": "GW-BLR-01",               // optional but recommended
 *       "batch_uid":   "b-01J8...",               // REQUIRED for retry safety
 *       "samples": [
 *         { "sample_uid": "s-01J8...", "seq_no": 41201,
 *           "metric": "THD_I_L1", "value": 4.2,
 *           "event_ts": "2026-09-14T10:00:00Z", "quality": "VALID" }
 *       ]
 *     }
 *
 *   POST /iot/gateway/heartbeat   — gateway diagnostics (same device token)
 *
 * WHAT CHANGED IN PHASE 4, AND WHY
 * --------------------------------
 * 1. IDEMPOTENCY. Sample identity was (BIGSERIAL id, ts), so a gateway that
 *    committed a batch and then lost the HTTP response resent it and got a second
 *    copy of every reading. Identity is now (equipment_id, sample_uid, ts) with a
 *    unique index, and the batch is recorded in iot_ingest_batches so a replay
 *    returns the ORIGINAL response instead of reprocessing. Deduplication is a
 *    database constraint, not an application check that a concurrent request can
 *    race past.
 *
 * 2. EVENT TIME vs RECEIPT TIME. `ts` was both. A sample stamped 2099 set
 *    last_seen_at and connection_state='online', so a dead device read as healthy
 *    forever. Liveness now comes from `received_at` (server clock); `ts` stays the
 *    analytical axis. Clock-skew policy is stated below and enforced here.
 *
 * 3. QUALITY. The old `quality SMALLINT` was written and never read. A quality
 *    code now decides whether a sample may touch the latest-value cache, the
 *    liveness state and the alert engine.
 *
 * 4. RANGE. An undeclared metric, or a value outside the metric's declared
 *    physical range, is quarantined in iot_rejected_samples instead of becoming a
 *    measurement.
 *
 * 5. TRANSACTION INTEGRITY. Ticket creation no longer runs inside this
 *    transaction. Telemetry + alert rows + an outbox event commit together; the
 *    worker turns the event into a ticket. A ticket failure cannot abort the
 *    telemetry transaction (which is what actually happened before: a raising
 *    statement inside a transaction aborts it, and the catch block then ran more
 *    SQL on an aborted transaction).
 *
 * CLOCK-SKEW POLICY (configurable via env, defaults in brackets)
 *   IOT_MAX_FUTURE_SKEW_SECS   [120]      event_ts further ahead than this is
 *                                          REJECTED and quarantined.
 *   IOT_REPLAY_AFTER_SECS      [3600]     event_ts older than this is accepted but
 *                                          marked REPLAY: stored in history,
 *                                          excluded from the latest-value cache
 *                                          and from liveness.
 *   IOT_MAX_AGE_DAYS           [30]       event_ts older than this is REJECTED
 *                                          (it would land outside live partitions
 *                                          and cannot be a current reading).
 */

import { Router } from 'express';
import crypto from 'crypto';
import pool from '../../../config/db.js';
import { validateReading } from '../metricRegistry.js';
import { QUALITY, normaliseQuality, drivesCurrentState, isStorable } from '../quality.js';
import { evaluateWindow } from '../alertEngine.js';
import { recordEvent } from '../deviceEvents.js';
import { memoryRateLimit } from '../../../middlewares/rateLimit.js';

const router = Router();

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const MAX_FUTURE_SKEW_SECS = parseInt(process.env.IOT_MAX_FUTURE_SKEW_SECS || '120', 10);
const REPLAY_AFTER_SECS    = parseInt(process.env.IOT_REPLAY_AFTER_SECS || '3600', 10);
const MAX_AGE_DAYS         = parseInt(process.env.IOT_MAX_AGE_DAYS || '30', 10);
const MAX_BATCH            = parseInt(process.env.IOT_MAX_BATCH || '5000', 10);

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
      `SELECT ce.id, ce.company_id, ce.telemetry_token_hash, ce.device_status,
              ce.equipment_name, ce.sampling_secs, ce.gateway_id,
              p.capabilities
         FROM customer_equipment ce
         LEFT JOIN iot_device_profiles p ON p.id = ce.device_profile_id
        WHERE ce.device_uid = $1`,
      [deviceUid],
    );
    const eq = rows[0];

    // Constant-time compare; unknown device and bad token are indistinguishable
    // so the endpoint does not leak which device_uids exist.
    const expected = eq?.telemetry_token_hash || '';
    const supplied = sha256(raw);
    const ok =
      expected.length === supplied.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
    if (!eq || !expected || !ok) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(), level: 'WARN', event: 'iot_ingest_auth_failed',
        device_uid: String(deviceUid).slice(0, 120), ip: req.ip,
      }));
      return res.status(401).json({ error: 'invalid device credentials' });
    }

    // A revoked token or a disabled device stops ingest IMMEDIATELY. Before this,
    // "revoked" had no meaning: the only way to stop a device was to rotate its
    // token, which required someone to notice.
    if (eq.device_status === 'revoked' || eq.device_status === 'disabled') {
      return res.status(403).json({
        error: `device is ${eq.device_status}`,
        code: `DEVICE_${String(eq.device_status).toUpperCase()}`,
      });
    }

    // Token-table cross-check: the equipment row holds the fast-path hash, but a
    // revocation is recorded on the token row. Both must agree.
    const { rows: tk } = await pool.query(
      `SELECT id, status, expires_at FROM iot_device_tokens
        WHERE equipment_id = $1 AND token_hash = $2
        ORDER BY created_at DESC LIMIT 1`,
      [eq.id, supplied],
    );
    if (tk.length) {
      if (tk[0].status !== 'active') {
        return res.status(403).json({ error: 'device token has been ' + tk[0].status, code: 'TOKEN_' + String(tk[0].status).toUpperCase() });
      }
      if (tk[0].expires_at && new Date(tk[0].expires_at) < new Date()) {
        return res.status(403).json({ error: 'device token has expired', code: 'TOKEN_EXPIRED' });
      }
      pool.query(`UPDATE iot_device_tokens SET last_used_at = NOW() WHERE id = $1`, [tk[0].id])
        .catch(() => { /* last_used_at is diagnostic; never fail ingest on it */ });
    }

    req.device = {
      equipment_id: eq.id,
      company_id: eq.company_id,
      equipment_name: eq.equipment_name,
      sampling_secs: eq.sampling_secs,
      capabilities: eq.capabilities || null,
      gateway_id: eq.gateway_id ?? null,
    };
    next();
  } catch (e) {
    console.error('[iot ingest] auth error:', e.message);
    res.status(500).json({ error: 'authentication failed' });
  }
}

/**
 * Per-device rate limiting.
 *
 * The global limiter keys on req.ip at 300/min. Several gateways at one customer
 * site share one public IP, so one chatty gateway could exhaust the budget for
 * every other device behind the same NAT — and conversely a single device could
 * flood freely from its own IP. Keying on the authenticated device identity is
 * what actually bounds a device; the IP limiter stays underneath as a backstop
 * against unauthenticated floods.
 */
const deviceLimiter = memoryRateLimit({
  windowMs: parseInt(process.env.IOT_DEVICE_RL_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.IOT_DEVICE_RL_MAX || '120', 10),
  bucket: 'iot_device',
  key: (req) => `dev:${req.device?.equipment_id ?? req.body?.device_uid ?? req.ip}`,
});

/** Classify event time against the skew policy. */
function classifyTime(eventTs, receivedAt) {
  const ageSecs = (receivedAt - eventTs) / 1000;
  if (ageSecs < -MAX_FUTURE_SKEW_SECS) {
    return { accept: false, reason: 'FUTURE_TIMESTAMP', detail: `event_ts is ${Math.round(-ageSecs)}s ahead of server time (max ${MAX_FUTURE_SKEW_SECS}s)` };
  }
  if (ageSecs > MAX_AGE_DAYS * 86400) {
    return { accept: false, reason: 'TOO_OLD', detail: `event_ts is ${Math.round(ageSecs / 86400)} days old (max ${MAX_AGE_DAYS})` };
  }
  if (ageSecs > REPLAY_AFTER_SECS) {
    return { accept: true, replay: true };
  }
  return { accept: true, replay: false };
}

// ── POST /iot/ingest ──────────────────────────────────────────────────────────
router.post('/ingest', deviceAuth, deviceLimiter, async (req, res) => {
  const { equipment_id, company_id, capabilities, equipment_name } = req.device;
  const gatewayUid = req.body?.gateway_uid ? String(req.body.gateway_uid).slice(0, 120) : null;
  const samples = Array.isArray(req.body?.samples) ? req.body.samples : null;

  if (!samples || samples.length === 0) {
    return res.status(400).json({ error: 'samples must be a non-empty array' });
  }
  if (samples.length > MAX_BATCH) {
    return res.status(413).json({ error: `batch too large (max ${MAX_BATCH} samples)` });
  }

  // batch_uid is how a retry is recognised. A gateway that does not send one gets
  // a generated id, which means ITS retries cannot be deduplicated at batch level
  // — the per-sample unique index still protects the data, and the response says
  // so rather than pretending the batch was idempotent.
  const suppliedBatchUid = req.body?.batch_uid ? String(req.body.batch_uid).slice(0, 80) : null;
  const batchUid = suppliedBatchUid || `auto-${crypto.randomUUID()}`;

  const receivedAt = new Date();

  // ── replay check, before any work ──────────────────────────────────────────
  if (suppliedBatchUid) {
    const { rows: prior } = await pool.query(
      `SELECT response FROM iot_ingest_batches WHERE equipment_id = $1 AND batch_uid = $2`,
      [equipment_id, batchUid],
    );
    if (prior.length) {
      // The batch already committed. Return what we returned the first time, so
      // the gateway can drop it from its spool exactly as if the original
      // response had arrived.
      return res.json({ ...(prior[0].response || {}), replayed: true });
    }
  }

  // ── validate + classify every sample (no DB writes yet) ────────────────────
  const clean = [];
  const rejected = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] || {};
    const metric = typeof s.metric === 'string' ? s.metric.trim().slice(0, 40) : '';
    const sampleUid = s.sample_uid ? String(s.sample_uid).slice(0, 80) : `${batchUid}:${i}`;
    const seqNo = Number.isFinite(Number(s.seq_no)) ? Number(s.seq_no) : null;
    const rawTs = s.event_ts || s.ts;
    const eventTs = rawTs ? new Date(rawTs) : new Date(receivedAt);

    if (!metric) {
      rejected.push({ sampleUid, metric: null, raw: s.value, eventTs: null, reason: 'NO_METRIC', detail: 'sample has no metric' });
      continue;
    }
    if (Number.isNaN(eventTs.getTime())) {
      rejected.push({ sampleUid, metric, raw: s.value, eventTs: null, reason: 'BAD_TIMESTAMP', detail: `unparseable event_ts '${rawTs}'` });
      continue;
    }

    const time = classifyTime(eventTs, receivedAt);
    if (!time.accept) {
      rejected.push({ sampleUid, metric, raw: s.value, eventTs, reason: time.reason, detail: time.detail });
      continue;
    }

    const check = await validateReading(company_id, metric, s.value, { capabilities });
    if (!check.ok) {
      rejected.push({ sampleUid, metric, raw: s.value, eventTs, reason: check.reason, detail: check.detail });
      continue;
    }

    let quality = normaliseQuality(s.quality);
    if (time.replay && quality === QUALITY.VALID) quality = QUALITY.REPLAY;
    if (!isStorable(quality)) {
      rejected.push({ sampleUid, metric, raw: s.value, eventTs, reason: 'QUALITY_' + quality, detail: `quality ${quality} is not storable` });
      continue;
    }

    clean.push({
      metric: check.def.metric_code,
      value: check.value,
      eventTs: eventTs.toISOString(),
      quality,
      sampleUid,
      seqNo,
      unit: check.def.unit,
      isReplay: !!time.replay,
    });
  }

  if (!clean.length) {
    // Everything was rejected. Quarantine and answer 422 — a 200 here is how a
    // gateway learns to believe bad data was accepted.
    await quarantine(pool, { company_id, equipment_id, gatewayUid, batchUid, rejected });
    return res.status(422).json({
      ok: false, accepted: 0, duplicates: 0, rejected: rejected.length,
      reasons: summarise(rejected),
      message: 'no sample in this batch passed validation',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. raw samples. ON CONFLICT DO NOTHING against the sample identity is what
    //    makes a retry a no-op at the database level.
    const cols = [];
    const vals = [];
    clean.forEach((s, i) => {
      const b = i * 12;
      cols.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12})`);
      vals.push(
        company_id, equipment_id, s.eventTs, s.metric, s.value,
        s.quality === QUALITY.VALID ? 0 : 1,      // legacy numeric column, kept in step
        receivedAt.toISOString(), s.sampleUid, batchUid, s.seqNo, s.quality, s.unit,
      );
    });
    const ins = await client.query(
      `INSERT INTO device_telemetry
         (company_id, equipment_id, ts, metric, value, quality,
          received_at, sample_uid, batch_uid, seq_no, quality_code, unit)
       VALUES ${cols.join(',')}
       ON CONFLICT (equipment_id, sample_uid, ts) DO NOTHING
       RETURNING sample_uid`,
      vals,
    );
    const insertedUids = new Set(ins.rows.map((r) => r.sample_uid));
    const accepted = ins.rowCount;
    const duplicates = clean.length - accepted;

    // Only genuinely new, current-state-eligible samples go further. A duplicate
    // must not re-fire an alert, and a REPLAY must not rewrite "now".
    const fresh = clean.filter((s) => insertedUids.has(s.sampleUid));
    const currentEligible = fresh.filter((s) => !s.isReplay && drivesCurrentState(s.quality));

    // 2. latest-value cache — newest event time wins, so a late packet cannot
    //    overwrite a newer reading (the WHERE on the DO UPDATE is the guard).
    const latest = new Map();
    for (const s of currentEligible) {
      const prev = latest.get(s.metric);
      if (!prev || s.eventTs > prev.eventTs) latest.set(s.metric, s);
    }
    for (const s of latest.values()) {
      await client.query(
        `INSERT INTO device_latest (equipment_id, company_id, metric, ts, value, quality, received_at, quality_code, unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (equipment_id, metric) DO UPDATE
           SET ts = EXCLUDED.ts, value = EXCLUDED.value, quality = EXCLUDED.quality,
               received_at = EXCLUDED.received_at, quality_code = EXCLUDED.quality_code,
               unit = EXCLUDED.unit
         WHERE device_latest.ts < EXCLUDED.ts`,
        [equipment_id, company_id, s.metric, s.eventTs, s.value,
         s.quality === QUALITY.VALID ? 0 : 1, receivedAt.toISOString(), s.quality, s.unit],
      );
    }

    // 3. liveness — driven by RECEIPT, not by the event stamp the device chose.
    if (currentEligible.length) {
      const newestEvent = currentEligible.reduce((m, s) => (s.eventTs > m ? s.eventTs : m), currentEligible[0].eventTs);
      // Read the prior state first: the ONLINE event must only be recorded on an
      // actual transition, or a device reporting every 60 s writes 1,440 "came
      // online" events a day and MTBF becomes meaningless.
      const { rows: before } = await client.query(
        `SELECT connection_state FROM customer_equipment WHERE id = $1 FOR UPDATE`,
        [equipment_id],
      );
      const prior = before[0]?.connection_state ?? null;
      await client.query(
        `UPDATE customer_equipment
            SET last_seen_at  = GREATEST(COALESCE(last_seen_at, $2::timestamptz), $2::timestamptz),
                last_event_ts = GREATEST(COALESCE(last_event_ts, $3::timestamptz), $3::timestamptz),
                last_success_at = $2::timestamptz,
                connection_state = 'online'
          WHERE id = $1`,
        [equipment_id, receivedAt.toISOString(), newestEvent],
      );
      if (prior && prior !== 'online') {
        await recordEvent(client, {
          companyId: company_id, equipmentId: equipment_id, eventType: 'ONLINE',
          occurredAt: receivedAt.toISOString(), source: 'ingest',
          detail: { from: prior },
        });
      }
    }

    // 4. alerts — the FULL event window, in event order, not just the last sample.
    const alertResult = await evaluateWindow(
      client,
      { equipmentId: equipment_id, companyId: company_id, equipment: { equipment_name } },
      fresh.filter((s) => !s.isReplay),
    );

    // 5. batch ledger, so a retry of this exact batch replays the response.
    const response = {
      ok: true,
      batch_uid: batchUid,
      accepted,
      duplicates,
      rejected: rejected.length,
      alerts_opened: alertResult.opened.length,
      alerts_resolved: alertResult.resolved.length,
      suppressed: alertResult.suppressed,
      idempotent: !!suppliedBatchUid,
      reasons: rejected.length ? summarise(rejected) : undefined,
    };
    await client.query(
      `INSERT INTO iot_ingest_batches
         (company_id, equipment_id, gateway_uid, batch_uid, received_at, sample_count, accepted, duplicates, rejected, response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (equipment_id, batch_uid) DO NOTHING`,
      [company_id, equipment_id, gatewayUid, batchUid, receivedAt.toISOString(),
       samples.length, accepted, duplicates, rejected.length, JSON.stringify(response)],
    );

    await client.query('COMMIT');

    // Quarantine AFTER the commit: a rejected sample is diagnostic, and a failure
    // to record it must not cost us the good samples in the same batch.
    if (rejected.length) {
      quarantine(pool, { company_id, equipment_id, gatewayUid, batchUid, rejected })
        .catch((e) => console.warn('[iot ingest] quarantine write failed:', e.message));
    }

    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'INFO', event: 'iot_ingest',
      company_id, equipment_id, gateway_uid: gatewayUid, batch_uid: batchUid,
      accepted, duplicates, rejected: rejected.length,
      alerts_opened: alertResult.opened.length, alerts_resolved: alertResult.resolved.length,
    }));

    res.json(response);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'ERROR', event: 'iot_ingest_failed',
      company_id, equipment_id, batch_uid: batchUid, message: e.message,
    }));
    // 5xx so the gateway RETRIES. The batch ledger makes that retry safe.
    res.status(500).json({ error: 'ingest failed', batch_uid: batchUid, retryable: true });
  } finally {
    client.release();
  }
});

function summarise(rejected) {
  const by = {};
  for (const r of rejected) by[r.reason] = (by[r.reason] || 0) + 1;
  return by;
}

/**
 * Quarantine rejected samples so a bad configuration is visible instead of
 * silently thinning the series. Capped at 1,000 rows per batch: a gateway sending
 * 5,000 bad samples has one problem, not five thousand, and the reason summary in
 * the response carries the full count.
 */
async function quarantine(db, { company_id, equipment_id, gatewayUid, batchUid, rejected }) {
  if (!rejected.length) return;
  const slice = rejected.slice(0, 1000);
  const cols = [], vals = [];
  slice.forEach((r, i) => {
    const b = i * 10;
    cols.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`);
    vals.push(
      company_id, equipment_id, gatewayUid, batchUid, r.sampleUid,
      r.metric == null ? null : String(r.metric).slice(0, 40),
      r.raw == null ? null : String(r.raw).slice(0, 200),
      r.eventTs ? new Date(r.eventTs).toISOString() : null,
      String(r.reason).slice(0, 40),
      String(r.detail || '').slice(0, 1000),
    );
  });
  await db.query(
    `INSERT INTO iot_rejected_samples
       (company_id, equipment_id, gateway_uid, batch_uid, sample_uid, metric, raw_value, event_ts, reason, detail)
     VALUES ${cols.join(',')}`,
    vals,
  );
}

// ── POST /iot/gateway/heartbeat ───────────────────────────────────────────────
// The gateway reports its own health so an operator can tell an equipment problem
// from a gateway problem from a network problem. Authenticated with the same
// device token, because the gateway already holds one.
router.post('/gateway/heartbeat', deviceAuth, async (req, res) => {
  try {
    const { company_id, equipment_id } = req.device;
    const b = req.body || {};
    const gatewayUid = b.gateway_uid ? String(b.gateway_uid).slice(0, 120) : null;
    if (!gatewayUid) return res.status(400).json({ error: 'gateway_uid is required' });

    const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
    const { rows } = await pool.query(
      `INSERT INTO iot_gateways
         (company_id, gateway_uid, name, site_location, version, status, last_heartbeat_at,
          queue_depth, oldest_queued_ts, spool_bytes, disk_free_bytes, device_count,
          error_count, dead_letter_count, retry_count, poll_secs)
       VALUES ($1,$2,$3,$4,$5,'online',NOW(),$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (gateway_uid) DO UPDATE
         SET last_heartbeat_at = NOW(), status = 'online',
             version = COALESCE(EXCLUDED.version, iot_gateways.version),
             name = COALESCE(EXCLUDED.name, iot_gateways.name),
             site_location = COALESCE(EXCLUDED.site_location, iot_gateways.site_location),
             queue_depth = EXCLUDED.queue_depth,
             oldest_queued_ts = EXCLUDED.oldest_queued_ts,
             spool_bytes = EXCLUDED.spool_bytes,
             disk_free_bytes = EXCLUDED.disk_free_bytes,
             device_count = EXCLUDED.device_count,
             error_count = EXCLUDED.error_count,
             dead_letter_count = EXCLUDED.dead_letter_count,
             retry_count = EXCLUDED.retry_count,
             poll_secs = EXCLUDED.poll_secs,
             updated_at = NOW()
       RETURNING id`,
      [company_id, gatewayUid, b.name ?? null, b.site_location ?? null, b.version ?? null,
       num(b.queue_depth), b.oldest_queued_ts ? new Date(b.oldest_queued_ts).toISOString() : null,
       num(b.spool_bytes), b.disk_free_bytes == null ? null : num(b.disk_free_bytes),
       num(b.device_count), num(b.error_count), num(b.dead_letter_count), num(b.retry_count),
       b.poll_secs == null ? null : num(b.poll_secs)],
    );

    // Link the device to its gateway, and record the polling interval the gateway
    // is ACTUALLY using — which is the half of the sampling story the application
    // never had (it knew only what it had configured).
    await pool.query(
      `UPDATE customer_equipment
          SET gateway_id = $2,
              actual_sampling_secs = COALESCE($3, actual_sampling_secs),
              last_poll_at = NOW()
        WHERE id = $1`,
      [equipment_id, rows[0].id, b.poll_secs == null ? null : num(b.poll_secs)],
    );

    res.json({ ok: true, gateway_id: rows[0].id });
  } catch (e) {
    console.error('[iot heartbeat]', e.message);
    res.status(500).json({ error: 'heartbeat failed' });
  }
});

export default router;
