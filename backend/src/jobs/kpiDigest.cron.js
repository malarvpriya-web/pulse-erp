// backend/src/jobs/kpiDigest.cron.js
// Monthly KPI digest — pushes a narrated rollup of the prior month's revenue,
// attrition, pipeline and headcount to leadership who may not log in daily.
// Reuses the same narrator as POST /api/ai/ceo-insights (kpiNarrator.js) and
// the standard notifications pipeline (auto-mirrors to push/email).
import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { narrateKpis } from '../modules/intelligence/kpiNarrator.js';

const LEADERSHIP_ROLES = ['admin', 'super_admin', 'superadmin', 'department_head'];

async function getReceivers(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.is_active = true
       AND u.company_id = $1
       AND LOWER(r.code) = ANY($2)
     ORDER BY u.id`,
    [companyId, LEADERSHIP_ROLES]
  );
  return rows.map((r) => r.id);
}

async function getCompanies() {
  const { rows } = await pool.query(
    `SELECT id, name FROM companies WHERE is_active = true ORDER BY id`
  );
  return rows;
}

async function getPriorMonthKpis(companyId) {
  const [revRow, prevRevRow, attrRow, hcRow, pipeRow, convRow] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM invoices
       WHERE deleted_at IS NULL AND company_id = $1
         AND invoice_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
         AND invoice_date <  DATE_TRUNC('month', CURRENT_DATE)`,
      [companyId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(total_amount),0)::numeric AS total FROM invoices
       WHERE deleted_at IS NULL AND company_id = $1
         AND invoice_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 month'
         AND invoice_date <  DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'`,
      [companyId]
    ),
    pool.query(
      `SELECT COUNT(*) AS total FROM employees
       WHERE company_id = $1 AND LOWER(status) IN ('inactive','terminated','left')
         AND updated_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
         AND updated_at <  DATE_TRUNC('month', CURRENT_DATE)`,
      [companyId]
    ),
    pool.query(
      `SELECT COUNT(*) AS total FROM employees
       WHERE company_id = $1 AND LOWER(status) IN ('active','probation')`,
      [companyId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(expected_value),0)::numeric AS value FROM opportunities
       WHERE company_id = $1 AND deleted_at IS NULL
         AND LOWER(stage) NOT IN ('closed_won','closed_lost')`,
      [companyId]
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE LOWER(stage) = 'closed_won') AS won,
         COUNT(*) AS total
       FROM opportunities
       WHERE company_id = $1 AND deleted_at IS NULL
         AND updated_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
         AND updated_at <  DATE_TRUNC('month', CURRENT_DATE)`,
      [companyId]
    ),
  ]);

  const revenue     = parseFloat(revRow.rows[0].total);
  const prevRevenue = parseFloat(prevRevRow.rows[0].total);
  const attritionCt = parseInt(attrRow.rows[0].total, 10);
  const activeHc    = parseInt(hcRow.rows[0].total, 10);
  const convTotal   = parseInt(convRow.rows[0].total, 10);
  const convWon     = parseInt(convRow.rows[0].won, 10);

  return {
    kpis: {
      revenue: {
        value: revenue,
        growth: prevRevenue > 0 ? ((revenue - prevRevenue) / prevRevenue) * 100 : null,
      },
    },
    attrition: {
      rate: activeHc + attritionCt > 0 ? (attritionCt / (activeHc + attritionCt)) * 100 : null,
    },
    salesKPI: {
      pipelineValue: parseFloat(pipeRow.rows[0].value),
      conversionRate: convTotal > 0 ? (convWon / convTotal) * 100 : null,
    },
    hc: {
      active: activeHc,
    },
  };
}

async function alreadySentThisMonth(companyId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM notifications
     WHERE module_name = 'executive'
       AND notification_type = 'kpi_digest'
       AND reference_id = $1
       AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
     LIMIT 1`,
    [companyId]
  );
  return rows.length > 0;
}

async function runKpiDigest() {
  const companies = await getCompanies();

  for (const company of companies) {
    if (await alreadySentThisMonth(company.id)) continue;

    const receivers = await getReceivers(company.id);
    if (!receivers.length) continue;

    const dashboardData = await getPriorMonthKpis(company.id);
    const { reply } = await narrateKpis(dashboardData).catch((err) => {
      console.error('[kpiDigestCron] narration failed:', err.message);
      return { reply: null };
    });
    if (!reply) continue;

    const monthLabel = new Date(Date.now());
    monthLabel.setMonth(monthLabel.getMonth() - 1);
    const title = `KPI Digest — ${monthLabel.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}`;

    for (const userId of receivers) {
      await notificationsRepository.create({
        user_id: userId,
        title,
        message: reply,
        module_name: 'executive',
        reference_id: company.id,
        notification_type: 'kpi_digest',
      });
    }
  }
}

export function startKpiDigestCron() {
  // 1st of every month, 07:00 server local time
  cron.schedule('0 7 1 * *', () => {
    runKpiDigest().catch((err) =>
      console.error('[kpiDigestCron] failed:', err.message)
    );
  });
  console.log('📊 Monthly KPI digest cron started (1st of month, 07:00)');
}
