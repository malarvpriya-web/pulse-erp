// backend/src/modules/crm/customerHealth.service.js
// Phase 49F — Customer Health Score Engine
// 9-dimension scoring model, early-warning system, segmentation, risk prediction.

import pool from '../../config/db.js';

// ── Cache (TTL 5 min per customer, 2 min for aggregates) ─────────────────────
const _cache = new Map();
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data, ttlMs = 300_000) {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}
export function invalidateCache(customerId, companyId) {
  _cache.delete(`health_${customerId}_${companyId}`);
  _cache.delete(`dashboard_${companyId}`);
  _cache.delete(`alerts_${companyId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 1: REVENUE SCORE  (max 20)
// Evaluates: revenue growth, repeat orders, order frequency
// ─────────────────────────────────────────────────────────────────────────────
async function calcRevenueScore(customerId, companyId) {
  let score = 0;
  let details = {};

  try {
    // Total revenue (paid invoices)
    const r = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='paid' THEN total_amount ELSE 0 END),0)           AS revenue,
         COALESCE(SUM(CASE WHEN status='paid' AND created_at >= NOW()-INTERVAL '12 months'
                           THEN total_amount ELSE 0 END),0)                               AS revenue_12m,
         COALESCE(SUM(CASE WHEN status='paid' AND created_at >= NOW()-INTERVAL '24 months'
                           AND created_at < NOW()-INTERVAL '12 months'
                           THEN total_amount ELSE 0 END),0)                               AS revenue_prev_12m,
         COUNT(DISTINCT CASE WHEN status='paid' THEN id END)::int                        AS paid_count,
         COUNT(DISTINCT CASE WHEN status='paid' AND created_at >= NOW()-INTERVAL '12 months'
                             THEN id END)::int                                            AS orders_12m
       FROM invoices
       WHERE party_id=$1`,
      [customerId]
    );
    const d = r.rows[0];
    const rev12m   = parseFloat(d.revenue_12m || 0);
    const prevRev  = parseFloat(d.revenue_prev_12m || 0);
    const orders12 = parseInt(d.orders_12m || 0);

    details = {
      total_revenue:     parseFloat(d.revenue || 0),
      revenue_12m:       rev12m,
      revenue_prev_12m:  prevRev,
      orders_12m:        orders12,
      total_orders:      parseInt(d.paid_count || 0),
    };

    // Growth sub-score (0–12): is revenue growing?
    let growthScore = 0;
    if (rev12m > 0 && prevRev > 0) {
      const growthPct = ((rev12m - prevRev) / prevRev) * 100;
      growthScore = growthPct > 10 ? 12 : growthPct > 0 ? 9 : growthPct > -10 ? 5 : 0;
      details.revenue_growth_pct = Math.round(growthPct);
    } else if (rev12m > 0) {
      growthScore = 9; // new customer with revenue
    }

    // Order frequency sub-score (0–8)
    const freqScore = orders12 >= 6 ? 8 : orders12 >= 3 ? 6 : orders12 >= 1 ? 3 : 0;
    details.order_frequency_score = freqScore;

    score = growthScore + freqScore;
  } catch (_) {}

  return { score: Math.min(20, score), details };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 2: COLLECTION SCORE  (max 20)
