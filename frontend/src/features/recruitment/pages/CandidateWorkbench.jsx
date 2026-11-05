import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Users, Search, SlidersHorizontal, X, ChevronLeft, ChevronRight, Download,
  Shuffle, Archive, CalendarClock, Tag, ClipboardCheck,
} from 'lucide-react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import useCandidateWorkbench, { EXPERIENCE_BANDS } from '../shared/useCandidateWorkbench';
import CandidateQuickView from '../shared/components/CandidateQuickView';
import {
  ConsiderOtherRolesDialog, TalentBankDialog, FutureOpportunityDialog, BulkConfirmDialog,
} from '../shared/components/CandidateActionDialogs';
import {
  ALL_STAGES, ACTIVE_STAGES, DEADEND_STAGES, stageLabelShort, stageColor,
  dispositionLabel, dispositionColor, SELECTABLE_DISPOSITIONS,
  sourceLabel, SELECTABLE_SOURCES, SOURCE_LABELS,
  relocationLabel, relocationColor, decisionLabel, decisionTone,
} from '../shared/constants';
import './candidate-workbench.css';

/**
 * CandidateWorkbench — §6's candidate list, which the brief calls "the most
 * frequently used screen".
 *
 * Replaces AllCandidates.jsx, which was missing the three things that make a list
 * workable at volume: no checkbox column (`selectable={false}`), no way to change
 * a status without leaving the page, and no quick view — clicking a candidate was
 * a full page transition that discarded every filter on the way there and back.
 *
 * ── WHAT MAKES THIS FAST ───────────────────────────────────────────────────
 *  · Every predicate is a server-side filter (see useCandidateWorkbench). A
 *    client-side filter over a paged list can only search the page you are on,
 *    which produces confidently wrong "no matches" answers.
 *  · Filters live in the URL, so the back button, a refresh and a bookmark all
 *    reproduce the same list — §31's "preserve filters when returning".
 *  · Clicking a row opens a drawer, not a page. J / K move through candidates
 *    inside it without going back to the list at all (§8, §32).
 *  · The status dropdown writes directly from the row (§7).
 *  · Résumés are never fetched for the list. Only the one being read loads.
 *
 * ── WHAT THIS SCREEN DELIBERATELY IS NOT ───────────────────────────────────
 * It is not a dashboard. §25 is explicit that recruiters need action before
 * charts, so the only numbers here are the result count and the pagination.
 */

const NOTICE_OPTIONS = [
  { value: 'all', label: 'Any notice period' },
  { value: '15', label: 'Within 15 days' },
  { value: '30', label: 'Within 30 days' },
  { value: '60', label: 'Within 60 days' },
  { value: '90', label: 'Within 90 days' },
];

const STALE_OPTIONS = [
  { value: 'all', label: 'Any last activity' },
  { value: '3',   label: 'No movement in 3+ days' },
  { value: '7',   label: 'No movement in 7+ days' },
  { value: '14',  label: 'No movement in 14+ days' },
  { value: '30',  label: 'No movement in 30+ days' },
];

const QUALIFICATIONS = ['Diploma', 'BE/BTech', 'ME/MTech', 'MBA', 'MCA', 'BCA', 'BSc', 'MSc', 'BCom', 'PhD', 'Other'];

const SORTS = [
  { value: 'last_activity_at', label: 'Last activity' },
  { value: 'created_at',       label: 'Date applied' },
  { value: 'full_name',        label: 'Name' },
  { value: 'experience_years', label: 'Experience' },
  { value: 'current_stage',    label: 'Stage' },
  { value: 'disposition',      label: 'Candidate status' },
  { value: 'location',         label: 'Location' },
  { value: 'source',           label: 'Source' },
];

