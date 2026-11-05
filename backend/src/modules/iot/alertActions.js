/**
 * alertActions.js — the outbox HANDLERS: what an alert event turns into.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT CHANGED
 * ---------------------------------------------
 * It used to be called from inside the ingest transaction and carried this
 * comment: "never throws — a ticket failure must not roll back the telemetry
 * write". The intention was right and the mechanism could not deliver it: a
 * statement that raises inside a Postgres transaction ABORTS the transaction, so
 * catching the JavaScript error changes nothing — every subsequent statement
 * fails with 25P02, including the ones the ingest handler ran next. A ticket
 * failure therefore took down the whole telemetry batch, which is precisely what
 * the comment promised would not happen.
 *
 * Now these run in a worker, after the telemetry has committed, against the pool.
 * They may throw: the outbox retries with backoff and eventually dead-letters,
 * and the telemetry is untouched either way.
 *
 * IDEMPOTENCY
 * Delivery is at-least-once. Every handler re-checks the artefact it would create
 * (`device_alerts.ticket_id IS NULL`) so a redelivery cannot produce a second
 * ticket for the same incident.
 */

import { recordEvent } from './deviceEvents.js';
import { notifyAlert } from './notify.js';

const PRIORITY = { critical: 'High', warning: 'Medium', info: 'Low' };

/**
 * Create the service breakdown ticket for an alert.
 *
 * Field devices live in customer_equipment, which is SERVICE's domain rather than
 * the factory maintenance module (maintenance_logs.asset_id references
 * assets_register, a different table). So a telemetry alert raises a
 * support_tickets row with ticket_kind='service' — the same breakdown-call
 * surface service engineers already work — carrying the device's project, serial
 * and AMC so the ticket is actionable on arrival.
 */
async function createServiceTicket(db, alert, equipment) {
  const title = `[IoT] ${equipment.equipment_name || 'Device'} — ${alert.message}`.slice(0, 255);
  const description = [
    'Auto-raised from device telemetry.',
    `Incident: ${alert.incident_uid}`,
    `Metric: ${alert.metric} = ${alert.observed_value ?? alert.value}${alert.unit ? ' ' + alert.unit : ''}`,
    `Threshold: ${alert.threshold ?? 'n/a'}`,
    `Severity: ${alert.severity}`,
    `First detected: ${alert.first_detected_at ?? alert.opened_at}`,
    `Alert #${alert.id}`,
  ].join('\n');

  // category_id is linked to the ticket-category master the same way every
  // other ticket's is (LOWER(BTRIM(name)), the master's unique key), so a
  // rename of 'Breakdown' follows these tickets. The row is seeded by
  // 20261014000005; if it is ever absent or deactivated the link is simply
  // NULL — the ticket is still raised, exactly as before.
  const { rows } = await db.query(
    `INSERT INTO support_tickets
       (ticket_number, title, description, category, priority, status, ticket_kind,
        company_id, project_id, serial_number, amc_contract_id, customer_id,
        service_type, requester_name, channel, category_id)
     VALUES ('IPS-' || LPAD(nextval('seq_ips')::text, 5, '0'),
             $1, $2, 'Breakdown', $3, 'Open', 'service',
             $4, $5, $6, $7, $8, 'Remote Alert', 'IoT Monitor', 'iot',
             (SELECT id FROM ticket_categories
               WHERE LOWER(BTRIM(name)) = 'breakdown' AND is_active = true
               ORDER BY id LIMIT 1))
     RETURNING id, ticket_number`,
    [title, description, PRIORITY[alert.severity] || 'Medium',
     equipment.company_id, equipment.project_id ?? null, equipment.serial_number ?? null,
     equipment.amc_contract_id ?? null, equipment.crm_account_id ?? null],
  );
  return rows[0];
}

/**
 * Handle `alert.opened`.
 *
 * Throws on failure — that is the contract with the outbox. Returns a summary of
 * what it did so the worker can log it.
 */
