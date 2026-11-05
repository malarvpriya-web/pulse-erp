/**
 * deviceEvents.js — the event history that makes uptime, MTBF, MTTR and SLA
 * computable.
 *
 * WHY THIS EXISTS
 * ---------------
 * The fleet page showed "Online / Offline / Stale" from customer_equipment
 * .connection_state, which is a SNAPSHOT: the cron overwrites it in place. Any
 * figure that needs to know how long a device was down, how often it failed, or
 * how quickly it was repaired cannot be derived from a column that only ever
 * holds "now". MTBF and MTTR computed from a snapshot are fiction, so they were
 * simply absent — correctly.
 *
 * This table records the transitions. The metrics in serviceKpis.js are computed
 * from it, and refuse to answer when the history is too short to support the
 * answer.
 */

/**
 * Append one event. Cheap and append-only; safe inside a transaction.
 *
 * @param {object} db pool or transaction client
 */
export async function recordEvent(db, { companyId, equipmentId, eventType, occurredAt = null, source = 'system', alertId = null, ticketId = null, detail = null }) {
  try {
    const { rows } = await db.query(
      `INSERT INTO iot_device_events
         (company_id, equipment_id, event_type, occurred_at, source, alert_id, ticket_id, detail)
       VALUES ($1,$2,$3,COALESCE($4::timestamptz, NOW()),$5,$6,$7,$8::jsonb)
       RETURNING id`,
      [companyId, equipmentId, eventType, occurredAt, source, alertId, ticketId,
       detail == null ? null : JSON.stringify(detail)],
    );
    return rows[0]?.id ?? null;
  } catch (e) {
    // An event-history write must never break the operation that caused it, but
    // it must also not disappear silently — the log line is the trail.
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN', event: 'iot_device_event_failed',
      equipment_id: equipmentId, event_type: eventType, message: e.message,
    }));
    return null;
  }
}

/**
 * Record a connection-state transition, but only when it is actually a change.
 * The monitor cron calls this for every device it re-states; writing an event per
 * sweep would turn a 5-minute cron into 288 meaningless rows per device per day
 * and make MTBF meaningless.
 */
export async function recordStateChange(db, { companyId, equipmentId, from, to, occurredAt = null }) {
  if (from === to) return null;
  const map = {
    online: 'ONLINE', offline: 'OFFLINE', stale: 'STALE', never: 'NEVER_CONNECTED',
  };
  const eventType = map[to];
  if (!eventType) return null;
  return recordEvent(db, {
    companyId, equipmentId, eventType, occurredAt, source: 'monitor_cron',
    detail: { from, to },
  });
}
