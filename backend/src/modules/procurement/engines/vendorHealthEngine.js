/**
 * Phase 49G — Vendor Health Engine
 *
 * Pure scoring functions. No DB calls.
 * Input: raw data objects. Output: scored dimensions + health_score + health_status.
 *
 * Weights (must sum to 1.0):
 *   Quality     0.25
 *   Delivery    0.20
 *   Cost        0.15
 *   Support     0.10
 *   Compliance  0.10
 *   Financial   0.10
 *   Dependency  0.05
 *   Risk Events 0.05
 */

const WEIGHTS = {
  quality:     0.25,
  delivery:    0.20,
  cost:        0.15,
  support:     0.10,
  compliance:  0.10,
  financial:   0.10,
  dependency:  0.05,
  risk_events: 0.05,
};

// ── Health status thresholds ────────────────────────────────────────────────────
export function classifyHealth(score) {
  if (score >= 90) return 'Preferred';
  if (score >= 75) return 'Approved';
  if (score >= 50) return 'Watchlist';
  return 'Critical';
}

// ── 49G-3  QUALITY SCORE (0–100) ───────────────────────────────────────────────
// Inputs: { totalInspections, passedInspections, openNCR, repeatNCR, criticalNCR,
//           totalCAPAs, closedCAPAs, rejectionQty, totalReceivedQty }
export function scoreQuality({ totalInspections = 0, passedInspections = 0,
  openNCR = 0, repeatNCR = 0, criticalNCR = 0,
  totalCAPAs = 0, closedCAPAs = 0,
  rejectionQty = 0, totalReceivedQty = 0 } = {}) {

  // Base: pass rate
  const passRate = totalInspections > 0
    ? (passedInspections / totalInspections) * 100
    : 75; // default when no data

  let base;
  if (passRate >= 98) base = 100;
  else if (passRate >= 95) base = 80;
  else if (passRate >= 90) base = 60;
  else base = 20;

  // NCR penalties
  let penalty = 0;
  penalty += openNCR * 5;            // -5 per open NCR
  penalty += repeatNCR * 8;          // -8 per repeat NCR
  penalty += criticalNCR * 15;       // -15 per critical NCR

  // CAPA closure bonus/penalty
  const capaClosurePct = totalCAPAs > 0 ? (closedCAPAs / totalCAPAs) * 100 : 100;
  if (capaClosurePct < 60) penalty += 10;
  else if (capaClosurePct >= 90) penalty -= 5; // bonus for excellent closure

  // Rejection rate penalty (PPM proxy)
  const rejectionRate = totalReceivedQty > 0
    ? (rejectionQty / totalReceivedQty) * 100 : 0;
  if (rejectionRate > 5) penalty += 15;
  else if (rejectionRate > 2) penalty += 8;

  return {
    score: Math.max(0, Math.min(100, base - penalty)),
    passRate: parseFloat(passRate.toFixed(2)),
    capaClosurePct: parseFloat(capaClosurePct.toFixed(2)),
    openNCR,
    criticalNCR,
  };
}

// ── 49G-4  DELIVERY SCORE (0–100) ──────────────────────────────────────────────
// Inputs: { totalGRNs, onTimeGRNs, delayedGRNs, avgDelayDays, partialDeliveries }
export function scoreDelivery({ totalGRNs = 0, onTimeGRNs = 0,
  delayedGRNs = 0, avgDelayDays = 0, partialDeliveries = 0 } = {}) {

  const otdPct = totalGRNs > 0 ? (onTimeGRNs / totalGRNs) * 100 : 75;

  let base;
  if (otdPct >= 95) base = 100;
  else if (otdPct >= 90) base = 75;
  else if (otdPct >= 80) base = 50;
  else base = 0;

  // Average delay penalty
  let penalty = 0;
  if (avgDelayDays > 14) penalty += 20;
  else if (avgDelayDays > 7) penalty += 10;
  else if (avgDelayDays > 3) penalty += 5;

  // Partial delivery penalty
  const partialRate = totalGRNs > 0 ? (partialDeliveries / totalGRNs) * 100 : 0;
  if (partialRate > 20) penalty += 10;
  else if (partialRate > 10) penalty += 5;

  return {
    score: Math.max(0, Math.min(100, base - penalty)),
    otdPct: parseFloat(otdPct.toFixed(2)),
    avgDelayDays: parseFloat(avgDelayDays.toFixed(1)),
  };
}