export async function handleAlertOpened(db, payload) {
  const alertId = payload.alert_id;

  const { rows: alerts } = await db.query(
    `SELECT da.*, ce.equipment_name, ce.company_id AS eq_company_id, ce.project_id,
            ce.serial_number, ce.amc_contract_id, ce.crm_account_id
       FROM device_alerts da
       JOIN customer_equipment ce ON ce.id = da.equipment_id
      WHERE da.id = $1`, [alertId]);
  if (!alerts.length) {
    // The alert was deleted between enqueue and delivery. Nothing to do, and
    // retrying will never help — treat as done.
    return { skipped: 'alert no longer exists' };
  }
  const alert = alerts[0];

  const out = { alert_id: alertId, ticket_id: alert.ticket_id ?? null, notified: 0 };

  // ── service ticket ──────────────────────────────────────────────────────────
  // Only for conditions that warrant a dispatch, and only once per incident.
  const wantsTicket = payload.create_ticket !== false && alert.severity === 'critical';
  if (wantsTicket && !alert.ticket_id && alert.state !== 'resolved') {
    const ticket = await createServiceTicket(db, alert, {
      equipment_name: alert.equipment_name,
      company_id: alert.eq_company_id,
      project_id: alert.project_id,
      serial_number: alert.serial_number,
      amc_contract_id: alert.amc_contract_id,
      crm_account_id: alert.crm_account_id,
    });
    // Conditional UPDATE: if a concurrent redelivery already linked a ticket, this
    // writes nothing and we have created one spare ticket rather than corrupting
    // the link. The unique dedupe_key makes that race very unlikely; the guard
    // makes it harmless.
    const { rowCount } = await db.query(
      `UPDATE device_alerts SET ticket_id = $2 WHERE id = $1 AND ticket_id IS NULL`,
      [alertId, ticket.id]);
    if (rowCount) {
      out.ticket_id = ticket.id;
      out.ticket_number = ticket.ticket_number;
      await recordEvent(db, {
        companyId: alert.company_id, equipmentId: alert.equipment_id,
        eventType: 'SERVICE_STARTED', alertId, ticketId: ticket.id, source: 'outbox',
        detail: { ticket_number: ticket.ticket_number, incident_uid: alert.incident_uid },
      });
    }
  }

  // ── notifications, across every channel the deployment can deliver ──────────
  // An alert row is not a notification. Until 2026-09-15 this delivered in-app
  // only, and a rule asking for SMS on a critical trip did nothing at all.
  // notify.js now fans out to in-app, push, email and SMS through the senders the
  // rest of Pulse already uses, and RECORDS each attempt in iot_notification_log
  // — so "the engineer was not told" is visible rather than assumed.
  const delivery = await notifyAlert(db, {
    companyId: alert.company_id,
    alertId,
    severity: alert.severity,
    metric: alert.metric,
    title: `${alert.severity === 'critical' ? 'Critical' : 'Warning'}: ${alert.equipment_name}`,
    message: alert.message,
    link: `/iot/alert-center?alert=${alertId}`,
    ruleChannels: payload.notify_channels || ['in_app'],
    ruleRoles: payload.notify_roles || [],
    ruleUserIds: payload.notify_user_ids || [],
    escalation: !!payload.escalation,
  });
  out.notified = delivery.recipients;
  out.delivery = delivery;

  return out;
}

/** Handle `alert.resolved`. Records the service completion; does not close tickets. */
export async function handleAlertResolved(db, payload) {
  const { rows } = await db.query(
    `SELECT da.*, ce.equipment_name FROM device_alerts da
       JOIN customer_equipment ce ON ce.id = da.equipment_id WHERE da.id = $1`,
    [payload.alert_id]);
  if (!rows.length) return { skipped: 'alert no longer exists' };
  const alert = rows[0];

  // Deliberately does NOT close the service ticket. The telemetry recovering says
  // the CONDITION cleared; it does not say the repair is finished, the parts are
  // fitted or the paperwork is done. Closing an engineer's ticket from a sensor
  // reading would lose that work. The ticket is annotated instead.
  if (alert.ticket_id) {
    await db.query(
      `UPDATE support_tickets
          SET description = COALESCE(description,'') || $2
        WHERE id = $1`,
      [alert.ticket_id,
       `\n\n[IoT ${new Date().toISOString()}] Telemetry recovered: ${alert.metric} returned to a non-breaching value. The alert is resolved; this ticket remains open for the engineer to close.`],
    );
  }

  // Tell whoever was told about the breach that it cleared. Without this, an
  // engineer paged at 02:00 has no way to learn the condition recovered except
  // by opening the app.
  const delivery = await notifyAlert(db, {
    companyId: alert.company_id,
    alertId: alert.id,
    severity: alert.severity,
    metric: alert.metric,
    resolved: true,
    title: `Resolved: ${alert.equipment_name}`,
    message: `${alert.metric} returned to normal. ${alert.resolution_reason || ''}`.trim(),
    link: `/iot/alert-center?alert=${alert.id}`,
    ruleChannels: ['in_app'],
    ruleRoles: [],
    ruleUserIds: [],
  });

  return { alert_id: alert.id, ticket_annotated: !!alert.ticket_id, notified: delivery.recipients };
}

export const HANDLERS = {
  'alert.opened': handleAlertOpened,
  'alert.resolved': handleAlertResolved,
};
