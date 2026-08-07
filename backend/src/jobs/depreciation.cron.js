import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { postMonthlyDepreciation } from '../modules/finance/services/depreciation.js';

// postMonthlyDepreciation() (finance/services/depreciation.js) was fully built
// — SLM/WDV per Schedule II, its own docstring says "Called by the monthly
// cron job" — but had zero callers anywhere. This is that registration.

async function getCompanies() {
  const { rows } = await pool.query(
    `SELECT id, name FROM companies WHERE is_active = true ORDER BY id`
  );
  return rows;
}

async function getFinanceReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT id
     FROM users
     WHERE is_active = true
       AND company_id = $1
       AND LOWER(role) IN ('admin', 'super_admin', 'superadmin', 'finance', 'finance_manager')
     ORDER BY id`,
    [companyId]
  );
  return rows.map((r) => r.id);
}

async function runMonthlyDepreciation() {
  const companies = await getCompanies();

  for (const company of companies) {
    let result;
    try {
      result = await postMonthlyDepreciation(company.id);
    } catch (err) {
      console.error(`[depreciationCron] company ${company.id} (${company.name}) failed:`, err.message);
      continue;
    }

    console.log(
      `[depreciationCron] ${company.name}: posted ${result.posted}, skipped ${result.skipped}, errors ${result.errors.length}`
    );

    // Nothing new happened (no active assets, or already posted this period) — no notification noise.
    if (!result.posted && !result.errors.length) continue;

    const receivers = await getFinanceReceivers(company.id);
    if (!receivers.length) continue;

    const periodLabel = new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const title = result.errors.length
      ? `Depreciation Posted with Errors — ${periodLabel}`
      : `Depreciation Posted — ${periodLabel}`;
    const message =
      `${result.posted} asset(s) depreciated for ${periodLabel}` +
      (result.skipped ? `, ${result.skipped} skipped` : '') +
      (result.errors.length ? `, ${result.errors.length} failed — check server logs.` : '.');

    for (const userId of receivers) {
      await notificationsRepository.create({
        user_id: userId,
        title,
        message,
        module_name: 'finance',
        reference_id: company.id,
        notification_type: 'depreciation_posted',
      });
    }
  }
}

export function startDepreciationCron() {
  // 1st of every month, 02:00 IST — ahead of business hours and ahead of the
  // 07:00 KPI digest cron, so that month's books are settled before it reads them.
  cron.schedule('0 2 1 * *', () => {
    runMonthlyDepreciation().catch((err) =>
      console.error('[depreciationCron] failed:', err.message)
    );
  }, {
    scheduled: true,
    timezone: 'Asia/Kolkata',
  });
  console.log('📉 Monthly depreciation cron started (1st of month, 02:00 IST)');
}

// Allow manual trigger via: node -e "import('./src/jobs/depreciation.cron.js').then(m => m.runMonthlyDepreciationNow())"
export { runMonthlyDepreciation as runMonthlyDepreciationNow };
