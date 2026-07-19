/**
 * Server-side table data hook.
 * Handles pagination, sort, filter, and search in one place.
 */
import { useState, useCallback, useEffect } from 'react';
import api from '../api/client';

export function useTableData(endpoint, defaultParams = {}) {
  const [rows,     setRows]     = useState([]);
  const [total,    setTotal]    = useState(0);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy,   setSortBy]   = useState(defaultParams.sortBy || '');
  const [sortDir,  setSortDir]  = useState(defaultParams.sortDir || 'asc');
  const [search,   setSearch]   = useState('');
  const [filters,  setFilters]  = useState(defaultParams.filters || {});

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(endpoint, {
        params: {
          page, page_size: pageSize,
          sort_by: sortBy || undefined,
          sort_dir: sortDir,
          search: search || undefined,
          ...filters,
          ...defaultParams,
        },
      });
      const d = res.data;
      if (Array.isArray(d)) {
        setRows(d);
        setTotal(d.length);
      } else {
        setRows(d.data || d.rows || d.items || d.results || []);
        setTotal(d.total || d.count || d.total_count || 0);
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load table');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, page, pageSize, sortBy, sortDir, search, JSON.stringify(filters)]);

  useEffect(() => { fetch(); }, [fetch]);

  const handleSort = useCallback((col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
    setPage(1);
  }, [sortBy]);

  const handleFilter = useCallback((newFilters) => {
    setFilters(f => ({ ...f, ...newFilters }));
    setPage(1);
  }, []);

  const handleSearch = useCallback((q) => {
    setSearch(q);
    setPage(1);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    rows, total, loading, error,
    page, pageSize, sortBy, sortDir, search, filters,
    totalPages,
    setPage, setPageSize,
    handleSort, handleFilter, handleSearch,
    refresh: fetch,
  };
}
