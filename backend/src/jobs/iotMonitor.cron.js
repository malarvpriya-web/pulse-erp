/**
 * iotMonitor.cron.js — keeps device connection state honest and raises alerts
 * for devices that have gone silent.
 *
 * Runs every 5 minutes. Two sweeps:
 *
 *  1. Connection-state sweep — a device is 'online' only while telemetry keeps
 *     arriving. Ingest sets last_seen_at + 'online'; this cron ages that:
 *       last_seen_at older than 3× the sampling interval  -> 'stale'
 *       last_seen_at older than 12× the sampling interval -> 'offline'
 *     Default sampling interval is 300s when a device hasn't declared one, so
 *     the defaults are stale @ 15 min, offline @ 60 min. Never-seen devices
 *     (last_seen_at IS NULL) stay 'never'.
 *
 *  2. Stale-rule alerts — device_alert_rules with operator='stale' fire when a
 *     device has been silent longer than the rule's stale_secs. These go through
 *     the shared raiseAlert(), so a critical stale rule opens a service ticket
 *     exactly like a threshold breach. A rule with equipment_id targets one
 *     device; a company-wide rule (equipment_id NULL) covers every provisioned
 *     device in that company.
 */

import cron from 'node-cron';
import pool from '../config/db.js';
import { raiseAlert } from '../modules/iot/alertActions.js';

async function sweepConnectionState() {
  const { rowCount } = await pool.query(`
    UPDATE customer_equipment ce SET connection_state = next.state
      FROM (
        SELECT id,
               CASE
                 WHEN last_seen_at IS NULL THEN 'never'
                 WHEN last_seen_at < NOW() - (COALESCE(sampling_secs, 300) * 12 || ' seconds')::interval THEN 'offline'
                 WHEN last_seen_at < NOW() - (COALESCE(sampling_secs, 300) * 3  || ' seconds')::interval THEN 'stale'
                 ELSE 'online'
               END AS state
          FROM customer_equipment
         WHERE device_uid IS NOT NULL
      ) next
     WHERE ce.id = next.id
       AND ce.connection_state IS DISTINCT FROM next.state`);
  return rowCount;
}

async function sweepStaleRules() {
  const { rows: due } = await pool.query(`
    SELECT r.id AS rule_id, r.severity, r.stale_secs,
           ce.id AS equipment_id, ce.company_id, ce.last_seen_at
      FROM device_alert_rules r
      JOIN customer_equipment ce
        ON (r.equipment_id = ce.id OR (r.equipment_id IS NULL AND ce.company_id = r.company_id))
     WHERE r.is_active = TRUE
       AND r.operator = 'stale'
       AND ce.device_uid IS NOT NULL
       AND ce.last_seen_at IS NOT NULL
       AND ce.last_seen_at < NOW() - (COALESCE(r.stale_secs, 900) || ' seconds')::interval`);

  let opened = 0, tickets = 0;
  for (const d of due) {
    const mins = Math.round((d.stale_secs == null ? 900 : Number(d.stale_secs)) / 60);
    const { opened: n, ticketId } = await raiseAlert(pool, {
      companyId: d.company_id ?? 1, equipmentId: d.equipment_id, ruleId: d.rule_id,
      metric: 'heartbeat', value: null, severity: d.severity || 'critical',
      message: `device silent for over ${mins} min (last seen ${new Date(d.last_seen_at).toISOString()})`,
    });
    opened += n; if (ticketId) tickets += 1;
  }
  return { opened, tickets };
}

async function runSweep() {
  try {
    const changed = await sweepConnectionState();
    const { opened, tickets } = await sweepStaleRules();
    if (changed || opened) {
      console.log(`[iotMonitor] state changes: ${changed} | stale alerts opened: ${opened} | tickets: ${tickets}`);
    }
  } catch (e) {
    console.error('[iotMonitor] sweep failed:', e.message);
  }
}

export function startIotMonitorCron() {
  cron.schedule('*/5 * * * *', () => { runSweep(); });
  console.log('📡 IoT device monitor cron started — every 5 min (state aging + stale alerts)');
}

// Exported for tests / manual invocation.
export { runSweep };
