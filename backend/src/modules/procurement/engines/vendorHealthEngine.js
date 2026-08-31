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
/**
 * `hasEvidence` is whether this supplier has any operational history at all --
 * a PO, a receipt, an inspection or an NCR. Without one, the composite is built
 * almost entirely out of the defaults in the dimension scorers, and those
 * defaults are not neutral: scoreDelivery's no-data otdPct of 75 falls through
 * to `base = 0` (the >= 80 bucket is the lowest that scores anything) and
 * scoreQuality's no-data passRate of 75 lands on `base = 20`. A supplier nobody
 * has ever ordered from therefore scored ~37 and was labelled 'Critical' --
 * indistinguishable, on the dashboard and in vendors.classification, from one
 * that had genuinely failed. 'Unrated' says what is actually true.
 */
export function classifyHealth(score, hasEvidence = true) {
  if (!hasEvidence) return 'Unrated';
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
    // `passRate` is the 75 default above when nobody has inspected anything.
    // That prior is fine inside the composite and a lie everywhere else, so
    // every consumer that publishes or alerts on the number must check this.
    passRateMeasured: totalInspections > 0,
    capaClosurePct: parseFloat(capaClosurePct.toFixed(2)),
    capaMeasured: totalCAPAs > 0,
    // Anything at all to judge quality on: an inspection, a receipt to reject
    // from, an NCR, or a CAPA. With none of them the score above is the bare
    // `base = 20` default and must not enter the composite.
    measured: totalInspections > 0 || totalReceivedQty > 0
              || openNCR > 0 || repeatNCR > 0 || criticalNCR > 0 || totalCAPAs > 0,
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
    // See scoreQuality: 75 is the no-receipts prior, not a delivery record.
    otdMeasured: totalGRNs > 0,
    measured: totalGRNs > 0,
    totalGRNs,
    avgDelayDays: parseFloat(avgDelayDays.toFixed(1)),
  };
}

// ── 49G-5  COST SCORE (0–100) ───────────────────────────────────────────────────
// Inputs: { priceVariancePct, rfqCompetitive, escalationCount, last12mPOCount }
export function scoreCost({ priceVariancePct = 0, rfqCompetitive = true,
  escalationCount = 0, last12mPOCount = 1,
  // Explicit, because a priceVariancePct of 0 is produced BOTH by a supplier
  // whose prices never moved and by one with no price history to compare --
  // and the first deserves 100 while the second deserves no vote at all.
  hasPriceHistory = true } = {}) {

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
    measured: hasPriceHistory,
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
    return { score: Math.min(100, parseFloat(storedSupportScore)), measured: true, source: 'stored' };
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

  // avgResponseHours defaults to 24 and nothing in this schema measures it, so
  // without a stored scorecard value the whole dimension is the 70 default.
  return {
    score: Math.max(0, Math.min(100, base)),
    measured: openIssues + resolvedIssues > 0,
    source: 'computed',
  };
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

  // Always measured: these are vendor-master facts. A missing GST certificate
  // is a finding about the supplier, not a gap in our data about them.
  return { score: Math.max(0, Math.min(100, score)), measured: true, hasGST, hasPAN, hasISO, hasMSME };
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

  return { score: Math.max(0, Math.min(100, score)), measured: true, bankVerified, annualTurnover };
}

// ── 49G-9  DEPENDENCY SCORE (0–100) ─────────────────────────────────────────────
// Inputs: { isSingleSource, isCriticalSupplier, isLongLead,
//           alternativeCount, spendConcentrationPct }
export function scoreDependency({ isSingleSource = false, isCriticalSupplier = false,
  isLongLead = false, alternativeCount = 3,
  spendConcentrationPct = 0 } = {}) {

  // Single source = worst case
  if (isSingleSource) {
    return { score: 20, measured: true, isSingleSource: true, isCriticalSupplier, isLongLead };
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
    measured: true,
    isSingleSource, isCriticalSupplier, isLongLead, alternativeCount,
  };
}

