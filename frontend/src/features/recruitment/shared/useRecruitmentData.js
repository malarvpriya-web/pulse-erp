import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Shared data-loading hook for Recruitment pages.
 *
 * Exists because the 2026-08-12 live-data audit found three of the module's four
 * KPI-bearing pages rendered a FAILED api call as a literal "0", indistinguishable
 * from a genuine zero — a recruiter could read "0 Pending Offers" off a dashboard
 * whose request had actually 500'd. Only RecruitmentReports.jsx got it right, by
 * hiding its KPI row when the call failed.
 *
 * This hook makes the correct behaviour the default: it reports `error` separately
 * from `data`, so a page can render "—" plus a retry affordance instead of a
 * fabricated zero. Pair it with `<KpiValue>` / `.rec-kpi-val-unavailable`.
 *
 *   const { data, loading, error, reload } = useRecruitmentData(
 *     () => api.get('/recruitment/dashboard-summary').then(r => r.data), []
 *   );
 *
 * @param {Function} fetcher  async () => data. Must throw/reject on failure.
 * @param {Array}    deps     dependency list, as for useCallback.
 * @param {Object}   options  { initial, enabled, refreshMs }
 */
export function useRecruitmentData(fetcher, deps = [], options = {}) {
  const { initial = null, enabled = true, refreshMs = 0 } = options;

  const [data, setData]       = useState(initial);
  const [loading, setLoading] = useState(enabled);
  const [error, setError]     = useState(null);

  const mounted     = useRef(true);
  const fetcherRef  = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!enabled) return;
    if (!silent) setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (!mounted.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      // Keep any previously-good data on screen rather than blanking it — but
      // surface the error so the page can mark the values as possibly stale.
      setError(err?.response?.data?.error || err?.message || 'Could not load this data.');
    } finally {
      if (mounted.current && !silent) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  useEffect(() => { load(); }, [load]);

  // Opt-in background refresh, for the two dashboards where another user's
  // change (an approval, an accepted offer) should surface without a manual
  // reload. Deliberately not applied module-wide — every other page already
  // refetches on mount and on its own mutations.
  useEffect(() => {
    if (!refreshMs || !enabled) return undefined;
    const id = setInterval(() => load({ silent: true }), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs, enabled, load]);

  return { data, loading, error, reload: load, setData };
}

/**
 * Resolves a KPI value for display, keeping "real zero" and "unavailable"
 * distinct — the core rule from the audit's Section J.
 * Returns { text, unavailable }.
 */
export function kpiValue(value, { error = null, suffix = '', formatter = null } = {}) {
  if (error && (value === null || value === undefined)) {
    return { text: '—', unavailable: true };
  }
  if (value === null || value === undefined) {
    return { text: '—', unavailable: true };
  }
  const shown = formatter ? formatter(value) : value;
  return { text: `${shown}${suffix}`, unavailable: false };
}

export default useRecruitmentData;
