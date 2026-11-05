/**
 * iot.ingest.e2e.test.js — the ingest and fleet routes over real HTTP, against a
 * real Postgres.
 *
 * iot.phase4.test.js proves the MODULES. This suite proves the ROUTES: the same
 * request a gateway actually sends, through deviceAuth, the skew policy, the
 * metric registry, the transaction and the alert engine, answered by the same
 * handler production runs. The distinction matters because several of the
 * original defects lived in the handler rather than in any function it called —
 * the null-scope fail-open, the reliance on the last sample of a batch, and the
 * ticket INSERT inside the telemetry transaction were all route-level.
 *
 * The §61 scenarios are executed here end to end:
 *   1 normal operation · 2 THD breach · 3 persistent breach · 4 recovery
 *   6 lost HTTP response · 7 bad timestamp · 8 bad quality · 9 cross-company
 *
 * Scenario 5 (gateway outage) is a gateway-side behaviour and is covered by
 * edge-gateway/__tests__/gateway.spool.test.mjs.
 *
 * Run:  npx vitest run src/__tests__/iot.ingest.e2e.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Real DB credentials — see the header of analytics.dataIntegrity.test.js.
if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

// The pre-auth limiter reads its ceiling at import time, and its production
// default (600/min) is deliberately too high to drive from a test. Lower it
// BEFORE ingest.routes.js is imported. Only FAILED requests count towards it, and
// 200 is far above the handful of deliberate 4xx cases elsewhere in this file, so
// no other case can trip it.
process.env.IOT_PREAUTH_RL_MAX = '200';

const { default: pool } = await import('../config/db.js');
const { default: ingestRoutes } = await import('../modules/iot/routes/ingest.routes.js');
const { default: devicesRoutes } = await import('../modules/iot/routes/devices.routes.js');
const { default: alertsRoutes } = await import('../modules/iot/routes/alerts.routes.js');
const { buildApp } = await import('./helpers/testApp.js');
const { drainOutbox } = await import('../jobs/iotOutbox.cron.js');

const TAG = `IOTE2E_${Date.now()}`;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (d) => new Date(d).toISOString();
const minsAgo = (m) => new Date(Date.now() - m * 60000);

const ctx = {};
let app;

/**
 * A stand-in for verifyToken that produces exactly the req.user / req.scope shape
 * the real middleware produces, including the null-scope case that used to read
 * as "every company".
 */
