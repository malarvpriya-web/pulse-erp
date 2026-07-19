/**
 * metricsCalculator.js — Pure calculation functions (no DB access).
 * All functions are synchronous and side-effect free.
 */

/** Attrition rate as a percentage */
export const calcAttritionRate = (departures, avgHeadcount) =>
  avgHeadcount > 0 ? parseFloat(((departures / avgHeadcount) * 100).toFixed(2)) : 0;

/** Voluntary attrition rate */
export const calcVoluntaryAttrition = (voluntaryDepartures, avgHeadcount) =>
  avgHeadcount > 0 ? parseFloat(((voluntaryDepartures / avgHeadcount) * 100).toFixed(2)) : 0;

/** Average employee tenure in years */
export const calcAvgTenure = (tenureDaysArray) => {
  if (!tenureDaysArray.length) return 0;
  const avg = tenureDaysArray.reduce((s, d) => s + d, 0) / tenureDaysArray.length;
  return parseFloat((avg / 365).toFixed(1));
};

/** Absenteeism rate */
export const calcAbsenteeismRate = (absentDays, totalWorkdays, headcount) => {
  const denom = totalWorkdays * headcount;
  return denom > 0 ? parseFloat(((absentDays / denom) * 100).toFixed(2)) : 0;
};

/** Offer acceptance rate */
export const calcOfferAcceptanceRate = (accepted, offered) =>
  offered > 0 ? Math.round((accepted / offered) * 100) : 0;

/** Headcount growth rate (%) vs previous period */
export const calcHeadcountGrowth = (current, previous) =>
  previous > 0 ? parseFloat((((current - previous) / previous) * 100).toFixed(1)) : 0;

/** Revenue growth rate (%) */
export const calcRevenueGrowth = (current, previous) =>
  previous > 0 ? parseFloat((((current - previous) / previous) * 100).toFixed(1)) : 0;

/** MRR from active subscriptions */
export const calcMRR = (subscriptions) =>
  subscriptions.reduce((sum, s) => {
    if (s.status !== 'Active') return sum;
    return sum + (s.billing === 'Monthly' ? s.amount : Math.round(s.amount / 12));
  }, 0);

/** ARR */
export const calcARR = (mrr) => mrr * 12;

/** Net Promoter Score (0-100 mapped from -100 to +100) */
export const calcNPS = (promoters, detractors, total) =>
  total > 0 ? Math.round(((promoters - detractors) / total) * 100) : 0;

/** Project health score (0-100) from task completion */
export const calcProjectHealth = (completedTasks, totalTasks, daysOverdue) => {
  if (!totalTasks) return 0;
  const completionScore = (completedTasks / totalTasks) * 70;
  const penaltyScore    = Math.min(daysOverdue * 2, 30);
  return Math.max(0, Math.round(completionScore - penaltyScore + 30));
};

/** Budget burn rate (%) */
export const calcBurnRate = (spent, budget) =>
  budget > 0 ? parseFloat(((spent / budget) * 100).toFixed(1)) : 0;

/** Sales conversion rate (%) */
export const calcConversionRate = (closedWon, totalOpportunities) =>
  totalOpportunities > 0 ? parseFloat(((closedWon / totalOpportunities) * 100).toFixed(1)) : 0;

/** Gross profit margin (%) */
export const calcGrossMargin = (revenue, cogs) =>
  revenue > 0 ? parseFloat((((revenue - cogs) / revenue) * 100).toFixed(1)) : 0;

/** Average deal size */
export const calcAvgDealSize = (totalRevenue, closedDeals) =>
  closedDeals > 0 ? Math.round(totalRevenue / closedDeals) : 0;

/** Utilization rate for a department (%) */
export const calcUtilizationRate = (loggedHours, availableHours) =>
  availableHours > 0 ? parseFloat(((loggedHours / availableHours) * 100).toFixed(1)) : 0;

/** Performance score normalizer (0-100) */
export const calcPerformanceScore = (rawScore, maxScore) =>
  maxScore > 0 ? Math.round((rawScore / maxScore) * 100) : 0;
