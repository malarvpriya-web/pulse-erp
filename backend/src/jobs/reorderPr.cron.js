import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { convertSuggestionToPurchaseRequest } from '../modules/inventory/services/suggestionToPr.service.js';
import { scheduled } from './jobRun.js';

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
// ⚠ THE DEDUP CLAIM THAT USED TO BE HERE WAS WRONG, and it is worth recording why
// because it reads as sound. It said: "a suggestion converted here flips to
// status='converted_to_pr' inside the same transaction, and checkAndCreateAlerts()
// already skips creating a new suggestion for an item/warehouse pair that still
// has one 'pending' — so nothing can be redrafted."
//
// The second half is true and does prevent a duplicate SUGGESTION. The first half
// does not prevent a duplicate REQUISITION. A status flip inside a transaction only
// excludes a concurrent writer if that writer reads the row under a lock, and
// neither this job nor the Convert button did: both took a plain SELECT. In READ
// COMMITTED (this database's default) two transactions both see 'pending', both
// insert a requisition, and the second UPDATE overwrites `converted_to_pr_id` —
// leaving the FIRST requisition in the register attributable to nothing. The cron
// racing a human's click is the realistic path, and two app instances both running
// crons is the other.
//
// Dedup is NOW structural, in the database: `uq_pr_source_suggestion` (migration
// 20260926000011) makes a second requisition for one suggestion a unique violation.
// See suggestionToPr.service.js.

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

/**
 * Draft one requisition from one suggestion.
 *
 * ⚠ THIS NO LONGER OWNS THE TRANSACTION. It used to hold a near-copy of the
 * Convert button's handler — the same getNextNumber → create → createItem →
 * recomputeTotal → convertSuggestionToPR sequence, written out twice. Both copies
 * read the suggestion without a lock and neither re-checked its status, so the
 * dedup claim in this file's header (the status flip "happens inside the
 * transaction") did not hold: in READ COMMITTED two transactions both see
 * 'pending' and both commit. The cron racing a human's click, or two app
 * instances both running crons, produced two requisitions for one reorder signal
 * — a duplicate order that nothing pointed at.
 *
 * `inventory/services/suggestionToPr.service.js` is now the one implementation,
 * and it takes the row lock, re-checks after it, and is backed by
 * `uq_pr_source_suggestion`. This function keeps the two things that are genuinely
 * the CRON's and not the button's:
 *
 *   - `status: 'draft'`. The notification below tells the reviewer these arrive as
 *     drafts to review before submitting for approval. Without this they are born
 *     'pending_approval' (purchaseRequestRepo.PR_INITIAL_STATUS) — straight into
 *     the approval queue, skipping the review this job says it wants. The Convert
 *     button deliberately keeps the repository default; that difference is real.
 *   - the auto-drafted notes wording.
 *
 * `created: false` (the suggestion was already converted, by a human's click
 * between this job's SELECT and this call) is returned as `null` so the caller can
 * count it as skipped rather than drafted, instead of double-counting somebody
 * else's requisition as this job's output.
 */
async function draftPrFromSuggestion(suggestion, requesterEmployeeId, companyId) {
  const { created, purchase_request } = await convertSuggestionToPurchaseRequest({
    suggestionId: suggestion.id,
    companyId: companyId || null,
    requestedByEmployeeId: requesterEmployeeId,
    status: 'draft',
    notes: `Auto-drafted: ${suggestion.item_code || suggestion.item_name} fell to or below its reorder point.`,
  });
  return created ? purchase_request : null;
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
  // Counters, not row content — see jobRun.js. These answer "did it run and what
  // did it do" without putting an item name or a quantity into a log file.
  const counters = { companies: byCompany.size, suggestions: 0, drafted: 0, skipped: 0, failed: 0, notified: 0 };
  if (!byCompany.size) return counters;

  for (const [companyId, suggestions] of byCompany) {
    counters.suggestions += suggestions.length;
    const requesterEmployeeId = await getRequesterEmployeeId(companyId);
    if (!requesterEmployeeId) {
      console.warn(
        `[reorderPrCron] company ${companyId}: no active procurement_manager/procurement_exec with a linked employee record — skipping ${suggestions.length} pending suggestion(s)`
      );
      counters.skipped += suggestions.length;
      continue;
    }

    let drafted = 0;
    for (const suggestion of suggestions) {
      try {
        const pr = await draftPrFromSuggestion(suggestion, requesterEmployeeId, companyId || null);
        // null = already converted between this run's SELECT and now (a human
        // clicked Convert). Counted as skipped, not drafted: the notification
        // below quotes `drafted`, and telling a reviewer there are N drafts
        // waiting when one of them is somebody else's already-submitted
        // requisition is how the old double-count read.
        if (pr) drafted++; else counters.skipped++;
      } catch (err) {
        counters.failed++;
        console.error(`[reorderPrCron] failed to draft PR for suggestion ${suggestion.id} (company ${companyId}):`, err.message);
      }
    }
    counters.drafted += drafted;
    if (!drafted) continue;

    const receivers = await getReceivers(companyId);
    for (const userId of receivers) {
      await insertSummaryReminder(userId, companyId, drafted);
      counters.notified++;
    }
  }
  return counters;
}

export function startReorderPrCron() {
  // Daily at 10:15 server local time — after the 09:xx reminder crons and
  // after checkAndCreateAlerts() has had the day's stock movements land.
  cron.schedule('15 10 * * *', scheduled('reorderPr', runReorderPrCheck));
  console.log('📦 Reorder auto-draft PR cron started (daily 10:15)');
}

export { runReorderPrCheck as runReorderPrCheckNow };