function fakeAuth(userId, scope) {
  return (req, _res, next) => { req.user = { userId, roles: ['admin'] }; req.scope = scope; next(); };
}
/** requirePermission consults the real permissions matrix, so use a real admin user. */
async function realAdminUserId() {
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE LOWER(r.code) IN ('admin','super_admin') AND u.is_active
      ORDER BY u.id LIMIT 1`);
  return rows[0]?.id ?? null;
}

beforeAll(async () => {
  const { rows: ca } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG} A`, `${TAG.slice(-12)}A`]);
  const { rows: cb } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG} B`, `${TAG.slice(-12)}B`]);
  ctx.companyA = ca[0].id;
  ctx.companyB = cb[0].id;

  ctx.tokenA = `${TAG}-rawtoken-A`;
  ctx.tokenB = `${TAG}-rawtoken-B`;

  // Attach the generic AHF profile so the capability gate is exercised.
  const { rows: prof } = await pool.query(
    `SELECT id, capabilities FROM iot_device_profiles WHERE profile_code = 'GENERIC_AHF' AND company_id IS NULL`);
  ctx.profileId = prof[0]?.id ?? null;

  const mk = async (companyId, label, token) => {
    const { rows } = await pool.query(
      `INSERT INTO customer_equipment
         (company_id, equipment_name, serial_number, device_uid, telemetry_token_hash,
          sampling_secs, device_status, connection_state, device_profile_id, rating)
       VALUES ($1,$2,$3,$4,$5,60,'active','never',$6,'100A') RETURNING *`,
      [companyId, `${TAG} AHF ${label}`, `${TAG}-SN-${label}`, `${TAG}-UID-${label}`, sha256(token), ctx.profileId]);
    await pool.query(
      `INSERT INTO iot_device_tokens (company_id, equipment_id, token_hash, token_prefix, status)
       VALUES ($1,$2,$3,$4,'active')`,
      [companyId, rows[0].id, sha256(token), token.slice(0, 8)]);
    return rows[0];
  };
  ctx.devA = await mk(ctx.companyA, 'A', ctx.tokenA);
  ctx.devB = await mk(ctx.companyB, 'B', ctx.tokenB);
  // Scenarios 2-4 get their OWN device. The alert state machine deliberately
  // refuses to let a sample older than one it has already evaluated advance the
  // machine (that is what stops a late straggler from "recovering" an incident
  // the newer data says is still breaching). Sharing device A with the earlier
  // scenarios, which post at assorted historical offsets, would mean the breach
  // scenario's samples were correctly ignored as stragglers. So the lifecycle
  // scenario runs on a clean device with strictly increasing event times, which
  // is also how a real gateway behaves.
  ctx.tokenC = `${TAG}-rawtoken-C`;
  ctx.devC = await mk(ctx.companyA, 'C', ctx.tokenC);

  // A critical THD rule with hysteresis: fires above 8, clears below 6.
  const { rows: rule } = await pool.query(
    `INSERT INTO device_alert_rules
       (company_id, equipment_id, name, metric, operator, threshold, clear_threshold,
        severity, persistence_secs, recovery_secs, cooldown_secs, create_ticket, notify_channels)
     VALUES ($1,$2,$3,'THD_I_L1','>',8.0,6.0,'critical',0,0,0,TRUE,'{in_app}') RETURNING *`,
    [ctx.companyA, ctx.devC.id, `${TAG} THD critical`]);
  ctx.rule = rule[0];

  ctx.adminId = await realAdminUserId();

  app = buildApp(
    ['/iot', ingestRoutes],
    ['/iot', fakeAuth(ctx.adminId, { company_id: ctx.companyA }), devicesRoutes],
    ['/iot', fakeAuth(ctx.adminId, { company_id: ctx.companyA }), alertsRoutes],
    // A second mount under a different prefix, with the scope shapes that used to
    // fail open, so the same handlers can be probed as those callers.
    ['/as-companyB', fakeAuth(ctx.adminId, { company_id: ctx.companyB }), devicesRoutes],
    ['/as-noscope', fakeAuth(ctx.adminId, null), devicesRoutes],
  );
}, 60000);

afterAll(async () => {
  const ids = [ctx.companyA, ctx.companyB];
  for (const t of ['device_telemetry', 'iot_outbox', 'iot_rejected_samples', 'iot_ingest_batches',
                   'iot_device_events', 'iot_notification_log', 'support_tickets', 'notifications']) {
    if (t === 'notifications') {
      await pool.query(`DELETE FROM notifications WHERE module_name = 'iot' AND created_at > NOW() - INTERVAL '10 minutes'`).catch(() => {});
      continue;
    }
    await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [ids]).catch(() => {});
  }
  await pool.query(`DELETE FROM customer_equipment WHERE company_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [ids]).catch(() => {});
}, 60000);

const post = (body, token = ctx.tokenA) =>
  request(app).post('/iot/ingest').set('X-Device-Token', token).send(body);

/**
 * A strictly increasing event clock for the lifecycle scenario. Real telemetry
 * moves forward; the engine is entitled to assume that, and a test that walks
 * backwards is testing something no gateway does.
 */
let clockMs = Date.now() - 15 * 60000;
const nextTs = (advanceSecs = 60) => { clockMs += advanceSecs * 1000; return iso(new Date(clockMs)); };

