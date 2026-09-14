/**
 * iotMonitor.cron.js — keeps device connection state honest, raises stale-device
 * alerts, and closes maintenance windows.
 *
 * Runs every 5 minutes. Four sweeps:
 *
 *  1. CONNECTION STATE. A device is 'online' only while telemetry keeps arriving.
 *     Ingest sets last_seen_at from the RECEIPT time (not the event stamp the
 *     device chose — that is how a sample dated 2099 used to make a dead device
 *     read as online). This cron ages it:
 *        older than 3× the sampling interval  -> 'stale'
 *        older than 12× the sampling interval -> 'offline'
 *     NEVER_CONNECTED is its own state, not a flavour of offline: a device that
 *     has never reported is a commissioning problem, not a fault, and grouping
 *     the two sent engineers to sites where nothing had been installed yet.
 *     Every genuine transition writes an iot_device_events row, which is what
 *     makes MTBF/MTTR/uptime computable at all.
 *
 *  2. STALE RULES. device_alert_rules with operator='stale'. The join now carries
 *     company equality — the previous version joined `r.equipment_id = ce.id OR
 *     (r.equipment_id IS NULL AND ce.company_id = r.company_id)`, so a
 *     device-specific rule matched a device in ANOTHER company whose id happened
 *     to match.
 *
 *  3. MAINTENANCE EXPIRY. A window that has ended writes MAINTENANCE_END so
 *     monitoring resumes and the history is complete.
 *
 *  4. ESCALATION / REPEAT. Live alerts past their rule's escalation delay are
 *     re-notified through the outbox, once, and marked.
 */

import cron from 'node-cron';
import pool from '../config/db.js';
import { enqueue } from '../modules/iot/outbox.js';
import { recordEvent, recordStateChange } from '../modules/iot/deviceEvents.js';
import { inMaintenance } from '../modules/iot/alertEngine.js';

const LIVE = `('pending_confirmation','active','acknowledged','recovery_pending')`;

/**
 * Age connection state. Returns the transitions so each can be recorded as an
 * event — a state column tells you where a device is now; the events tell you
 * where it has been, and only the second supports a service KPI.
 */
async function sweepConnectionState() {
  const { rows } = await pool.query(`
    SELECT id, company_id, connection_state AS old_state,
           CASE
             WHEN last_seen_at IS NULL THEN 'never'
             WHEN last_seen_at < NOW() - (COALESCE(sampling_secs, 300) * 12 || ' seconds')::interval THEN 'offline'
             WHEN last_seen_at < NOW() - (COALESCE(sampling_secs, 300) * 3  || ' seconds')::interval THEN 'stale'
             ELSE 'online'
           END AS new_state
      FROM customer_equipment
     WHERE device_uid IS NOT NULL
       AND device_status = 'active'`);

  const changed = rows.filter((r) => r.old_state !== r.new_state);
  if (!changed.length) return { changed: 0 };

  for (const r of changed) {
    await pool.query(`UPDATE customer_equipment SET connection_state = $2 WHERE id = $1`, [r.id, r.new_state]);
    // A device inside a maintenance window still changes state, but the
    // transition is tagged so it can be excluded from uptime.
    const maint = await inMaintenance(pool, r.id);
    await recordStateChange(pool, {
      companyId: r.company_id, equipmentId: r.id,
      from: r.old_state, to: r.new_state,
    });
    if (maint && r.new_state !== 'online') {
      await recordEvent(pool, {
        companyId: r.company_id, equipmentId: r.id, eventType: 'MAINTENANCE_START',
        source: 'monitor_cron', detail: { note: 'state change occurred during a maintenance window', window_id: maint.id },
      });
    }
  }
  return { changed: changed.length };
}

async function sweepStaleRules() {
  // Company equality is in the join on BOTH branches. A device-specific rule now
  // requires r.company_id = ce.company_id as well as the id match.
  const { rows: due } = await pool.query(`
    SELECT r.id AS rule_id, r.severity, r.stale_secs, r.create_ticket,
           r.notify_channels, r.notify_roles, r.notify_user_ids, r.suppress_in_maintenance,
           ce.id AS equipment_id, ce.company_id, ce.last_seen_at, ce.equipment_name
      FROM device_alert_rules r
      JOIN customer_equipment ce
        ON ce.company_id = r.company_id
       AND (r.equipment_id = ce.id OR r.equipment_id IS NULL)
     WHERE r.is_active = TRUE
       AND r.operator = 'stale'
       AND ce.device_uid IS NOT NULL
       AND ce.device_status = 'active'
       AND ce.last_seen_at IS NOT NULL
       AND ce.last_seen_at < NOW() - (COALESCE(r.stale_secs, 900) || ' seconds')::interval
       AND NOT EXISTS (
         SELECT 1 FROM device_alerts da
          WHERE da.equipment_id = ce.id AND da.rule_id = r.id AND da.state IN ${LIVE}
       )`);

  let opened = 0, suppressed = 0;
  for (const d of due) {
    if (d.suppress_in_maintenance) {
      const maint = await inMaintenance(pool, d.equipment_id);
      if (maint) { suppressed += 1; continue; }
    }
    const mins = Math.round((d.stale_secs == null ? 900 : Number(d.stale_secs)) / 60);
    const incidentUid = `INC-${Date.now().toString(36).toUpperCase()}-STALE${d.equipment_id}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO device_alerts
           (company_id, equipment_id, rule_id, metric, value, severity, state, message,
            incident_uid, first_detected_at, last_detected_at, opened_at)
         VALUES ($1,$2,$3,'heartbeat',NULL,$4,'active',$5,$6,NOW(),NOW(),NOW())
         ON CONFLICT (equipment_id, rule_id)
           WHERE state IN ('pending_confirmation','active','acknowledged','recovery_pending')
           DO NOTHING
         RETURNING id`,
        [d.company_id, d.equipment_id, d.rule_id, d.severity || 'critical',
         `device silent for over ${mins} min (last seen ${new Date(d.last_seen_at).toISOString()})`,
         incidentUid]);
      if (rows.length) {
        await recordEvent(client, {
          companyId: d.company_id, equipmentId: d.equipment_id, eventType: 'FAULT',
          alertId: rows[0].id, source: 'monitor_cron',
          detail: { kind: 'stale', stale_secs: d.stale_secs, incident_uid: incidentUid },
        });
        await enqueue(client, {
          companyId: d.company_id, topic: 'alert.opened',
          dedupeKey: `alert.opened:${rows[0].id}`,
          payload: {
            alert_id: rows[0].id, incident_uid: incidentUid, rule_id: d.rule_id,
            equipment_id: d.equipment_id, company_id: d.company_id,
            metric: 'heartbeat', severity: d.severity || 'critical',
            create_ticket: d.create_ticket !== false,
            notify_channels: d.notify_channels || ['in_app'],
            notify_roles: d.notify_roles || [], notify_user_ids: d.notify_user_ids || [],
            equipment_name: d.equipment_name,
          },
        });
        opened += 1;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[iotMonitor] stale alert failed:', e.message);
    } finally { client.release(); }
  }
  return { opened, suppressed };
}

