/**
 * iot-capacity-test.mjs — measured ingestion and query capacity for the IoT
 * pipeline, against a real server and a real database.
 *
 * WHY THIS EXISTS
 * ---------------
 * The pipeline had only ever been exercised by the simulator against a handful of
 * devices. "It works" at 5 devices says nothing about 500, and the specific thing
 * that changes with scale here is not CPU: it is the per-batch transaction, the
 * unique-index maintenance on a partitioned table, and the per-metric latest-value
 * upsert loop.
 *
 * WHAT IT MEASURES
 *   ingestion latency      p50 / p95 / max per batch, and samples per second
 *   database write latency  the transaction alone, excluding HTTP
 *   alert evaluation        with rules present vs absent
 *   API latency             fleet summary, device list, history, alert centre
 *   duplicate handling      the cost of a full-batch retry (should be cheap)
 *
 * WHAT IT DOES NOT CLAIM
 *   Nothing here is a statement about a production host. It runs against whatever
 *   machine invokes it — here, a developer laptop with the database on localhost,
 *   which removes network latency and shares CPU with the server. Treat the
 *   numbers as a floor for relative comparison between device counts, not as a
 *   capacity guarantee.
 *
 * USAGE
 *   node scripts/iot-capacity-test.mjs [--devices 100] [--metrics 8] [--batches 5]
 *                                      [--url http://localhost:5099/api/v1]
 *   node scripts/iot-capacity-test.mjs --sweep      (10, 100, 500, 1000)
 *
 * It creates its own company and devices under an IOTCAP_ prefix and deletes them
 * on exit, including after a failure.
 */

import dotenv from 'dotenv';
import crypto from 'crypto';
import pg from 'pg';

dotenv.config();

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SWEEP = args.includes('--sweep');
const BASE = arg('url', 'http://localhost:5099/api/v1');
const METRICS_PER_DEVICE = parseInt(arg('metrics', '8'), 10);
const BATCHES = parseInt(arg('batches', '5'), 10);
const CONCURRENCY = parseInt(arg('concurrency', '10'), 10);

const METRIC_CODES = ['V_L1', 'V_L2', 'V_L3', 'I_L1', 'I_L2', 'I_L3', 'THD_I_L1', 'THD_V_L1',
                      'FREQUENCY', 'KW', 'KVAR', 'PF', 'TEMPERATURE', 'DC_BUS_VOLTAGE'];

const pool = new pg.Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 10,
});

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: Math.round(pct(s, 0.5)),
    p95: Math.round(pct(s, 0.95)),
    max: Math.round(s[s.length - 1] ?? 0),
    mean: Math.round(s.reduce((x, y) => x + y, 0) / (s.length || 1)),
  };
};