export default function CandidateWorkbench({ setPage, embedded = false, scope = 'all' }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);

  const wb = useCandidateWorkbench({ scope });
  const {
    filters, setFilter, resetFilters, activeFilterCount,
    rows, total, loading, error, refresh,
    page, totalPages, goToPage,
    selected, toggleOne, toggleAll, clearSelection, neighbourOf,
  } = wb;

  const [showFilters, setShowFilters] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [meta, setMeta] = useState({ departments: [], recruiters: [], pools: [] });
  const [dialog, setDialog] = useState(null);      // { kind, candidate }
  const [bulkPending, setBulkPending] = useState(null);
  const [rowBusy, setRowBusy] = useState(null);

  // One request for every picker on the page (§29's "GET candidate quick view"
  // sibling). Loaded once — departments and pools do not change while a recruiter
  // works through a list.
  useEffect(() => {
    let cancelled = false;
    api.get('/recruitment/meta/candidate-workbench')
      .then(res => { if (!cancelled) setMeta(res.data || {}); })
      .catch(() => { /* the screen is usable without the pickers; filters degrade to text */ });
    return () => { cancelled = true; };
  }, []);

  const openProfile = useCallback((id) => {
    setSelectedCandidateId(id);
    // The list's own URL params survive: setPage changes the page key, and the
    // search string is what carries the filters, so coming back restores them.
    setPage?.('CandidateDetail');
  }, [setSelectedCandidateId, setPage]);

  const openScreening = useCallback((id, applicationId) => {
    setSelectedCandidateId(id);
    setPage?.('CandidateScreening', applicationId ? { application: applicationId } : undefined);
  }, [setSelectedCandidateId, setPage]);

  /** §7 — change a stage straight from the row. */
  const changeStage = async (row, stage) => {
    if (stage === row.current_stage) return;
    setRowBusy(row.id);
    try {
      await api.post(`/recruitment/candidates/${row.id}/move-stage`, { new_stage: stage });
      toast(`${row.full_name} → ${stageLabelShort(stage)}`);
      refresh();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not change the stage', 'error');
    } finally {
      setRowBusy(null);
    }
  };

  /** §22 — bulk. Destructive values route through the confirm dialog. */
  const runBulk = async (action, value, { confirm = false } = {}) => {
    try {
      const res = await api.post('/recruitment/candidates/bulk-action', {
        candidate_ids: [...selected], action, value, confirm,
      });
      toast(res?.data?.message || 'Updated');
      clearSelection();
      setBulkPending(null);
      refresh();
    } catch (e) {
      // The API refuses a destructive bulk action without `confirm`. That refusal
      // is the trigger for the dialog rather than something the UI predicts, so
      // the control lives in one place and cannot be bypassed by a stale client.
      if (e?.response?.data?.requires_confirmation) {
        setBulkPending({ action, value, label: e.response.data.error });
        return;
      }
      toast(e?.response?.data?.error || 'Bulk update failed', 'error');
    }
  };

  const exportCsv = async () => {
    try {
      const p = new URLSearchParams(wb.queryParams);
      p.delete('limit'); p.delete('offset');
      const res = await api.get(`/recruitment/candidates/export?${p.toString()}`);
      const list = res.data?.rows || [];
      if (!list.length) return toast('Nothing to export for these filters.', 'error');

      // Built from the server's own response, not from the rows on screen: the
      // export endpoint is the one that carries the `recruitment:export`
      // permission and records who took a copy. Building the file from the list
      // response is how the old CSV button bypassed both.
      const cols = [
        ['candidate_code', 'Candidate ID'], ['full_name', 'Name'], ['email', 'Email'],
        ['phone', 'Phone'], ['job_title', 'Applied For'], ['current_stage', 'Stage'],
        ['disposition', 'Candidate Status'], ['experience_years', 'Experience'],
        ['current_city', 'City'], ['current_state', 'State'], ['source', 'Source'],
        ['recruiter_name', 'Recruiter'], ['created_at', 'Applied'],
      ];
      const esc = (v) => {
        const s = v == null ? '' : String(v);
        // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
        // Prefixing an apostrophe is the standard neutralisation and this codebase
        // has shipped the un-neutralised version before.
        const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const csv = [
        cols.map(c => esc(c[1])).join(','),
        ...list.map(r => cols.map(c => esc(r[c[0]])).join(',')),
      ].join('\r\n');

      // A byte-order mark, built from its code point rather than typed as a
      // literal character. Excel needs it to read the file as UTF-8 instead of
      // mojibake; a raw BOM in the source is invisible to the next reader and
      // trips eslint's no-irregular-whitespace.
      const BOM = String.fromCharCode(0xFEFF);
      const url = URL.createObjectURL(new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `candidates-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast(`Exported ${list.length} candidates`);
    } catch (e) {
      if (e?.response?.status === 403) {
        return toast('You do not have permission to export candidate data.', 'error');
      }
      toast(e?.response?.data?.error || 'Export failed', 'error');
    }
  };

  const prevRow = openId ? neighbourOf(openId, -1) : null;
  const nextRow = openId ? neighbourOf(openId, 1) : null;

  const allOnPageSelected = rows.length > 0 && selected.size === rows.length;

  const rangeLabel = useMemo(() => {
    if (!total) return '0 candidates';
    const from = (page - 1) * wb.pageSize + 1;
    const to = Math.min(page * wb.pageSize, total);
    return `${from}–${to} of ${total}`;
  }, [page, total, wb.pageSize]);

  return (
    <div className={`cwb${embedded ? ' cwb--embedded' : ''}`}>
      {/* ── Search + filter bar ───────────────────────────────────────── */}
      <div className="cwb-bar">
        <div className="cwb-search">
          <Search size={15} className="cwb-search-icon" />
          <input
            className="cwb-search-input"
            value={filters.q}
            onChange={(e) => setFilter('q', e.target.value)}
            placeholder="Name, phone, email, candidate ID, employer, job title, city…"
            aria-label="Search candidates"
          />
          {filters.q && (
            <button type="button" className="cwb-search-clear" onClick={() => setFilter('q', '')} aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </div>

        {/* The four filters a recruiter reaches for constantly stay on the bar;
            the other fourteen live behind "More filters". A flat wall of eighteen
            controls is the thing that makes a list feel slow to use. */}
        <select className="cwb-sel" value={filters.stage} onChange={(e) => setFilter('stage', e.target.value)} aria-label="Stage">
          <option value="all">All stages</option>
          <optgroup label="In the pipeline">
            {ACTIVE_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
          </optgroup>
          <optgroup label="Parked">
            {DEADEND_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
          </optgroup>
        </select>

        <select className="cwb-sel" value={filters.disposition} onChange={(e) => setFilter('disposition', e.target.value)} aria-label="Candidate status">
          <option value="all">Any candidate status</option>
          {SELECTABLE_DISPOSITIONS.map(d => <option key={d} value={d}>{dispositionLabel(d)}</option>)}
        </select>

        <select className="cwb-sel" value={filters.recruiter} onChange={(e) => setFilter('recruiter', e.target.value)} aria-label="Recruiter">
          <option value="all">Any recruiter</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
          {meta.recruiters?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>

        <button
          type="button"
          className={`cwb-more${showFilters ? ' is-on' : ''}`}
          onClick={() => setShowFilters(v => !v)}
          aria-expanded={showFilters}
        >
          <SlidersHorizontal size={14} />
          More filters
          {activeFilterCount > 0 && <span className="cwb-badge">{activeFilterCount}</span>}
        </button>

        {activeFilterCount > 0 && (
          <button type="button" className="cwb-reset" onClick={resetFilters}>Clear all</button>
        )}

        <div className="cwb-bar-right">
          <select
            className="cwb-sel cwb-sel--sort"
            value={`${filters.sortBy}:${filters.sortDir}`}
            onChange={(e) => {
              const [by, dir] = e.target.value.split(':');
              setFilter('sortBy', by);
              setFilter('sortDir', dir);
            }}
            aria-label="Sort"
          >
            {SORTS.flatMap(s => [
              <option key={`${s.value}:desc`} value={`${s.value}:desc`}>{s.label} ↓</option>,
              <option key={`${s.value}:asc`} value={`${s.value}:asc`}>{s.label} ↑</option>,
            ])}
          </select>
          <button type="button" className="cwb-icon-btn" onClick={exportCsv} title="Export these candidates">
            <Download size={14} />
          </button>
        </div>
      </div>

      {/* ── Advanced filters ──────────────────────────────────────────── */}
      {showFilters && (
        <div className="cwb-filters">
          <Field label="Job / department">
            <select className="cwb-sel cwb-sel--full" value={filters.department} onChange={(e) => setFilter('department', e.target.value)}>
              <option value="all">Any department</option>
              {meta.departments?.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Source">
            <select className="cwb-sel cwb-sel--full" value={filters.source} onChange={(e) => setFilter('source', e.target.value)}>
              <option value="all">Any source</option>
              {SELECTABLE_SOURCES.map(v => <option key={v} value={v}>{SOURCE_LABELS[v]}</option>)}
              <option value="resume_db">{SOURCE_LABELS.resume_db}</option>
            </select>
          </Field>
          <Field label="Experience">
            <select className="cwb-sel cwb-sel--full" value={filters.exp} onChange={(e) => setFilter('exp', e.target.value)}>
              {EXPERIENCE_BANDS.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </Field>
          <Field label="Location">
            <input className="cwb-input" value={filters.location} onChange={(e) => setFilter('location', e.target.value)} placeholder="Madurai" />
          </Field>
          <Field label="Skills — all of them">
            <input className="cwb-input" value={filters.skills} onChange={(e) => setFilter('skills', e.target.value)} placeholder="Power Electronics, MATLAB" />
          </Field>
          <Field label="Education">
            <select className="cwb-sel cwb-sel--full" value={filters.qualification} onChange={(e) => setFilter('qualification', e.target.value)}>
              <option value="all">Any qualification</option>
              {QUALIFICATIONS.map(q => <option key={q} value={q}>{q}</option>)}
            </select>
          </Field>
          <Field label="Specialisation">
            <input className="cwb-input" value={filters.specialisation} onChange={(e) => setFilter('specialisation', e.target.value)} placeholder="Electrical" />
          </Field>
          <Field label="Relocation">
            <select className="cwb-sel cwb-sel--full" value={filters.relocate} onChange={(e) => setFilter('relocate', e.target.value)}>
              <option value="all">Any answer</option>
              <option value="true">Can be at the site</option>
              <option value="already_local">Already lives nearby</option>
              <option value="willing">Can relocate</option>
              <option value="willing_with_support">Can relocate, with support</option>
              <option value="needs_information">Needs more information</option>
              <option value="not_currently">Not currently</option>
              <option value="no">No</option>
              <option value="unknown">Not discussed</option>
            </select>
          </Field>
          <Field label="Notice period">
            <select className="cwb-sel cwb-sel--full" value={filters.notice} onChange={(e) => setFilter('notice', e.target.value)}>
              {NOTICE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="Tags">
            <input className="cwb-input" value={filters.tags} onChange={(e) => setFilter('tags', e.target.value)} placeholder="AHF, HighPotential" />
          </Field>
          <Field label="Talent pool">
            <select className="cwb-sel cwb-sel--full" value={filters.pool} onChange={(e) => setFilter('pool', e.target.value)}>
              <option value="all">Any pool</option>
              {meta.pools?.map(p => <option key={p.id} value={p.id}>{p.pool_name}</option>)}
            </select>
          </Field>
          <Field label="Résumé content">
            <input className="cwb-input" value={filters.resumeText} onChange={(e) => setFilter('resumeText', e.target.value)} placeholder="inverter troubleshooting" />
          </Field>
          <Field label="Applied from">
            <input type="date" className="cwb-input" value={filters.appliedFrom} onChange={(e) => setFilter('appliedFrom', e.target.value)} />
          </Field>
          <Field label="Applied to">
            <input type="date" className="cwb-input" value={filters.appliedTo} onChange={(e) => setFilter('appliedTo', e.target.value)} />
          </Field>
          <Field label="Waiting on us">
            <select className="cwb-sel cwb-sel--full" value={filters.staleDays} onChange={(e) => setFilter('staleDays', e.target.value)}>
              {STALE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        </div>
      )}

      {/* ── Bulk bar (§22) ────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="cwb-bulk" role="region" aria-label="Bulk actions">
          <span className="cwb-bulk-count">{selected.size} selected</span>

          <select
            className="cwb-sel cwb-sel--bulk"
            defaultValue=""
            onChange={(e) => { if (e.target.value) { runBulk('stage', e.target.value); e.target.value = ''; } }}
            aria-label="Change stage for selected"
          >
            <option value="">Change stage…</option>
            {ALL_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
          </select>

          <select
            className="cwb-sel cwb-sel--bulk"
            defaultValue=""
            onChange={(e) => { if (e.target.value) { runBulk('disposition', e.target.value); e.target.value = ''; } }}
            aria-label="Change candidate status for selected"
          >
            <option value="">Candidate status…</option>
            {SELECTABLE_DISPOSITIONS.map(d => <option key={d} value={d}>{dispositionLabel(d)}</option>)}
          </select>

          <select
            className="cwb-sel cwb-sel--bulk"
            defaultValue=""
            onChange={(e) => { if (e.target.value) { runBulk('recruiter', e.target.value === 'none' ? '' : e.target.value); e.target.value = ''; } }}
            aria-label="Assign recruiter for selected"
          >
            <option value="">Assign recruiter…</option>
            <option value="none">Unassign</option>
            {meta.recruiters?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>

          <button
            type="button" className="cwb-bulk-btn"
            onClick={() => {
              const tag = window.prompt('Tag to add to the selected candidates');
              if (tag?.trim()) runBulk('add_tag', tag.trim());
            }}
          >
            <Tag size={13} /> Add tag
          </button>

          <button
            type="button" className="cwb-bulk-btn"
            onClick={() => setDialog({ kind: 'bulk_bank' })}
          >
            <Archive size={13} /> To Talent Bank
          </button>

          <button type="button" className="cwb-bulk-clear" onClick={clearSelection}>Clear</button>
        </div>
      )}

      {/* ── Result count ──────────────────────────────────────────────── */}
      <div className="cwb-meta">
        <span>{loading ? 'Searching…' : rangeLabel}</span>
        {!loading && activeFilterCount > 0 && (
          <span className="cwb-meta-dim">
            {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} applied
          </span>
        )}
      </div>

      {/* ── Table (§6) ────────────────────────────────────────────────── */}
      <div className="cwb-table-wrap">
        <table className="cwb-table">
          <thead>
            <tr>
              <th className="cwb-th-check">
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={toggleAll}
                  aria-label="Select all on this page"
                />
              </th>
              <th>Candidate</th>
              <th>Applied role</th>
              <th>Exp.</th>
              <th>Location</th>
              <th>Source</th>
              <th>Applied</th>
              <th>Stage</th>
              <th>Screening</th>
              <th>Recruiter</th>
              <th>Last activity</th>
              <th className="cwb-th-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`cwb-tr${openId === r.id ? ' is-open' : ''}${selected.has(r.id) ? ' is-selected' : ''}`}
              >
                <td className="cwb-td-check">
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggleOne(r.id)}
                    aria-label={`Select ${r.full_name}`}
                  />
                </td>

                <td>
                  {/* The name opens the DRAWER, not the profile. That is the
                      §8 choice: the recruiter stays on the list. The drawer offers
                      the profile for when the résumé is what they need. */}
                  <button type="button" className="cwb-name" onClick={() => setOpenId(r.id)}>
                    {r.full_name || '—'}
                  </button>
                  <div className="cwb-sub">
                    {r.candidate_code && <span>{r.candidate_code}</span>}
                    {r.phone && <span>{r.phone}</span>}
                    <span className="cwb-chip cwb-chip--xs" style={dispositionColor(r.disposition)}>
                      {dispositionLabel(r.disposition)}
                    </span>
                  </div>
                </td>

                <td>
                  <span className="cwb-cell-main">{r.job_title || 'Speculative'}</span>
                  {r.application_count > 1 && (
                    <span className="cwb-sub">+{r.application_count - 1} more</span>
                  )}
                </td>

                <td>{r.experience_years != null ? `${r.experience_years}y` : '—'}</td>

                <td>
                  <span className="cwb-cell-main">
                    {[r.current_city, r.current_state].filter(Boolean).join(', ') || r.location || '—'}
                  </span>
                  {r.willing_to_relocate && r.willing_to_relocate !== 'unknown' && (
                    <span className="cwb-chip cwb-chip--xs" style={relocationColor(r.willing_to_relocate)}>
                      {relocationLabel(r.willing_to_relocate)}
                    </span>
                  )}
                </td>

                <td><span className="cwb-chip cwb-chip--xs cwb-chip--dim">{sourceLabel(r.source)}</span></td>

                <td className="cwb-nowrap">{fmtDate(r.created_at)}</td>

                <td>
                  {/* §7 — the status change IS the cell. No edit screen, no modal. */}
                  <select
                    className="cwb-stage-sel"
                    style={stageColor(r.current_stage)}
                    value={r.current_stage || 'applied'}
                    disabled={rowBusy === r.id}
                    onChange={(e) => changeStage(r, e.target.value)}
                    aria-label={`Stage for ${r.full_name}`}
                  >
                    <optgroup label="In the pipeline">
                      {ACTIVE_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
                    </optgroup>
                    <optgroup label="Parked — stays in the system">
                      {DEADEND_STAGES.map(s => <option key={s} value={s}>{stageLabelShort(s)}</option>)}
                    </optgroup>
                  </select>
                </td>

                <td>
                  {r.screening_status
                    ? (
                      <span
                        className="cwb-chip cwb-chip--xs"
                        style={r.screening_decision ? decisionTone(r.screening_decision) : { background: '#F5F3FF', color: '#6C47FF' }}
                        title={r.screening_decision ? decisionLabel(r.screening_decision) : 'Screening in progress'}
                      >
                        {r.screening_score != null ? `${r.screening_score}/100` : 'Draft'}
                      </span>
                    )
                    : <span className="cwb-dim">Not screened</span>}
                </td>

                <td>
                  {r.recruiter_name
                    ? <span className="cwb-cell-main">{r.recruiter_name}</span>
                    : <span className="cwb-dim">Unassigned</span>}
                </td>

                <td className="cwb-nowrap">
                  {/* Days since LAST MOVEMENT, not since the application arrived.
                      The two are different questions and the old dashboard
                      conflated them — a candidate moved yesterday reported as
                      waiting thirty days. */}
                  <span className={r.days_since_activity >= 7 ? 'cwb-stale' : ''}>
                    {r.days_since_activity != null
                      ? (r.days_since_activity === 0 ? 'Today' : `${r.days_since_activity}d ago`)
                      : '—'}
                  </span>
                </td>

                <td className="cwb-td-actions">
                  {/* No application id is passed. The row carries `job_opening_id`,
                      NOT an application id, and handing that to the screening page
                      would attach the screening to the wrong application — or be
                      rejected outright by the endpoint, which checks that the
                      application belongs to the candidate. The screening page
                      resolves the primary application itself, which is right in
                      every case including a speculative profile with none. */}
                  <button type="button" className="cwb-act" title="Screen this candidate"
                          onClick={() => openScreening(r.id)}>
                    <ClipboardCheck size={13} />
                  </button>
                  <button type="button" className="cwb-act" title="Consider for other roles"
                          onClick={() => setDialog({ kind: 'roles', candidate: r })}>
                    <Shuffle size={13} />
                  </button>
                  <button type="button" className="cwb-act" title="Keep in the Talent Bank"
                          onClick={() => setDialog({ kind: 'bank', candidate: r })}>
                    <Archive size={13} />
                  </button>
                  <button type="button" className="cwb-act" title="Future opportunity"
                          onClick={() => setDialog({ kind: 'future', candidate: r })}>
                    <CalendarClock size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && rows.length === 0 && (
          <div className="cwb-empty">
            <Users size={38} strokeWidth={1.4} />
            {error ? (
              <>
                <p className="cwb-empty-title">Could not load candidates</p>
                <p className="cwb-empty-sub">{error}</p>
                <button type="button" className="cwb-empty-btn" onClick={refresh}>Try again</button>
              </>
            ) : activeFilterCount > 0 ? (
              <>
                <p className="cwb-empty-title">No candidates match these filters</p>
                <p className="cwb-empty-sub">
                  {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} applied. The search covers
                  name, phone, email, candidate ID, employer, job title and city.
                </p>
                <button type="button" className="cwb-empty-btn" onClick={resetFilters}>Clear all filters</button>
              </>
            ) : (
              <>
                <p className="cwb-empty-title">No candidates yet</p>
                <p className="cwb-empty-sub">Add candidates by hand, or open a job so applications can arrive.</p>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Pagination ────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div className="cwb-pager">
          <button type="button" className="cwb-icon-btn" disabled={page <= 1} onClick={() => goToPage(page - 1)} aria-label="Previous page">
            <ChevronLeft size={15} />
          </button>
          <span className="cwb-pager-label">Page {page} of {totalPages}</span>
          <button type="button" className="cwb-icon-btn" disabled={page >= totalPages} onClick={() => goToPage(page + 1)} aria-label="Next page">
            <ChevronRight size={15} />
          </button>
        </div>
      )}

      {/* ── Quick view drawer (§8) ────────────────────────────────────── */}
      {openId && (
        <CandidateQuickView
          candidateId={openId}
          onClose={() => setOpenId(null)}
          hasPrev={Boolean(prevRow)}
          hasNext={Boolean(nextRow)}
          onPrev={() => prevRow && setOpenId(prevRow.id)}
          onNext={() => nextRow && setOpenId(nextRow.id)}
          onOpenProfile={openProfile}
          onOpenScreening={openScreening}
          onConsiderOtherRoles={(c) => setDialog({ kind: 'roles', candidate: c })}
          onAddToTalentBank={(c) => setDialog({ kind: 'bank', candidate: c })}
          onFutureOpportunity={(c) => setDialog({ kind: 'future', candidate: c })}
          onChanged={refresh}
        />
      )}

      {/* ── Dialogs ───────────────────────────────────────────────────── */}
      {dialog?.kind === 'roles' && (
        <ConsiderOtherRolesDialog
          candidate={dialog.candidate}
          departments={meta.departments || []}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      )}
      {dialog?.kind === 'bank' && (
        <TalentBankDialog
          candidate={dialog.candidate}
          pools={meta.pools || []}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      )}
      {dialog?.kind === 'future' && (
        <FutureOpportunityDialog
          candidate={dialog.candidate}
          departments={meta.departments || []}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      )}
      {dialog?.kind === 'bulk_bank' && (
        <TalentBankDialog
          pools={meta.pools || []}
          title={`Keep ${selected.size} candidate${selected.size === 1 ? '' : 's'} in the Talent Bank`}
          subtitle="Every selected candidate is added to the categories you choose. Nothing is deleted."
          onClose={() => setDialog(null)}
          // Routed through the BULK endpoint, not N single-candidate calls: one
          // transaction, so the action either applies to everyone selected or to
          // nobody. A half-applied bulk action leaves the recruiter unable to tell
          // which half went through.
          onSubmit={({ pool_ids }) => runBulk('talent_bank', pool_ids)}
        />
      )}
      {bulkPending && (
        <BulkConfirmDialog
          count={selected.size}
          actionLabel={bulkPending.label}
          destructive
          onCancel={() => setBulkPending(null)}
          onConfirm={() => runBulk(bulkPending.action, bulkPending.value, { confirm: true })}
        />
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="cwb-field">
      <span className="cwb-field-label">{label}</span>
      {children}
    </div>
  );
}
