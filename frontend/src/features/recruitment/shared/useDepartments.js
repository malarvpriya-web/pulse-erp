import { useState, useEffect } from 'react';
import api from '@/services/api/client';

/**
 * Live department list for every Recruitment department picker.
 *
 * Consolidates the module's four separate implementations of the same
 * two-endpoint fallback, and replaces JobOpenings.jsx's hardcoded eight-value
 * array — the one department dropdown in the module that was NOT live, so it
 * silently drifted the moment Org Setup changed.
 *
 * Falls back from the admin config list to the org-chart list, matching what
 * JobRequisitionPipeline already did (org-chart is the broader source; admin
 * config is the curated one and wins when populated).
 *
 * Module-level cache: these lists change rarely and several Recruitment pages
 * mount pickers in the same session.
 */
let cache = null;
let inflight = null;

async function fetchDepartments() {
  try {
    const r = await api.get('/admin/config/departments');
    const list = Array.isArray(r.data) ? r.data.map(d => d.name || d).filter(Boolean) : [];
    if (list.length) return list;
  } catch { /* fall through to org chart */ }

  try {
    const r = await api.get('/orgchart/departments');
    const raw = r.data?.data ?? r.data ?? [];
    return Array.isArray(raw) ? raw.map(d => d.name || d).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function useDepartments() {
  const [departments, setDepartments] = useState(cache || []);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    let alive = true;
    if (cache) { setDepartments(cache); setLoading(false); return () => { alive = false; }; }

    inflight = inflight || fetchDepartments();
    inflight.then(list => {
      cache = list;
      inflight = null;
      if (alive) { setDepartments(list); setLoading(false); }
    });
    return () => { alive = false; };
  }, []);

  return { departments, loading };
}

/** Clears the cache — call after Org Setup edits departments. */
export function invalidateDepartments() { cache = null; inflight = null; }

export default useDepartments;
