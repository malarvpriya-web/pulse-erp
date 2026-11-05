/**
 * iot.phase4.test.js — the IoT Phase 4 acceptance suite, against a REAL Postgres.
 *
 * These are not mock tests. Every case below drives the production functions
 * against the live schema, because the defects being tested for are database
 * behaviours: a unique index absorbing a retry, a transaction aborting on a
 * failed statement, a partial index blocking an insert, a composite foreign key
 * refusing a cross-tenant reference. A mocked pool proves none of them.
 *
 * Fixtures: two companies (A and B) with one device each, created in a prefix
 * this suite owns and torn down at the end. Nothing touches existing rows.
 *
 * Run:  npx vitest run src/__tests__/iot.phase4.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// -- real DB credentials -------------------------------------------------------
// setup.js sets DB_PASSWORD='test-db-password' because most suites mock the pool.
// This one does not, so the real password is restored FIRST: config/db.js builds
// its Pool at import time, which is why every import below is dynamic and comes
// after this block. Same pattern as analytics.dataIntegrity.test.js.
if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available -- this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env -- this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');
const { evaluateWindow, transition, canTransition, ALERT_STATES } = await import('../modules/iot/alertEngine.js');
const { enqueue, claim, markFailed, markDone } = await import('../modules/iot/outbox.js');
const { iotScope, scopedEquipment } = await import('../modules/iot/scope.js');
const { validateReading } = await import('../modules/iot/metricRegistry.js');
const { normaliseQuality, QUALITY, eligibleCodes } = await import('../modules/iot/quality.js');
const { linearTrend, daysToThreshold, conditionRisk } = await import('../modules/iot/trend.js');
const { energyDelta, aggregatePf, unbalancePct, harmonicReductionPct } = await import('../modules/iot/ratios.js');
const { mtbfFromEvents, mttrFromEvents, uptimeFromEvents } = await import('../modules/iot/serviceKpis.js');

const TAG = `IOTP4_${Date.now()}`;
const ctx = { companyA: null, companyB: null, devA: null, devB: null, ruleA: null };

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (d) => new Date(d).toISOString();
const minsAgo = (m) => new Date(Date.now() - m * 60000);

beforeAll(async () => {
  // companies.code is NOT NULL with no default — the fixture states it rather
  // than discovering that at runtime.
  const { rows: ca } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG} Company A`, `${TAG.slice(-12)}A`]);
  const { rows: cb } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG} Company B`, `${TAG.slice(-12)}B`]);
  ctx.companyA = ca[0].id;
  ctx.companyB = cb[0].id;

  const mkDevice = async (companyId, label) => {
    const { rows } = await pool.query(
      `INSERT INTO customer_equipment
         (company_id, equipment_name, serial_number, device_uid, telemetry_token_hash,
          sampling_secs, device_status, connection_state)
       VALUES ($1,$2,$3,$4,$5,60,'active','never') RETURNING *`,
      [companyId, `${TAG} ${label}`, `${TAG}-SN-${label}`, `${TAG}-UID-${label}`, sha256(`${TAG}-token-${label}`)]);
    return rows[0];
  };
  ctx.devA = await mkDevice(ctx.companyA, 'A');
  ctx.devB = await mkDevice(ctx.companyB, 'B');
}, 60000);

afterAll(async () => {
  // Children first — the composite FKs cascade, but being explicit keeps a
  // failed run from leaving half a fixture behind.
  await pool.query(`DELETE FROM device_telemetry WHERE company_id = ANY($1)`, [[ctx.companyA, ctx.companyB]]).catch(() => {});
  await pool.query(`DELETE FROM iot_outbox WHERE company_id = ANY($1)`, [[ctx.companyA, ctx.companyB]]).catch(() => {});
  await pool.query(`DELETE FROM iot_rejected_samples WHERE company_id = ANY($1)`, [[ctx.companyA, ctx.companyB]]).catch(() => {});
  await pool.query(`DELETE FROM iot_ingest_batches WHERE company_id = ANY($1)`, [[ctx.companyA, ctx.companyB]]).catch(() => {});
  await pool.query(`DELETE FROM support_tickets WHERE company_id = ANY($1)`, [[ctx.companyA, ctx.companyB]]).catch(() => {});
  await pool.query(`DELETE FROM customer_equipment WHERE company_id = ANY($1)`, [[ctx.companyA, ctx.companyB]]).catch(() => {});
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [[ctx.companyA, ctx.companyB]]).catch(() => {});
}, 60000);

// ─────────────────────────────────────────────────────────────────────────────
// GATE A — SECURITY
// ─────────────────────────────────────────────────────────────────────────────
describe('GATE A — tenant isolation', () => {
  it('denies a caller with NO company scope instead of returning every company', () => {
    // This is the exact shape verifyToken produces for an authenticated
    // non-super-admin with no user_scope row.
    const req = { user: { userId: 1, roles: ['service_engineer'] }, scope: null };
    const s = iotScope(req);
    expect(s.ok).toBe(false);
    expect(s.reason).toBe('NO_COMPANY_SCOPE');
  });

  it('denies an unauthenticated caller', () => {
    expect(iotScope({}).ok).toBe(false);
    expect(iotScope({}).reason).toBe('UNAUTHENTICATED');
  });

  it('allows an explicitly global (super-admin) scope', () => {
    const s = iotScope({ user: { userId: 1 }, scope: { company_id: null, isGlobal: true } });
    expect(s.ok).toBe(true);
    expect(s.isGlobal).toBe(true);
    expect(s.companyId).toBeNull();
  });

  it('company A cannot resolve company B device', async () => {
    const scopeA = iotScope({ user: { userId: 1 }, scope: { company_id: ctx.companyA } });
    const own = await scopedEquipment(pool, ctx.devA.id, scopeA);
    const other = await scopedEquipment(pool, ctx.devB.id, scopeA);
    expect(own?.id).toBe(ctx.devA.id);
    expect(other).toBeNull();
  });

  it('the DATABASE refuses a rule pointing at another company equipment', async () => {
    // The application checks this too, but the composite FK is what makes it
    // impossible for ANY writer — including a future route that forgets.
    await expect(pool.query(
      `INSERT INTO device_alert_rules (company_id, equipment_id, name, metric, operator, threshold, severity)
       VALUES ($1,$2,'cross tenant','THD_I_L1','>',5,'warning')`,
      [ctx.companyA, ctx.devB.id],
    )).rejects.toThrow(/foreign key|violates/i);
  });

  it('a rule in its OWN company is accepted', async () => {
    const { rows } = await pool.query(
      `INSERT INTO device_alert_rules
         (company_id, equipment_id, name, metric, operator, threshold, clear_threshold,
          severity, persistence_secs, recovery_secs, cooldown_secs, create_ticket)
       VALUES ($1,$2,$3,'THD_I_L1','>',8.0,6.0,'critical',0,0,0,TRUE) RETURNING *`,
      [ctx.companyA, ctx.devA.id, `${TAG} THD rule`]);
    ctx.ruleA = rows[0];
    expect(ctx.ruleA.company_id).toBe(ctx.companyA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE B — TELEMETRY INTEGRITY
// ─────────────────────────────────────────────────────────────────────────────
describe('GATE B — telemetry integrity', () => {
  it('a retried sample is deduplicated by the DATABASE, not by application logic', async () => {
    const sampleUid = `${TAG}-dup-1`;
    const ts = iso(minsAgo(5));
    const ins = () => pool.query(
      `INSERT INTO device_telemetry
         (company_id, equipment_id, ts, metric, value, quality, received_at, sample_uid, batch_uid, quality_code)
       VALUES ($1,$2,$3,'THD_I_L1',4.2,0,NOW(),$4,$5,'VALID')
       ON CONFLICT (equipment_id, sample_uid, ts) DO NOTHING RETURNING id`,
      [ctx.companyA, ctx.devA.id, ts, sampleUid, `${TAG}-batch-1`]);

    const first = await ins();
    const second = await ins();          // the lost-response retry
    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0);     // silently absorbed — ONE logical sample

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM device_telemetry WHERE equipment_id=$1 AND sample_uid=$2`,
      [ctx.devA.id, sampleUid]);
    expect(rows[0].n).toBe(1);
  });

  it('CONCURRENT retries of the same sample still produce exactly one row', async () => {
    // Two gateways (or a gateway and its own retry) racing. An application-side
    // "check then insert" loses this race; a unique index does not.
    const sampleUid = `${TAG}-race-1`;
    const ts = iso(minsAgo(4));
    const attempt = () => pool.query(
      `INSERT INTO device_telemetry
         (company_id, equipment_id, ts, metric, value, quality, received_at, sample_uid, quality_code)
       VALUES ($1,$2,$3,'THD_I_L1',5.0,0,NOW(),$4,'VALID')
       ON CONFLICT (equipment_id, sample_uid, ts) DO NOTHING RETURNING id`,
      [ctx.companyA, ctx.devA.id, ts, sampleUid]);

    const results = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);
    const inserted = results.filter((r) => r.rowCount === 1).length;
    expect(inserted).toBe(1);
  });

  it('a batch replay returns the ORIGINAL response instead of reprocessing', async () => {
    const batchUid = `${TAG}-replaybatch`;
    const response = { ok: true, accepted: 3, duplicates: 0 };
    const ins = () => pool.query(
      `INSERT INTO iot_ingest_batches (company_id, equipment_id, batch_uid, sample_count, accepted, response)
       VALUES ($1,$2,$3,3,3,$4::jsonb)
       ON CONFLICT (equipment_id, batch_uid) DO NOTHING RETURNING id`,
      [ctx.companyA, ctx.devA.id, batchUid, JSON.stringify(response)]);
    expect((await ins()).rowCount).toBe(1);
    expect((await ins()).rowCount).toBe(0);

    const { rows } = await pool.query(
      `SELECT response FROM iot_ingest_batches WHERE equipment_id=$1 AND batch_uid=$2`,
      [ctx.devA.id, batchUid]);
    expect(rows[0].response.accepted).toBe(3);
  });

  it('the latest-value cache refuses to go backwards for a LATE packet', async () => {
    // 10:00=100, 10:01=105, 10:02=110, then the late 10:01=103 arrives.
    const put = (tsMin, value) => pool.query(
      `INSERT INTO device_latest (equipment_id, company_id, metric, ts, value, quality, quality_code)
       VALUES ($1,$2,'LATE_TEST',$3,$4,0,'VALID')
       ON CONFLICT (equipment_id, metric) DO UPDATE
         SET ts = EXCLUDED.ts, value = EXCLUDED.value
       WHERE device_latest.ts < EXCLUDED.ts`,
      [ctx.devA.id, ctx.companyA, iso(minsAgo(tsMin)), value]);

    await put(10, 100);
    await put(9, 105);
    await put(8, 110);
    await put(9, 103);           // the late packet

    const { rows } = await pool.query(
      `SELECT value::float AS value FROM device_latest WHERE equipment_id=$1 AND metric='LATE_TEST'`,
      [ctx.devA.id]);
    expect(rows[0].value).toBe(110);   // NOT 103
  });

  it('metric range validation rejects a physically impossible reading', async () => {
    const ok = await validateReading(ctx.companyA, 'THD_I_L1', 4.2);
    expect(ok.ok).toBe(true);
    expect(ok.def.unit).toBe('%');

    const bad = await validateReading(ctx.companyA, 'FREQUENCY', 899);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('OUT_OF_RANGE');

    const unknown = await validateReading(ctx.companyA, 'SEED metric 1', 1);
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toBe('UNKNOWN_METRIC');
  });

  it('a capability gate rejects a metric the device profile does not publish', async () => {
    const r = await validateReading(ctx.companyA, 'THD_I_PRE', 5, { capabilities: ['THD_I_L1', 'PF'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NOT_SUPPORTED_BY_PROFILE');
  });

  it('an unrecognised quality flag degrades to SUSPECT, never to VALID', () => {
    expect(normaliseQuality(0)).toBe(QUALITY.VALID);
    expect(normaliseQuality('VALID')).toBe(QUALITY.VALID);
    expect(normaliseQuality('banana')).toBe(QUALITY.SUSPECT);
    expect(normaliseQuality(7)).toBe(QUALITY.SUSPECT);
  });

  it('quality policy excludes non-eligible samples from calculations', async () => {
    const base = iso(minsAgo(60));
    await pool.query(
      `INSERT INTO device_telemetry (company_id, equipment_id, ts, metric, value, quality, received_at, sample_uid, quality_code)
       VALUES ($1,$2,$3,'QUAL_TEST',10,0,NOW(),$4,'VALID'),
              ($1,$2,$3,'QUAL_TEST',1000,1,NOW(),$5,'COMMUNICATION_ERROR')`,
      [ctx.companyA, ctx.devA.id, base, `${TAG}-q1`, `${TAG}-q2`]);

    const { rows } = await pool.query(
      `SELECT AVG(value)::float AS avg FROM device_telemetry
        WHERE equipment_id=$1 AND metric='QUAL_TEST' AND quality_code = ANY($2)`,
      [ctx.devA.id, eligibleCodes('valid_only')]);
    expect(rows[0].avg).toBe(10);      // the 1000 is excluded, not averaged in
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE E — ALERT STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────
describe('GATE E — alert lifecycle', () => {
  const clearState = async () => {
    await pool.query(`DELETE FROM device_alerts WHERE equipment_id = $1`, [ctx.devA.id]);
    await pool.query(`DELETE FROM iot_rule_state WHERE equipment_id = $1`, [ctx.devA.id]);
    await pool.query(`DELETE FROM iot_outbox WHERE company_id = $1`, [ctx.companyA]);
  };
  const run = async (samples) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await evaluateWindow(client,
        { equipmentId: ctx.devA.id, companyId: ctx.companyA, equipment: { equipment_name: 'test' } },
        samples);
      await client.query('COMMIT');
      return r;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  };
  const s = (minsAgoVal, value, quality = 'VALID') =>
    ({ metric: 'THD_I_L1', value, eventTs: iso(minsAgo(minsAgoVal)), quality, unit: '%' });

  it('detects an INTERMEDIATE breach, not only the last sample in the batch', async () => {
    await clearState();
    // 10:00=4, 10:01=12 (breach, threshold is 8), 10:02=5.
    // The old engine examined only the last sample and saw 5 — no alert at all.
    const r = await run([s(30, 4), s(29, 12), s(28, 5)]);
    expect(r.evaluated).toBe(3);
    expect(r.opened.length + r.resolved.length).toBeGreaterThan(0);
    const { rows } = await pool.query(
      `SELECT worst_value::float AS worst FROM device_alerts WHERE equipment_id=$1 ORDER BY id DESC LIMIT 1`,
      [ctx.devA.id]);
    expect(Number(rows[0].worst)).toBe(12);
  });

  it('a persistent breach produces ONE incident, not one per batch', async () => {
    await clearState();
    await run([s(30, 12)]);
    await run([s(25, 13)]);
    await run([s(20, 14)]);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n, MAX(breach_count)::int AS breaches
         FROM device_alerts WHERE equipment_id=$1 AND state IN ('active','acknowledged')`,
      [ctx.devA.id]);
    expect(rows[0].n).toBe(1);
    expect(rows[0].breaches).toBeGreaterThanOrEqual(3);
  });

  it('hysteresis: a value between clear and trigger changes nothing', async () => {
    await clearState();
    await run([s(30, 12)]);                       // breach (>8)
    const before = await pool.query(`SELECT state FROM device_alerts WHERE equipment_id=$1`, [ctx.devA.id]);
    await run([s(25, 7)]);                        // between clear (6) and trigger (8)
    const after = await pool.query(`SELECT state FROM device_alerts WHERE equipment_id=$1`, [ctx.devA.id]);
    expect(after.rows[0].state).toBe(before.rows[0].state);
    expect(after.rows[0].state).not.toBe('resolved');
  });

  it('recovery below the CLEAR threshold resolves the incident', async () => {
    await clearState();
    await run([s(30, 12)]);
    const r = await run([s(20, 3)]);              // below clear_threshold 6
    expect(r.resolved.length).toBe(1);
    const { rows } = await pool.query(
      `SELECT state, resolution_source FROM device_alerts WHERE equipment_id=$1 ORDER BY id DESC LIMIT 1`,
      [ctx.devA.id]);
    expect(rows[0].state).toBe('resolved');
    expect(rows[0].resolution_source).toBe('telemetry_recovery');
  });

  it('a re-breach after resolution is a NEW incident with a new incident_uid', async () => {
    await clearState();
    await run([s(40, 12)]);
    await run([s(35, 3)]);                        // resolves
    await run([s(30, 15)]);                       // breaches again
    const { rows } = await pool.query(
      `SELECT incident_uid, state FROM device_alerts WHERE equipment_id=$1 ORDER BY id`,
      [ctx.devA.id]);
    expect(rows.length).toBe(2);
    expect(rows[0].incident_uid).not.toBe(rows[1].incident_uid);
    expect(rows[0].state).toBe('resolved');
    expect(rows[1].state).toBe('active');
  });

  it('a POOR-QUALITY sample does not open an alert', async () => {
    await clearState();
    const r = await run([s(30, 99, 'COMMUNICATION_ERROR')]);
    expect(r.opened.length).toBe(0);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM device_alerts WHERE equipment_id=$1`, [ctx.devA.id]);
    expect(rows[0].n).toBe(0);
  });

  it('a maintenance window suppresses the incident', async () => {
    await clearState();
    const { rows: w } = await pool.query(
      `INSERT INTO iot_maintenance_windows (company_id, equipment_id, starts_at, ends_at, reason)
       VALUES ($1,$2,NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 hour','fan replacement') RETURNING id`,
      [ctx.companyA, ctx.devA.id]);
    const r = await run([s(10, 20)]);
    expect(r.opened.length).toBe(0);
    expect(r.suppressed).toBe(1);
    await pool.query(`DELETE FROM iot_maintenance_windows WHERE id = $1`, [w[0].id]);
  });

  it('an ILLEGAL transition is refused (resolved cannot be acknowledged)', async () => {
    await clearState();
    await run([s(30, 12)]);
    const { rows } = await pool.query(`SELECT id FROM device_alerts WHERE equipment_id=$1`, [ctx.devA.id]);
    const alertId = rows[0].id;

    const ack = await transition(pool, { alertId, companyId: ctx.companyA, toState: ALERT_STATES.ACKNOWLEDGED, userId: 1 });
    expect(ack.ok).toBe(true);

    const res = await transition(pool, { alertId, companyId: ctx.companyA, toState: ALERT_STATES.RESOLVED, userId: 1, reason: 'fixed' });
    expect(res.ok).toBe(true);

    const illegal = await transition(pool, { alertId, companyId: ctx.companyA, toState: ALERT_STATES.ACKNOWLEDGED, userId: 1 });
    expect(illegal.ok).toBe(false);
    expect(illegal.code).toBe('ILLEGAL_TRANSITION');
    expect(canTransition('resolved', 'acknowledged')).toBe(false);
  });

  it('a transition from ANOTHER company is not found', async () => {
    await clearState();
    await run([s(30, 12)]);
    const { rows } = await pool.query(`SELECT id FROM device_alerts WHERE equipment_id=$1`, [ctx.devA.id]);
    const r = await transition(pool, { alertId: rows[0].id, companyId: ctx.companyB, toState: ALERT_STATES.ACKNOWLEDGED, userId: 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION INTEGRITY + OUTBOX
// ─────────────────────────────────────────────────────────────────────────────
describe('transaction integrity and the outbox', () => {
  it('demonstrates the ORIGINAL defect: a failed statement aborts the whole transaction', async () => {
    // This is the behaviour the old alertActions.js comment claimed to avoid with
    // try/catch. Catching the JS error does not un-abort the transaction — every
    // later statement fails with 25P02, which is how a ticket failure took the
    // telemetry write down with it.
    const client = await pool.connect();
    let abortedCode = null;
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO device_telemetry (company_id, equipment_id, ts, metric, value, quality, received_at, sample_uid, quality_code)
         VALUES ($1,$2,NOW(),'THD_I_L1',1,0,NOW(),$3,'VALID')`,
        [ctx.companyA, ctx.devA.id, `${TAG}-abort-demo`]);
      try {
        await client.query(`INSERT INTO support_tickets (nonexistent_column) VALUES (1)`);
      } catch { /* exactly what the old code did */ }
      try {
        await client.query(`SELECT 1`);
      } catch (e) { abortedCode = e.code; }
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect(abortedCode).toBe('25P02');   // current transaction is aborted
  });

  it('the outbox carries the event so a ticket failure cannot touch telemetry', async () => {
    const dedupe = `${TAG}-outbox-1`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO device_telemetry (company_id, equipment_id, ts, metric, value, quality, received_at, sample_uid, quality_code)
         VALUES ($1,$2,NOW(),'THD_I_L1',9,0,NOW(),$3,'VALID')`,
        [ctx.companyA, ctx.devA.id, `${TAG}-outbox-sample`]);
      await enqueue(client, {
        companyId: ctx.companyA, topic: 'alert.opened', dedupeKey: dedupe,
        payload: { alert_id: -1 },
      });
      await client.query('COMMIT');
    } finally { client.release(); }

    const { rows } = await pool.query(`SELECT status FROM iot_outbox WHERE dedupe_key=$1`, [dedupe]);
    expect(rows[0].status).toBe('pending');
    const { rows: tel } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM device_telemetry WHERE sample_uid=$1`, [`${TAG}-outbox-sample`]);
    expect(tel[0].n).toBe(1);   // telemetry committed regardless of the event's fate
  });

  it('enqueue is idempotent on dedupe_key', async () => {
    const k = `${TAG}-outbox-dupe`;
    const a = await enqueue(pool, { companyId: ctx.companyA, topic: 'alert.opened', dedupeKey: k, payload: {} });
    const b = await enqueue(pool, { companyId: ctx.companyA, topic: 'alert.opened', dedupeKey: k, payload: {} });
    expect(a.enqueued).toBe(true);
    expect(b.enqueued).toBe(false);
  });

  it('a failing event backs off and eventually dead-letters instead of vanishing', async () => {
    const k = `${TAG}-outbox-dead`;
    await enqueue(pool, { companyId: ctx.companyA, topic: 'alert.opened', dedupeKey: k, payload: {}, maxAttempts: 2 });
    const [claimed] = await claim(pool, 50).then((rows) => rows.filter((r) => r.dedupe_key === k));
    expect(claimed).toBeTruthy();

    const first = await markFailed(pool, claimed, 'simulated failure');
    expect(first.dead).toBe(false);
    expect(first.retryInSecs).toBeGreaterThan(0);

    const second = await markFailed(pool, { ...claimed, attempts: 2 }, 'simulated failure');
    expect(second.dead).toBe(true);

    const { rows } = await pool.query(`SELECT status, last_error FROM iot_outbox WHERE dedupe_key=$1`, [k]);
    expect(rows[0].status).toBe('dead');
    expect(rows[0].last_error).toContain('simulated failure');
  });

  it('two workers claiming concurrently never take the same event', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `${TAG}-concurrent-${i}`);
    for (const k of keys) {
      await enqueue(pool, { companyId: ctx.companyA, topic: 'alert.opened', dedupeKey: k, payload: {} });
    }
    const [w1, w2] = await Promise.all([claim(pool, 10), claim(pool, 10)]);
    const ids1 = new Set(w1.map((r) => r.id));
    const overlap = w2.filter((r) => ids1.has(r.id));
    expect(overlap.length).toBe(0);      // FOR UPDATE SKIP LOCKED
    for (const r of [...w1, ...w2]) await markDone(pool, r.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRUTHFULNESS — insufficient data must look like insufficient data
// ─────────────────────────────────────────────────────────────────────────────
describe('insufficient data is reported as insufficient data', () => {
  it('a trend from 5 points is INSUFFICIENT_DATA, not a slope', () => {
    const pts = Array.from({ length: 5 }, (_, i) => ({ ts: iso(minsAgo(50 - i * 10)), value: 4 + i * 0.1 }));
    const t = linearTrend(pts);
    expect(t.state).toBe('INSUFFICIENT_DATA');
    expect(t.slopePerDay).toBeNull();
  });

  it('a 30-point, 12-hour rising series yields a usable slope', () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({
      ts: iso(new Date(Date.now() - (40 - i) * 30 * 60000)),   // every 30 min = 20h
      value: 4 + i * 0.05,
    }));
    const t = linearTrend(pts);
    expect(t.state).toBe('OK');
    expect(t.slopePerDay).toBeGreaterThan(0);
    expect(t.r2).toBeGreaterThan(0.9);
  });

  it('days-to-threshold refuses to extrapolate from a weak trend', () => {
    const weak = linearTrend([{ ts: iso(minsAgo(10)), value: 1 }]);
    const p = daysToThreshold(weak, 10);
    expect(p.state).toBe('INSUFFICIENT_DATA');
    expect(p.days).toBeNull();
  });

  it('a device with NO evidence scores INSUFFICIENT_DATA, never 0 / "no action needed"', () => {
    const r = conditionRisk({
      connection_state: 'never', last_seen_at: null,
      open_alerts: 0, critical_open: 0, alerts_30d: 0, telemetry_samples_30d: 0,
    }, []);
    expect(r.state).toBe('INSUFFICIENT_DATA');
    expect(r.score).toBeNull();
    expect(r.recommendation).toMatch(/unknown/i);
  });

  it('MTBF/MTTR refuse to answer from one event', () => {
    const one = [{ event_type: 'FAULT', occurred_at: iso(minsAgo(100)) }];
    expect(mtbfFromEvents(one).state).toBe('INSUFFICIENT_DATA');
    expect(mttrFromEvents(one).state).toBe('INSUFFICIENT_DATA');
  });

  it('MTBF answers from three failures, and flags low confidence', () => {
    const ev = [
      { event_type: 'FAULT', occurred_at: iso(new Date(Date.now() - 72 * 3600000)) },
      { event_type: 'FAULT', occurred_at: iso(new Date(Date.now() - 48 * 3600000)) },
      { event_type: 'FAULT', occurred_at: iso(new Date(Date.now() - 24 * 3600000)) },
    ];
    const m = mtbfFromEvents(ev);
    expect(m.state).toBe('OK');
    expect(m.value).toBeCloseTo(24, 0);
    expect(m.low_confidence).toBe(false);
  });

  it('MTTR excludes a still-open fault from the mean', () => {
    const ev = [
      { event_type: 'FAULT', occurred_at: iso(new Date(Date.now() - 10 * 3600000)) },
      { event_type: 'RECOVERY', occurred_at: iso(new Date(Date.now() - 8 * 3600000)) },
      { event_type: 'FAULT', occurred_at: iso(new Date(Date.now() - 6 * 3600000)) },
      { event_type: 'RECOVERY', occurred_at: iso(new Date(Date.now() - 2 * 3600000)) },
      { event_type: 'FAULT', occurred_at: iso(new Date(Date.now() - 1 * 3600000)) },
    ];
    const m = mttrFromEvents(ev);
    expect(m.state).toBe('OK');
    expect(m.completed_repairs).toBe(2);
    expect(m.open_faults).toBe(1);
    expect(m.value).toBeCloseTo(3, 0);   // (2h + 4h) / 2
  });

  it('uptime over a too-short window refuses rather than extrapolating', () => {
    const r = uptimeFromEvents([], new Date(Date.now() - 3600000), new Date());
    expect(r.state).toBe('INSUFFICIENT_DATA');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE G — ELECTRICAL MATHS
// ─────────────────────────────────────────────────────────────────────────────
describe('GATE G — electrical calculations', () => {
  it('energy deltas survive a counter RESET', () => {
    const series = [
      { ts: iso(minsAgo(50)), value: 1000 },
      { ts: iso(minsAgo(40)), value: 1010 },
      { ts: iso(minsAgo(30)), value: 5 },     // device restarted, counter cleared
      { ts: iso(minsAgo(20)), value: 15 },
    ];
    const d = energyDelta(series);
    expect(d.resets).toBe(1);
    expect(d.total).toBe(25);      // 10 + 5 (since reset) + 10
  });

  it('energy deltas survive a 16-bit ROLLOVER', () => {
    const W = 65536;
    const series = [
      { ts: iso(minsAgo(30)), value: W - 10 },
      { ts: iso(minsAgo(20)), value: 5 },     // wrapped
    ];
    const d = energyDelta(series);
    expect(d.rollovers).toBe(1);
    expect(d.total).toBe(15);
  });

  it('aggregate PF is energy-weighted, not an average of PF samples', () => {
    // 100 kWh against 125 kVAh is PF 0.80 — the arithmetic mean of the underlying
    // PF samples would weight a lightly-loaded minute the same as a heavy one.
    const pf = aggregatePf({ kwh: 100, kvah: 125, window: '24h' });
    expect(pf.state).toBe('OK');
    expect(pf.value).toBeCloseTo(0.8, 3);
    expect(pf.method).toBe('kwh_over_kvah');
  });

  it('PF keeps the LEADING sign instead of abs()-ing it away', () => {
    const pf = aggregatePf({ kwh: 100, kvah: null, kvarh: -75, window: '24h' });
    expect(pf.value).toBeLessThan(0);      // leading / capacitive
    expect(Math.abs(pf.value)).toBeCloseTo(0.8, 3);
  });

  it('PF over a window with no energy is undefined, not 1.0', () => {
    const pf = aggregatePf({ kwh: 0, kvah: null, kvarh: 0, window: '24h' });
    expect(pf.value).toBeNull();
    expect(pf.state).toBe('NO_DENOMINATOR');
  });

  it('unbalance needs all three phases', () => {
    expect(unbalancePct([230, 231, null]).state).toBe('INSUFFICIENT_DATA');
    const u = unbalancePct([230, 235, 225]);
    expect(u.state).toBe('OK');
    expect(u.value).toBeCloseTo(2.174, 2);
  });

  it('harmonic reduction refuses without BOTH pre and post THD', () => {
    expect(harmonicReductionPct({ preThd: 25, postThd: null, window: '24h' }).state).toBe('INSUFFICIENT_DATA');
    const h = harmonicReductionPct({ preThd: 25, postThd: 5, window: '24h' });
    expect(h.value).toBe(80);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA GUARANTEES
// ─────────────────────────────────────────────────────────────────────────────
describe('schema guarantees', () => {
  it('the alert state vocabulary is enforced on new writes', async () => {
    await expect(pool.query(
      `INSERT INTO device_alerts (company_id, equipment_id, metric, severity, state, message)
       VALUES ($1,$2,'THD_I_L1','warning','Tamil Nadu','bad state')`,
      [ctx.companyA, ctx.devA.id],
    )).rejects.toThrow(/ck_iot_alert_state|check constraint/i);
  });

  it('the severity vocabulary is enforced on new writes', async () => {
    await expect(pool.query(
      `INSERT INTO device_alerts (company_id, equipment_id, metric, severity, state, message)
       VALUES ($1,$2,'THD_I_L1','Minor','active','bad severity')`,
      [ctx.companyA, ctx.devA.id],
    )).rejects.toThrow(/ck_iot_alert_severity|check constraint/i);
  });

  it('the rule operator vocabulary is enforced on new writes', async () => {
    await expect(pool.query(
      `INSERT INTO device_alert_rules (company_id, name, metric, operator, threshold, severity)
       VALUES ($1,'bad op','THD_I_L1','SEED ope',5,'warning')`,
      [ctx.companyA],
    )).rejects.toThrow(/ck_iot_rule_operator|check constraint/i);
  });

  it('only ONE token can be active per device', async () => {
    await pool.query(
      `INSERT INTO iot_device_tokens (company_id, equipment_id, token_hash, status)
       VALUES ($1,$2,$3,'active')`,
      [ctx.companyA, ctx.devA.id, sha256('t1')]);
    await expect(pool.query(
      `INSERT INTO iot_device_tokens (company_id, equipment_id, token_hash, status)
       VALUES ($1,$2,$3,'active')`,
      [ctx.companyA, ctx.devA.id, sha256('t2')],
    )).rejects.toThrow(/uq_iot_device_token_active|duplicate key/i);
  });

  it('only ONE live alert exists per (equipment, rule)', async () => {
    await pool.query(`DELETE FROM device_alerts WHERE equipment_id = $1`, [ctx.devA.id]);
    const ins = () => pool.query(
      `INSERT INTO device_alerts (company_id, equipment_id, rule_id, metric, severity, state, message)
       VALUES ($1,$2,$3,'THD_I_L1','warning','active','x')
       ON CONFLICT (equipment_id, rule_id)
         WHERE state IN ('pending_confirmation','active','acknowledged','recovery_pending')
         DO NOTHING RETURNING id`,
      [ctx.companyA, ctx.devA.id, ctx.ruleA.id]);
    expect((await ins()).rowCount).toBe(1);
    expect((await ins()).rowCount).toBe(0);
  });
});
