import cron      from 'node-cron';
import fs        from 'fs';
import path      from 'path';
import { fileURLToPath } from 'url';
import { snapshot as metricsSnapshot } from '../config/metrics.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
// Two levels up from src/jobs lands at the backend root (= /app in the
// container); a third '..' escaped to the filesystem root (EACCES for the
// non-root `node` user — see errorHandler.js for the same bug at boot time).
const LOGS_DIR   = path.join(__dirname, '../../logs');
const HEALTH_LOG = path.join(LOGS_DIR, 'health.log');

const THRESHOLD_MS            = parseInt(process.env.ALERT_THRESHOLD_MS || '800');
const MEMORY_ALERT_MB         = parseInt(process.env.MEMORY_ALERT_MB    || '450');
const WORKFLOW_FAIL_THRESHOLD = parseInt(process.env.WORKFLOW_FAIL_THRESHOLD || '5');
const NOTIFICATION_FAIL_THRESHOLD = parseInt(process.env.NOTIFICATION_FAIL_THRESHOLD || '10');
const WEBHOOK_URL             = () => process.env.ALERT_WEBHOOK_URL;   // read each tick — survives hot env updates

// Snapshot of counters from last check — used to detect *new* failures since last tick
let _lastMetrics = { workflow_transition_failures: 0, notification_failures: 0 };

// ── State machine ─────────────────────────────────────────────────────────────
// States: 'ok' | 'degraded' | 'slow'
// Alerts only fire on state *transitions* — no repeated spam during sustained incidents.

let dbState           = 'ok';
let consecutiveFails  = 0;
let consecutiveSlow   = 0;
let failsAtTransition = 0;          // how many failures triggered the degraded transition
let lastMemAlertAt    = 0;          // epoch ms — prevents memory alert every 5 min

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pingDB(pool) {
  const t0 = Date.now();
  await pool.query('SELECT 1');
  return Date.now() - t0;
}

async function sendAlert(text) {
  const url = WEBHOOK_URL();
  if (!url) return;
  try {
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });
  } catch { /* never crash the cron on webhook failure */ }
}

function writeLog(entry, pool = null) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.appendFile(HEALTH_LOG, JSON.stringify(entry) + '\n', () => {});
  if (pool) persistHealth(pool, entry);
}

/**
 * Persist the measurement to `health_checks`.
 *
 * The table has existed since the schema was written and had ZERO rows —
 * nothing ever wrote to it. Every measurement this cron takes was logged to the
 * console and discarded, so "did latency degrade under sustained load?" could
 * only be answered by watching a terminal live. That is the question a pilot
 * exists to answer, hence the write.
 *
 * The file log stays as-is and is deliberately NOT replaced: on the DB-failure
 * path this INSERT cannot succeed either, so logs/health.log remains the only
 * record of an outage. Two sinks, and the one that survives is the one you need
 * during an incident.
 *
 * Fire-and-forget: health monitoring must never be the thing that breaks the
 * process it is monitoring.
 */
