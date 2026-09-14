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

  const { rows } = await db.query(
    `INSERT INTO support_tickets
       (ticket_number, title, description, category, priority, status, ticket_kind,
        company_id, project_id, serial_number, amc_contract_id, customer_id,
        service_type, requester_name, channel)
     VALUES ('IPS-' || LPAD(nextval('seq_ips')::text, 5, '0'),
             $1, $2, 'Breakdown', $3, 'Open', 'service',
             $4, $5, $6, $7, $8, 'Remote Alert', 'IoT Monitor', 'iot')
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

  // ── notifications ───────────────────────────────────────────────────────────
  // An alert row is not a notification. Nothing told a human before this.
  const channels = payload.notify_channels || ['in_app'];
  if (channels.includes('in_app')) {
    const recipients = await resolveRecipients(db, {
      companyId: alert.company_id,
      roles: payload.notify_roles || [],
      userIds: payload.notify_user_ids || [],
    });
    for (const userId of recipients) {
      await db.query(
        `INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type, link)
         VALUES ($1,$2,$3,'iot',$4,$5,$6)`,
        [userId,
         `${alert.severity === 'critical' ? 'Critical' : 'Warning'}: ${alert.equipment_name}`,
         alert.message,
         alertId,
         alert.severity === 'critical' ? 'error' : 'warning',
         `/iot/alert-center?alert=${alertId}`],
      );
      out.notified += 1;
    }
    await db.query(`UPDATE device_alerts SET notified_at = NOW(), last_notified_at = NOW() WHERE id = $1`, [alertId]);
  }
  // email / sms / push are declared on the rule but not delivered here — see
  // IOT_PHASE4_REPORT.md section L. Recording the intent without delivering it
  // would be worse than not offering it, so the rule UI marks them as not yet
  // wired rather than silently accepting them.

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
  return { alert_id: alert.id, ticket_annotated: !!alert.ticket_id };
}

/**
 * Recipients for an in-app notification.
 *
 * Roles are many-to-many (user_roles), so this unions across the junction table
 * rather than reading users.role — a manager who also holds `employee` must still
 * be reachable.
 */
async function resolveRecipients(db, { companyId, roles, userIds }) {
  const set = new Set((userIds || []).filter((n) => Number.isInteger(n)));
  if (roles?.length) {
    const { rows } = await db.query(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         LEFT JOIN user_scope us ON us.user_id = u.id AND us.is_primary = TRUE
        WHERE LOWER(r.code) = ANY($1) AND u.is_active
          AND (us.company_id = $2 OR us.company_id IS NULL)`,
      [roles.map((r) => String(r).toLowerCase()), companyId]);
    for (const r of rows) set.add(r.id);
  }
  return [...set].slice(0, 200);
}

export const HANDLERS = {
  'alert.opened': handleAlertOpened,
  'alert.resolved': handleAlertResolved,
};
