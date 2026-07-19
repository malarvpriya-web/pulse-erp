// PATH: frontend/src/hooks/useTableData.js
/**
 * useTableData — Server-side pagination + sorting + filter integration.
 *
 * Features:
 *  - Server-side pagination (page, pageSize, totalCount)
 *  - Sort state (sortKey, sortDir) passed to API as ?sort=field&dir=asc
 *  - Integrates with useFilters filterParams
 *  - Auto-retry on failure (3 attempts, exponential backoff)
 *  - Stale-while-revalidate: keeps old data visible while re-fetching
 *  - lastUpdated timestamp
 *  - Manual refresh via refetch()
 *
 * @example
 * const { rows, loading, page, setPage, sort, setSort, totalCount, refetch } = useTableData({
 *   endpoint: '/invoices',
 *   filterParams: { status: 'active', q: 'foo' },
 *   defaultSort: { key: 'date', dir: 'desc' },
 *   pageSize: 25,
 * });
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/services/api/client';

const MAX_RETRIES     = 3;
const BACKOFF_BASE_MS = 500;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useTableData({
  endpoint,
  filterParams   = {},
  defaultSort    = { key: '', dir: 'asc' },
  pageSize       = 20,
  initialPage    = 1,
  transformData,       // optional (data) => rows transformation
  enabled        = true,
} = {}) {
  const [rows,        setRows]        = useState([]);
  const [totalCount,  setTotalCount]  = useState(0);
  const [page,        setPage]        = useState(initialPage);
  const [sort,        setSort]        = useState(defaultSort);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Track in-flight request so we can abort stale ones
  const abortRef   = useRef(null);
  const retryRef   = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(retryRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const buildParams = useCallback(() => {
    const p = {
      ...filterParams,
      page,
      pageSize,
    };
    if (sort.key) {
      p.sort = sort.key;
      p.dir  = sort.dir;
    }
    return p;
  }, [filterParams, page, pageSize, sort]);

  const fetchData = useCallback(async (attempt = 1) => {
    if (!endpoint || !enabled) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const params   = buildParams();
      const qs       = '?' + Object.entries(params)
        .filter(([, v]) => v !== '' && v !== null && v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

      const res  = await api.get(`${endpoint}${qs}`, { signal: controller.signal });
      const data = res.data;

      if (!mountedRef.current) return;

      // Support various response shapes:
      // { rows, total } | { data, total } | { items, count } | plain array
      let extractedRows  = [];
      let extractedTotal = 0;

      if (Array.isArray(data)) {
        extractedRows  = data;
        extractedTotal = data.length;
      } else if (Array.isArray(data.rows)) {
        extractedRows  = data.rows;
        extractedTotal = data.total ?? data.count ?? data.rows.length;
      } else if (Array.isArray(data.data)) {
        extractedRows  = data.data;
        extractedTotal = data.total ?? data.count ?? data.data.length;
      } else if (Array.isArray(data.items)) {
        extractedRows  = data.items;
        extractedTotal = data.total ?? data.count ?? data.items.length;
      }

      if (transformData) extractedRows = transformData(extractedRows);

      setRows(extractedRows);
      setTotalCount(extractedTotal);
      setLastUpdated(new Date());
    } catch (err) {
      if (!mountedRef.current || err.name === 'CanceledError' || err.name === 'AbortError') return;

      if (attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        retryRef.current = setTimeout(() => fetchData(attempt + 1), delay);
        return;
      }

      setError(err?.response?.data?.error || err.message || 'Failed to load data');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [endpoint, enabled, buildParams, transformData]);

  // Fetch whenever page, sort, or filterParams change
  const filterKey = JSON.stringify(filterParams);
  useEffect(() => {
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, page, sort.key, sort.dir, filterKey, enabled]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [filterKey]);

  /** Toggle sort: same key flips direction; new key starts asc */
  const toggleSort = useCallback((key) => {
    setSort(prev =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' }
    );
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return {
    rows,
    loading,
    error,
    page,
    setPage,
    pageSize,
    totalCount,
    totalPages,
    sort,
    setSort,
    toggleSort,
    lastUpdated,
    refetch:  () => fetchData(),
    isEmpty:  !loading && rows.length === 0,
  };
}

export default useTableData;
