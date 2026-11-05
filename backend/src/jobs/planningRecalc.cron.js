import cron from 'node-cron';
import pool from '../config/db.js';
import { runJob, scheduled } from './jobRun.js';
import planning from '../modules/inventory/services/inventoryPlanning.service.js';

/**
 * Nightly recomputation of every item's planning parameters.
 *
 * WHY THIS EXISTS
 * ---------------
 * recomputePlanningParameters() computes EOQ, reorder point, safety stock and
 * the ABC/XYZ/FSN classifications from live consumption — and until now the
 * only thing that called it was `POST /inventory/planning/recompute`, a button.
 * Nothing scheduled it. So every one of those figures was as old as the last
 * time a person happened to press it, while the ledger underneath kept moving.
 *
 * That is the same defect the vendor health score had (see
 * vendorHealthRecalc.cron.js: the engine, the service and the routes all
 * existed, nothing scheduled them, and the table held whatever the last person
 * to press the button left behind). It matters more here, because two crons
 * downstream CONSUME these numbers and neither knows how stale they are:
 *
 *   03:00  mrpAutoRun    lot-sizes against inventory_items.eoq
 *   10:15  reorderPr     raises draft purchase requisitions against
 *                        reorder_level, and sizes them from eoq
 *
 * A reorder point computed from last quarter's demand does not announce itself.
 * It quietly under-orders a part whose demand has grown and over-orders one
 * whose demand has fallen, and the planner sees a system that is simply wrong
 * about everything without any single thing having failed.
 *
 * ORDERING
 * 02:30, deliberately ahead of MRP at 03:00 and the reorder PR run at 10:15.
 * Both consume what this writes, so running after either would have them work a
 * full day behind the parameters — the failure mode being fixed, reintroduced
 * by a scheduling accident.
 *
 * AUTO_APPLY IS HONOURED, NOT OVERRIDDEN
 * `apply: null` means "use the company's own inventory_planning_settings
 * .auto_apply". A company that has deliberately turned auto-apply off gets a
 * dry run: the run and its per-item detail are still recorded in
 * inventory_planning_runs, so a planner can review what the system WOULD have
 * set and apply it by hand. Passing `apply: true` here would have quietly
 * overwritten the manual policy of every company that switched it off — a cron
 * silently revoking a setting is the worst kind of surprise, because the
 * setting still reads as off.
 *
 * Per-item manual overrides survive regardless: safety_stock_source and
 * reorder_point_source = 'manual' are respected inside the service itself.
 */
/**
 * The nightly job's call for ONE company, exactly as the loop below makes it.
 * Exported so a test can exercise the scheduled path for its own fixture
 * company without recomputing every tenant in the database.
 */
export function recalcCompany(companyId) {
  return planning.recomputePlanningParameters({
    companyId,
    apply: null,
    actor: { id: null, name: 'planningRecalc cron' },
  });
}

async function runPlanningRecalc() {
  // Only companies that actually hold items. recomputePlanningParameters()
  // records a run whether or not it found anything to evaluate — correct for the
  // button, where "it ran and found nothing" is the answer to a question
  // somebody asked — but nightly across every tenant it wrote an empty
  // inventory_planning_runs row per company per night. The first live execution
  // produced 33 runs of which 32 were empty; left alone that buries the real
  // run history under about twelve thousand blank rows a year, and the audit
  // trail exists to be read.
  const { rows: companies } = await pool.query(`
    SELECT c.id
      FROM companies c
     WHERE EXISTS (SELECT 1 FROM inventory_items ii
                    WHERE ii.company_id = c.id
                      AND ii.deleted_at IS NULL
                      AND COALESCE(ii.is_active, true) = true)
     ORDER BY c.id`);

  let companiesOk = 0, itemsEvaluated = 0, itemsUpdated = 0, itemsSkipped = 0;
  const failures = [];

  for (const { id: companyId } of companies) {
    try {
      const { run } = await recalcCompany(companyId);
      companiesOk++;
      itemsEvaluated += run?.items_evaluated ?? 0;
      itemsUpdated   += run?.items_updated ?? 0;
      itemsSkipped   += run?.items_skipped ?? 0;
    } catch (err) {
      // One company whose data will not compute must not cost every other
      // company its refresh — the whole point of a nightly job is that it is
      // dependable, and an all-or-nothing loop is not.
      failures.push(`${companyId}: ${err.message}`);
    }
  }

  if (failures.length) {
    console.error(`[planningRecalc] ${failures.length} company failure(s): ${failures.join(' | ')}`);
  }

  // Counters only — item codes, quantities and values stay out of the log.
  return {
    companies: companies.length,
    companies_ok: companiesOk,
    items_evaluated: itemsEvaluated,
    items_updated: itemsUpdated,
    items_skipped: itemsSkipped,
    failures: failures.length,
  };
}

export function startPlanningRecalcCron() {
  // 02:30 — ahead of mrpAutoRun (03:00) and reorderPr (10:15), both of which
  // read the parameters this job writes.
  cron.schedule('30 2 * * *', scheduled('planningRecalc', runPlanningRecalc), {
    timezone: 'Asia/Kolkata',
  });
  console.log('📐 Inventory planning recalculation cron started (daily 02:30 IST, all companies)');
}

/** Exported for tests and for an operator who needs to force a refresh now. */
export async function runPlanningRecalcNow() {
  return runJob('planningRecalc', runPlanningRecalc);
}

export default { startPlanningRecalcCron, runPlanningRecalcNow };
