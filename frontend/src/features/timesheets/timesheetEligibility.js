import { useEffect, useState } from 'react';
import api from '@/services/api/client';

/**
 * Is the signed-in employee on an active project this week?
 *
 * Asked of GET /timesheets/timesheets/eligibility. The Sidebar shows the My
 * Timesheet row to an employee-only login only while this is true (owner,
 * 2026-11-11): someone on no project has nothing to book time to. Fetched only
 * when `enabled`; one request per login, re-asked on window focus. Any failure
 * reads as "not on a project" — the page itself still explains why it is empty.
 */
let cache = { token: null, promise: null, value: null };

const tokenNow = () => {
  try { return localStorage.getItem('token'); } catch { return null; }
};

function fetchStatus(force = false) {
  const token = tokenNow();
  if (!token) return Promise.resolve({ on_project: false });
  if (!force && cache.token === token && cache.promise) return cache.promise;
  const promise = api.get('/timesheets/timesheets/eligibility')
    .then(r => ({ on_project: r?.data?.on_project === true }))
    .catch(() => ({ on_project: false }))
    .then(v => { if (cache.promise === promise) cache.value = v; return v; });
  cache = { token, promise, value: cache.token === token ? cache.value : null };
  return promise;
}

/** Test seam. */
export function __resetTimesheetEligibility() { cache = { token: null, promise: null, value: null }; }

export function useTimesheetEligibility(enabled = true) {
  const [status, setStatus] = useState(() => (cache.token === tokenNow() && cache.value) || { on_project: false, loading: true });
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