// Evaluates: outstanding balance, payment delays, overdue invoices
// ─────────────────────────────────────────────────────────────────────────────
async function calcCollectionScore(customerId, companyId) {
  let score = 20;
  let details = {};

  try {
    const r = await pool.query(
      `SELECT
         COUNT(CASE WHEN status='overdue' THEN 1 END)::int                          AS overdue_count,
         COUNT(CASE WHEN status='overdue' AND created_at < NOW()-INTERVAL '90 days'
                    THEN 1 END)::int                                                 AS overdue_90d,
         COUNT(CASE WHEN status='overdue' AND created_at >= NOW()-INTERVAL '90 days'
                    AND created_at < NOW()-INTERVAL '60 days' THEN 1 END)::int      AS overdue_60d,
         COUNT(CASE WHEN status='overdue' AND created_at >= NOW()-INTERVAL '60 days'
                    AND created_at < NOW()-INTERVAL '30 days' THEN 1 END)::int      AS overdue_30d,
         COALESCE(SUM(CASE WHEN status IN ('overdue','pending') THEN total_amount ELSE 0 END),0) AS outstanding,
         COALESCE(ROUND(AVG(CASE WHEN status='paid' AND updated_at > created_at
                               THEN EXTRACT(EPOCH FROM (updated_at-created_at))/86400
                               END))::int, 0)                                       AS avg_days_to_pay
       FROM invoices WHERE party_id=$1`,
      [customerId]
    );
    const d = r.rows[0];
    details = {
      overdue_count:    d.overdue_count,
      overdue_90d:      d.overdue_90d,
      overdue_60d:      d.overdue_60d,
      overdue_30d:      d.overdue_30d,
      outstanding:      parseFloat(d.outstanding),
      avg_days_to_pay:  d.avg_days_to_pay,
    };

    // Per spec 49F-4: penalty bands
    if (d.overdue_90d > 0)      score = 0;
    else if (d.overdue_60d > 0) score = 10;
    else if (d.overdue_30d > 0) score = 15;
    else                        score = 20;

    // Additional penalty for avg payment delay
    if (d.avg_days_to_pay > 90) score = Math.max(0, score - 5);
    else if (d.avg_days_to_pay > 60) score = Math.max(0, score - 3);
  } catch (_) {}

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 3: PROFITABILITY / MARGIN SCORE  (max 15)
// Evaluates: customer margin, project margin, AMC margin
// ─────────────────────────────────────────────────────────────────────────────
async function calcMarginScore(customerId, companyId) {
  let score = 0;
  let details = {};

  try {
    // Project margin
    const r = await pool.query(
      `SELECT
         COALESCE(SUM(budget_amount),0) AS total_budget,
         COALESCE(SUM(actual_cost),0)   AS total_actual
       FROM projects WHERE customer_id=$1 AND deleted_at IS NULL AND status='completed'`,
      [customerId]
    );
    const d = r.rows[0];
    const budget = parseFloat(d.total_budget || 0);
    const actual = parseFloat(d.total_actual || 0);

    let marginPct = 0;
    if (budget > 0) {
      marginPct = ((budget - actual) / budget) * 100;
    }

    // AMC revenue vs cost proxy — if active AMC exists, assume positive margin
    let amcActive = 0;
    try {
      const amcR = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM amc_contracts WHERE customer_id=$1 AND status='active'`,
        [customerId]
      );
      amcActive = amcR.rows[0]?.cnt || 0;
    } catch (_) {}

    details = { margin_pct: Math.round(marginPct), project_budget: budget, project_actual: actual, amc_active: amcActive };

    // Per spec 49F-5
    if (marginPct > 25)      score = 15;
    else if (marginPct > 15) score = 10;
    else if (marginPct > 0)  score = 5;
    else if (budget === 0 && amcActive > 0) score = 8; // AMC-only customer, assume moderate margin
    else                     score = 0;
  } catch (_) {}

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 4: PROJECT SUCCESS SCORE  (max 10)
// Evaluates: on-time delivery, delays, budget variance, schedule variance
// ─────────────────────────────────────────────────────────────────────────────
async function calcProjectScore(customerId, companyId) {
  let score = 0;
  let details = {};

  try {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int                                                             AS total,
         COUNT(CASE WHEN status='completed' THEN 1 END)::int                     AS completed,
         COUNT(CASE WHEN status='completed' AND end_date IS NOT NULL
                    AND end_date < actual_end_date THEN 1 END)::int              AS delayed,
         COUNT(CASE WHEN status IN ('cancelled','failed') THEN 1 END)::int       AS failed,
         COUNT(CASE WHEN status='active' AND end_date IS NOT NULL
                    AND end_date < NOW() THEN 1 END)::int                        AS overdue_active
       FROM projects WHERE customer_id=$1 AND deleted_at IS NULL`,
      [customerId]
    );
    const d = r.rows[0];
    details = {
      total_projects:   d.total,
      completed:        d.completed,
      delayed:          d.delayed,
      failed:           d.failed,
      overdue_active:   d.overdue_active,
    };

    if (d.total === 0) {
      score = 7; // no projects = no delivery risk
    } else {
      const failedOrDelayed = d.failed + d.delayed + d.overdue_active;
      if (failedOrDelayed === 0)              score = 10; // Perfect delivery
      else if (failedOrDelayed <= 1)          score = 7;  // Minor delays
      else if (failedOrDelayed <= 3)          score = 3;  // Repeated delays
      else                                    score = 0;  // Failed projects
    }
  } catch (_) {}

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 5: QUALITY SCORE  (max 10)
// Evaluates: NCR count, CAPA count, customer complaints
// ─────────────────────────────────────────────────────────────────────────────
async function calcQualityScore(customerId, companyId) {
  let score = 10;
  let details = {};

  try {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int                                                              AS total_ncrs,
         COUNT(CASE WHEN status != 'closed' THEN 1 END)::int                      AS open_ncrs,
         COUNT(CASE WHEN severity IN ('major','critical') THEN 1 END)::int        AS major_ncrs,
         COUNT(CASE WHEN created_at >= NOW()-INTERVAL '12 months' THEN 1 END)::int AS ncrs_12m
       FROM non_conformance_reports WHERE customer_id=$1`,
      [customerId]
    );
    const d = r.rows[0];

    let complaints = 0;
    try {
      const cr = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM support_tickets
         WHERE customer_id=$1 AND priority IN ('high','critical')
         AND created_at >= NOW()-INTERVAL '12 months'`,
        [customerId]
      );
      complaints = cr.rows[0]?.cnt || 0;
    } catch (_) {}

    details = {
      total_ncrs:   d.total_ncrs,
      open_ncrs:    d.open_ncrs,
      major_ncrs:   d.major_ncrs,
      ncrs_12m:     d.ncrs_12m,
      complaints:   complaints,
    };

    // Per spec 49F-7
    if (d.major_ncrs > 2 || complaints > 5) score = 0;
    else if (d.ncrs_12m > 3 || d.open_ncrs > 2) score = 3;
    else if (d.ncrs_12m > 0 || complaints > 0) score = 7;
    else score = 10;
  } catch (_) {}

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 6: SERVICE SCORE  (max 10)
// Evaluates: open tickets, closure time, satisfaction
// ─────────────────────────────────────────────────────────────────────────────
async function calcServiceScore(customerId, companyId) {
  let score = 0;
  let details = {};

  try {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int                                                                  AS total_tickets,
         COUNT(CASE WHEN status NOT IN ('resolved','closed') THEN 1 END)::int         AS open_tickets,
         COUNT(CASE WHEN status NOT IN ('resolved','closed')
                    AND priority = 'critical' THEN 1 END)::int                        AS critical_open,
         COALESCE(ROUND(AVG(CASE WHEN status IN ('resolved','closed') AND resolved_at IS NOT NULL
                               THEN EXTRACT(EPOCH FROM (resolved_at-created_at))/86400
                               END))::int, 0)                                         AS avg_resolution_days,
         COUNT(CASE WHEN status IN ('resolved','closed') THEN 1 END)::int             AS closed_tickets
       FROM support_tickets WHERE customer_id=$1`,
      [customerId]
    );
    const d = r.rows[0];
    details = {
      total_tickets:        d.total_tickets,
      open_tickets:         d.open_tickets,
      critical_open:        d.critical_open,
      closed_tickets:       d.closed_tickets,
      avg_resolution_days:  d.avg_resolution_days,
    };

    const total = d.total_tickets;
    if (total === 0) {
      score = 8; // no issues raised = generally good, not perfect
    } else {
      const closeRate = total > 0 ? d.closed_tickets / total : 0;
      if (d.critical_open > 0)                  score = 0;
      else if (d.open_tickets > 5)              score = 3;
      else if (closeRate >= 0.9 && d.avg_resolution_days <= 7)  score = 10;
      else if (closeRate >= 0.75)               score = 7;
      else                                      score = 5;
    }
  } catch (_) {}

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 7: AMC SCORE  (max 5)
// Evaluates: AMC active, renewal, revenue
// ─────────────────────────────────────────────────────────────────────────────
async function calcAMCScore(customerId, companyId) {
  let score = 0;
  let details = {};

  try {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int                                                                        AS total,
         COUNT(CASE WHEN status='active' THEN 1 END)::int                                   AS active,
         COUNT(CASE WHEN status='expired' THEN 1 END)::int                                  AS expired,
         COUNT(CASE WHEN status='active' AND end_date BETWEEN NOW() AND NOW()+INTERVAL '90 days'
                    THEN 1 END)::int                                                         AS expiring_soon,
         COALESCE(SUM(CASE WHEN status='active' THEN annual_value ELSE 0 END),0)            AS active_revenue,
         COALESCE(SUM(annual_value),0)                                                       AS total_revenue
       FROM amc_contracts WHERE customer_id=$1`,
      [customerId]
    );
    const d = r.rows[0];
    details = {
      total:           d.total,
      active:          d.active,
      expired:         d.expired,
      expiring_soon:   d.expiring_soon,
      active_revenue:  parseFloat(d.active_revenue),
    };

    // Per spec 49F-9
    if (d.active > 0) score = 5;
    else if (d.expired > 0) score = 0;
    else score = 0; // no AMC history
  } catch (_) {}

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 8: ENGAGEMENT SCORE  (max 5)
// Evaluates: meetings, visits, calls, emails, portal usage
// ─────────────────────────────────────────────────────────────────────────────
async function calcEngagementScore(customerId, companyId) {
  let score = 0;
  let details = {};

  try {
    // Customer visits (sales/pre-sales)
    let visits = 0;
    try {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM customer_visits
         WHERE customer_id=$1 AND visit_date >= NOW()-INTERVAL '12 months'`,
        [customerId]
      );
      visits = r.rows[0]?.cnt || 0;
    } catch (_) {}

    // CRM emails / meetings
    let emails = 0;
    try {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM crm_emails ce
         JOIN accounts a ON a.id = ce.account_id AND a.deleted_at IS NULL
         WHERE a.party_id=$1 AND ce.sent_at >= NOW()-INTERVAL '12 months'`,
        [customerId]
      );
      emails = r.rows[0]?.cnt || 0;
    } catch (_) {}

    // CRM activities (calls, meetings)
    let activities = 0;
    try {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM crm_activities ca
         JOIN accounts a ON a.id = ca.account_id AND a.deleted_at IS NULL
         WHERE a.party_id=$1 AND ca.created_at >= NOW()-INTERVAL '12 months'`,
        [customerId]
      );
      activities = r.rows[0]?.cnt || 0;
    } catch (_) {}

    const touchpoints = visits + emails + activities;
    details = { visits, emails, activities, total_touchpoints: touchpoints };

    // Per spec 49F-10
    if (touchpoints >= 10) score = 5;
    else if (touchpoints >= 4) score = 3;
    else score = 0;
  } catch (_) {}

  return { score, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION 9: RISK SCORE  (max 5)
// Evaluates: payment risk, project risk, commercial risk, dependency risk
// ─────────────────────────────────────────────────────────────────────────────
async function calcRiskScore(customerId, companyId, collectionDetails, projectDetails, qualityDetails) {
  let score = 5;
  let details = {};
  let riskLevel = 'low';

  try {
    // Risk factors aggregated from other dimensions
    const paymentRisk     = collectionDetails?.overdue_90d > 0 ? 'critical'
                          : collectionDetails?.overdue_60d > 0 ? 'high'
                          : collectionDetails?.overdue_30d > 0 ? 'medium' : 'low';

    const projectRisk     = (projectDetails?.failed > 0 || projectDetails?.overdue_active > 2) ? 'high'
                          : (projectDetails?.delayed > 1 || projectDetails?.overdue_active > 0) ? 'medium' : 'low';

    const qualityRisk     = qualityDetails?.major_ncrs > 2 ? 'high'
                          : qualityDetails?.open_ncrs > 1 ? 'medium' : 'low';

    const riskLevels = [paymentRisk, projectRisk, qualityRisk];
    if (riskLevels.includes('critical'))     { score = 0; riskLevel = 'critical'; }
    else if (riskLevels.includes('high'))    { score = 1; riskLevel = 'high'; }
    else if (riskLevels.includes('medium'))  { score = 3; riskLevel = 'medium'; }
    else                                     { score = 5; riskLevel = 'low'; }

    details = { payment_risk: paymentRisk, project_risk: projectRisk, quality_risk: qualityRisk, composite: riskLevel };
  } catch (_) {}

  return { score, details, riskLevel };
}

// ─────────────────────────────────────────────────────────────────────────────
// MANIFEST SPECIAL MODEL  (49F-23)
// Additional context for HVDC, STATCOM, SST, Industrial Automation customers
// ─────────────────────────────────────────────────────────────────────────────
async function calcManifestMetrics(customerId) {
  const metrics = {
    fat_success_pct:           null,
    sat_success_pct:           null,
    commissioning_success_pct: null,
    warranty_claims_count:     0,
    amc_renewal_pct:           null,
  };

  try {
    const fat = await pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(CASE WHEN result='passed' THEN 1 END)::int AS passed
       FROM fat_reports WHERE customer_id=$1`,
      [customerId]
    );
    const f = fat.rows[0];
    if (f.total > 0) metrics.fat_success_pct = Math.round((f.passed / f.total) * 100);
  } catch (_) {}

  try {
    const sat = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(CASE WHEN result IN ('accepted','passed') OR status='completed' THEN 1 END)::int AS passed
       FROM sat_reports WHERE customer_id=$1`,
      [customerId]
    );
    const s = sat.rows[0];
    if (s.total > 0) metrics.sat_success_pct = Math.round((s.passed / s.total) * 100);
  } catch (_) {}

  try {
    const comm = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(CASE WHEN acceptance_status='accepted' THEN 1 END)::int AS accepted
       FROM commissioning_reports WHERE customer_id=$1`,
      [customerId]
    );
    const c = comm.rows[0];
    if (c.total > 0) metrics.commissioning_success_pct = Math.round((c.accepted / c.total) * 100);
  } catch (_) {}

  try {
    const wr = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM warranty_register WHERE customer_id=$1`,
      [customerId]
    );
    metrics.warranty_claims_count = wr.rows[0]?.cnt || 0;
  } catch (_) {}

  try {
    const amc = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(CASE WHEN status='active' THEN 1 END)::int AS active
       FROM amc_contracts WHERE customer_id=$1`,
      [customerId]
    );
    const a = amc.rows[0];
    if (a.total > 0) metrics.amc_renewal_pct = Math.round((a.active / a.total) * 100);
  } catch (_) {}

  return metrics;
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CLASSIFICATION  (49F-12)
// ─────────────────────────────────────────────────────────────────────────────
function classify(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 50) return 'Watchlist';
  return 'Critical';
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER SEGMENTATION  (49F-16)
// ─────────────────────────────────────────────────────────────────────────────
function determineSegment(score, revenueDetails) {
  const rev12m = revenueDetails?.revenue_12m || 0;
  const growthPct = revenueDetails?.revenue_growth_pct || 0;

  if (score >= 85 && rev12m >= 5_000_000)      return 'Strategic';
  if (score >= 75 && rev12m >= 1_000_000)       return 'Key Account';
  if (growthPct > 15 && score >= 50)            return 'Growth Account';
  if (score >= 50)                              return 'Standard Account';
  return 'At-Risk Account';
}