const sample = (over = {}) => ({
  sample_uid: `${TAG}-${crypto.randomUUID()}`,
  metric: 'THD_I_L1',
  value: 4.2,
  event_ts: iso(new Date()),
  quality: 'VALID',
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SCENARIO 1 — normal operation', () => {
  it('accepts a batch, updates the latest cache and marks the device online', async () => {
    const batchUid = `${TAG}-b1`;
    const res = await post({
      device_uid: ctx.devA.device_uid,
      gateway_uid: `${TAG}-GW`,
      batch_uid: batchUid,
      samples: [
        sample({ metric: 'THD_I_L1', value: 4.2, event_ts: iso(minsAgo(3)) }),
        sample({ metric: 'V_L1', value: 415, event_ts: iso(minsAgo(3)) }),
        sample({ metric: 'TEMPERATURE', value: 44, event_ts: iso(minsAgo(2)) }),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(3);
    expect(res.body.duplicates).toBe(0);
    expect(res.body.rejected).toBe(0);

    const { rows: eq } = await pool.query(
      `SELECT connection_state, last_seen_at, last_event_ts FROM customer_equipment WHERE id=$1`, [ctx.devA.id]);
    expect(eq[0].connection_state).toBe('online');
    expect(eq[0].last_seen_at).toBeTruthy();

    const { rows: latest } = await pool.query(
      `SELECT metric, value::float AS value, unit FROM device_latest WHERE equipment_id=$1 ORDER BY metric`, [ctx.devA.id]);
    expect(latest.length).toBe(3);
    // The unit comes from the metric registry, not from the gateway's opinion.
    expect(latest.find((r) => r.metric === 'V_L1').unit).toBe('V');
  });

  it('records an ONLINE device event on the transition only', async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM iot_device_events WHERE equipment_id=$1 AND event_type='ONLINE'`, [ctx.devA.id]);
    expect(rows[0].n).toBe(1);
    // A second batch must NOT write another ONLINE event — the device was
    // already online, and one event per poll would make MTBF meaningless.
    await post({ device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-b1b`, samples: [sample({ value: 4.4 })] });
    const { rows: after } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM iot_device_events WHERE equipment_id=$1 AND event_type='ONLINE'`, [ctx.devA.id]);
    expect(after[0].n).toBe(1);
  });
});

describe('SCENARIO 6 — lost HTTP response', () => {
  it('a replayed batch_uid returns the ORIGINAL response and stores nothing new', async () => {
    const batchUid = `${TAG}-lost`;
    const samples = [sample({ value: 5.1, event_ts: iso(minsAgo(10)) }), sample({ value: 5.2, event_ts: iso(minsAgo(10)) })];
    const body = { device_uid: ctx.devA.device_uid, batch_uid: batchUid, samples };

    const first = await post(body);
    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(2);
    expect(first.body.replayed).toBeUndefined();

    const { rows: before } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM device_telemetry WHERE batch_uid=$1`, [batchUid]);

    // The gateway never saw the response, so it sends the identical batch again.
    const retry = await post(body);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.accepted).toBe(2);   // the ORIGINAL count, not a new one

    const { rows: after } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM device_telemetry WHERE batch_uid=$1`, [batchUid]);
    expect(after[0].n).toBe(before[0].n);  // ONE logical sample each, not two
  });

  it('the same SAMPLES under a different batch_uid are still deduplicated', async () => {
    const shared = [sample({ value: 5.5, event_ts: iso(minsAgo(11)) })];
    const r1 = await post({ device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-x1`, samples: shared });
    const r2 = await post({ device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-x2`, samples: shared });
    expect(r1.body.accepted).toBe(1);
    expect(r2.body.accepted).toBe(0);      // absorbed by the sample-level index
    expect(r2.body.duplicates).toBe(1);
  });
});

describe('SCENARIO 7 — bad timestamps', () => {
  it('a FUTURE sample is rejected and cannot make the device look alive', async () => {
    const before = await pool.query(`SELECT last_seen_at FROM customer_equipment WHERE id=$1`, [ctx.devA.id]);
    const res = await post({
      device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-future`,
      samples: [sample({ value: 4.0, event_ts: iso(new Date(Date.now() + 86400000)) })],
    });
    expect(res.status).toBe(422);
    expect(res.body.reasons.FUTURE_TIMESTAMP).toBe(1);

    const after = await pool.query(`SELECT last_seen_at FROM customer_equipment WHERE id=$1`, [ctx.devA.id]);
    expect(new Date(after.rows[0].last_seen_at).getTime())
      .toBe(new Date(before.rows[0].last_seen_at).getTime());

    const { rows: q } = await pool.query(
      `SELECT reason FROM iot_rejected_samples WHERE batch_uid=$1`, [`${TAG}-future`]);
    expect(q[0].reason).toBe('FUTURE_TIMESTAMP');
  });

  it('a very OLD sample is accepted as history but does NOT update the latest value', async () => {
    // 3 days old: inside the 30-day acceptance window, far past the 1-hour replay
    // threshold. The original code would have written it straight into
    // device_latest and set connection_state='online'.
    const res = await post({
      device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-replay`,
      samples: [sample({ metric: 'V_L1', value: 300, event_ts: iso(new Date(Date.now() - 3 * 86400000)) })],
    });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);

    const { rows } = await pool.query(
      `SELECT quality_code FROM device_telemetry WHERE batch_uid=$1`, [`${TAG}-replay`]);
    expect(rows[0].quality_code).toBe('REPLAY');

    const { rows: latest } = await pool.query(
      `SELECT value::float AS value FROM device_latest WHERE equipment_id=$1 AND metric='V_L1'`, [ctx.devA.id]);
    expect(latest[0].value).toBe(415);   // the live reading, not the 3-day-old 300
  });

  it('a sample beyond the maximum age is rejected outright', async () => {
    const res = await post({
      device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-ancient`,
      samples: [sample({ value: 4, event_ts: '2000-01-01T00:00:00Z' })],
    });
    expect(res.status).toBe(422);
    expect(res.body.reasons.TOO_OLD).toBe(1);
  });
});

