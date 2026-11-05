// backend/src/jobs/anomalyDetection.cron.js
// Daily push wrapper around the existing anomaly detector (GET /api/ai/anomalies)
// — that endpoint already finds invoice outliers, low attendance, PO price
// variance, TDS mismatches and QC test-failure spikes, but only when a human
// opens it. This cron runs the same detectAnomalies() logic once a day and
// pushes each flagged anomaly to the role it's actually relevant to, via the
// standard notifications pipeline (auto-mirrors to push/email).
//
// Per company (PC-01 closure decision 4, 04 Nov 26). This used to run
// detectAnomalies() unscoped and send every anomaly to the routed roles in
// EVERY company — company A's named TDS mismatches (employee, TDS deducted,
// computed TDS) reached company B's finance users. Now each active company is
// detected on its own (detectAnomalies(companyId) scopes every detector) and
// notified only to its own users. A TDS mismatch is payroll data: it goes to
// that company's payroll:view holders only, resolved as can() resolves it —
// a user-level permissions row replaces the role grants, else the union of
// the roles held.
import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';
import { detectAnomalies } from '../modules/intelligence/anomalyDetector.js';
import { logAudit } from '../services/AuditService.js';

const ANOMALY_ROUTING = {
  'Invoice Amount Outlier': { roles: ['finance_manager', 'finance', 'admin', 'super_admin'], slug: 'invoice_outlier' },
  'Low Attendance':         { roles: ['hr', 'hr_manager', 'admin', 'super_admin'], slug: 'low_attendance' },
  'PO Price Variance':      { roles: ['procurement_manager', 'admin', 'super_admin'], slug: 'po_price_variance' },
  'TDS Mismatch':           { grant: ['payroll', 'can_view'], slug: 'tds_mismatch' },
  'PQ Test Failure':        { roles: ['qc_manager', 'production_manager', 'admin', 'super_admin'], slug: 'pq_test_failure' },
};
const DEFAULT_ROUTING = { roles: ['admin', 'super_admin'], slug: 'other' };

async function getReceiversForRoles(roles, companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     JOIN companies c ON c.id = u.company_id
     WHERE u.is_active = true AND c.is_active = true AND u.company_id = $2
       AND LOWER(r.code) = ANY($1)
     ORDER BY u.id`,
    [roles, companyId]
  );
  return rows.map((r) => r.id);
}

const GRANT_COLUMNS = new Set(['can_view', 'can_add', 'can_edit', 'can_delete', 'can_approve', 'can_export']);
/** Active users of one company holding module/column — the user row if any, else the roles' union. */
export async function getReceiversWithGrant(module, column, companyId) {
  if (!GRANT_COLUMNS.has(column)) throw new Error(`unknown permission column ${column}`);
  const { rows } = await pool.query(
    `SELECT u.id
       FROM users u
       JOIN companies c ON c.id = u.company_id
      WHERE u.is_active = true AND c.is_active = true AND u.company_id = $2
        AND COALESCE(
              (SELECT p.${column} FROM permissions p WHERE p.user_id = u.id AND p.module = $1 LIMIT 1),
              (SELECT BOOL_OR(rp.${column}) FROM user_roles ur
                 JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.module = $1
                WHERE ur.user_id = u.id),
              false)
      ORDER BY u.id`,
    [module, companyId]
  );
  return rows.map((r) => r.id);
}

async function notifyAnomaly(userId, anomaly, slug) {
  // de-dup for the same anomaly / user / day (mirrors amcRenewal.cron.js)
  const dup = await pool.query(
    `SELECT 1 FROM notifications
     WHERE user_id = $1 AND module_name = 'intelligence'
       AND reference_id = $2 AND notification_type = $3
       AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [userId, anomaly.affected_id, slug]
  );
  if (dup.rows.length) return;

  await notificationsRepository.create({
    user_id: userId,
    title: `Anomaly Detected — ${anomaly.type}`,
    message: anomaly.description,
    module_name: 'intelligence',
    reference_id: anomaly.affected_id,
    notification_type: slug,
  });
}

// Automation Opportunity Audit §32.1 — audit_logs (via logAudit()) is a
// passive, query-only history; this cron already pushes notifications
// (§1.2/§40) but never wrote the flagged anomaly into audit_logs as its own
// event, confirmed via grep before adding this. One row per anomaly per day
// (not per receiver — this is a record that the anomaly was flagged, not a
// per-user delivery log, which the notifications rows already cover).
async function alreadyAuditLogged(slug, affectedId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM audit_logs
     WHERE module_name = 'intelligence' AND action_type = $1
       AND reference_id = $2 AND created_at::date = CURRENT_DATE
     LIMIT 1`,
    [`anomaly_flagged.${slug}`, String(affectedId)]
  );
  return rows.length > 0;
}

/**
 * One pass over every active company (or `companyIds`, for a scoped run).
 * @returns {Promise<Array<{company_id:number, anomalies:number}>>}
 */
export async function runAnomalyDetectionCheck({ companyIds = null } = {}) {
  const ids = companyIds ?? (await pool.query(`SELECT id FROM companies WHERE is_active = true ORDER BY id`)).rows.map(r => r.id);
  const summary = [];
  for (const companyId of ids) {
    const anomalies = await detectAnomalies(companyId);
    summary.push({ company_id: companyId, anomalies: anomalies.length });
    await notifyCompany(companyId, anomalies);
  }
  return summary;
}

async function notifyCompany(companyId, anomalies) {
  for (const anomaly of anomalies) {
    const routing = ANOMALY_ROUTING[anomaly.type] || DEFAULT_ROUTING;
    const receivers = routing.grant
      ? await getReceiversWithGrant(routing.grant[0], routing.grant[1], companyId)
      : await getReceiversForRoles(routing.roles, companyId);
    for (const userId of receivers) {
      await notifyAnomaly(userId, anomaly, routing.slug);
    }

    if (!(await alreadyAuditLogged(routing.slug, anomaly.affected_id))) {
      logAudit({
        userId: null,
        module: 'intelligence',
        recordId: anomaly.affected_id,
        recordType: 'anomaly',
        action: `anomaly_flagged.${routing.slug}`,
        newData: anomaly,
      });
    }
  }
}

export function startAnomalyDetectionCron() {
  // Daily at 06:30 server local time — ahead of the 07:00 monthly KPI digest.
  cron.schedule('30 6 * * *', () => {
    runAnomalyDetectionCheck().catch((err) =>
      console.error('[anomalyDetectionCron] failed:', err.message)
    );
  });
  console.log('🔍 Daily anomaly-detection cron started (daily 06:30)');
}
