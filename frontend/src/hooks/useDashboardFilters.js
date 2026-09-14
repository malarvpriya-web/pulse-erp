// PATH: frontend/src/hooks/useDashboardFilters.js
/**
 * useDashboardFilters — canonical filter state for dashboard pages.
 *
 * Pairs with <DashboardFilterBar> (components/pulse-ui) on the UI side and
 * `resolveRange()` / `dimension()` (backend/src/shared/dashboardFilters.js) on
 * the API side. Every dashboard that needs a period + a module dimension should
 * use this rather than hand-rolling its own useState soup — that divergence is
 * why filters ended up inconsistent (or missing) across the app.
 *
 * `params` is ready to hand straight to axios:
 *   const { params, ...filters } = useDashboardFilters({ dimensions: { department: 'all' } });
 *   useEffect(() => { api.get('/quality/dashboard', { params }); }, [params]);
 *
 * `params` is memoised on its own values, so it is a safe useEffect dependency —
 * it only changes identity when a filter actually changes.
 *
 * Selections persist per page in sessionStorage (pass `storageKey`), so moving
 * to a record and back does not silently reset the range under the user.
 */
import { useState, useMemo, useCallback, useEffect } from 'react';

/** Presets offered by the bar, in display order. Keys match the backend. */
export const PERIOD_OPTIONS = [
  { value: 'mtd',     label: 'This Month' },
  { value: 'qtd',     label: 'This Quarter' },
  { value: 'fytd',    label: 'This FY' },
  { value: 'last30',  label: 'Last 30 Days' },
  { value: 'last90',  label: 'Last 90 Days' },
  { value: 'last6m',  label: 'Last 6 Months' },
  { value: 'last12m', label: 'Last 12 Months' },
  { value: 'all',     label: 'All Time' },
  { value: 'custom',  label: 'Custom…' },
];

export const DEFAULT_PERIOD = 'fytd';

const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Concrete bounds for a preset, mirroring `resolveRange()` in
 * backend/src/shared/dashboardFilters.js.
 *
 * The backend copy stays authoritative — normal calls send `period` and let the
 * server resolve it. This exists only for the handful of endpoints that predate
 * the shared contract and demand explicit start/end dates (e.g.
 * /finance/reports/profit-loss). Keep the two in step: the backend has unit
 * tests in src/__tests__/dashboardFilters.test.js covering each preset.
 *
 * @returns {{from: string|null, to: string|null}} null means unbounded.
 */
export function resolvePeriodBounds(period, from = '', to = '', now = new Date()) {
  if (period === 'custom') {
    return { from: isIso(from) ? from : null, to: isIso(to) ? to : null };
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = iso(today);
  const daysAgo = (n) => { const c = new Date(today); c.setDate(c.getDate() - n); return c; };
  const monthsAgo = (n) => { const c = new Date(today); c.setMonth(c.getMonth() - n); return c; };
  const fyStart = () => new Date(
    today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1, 3, 1,
  );

  switch (period) {
    case 'all':     return { from: null, to: null };
    case 'mtd':     return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: end };
    case 'qtd':     return { from: iso(new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1)), to: end };
    case 'ytd':     return { from: iso(new Date(today.getFullYear(), 0, 1)), to: end };
    case 'last7':   return { from: iso(daysAgo(6)),  to: end };
    case 'last30':  return { from: iso(daysAgo(29)), to: end };
    case 'last90':  return { from: iso(daysAgo(89)), to: end };
    case 'last6m':  return { from: iso(monthsAgo(6)),  to: end };
    case 'last12m': return { from: iso(monthsAgo(12)), to: end };
    case 'fytd':
    default:        return { from: iso(fyStart()), to: end };
  }
}

function readStored(key) {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(`pulse.filters.${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // private mode / quota — filters just don't persist
  }
}

function writeStored(key, value) {
  if (!key) return;
  try {
    sessionStorage.setItem(`pulse.filters.${key}`, JSON.stringify(value));
  } catch { /* non-fatal */ }
}

/**
 * @param {object} [options]
 * @param {string} [options.defaultPeriod='fytd'] initial preset. Use 'all' on
 *   dashboards showing point-in-time balances (stock on hand, open tickets)
 *   rather than period activity.
 * @param {object} [options.dimensions={}] initial module dimensions keyed by the
 *   query-param name the backend reads, e.g. `{ department: 'all', status: 'all' }`.
 *   The value 'all' (or '') is omitted from `params` — the backend reads that as
 *   unfiltered.
 * @param {string} [options.storageKey] persists the selection for this page.
 */
export default function useDashboardFilters(options = {}) {
  const {
    defaultPeriod = DEFAULT_PERIOD,
    dimensions: initialDimensions = {},
    storageKey,
  } = options;

  const stored = useMemo(() => readStored(storageKey), [storageKey]);

  const [period, setPeriodState] = useState(stored?.period || defaultPeriod);
  const [from, setFrom] = useState(stored?.from || '');
  const [to, setTo] = useState(stored?.to || '');
  const [dimensions, setDimensions] = useState(() => ({
    ...initialDimensions,
    ...(stored?.dimensions || {}),
  }));

  useEffect(() => {
    writeStored(storageKey, { period, from, to, dimensions });
  }, [storageKey, period, from, to, dimensions]);

  const setPeriod = useCallback((next) => {
    setPeriodState(next);
    // Leaving custom drops the bounds so a stale hand-typed range can't linger
    // in `params` while the bar shows a preset.
    if (next !== 'custom') { setFrom(''); setTo(''); }
  }, []);

  const setDimension = useCallback((key, value) => {
    setDimensions(prev => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => {
    setPeriodState(defaultPeriod);
    setFrom('');
    setTo('');
    setDimensions(initialDimensions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultPeriod, JSON.stringify(initialDimensions)]);

  // Serialised so the memo below compares by value, not by object identity —
  // callers pass an object literal for `dimensions` on every render.
  const dimensionsKey = JSON.stringify(dimensions);

  const params = useMemo(() => {
    const out = { period };
    // A custom range with only one bound filled in is still meaningful
    // (open-ended), so send whichever side the user has completed.
    if (period === 'custom') {
      if (isIso(from)) out.from = from;
      if (isIso(to)) out.to = to;
      // Nothing valid entered yet — don't ask the API for an undefined window.
      if (!out.from && !out.to) out.period = DEFAULT_PERIOD;
    }
    for (const [k, v] of Object.entries(JSON.parse(dimensionsKey))) {
      if (v !== undefined && v !== null && v !== '' && v !== 'all') out[k] = v;
    }
    return out;
  }, [period, from, to, dimensionsKey]);

  /** Count of filters differing from their defaults — drives the bar's badge. */
  const activeCount = useMemo(() => {
    let n = period !== defaultPeriod ? 1 : 0;
    for (const [k, v] of Object.entries(JSON.parse(dimensionsKey))) {
      const base = initialDimensions[k] ?? 'all';
      if (v !== base) n += 1;
    }
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, defaultPeriod, dimensionsKey, JSON.stringify(initialDimensions)]);

  // Concrete dates for the selected period. Only needed by endpoints that can't
  // take a preset — prefer sending `params` and letting the backend resolve.
  const bounds = useMemo(
    () => resolvePeriodBounds(period, from, to),
    [period, from, to],
  );

  return {
    period, setPeriod,
    from, setFrom,
    to, setTo,
    dimensions, setDimension, setDimensions,
    params,
    bounds,
    activeCount,
    reset,
  };
}
