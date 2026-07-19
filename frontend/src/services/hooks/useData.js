/**
 * Generic data fetching hook with loading / error / data states,
 * auto-refresh on filter change, manual refresh, and abort on unmount.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api/client';

export function useData(endpoint, params = {}, options = {}) {
  const {
    initialData = null,
    transform    = d => d,
    skip         = false,
    deps         = [],
  } = options;

  const [data,    setData]    = useState(initialData);
  const [loading, setLoading] = useState(!skip);
  const [error,   setError]   = useState(null);
  const abortRef = useRef(null);

  const fetch = useCallback(async (overrideParams = {}) => {
    if (skip) return;
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setError(null);
    try {
      const res = await api.get(endpoint, {
        params: { ...params, ...overrideParams },
        signal: abortRef.current.signal,
      });
      setData(transform(res.data));
    } catch (err) {
      if (err.name !== 'AbortError' && err.name !== 'CanceledError') {
        setError(err.response?.data?.message || err.message || 'Failed to load');
        if (initialData !== null) setData(initialData);
      }
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, JSON.stringify(params), skip, ...deps]);

  useEffect(() => { fetch(); return () => abortRef.current?.abort(); }, [fetch]);

  return { data, loading, error, refresh: fetch };
}

/**
 * Run multiple API calls in parallel.
 * requests: [{ key, endpoint, params, transform }]
 */
export function useMultiData(requests = []) {
  const [data,    setData]    = useState({});
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const results = await Promise.allSettled(
      requests.map(r =>
        api.get(r.endpoint, { params: r.params || {} })
           .then(res => ({ key: r.key, value: (r.transform || (d => d))(res.data) }))
      )
    );
    const merged = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') merged[r.value.key] = r.value.value;
      else merged[requests[i].key] = null;
    });
    setData(merged);
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) setError(`${failed.length} data source(s) failed`);
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(requests)]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  return { data, loading, error, refresh: fetchAll };
}
