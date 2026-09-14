import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { sendWhatsAppMessage } from '../modules/integrations/whatsapp.routes.js';
import { scheduled } from './jobRun.js';

const REMINDER_DAYS = parseInt(process.env.AMC_RENEWAL_REMINDER_DAYS || '30', 10);

/**
 * Receivers for one company.
 *
 * This used to select every active admin/manager/service_manager in the
 * database with no company predicate, and the caller then sent each of them a
 * reminder naming another tenant's customer and contract — and, below, pushed
 * that same customer name out over WhatsApp through the real Meta Graph API, so
 * the disclosure left the building. A cron has no HTTP endpoint, so no tenant
 * sweep driven from a foreign token could reach this.
 *
 * users.role is a stale single-value column — real role assignment lives in
 * user_roles, and the company resolves through the linked employee first
 * because pilot accounts carry users.company_id IS NULL.
 */
async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND r.code IN ('service_manager', 'manager', 'admin', 'super_admin')
       AND COALESCE(e.company_id, u.company_id) = $1`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

// Automation Opportunity Audit §29.2 — whatsapp.routes.js's send implementation
// is real (Meta Graph API) but had zero callers; AMC renewal is the audit's
// own suggested pilot flow. Reuses the same once-per-day dedup as the in-app
// insert below (this only runs when that insert wasn't already a no-op), so
// it can't double-send even if the cron somehow fires twice in a day.
async function getReceiverPhone(userId) {
  const { rows } = await pool.query(
    `SELECT e.phone FROM users u JOIN employees e ON e.id = u.employee_id WHERE u.id = $1 AND e.phone IS NOT NULL`,
    [userId]
  );
  return rows[0]?.phone || null;
}

async function insertReminder(userId, contract, notificationType) {
  // de-dup for the same contract / user / day
  const dup = await pool.query(
    `SELECT 1
     FROM notifications
     WHERE user_id = $1
       AND module_name = 'service'
       AND reference_id = $2
       AND notification_type = $3
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, contract.id, notificationType]
  );
  if (dup.rows.length) return false;

  await notificationsRepository.create({
    user_id: userId,
    title: `AMC Renewal Due in ${contract.days_left} Day${contract.days_left === 1 ? '' : 's'}`,
    message: `${contract.contract_type || 'AMC'} contract ${contract.contract_number ? `${contract.contract_number} ` : ''}for ${contract.customer_name} expires on ${contract.end_date}. Renew soon.`,
    module_name: 'service',
    reference_id: contract.id,
    notification_type: notificationType,
  });

  const phone = await getReceiverPhone(userId);
  if (phone) {
    await sendWhatsAppMessage({
      to: phone,
      template_name: 'amc_renewal_due',
      template_params: [contract.customer_name, contract.end_date, String(contract.days_left)],
    }).catch(() => {});
  }
  return true;
}

/**
 * Group rows by the tenant that owns them. A contract with no company_id cannot
 * be routed to a tenant's staff, and routing it to everyone is the leak this
 * exists to close — so it is counted and skipped.
 */
function groupByCompany(rows) {
  const byCompany = new Map();
  let unattributed = 0;
  for (const row of rows) {
    if (row.company_id === null || row.company_id === undefined) {
      unattributed++;
      continue;
    }
    if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, []);
    byCompany.get(row.company_id).push(row);
  }
  return { byCompany, unattributed };
}

// `service_contracts` (manual-entry, ServiceContracts.jsx) and `amc_contracts`
// (the lifecycle/commissioning-driven system-of-record, linked to
// sales_order_id/project_id/commissioning_workflow_id) are two disconnected
// AMC stores — see [[project_enterprise_workflow_audit]]. Checking only one
// would silently miss whichever the caller didn't populate, so both are
// checked here with distinct notification_type values (their integer ids
// aren't unique across the two tables, so the types must differ to dedup
// correctly).
//
// ⚠ The status compare is case-insensitive. It used to read `status = 'Active'`
// with a capital A, and every row in this table stores 'active' — so this half
// of the job matched ZERO rows and had never sent a single reminder, while five
// live contracts sat inside the renewal window. Same class as the vendor-status
// case drift: the read layer lowercases, the writer did not.
async function fetchExpiringServiceContracts() {
  const { rows } = await pool.query(
    `SELECT id, company_id, customer_name, contract_type, end_date::date AS end_date,
            (end_date::date - CURRENT_DATE) AS days_left
     FROM service_contracts
     WHERE LOWER(status) = 'active'
       AND end_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY company_id, end_date ASC`,
    [REMINDER_DAYS]
  );
  return rows;
}

async function fetchExpiringAmcContracts() {
  const { rows } = await pool.query(
    `SELECT ac.id, ac.company_id, ac.contract_number,
            COALESCE(p.customer_name, ac.product_name, 'Unknown customer') AS customer_name,
            'AMC' AS contract_type, ac.end_date::date AS end_date,
            (ac.end_date::date - CURRENT_DATE) AS days_left
     FROM amc_contracts ac
     LEFT JOIN projects p ON p.id = ac.project_id
     WHERE LOWER(ac.status) = 'active'
       AND ac.deleted_at IS NULL
       AND ac.end_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')
     ORDER BY ac.company_id, ac.end_date ASC`,
    [REMINDER_DAYS]
  );
  return rows;
}

async function runAmcRenewalCheck() {
  const [serviceRows, amcRows] = await Promise.all([
    fetchExpiringServiceContracts(),
    fetchExpiringAmcContracts(),
  ]);
  const sc = groupByCompany(serviceRows);
  const ac = groupByCompany(amcRows);

  // Counters, not row content — see jobRun.js. No customer name reaches a log.
  const counters = {
    companies: new Set([...sc.byCompany.keys(), ...ac.byCompany.keys()]).size,
    service_contracts: serviceRows.length - sc.unattributed,
    amc_contracts: amcRows.length - ac.unattributed,
    notified: 0,
    skipped: sc.unattributed + ac.unattributed,
  };
  if (counters.skipped) {
    console.warn(`[amcRenewalCron] ${counters.skipped} expiring contract(s) have no company_id — not routed`);
  }

  const companies = new Set([...sc.byCompany.keys(), ...ac.byCompany.keys()]);
  for (const companyId of companies) {
    const receivers = await getReceivers(companyId);
    if (!receivers.length) {
      const n = (sc.byCompany.get(companyId)?.length ?? 0) + (ac.byCompany.get(companyId)?.length ?? 0);
      console.warn(`[amcRenewalCron] company ${companyId}: no active service/admin receiver — skipping ${n} expiring contract(s)`);
      counters.skipped += n;
      continue;
    }

    for (const contract of sc.byCompany.get(companyId) ?? []) {
      for (const userId of receivers) {
        if (await insertReminder(userId, contract, 'amc_renewal')) counters.notified++;
      }
    }
    for (const contract of ac.byCompany.get(companyId) ?? []) {
      for (const userId of receivers) {
        if (await insertReminder(userId, contract, 'amc_contract_renewal')) counters.notified++;
      }
    }
  }
  return counters;
}

export function startAmcRenewalCron() {
  // Daily at 09:00 server local time
  cron.schedule('0 9 * * *', scheduled('amcRenewal', runAmcRenewalCheck));
  console.log(`🔧 AMC renewal cron started (daily 09:00, reminder window ${REMINDER_DAYS} days before expiry)`);
}

export { runAmcRenewalCheck as runAmcRenewalCheckNow };
