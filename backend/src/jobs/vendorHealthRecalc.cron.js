import cron from 'node-cron';
import pool from '../config/db.js';
import svc from '../modules/procurement/services/vendorHealth.service.js';

/**
 * Nightly recalculation of the Supplier Performance Index.
 *
 * The engine, the service and the routes all existed; nothing scheduled them.
 * `POST /vendor-health/recalculate-all` was the only way a score was ever
 * written, so the table held whatever the last person to press the button left
 * behind -- three of six vendors scored, all of them stamped 2026-08-10, while
 * a GRN received yesterday changed nobody's on-time delivery. Vendors that had
 * never been recalculated at all were simply absent from the heatmap, the
 * distribution chart and the CEO summary: unscored, not zero, and invisible.
 *
 * The customer side of the same engine already had this job
 * (customerHealthRecalc.cron.js, daily 09:05); this is its missing twin.
 * computeAndSave() is idempotent -- it upserts on (company_id, vendor_id),
 * refreshes the current month's timeline snapshot, and rewrites the vendor's
 * active early warnings -- so a re-run costs nothing but the query time.
 */
async function runVendorHealthRecalc() {
  const { rows: companies } = await pool.query('SELECT id FROM companies ORDER BY id');
  for (const { id: companyId } of companies) {
    const { rows: vendors } = await pool.query(
      `SELECT id FROM vendors WHERE company_id = $1 AND deleted_at IS NULL ORDER BY id`,
      [companyId]
    );
    let ok = 0;
    const failures = [];
    for (const { id: vendorId } of vendors) {
      try {
        await svc.computeAndSave(vendorId, companyId);
        ok++;
      } catch (err) {
        // One unscoreable vendor must not cost the other 200 their refresh.
        failures.push(`${vendorId}: ${err.message}`);
      }
    }
    console.log(`[vendorHealthRecalcCron] company ${companyId}: ${ok}/${vendors.length} vendors scored`);
    if (failures.length) {
      console.error(`[vendorHealthRecalcCron] company ${companyId} failures: ${failures.join(' | ')}`);
    }
  }
}

export function startVendorHealthRecalcCron() {
  // Daily at 09:10 — staggered one slot behind the customer health recalc so the
  // two never contend for the pool.
  cron.schedule('10 9 * * *', () => {
    runVendorHealthRecalc().catch((err) =>
      console.error('[vendorHealthRecalcCron] failed:', err.message)
    );
  });
  console.log('🏭 Vendor health recalculation cron started (daily 09:10, all companies)');
}

export { runVendorHealthRecalc as runVendorHealthRecalcNow };