describe('SCENARIO 8 — bad values and bad quality', () => {
  it('an out-of-range value is quarantined, not stored as a measurement', async () => {
    const res = await post({
      device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-range`,
      samples: [sample({ metric: 'FREQUENCY', value: 899 })],
    });
    expect(res.status).toBe(422);
    expect(res.body.reasons.OUT_OF_RANGE).toBe(1);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM device_telemetry WHERE equipment_id=$1 AND metric='FREQUENCY'`, [ctx.devA.id]);
    expect(rows[0].n).toBe(0);
  });

  it('an undeclared metric is rejected rather than silently creating a new series', async () => {
    const res = await post({
      device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-unknown`,
      samples: [sample({ metric: 'SEED metric 1', value: 1 })],
    });
    expect(res.status).toBe(422);
    expect(res.body.reasons.UNKNOWN_METRIC).toBe(1);
  });

  it('a COMMUNICATION_ERROR sample is stored but excluded from the latest value', async () => {
    const res = await post({
      device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-commerr`,
      samples: [sample({ metric: 'TEMPERATURE', value: 999, quality: 'COMMUNICATION_ERROR' })],
    });
    // 999 exceeds TEMPERATURE's declared 150 degC ceiling, so the range check
    // catches it before the quality code is even consulted — which is the right
    // order: an impossible number is not a measurement whatever its flag says.
    expect(res.status).toBe(422);

    const ok = await post({
      device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-commerr2`,
      samples: [sample({ metric: 'TEMPERATURE', value: 120, quality: 'COMMUNICATION_ERROR', event_ts: iso(new Date()) })],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.accepted).toBe(1);
    const { rows } = await pool.query(
      `SELECT value::float AS value FROM device_latest WHERE equipment_id=$1 AND metric='TEMPERATURE'`, [ctx.devA.id]);
    expect(rows[0].value).toBe(44);      // the earlier VALID reading still stands
  });
});

describe('SCENARIOS 2-4 - breach, persistence, recovery, and the service ticket', () => {
  const postC = (body) => request(app).post('/iot/ingest').set('X-Device-Token', ctx.tokenC).send(body);

  it('2: an intermediate THD breach inside a batch opens a critical incident', async () => {
    // 4.0 -> 12.5 -> 7.0. The breach is the MIDDLE sample; the batch ends below
    // the threshold. The Phase-1 engine examined only the last sample, saw 7.0,
    // and raised nothing.
    const res = await postC({
      device_uid: ctx.devC.device_uid, batch_uid: `${TAG}-breach`,
      samples: [
        sample({ value: 4.0, event_ts: nextTs() }),
        sample({ value: 12.5, event_ts: nextTs() }),
        sample({ value: 7.0, event_ts: nextTs() }),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.alerts_opened).toBe(1);

    const { rows } = await pool.query(
      `SELECT state, severity, worst_value::float AS worst, threshold::float AS threshold, incident_uid
         FROM device_alerts WHERE equipment_id=$1 ORDER BY id DESC LIMIT 1`, [ctx.devC.id]);
    expect(rows[0].state).toBe('active');
    expect(rows[0].severity).toBe('critical');
    expect(rows[0].worst).toBe(12.5);
    expect(rows[0].threshold).toBe(8);
    ctx.incidentUid = rows[0].incident_uid;
  });

  it('3: a continuing breach extends the SAME incident and creates no second ticket', async () => {
    await postC({
      device_uid: ctx.devC.device_uid, batch_uid: `${TAG}-breach2`,
      samples: [sample({ value: 13.0, event_ts: nextTs() })],
    });
    await postC({
      device_uid: ctx.devC.device_uid, batch_uid: `${TAG}-breach3`,
      samples: [sample({ value: 14.0, event_ts: nextTs() })],
    });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n, MAX(breach_count)::int AS breaches FROM device_alerts
        WHERE equipment_id=$1 AND state IN ('active','acknowledged','recovery_pending')`, [ctx.devC.id]);
    expect(rows[0].n).toBe(1);
    expect(rows[0].breaches).toBeGreaterThanOrEqual(3);
  });

  it('the outbox worker creates exactly ONE service ticket for the incident', async () => {
    const first = await drainOutbox();
    expect(first.claimed).toBeGreaterThan(0);

    const { rows } = await pool.query(
      `SELECT da.ticket_id, t.ticket_number, t.status, t.priority, t.serial_number, t.company_id
         FROM device_alerts da LEFT JOIN support_tickets t ON t.id = da.ticket_id
        WHERE da.equipment_id=$1 AND da.state='active'`, [ctx.devC.id]);
    expect(rows[0].ticket_id).toBeTruthy();
    expect(rows[0].ticket_number).toMatch(/^IPS-/);
    expect(rows[0].priority).toBe('High');
    expect(rows[0].serial_number).toBe(`${TAG}-SN-C`);
    expect(rows[0].company_id).toBe(ctx.companyA);
    ctx.ticketId = rows[0].ticket_id;

    // Re-running the worker must not produce a second ticket for the incident.
    await drainOutbox();
    const { rows: tickets } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM support_tickets WHERE company_id=$1`, [ctx.companyA]);
    expect(tickets[0].n).toBe(1);
  });

  it('the ticket is reachable from the alert API, not just stored in a column', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM device_alerts WHERE equipment_id=$1 AND state='active'`, [ctx.devC.id]);
    const res = await request(app).get(`/iot/alerts/${rows[0].id}`);
    expect(res.status).toBe(200);
    expect(res.body.ticket_number).toMatch(/^IPS-/);
    expect(res.body.ticket_status).toBe('Open');
    expect(res.body.evidence.length).toBeGreaterThan(0);   // telemetry proof
    expect(res.body.allowed_transitions).toContain('acknowledged');
  });

  it('"nobody was told" is recorded as a fact, not as a successful notification', async () => {
    // This rule names no recipient roles and the fixture company has no users, so
    // ZERO recipients is the correct outcome. The assertion changed on 2026-09-15
    // when multi-channel delivery landed, and the change is the point:
    //
    //   before — notified_at was stamped unconditionally, so "we ran the
    //            notification code" and "an engineer was told" were the same
    //            column, and an alert nobody received looked delivered.
    //   after  — notified_at is set only when a recipient was actually reached,
    //            and the no-recipient case is written to iot_notification_log
    //            with the reason.
    //
    // An alert that reached nobody must LOOK like an alert that reached nobody.
    const { rows: a } = await pool.query(
      `SELECT notified_at FROM device_alerts WHERE equipment_id=$1 AND state='active'`, [ctx.devC.id]);
    expect(a[0].notified_at).toBeNull();

    const { rows: log } = await pool.query(
      `SELECT status, detail FROM iot_notification_log
        WHERE company_id = $1 AND status = 'no_recipients' ORDER BY id DESC LIMIT 1`, [ctx.companyA]);
    expect(log.length, 'the no-recipient outcome must be recorded').toBe(1);
    expect(log[0].detail).toMatch(/no user matched/);
  });

  it('4: recovery below the clear threshold resolves the incident and keeps the ticket link', async () => {
    const res = await postC({
      device_uid: ctx.devC.device_uid, batch_uid: `${TAG}-recover`,
      samples: [sample({ value: 3.0, event_ts: nextTs() })],
    });
    expect(res.body.alerts_resolved).toBe(1);

    const { rows } = await pool.query(
      `SELECT state, resolution_source, ticket_id FROM device_alerts
        WHERE equipment_id=$1 AND incident_uid=$2`, [ctx.devC.id, ctx.incidentUid]);
    expect(rows[0].state).toBe('resolved');
    expect(rows[0].resolution_source).toBe('telemetry_recovery');
    expect(rows[0].ticket_id).toBe(ctx.ticketId);   // the chain survives resolution
  });

  it('closing the alert does NOT close the engineer service ticket', async () => {
    await drainOutbox();
    const { rows } = await pool.query(`SELECT status, description FROM support_tickets WHERE id=$1`, [ctx.ticketId]);
    expect(rows[0].status).toBe('Open');            // telemetry recovery is not a repair
    expect(rows[0].description).toMatch(/Telemetry recovered/);
  });

  it('a value inside the hysteresis band does not reopen the incident', async () => {
    await postC({
      device_uid: ctx.devC.device_uid, batch_uid: `${TAG}-hyst`,
      samples: [sample({ value: 7.0, event_ts: nextTs() })],   // between clear 6 and trigger 8
    });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM device_alerts
        WHERE equipment_id=$1 AND state IN ('active','acknowledged','recovery_pending')`, [ctx.devC.id]);
    expect(rows[0].n).toBe(0);
  });

  it('a re-breach after resolution opens a NEW incident', async () => {
    const res = await postC({
      device_uid: ctx.devC.device_uid, batch_uid: `${TAG}-rebreach`,
      samples: [sample({ value: 15.0, event_ts: nextTs() })],
    });
    expect(res.body.alerts_opened).toBe(1);
    const { rows } = await pool.query(
      `SELECT incident_uid FROM device_alerts WHERE equipment_id=$1 ORDER BY id`, [ctx.devC.id]);
    expect(rows.length).toBe(2);
    expect(rows[0].incident_uid).not.toBe(rows[1].incident_uid);
  });
});

describe('SCENARIO 9 — cross-company access is denied at the API', () => {
  it('company B cannot read company A device', async () => {
    const res = await request(app).get(`/as-companyB/devices/${ctx.devA.id}`);
    expect(res.status).toBe(404);
  });

  it('company B fleet list does not contain company A device', async () => {
    const res = await request(app).get('/as-companyB/devices');
    expect(res.status).toBe(200);
    expect(res.body.rows.some((r) => r.id === ctx.devA.id)).toBe(false);
  });

  it('company B cannot provision company A device', async () => {
    const res = await request(app).post(`/as-companyB/devices/${ctx.devA.id}/provision`);
    expect(res.status).toBe(404);
  });

  it('a caller with NO company scope is DENIED, not given everything', async () => {
    const list = await request(app).get('/as-noscope/devices');
    expect(list.status).toBe(403);
    expect(list.body.code).toBe('NO_COMPANY_SCOPE');

    const one = await request(app).get(`/as-noscope/devices/${ctx.devA.id}`);
    expect(one.status).toBe(403);

    const summary = await request(app).get('/as-noscope/fleet/summary');
    expect(summary.status).toBe(403);
  });

  it("device A token cannot write to device B (a leaked token is confined to its own device)", async () => {
    const res = await request(app).post('/iot/ingest')
      .set('X-Device-Token', ctx.tokenA)
      .send({ device_uid: ctx.devB.device_uid, batch_uid: `${TAG}-steal`, samples: [sample()] });
    expect(res.status).toBe(401);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM device_telemetry WHERE equipment_id=$1`, [ctx.devB.id]);
    expect(rows[0].n).toBe(0);
  });
});

