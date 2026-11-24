import { useEffect, useState } from 'react';
import api from '@/services/api/client';

/**
 * Does the signed-in user approve anything?
 *
 * Asked of GET /approvals/stats, whose `isApprover` is the server's own answer:
 * an approval role or leave-approve grant, an attendance approver, someone with
 * direct reports, or anyone with items to decide or decisions on record. It is
 * the same flag ApprovalCenter uses to show its approver tabs.
 *
 * Used by the Sidebar to hide the Approvals row from employee-only logins who
 * approve nothing (owner's instruction, 2026-11-11) while keeping it for an
 * employee-role team lead. Fetched only when `enabled`, so other roles make no
 * extra request. One request per login, re-asked when the window regains
 * focus. Any failure reads as "not an approver": the row fails closed, and the
 * page itself stays reachable from Home's approvals card and notifications.
 */
let cache = { token: null, promise: null, value: null };

const tokenNow = () => {
  try { return localStorage.getItem('token'); } catch { return null; }
};

function fetchStatus(force = false) {
  const token = tokenNow();
  if (!token) return Promise.resolve({ is_approver: false });
  if (!force && cache.token === token && cache.promise) return cache.promise;
  const promise = api.get('/approvals/stats')
    .then(r => ({ is_approver: r?.data?.isApprover === true, has_direct_reports: r?.data?.hasDirectReports === true }))
    .catch(() => ({ is_approver: false, has_direct_reports: false }))
    .then(v => { if (cache.promise === promise) cache.value = v; return v; });
  cache = { token, promise, value: cache.token === token ? cache.value : null };
  return promise;
}

/** Test seam. */
export function __resetApproverStatus() { cache = { token: null, promise: null, value: null }; }

export function useApproverStatus(enabled = true) {
  const [status, setStatus] = useState(() => (cache.token === tokenNow() && cache.value) || { is_approver: false, loading: true });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const apply = (v) => { if (alive) setStatus({ ...v, loading: false }); };
    fetchStatus().then(apply);
    const onFocus = () => fetchStatus(true).then(apply);
    window.addEventListener('focus', onFocus);
    return () => { alive = false; window.removeEventListener('focus', onFocus); };
  }, [enabled]);
  return status;
}
