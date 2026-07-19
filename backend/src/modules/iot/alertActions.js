/**
 * alertActions.js — the single writer that turns a rule breach into a device
 * alert and, for critical alerts, a real service breakdown ticket.
 *
 * Shared by BOTH the ingest path (ingest.routes.js, inside its transaction) and
 * the monitor cron (iotMonitor.cron.js, against the pool), so the "what happens
 * when an alert fires" logic lives in exactly one place. `db` is any object with
 * .query() — a pool or a transaction client.
 *
 * Field devices live in customer_equipment, which is SERVICE's domain, not the
 * factory maintenance module (maintenance_logs.asset_id references
 * assets_register, a different table). So a telemetry alert raises a
 * support_tickets row with ticket_kind='service' — the same breakdown-call
 * surface service engineers already work — carrying the device's project,
 * serial and AMC so the ticket is actionable.
 */

const PRIORITY = { critical: 'High', warning: 'Medium', info: 'Low' };

/**
 * Create a service breakdown ticket for a device alert.
 * Returns the new ticket id, or null on failure (never throws — a ticket
 * failure must not roll back the telemetry write that triggered it).
 */
async function createServiceTicket(db, { equipment, alertId, metric, value, severity, message }) {
  try {
    const title = `[IoT] ${equipment.equipment_name || 'Device'} — ${message}`.slice(0, 255);
    const { rows } = await db.query(
      `INSERT INTO support_tickets
         (ticket_number, title, description, category, priority, status, ticket_kind,
          company_id, project_id, serial_number, amc_contract_id, service_type, requester_name)
       VALUES ('IPS-' || LPAD(nextval('seq_ips')::text, 5, '0'),
               $1, $2, 'Breakdown', $3, 'Open', 'service',
               $4, $5, $6, $7, 'Remote Alert', 'IoT Monitor')
       RETURNING id`,
      [
        title,
        `Auto-raised from device telemetry.\nMetric ${metric} = ${value}\nSeverity: ${severity}\nAlert #${alertId}`,
        PRIORITY[severity] || 'Medium',
        equipment.company_id ?? 1,
        equipment.project_id ?? null,
        equipment.serial_number ?? null,
        equipment.amc_contract_id ?? null,
      ],
    );
    const ticketId = rows[0].id;
    await db.query(`UPDATE device_alerts SET ticket_id = $2 WHERE id = $1`, [alertId, ticketId]);
    return ticketId;
  } catch (e) {
    console.error('[iot alertActions] ticket creation failed:', e.message);
    return null;
  }
}

/**
 * Open one alert for a (device, rule) breach and, if it's critical, spawn a
 * service ticket. Idempotent: the partial unique index uq_device_alerts_open
 * makes the INSERT a no-op while an unresolved alert already exists for the
 * pair, so repeat breaches don't flood alerts or tickets.
 *
 * @returns {Promise<{opened: 0|1, alertId: number|null, ticketId: number|null}>}
 */
export async function raiseAlert(db, { companyId, equipmentId, ruleId, metric, value, severity, message }) {
  const { rows } = await db.query(
    `INSERT INTO device_alerts (company_id, equipment_id, rule_id, metric, value, severity, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (equipment_id, rule_id) WHERE state <> 'resolved' DO NOTHING
     RETURNING id`,
    [companyId, equipmentId, ruleId, metric, value ?? null, severity, message],
  );
  if (!rows.length) return { opened: 0, alertId: null, ticketId: null };

  const alertId = rows[0].id;
  let ticketId = null;
  if (severity === 'critical') {
    const { rows: eqRows } = await db.query(
      `SELECT id, equipment_name, company_id, project_id, serial_number, amc_contract_id
         FROM customer_equipment WHERE id = $1`,
      [equipmentId],
    );
    if (eqRows.length) {
      ticketId = await createServiceTicket(db, { equipment: eqRows[0], alertId, metric, value, severity, message });
    }
  }
  return { opened: 1, alertId, ticketId };
}
