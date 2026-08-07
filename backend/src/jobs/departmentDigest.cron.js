// backend/src/jobs/departmentDigest.cron.js
// Automation Opportunity Audit §27.2 — department-level narrative digests.
// kpiDigest.cron.js already sends ONE company-wide narrative (revenue/attrition/
// pipeline/headcount) to leadership every month; that's the only view leadership
// gets. Real HR/dept-head questions are per-department ("how is Production
// doing"), and nothing narrates that today. This reuses the exact same
// narrateKpis() rule-based-or-GPT pattern (kpiNarrator.js), fed department-scoped
// numbers instead of company-wide ones, and the same monthly notification
// pipeline (auto-mirrors to push/email) as kpiDigest.cron.js.
//
// Attrition math reuses calcAttritionRate() directly — same formula
// metricsEngine.js's computeAttrition() uses for the company-wide number — so a
// department's rate here and its rate on the HR Analytics dashboard never
// silently disagree.
//
// department is free text on `employees` (no FK, no reliable numeric id to key
// a notification on) — so dedup keys on company id + a slugified department
// name inside notification_type instead (see alreadySentThisMonth below).
import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { narrateKpis } from '../modules/intelligence/kpiNarrator.js';
import { calcAttritionRate } from '../analytics/services/metricsCalculator.js';

const RECEIVER_ROLES = ['admin', 'super_admin', 'superadmin', 'department_head', 'hr_manager', 'hr'];

async function getCompanies() {
  const { rows } = await pool.query(
    `SELECT id, name FROM companies WHERE is_active = true ORDER BY id`
  );
  return rows;
}

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
    [companyId, RECEIVER_ROLES]
  );
  return rows.map((r) => r.id);
}

async function getDeptStatsPriorMonth(companyId) {
  const { rows } = await pool.query(
    `SELECT e.department,
            COUNT(*) FILTER (WHERE LOWER(e.status) IN ('active','probation'))::int AS headcount,
            COUNT(*) FILTER (
              WHERE LOWER(e.status) IN ('active','probation')
                AND e.created_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                AND e.created_at <  date_trunc('month', CURRENT_DATE)
            )::int AS new_hires,
            COUNT(*) FILTER (
              WHERE LOWER(e.status) IN ('inactive','resigned','terminated','left')
                AND COALESCE(e.updated_at, e.created_at) >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                AND COALESCE(e.updated_at, e.created_at) <  date_trunc('month', CURRENT_DATE)
            )::int AS departures
     FROM employees e
     WHERE e.company_id = $1 AND e.department IS NOT NULL AND e.department <> ''
     GROUP BY e.department
     HAVING COUNT(*) FILTER (WHERE LOWER(e.status) IN ('active','probation')) > 0
     ORDER BY e.department`,
    [companyId]
  );
  return rows;
}

function slug(department) {
  return department.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function alreadySentThisMonth(companyId, department) {
  const notificationType = `dept_kpi_digest:${slug(department)}`.slice(0, 50);
  const { rows } = await pool.query(
    `SELECT 1 FROM notifications
     WHERE module_name = 'executive'
       AND notification_type = $1
       AND reference_id = $2
       AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
     LIMIT 1`,
    [notificationType, companyId]
  );
  return rows.length > 0;
}

async function runDepartmentDigest() {
  const companies = await getCompanies();

  for (const company of companies) {
    const receivers = await getReceivers(company.id);
    if (!receivers.length) continue;

    const deptStats = await getDeptStatsPriorMonth(company.id);
    if (!deptStats.length) continue;

    const monthLabel = new Date(Date.now());
    monthLabel.setMonth(monthLabel.getMonth() - 1);
    const monthText = monthLabel.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

    for (const dept of deptStats) {
      if (await alreadySentThisMonth(company.id, dept.department)) continue;

      const attritionRate = calcAttritionRate(dept.departures, dept.headcount);
      const { reply } = await narrateKpis({
        attrition: { rate: attritionRate },
        hc: { active: dept.headcount },
      }).catch((err) => {
        console.error('[departmentDigestCron] narration failed:', err.message);
        return { reply: null };
      });
      if (!reply) continue;

      const message =
        `${reply}\n• ${dept.new_hires} joined and ${dept.departures} left ${dept.department} in ${monthText}.`;
      const notificationType = `dept_kpi_digest:${slug(dept.department)}`.slice(0, 50);

      for (const userId of receivers) {
        await notificationsRepository.create({
          user_id: userId,
          title: `Department KPI Digest — ${dept.department} — ${monthText}`,
          message,
          module_name: 'executive',
          reference_id: company.id,
          notification_type: notificationType,
        });
      }
    }
  }
}

export function startDepartmentDigestCron() {
  // 1st of every month, 07:15 server local time — 15 min after the
  // company-wide KPI digest (07:00) so the two don't hammer the DB at once.
  cron.schedule('15 7 1 * *', () => {
    runDepartmentDigest().catch((err) =>
      console.error('[departmentDigestCron] failed:', err.message)
    );
  });
  console.log('🏢 Monthly department KPI digest cron started (1st of month, 07:15)');
}

export { runDepartmentDigest, getDeptStatsPriorMonth };
