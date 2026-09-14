import api from '@/services/api/client';

/**
 * HR analytics API client.
 *
 * FILTERS
 * -------
 * Every function here used to be a bare URL with no query string. The backend
 * has supported `?department=`, `?period=`, `?from=` and `?to=` on these
 * endpoints for some time (see `hrFrags()` in analytics.routes.js), but nothing
 * was ever sent — so HR Dashboard's department dropdown filtered a single
 * already-loaded array in memory and left the other seventeen widgets untouched,
 * and the page had no date filter at all.
 *
 * Each function now takes an optional `params` object which is passed straight
 * through to axios. Callers should hand it `params` from `useDashboardFilters`,
 * so the same filter vocabulary applies here as on every other dashboard.
 *
 * EMPTY vs FAILED
 * ---------------
 * `safeGet`/`safeGetArray` previously collapsed a network error, a 403 and a
 * genuinely empty result into the same value, so a broken endpoint was
 * indistinguishable from "no data yet". They now attach a non-enumerable
 * `__error` marker on failure, which `useHrAnalytics` reads to show a real error
 * state. Existing call sites that only read the data are unaffected.
 */

/** Tag a fallback value with the error that produced it, without changing its shape. */
const withError = (value, err) => {
  Object.defineProperty(value, '__error', {
    value: {
      status: err?.response?.status ?? 0,
      message: err?.response?.data?.error || err?.message || 'Request failed',
      forbidden: err?.response?.status === 403,
    },
    enumerable: false,
  });
  return value;
};

const safeGet = async (url, params) => {
  try {
    const res = await api.get(url, params ? { params } : undefined);
    const d = res.data?.data ?? res.data;
    if (d && typeof d === 'object' && Object.keys(d).length) return d;
    return {};
  } catch (err) {
    return withError({}, err);
  }
};

const safeGetArray = async (url, params) => {
  try {
    const res = await api.get(url, params ? { params } : undefined);
    const d = res.data?.data ?? res.data;
    return Array.isArray(d) ? d : [];
  } catch (err) {
    return withError([], err);
  }
};

/** True when a value came back from a failed request rather than an empty one. */
export const isErrored = (v) => Boolean(v && v.__error);
/** The error attached to a failed result, or null. */
export const errorOf = (v) => (v && v.__error) || null;

export const getHeadcount        = (p) => safeGet('/analytics/headcount', p);
export const getAttrition        = (p) => safeGet('/analytics/attrition', p);
export const getOfferAcceptance  = (p) => safeGet('/analytics/offer-acceptance', p);
export const getAbsenteeism      = (p) => safeGet('/analytics/absenteeism', p);
export const getAttritionTrend   = (p) => safeGetArray('/analytics/attrition-trend', p);
export const getHiringTrend      = (p) => safeGetArray('/analytics/hiring-trend', p);
export const getGenderDist       = (p) => safeGetArray('/analytics/gender', p);
export const getDeptWorkforce    = (p) => safeGetArray('/analytics/dept-workforce', p);
export const getProductivity     = (p) => safeGetArray('/analytics/productivity', p);
export const getTopPerformers    = (p) => safeGetArray('/analytics/top-performers', p);
export const getHRInsights       = (p) => safeGetArray('/analytics/insights/hr', p);

export const getHeadcountTrend    = (p) => safeGetArray('/analytics/headcount-trend', p);
export const getSalaryBands       = (p) => safeGetArray('/analytics/salary-bands', p);
export const getTimeToHire        = (p) => safeGet('/analytics/time-to-hire', p);
export const getSatisfaction      = (p) => safeGet('/analytics/satisfaction', p);
export const getOnboarding        = (p) => safeGet('/analytics/onboarding', p);
export const getComplianceAlerts  = (p) => safeGetArray('/analytics/compliance-alerts', p);
export const getHRBenchmarks      = (p) => safeGet('/analytics/hr-benchmarks', p);

/**
 * Department options, read from the employee master.
 *
 * HR Dashboard used to offer a hardcoded list — 'Engineering', 'Sales', 'HR',
 * 'Finance', 'Operations', 'Marketing', 'Support' — of which three matched no
 * employee at all while ten real departments (Human Resources, Management,
 * Service, Production, Procurement, Quality, IT, Stores, General, Projects) were
 * absent and therefore unselectable. This returns what is actually in the data.
 */
export const getHrFilterOptions = () => safeGet('/analytics/hr-filter-options');