// ── 49G-10  RISK EVENTS SCORE (0–100) ───────────────────────────────────────────
// Inputs: { lateDeliveries12m, criticalNCR12m, failedAudits12m,
//           supplyInterruptions, complianceViolations }
export function scoreRiskEvents({ lateDeliveries12m = 0, criticalNCR12m = 0,
  failedAudits12m = 0, supplyInterruptions = 0,
  complianceViolations = 0,
  // "No bad events on record" is trivially true for a supplier nobody has ever
  // transacted with, and it scores 100 -- a clean record earned by never being
  // used. Explicit, like scoreCost's hasPriceHistory.
  hasHistory = true } = {}) {

  // Any critical event = major penalty
  if (criticalNCR12m > 0 || failedAudits12m > 0 || supplyInterruptions > 0) {
    const penalty = criticalNCR12m * 20 + failedAudits12m * 25 + supplyInterruptions * 30;
    return {
      score: Math.max(0, 100 - penalty),
      // A recorded critical event IS history, whatever hasHistory says.
      measured: true,
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
    measured: hasHistory || complianceViolations > 0,
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
  // Any operational history at all. Defaults true so an existing caller that
  // does not pass it keeps the old behaviour rather than silently going Unrated.
  hasEvidence = true,
} = {}) {

  const qualityResult     = scoreQuality(qualityInputs);
  const deliveryResult    = scoreDelivery(deliveryInputs);
  const costResult        = scoreCost(costInputs);
  const supportResult     = scoreSupport(supportInputs);
  const complianceResult  = scoreCompliance(complianceInputs);
  const financialResult   = scoreFinancial(financialInputs);
  const dependencyResult  = scoreDependency(dependencyInputs);
  const riskEventsResult  = scoreRiskEvents(riskEventInputs);

  // ── Weight ONLY the dimensions that have evidence ──────────────────────────
  //
  // The weights are a fixed 1.0 split, so an unmeasured dimension used to vote
  // its default straight into the composite -- and the defaults are not neutral
  // in either direction. scoreDelivery's no-receipts prior scores 0 (its 75%
  // otdPct falls below the >= 80 bucket) and scoreQuality's scores 20, while
  // scoreCost and scoreRiskEvents both score 100 for having no history to fault.
  // A supplier with one NCR and no deliveries was taking a hard 0 on 20% of its
  // index for deliveries that were never scheduled.
  //
  // Renormalising over the measured weights asks the only answerable question:
  // "on what we have actually observed, how is this supplier doing?" A vendor
  // measured only on compliance and financials is scored on compliance and
  // financials -- and `coverage_pct` says so, so nobody mistakes a narrow
  // reading for a comprehensive one.
  const dimensions = [
    ['quality',     qualityResult],
    ['delivery',    deliveryResult],
    ['cost',        costResult],
    ['support',     supportResult],
    ['compliance',  complianceResult],
    ['financial',   financialResult],
    ['dependency',  dependencyResult],
    ['risk_events', riskEventsResult],
  ];

  let weighted = 0;
  let measuredWeight = 0;
  const measuredDimensions = [];
  for (const [key, result] of dimensions) {
    if (result.measured === false) continue;
    weighted       += result.score * WEIGHTS[key];
    measuredWeight += WEIGHTS[key];
    measuredDimensions.push(key);
  }

  // measuredWeight is never 0 in practice -- compliance, financial and
  // dependency are always measured -- but a caller stubbing the scorers could
  // make it so, and dividing by it must not yield NaN.
  const health_score = measuredWeight > 0 ? weighted / measuredWeight : 0;

  const roundedScore = parseFloat(health_score.toFixed(2));

  // An unmeasured dimension reports null, not its default. Storing the default
  // would put the same fabrication back on the radar chart and in the heatmap
  // columns that the renormalisation just took out of the composite.
  const dim = result => (result.measured === false ? null : parseFloat(result.score.toFixed(2)));

  return {
    health_score:      roundedScore,
    health_status:     classifyHealth(roundedScore, hasEvidence),
    has_evidence:      hasEvidence,
    // Share of the total weight that had evidence behind it, 0-100.
    coverage_pct:        parseFloat((measuredWeight * 100).toFixed(1)),
    measured_dimensions: measuredDimensions,
    quality_score:     dim(qualityResult),
    delivery_score:    dim(deliveryResult),
    cost_score:        dim(costResult),
    support_score:     dim(supportResult),
    compliance_score:  dim(complianceResult),
    financial_score:   dim(financialResult),
    dependency_score:  dim(dependencyResult),
    risk_score:        dim(riskEventsResult),
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

  // Only warn on a delivery record that exists. Before this guard every vendor
  // who had never shipped anything raised "On-Time Delivery 75.0% is below 85%"
  // -- a specific, actionable-looking figure about deliveries that never
  // happened, on 4 of this instance's 6 suppliers.
  if (deliveryResult?.otdMeasured && deliveryResult.otdPct < otdThreshold) {
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

  if (qualityResult?.capaMeasured && qualityResult.capaClosurePct < 60) {
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
