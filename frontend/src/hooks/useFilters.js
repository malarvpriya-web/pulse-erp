// PATH: frontend/src/hooks/useFilters.js
/**
 * useFilters — Controlled filter state with URL sync, localStorage persistence,
 * debounced filter params, and active filter counting.
 *
 * @example
 * const { values, setFilter, resetFilters, filterParams, activeFilterCount } = useFilters({
 *   key: 'invoices',
 *   defaults: { status: 'all', q: '', dateFrom: '', dateTo: '' },
 *   syncUrl: true,
 *   debounceMs: 300,
 * });
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFromUrl(defaults) {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const result = {};
  for (const key of Object.keys(defaults)) {
    if (params.has(key)) {
      const raw = params.get(key);
      // Arrays encoded as comma-separated
      if (Array.isArray(defaults[key])) {
        result[key] = raw ? raw.split(',') : [];
      } else {
        result[key] = raw;
      }
    }
  }
  return result;
}

function writeToUrl(values, defaults) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  for (const [key, val] of Object.entries(values)) {
    const def = defaults[key];
    const isEmpty = val === '' || val === null || val === undefined
                 || (Array.isArray(val) && val.length === 0)
                 || val === def;
    if (isEmpty) {
      params.delete(key);
    } else {
      params.set(key, Array.isArray(val) ? val.join(',') : String(val));
    }
  }
  const search = params.toString();
  const newUrl = search
    ? `${window.location.pathname}?${search}`
    : window.location.pathname;
  window.history.replaceState(null, '', newUrl);
}

function readFromStorage(key, defaults) {
  try {
    const raw = localStorage.getItem(`filters:${key}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Only restore keys that exist in defaults
    const result = {};
    for (const k of Object.keys(defaults)) {
      if (parsed[k] !== undefined) result[k] = parsed[k];
    }
    return result;
  } catch {
    return {};
  }
}

function writeToStorage(key, values) {
  try {
    localStorage.setItem(`filters:${key}`, JSON.stringify(values));
  } catch {
    // localStorage may be unavailable (private mode) — safe to ignore
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useFilters({
  key         = 'default',
  defaults    = {},
  syncUrl     = false,
  persist     = false,
  debounceMs  = 300,
} = {}) {
  // Merge initial values: defaults < storage < url
  const initial = useMemo(() => {
    let merged = { ...defaults };
    if (persist) Object.assign(merged, readFromStorage(key, defaults));
    if (syncUrl) Object.assign(merged, readFromUrl(defaults));
    return merged;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [values, setValues] = useState(initial);
  const debounceRef  = useRef(null);
  const [debouncedValues, setDebouncedValues] = useState(initial);

  // Sync URL + storage whenever values change
  useEffect(() => {
    if (syncUrl)  writeToUrl(values, defaults);
    if (persist)  writeToStorage(key, values);

    // Debounce the params used for API calls
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedValues(values);
    }, debounceMs);

    return () => clearTimeout(debounceRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  /** Update a single filter key */
  const setFilter = useCallback((filterKey, value) => {
    setValues(prev => ({ ...prev, [filterKey]: value }));
  }, []);

  /** Set multiple filters at once */
  const setFilters = useCallback((partial) => {
    setValues(prev => ({ ...prev, ...partial }));
  }, []);

  /** Reset all filters to defaults */
  const resetFilters = useCallback(() => {
    setValues({ ...defaults });
    if (persist)  writeToStorage(key, defaults);
    if (syncUrl)  writeToUrl(defaults, defaults);
  }, [defaults, key, persist, syncUrl]);

  /** Count filters that differ from their default */
  const activeFilterCount = useMemo(() => {
    return Object.entries(values).filter(([k, v]) => {
      const def = defaults[k];
      if (v === def) return false;
      if (v === '' || v === null || v === undefined) return false;
      if (Array.isArray(v) && v.length === 0) return false;
      return true;
    }).length;
  }, [values, defaults]);

  /** Build URLSearchParams-compatible object from debounced values (strips defaults/empties) */
  const filterParams = useMemo(() => {
    const params = {};
    for (const [k, v] of Object.entries(debouncedValues)) {
      if (v === '' || v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      params[k] = Array.isArray(v) ? v.join(',') : v;
    }
    return params;
  }, [debouncedValues]);

  /** Build query string (e.g. "?status=active&q=foo") */
  const queryString = useMemo(() => {
    const entries = Object.entries(filterParams);
    if (!entries.length) return '';
    return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }, [filterParams]);

  return {
    values,
    setFilter,
    setFilters,
    resetFilters,
    filterParams,
    queryString,
    activeFilterCount,
    debouncedValues,
  };
}

export default useFilters;