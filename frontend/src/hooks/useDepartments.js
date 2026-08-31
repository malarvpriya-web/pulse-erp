// ──────────────────────────────────────────────────────────────────────────────
// useDepartments — THE department list. Every department dropdown reads it.
//
// Departments are mastered in ONE place: Settings → Master Setup → Departments
// (table `master_departments`, served by GET /master/departments, also mounted
// as /admin/config/departments — same router, see server.js).
//
// That endpoint already unions the master list with the DISTINCT departments
// actually present on `employees`, so it is the superset and needs no local
// merging. Prefer it over /orgchart/departments, which returns ONLY the
// employees-derived subset (and in a { success, data } envelope rather than a
// bare array — a shape mismatch that silently yielded empty dropdowns).
//
// Why a shared hook: three screens carried hardcoded arrays that disagreed —
//   AdminDashboard   9 names, plus an "Other →  free text" box that wrote an
//                    arbitrary string onto the user record, minting a new
//                    department nobody could ever see in Master Setup
//   Contacts         8 names
//   JobOpenings      8 DIFFERENT names ('Engineering'/'Product'/'Legal' — none
//                    of which the other two offered)
// Filtering a report by department cannot work when each screen writes from its
// own vocabulary, so they all read from here now.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import api from '@/services/api/client';

let cached = null;
let inflight = null;

export function loadDepartments() {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = api.get('/master/departments')
    .then(({ data }) => {
      // Bare array from /master; tolerate a { data } envelope defensively.
      const rows = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
      cached = rows
        .map(d => (typeof d === 'string' ? d : d?.name))
        .filter(Boolean);
      return cached;
    })
    .catch(() => [])
    .finally(() => { inflight = null; });
  return inflight;
}

/** Invalidate after a write in Master Setup so open pickers pick the change up. */
export function invalidateDepartments() { cached = null; }

/**
 * useDepartments() → string[] of department names, alphabetical.
 * Empty until the first fetch resolves — render a "Select…" placeholder, never
 * a hardcoded stand-in list.
 */
export default function useDepartments() {
  const [departments, setDepartments] = useState(cached ?? []);

  useEffect(() => {
    let alive = true;
    loadDepartments().then(rows => { if (alive) setDepartments(rows); });
    return () => { alive = false; };
  }, []);

  return departments;
}
