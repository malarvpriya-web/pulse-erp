import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { sqlInvoiceOutstanding, sqlBillOutstanding } from '../shared/statusSets.js';
import { scheduled } from './jobRun.js';

/**
 * Receivers for one company.
 *
 * This used to select every active admin/finance user in the database with no
 * company predicate at all, and the caller then sent each of them a reminder
 * naming an invoice number, a customer or vendor, and an outstanding rupee
 * balance. That is a cross-tenant disclosure of the finance ledger, and it was
 * invisible to the isolation sweeps because a cron has no HTTP endpoint for a
 * foreign token to call.
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
       AND r.code IN ('finance_manager', 'finance', 'admin', 'super_admin')
       AND COALESCE(e.company_id, u.company_id) = $1`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function insertReminder(userId, { type, referenceId, title, message }) {
  // de-dup for the same record / user / day
  const dup = await pool.query(
    `SELECT 1
     FROM notifications
     WHERE user_id = $1
       AND module_name = 'finance'
       AND reference_id = $2
       AND notification_type = $3
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, referenceId, type]
  );
  if (dup.rows.length) return false;

  await notificationsRepository.create({
    user_id: userId,
    title,
    message,
    module_name: 'finance',
    reference_id: referenceId,
    notification_type: type,
  });
  return true;
}

/**
 * Group rows by the tenant that owns them. A row with no company_id cannot be
 * routed to a tenant's staff, and routing it to everyone is the leak this
 * function exists to close — so it is counted and skipped.
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

/**
 * The outstanding predicate is the shared one, not a hand-written exclusion.
 * `LOWER(status) NOT IN ('paid','cancelled')` missed the rest of INVOICE_VOID
 * ('void', 'draft'), so an unissued draft past its due date would be chased as
 * a real receivable. No such row exists in this database today, which is what
 * makes it worth fixing now rather than after one appears.
 */
async function fetchOverdueInvoices() {
  const { rows } = await pool.query(
    `SELECT id, company_id, invoice_number, COALESCE(party_name, 'Unknown customer') AS party_name,
            due_date::date AS due_date, COALESCE(balance, 0) AS balance
     FROM invoices
     WHERE deleted_at IS NULL
       AND ${sqlInvoiceOutstanding('status')}
       AND due_date::date < CURRENT_DATE
       AND COALESCE(balance, 0) > 0
     ORDER BY company_id, due_date ASC`
  );
  return rows;
}

async function fetchOverdueBills() {
  const { rows } = await pool.query(
    `SELECT id, company_id, bill_number, COALESCE(party_name, 'Unknown vendor') AS party_name,
            due_date::date AS due_date, COALESCE(balance, 0) AS balance
     FROM bills
     WHERE deleted_at IS NULL
       AND ${sqlBillOutstanding('status')}
       AND due_date::date < CURRENT_DATE
       AND COALESCE(balance, 0) > 0
     ORDER BY company_id, due_date ASC`
  );
  return rows;
}

const money = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

async function runOverdueCheck() {
  const [invoices, bills] = await Promise.all([fetchOverdueInvoices(), fetchOverdueBills()]);
  const ar = groupByCompany(invoices);
  const ap = groupByCompany(bills);

  // Counters, not row content — see jobRun.js. No invoice number, party name or
  // amount reaches a log line.
  const counters = {
    companies: new Set([...ar.byCompany.keys(), ...ap.byCompany.keys()]).size,
    ar: invoices.length - ar.unattributed,
    ap: bills.length - ap.unattributed,
    notified: 0,
    skipped: ar.unattributed + ap.unattributed,
  };
  if (counters.skipped) {
    console.warn(`[overdueRemindersCron] ${counters.skipped} overdue row(s) have no company_id — not routed`);
  }

  const companies = new Set([...ar.byCompany.keys(), ...ap.byCompany.keys()]);
  for (const companyId of companies) {
    const receivers = await getReceivers(companyId);
    if (!receivers.length) {
      const n = (ar.byCompany.get(companyId)?.length ?? 0) + (ap.byCompany.get(companyId)?.length ?? 0);
      console.warn(`[overdueRemindersCron] company ${companyId}: no active finance/admin receiver — skipping ${n} overdue record(s)`);
      counters.skipped += n;
      continue;
    }

    for (const inv of ar.byCompany.get(companyId) ?? []) {
      for (const userId of receivers) {
        const sent = await insertReminder(userId, {
          type: 'ar_overdue',
          referenceId: inv.id,
          title: 'Receivable Overdue',
          message: `Invoice ${inv.invoice_number} for ${inv.party_name} is ${money(inv.balance)} overdue (due ${inv.due_date}).`,
        });
        if (sent) counters.notified++;
      }
    }

    for (const bill of ap.byCompany.get(companyId) ?? []) {
      for (const userId of receivers) {
        const sent = await insertReminder(userId, {
          type: 'ap_overdue',
          referenceId: bill.id,
          title: 'Payable Overdue',
          message: `Bill ${bill.bill_number} for ${bill.party_name} is ${money(bill.balance)} overdue (due ${bill.due_date}).`,
        });
        if (sent) counters.notified++;
      }
    }
  }
  return counters;
}

export function startOverdueRemindersCron() {
  // Daily at 09:00 server local time
  cron.schedule('0 9 * * *', scheduled('overdueReminders', runOverdueCheck));
  console.log('💰 AR/AP overdue reminder cron started (daily 09:00)');
}

export { runOverdueCheck as runOverdueCheckNow };
