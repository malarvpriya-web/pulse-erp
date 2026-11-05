/**
 * iotPartitions.cron.js — rolling partition creation and retention for
 * device_telemetry.
 *
 * WHAT WAS MISSING
 * ----------------
 * 20260718000001 created three monthly partitions and a DEFAULT partition, with
 * a comment saying "a cron rolls new months forward". That cron did not exist. So
 * from the fourth month onward EVERY sample landed in device_telemetry_default —
 * a single unpartitioned heap that grows forever, cannot be dropped by month, and
 * makes the partitioning decorative. Worse, once rows sit in the default
 * partition Postgres refuses to create the overlapping month partition, so the
 * problem compounds: the longer nobody notices, the harder it is to fix.
 *
 * This job:
 *   1. creates partitions for the next N months (default 3),
 *   2. reports how many rows are stranded in the default partition,
 *   3. drops partitions older than the retention window (default 400 days),
 *   4. runs ANALYZE so the planner's stats reflect reality — stale planner stats
 *      are what made empty-table probes report the wrong thing elsewhere in this
 *      codebase.
 *
 * Retention is configurable and refuses to run destructively without one:
 *   IOT_TELEMETRY_RETENTION_DAYS   default 400 (13 months, so a year-on-year
 *                                  comparison always has its comparator)
 *   IOT_PARTITION_AHEAD_MONTHS     default 3
 *   IOT_PARTITION_DROP_ENABLED     default 'false' — dropping a partition
 *                                  destroys data, so it is opt-in per deployment.
 */

import cron from 'node-cron';
import pool from '../config/db.js';

const AHEAD = parseInt(process.env.IOT_PARTITION_AHEAD_MONTHS || '3', 10);
const RETENTION_DAYS = parseInt(process.env.IOT_TELEMETRY_RETENTION_DAYS || '400', 10);
const DROP_ENABLED = String(process.env.IOT_PARTITION_DROP_ENABLED || 'false').toLowerCase() === 'true';

const partName = (d) =>
  `device_telemetry_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export async function ensurePartitions() {
  const created = [];
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  for (let i = 0; i <= AHEAD; i++) {
    const from = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1));
    const name = partName(from);
    const { rows: exists } = await pool.query(`SELECT to_regclass($1) AS t`, [name]);
    if (exists[0].t) continue;
    try {
      // The application role cannot create tables. This function can create exactly
      // one kind of thing: a month of device_telemetry (migration 20261105000003).
      const { rows: [r] } = await pool.query(
        `SELECT ensure_device_telemetry_partition($1, $2) AS created`,
        [from.getUTCFullYear(), from.getUTCMonth() + 1]);
      if (r.created) created.push(name);
    } catch (e) {
      // The usual cause is rows already sitting in the default partition for this
      // month. Say so loudly — the remedy is to move them out, and a generic
      // failure message would hide that.
      console.error(JSON.stringify({
        ts: new Date().toISOString(), level: 'ERROR', event: 'iot_partition_create_failed',
        partition: name, message: e.message,
        hint: 'If rows already occupy device_telemetry_default for this range, they must be relocated before the partition can be created.',
      }));
    }
  }
  return created;
}

export async function checkDefaultPartition() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::bigint AS n, MIN(ts) AS oldest, MAX(ts) AS newest
      FROM device_telemetry_default`);
  const n = Number(rows[0].n);
  if (n > 0) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN', event: 'iot_default_partition_occupied',
      rows: n, oldest: rows[0].oldest, newest: rows[0].newest,
      message: 'Samples are landing in the catch-all partition. They cannot be dropped by month and will block creation of the overlapping monthly partition.',
    }));
  }
  return { rows: n, oldest: rows[0].oldest, newest: rows[0].newest };
}

export async function applyRetention() {
  if (!DROP_ENABLED) {
    return { dropped: [], skipped: true, reason: 'IOT_PARTITION_DROP_ENABLED is not true — retention is report-only' };
  }
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
  const { rows } = await pool.query(`
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'device_telemetry' AND c.relname ~ '^device_telemetry_[0-9]{4}_[0-9]{2}$'`);

  const dropped = [];
  for (const r of rows) {
    const m = r.name.match(/^device_telemetry_(\d{4})_(\d{2})$/);
    if (!m) continue;
    const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1)); // exclusive upper bound
    if (end <= cutoff) {
      await pool.query(`DROP TABLE IF EXISTS ${r.name}`);
      dropped.push(r.name);
    }
  }
  if (dropped.length) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'INFO', event: 'iot_partitions_dropped',
      dropped, retention_days: RETENTION_DAYS,
    }));
  }
  return { dropped, skipped: false, retention_days: RETENTION_DAYS };
}

export async function runPartitionMaintenance() {
  try {
    const created = await ensurePartitions();
    const def = await checkDefaultPartition();
    const retention = await applyRetention();
    await pool.query(`ANALYZE device_telemetry`).catch(() => {});
    if (created.length || def.rows > 0 || retention.dropped.length) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(), level: 'INFO', event: 'iot_partition_maintenance',
        created, default_partition_rows: def.rows, dropped: retention.dropped,
        retention_enabled: DROP_ENABLED,
      }));
    }
    return { created, default_partition: def, retention };
  } catch (e) {
    console.error('[iotPartitions] maintenance failed:', e.message);
    return { error: e.message };
  }
}

export function startIotPartitionCron() {
  // 03:10 daily — well clear of the month boundary, and daily rather than monthly
  // so a missed run is recovered the next day instead of a month later.
  cron.schedule('10 3 * * *', () => { runPartitionMaintenance(); });
  console.log(`🗂  IoT partition maintenance cron started — daily 03:10 (roll ${AHEAD} months ahead, retention ${RETENTION_DAYS}d, drop ${DROP_ENABLED ? 'ENABLED' : 'report-only'})`);
}