// ── 49G-5  COST SCORE (0–100) ───────────────────────────────────────────────────
// Inputs: { priceVariancePct, rfqCompetitive, escalationCount, last12mPOCount }
export function scoreCost({ priceVariancePct = 0, rfqCompetitive = true,
  escalationCount = 0, last12mPOCount = 1 } = {}) {

  // Price stability: variance < 5% is stable
  let base;
  if (priceVariancePct <= 5 && rfqCompetitive) base = 100;
  else if (priceVariancePct <= 10) base = 67;
  else base = 33;

  // Escalation penalty
  const escalationRate = last12mPOCount > 0
    ? (escalationCount / last12mPOCount) * 100 : 0;
  let penalty = 0;
  if (escalationRate > 30) penalty += 20;
  else if (escalationRate > 15) penalty += 10;

  return {
    score: Math.max(0, Math.min(100, base - penalty)),
    priceVariancePct: parseFloat(priceVariancePct.toFixed(2)),
    escalationCount,
  };
}

// ── 49G-6  SUPPORT SCORE (0–100) ────────────────────────────────────────────────
// Inputs: { storedSupportScore, avgResponseHours, openIssues, resolvedIssues }
export function scoreSupport({ storedSupportScore = null,
  avgResponseHours = 24, openIssues = 0, resolvedIssues = 0 } = {}) {

  // Prefer stored scorecard value if available
  if (storedSupportScore != null && storedSupportScore > 0) {
    return { score: Math.min(100, parseFloat(storedSupportScore)), source: 'stored' };
  }

  // Compute from response time
  let base;
  if (avgResponseHours <= 4) base = 100;         // Excellent
  else if (avgResponseHours <= 24) base = 70;    // Good
  else if (avgResponseHours <= 72) base = 50;    // Average
  else base = 0;                                  // Poor

  // Issue resolution bonus
  const resolutionRate = (openIssues + resolvedIssues) > 0
    ? (resolvedIssues / (openIssues + resolvedIssues)) * 100 : 80;
  if (resolutionRate >= 90) base = Math.min(100, base + 10);

  return { score: Math.max(0, Math.min(100, base)), source: 'computed' };
}

// ── 49G-7  COMPLIANCE SCORE (0–100) ─────────────────────────────────────────────
// Inputs: { hasGST, hasPAN, hasMSME, hasISO, docsExpiringSoon,
//           gstVerified, panVerified }
export function scoreCompliance({ hasGST = false, hasPAN = false,
  hasMSME = false, hasISO = false,
  docsExpiringSoon = 0, expiredDocs = 0,
  gstVerified = false, panVerified = false } = {}) {

  let score = 100;

  // Critical compliance gaps
  if (!hasGST)            score -= 25;
  else if (!gstVerified)  score -= 10;

  if (!hasPAN)            score -= 20;
  else if (!panVerified)  score -= 8;

  if (!hasISO)            score -= 10;
  if (!hasMSME)           score -= 5;

  // Document expiry warnings
  score -= docsExpiringSoon * 5;   // -5 per doc expiring in 30 days
  score -= expiredDocs * 15;       // -15 per expired doc

  return { score: Math.max(0, Math.min(100, score)), hasGST, hasPAN, hasISO, hasMSME };
}

// ── 49G-8  FINANCIAL STABILITY SCORE (0–100) ────────────────────────────────────
// Inputs: { annualTurnover, bankVerified, pendingPaymentDisputes,
//           outstandingVsLimit, creditRating }
export function scoreFinancial({ annualTurnover = 0, bankVerified = false,
  pendingPaymentDisputes = 0, outstandingVsLimitPct = 0,
  creditRating = 'B' } = {}) {

  let score = 100;

  // Bank verification
  if (!bankVerified) score -= 20;

  // Turnover thresholds (in INR)
  if (!annualTurnover)           score -= 20;
  else if (annualTurnover < 1_000_000)  score -= 20; // < 10L — micro vendor
  else if (annualTurnover < 10_000_000) score -= 10; // < 1Cr — small vendor

  // Payment disputes
  score -= Math.min(pendingPaymentDisputes * 10, 30);

  // Outstanding vs credit limit
  if (outstandingVsLimitPct > 90) score -= 20;
  else if (outstandingVsLimitPct > 70) score -= 10;

  // Credit rating map
  const ratingMap = { 'AAA': 5, 'AA': 4, 'A': 3, 'BBB': 0, 'BB': -5, 'B': -10, 'C': -20, 'D': -30 };
  score += (ratingMap[creditRating] || 0);

  return { score: Math.max(0, Math.min(100, score)), bankVerified, annualTurnover };
}

