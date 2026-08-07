import cron from 'node-cron';
import pool from '../config/db.js';
import { recalculateAll } from '../modules/crm/customerHealth.service.js';

// Automation Opportunity Audit §27.2 — extending /prescriptive to Sales/Service
// needs customer_health_scores populated, but POST /health-engine/recalculate-all
// (customerHealth.routes.js) is admin-triggered only, despite its own comment
// labeling it "admin / nightly" — nothing ever scheduled the nightly half.
async function runCustomerHealthRecalc() {
  const { rows } = await pool.query('SELECT id FROM companies ORDER BY id');
  for (const { id: companyId } of rows) {
    try {
      const result = await recalculateAll(companyId);
      console.log(`[customerHealthRecalcCron] company ${companyId}: ${result.processed}/${result.total} customers scored`);
    } catch (err) {
      console.error(`[customerHealthRecalcCron] company ${companyId} failed:`, err.message);
    }
  }
}

export function startCustomerHealthRecalcCron() {
  // Daily at 09:05 server local time (staggered with the other 09:xx crons)
  cron.schedule('5 9 * * *', () => {
    runCustomerHealthRecalc().catch((err) =>
      console.error('[customerHealthRecalcCron] failed:', err.message)
    );
  });
  console.log('💚 Customer health recalculation cron started (daily 09:05, all companies)');
}

export { runCustomerHealthRecalc as runCustomerHealthRecalcNow };
