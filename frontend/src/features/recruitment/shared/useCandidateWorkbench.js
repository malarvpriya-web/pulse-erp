import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '@/services/api/client';
import { candidateRows, candidateTotal } from './constants';
import { rememberCandidateList } from './listReturn';

/**
 * The candidate list's state, filters and paging.
 *
 * ── WHY THE FILTERS LIVE IN THE URL ────────────────────────────────────────
 * §31: "preserve filters when returning from candidate profile" and "preserve
 * scroll position where possible". The old AllCandidates.jsx held all nine of its
 * filters in component-local `useState`, so opening a candidate and coming back
 * reset every one of them — a recruiter who had narrowed 340 candidates down to
 * eleven lost that work on every single profile visit. That is the difference
 * between a screen you can process a morning's worth of candidates on and one you
 * cannot.
 *
 * The URL is the store, not a mirror of it: there is one source of truth, so the
 * back button, a refresh, a bookmark and a pasted link all reproduce the same
 * list. `replace: true` on every write keeps the history stack from filling with
 * one entry per keystroke.
 *
 * ── WHY EVERY PREDICATE GOES TO THE SERVER ─────────────────────────────────
 * §31 again, and it is not a preference: the list is capped at a page, so a
 * client-side filter can only ever search the page the recruiter is already
 * looking at. The old page filtered `search` in the browser over whatever the
 * unfiltered request returned — a search for a candidate on page 3 found nothing
 * and reported "no candidates match your filters", which is a wrong answer rather
 * than a slow one.
 */

/** Filter key → URL param name. Only keys listed here are ever read or written. */
const FILTERS = {
  q:            'q',
  stage:        'stage',
  status:       'status',
  disposition:  'disp',
  source:       'source',
  department:   'dept',
  recruiter:    'rec',
  location:     'loc',
  skills:       'skills',
  tags:         'tags',
  pool:         'pool',
  qualification: 'qual',
  specialisation: 'spec',
  relocate:     'relo',
  exp:          'exp',
  notice:       'notice',
  rating:       'rating',
  resumeText:   'rtext',
  appliedFrom:  'from',
  appliedTo:    'to',
  staleDays:    'stale',
  sortBy:       'sort',
  sortDir:      'dir',
  page:         'page',
};

export const EXPERIENCE_BANDS = [
  { value: 'all',  label: 'Any experience', min: undefined, max: undefined },
  { value: '0',    label: 'Fresher',        min: 0,  max: 1 },
  { value: '0-2',  label: '0-2 years',      min: 0,  max: 2 },
  { value: '2-5',  label: '2-5 years',      min: 2,  max: 5 },
  { value: '5-10', label: '5-10 years',     min: 5,  max: 10 },
  { value: '10',   label: '10+ years',      min: 10, max: undefined },
];

export const PAGE_SIZE = 50;

const DEFAULTS = {
  q: '', stage: 'all', status: 'all', disposition: 'all', source: 'all',
  department: 'all', recruiter: 'all', location: '', skills: '', tags: '',
  pool: 'all', qualification: 'all', specialisation: '', relocate: 'all',
  exp: 'all', notice: 'all', rating: 'all', resumeText: '',
  appliedFrom: '', appliedTo: '', staleDays: 'all',
  sortBy: 'last_activity_at', sortDir: 'desc', page: '1',
};

/** Which filters count as "narrowing" — drives the "N filters active" chip. */
const NARROWING = Object.keys(DEFAULTS).filter(k => !['sortBy', 'sortDir', 'page'].includes(k));

