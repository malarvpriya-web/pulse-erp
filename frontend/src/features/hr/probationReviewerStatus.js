import { useEffect, useState } from 'react';
import api from '@/services/api/client';

/**
 * Is the signed-in user CURRENTLY a department head in their company?
 *
 * Asked of GET /probation-reviews/mine/summary, which answers from the
 * assignment itself (login → linked employee, current, same company → an
 * active department_heads row). It is never inferred from a role: holding the
 * department_head role without an assignment gets `false`, and an HR user who
 * also heads a department gets `true`.
 *
 * Same contract as features/internships/mentorStatus.js: one request per login,
 * shared by every caller, re-asked when the window regains focus (a head
 * reassigned while signed in loses the entry without a reload), and any
 * failure reads as "not a head" — the navigation entry fails closed, and the
 * page and API make their own decision anyway.
 */
let cache = { token: null, promise: null, value: null };

const tokenNow = () => {
  try { return localStorage.getItem('token'); } catch { return null; }
};

const NOT_A_HEAD = { is_head: false, departments: [], needs_action: 0 };

export function fetchReviewerStatus(force = false) {
  const token = tokenNow();
  if (!token) return Promise.resolve(NOT_A_HEAD);
  if (!force && cache.token === token && cache.promise) return cache.promise;
  const promise = api.get('/probation-reviews/mine/summary')
    .then((r) => ({
      is_head: r?.data?.is_head === true,
      departments: Array.isArray(r?.data?.departments) ? r.data.departments : [],
      needs_action: Number(r?.data?.needs_action) || 0,
    }))
    .catch(() => NOT_A_HEAD)
    .then((v) => { if (cache.promise === promise) cache.value = v; return v; });
  cache = { token, promise, value: cache.token === token ? cache.value : null };
  return promise;
}

/** Test seam. */
export function __resetReviewerStatus() { cache = { token: null, promise: null, value: null }; }

export function useProbationReviewerStatus() {
  const [status, setStatus] = useState(
    () => (cache.token === tokenNow() && cache.value) || { ...NOT_A_HEAD, loading: true });
  useEffect(() => {
    let alive = true;
    const apply = (v) => { if (alive) setStatus({ ...v, loading: false }); };
    fetchReviewerStatus().then(apply);
    const onFocus = () => fetchReviewerStatus(true).then(apply);
    window.addEventListener('focus', onFocus);
    return () => { alive = false; window.removeEventListener('focus', onFocus); };
  }, []);
  return status;
}