// ─────────────────────────────────────────────────────────────────────────────
// RISK PREDICTIONS  (49F-15)
// ─────────────────────────────────────────────────────────────────────────────
function buildRiskPredictions(scores, details) {
  const { revenue, collection, margin, project, quality, service, amc, risk } = details;
  return {
    revenue_loss_risk:
      (revenue.score <= 5 || (revenue.details?.revenue_12m || 0) === 0) ? 'critical' :
      revenue.score <= 10 ? 'high' : revenue.score <= 15 ? 'medium' : 'low',

    payment_default_risk:
      (collection.details?.overdue_90d || 0) > 0 ? 'critical' :
      (collection.details?.overdue_60d || 0) > 0 ? 'high' :
      (collection.details?.overdue_30d || 0) > 0 ? 'medium' : 'low',

    project_escalation_risk:
      (project.details?.failed || 0) > 0 || (project.details?.overdue_active || 0) > 2 ? 'high' :
      (project.details?.delayed || 0) > 1 ? 'medium' : 'low',

    service_escalation_risk:
      (service.details?.critical_open || 0) > 0 ? 'critical' :
      (service.details?.open_tickets || 0) > 5 ? 'high' :
      (service.details?.open_tickets || 0) > 2 ? 'medium' : 'low',

    amc_nonrenewal_risk:
      (amc.details?.expiring_soon || 0) > 0 && amc.score === 0 ? 'high' :
      (amc.details?.expiring_soon || 0) > 0 ? 'medium' :
      amc.score === 0 ? 'medium' : 'low',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EARLY WARNING ALERTS  (49F-14)
// ─────────────────────────────────────────────────────────────────────────────
function buildAlerts(customerId, customerName, companyId, scores, details, prevScore) {
  const alerts = [];

  // Revenue drop > 25%
  const growthPct = details.revenue.details?.revenue_growth_pct;
  if (growthPct !== undefined && growthPct < -25) {
    alerts.push({
      company_id:      companyId,
      customer_id:     customerId,
      customer_name:   customerName,
      alert_type:      'revenue_drop',
      alert_severity:  'critical',
      alert_title:     'Revenue Drop Alert',
      alert_message:   `Revenue dropped ${Math.abs(growthPct)}% vs prior year`,
      metric_value:    growthPct,
      threshold_value: -25,
    });
  }

  // Outstanding > 90 days
  if ((details.collection.details?.overdue_90d || 0) > 0) {
    alerts.push({
      company_id:      companyId,
      customer_id:     customerId,
      customer_name:   customerName,
      alert_type:      'overdue_90',
      alert_severity:  'critical',
      alert_title:     'Payment Overdue >90 Days',
      alert_message:   `${details.collection.details.overdue_90d} invoice(s) overdue by 90+ days`,
      metric_value:    details.collection.details.overdue_90d,
      threshold_value: 0,
    });
  }

  // Margin < 10%
  if ((details.margin.details?.margin_pct || 100) < 10 && (details.margin.details?.project_budget || 0) > 0) {
    alerts.push({
      company_id:      companyId,
      customer_id:     customerId,
      customer_name:   customerName,
      alert_type:      'low_margin',
      alert_severity:  'warning',
      alert_title:     'Low Project Margin',
      alert_message:   `Project margin at ${details.margin.details.margin_pct}% (threshold: 10%)`,
      metric_value:    details.margin.details.margin_pct,
      threshold_value: 10,
    });
  }

  // Repeated NCR
  if ((details.quality.details?.ncrs_12m || 0) > 3) {
    alerts.push({
      company_id:      companyId,
      customer_id:     customerId,
      customer_name:   customerName,
      alert_type:      'repeated_ncr',
      alert_severity:  'warning',
      alert_title:     'Repeated Quality NCRs',
      alert_message:   `${details.quality.details.ncrs_12m} NCRs raised in last 12 months`,
      metric_value:    details.quality.details.ncrs_12m,
      threshold_value: 3,
    });
  }

  // Repeated delays
  if ((details.project.details?.delayed || 0) + (details.project.details?.overdue_active || 0) > 2) {
    alerts.push({
      company_id:      companyId,
      customer_id:     customerId,
      customer_name:   customerName,
      alert_type:      'repeated_delays',
      alert_severity:  'warning',
      alert_title:     'Repeated Project Delays',
      alert_message:   `${details.project.details.delayed + details.project.details.overdue_active} projects delayed`,
      metric_value:    details.project.details.delayed + details.project.details.overdue_active,
      threshold_value: 2,
    });
  }

  // AMC expired
  if ((details.amc.details?.expired || 0) > 0 && (details.amc.details?.active || 0) === 0) {
    alerts.push({
      company_id:      companyId,
      customer_id:     customerId,
      customer_name:   customerName,
      alert_type:      'amc_expired',
      alert_severity:  'warning',
      alert_title:     'AMC Contract Expired',
      alert_message:   `${details.amc.details.expired} AMC contract(s) expired, no active coverage`,
      metric_value:    details.amc.details.expired,
      threshold_value: 0,
    });
  }

  // Score drop
  if (prevScore !== null && prevScore - scores.total > 15) {
    alerts.push({
      company_id:      companyId,
      customer_id:     customerId,
      customer_name:   customerName,
      alert_type:      'score_drop',
      alert_severity:  'critical',
      alert_title:     'Customer Health Deteriorating',
      alert_message:   `Health score dropped from ${prevScore} to ${scores.total} this month`,
      metric_value:    scores.total,
      threshold_value: prevScore,
    });
  }

  return alerts;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIMARY: Calculate & persist health score for one customer (49F-2)
// ─────────────────────────────────────────────────────────────────────────────
export async function calculateAndStore(customerId, companyId) {
  const cacheKey = `health_${customerId}_${companyId}`;

  // Fetch customer name
  let customerName = '';
  try {
    const r = await pool.query('SELECT name FROM parties WHERE id=$1', [customerId]);
    customerName = r.rows[0]?.name || '';
  } catch (_) {}

  // Previous score for delta detection
  let prevScore = null;
  try {
    const prev = await pool.query(
      'SELECT health_score FROM customer_health_scores WHERE customer_id=$1 AND company_id=$2',
      [customerId, companyId]
    );
    if (prev.rows.length) prevScore = prev.rows[0].health_score;
  } catch (_) {}

  // Run all 9 dimensions in parallel
  const [revenue, collection, margin, project, quality, service, amc, engagement] = await Promise.all([
    calcRevenueScore(customerId, companyId),
    calcCollectionScore(customerId, companyId),
    calcMarginScore(customerId, companyId),
    calcProjectScore(customerId, companyId),
    calcQualityScore(customerId, companyId),
    calcServiceScore(customerId, companyId),
    calcAMCScore(customerId, companyId),
    calcEngagementScore(customerId, companyId),
  ]);

  const riskDim = await calcRiskScore(
    customerId, companyId,
    collection.details, project.details, quality.details
  );
  const manifestMetrics = await calcManifestMetrics(customerId);

  const dimensions = { revenue, collection, margin, project, quality, service, amc, engagement, risk: riskDim };

  const total = revenue.score + collection.score + margin.score + project.score +
                quality.score + service.score + amc.score + engagement.score + riskDim.score;

  const status   = classify(total);
  const segment  = determineSegment(total, revenue.details);
  const risks    = buildRiskPredictions(
    { revenue: revenue.score, collection: collection.score },
    dimensions
  );
  const alerts   = buildAlerts(customerId, customerName, companyId, { total }, dimensions, prevScore);

  // Upsert health score
  try {
    await pool.query(
      `INSERT INTO customer_health_scores
         (company_id, customer_id, customer_name, health_score, health_status, segment,
          revenue_score, collection_score, margin_score, project_score,
          quality_score, service_score, amc_score, engagement_score, risk_score,
          revenue_loss_risk, payment_default_risk, project_escalation_risk,
          service_escalation_risk, amc_nonrenewal_risk,
          fat_success_pct, sat_success_pct, commissioning_success_pct,
          warranty_claims_count, amc_renewal_pct, calculated_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22,$23,$24,$25,NOW(),NOW())
       ON CONFLICT (company_id, customer_id) DO UPDATE SET
         customer_name=EXCLUDED.customer_name, health_score=EXCLUDED.health_score,
         health_status=EXCLUDED.health_status, segment=EXCLUDED.segment,
         revenue_score=EXCLUDED.revenue_score, collection_score=EXCLUDED.collection_score,
         margin_score=EXCLUDED.margin_score, project_score=EXCLUDED.project_score,
         quality_score=EXCLUDED.quality_score, service_score=EXCLUDED.service_score,
         amc_score=EXCLUDED.amc_score, engagement_score=EXCLUDED.engagement_score,
         risk_score=EXCLUDED.risk_score,
         revenue_loss_risk=EXCLUDED.revenue_loss_risk,
         payment_default_risk=EXCLUDED.payment_default_risk,
         project_escalation_risk=EXCLUDED.project_escalation_risk,
         service_escalation_risk=EXCLUDED.service_escalation_risk,
         amc_nonrenewal_risk=EXCLUDED.amc_nonrenewal_risk,
         fat_success_pct=EXCLUDED.fat_success_pct,
         sat_success_pct=EXCLUDED.sat_success_pct,
         commissioning_success_pct=EXCLUDED.commissioning_success_pct,
         warranty_claims_count=EXCLUDED.warranty_claims_count,
         amc_renewal_pct=EXCLUDED.amc_renewal_pct,
         calculated_at=NOW(), updated_at=NOW()`,
      [
        companyId, customerId, customerName, total, status, segment,
        revenue.score, collection.score, margin.score, project.score,
        quality.score, service.score, amc.score, engagement.score, riskDim.score,
        risks.revenue_loss_risk, risks.payment_default_risk, risks.project_escalation_risk,
        risks.service_escalation_risk, risks.amc_nonrenewal_risk,
        manifestMetrics.fat_success_pct, manifestMetrics.sat_success_pct,
        manifestMetrics.commissioning_success_pct, manifestMetrics.warranty_claims_count,
        manifestMetrics.amc_renewal_pct,
      ]
    );
  } catch (e) {
    console.error('[customerHealth] upsert error:', e.message);
  }

  // Store month-end snapshot
  try {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    await pool.query(
      `INSERT INTO customer_health_history
         (company_id, customer_id, snapshot_month, health_score, health_status,
          revenue_score, collection_score, margin_score, project_score,
          quality_score, service_score, amc_score, engagement_score, risk_score,
          score_delta, trend_direction)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (company_id, customer_id, snapshot_month) DO UPDATE SET
         health_score=EXCLUDED.health_score, health_status=EXCLUDED.health_status,
         revenue_score=EXCLUDED.revenue_score, collection_score=EXCLUDED.collection_score,
         margin_score=EXCLUDED.margin_score, project_score=EXCLUDED.project_score,
         quality_score=EXCLUDED.quality_score, service_score=EXCLUDED.service_score,
         amc_score=EXCLUDED.amc_score, engagement_score=EXCLUDED.engagement_score,
         risk_score=EXCLUDED.risk_score, score_delta=EXCLUDED.score_delta,
         trend_direction=EXCLUDED.trend_direction`,
      [
        companyId, customerId, monthStart.toISOString().split('T')[0],
        total, status,
        revenue.score, collection.score, margin.score, project.score,
        quality.score, service.score, amc.score, engagement.score, riskDim.score,
        prevScore !== null ? total - prevScore : null,
        prevScore === null ? 'stable' : total > prevScore ? 'up' : total < prevScore ? 'down' : 'stable',
      ]
    );
  } catch (_) {}

  // Persist new alerts (deduplicate — only insert if no unresolved alert of same type exists today)
  for (const alert of alerts) {
    try {
      await pool.query(
        `INSERT INTO customer_health_alerts
           (company_id, customer_id, customer_name, alert_type, alert_severity,
            alert_title, alert_message, metric_value, threshold_value)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
         WHERE NOT EXISTS (
           SELECT 1 FROM customer_health_alerts
           WHERE company_id=$1 AND customer_id=$2 AND alert_type=$4
             AND is_resolved=FALSE
             AND triggered_at >= NOW()-INTERVAL '7 days'
         )`,
        [
          alert.company_id, alert.customer_id, alert.customer_name,
          alert.alert_type, alert.alert_severity, alert.alert_title,
          alert.alert_message, alert.metric_value, alert.threshold_value,
        ]
      );
    } catch (_) {}
  }

  invalidateCache(customerId, companyId);

  const result = {
    customer_id:   customerId,
    customer_name: customerName,
    company_id:    companyId,
    health_score:  total,
    health_status: status,
    segment,
    scores: {
      revenue:    revenue.score,
      collection: collection.score,
      margin:     margin.score,
      project:    project.score,
      quality:    quality.score,
      service:    service.score,
      amc:        amc.score,
      engagement: engagement.score,
      risk:       riskDim.score,
    },
    details: dimensions,
    risks,
    manifest: manifestMetrics,
    alerts_raised: alerts.length,
    calculated_at: new Date().toISOString(),
  };

  cacheSet(cacheKey, result, 300_000);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET stored health score (fast — reads from DB, no recalculation)
// ─────────────────────────────────────────────────────────────────────────────
export async function getStoredHealth(customerId, companyId) {
  try {
    const r = await pool.query(
      `SELECT *, EXTRACT(EPOCH FROM (NOW()-calculated_at))/60 AS age_minutes
       FROM customer_health_scores
       WHERE customer_id=$1 AND company_id=$2`,
      [customerId, companyId]
    );
    if (!r.rows.length) return null;
    return r.rows[0];
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 12-MONTH TREND  (49F-13, 49F-24)
// ─────────────────────────────────────────────────────────────────────────────
export async function getHealthTrend(customerId, companyId) {
  try {
    const r = await pool.query(
      `SELECT snapshot_month, health_score, health_status,
              revenue_score, collection_score, margin_score,
              project_score, quality_score, service_score,
              amc_score, engagement_score, risk_score,
              score_delta, trend_direction
       FROM customer_health_history
       WHERE customer_id=$1 AND company_id=$2
       ORDER BY snapshot_month DESC LIMIT 12`,
      [customerId, companyId]
    );
    return r.rows.reverse();
  } catch (_) { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// CEO DASHBOARD  (49F-18) — distribution + aggregates
// ─────────────────────────────────────────────────────────────────────────────
export async function getCEODashboard(companyId) {
  const cacheKey = `dashboard_${companyId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let distribution = { Excellent: 0, Good: 0, Watchlist: 0, Critical: 0 };
  let customers = [];

  try {
    const r = await pool.query(
      `SELECT chs.*, p.name AS customer_name, p.city, p.state
       FROM customer_health_scores chs
       JOIN parties p ON p.id = chs.customer_id
       WHERE chs.company_id=$1
       ORDER BY chs.health_score DESC`,
      [companyId]
    );
    customers = r.rows;
    customers.forEach(c => {
      if (distribution[c.health_status] !== undefined) distribution[c.health_status]++;
    });
  } catch (_) {}

  // Health trend for last 6 months (aggregate)
  let trend = [];
  try {
    const r = await pool.query(
      `SELECT TO_CHAR(snapshot_month,'Mon YY') AS month,
              snapshot_month,
              ROUND(AVG(health_score))::int AS avg_score,
              COUNT(CASE WHEN health_status='Excellent' THEN 1 END)::int AS excellent,
              COUNT(CASE WHEN health_status='Good' THEN 1 END)::int AS good,
              COUNT(CASE WHEN health_status='Watchlist' THEN 1 END)::int AS watchlist,
              COUNT(CASE WHEN health_status='Critical' THEN 1 END)::int AS critical
       FROM customer_health_history
       WHERE company_id=$1 AND snapshot_month >= NOW()-INTERVAL '12 months'
       GROUP BY snapshot_month ORDER BY snapshot_month`,
      [companyId]
    );
    trend = r.rows;
  } catch (_) {}

  const result = {
    distribution,
    total_customers:      customers.length,
    excellent_customers:  customers.filter(c => c.health_status === 'Excellent'),
    good_customers:       customers.filter(c => c.health_status === 'Good'),
    watchlist_customers:  customers.filter(c => c.health_status === 'Watchlist'),
    critical_customers:   customers.filter(c => c.health_status === 'Critical'),
    all_customers:        customers,
    trend,
    generated_at:         new Date().toISOString(),
  };

  cacheSet(cacheKey, result, 120_000);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// SALES DASHBOARD  (49F-19)
// ─────────────────────────────────────────────────────────────────────────────
export async function getSalesDashboard(companyId) {
  try {
    const r = await pool.query(
      `SELECT chs.customer_id, chs.health_score, chs.health_status, chs.segment,
              chs.revenue_score, chs.collection_score, chs.amc_score,
              chs.revenue_loss_risk, chs.amc_nonrenewal_risk,
              chs.amc_score, chs.fat_success_pct, chs.sat_success_pct,
              p.name AS customer_name, p.city, p.state,
              (SELECT end_date FROM amc_contracts
               WHERE customer_id=chs.customer_id AND status='active'
               ORDER BY end_date ASC LIMIT 1) AS amc_expiry
       FROM customer_health_scores chs
       JOIN parties p ON p.id=chs.customer_id
       WHERE chs.company_id=$1
       ORDER BY chs.health_score ASC`,
      [companyId]
    );

    const all = r.rows;
    return {
      needs_attention:   all.filter(c => c.health_status === 'Watchlist'),
      at_risk:           all.filter(c => c.health_status === 'Critical'),
      growing:           all.filter(c => c.revenue_loss_risk === 'low' && c.health_score >= 75),
      upcoming_renewals: all.filter(c => {
        if (!c.amc_expiry) return false;
        const diff = (new Date(c.amc_expiry) - Date.now()) / 86400000;
        return diff >= 0 && diff <= 90;
      }),
      total_customers:   all.length,
    };
  } catch (_) { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE DASHBOARD  (49F-20)
// ─────────────────────────────────────────────────────────────────────────────
export async function getServiceDashboard(companyId) {
  try {
    const r = await pool.query(
      `SELECT chs.customer_id, chs.health_score, chs.health_status,
              chs.service_score, chs.quality_score, chs.service_escalation_risk,
              p.name AS customer_name, p.city,
              (SELECT COUNT(*)::int FROM support_tickets st
               WHERE st.customer_id=chs.customer_id AND st.status NOT IN ('resolved','closed')
               AND st.priority='critical') AS critical_open_tickets,
              (SELECT COUNT(*)::int FROM support_tickets st
               WHERE st.customer_id=chs.customer_id AND st.status NOT IN ('resolved','closed')) AS open_tickets
       FROM customer_health_scores chs
       JOIN parties p ON p.id=chs.customer_id
       WHERE chs.company_id=$1
       ORDER BY chs.service_score ASC`,
      [companyId]
    );
    const all = r.rows;
    return {
      open_escalations:      all.filter(c => c.critical_open_tickets > 0),
      repeated_complaints:   all.filter(c => c.quality_score <= 3),
      low_satisfaction:      all.filter(c => c.service_score <= 3),
      total_customers:       all.length,
    };
  } catch (_) { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// FINANCE DASHBOARD  (49F-21)
// ─────────────────────────────────────────────────────────────────────────────
export async function getFinanceDashboard(companyId) {
  try {
    const r = await pool.query(
      `SELECT chs.customer_id, chs.health_score, chs.health_status,
              chs.collection_score, chs.margin_score, chs.payment_default_risk,
              p.name AS customer_name, p.city,
              (SELECT COALESCE(SUM(total_amount),0) FROM invoices
               WHERE party_id=chs.customer_id AND status IN ('overdue','pending')) AS outstanding,
              (SELECT COUNT(*)::int FROM invoices
               WHERE party_id=chs.customer_id AND status='overdue'
               AND created_at < NOW()-INTERVAL '90 days') AS overdue_90d
       FROM customer_health_scores chs
       JOIN parties p ON p.id=chs.customer_id
       WHERE chs.company_id=$1
       ORDER BY chs.collection_score ASC`,
      [companyId]
    );
    const all = r.rows;
    return {
      high_outstanding:    all.filter(c => parseFloat(c.outstanding) > 100000),
      payment_delays:      all.filter(c => c.collection_score < 15),
      collection_risk:     all.filter(c => c.payment_default_risk !== 'low'),
      overdue_90d:         all.filter(c => c.overdue_90d > 0),
      total_customers:     all.length,
    };
  } catch (_) { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT DASHBOARD  (49F-22)
// ─────────────────────────────────────────────────────────────────────────────
export async function getProjectDashboard(companyId) {
  try {
    const r = await pool.query(
      `SELECT chs.customer_id, chs.health_score, chs.health_status,
              chs.project_score, chs.project_escalation_risk,
              chs.fat_success_pct, chs.sat_success_pct, chs.commissioning_success_pct,
              p.name AS customer_name, p.city,
              (SELECT COUNT(*)::int FROM projects
               WHERE customer_id=chs.customer_id AND deleted_at IS NULL
               AND status='active' AND end_date IS NOT NULL AND end_date < NOW()) AS overdue_projects,
              (SELECT COUNT(*)::int FROM projects
               WHERE customer_id=chs.customer_id AND deleted_at IS NULL
               AND status='active') AS active_projects
       FROM customer_health_scores chs
       JOIN parties p ON p.id=chs.customer_id
       WHERE chs.company_id=$1
       ORDER BY chs.project_score ASC`,
      [companyId]
    );
    const all = r.rows;
    return {
      delayed_projects:   all.filter(c => c.overdue_projects > 0),
      cost_overruns:      all.filter(c => c.project_score <= 3 && c.active_projects > 0),
      escalation_risk:    all.filter(c => c.project_escalation_risk !== 'low'),
      total_customers:    all.length,
    };
  } catch (_) { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// EARLY WARNINGS  (49F-14)
// ─────────────────────────────────────────────────────────────────────────────
export async function getActiveAlerts(companyId) {
  const cacheKey = `alerts_${companyId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const r = await pool.query(
      `SELECT * FROM customer_health_alerts
       WHERE company_id=$1 AND is_resolved=FALSE
       ORDER BY triggered_at DESC LIMIT 200`,
      [companyId]
    );
    const result = r.rows;
    cacheSet(cacheKey, result, 60_000);
    return result;
  } catch (_) { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK RECALCULATE — all customers for a company (nightly job)
// ─────────────────────────────────────────────────────────────────────────────
export async function recalculateAll(companyId) {
  let customers = [];
  try {
    const r = await pool.query(
      `SELECT DISTINCT p.id FROM parties p
       WHERE (p.type='customer' OR p.type IS NULL)
       AND (SELECT company_id FROM companies LIMIT 1) = $1
       ORDER BY p.id`,
      [companyId]
    );
    customers = r.rows;
  } catch (_) {}

  // If company_id not on parties, use invoices as proxy
  if (customers.length === 0) {
    try {
      const r = await pool.query(
        `SELECT DISTINCT party_id AS id FROM invoices
         WHERE company_id=$1 AND party_id IS NOT NULL`,
        [companyId]
      );
      customers = r.rows;
    } catch (_) {}
  }

  let processed = 0;
  for (const c of customers) {
    try {
      await calculateAndStore(c.id, companyId);
      processed++;
    } catch (_) {}
  }

  return { processed, total: customers.length };
}