describe('token lifecycle', () => {
  it('a revoked device stops ingesting immediately', async () => {
    const good = await post({ device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-pre-revoke`, samples: [sample({ value: 4.1 })] });
    expect(good.status).toBe(200);

    const revoke = await request(app).post(`/iot/devices/${ctx.devA.id}/revoke-token`).send({ reason: 'suspected compromise' });
    expect(revoke.status).toBe(200);

    const after = await post({ device_uid: ctx.devA.device_uid, batch_uid: `${TAG}-post-revoke`, samples: [sample({ value: 4.1 })] });
    expect(after.status).toBe(401);   // the equipment hash is cleared, so auth fails first

    const { rows } = await pool.query(
      `SELECT status, revoked_at FROM iot_device_tokens WHERE equipment_id=$1 ORDER BY id DESC LIMIT 1`, [ctx.devA.id]);
    expect(rows[0].status).toBe('revoked');
    expect(rows[0].revoked_at).toBeTruthy();
  });

  it('rotation issues a working token and retires the previous one', async () => {
    const res = await request(app).post(`/iot/devices/${ctx.devA.id}/rotate-token`).send({ reason: 'post-incident rotation' });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^[0-9a-f]{48}$/);

    const used = await post(
      { device_uid: res.body.device_uid, batch_uid: `${TAG}-rotated`, samples: [sample({ value: 4.3 })] },
      res.body.token);
    expect(used.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM iot_device_tokens WHERE equipment_id=$1 AND status='active'`, [ctx.devA.id]);
    expect(rows[0].n).toBe(1);   // exactly one active token, ever
  });

  it('the token history never exposes a secret', async () => {
    const res = await request(app).get(`/iot/devices/${ctx.devA.id}/tokens`);
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(1);
    for (const r of res.body.rows) {
      expect(r.token_hash).toBeUndefined();
      expect(String(r.token_prefix || '').length).toBeLessThanOrEqual(12);
    }
  });
});

describe('fleet KPIs are computed over the population, not over a filtered page', () => {
  it('a search filter changes the list but NOT the company summary', async () => {
    const summary = await request(app).get('/iot/fleet/summary');
    expect(summary.status).toBe(200);
    const provisioned = summary.body.provisioned;

    const filtered = await request(app).get('/iot/devices?search=zzzz-no-such-device');
    expect(filtered.body.rows.length).toBe(0);

    const again = await request(app).get('/iot/fleet/summary');
    expect(again.body.provisioned).toBe(provisioned);   // unchanged by the search
    expect(provisioned).toBeGreaterThanOrEqual(1);
  });

  it('the device list warns callers not to derive KPIs from it', async () => {
    const res = await request(app).get('/iot/devices');
    expect(res.body.note).toMatch(/fleet\/summary/);
    expect(typeof res.body.total).toBe('number');
  });
});

describe('rule management guards', () => {
  it('rejects a clear threshold on the wrong side of the trigger', async () => {
    const res = await request(app).post('/iot/rules').send({
      name: `${TAG} bad hysteresis`, metric: 'THD_I_L1', operator: '>',
      threshold: 8, clear_threshold: 9, severity: 'warning',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/can never clear/);
  });

  it('rejects a metric that is not in the registry', async () => {
    const res = await request(app).post('/iot/rules').send({
      name: `${TAG} bad metric`, metric: 'not_a_real_metric', operator: '>', threshold: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metric registry/);
  });

  it('refuses a rule targeting another company equipment', async () => {
    const res = await request(app).post('/iot/rules').send({
      name: `${TAG} cross`, metric: 'THD_I_L1', operator: '>', threshold: 5,
      equipment_id: ctx.devB.id,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CROSS_COMPANY_EQUIPMENT');
  });
});

describe('history reports coverage and gaps instead of a smooth line', () => {
  it('returns sample counts, a quality mix and a coverage ratio', async () => {
    const res = await request(app).get(`/iot/devices/${ctx.devA.id}/telemetry?metric=THD_I_L1&hours=24`);
    expect(res.status).toBe(200);
    expect(res.body.unit).toBe('%');
    expect(res.body.sample_count).toBeGreaterThan(0);
    expect(Array.isArray(res.body.quality_mix)).toBe(true);
    expect(res.body.coverage).toHaveProperty('formula');
    // The window holds a handful of test samples against an expectation of one a
    // minute, so coverage must read as a low percentage rather than as 100%.
    expect(res.body.coverage.value).toBeLessThan(100);
  });

  it('an empty series is EMPTY, not a silent zero', async () => {
    const res = await request(app).get(`/iot/devices/${ctx.devA.id}/telemetry?metric=KVAR&hours=24`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('EMPTY');
    expect(res.body.points.length).toBe(0);
  });
});

describe('unauthenticated floods are bounded, authenticated devices are not', () => {
  /**
   * server.js excludes the device-facing IoT paths from the global IP limiter,
   * because a per-IP budget is a SITE budget that several gateways behind one NAT
   * exhaust between them. That exclusion was unconditional, and the per-device
   * limiter cannot cover the gap because deviceAuth runs first — so these routes
   * had no ceiling at all for traffic that never authenticates.
   *
   * Reproduced against the running server on 2026-09-15: 400 unauthenticated
   * POSTs to /iot/ingest from one IP returned 400 x 401 and ZERO 429s, while the
   * same volume against a human-facing IoT route from the same IP was cut off
   * after 252. Each 401 costs an indexed SELECT with a LEFT JOIN, because
   * deviceAuth must look the device up before it can say the token is wrong.
   *
   * ORDER IS LOAD-BEARING. The limiter keys on IP and every request here comes
   * from 127.0.0.1, so the flood case below poisons the counter for anything
   * after it. The valid-traffic case therefore runs FIRST — which is also the
   * order that proves the point: valid traffic must not move the counter at all.
   */
  // Its OWN device. Device A's token is rotated by the token-lifecycle case
  // above, so borrowing it here made every "valid" request a 401 — which the
  // limiter then counted, quietly testing the opposite of the intended property.
  const rlToken = `${TAG}-rawtoken-RL`;
  beforeAll(async () => {
    const { rows } = await pool.query(
      `INSERT INTO customer_equipment
         (company_id, equipment_name, serial_number, device_uid, telemetry_token_hash,
          sampling_secs, device_status, connection_state, device_profile_id, rating)
       VALUES ($1,$2,$3,$4,$5,60,'active','never',$6,'100A') RETURNING *`,
      [ctx.companyA, `${TAG} AHF RL`, `${TAG}-SN-RL`, `${TAG}-UID-RL`, sha256(rlToken), ctx.profileId]);
    ctx.devRL = rows[0];
    await pool.query(
      `INSERT INTO iot_device_tokens (company_id, equipment_id, token_hash, token_prefix, status)
       VALUES ($1,$2,$3,$4,'active')`,
      [ctx.companyA, rows[0].id, sha256(rlToken), rlToken.slice(0, 8)]);
  }, 30000);

  it('valid telemetry never moves the counter, so a NAT site is never throttled', async () => {
    // This is the defect the exclusion existed to fix, and it must not come back.
    // Far more successful batches than the suite's 200-failure ceiling, all from
    // one IP, none refused — because success is not counted.
    const codes = {};
    for (let i = 0; i < 60; i++) {
      const res = await request(app)
        .post('/iot/ingest')
        .set('X-Device-Token', rlToken)
        .send({
          device_uid: ctx.devRL.device_uid,
          batch_uid: `${TAG}-rl-ok-${i}`,
          samples: [{
            sample_uid: `${TAG}-rl-ok-s-${i}`,
            metric: 'THD_I_L1',
            value: 1.5,
            event_ts: iso(new Date()),
            quality: 'VALID',
          }],
        });
      codes[res.status] = (codes[res.status] || 0) + 1;
    }
    expect(codes[429]).toBeUndefined();
    expect(codes[200]).toBe(60);
  });

  it('a credential-free flood is cut off instead of querying the database forever', async () => {
    const codes = {};
    for (let i = 0; i < 260; i++) {
      const res = await request(app)
        .post('/iot/ingest')
        .set('X-Device-Token', `garbage-${i}`)
        .send({ device_uid: `NO-SUCH-DEVICE-${i}`, samples: [] });
      codes[res.status] = (codes[res.status] || 0) + 1;
    }
    expect(codes[429]).toBeGreaterThan(0);
    // The ceiling is 200 for this suite. A handful of earlier cases in this file
    // are deliberate 4xx and count too, so assert the bound rather than a total.
    expect(codes[401]).toBeLessThanOrEqual(201);
  });

  it('once an IP is over its FAILURE budget it is throttled even for valid traffic', async () => {
    // The documented trade, asserted so it is a decision rather than a surprise:
    // an IP that has produced a flood of auth failures is shut off entirely until
    // the window rolls. An attacker is not normally behind the customer's NAT, and
    // a site whose own gateways are failing auth 200 times a minute has a broken
    // deployment rather than a rate-limiting problem.
    const res = await request(app)
      .post('/iot/ingest')
      .set('X-Device-Token', rlToken)
      .send({
        device_uid: ctx.devRL.device_uid,
        batch_uid: `${TAG}-rl-after-flood`,
        samples: [{
          sample_uid: `${TAG}-rl-after-flood-s`,
          metric: 'THD_I_L1', value: 1.5,
          event_ts: iso(new Date()), quality: 'VALID',
        }],
      });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});
