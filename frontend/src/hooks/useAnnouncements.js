import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';

const CACHE_TTL = 30_000; // 30 s — prevents duplicate network hits when multiple components mount together

/*
 * One cache slot, OWNED by an identity. GET /announcements/active answers
 * differently per login — company, audience and the caller's own `is_read` — so
 * a module-level cache keyed by nothing would hand user A's list to user B for
 * up to 30 s after a sign-out / sign-in in the same tab (no reload, so module
 * state survives). The slot now records whose list it holds; a different
 * identity is a miss, and a request that resolves after the identity changed is
 * discarded rather than written into the slot or shown.
 */
const _cache = { key: null, data: null, fetchedAt: 0, inflight: null, inflightKey: null };

/**
 * Who the cached list belongs to: login, company, the roles in force, and the
 * session token. The login payload carries no company_id, and a company or
 * permission change for the same user arrives as a new token — so the token
 * makes those a different identity too. Held in memory only, like AuthContext.
 */
export function announcementCacheKey(user, roles, token = null) {
  if (!user) return null;
  const id = user.id ?? user.userId ?? user.user_id ?? user.email ?? null;
  if (id == null) return null;
  const company = user.company_id ?? user.companyId ?? '';
  const roleList = (Array.isArray(roles) && roles.length ? roles : [user.role]).filter(Boolean).map(String).sort();
  return JSON.stringify([String(id), String(company), roleList, token ?? '']);
}

/** Test seam and logout hygiene: forget whatever the slot holds. */
export function clearAnnouncementCache() {
  Object.assign(_cache, { key: null, data: null, fetchedAt: 0, inflight: null, inflightKey: null });
}

/**
 * Returns announcements with a 30-second cache shared by components that mount
 * together — for the SAME signed-in identity only.
 *
 * @param {number} limit  Max items to return (default 5)
 * @returns {{ items: array, loading: boolean }}
 */
export function useAnnouncements(limit = 5) {
  const { user, roles, token } = useAuth();
  const key = announcementCacheKey(user, roles, token);
  const fresh = () => key != null && _cache.key === key && _cache.data && Date.now() - _cache.fetchedAt < CACHE_TTL;

  const [items,   setItems]   = useState(() => (fresh() ? _cache.data.slice(0, limit) : []));
  const [loading, setLoading] = useState(() => key != null && !fresh());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    // Nothing is shown from a previous identity while this one loads.
    if (key == null) { setItems([]); setLoading(false); return () => { mountedRef.current = false; }; }

    if (fresh()) {
      setItems(_cache.data.slice(0, limit));
      setLoading(false);
      return () => { mountedRef.current = false; };
    }
    if (_cache.key !== key) Object.assign(_cache, { key, data: null, fetchedAt: 0 });
    setItems([]);
    setLoading(true);

    if (!_cache.inflight || _cache.inflightKey !== key) {
      const p = api.get('/announcements/active')
        .then(r => {
          const raw = r.data?.announcements || r.data || [];
          return Array.isArray(raw) ? raw : [];
        })
        .catch(() => [])
        .then(list => {
          // Only the identity that asked may populate the slot.
          if (_cache.key === key) Object.assign(_cache, { data: list, fetchedAt: Date.now() });
          return list;
        })
        .finally(() => { if (_cache.inflight === p) Object.assign(_cache, { inflight: null, inflightKey: null }); });
      Object.assign(_cache, { inflight: p, inflightKey: key });
    }

    const mine = _cache.inflight;
    mine.then(list => {
      if (mountedRef.current && _cache.key === key) {
        setItems(list.slice(0, limit));
        setLoading(false);
      }
    });

    return () => { mountedRef.current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit, key]);

  return { items, loading };
}
