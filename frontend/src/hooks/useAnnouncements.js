import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';

const CACHE_TTL = 30_000; // 30 s — prevents duplicate network hits when multiple components mount together

const _cache = { data: null, fetchedAt: 0, inflight: null };

/**
 * Returns announcements with a 30-second module-level cache so multiple
 * components that mount on the same page share a single network request.
 *
 * @param {number} limit  Max items to return (default 5)
 * @returns {{ items: array, loading: boolean }}
 */
export function useAnnouncements(limit = 5) {
  const [items,   setItems]   = useState(() => _cache.data ? _cache.data.slice(0, limit) : []);
  const [loading, setLoading] = useState(!_cache.data || Date.now() - _cache.fetchedAt >= CACHE_TTL);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const now = Date.now();
    if (_cache.data && now - _cache.fetchedAt < CACHE_TTL) {
      setItems(_cache.data.slice(0, limit));
      setLoading(false);
      return () => { mountedRef.current = false; };
    }

    if (!_cache.inflight) {
      _cache.inflight = api.get('/announcements/active')
        .then(r => {
          const raw = r.data?.announcements || r.data || [];
          _cache.data = Array.isArray(raw) ? raw : [];
          _cache.fetchedAt = Date.now();
          return _cache.data;
        })
        .catch(() => {
          _cache.data = [];
          _cache.fetchedAt = Date.now();
          return _cache.data;
        })
        .finally(() => { _cache.inflight = null; });
    }

    _cache.inflight.then(list => {
      if (mountedRef.current) {
        setItems(list.slice(0, limit));
        setLoading(false);
      }
    });

    return () => { mountedRef.current = false; };
  }, [limit]);

  return { items, loading };
}