/** Close maintenance windows that have ended, so monitoring resumes on its own. */
async function sweepMaintenanceExpiry() {
  const { rows } = await pool.query(`
    SELECT m.id, m.company_id, m.equipment_id, m.ends_at
      FROM iot_maintenance_windows m
     WHERE m.cancelled_at IS NULL
       AND m.ends_at <= NOW()
       AND m.ends_at > NOW() - INTERVAL '1 hour'
       AND NOT EXISTS (
         SELECT 1 FROM iot_device_events e
          WHERE e.equipment_id = m.equipment_id AND e.event_type = 'MAINTENANCE_END'
            AND e.detail->>'window_id' = m.id::text
       )`);
  for (const m of rows) {
    await recordEvent(pool, {
      companyId: m.company_id, equipmentId: m.equipment_id, eventType: 'MAINTENANCE_END',
      occurredAt: m.ends_at, source: 'monitor_cron', detail: { window_id: m.id },
    });
  }
  return { closed: rows.length };
}

/**
 * Escalate live alerts that nobody has acknowledged within the rule's escalation
 * delay. One escalation per incident — a repeat policy exists on the rule but an
 * unacknowledged critical must not become a notification every five minutes.
 */
async function sweepEscalations() {
  const { rows } = await pool.query(`
    SELECT da.id, da.company_id, da.equipment_id, da.metric, da.severity, da.incident_uid,
           r.escalation_mins, r.notify_channels, r.notify_roles, r.notify_user_ids,
           ce.equipment_name
      FROM device_alerts da
      JOIN device_alert_rules r ON r.id = da.rule_id
      JOIN customer_equipment ce ON ce.id = da.equipment_id
     WHERE da.state IN ('pending_confirmation','active')
       AND da.acknowledged_at IS NULL
       AND da.escalated_at IS NULL
       AND r.escalation_mins IS NOT NULL
       AND da.opened_at < NOW() - (r.escalation_mins || ' minutes')::interval
     LIMIT 200`);

  let escalated = 0;
  for (const a of rows) {
    const { enqueued } = await enqueue(pool, {
      companyId: a.company_id, topic: 'alert.opened',
      dedupeKey: `alert.escalate:${a.id}`,
      payload: {
        alert_id: a.id, incident_uid: a.incident_uid, equipment_id: a.equipment_id,
        company_id: a.company_id, metric: a.metric, severity: a.severity,
        create_ticket: false,            // the ticket already exists if it was going to
        notify_channels: a.notify_channels || ['in_app'],
        notify_roles: a.notify_roles || [], notify_user_ids: a.notify_user_ids || [],
        equipment_name: a.equipment_name, escalation: true,
      },
    });
    await pool.query(`UPDATE device_alerts SET escalated_at = NOW() WHERE id = $1`, [a.id]);
    if (enqueued) escalated += 1;
  }
  return { escalated };
}

export async function runSweep() {
  try {
    const conn = await sweepConnectionState();
    const stale = await sweepStaleRules();
    const maint = await sweepMaintenanceExpiry();
    const esc = await sweepEscalations();
    if (conn.changed || stale.opened || maint.closed || esc.escalated) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(), level: 'INFO', event: 'iot_monitor_sweep',
        state_changes: conn.changed, stale_alerts: stale.opened,
        stale_suppressed: stale.suppressed, maintenance_closed: maint.closed,
        escalated: esc.escalated,
      }));
    }
    return { conn, stale, maint, esc };
  } catch (e) {
    console.error('[iotMonitor] sweep failed:', e.message);
    return { error: e.message };
  }
}

export function startIotMonitorCron() {
  cron.schedule('*/5 * * * *', () => { runSweep(); });
  console.log('📡 IoT device monitor cron started — every 5 min (state aging + events + stale alerts + maintenance + escalation)');
}