// ── 49G-9  DEPENDENCY SCORE (0–100) ─────────────────────────────────────────────
// Inputs: { isSingleSource, isCriticalSupplier, isLongLead,
//           alternativeCount, spendConcentrationPct }
export function scoreDependency({ isSingleSource = false, isCriticalSupplier = false,
  isLongLead = false, alternativeCount = 3,
  spendConcentrationPct = 0 } = {}) {

  // Single source = worst case
  if (isSingleSource) {
    return { score: 20, isSingleSource: true, isCriticalSupplier, isLongLead };
  }

  let score = 100;

  if (isCriticalSupplier) score -= 20;
  if (isLongLead)         score -= 20;

  // Alternative source count
  if (alternativeCount === 0) score -= 40;
  else if (alternativeCount === 1) score -= 20;
  else if (alternativeCount === 2) score -= 10;

  // Spend concentration (if > 40% of spend is on one vendor)
  if (spendConcentrationPct > 60) score -= 20;
  else if (spendConcentrationPct > 40) score -= 10;

  return {
    score: Math.max(0, Math.min(100, score)),
    isSingleSource, isCriticalSupplier, isLongLead, alternativeCount,
  };
}

// ── 49G-10  RISK EVENTS SCORE (0–100) ───────────────────────────────────────────
// Inputs: { lateDeliveries12m, criticalNCR12m, failedAudits12m,
//           supplyInterruptions, complianceViolations }
export function scoreRiskEvents({ lateDeliveries12m = 0, criticalNCR12m = 0,
  failedAudits12m = 0, supplyInterruptions = 0,
  complianceViolations = 0 } = {}) {

  // Any critical event = major penalty
  if (criticalNCR12m > 0 || failedAudits12m > 0 || supplyInterruptions > 0) {
    const penalty = criticalNCR12m * 20 + failedAudits12m * 25 + supplyInterruptions * 30;
    return {
      score: Math.max(0, 100 - penalty),
      severity: 'Major',
      criticalNCR12m, failedAudits12m, supplyInterruptions,
    };
  }

  let score = 100;
  score -= Math.min(lateDeliveries12m * 10, 40);
  score -= complianceViolations * 15;

  const severity = score < 50 ? 'Minor' : 'None';

  return {
    score: Math.max(0, Math.min(100, score)),
    severity, lateDeliveries12m, complianceViolations,
  };
}

// ── MASTER HEALTH CALCULATOR ─────────────────────────────────────────────────────
export function computeVendorHealth({
  qualityInputs = {},
  deliveryInputs = {},
  costInputs = {},
  supportInputs = {},
  complianceInputs = {},
  financialInputs = {},
  dependencyInputs = {},
  riskEventInputs = {},
} = {}) {

  const qualityResult     = scoreQuality(qualityInputs);
  const deliveryResult    = scoreDelivery(deliveryInputs);
  const costResult        = scoreCost(costInputs);
  const supportResult     = scoreSupport(supportInputs);
  const complianceResult  = scoreCompliance(complianceInputs);
  const financialResult   = scoreFinancial(financialInputs);
  const dependencyResult  = scoreDependency(dependencyInputs);
  const riskEventsResult  = scoreRiskEvents(riskEventInputs);

  const health_score = (
    qualityResult.score    * WEIGHTS.quality    +
    deliveryResult.score   * WEIGHTS.delivery   +
    costResult.score       * WEIGHTS.cost       +
    supportResult.score    * WEIGHTS.support    +
    complianceResult.score * WEIGHTS.compliance +
    financialResult.score  * WEIGHTS.financial  +
    dependencyResult.score * WEIGHTS.dependency +
    riskEventsResult.score * WEIGHTS.risk_events
  );

  const roundedScore = parseFloat(health_score.toFixed(2));

  return {
    health_score:      roundedScore,
    health_status:     classifyHealth(roundedScore),
    quality_score:     parseFloat(qualityResult.score.toFixed(2)),
    delivery_score:    parseFloat(deliveryResult.score.toFixed(2)),
    cost_score:        parseFloat(costResult.score.toFixed(2)),
    support_score:     parseFloat(supportResult.score.toFixed(2)),
    compliance_score:  parseFloat(complianceResult.score.toFixed(2)),
    financial_score:   parseFloat(financialResult.score.toFixed(2)),
    dependency_score:  parseFloat(dependencyResult.score.toFixed(2)),
    risk_score:        parseFloat(riskEventsResult.score.toFixed(2)),
    detail: {
      quality:     qualityResult,
      delivery:    deliveryResult,
      cost:        costResult,
      support:     supportResult,
      compliance:  complianceResult,
      financial:   financialResult,
      dependency:  dependencyResult,
      risk_events: riskEventsResult,
    },
    weights: WEIGHTS,
  };
}