async function setup(tag, deviceCount) {
  const { rows: c } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${tag} capacity`, tag.slice(-12)]);
  const companyId = c[0].id;

  // One multi-row INSERT rather than N round-trips — creating 1,000 devices one at
  // a time would dominate the measurement it is setting up for.
  const cols = [], vals = [];
  const tokens = [];
  for (let i = 0; i < deviceCount; i++) {
    const token = `${tag}-tok-${i}`;
    tokens.push(token);
    const b = i * 7;
    cols.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
    vals.push(companyId, `${tag} dev ${i}`, `${tag}-SN-${i}`, `${tag}-UID-${i}`, sha256(token), 60, 'active');
  }
  await pool.query(
    `INSERT INTO customer_equipment
       (company_id, equipment_name, serial_number, device_uid, telemetry_token_hash, sampling_secs, device_status)
     VALUES ${cols.join(',')}`, vals);

  const { rows: devs } = await pool.query(
    `SELECT id, device_uid FROM customer_equipment WHERE company_id = $1 ORDER BY id`, [companyId]);

  // A rule on every device, so alert evaluation is part of the measurement rather
  // than being skipped by an empty rule set — which is what a naive benchmark of
  // this pipeline would accidentally measure.
  const rc = [], rv = [];
  devs.forEach((d, i) => {
    const b = i * 5;
    rc.push(`($${b + 1},$${b + 2},$${b + 3},'THD_I_L1','>',$${b + 4},$${b + 5},'warning')`);
    rv.push(companyId, d.id, `${tag} rule ${i}`, 90, 80);
  });
  if (rc.length) {
    await pool.query(
      `INSERT INTO device_alert_rules (company_id, equipment_id, name, metric, operator, threshold, clear_threshold, severity)
       VALUES ${rc.join(',')}`, rv);
  }

  return { companyId, devices: devs.map((d, i) => ({ ...d, token: tokens[i] })) };
}

async function teardown(companyId) {
  for (const t of ['device_telemetry', 'device_latest', 'iot_outbox', 'iot_rejected_samples',
                   'iot_ingest_batches', 'iot_device_events', 'iot_rule_state', 'device_alerts',
                   'device_alert_rules', 'support_tickets']) {
    const col = t === 'device_latest' || t === 'iot_rule_state' ? 'company_id' : 'company_id';
    await pool.query(`DELETE FROM ${t} WHERE ${col} = $1`, [companyId]).catch(() => {});
  }
  await pool.query(`DELETE FROM customer_equipment WHERE company_id = $1`, [companyId]).catch(() => {});
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]).catch(() => {});
}

function makeBatch(tag, deviceIdx, batchIdx, metrics) {
  const now = Date.now();
  const samples = [];
  for (let m = 0; m < metrics; m++) {
    const metric = METRIC_CODES[m % METRIC_CODES.length];
    samples.push({
      sample_uid: `${tag}-${deviceIdx}-${batchIdx}-${m}`,
      seq_no: batchIdx * metrics + m,
      metric,
      // Values inside each metric's declared physical range, so the run measures
      // the accept path rather than the quarantine path.
      value: metric.startsWith('V_') ? 415 + Math.random()
        : metric.startsWith('I_') ? 100 + Math.random() * 10
        : metric === 'FREQUENCY' ? 50 + Math.random() * 0.1
        : metric === 'PF' ? 0.95
        : metric === 'TEMPERATURE' ? 45 + Math.random() * 3
        : metric === 'DC_BUS_VOLTAGE' ? 700 + Math.random() * 5
        : 4 + Math.random() * 2,
      event_ts: new Date(now - (metrics - m) * 100).toISOString(),
      quality: 'VALID',
    });
  }
  return { batch_uid: `${tag}-b-${deviceIdx}-${batchIdx}`, samples };
}

/** Run `tasks` with a bounded number in flight — a 1,000-way Promise.all is a load test of Node, not of the pipeline. */
async function pooled(tasks, limit) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const my = i++;
      results[my] = await tasks[my]();
    }
  });
  await Promise.all(workers);
  return results;
}

async function runScenario(deviceCount) {
  const tag = `IOTCAP_${Date.now()}_${deviceCount}`;
  console.log(`\n${'='.repeat(74)}`);
  console.log(`SCENARIO: ${deviceCount} devices x ${METRICS_PER_DEVICE} metrics x ${BATCHES} batches`);
  console.log(`          = ${deviceCount * METRICS_PER_DEVICE * BATCHES} samples, concurrency ${CONCURRENCY}`);
  console.log('='.repeat(74));

  const t0 = Date.now();
  const { companyId, devices } = await setup(tag, deviceCount);
  console.log(`setup: ${deviceCount} devices + rules in ${Date.now() - t0}ms`);

  const latencies = [];
  const errors = [];
  let accepted = 0, duplicates = 0, rejected = 0;

  const tasks = [];
  for (let b = 0; b < BATCHES; b++) {
    devices.forEach((d, idx) => {
      tasks.push(async () => {
        const body = { device_uid: d.device_uid, gateway_uid: `${tag}-GW`, ...makeBatch(tag, idx, b, METRICS_PER_DEVICE) };
        const start = performance.now();
        try {
          const res = await fetch(`${BASE}/iot/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Device-Token': d.token },
            body: JSON.stringify(body),
          });
          const ms = performance.now() - start;
          latencies.push(ms);
          if (res.ok) {
            const j = await res.json();
            accepted += j.accepted || 0; duplicates += j.duplicates || 0; rejected += j.rejected || 0;
          } else {
            errors.push(`${res.status}: ${(await res.text()).slice(0, 120)}`);
          }
        } catch (e) {
          latencies.push(performance.now() - start);
          errors.push(e.message);
        }
      });
    });
  }

  // WARM-UP. The first request of a run pays for the metric-registry cache load,
  // the connection-pool ramp and JIT warm-up; including it puts a 2-second
  // outlier in the p95 of every scenario and makes small runs look worse than
  // large ones. One warm batch is discarded before the clock starts.
  await (async () => {
    const d = devices[0];
    const body = { device_uid: d.device_uid, ...makeBatch(`${tag}-warm`, 0, 999, METRICS_PER_DEVICE) };
    await fetch(`${BASE}/iot/ingest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Token': d.token },
      body: JSON.stringify(body),
    }).catch(() => {});
  })();

  const ingestStart = Date.now();
  await pooled(tasks, CONCURRENCY);
  const ingestMs = Date.now() - ingestStart;
  const totalSamples = deviceCount * METRICS_PER_DEVICE * BATCHES;

  const L = stats(latencies);
  console.log(`\ningestion (${tasks.length} batches over ${(ingestMs / 1000).toFixed(1)}s)`);
  console.log(`  latency per batch   p50 ${L.p50}ms · p95 ${L.p95}ms · max ${L.max}ms · mean ${L.mean}ms`);
  console.log(`  throughput          ${Math.round(totalSamples / (ingestMs / 1000))} samples/s · ${Math.round(tasks.length / (ingestMs / 1000))} batches/s`);
  console.log(`  accepted ${accepted} · duplicates ${duplicates} · rejected ${rejected} · errors ${errors.length}`);
  if (errors.length) console.log(`  first error: ${errors[0]}`);

  // Duplicate cost: resend the whole first round. Every sample collides, so this
  // measures the unique-index rejection path — the one a real retry storm takes.
  const dupTasks = devices.map((d, idx) => async () => {
    const body = { device_uid: d.device_uid, ...makeBatch(tag, idx, 0, METRICS_PER_DEVICE) };
    const start = performance.now();
    const res = await fetch(`${BASE}/iot/ingest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Token': d.token },
      body: JSON.stringify(body),
    });
    await res.json().catch(() => ({}));
    return performance.now() - start;
  });
  const dupStart = Date.now();
  const dupLat = await pooled(dupTasks, CONCURRENCY);
  const D = stats(dupLat.filter(Boolean));
  console.log(`\nretry of an already-committed batch (the lost-response path)`);
  console.log(`  latency             p50 ${D.p50}ms · p95 ${D.p95}ms · max ${D.max}ms`);
  console.log(`  ${devices.length} batches replayed in ${Date.now() - dupStart}ms`);

  // API latency under the data just written.
  const apiTimes = {};
  // The read token must be scoped to THIS scenario's company, not to whatever
  // company the first admin happens to sit in — otherwise every device-level read
  // correctly 404s and the API timings measure the rejection path.
  const admin = await adminToken(companyId);
  const timeGet = async (label, path) => {
    const t = performance.now();
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${admin}` } });
    await res.text();
    apiTimes[label] = { ms: Math.round(performance.now() - t), status: res.status };
  };
  await timeGet('fleet summary', '/iot/fleet/summary');
  await timeGet('device list (100)', '/iot/devices?limit=100');
  await timeGet('alert centre', '/iot/alerts?view=open&limit=100');
  await timeGet('device 360', `/iot/devices/${devices[0].id}`);
  await timeGet('history 24h', `/iot/devices/${devices[0].id}/telemetry?metric=THD_I_L1&hours=24`);
  await timeGet('history 30d', `/iot/devices/${devices[0].id}/telemetry?metric=THD_I_L1&hours=720`);
  await timeGet('condition risk', `/iot/devices/${devices[0].id}/risk`);
  await timeGet('platform health', '/iot/ops/health?hours=24');
  await timeGet('data quality', '/iot/ops/data-quality?hours=24');

  console.log('\nAPI latency (read paths, with the data above present)');
  for (const [k, v] of Object.entries(apiTimes)) {
    console.log(`  ${k.padEnd(20)} ${String(v.ms).padStart(5)}ms  [${v.status}]`);
  }

  const { rows: dbRows } = await pool.query(
    `SELECT COUNT(*)::int AS telemetry FROM device_telemetry WHERE company_id = $1`, [companyId]);
  const { rows: alertRows } = await pool.query(
    `SELECT COUNT(*)::int AS alerts FROM device_alerts WHERE company_id = $1`, [companyId]);
  const { rows: outboxRows } = await pool.query(
    `SELECT COUNT(*)::int AS events FROM iot_outbox WHERE company_id = $1`, [companyId]);
  console.log(`\nstored: ${dbRows[0].telemetry} telemetry rows · ${alertRows[0].alerts} alerts · ${outboxRows[0].events} outbox events`);

  await teardown(companyId);
  console.log('teardown complete');

  return {
    devices: deviceCount, samples: totalSamples,
    ingest_p50: L.p50, ingest_p95: L.p95, ingest_max: L.max,
    samples_per_sec: Math.round(totalSamples / (ingestMs / 1000)),
    retry_p50: D.p50, errors: errors.length,
    api: apiTimes,
  };
}

let cachedAdmin = null;
async function adminToken(companyId) {
  const jwt = (await import('jsonwebtoken')).default;
  if (!cachedAdmin) {
    const { rows } = await pool.query(
      `SELECT u.id, u.email FROM users u
         JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE LOWER(r.code) = 'admin' AND u.is_active
        ORDER BY u.id LIMIT 1`);
    cachedAdmin = rows[0];
  }
  // company_id is a JWT claim that verifyToken prefers over the DB row, so the
  // same real admin can read the scenario's company without its scope row being
  // rewritten — which would be a mutation this benchmark has no business making.
  return jwt.sign(
    { userId: cachedAdmin.id, email: cachedAdmin.email, company_id: companyId },
    process.env.JWT_SECRET, { expiresIn: '30m' });
}

async function main() {
  const counts = SWEEP ? [10, 100, 500, 1000] : [parseInt(arg('devices', '100'), 10)];
  const results = [];
  for (const n of counts) {
    try { results.push(await runScenario(n)); }
    catch (e) { console.error(`scenario ${n} failed:`, e.message); }
  }

  if (results.length > 1) {
    console.log(`\n${'='.repeat(74)}\nSUMMARY\n${'='.repeat(74)}`);
    console.log('devices | samples | ingest p50 | p95   | max   | samples/s | retry p50 | errors');
    for (const r of results) {
      console.log(
        `${String(r.devices).padStart(7)} | ${String(r.samples).padStart(7)} | ` +
        `${String(r.ingest_p50).padStart(10)} | ${String(r.ingest_p95).padStart(5)} | ` +
        `${String(r.ingest_max).padStart(5)} | ${String(r.samples_per_sec).padStart(9)} | ` +
        `${String(r.retry_p50).padStart(9)} | ${r.errors}`);
    }
  }
  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