function persistHealth(pool, entry) {
  pool.query(
    `INSERT INTO health_checks (status, db_ms, uptime_s, memory_mb, error)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.status ?? 'unknown',
      Number.isFinite(entry.db_ms) ? entry.db_ms : null,
      Number.isFinite(entry.uptime_s) ? entry.uptime_s : Math.floor(process.uptime()),
      Number.isFinite(entry.mem_mb) ? entry.mem_mb : null,
      entry.error ?? null,
    ]
  ).catch(() => { /* never let telemetry take down the monitor */ });
}

/**
 * Retention. A check every 5 minutes is 288 rows/day (~105k/year) — small, but
 * unbounded growth in a diagnostic table is how a monitoring feature becomes an
 * operational problem. Runs opportunistically, roughly hourly.
 */
let _lastPrune = 0;
function pruneHealth(pool) {
  const HOUR = 60 * 60 * 1000;
  if (Date.now() - _lastPrune < HOUR) return;
  _lastPrune = Date.now();
  const days = parseInt(process.env.HEALTH_RETENTION_DAYS || '90', 10);
  pool.query(`DELETE FROM health_checks WHERE checked_at < NOW() - ($1 || ' days')::interval`, [days])
      .catch(() => {});
}

function memMB() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

// ── Core check ────────────────────────────────────────────────────────────────

async function runCheck(pool) {
  const ts  = new Date().toISOString();
  const mem = memMB();

  // ── DB ping ────────────────────────────────────────────────────────────────
  let latencyMs = 0;
  let dbOk      = true;
  let dbErr     = null;

  try {
    latencyMs = await pingDB(pool);
  } catch (err) {
    dbOk  = false;
    dbErr = err.message;
  }

  // ── DB failure state ───────────────────────────────────────────────────────
  if (!dbOk) {
    consecutiveFails++;
    consecutiveSlow = 0;

    writeLog({ ts, status: 'error', error: dbErr, consecutiveFails, mem_mb: mem }, pool);
    console.error(`[healthMonitor] DB unreachable (failure #${consecutiveFails}): ${dbErr}`);

    // Transition ok → degraded on 2nd consecutive failure (avoids single transient alert)
    if (consecutiveFails === 2 && dbState !== 'degraded') {
      dbState           = 'degraded';
      failsAtTransition = consecutiveFails;
      await sendAlert(
        `🚨 *Pulse ERP — DB DEGRADED*\n` +
        `DB unreachable for ${consecutiveFails} consecutive checks.\n` +
        `Error: ${dbErr}\n` +
        `Time: ${ts}`
      );
    }
    return;
  }

  // ── DB recovered ──────────────────────────────────────────────────────────
  if (dbState === 'degraded') {
    dbState = 'ok';
    await sendAlert(
      `✅ *Pulse ERP — DB RECOVERED*\n` +
      `DB is reachable again after ${consecutiveFails} failures.\n` +
      `Current latency: ${latencyMs}ms | Time: ${ts}`
    );
  }
  consecutiveFails = 0;

  // ── Slow query state ───────────────────────────────────────────────────────
  if (latencyMs > THRESHOLD_MS) {
    consecutiveSlow++;

    // Transition ok → slow on 2nd consecutive slow check
    if (consecutiveSlow === 2 && dbState !== 'slow') {
      dbState = 'slow';
      await sendAlert(
        `⚠️ *Pulse ERP — HIGH DB LATENCY*\n` +
        `Latency: ${latencyMs}ms (threshold: ${THRESHOLD_MS}ms) for ${consecutiveSlow} consecutive checks.\n` +
        `Time: ${ts}`
      );
    }
  } else {
    if (dbState === 'slow') {
      dbState = 'ok';
      await sendAlert(
        `✅ *Pulse ERP — LATENCY RECOVERED*\n` +
        `DB latency back to normal: ${latencyMs}ms.\n` +
        `Time: ${ts}`
      );
    }
    consecutiveSlow = 0;
  }

  // ── Memory pressure (alert at most once per hour) ─────────────────────────
  if (mem > MEMORY_ALERT_MB && Date.now() - lastMemAlertAt > 60 * 60 * 1000) {
    lastMemAlertAt = Date.now();
    await sendAlert(
      `⚠️ *Pulse ERP — MEMORY PRESSURE*\n` +
      `RSS: ${mem}MB exceeds threshold ${MEMORY_ALERT_MB}MB.\n` +
      `Time: ${ts}`
    );
    console.warn(`[healthMonitor] Memory pressure: ${mem}MB > ${MEMORY_ALERT_MB}MB`);
  }

  // ── Operational metrics spike detection ───────────────────────────────────
  const m = metricsSnapshot();
  const newWorkflowFails     = m.workflow_transition_failures - _lastMetrics.workflow_transition_failures;
  const newNotificationFails = m.notification_failures        - _lastMetrics.notification_failures;
  _lastMetrics = { workflow_transition_failures: m.workflow_transition_failures, notification_failures: m.notification_failures };

  if (newWorkflowFails >= WORKFLOW_FAIL_THRESHOLD) {
    console.warn(`[healthMonitor] workflow failure spike: +${newWorkflowFails} in last 5min (total: ${m.workflow_transition_failures})`);
    await sendAlert(
      `⚠️ *Pulse ERP — WORKFLOW FAILURE SPIKE*\n` +
      `${newWorkflowFails} workflow transition failures in the last 5 minutes.\n` +
      `Total since start: ${m.workflow_transition_failures} | Time: ${ts}`
    );
  }
  if (newNotificationFails >= NOTIFICATION_FAIL_THRESHOLD) {
    console.warn(`[healthMonitor] notification failure spike: +${newNotificationFails} in last 5min (total: ${m.notification_failures})`);
    await sendAlert(
      `⚠️ *Pulse ERP — NOTIFICATION FAILURE SPIKE*\n` +
      `${newNotificationFails} notification delivery failures in the last 5 minutes.\n` +
      `Total since start: ${m.notification_failures} | Time: ${ts}`
    );
  }

  // status carries dbState rather than a literal 'ok' — otherwise a sustained
  // 'slow' period is indistinguishable from healthy in the stored history,
  // which is precisely the trend a pilot is meant to surface.
  const entry = { ts, status: dbState === 'degraded' ? 'error' : dbState, db_ms: latencyMs, mem_mb: mem, uptime_s: Math.floor(process.uptime()), metrics: m };
  writeLog(entry, pool);
  pruneHealth(pool);

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[healthMonitor] ok — db=${latencyMs}ms mem=${mem}MB wf_fails=${m.workflow_transition_failures} notif_fails=${m.notification_failures}`);
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Exported so a check can be taken on demand — for tests, and for capturing a
 * data point during an incident without waiting for the next tick.
 */
export const runHealthCheck = runCheck;

export function startHealthMonitor(pool) {
  cron.schedule('*/5 * * * *', () => runCheck(pool));

  // One check shortly after boot. Without it there is a five-minute hole in the
  // history after every restart and deploy — exactly the window where something
  // is most likely to be wrong, and previously the window with no data at all.
  // Delayed slightly so startup migrations are not competing for the pool.
  setTimeout(() => runCheck(pool).catch(() => {}), 10_000).unref();

  console.log(
    `🩺 Health monitor started — every 5 min | ` +
    `latency threshold: ${THRESHOLD_MS}ms | memory threshold: ${MEMORY_ALERT_MB}MB`
  );
}