// ── EARLY WARNING DETECTION ───────────────────────────────────────────────────────
export function detectEarlyWarnings({ vendorId, deliveryResult, qualityResult,
  complianceInputs, costResult, riskEventInputs, thresholds = {} } = {}) {

  const warnings = [];

  const {
    otdThreshold          = 85,
    openNCRThreshold      = 3,
    capaOverdueDays       = 30,
    priceIncreaseThreshold = 15,
    complianceExpireDays  = 30,
  } = thresholds;

  if (deliveryResult?.otdPct < otdThreshold) {
    warnings.push({
      vendor_id:       vendorId,
      warning_type:    'LOW_OTD',
      severity:        deliveryResult.otdPct < 70 ? 'Critical' : 'High',
      message:         `On-Time Delivery ${deliveryResult.otdPct.toFixed(1)}% is below ${otdThreshold}% threshold`,
      metric_value:    deliveryResult.otdPct,
      threshold_value: otdThreshold,
    });
  }

  if (qualityResult?.openNCR > openNCRThreshold) {
    warnings.push({
      vendor_id:       vendorId,
      warning_type:    'OPEN_NCR_EXCESS',
      severity:        qualityResult.openNCR > openNCRThreshold * 2 ? 'Critical' : 'High',
      message:         `${qualityResult.openNCR} open NCRs exceed threshold of ${openNCRThreshold}`,
      metric_value:    qualityResult.openNCR,
      threshold_value: openNCRThreshold,
    });
  }

  if (qualityResult?.capaClosurePct < 60) {
    warnings.push({
      vendor_id:       vendorId,
      warning_type:    'CAPA_OVERDUE',
      severity:        'Medium',
      message:         `CAPA closure rate ${qualityResult.capaClosurePct.toFixed(1)}% — action required`,
      metric_value:    qualityResult.capaClosurePct,
      threshold_value: 60,
    });
  }

  if (complianceInputs?.docsExpiringSoon > 0) {
    warnings.push({
      vendor_id:       vendorId,
      warning_type:    'COMPLIANCE_EXPIRING',
      severity:        'Medium',
      message:         `${complianceInputs.docsExpiringSoon} compliance document(s) expiring within ${complianceExpireDays} days`,
      metric_value:    complianceInputs.docsExpiringSoon,
      threshold_value: 0,
    });
  }

  if (costResult?.priceVariancePct > priceIncreaseThreshold) {
    warnings.push({
      vendor_id:       vendorId,
      warning_type:    'PRICE_ESCALATION',
      severity:        'Medium',
      message:         `Price variance ${costResult.priceVariancePct.toFixed(1)}% exceeds ${priceIncreaseThreshold}% threshold`,
      metric_value:    costResult.priceVariancePct,
      threshold_value: priceIncreaseThreshold,
    });
  }

  if (riskEventInputs?.failedAudits12m > 0) {
    warnings.push({
      vendor_id:       vendorId,
      warning_type:    'AUDIT_FAILURE',
      severity:        'Critical',
      message:         `${riskEventInputs.failedAudits12m} failed audit(s) in the last 12 months`,
      metric_value:    riskEventInputs.failedAudits12m,
      threshold_value: 0,
    });
  }

  return warnings;
}

export default {
  computeVendorHealth,
  classifyHealth,
  detectEarlyWarnings,
  scoreQuality,
  scoreDelivery,
  scoreCost,
  scoreSupport,
  scoreCompliance,
  scoreFinancial,
  scoreDependency,
  scoreRiskEvents,
  WEIGHTS,
};
