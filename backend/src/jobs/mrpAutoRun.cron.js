// backend/src/jobs/mrpAutoRun.cron.js
//
// Automation Opportunity Audit §15.1 — "Auto-trigger MRP run on new demand."
// POST /mrp/run (production/mrp.routes.js) was a manual button; nothing ran
// the regenerative MRP pass proactively as new sales orders/MPS/forecast
// entries accumulated, so planners had to remember to re-run it. This cron
// calls the exact same runMRP() the button calls, nightly, per company —
// deliberately a nightly batch rather than a synchronous hook off sales
// order acceptance (per the audit's own flow), so order acceptance itself
// stays fast. Firming/converting planned orders into real POs/production
// orders remains a manual, human-reviewed step — this only keeps the
// planning workbench current so that review has fresh data every morning.

import cron from 'node-cron';
import pool from '../config/db.js';
import { runMRP } from '../modules/production/mrpEngine.service.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

async function getActiveCompanies() {
  const { rows } = await pool.query(`SELECT id, name FROM companies WHERE is_active = true ORDER BY id`);
  return rows;
}

// Mirrors §54's compliance-reminder approach: read role_permissions directly
// (can_edit on the 'production' module — the same permission POST /mrp/run
// itself requires) rather than hardcoding a role-code list, so the receiver
// set stays correct if that seed ever changes.
async function getPlanningReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'production' AND rp.can_edit = true
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND (COALESCE(e.company_id, u.company_id) = $1 OR $1 IS NULL)`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function insertSummaryReminder(userId, companyId, summary) {
  // De-dup: one digest per company per day, not per planned order.
  const dup = await pool.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1
       AND module_name = 'production'
       AND reference_id = $2
       AND notification_type = 'mrp_auto_run'
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, companyId]
  );
  if (dup.rows.length) return;

  const parts = [];
  if (summary.planned_orders > 0) {
    parts.push(`${summary.planned_orders} planned order${summary.planned_orders === 1 ? '' : 's'} (${summary.make} make, ${summary.buy} buy)`);
  }
  if (summary.critical_exceptions > 0) {
    parts.push(`${summary.critical_exceptions} critical exception${summary.critical_exceptions === 1 ? '' : 's'}`);
  }

  await notificationsRepository.create({
    user_id: userId,
    title: 'Nightly MRP Run — Planning Workbench Updated',
    message: `Regenerative MRP ran overnight: ${parts.join(', ')}. Review in the Planning Workbench before converting.`,
    module_name: 'production',
    reference_id: companyId,
    notification_type: 'mrp_auto_run',
  });
}

async function runMrpAutoRunCheck() {
  const companies = await getActiveCompanies();

  for (const company of companies) {
    let result;
    try {
      result = await runMRP({
        companyId: company.id,
        horizonDays: 90,
        bucketDays: 7,
        includeSalesOrders: true,
        includeMPS: true,
        includeForecast: true,
        actor: { id: null, name: 'System (Nightly MRP Cron)' },
      });
    } catch (err) {
      console.error(`[mrpAutoRunCron] company ${company.id} (${company.name}): MRP run failed:`, err.message);
      continue;
    }

    const criticalExceptions = result.exceptions.filter((e) => e.severity === 'critical').length;
    if (!result.plannedOrders.length && !criticalExceptions) {
      console.log(`[mrpAutoRunCron] company ${company.id} (${company.name}): no new planned orders or critical exceptions — skipping notification`);
      continue;
    }

    const summary = {
      planned_orders: result.plannedOrders.length,
      make: result.plannedOrders.filter((p) => p.order_type === 'make').length,
      buy: result.plannedOrders.filter((p) => p.order_type === 'buy').length,
      critical_exceptions: criticalExceptions,
    };

    const receivers = await getPlanningReceivers(company.id);
    for (const userId of receivers) {
      await insertSummaryReminder(userId, company.id, summary);
    }
    console.log(`[mrpAutoRunCron] company ${company.id} (${company.name}): ${summary.planned_orders} planned orders (${summary.make} make/${summary.buy} buy), ${summary.critical_exceptions} critical exceptions, notified ${receivers.length} planner(s)`);
  }
}

export function startMrpAutoRunCron() {
  // Daily 03:00 IST — after the S-curve/depreciation 02:00 jobs, well before
  // the 09:xx morning reminder wave, so the Planning Workbench has fresh
  // data by the time planners start their day.
  cron.schedule('0 3 * * *', () => {
    runMrpAutoRunCheck().catch((err) => console.error('[mrpAutoRunCron] failed:', err.message));
  }, {
    scheduled: true,
    timezone: 'Asia/Kolkata',
  });
  console.log('🏭 Nightly MRP auto-run cron started (daily 03:00 IST)');
}

export { runMrpAutoRunCheck as runMrpAutoRunCheckNow };
