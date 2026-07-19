import api from '@/services/api/client';

const safeGet = async (url) => {
  try {
    const res = await api.get(url);
    const d = res.data?.data || res.data;
    if (d && Object.keys(d).length) return d;
    return null;
  } catch {
    return null;
  }
};

const safeGetArray = async (url) => {
  try {
    const res = await api.get(url);
    const d = res.data?.data || res.data;
    if (Array.isArray(d)) return d;
    return [];
  } catch {
    return [];
  }
};

export const getHeadcount        = () => safeGet('/analytics/headcount');
export const getAttrition        = () => safeGet('/analytics/attrition');
export const getOfferAcceptance  = () => safeGet('/analytics/offer-acceptance');
export const getAbsenteeism      = () => safeGet('/analytics/absenteeism');
export const getAttritionTrend   = () => safeGetArray('/analytics/attrition-trend');
export const getHiringTrend      = () => safeGetArray('/analytics/hiring-trend');
export const getGenderDist       = () => safeGetArray('/analytics/gender');
export const getDeptWorkforce    = () => safeGetArray('/analytics/dept-workforce');
export const getProductivity     = () => safeGetArray('/analytics/productivity');
export const getTopPerformers    = () => safeGetArray('/analytics/top-performers');
export const getHRInsights       = () => safeGetArray('/analytics/insights/hr');

// ── New endpoints ──────────────────────────────────────────────────────────────
export const getHeadcountTrend    = () => safeGetArray('/analytics/headcount-trend');
export const getSalaryBands       = () => safeGetArray('/analytics/salary-bands');
export const getTimeToHire        = () => safeGet('/analytics/time-to-hire');
export const getSatisfaction      = () => safeGet('/analytics/satisfaction');
export const getOnboarding        = () => safeGet('/analytics/onboarding');
export const getComplianceAlerts  = () => safeGetArray('/analytics/compliance-alerts');
export const getHRBenchmarks      = () => safeGet('/analytics/hr-benchmarks');