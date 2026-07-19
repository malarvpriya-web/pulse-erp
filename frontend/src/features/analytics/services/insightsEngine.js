/**
 * insightsEngine.js — Client-side rule engine.
 * generateInsights(metrics) → array of insight objects.
 *
 * Each insight: { type, rule, message, severity (1-3) }
 * type: 'success' | 'warning' | 'danger' | 'info'
 */

const RULES = [
  {
    id: 'high_attrition',
    check: m => m.attritionRate > 15,
    type: 'danger',
    severity: 3,
    message: m => `Attrition at ${m.attritionRate.toFixed(1)}% — critical. Immediate retention action needed.`,
  },
  {
    id: 'high_attrition_moderate',
    check: m => m.attritionRate > 10 && m.attritionRate <= 15,
    type: 'warning',
    severity: 2,
    message: m => `Attrition at ${m.attritionRate.toFixed(1)}% — above 10% benchmark. Review exit trends.`,
  },
  {
    id: 'burn_rate_risk',
    check: m => m.burnRate != null && m.budget != null && m.burnRate > m.budget * 0.9,
    type: 'danger',
    severity: 3,
    message: () => 'Burn rate exceeds 90% of budget — risk of overrun this quarter.',
  },
  {
    id: 'pipeline_healthy',
    check: m => m.pipelineValue != null && m.salesTarget != null && m.pipelineValue >= m.salesTarget * 1.5,
    type: 'success',
    severity: 1,
    message: m => `Sales pipeline at ₹${(m.pipelineValue / 100000).toFixed(1)}L — 1.5× target coverage. On track.`,
  },
  {
    id: 'low_offer_acceptance',
    check: m => m.offerAcceptanceRate != null && m.offerAcceptanceRate < 70,
    type: 'warning',
    severity: 2,
    message: m => `Offer acceptance at ${m.offerAcceptanceRate}% — below 70% benchmark. Review compensation.`,
  },
  {
    id: 'projects_at_risk',
    check: m => m.projectsAtRisk != null && m.projectsAtRisk > 2,
    type: 'danger',
    severity: 3,
    message: m => `${m.projectsAtRisk} projects flagged at-risk. Escalate for resource reallocation.`,
  },
  {
    id: 'workload_imbalance',
    check: m => {
      if (!m.deptUtilization || m.deptUtilization.length < 2) return false;
      const vals = m.deptUtilization.map(d => d.utilization || 0);
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      return min > 0 && max / min > 2;
    },
    type: 'warning',
    severity: 2,
    message: () => 'Significant workload imbalance across departments. Consider cross-team reallocation.',
  },
  {
    id: 'revenue_growth_positive',
    check: m => m.revenueGrowth != null && m.revenueGrowth > 10,
    type: 'success',
    severity: 1,
    message: m => `Revenue growing at ${m.revenueGrowth.toFixed(1)}% YoY — strong momentum.`,
  },
];

/**
 * generateInsights(metrics) — run all rules against a metrics object.
 * @param {Object} metrics — any subset of the following keys:
 *   attritionRate, burnRate, budget, pipelineValue, salesTarget,
 *   offerAcceptanceRate, projectsAtRisk, deptUtilization, revenueGrowth
 * @returns {Array<{type, rule, message, severity}>}
 */
export function generateInsights(metrics = {}) {
  return RULES
    .filter(r => {
      try { return r.check(metrics); } catch { return false; }
    })
    .map(r => ({
      type:     r.type,
      rule:     r.id,
      message:  r.message(metrics),
      severity: r.severity,
    }))
    .sort((a, b) => b.severity - a.severity);
}

export default generateInsights;
