import { useEffect, useState } from 'react';
import api from '@/services/api/client';

/**
 * Is the signed-in user CURRENTLY an intern's assigned mentor?
 *
 * Asked of GET /intern-evaluations/mine/summary, which answers from the
 * assignment itself (login -> employee -> intern.mentor_employee_id, same
 * company, current employee). It is never inferred from a role: a manager or
 * employee who mentors nobody gets `false`.
 *
 * One request per login, shared by every caller, and re-asked when the window
 * regains focus — a mentor reassigned while signed in loses the entry without a
 * reload. Any failure reads as "not a mentor": the navigation entry fails
 * closed, and the page and API make their own decision anyway.
 */
let cache = { token: null, promise: null, value: null };

const tokenNow = () => {
  try { return localStorage.getItem('token'); } catch { return null; }
};

function fetchStatus(force = false) {
  const token = tokenNow();
  if (!token) return Promise.resolve({ is_mentor: false });
  if (!force && cache.token === token && cache.promise) return cache.promise;
  const promise = api.get('/intern-evaluations/mine/summary')
    .then(r => ({ is_mentor: r?.data?.is_mentor === true, needs_action: Number(r?.data?.needs_action) || 0 }))
    .catch(() => ({ is_mentor: false, needs_action: 0 }))
    .then(v => { if (cache.promise === promise) cache.value = v; return v; });
  cache = { token, promise, value: cache.token === token ? cache.value : null };
  return promise;
}

/** Test seam. */
export function __resetMentorStatus() { cache = { token: null, promise: null, value: null }; }

export function useMentorStatus() {
  const [status, setStatus] = useState(() => (cache.token === tokenNow() && cache.value) || { is_mentor: false, needs_action: 0, loading: true });
  useEffect(() => {
    let alive = true;
    const apply = (v) => { if (alive) setStatus({ ...v, loading: false }); };
    fetchStatus().then(apply);
    const onFocus = () => fetchStatus(true).then(apply);
    window.addEventListener('focus', onFocus);
    return () => { alive = false; window.removeEventListener('focus', onFocus); };
  }, []);
  return status;
}