export default function useCandidateWorkbench({ scope = 'all' } = {}) {
  const [sp, setSp] = useSearchParams();

  // Read straight from the URL on every render. Holding a copy in state and
  // syncing it back is the bug this avoids: two sources of truth that disagree
  // for one render, which shows up as a filter chip that does not match the rows.
  const filters = useMemo(() => {
    const out = { ...DEFAULTS };
    for (const [key, param] of Object.entries(FILTERS)) {
      const v = sp.get(param);
      if (v !== null && v !== '') out[key] = v;
    }
    return out;
  }, [sp]);

  const page = Math.max(parseInt(filters.page, 10) || 1, 1);

  // Recorded on every change so the candidate profile's "Candidates" button can
  // put the recruiter back on THIS list. See listReturn.js for why the URL alone
  // is not enough (setPage replaces the whole query string).
  useEffect(() => { rememberCandidateList(`?${sp.toString()}`); }, [sp]);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  /**
   * The fetch generation.
   *
   * Two rapid filter changes can resolve out of order, and the LAST response to
   * arrive wins regardless of which request it answers — so a slow response to an
   * abandoned query silently overwrites the current one. Comparing a generation
   * counter fixes it without needing AbortController semantics that differ
   * between axios versions (a cancelled axios request rejects with
   * CanceledError, not AbortError, which this codebase has tripped over before).
   */
  const gen = useRef(0);

  const setFilter = useCallback((key, value) => {
    const param = FILTERS[key];
    if (!param) return;
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (value === undefined || value === null || value === '' || value === DEFAULTS[key]) {
        next.delete(param);
      } else {
        next.set(param, String(value));
      }
      // Any change to a PREDICATE returns to page 1. Without this, narrowing a
      // 340-row list to 11 while sitting on page 4 shows an empty table and reads
      // as "no matches".
      if (!['sortBy', 'sortDir', 'page'].includes(key)) next.delete(FILTERS.page);
      return next;
    }, { replace: true });
  }, [setSp]);

  const setManyFilters = useCallback((patch) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        const param = FILTERS[key];
        if (!param) continue;
        if (value === undefined || value === null || value === '' || value === DEFAULTS[key]) next.delete(param);
        else next.set(param, String(value));
      }
      next.delete(FILTERS.page);
      return next;
    }, { replace: true });
  }, [setSp]);

  const resetFilters = useCallback(() => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      // Only this screen's params are cleared. A `tab` param belongs to the host
      // hub page, and wiping it would throw the recruiter back to the Kanban.
      for (const param of Object.values(FILTERS)) next.delete(param);
      return next;
    }, { replace: true });
  }, [setSp]);

  const activeFilterCount = useMemo(
    () => NARROWING.filter(k => filters[k] !== DEFAULTS[k]).length,
    [filters]
  );

  /** The query string the API sees. Built once, used by the list and the export. */
  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    const band = EXPERIENCE_BANDS.find(b => b.value === filters.exp);

    if (filters.q.trim())              p.set('search', filters.q.trim());
    if (filters.stage !== 'all')       p.set('current_stage', filters.stage);
    if (filters.status !== 'all')      p.set('overall_status', filters.status);
    if (filters.disposition !== 'all') p.set('disposition', filters.disposition);
    if (filters.source !== 'all')      p.set('source', filters.source);
    if (filters.department !== 'all')  p.set('department', filters.department);
    if (filters.recruiter !== 'all')   p.set('recruiter_id', filters.recruiter);
    if (filters.pool !== 'all')        p.set('pool_id', filters.pool);
    if (filters.qualification !== 'all') p.set('qualification', filters.qualification);
    if (filters.relocate !== 'all')    p.set('willing_to_relocate', filters.relocate);
    if (filters.notice !== 'all')      p.set('notice_period_max', filters.notice);
    if (filters.rating !== 'all')      p.set('min_rating', filters.rating);
    if (filters.staleDays !== 'all')   p.set('stale_days', filters.staleDays);
    if (filters.location.trim())       p.set('location', filters.location.trim());
    if (filters.skills.trim())         p.set('skills', filters.skills.trim());
    if (filters.tags.trim())           p.set('tags', filters.tags.trim());
    if (filters.specialisation.trim()) p.set('specialisation', filters.specialisation.trim());
    if (filters.resumeText.trim())     p.set('resume_text', filters.resumeText.trim());
    if (filters.appliedFrom)           p.set('applied_from', filters.appliedFrom);
    if (filters.appliedTo)             p.set('applied_to', filters.appliedTo);
    if (band?.min !== undefined)       p.set('experience_min', String(band.min));
    if (band?.max !== undefined)       p.set('experience_max', String(band.max));

    // `scope` is the caller's own narrowing (the work queue's "needs screening"
    // links), applied on top of the recruiter's filters rather than instead of
    // them, so a recruiter can filter WITHIN a queue.
    if (scope === 'mine')       p.set('recruiter_id', 'me');
    if (scope === 'unassigned') p.set('recruiter_id', 'unassigned');

    p.set('sort_by', filters.sortBy);
    p.set('sort_dir', filters.sortDir);
    p.set('limit', String(PAGE_SIZE));
    p.set('offset', String((page - 1) * PAGE_SIZE));
    return p;
  }, [filters, page, scope]);

  const fetchRows = useCallback(async () => {
    const mine = ++gen.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/recruitment/candidates?${queryParams.toString()}`);
      if (mine !== gen.current) return;              // a newer request has started
      const list = candidateRows(res.data);
      setRows(list);
      setTotal(candidateTotal(res.data, list));
    } catch (e) {
      if (mine !== gen.current) return;
      if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') return;
      setRows([]);
      setTotal(0);
      setError(e?.response?.data?.error || 'Could not load candidates.');
    } finally {
      if (mine === gen.current) setLoading(false);
    }
  }, [queryParams]);

  // Debounced, because three of the filters are free-text boxes and an
  // un-debounced effect fires a request per keystroke.
  useEffect(() => {
    const t = setTimeout(fetchRows, 280);
    return () => clearTimeout(t);
  }, [fetchRows]);

  // ── Selection (§22) ──────────────────────────────────────────────────────
  // Pruned to the rows actually on screen whenever the page changes. A selection
  // that survives a filter change would let a bulk action apply to candidates the
  // recruiter can no longer see — the worst possible shape for a bulk write.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(rows.map(r => r.id));
      const next = new Set([...prev].filter(id => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const toggleOne = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map(r => r.id))));
  }, [rows]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // ── Sequential processing (§8, §32) ──────────────────────────────────────
  // Previous/next work over the CURRENT page's rows in their current sort order,
  // which is what "next candidate" means to someone working down a list.
  const indexOf = useCallback((id) => rows.findIndex(r => r.id === id), [rows]);
  const neighbourOf = useCallback((id, dir) => {
    const i = indexOf(id);
    if (i === -1) return null;
    const j = i + dir;
    return j >= 0 && j < rows.length ? rows[j] : null;
  }, [rows, indexOf]);

  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return {
    filters, setFilter, setManyFilters, resetFilters, activeFilterCount,
    rows, total, loading, error, refresh: fetchRows,
    page, totalPages, pageSize: PAGE_SIZE,
    goToPage: (p) => setFilter('page', String(Math.min(Math.max(p, 1), totalPages))),
    selected, toggleOne, toggleAll, clearSelection,
    indexOf, neighbourOf,
    queryParams,
  };
}
