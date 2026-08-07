import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import purchaseRequestRepo from '../modules/procurement/repositories/purchaseRequest.repository.js';
import advancedInventoryRepository from '../modules/inventory/repositories/advancedInventory.repository.js';

// Automation Opportunity Audit §5.1 — "Inventory reorder -> auto-draft
// Purchase Request". The audit assumed the trigger would have to be built
// from scratch off inventory_items.current_stock/reorder_point, but
// stockAlerts.js's checkAndCreateAlerts() (called on every stock-ledger
// movement) already detects the reorder breach and writes a pending
// purchase_suggestions row — a human just has to open the Suggestions tab
// and click Convert (POST /purchase-suggestions/:id/convert,
// advancedInventory.routes.js:165) to turn it into a draft PR. That click is
// the actual manual step this closes. This cron runs the same
// create+createItem+recomputeTotal+convertSuggestionToPR transaction the
// button runs, on a schedule instead of a click — reusing it exactly rather
// than re-deriving reorder logic against inventory_items directly.
//
// Dedup is structural, not bolted on: a suggestion converted here flips to
// status='converted_to_pr' inside the same transaction, and
// checkAndCreateAlerts() already skips creating a new suggestion for an
// item/warehouse pair that still has one 'pending' — so nothing can be
// redrafted.

async function getPendingSuggestionsByCompany() {
  const { rows } = await pool.query(
    `SELECT ps.id, ps.item_id, ps.suggested_quantity, ps.priority,
            ii.item_code, ii.item_name, ii.standard_cost, ii.company_id
     FROM purchase_suggestions ps
     JOIN inventory_items ii ON ii.id = ps.item_id
     WHERE ps.status = 'pending'
     ORDER BY ii.company_id NULLS LAST, ps.created_at`
  );

  const byCompany = new Map();
  for (const row of rows) {
    const key = row.company_id ?? 0;
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(row);
  }
  return byCompany;
}

// Draft PRs need a requested_by_employee_id — purchase_requests has its own
// company_id column, but every existing list/filter query (findAll in
// purchaseRequest.repository.js) scopes by joining through
// employees.company_id, not pr.company_id. Leaving it null would make an
// auto-drafted PR invisible to company-scoped procurement users (the same
// NULL-company_id visibility gotcha seen elsewhere in this app). Some pilot
// accounts (e.g. pilot.purchase@manifest.in) have users.company_id NULL with
// the real company only resolvable via their linked employee row, so this
// resolves through employees.company_id rather than users.company_id.
async function getRequesterEmployeeId(companyId) {
  const { rows } = await pool.query(
    `SELECT u.employee_id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND u.employee_id IS NOT NULL
       AND r.code IN ('procurement_manager', 'procurement_exec')
       AND COALESCE(e.company_id, u.company_id) = $1
     ORDER BY CASE r.code WHEN 'procurement_manager' THEN 0 ELSE 1 END, u.id
     LIMIT 1`,
    [companyId]
  );
  return rows[0]?.employee_id ?? null;
}

// users.role is a stale single-value column that pilot procurement accounts
// are stuck on ('user') — real role assignment lives in user_roles, so
// receivers are resolved from there, not from LOWER(role) IN (...) the way
// older reminder crons in this file do.
async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND r.code IN ('procurement_manager', 'procurement_exec', 'admin', 'super_admin')
       AND COALESCE(e.company_id, u.company_id) = $1`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function draftPrFromSuggestion(suggestion, requesterEmployeeId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prNumber = await purchaseRequestRepo.getNextNumber();
    const pr = await purchaseRequestRepo.create(client, {
      request_number: prNumber,
      requested_by_employee_id: requesterEmployeeId,
      request_date: new Date(),
      notes: `Auto-drafted: ${suggestion.item_code || suggestion.item_name} fell to or below its reorder point.`,
    });
    await purchaseRequestRepo.createItem(client, {
      pr_id: pr.id,
      item_id: suggestion.item_id,
      item_name: suggestion.item_name,
      quantity: suggestion.suggested_quantity,
      expected_price: suggestion.standard_cost || 0,
    });
    await purchaseRequestRepo.recomputeTotal(client, pr.id);
    await advancedInventoryRepository.convertSuggestionToPR(suggestion.id, pr.id, client);
    await client.query('COMMIT');
    return pr;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertSummaryReminder(userId, companyId, count) {
  // de-dup: one digest per company per day, not per PR
  const dup = await pool.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1
       AND module_name = 'procurement'
       AND reference_id = $2
       AND notification_type = 'reorder_draft_prs'
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, companyId]
  );
  if (dup.rows.length) return;

  await notificationsRepository.create({
    user_id: userId,
    title: `${count} Draft Purchase Request${count === 1 ? '' : 's'} Awaiting Review`,
    message: `${count} item${count === 1 ? '' : 's'} fell to or below reorder point and ${count === 1 ? 'was' : 'were'} auto-drafted into a Purchase Request (status: draft). Review before submitting for approval.`,
    module_name: 'procurement',
    reference_id: companyId,
    notification_type: 'reorder_draft_prs',
  });
}

async function runReorderPrCheck() {
  const byCompany = await getPendingSuggestionsByCompany();
  if (!byCompany.size) return;

  for (const [companyId, suggestions] of byCompany) {
    const requesterEmployeeId = await getRequesterEmployeeId(companyId);
    if (!requesterEmployeeId) {
      console.warn(
        `[reorderPrCron] company ${companyId}: no active procurement_manager/procurement_exec with a linked employee record — skipping ${suggestions.length} pending suggestion(s)`
      );
      continue;
    }

    let drafted = 0;
    for (const suggestion of suggestions) {
      try {
        await draftPrFromSuggestion(suggestion, requesterEmployeeId);
        drafted++;
      } catch (err) {
        console.error(`[reorderPrCron] failed to draft PR for suggestion ${suggestion.id}:`, err.message);
      }
    }
    if (!drafted) continue;

    const receivers = await getReceivers(companyId);
    for (const userId of receivers) {
      await insertSummaryReminder(userId, companyId, drafted);
    }
  }
}

export function startReorderPrCron() {
  // Daily at 10:15 server local time — after the 09:xx reminder crons and
  // after checkAndCreateAlerts() has had the day's stock movements land.
  cron.schedule('15 10 * * *', () => {
    runReorderPrCheck().catch((err) => console.error('[reorderPrCron] failed:', err.message));
  });
  console.log('📦 Reorder auto-draft PR cron started (daily 10:15)');
}

export { runReorderPrCheck as runReorderPrCheckNow };
