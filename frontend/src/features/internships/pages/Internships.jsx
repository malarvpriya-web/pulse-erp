import { useState, useEffect, useCallback, useMemo } from 'react';
import { GraduationCap, UserCheck, CalendarClock, CalendarX, Award, Users, Search } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell, StatBand, Stat, LoadingState, LoadError, EmptyState } from '@/components/pulse-ui';
import { formatDuration, StatusBadge, StageBadge, stipendLabel, money, fmtDate } from '../internship';
import { useAuth } from '@/context/AuthContext';
import InternTemplatesPanel from './InternTemplatesPanel';
import './Internships.css';

/**
 * Internships — summary cards, the register, and internship reporting.
 *
 * Every number on this page comes from GET /interns/summary together with the
 * filter that reproduces it, and clicking it applies exactly that filter to the
 * register. A card and the list it opens therefore cannot count different
 * people (the integration suite re-derives each count through its filter).
 *
 * The filter state lives in the URL, so a filtered register can be refreshed,
 * bookmarked and reached with Back.
 */
const FILTER_KEYS = ['q', 'view', 'department', 'college', 'status', 'stage', 'mentor_id', 'internship_type',
  'duration', 'start_from', 'start_to', 'end_from', 'end_to'];
const VIEW_LABELS = {
  active: 'Active interns', starting_soon: 'Starting soon', ending_soon: 'Ending soon',
  completed: 'Completed', awaiting_completion: 'Past end date — awaiting completion', current: 'Onboarding + Active',
  evaluation_pending: 'Evaluation pending', converted: 'Converted to employee',
};
const TABS = ['register', 'reports', 'templates'];

/**
 * One single-series horizontal bar list. Each row is a button that filters the register.
 * ⚠ The accessor prop is `measure`, not `valueOf`: every props object inherits
 * Object.prototype.valueOf, so a destructuring default for that name never applies.
 */
function BarList({ title, rows, onPick, measure = r => r.count, format = v => v, empty = 'No data yet.' }) {
  const max = Math.max(1, ...rows.map(measure));
  return (
    <div className="in-report">
      <div className="iv-card-title">{title}</div>
      {rows.length === 0 || rows.every(r => !measure(r))
        ? <p className="iv-muted">{empty}</p>
        : (
          <ul className="in-bars">
            {rows.map(r => (
              <li key={r.label}>
                <button type="button" onClick={() => onPick(r.filter)} title={`${r.label}: ${format(measure(r))} — open in the register`}
                  disabled={!measure(r)}>
                  <span className="in-bar-label">{r.label}</span>
                  <span className="in-bar-track">{measure(r) > 0 && <span className="in-bar-fill" style={{ width: `${(measure(r) / max) * 100}%` }} />}</span>
                  <span className="in-bar-value">{format(measure(r))}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

export default function Internships({ setPage, urlParams = {} }) {
  const filters = useMemo(() => Object.fromEntries(
    FILTER_KEYS.filter(k => urlParams[k]).map(k => [k, urlParams[k]])), [urlParams]);
  const tab = TABS.includes(urlParams.tab) ? urlParams.tab : 'register';
  const { hasPermission } = useAuth();

  const [summary, setSummary] = useState(null);
  const [options, setOptions] = useState(null);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(filters.q || '');

  /** Navigate to the register with these filters (replacing the current ones). */
  const applyFilters = useCallback((next, nextTab = 'register') => {
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v != null && v !== ''));
    setPage('Internships', { ...(nextTab !== 'register' ? { tab: nextTab } : {}), ...clean });
  }, [setPage]);
  const setFilter = (k, v) => applyFilters({ ...filters, [k]: v });

  // Mentor evaluations waiting for an HR decision — the review queue.
  const [pendingEvals, setPendingEvals] = useState([]);
  useEffect(() => {
    api.get('/intern-evaluations?status=Submitted')
      .then(r => setPendingEvals(Array.isArray(r.data) ? r.data : []))
      .catch(() => setPendingEvals([]));
  }, []);

  useEffect(() => {
    api.get('/interns/summary').then(r => setSummary(r.data)).catch(() => setSummary(null));
    api.get('/interns/filter-options').then(r => setOptions(r.data)).catch(() => setOptions(null));
  }, []);

  const loadRows = useCallback(() => {
    setRows(null); setError(null);
    api.get(`/interns?${new URLSearchParams(filters)}`)
      .then(r => setRows(Array.isArray(r.data) ? r.data : []))
      .catch(e => setError(e?.response?.data?.error || e?.message || 'Could not load interns.'));
  }, [filters]);
  useEffect(() => { if (tab === 'register') loadRows(); }, [tab, loadRows]);

  // Search is applied after a short pause, not on every keystroke.
  useEffect(() => {
    if ((filters.q || '') === search) return undefined;
    const t = setTimeout(() => setFilter('q', search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const cards = summary?.cards;
  const cf = summary?.card_filters || {};
  const soon = summary?.soon_days ?? 14;
  const active = Object.keys(filters).length > 0;

  const chips = Object.entries(filters).filter(([k]) => k !== 'q').map(([k, v]) => {
    let label = v;
    if (k === 'view') label = VIEW_LABELS[v] || v;
    if (k === 'mentor_id') label = `Mentor: ${options?.mentors?.find(m => String(m.id) === String(v))?.name || `#${v}`}`;
    if (k.startsWith('start_') || k.startsWith('end_')) label = `${k.replace('_', ' ')} ${fmtDate(v)}`;
    return { k, label };
  });

  const select = (k, label, values, render = v => v) => (
    <label className="in-filter">
      <span>{label}</span>
      <select value={filters[k] || ''} onChange={e => setFilter(k, e.target.value)}>
        <option value="">All</option>
        {values.map(v => (typeof v === 'object'
          ? <option key={v.id} value={String(v.id)}>{v.name || `#${v.id}`}</option>
          : <option key={v} value={v}>{render(v)}</option>))}
      </select>
    </label>
  );

  return (
    <PageShell dock={
      <PageHero
        icon={GraduationCap}
        eyebrow="HR"
        title="Internships"
        subtitle="Interns are a separate population: INT numbers, no employee record, not in headcount or payroll."
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={() => setPage('EmployeesData')}>View Employees →</button>
          <button className="plh-cta" onClick={() => setPage('AddIntern')}>+ Add Intern</button>
        </>}
      />
    }>
      <div className="in-page">
        <StatBand cols={5}>
          <Stat index={0} icon={UserCheck} tone="success" label="Active Interns" loading={!cards} value={cards?.active}
            onClick={() => applyFilters(cf.active || {})} />
          <Stat index={1} icon={CalendarClock} tone="info" label="Starting Soon" loading={!cards} value={cards?.starting_soon}
            sub={`next ${soon} days`} onClick={() => applyFilters(cf.starting_soon || {})} />
          <Stat index={2} icon={CalendarX} tone="warning" label="Ending Soon" loading={!cards} value={cards?.ending_soon}
            sub={`next ${soon} days`} onClick={() => applyFilters(cf.ending_soon || {})} />
          <Stat index={3} icon={Award} tone="primary" label="Completed" loading={!cards} value={cards?.completed}
            onClick={() => applyFilters(cf.completed || {})} />
          <Stat index={4} icon={Users} tone="neutral" label="Total Interns" loading={!cards} value={cards?.total}
            onClick={() => applyFilters({})} />
        </StatBand>

        {cards?.awaiting_completion > 0 && (
          <button type="button" className="in-alert" onClick={() => applyFilters(cf.awaiting_completion)}>
            <strong>{cards.awaiting_completion}</strong> internship{cards.awaiting_completion === 1 ? ' is' : 's are'} past the end date
            and still open. Open {cards.awaiting_completion === 1 ? 'it' : 'them'} to mark Completed →
          </button>
        )}

        {cards?.evaluation_pending > 0 && (
          <button type="button" className="in-alert" onClick={() => applyFilters(cf.evaluation_pending)}>
            <strong>{cards.evaluation_pending}</strong> internship{cards.evaluation_pending === 1 ? ' has' : 's have'} ended
            without a mentor evaluation received (Evaluation Pending). Open {cards.evaluation_pending === 1 ? 'it' : 'them'} →
          </button>
        )}

        {pendingEvals.length > 0 && (
          <div className="in-alert ie-queue" role="status">
            <strong>{pendingEvals.length}</strong> mentor evaluation{pendingEvals.length === 1 ? '' : 's'} waiting for HR review:{' '}
            {pendingEvals.map((e, i) => (
              <span key={e.id}>
                {i > 0 && ', '}
                <button type="button" className="ai-link" onClick={() => setPage('ViewIntern', { id: e.intern_id, tab: 'Evaluation' })}>
                  {e.intern_name || e.intern_code} ({e.intern_code})
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="iv-tabs in-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'register'} className={tab === 'register' ? 'is-active' : ''}
            onClick={() => applyFilters(filters)}>Register</button>
          <button role="tab" aria-selected={tab === 'reports'} className={tab === 'reports' ? 'is-active' : ''}
            onClick={() => applyFilters({}, 'reports')}>Reports</button>
          <button role="tab" aria-selected={tab === 'templates'} className={tab === 'templates' ? 'is-active' : ''}
            onClick={() => applyFilters({}, 'templates')}>Document Templates</button>
        </div>

        {tab === 'templates' && <InternTemplatesPanel canEdit={hasPermission('internships', 'edit')} />}

        {tab === 'register' && (
          <div className="in-panel">
            <div className="in-filters">
              <label className="in-filter in-search">
                <span>Search</span>
                <div className="in-search-box">
                  <Search size={14} aria-hidden="true" />
                  <input type="search" value={search} placeholder="Name, Intern ID, college or email"
                    onChange={e => setSearch(e.target.value)} aria-label="Search interns" />
                </div>
              </label>
              {select('department', 'Department', options?.departments || [])}
              {select('college', 'College', options?.colleges || [])}
              {select('status', 'Status', options?.statuses || [])}
              {select('stage', 'Stage', options?.completion_stages || [])}
              {select('mentor_id', 'Mentor', options?.mentors || [])}
              {select('internship_type', 'Type', options?.internship_types || [])}
              {select('duration', 'Duration', options?.durations || [])}
              <label className="in-filter"><span>Start from</span>
                <input type="date" value={filters.start_from || ''} onChange={e => setFilter('start_from', e.target.value)} /></label>
              <label className="in-filter"><span>Start to</span>
                <input type="date" value={filters.start_to || ''} onChange={e => setFilter('start_to', e.target.value)} /></label>
              <label className="in-filter"><span>End from</span>
                <input type="date" value={filters.end_from || ''} onChange={e => setFilter('end_from', e.target.value)} /></label>
              <label className="in-filter"><span>End to</span>
                <input type="date" value={filters.end_to || ''} onChange={e => setFilter('end_to', e.target.value)} /></label>
            </div>

            {(chips.length > 0 || active) && (
              <div className="in-chips">
                {chips.map(c => (
                  <button key={c.k} type="button" className="in-chip" onClick={() => setFilter(c.k, '')} aria-label={`Remove filter ${c.label}`}>
                    {c.label} ✕
                  </button>
                ))}
                {active && <button type="button" className="ai-link" onClick={() => { setSearch(''); applyFilters({}); }}>Clear all</button>}
              </div>
            )}

            {error && <LoadError message={error} onRetry={loadRows} />}
            {!error && rows == null && <LoadingState shape="lines" rows={6} />}
            {!error && rows && rows.length === 0 && (
              <EmptyState
                title={active ? 'No interns match these filters' : 'No interns yet'}
                subtitle={active ? 'Clear a filter to widen the list.' : 'Add the first intern to start the register.'}
              />
            )}
            {!error && rows && rows.length > 0 && (
              <>
                <div className="in-count">{rows.length} intern{rows.length === 1 ? '' : 's'}</div>
                <div className="in-table-wrap">
                  <table className="in-table">
                    <thead>
                      <tr>
                        <th>#</th><th>Intern ID</th><th>Intern Name</th><th>College</th><th>Department</th>
                        <th>Internship Role</th><th>Mentor</th><th>Start Date</th><th>End Date</th>
                        <th>Duration</th><th>Status</th><th>Stage</th><th>Stipend</th><th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.id}>
                          <td>{i + 1}</td>
                          <td className="in-code">{r.intern_code}</td>
                          <td>
                            <button type="button" className="in-name" onClick={() => setPage('ViewIntern', { id: r.id })}>{r.name}</button>
                            {r.personal_email && <div className="iv-muted in-sub">{r.personal_email}</div>}
                          </td>
                          <td>{r.college}</td>
                          <td>{r.department}</td>
                          <td>{r.designation}</td>
                          <td>{r.mentor_name || '—'}</td>
                          <td>{fmtDate(r.start_date)}</td>
                          <td>{fmtDate(r.end_date)}</td>
                          <td title={`${r.duration_days} days`}>{formatDuration(r.start_date, r.end_date)}</td>
                          <td><StatusBadge status={r.status} /></td>
                          <td>
                            <StageBadge stage={r.completion_stage} />
                            {r.converted_employee_code && <div className="iv-muted in-sub">→ {r.converted_employee_code}</div>}
                          </td>
                          <td>{stipendLabel(r.stipend, r.stipend_frequency)}</td>
                          <td className="in-actions">
                            <button type="button" className="ai-link" onClick={() => setPage('ViewIntern', { id: r.id })}>View</button>
                            <button type="button" className="ai-link" onClick={() => setPage('EditIntern', { id: r.id })}>Edit</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'reports' && (
          !summary ? <LoadingState shape="lines" rows={6} /> : (
            <div className="in-reports">
              <p className="iv-muted" style={{ gridColumn: '1 / -1', margin: 0 }}>
                Internship reporting only — interns never appear in Employee Reports. Click any bar to open those interns in the register.
              </p>
              <BarList title="Active interns by department" rows={summary.reports.active_by_department} onPick={applyFilters}
                empty="No active interns." />
              <BarList title="Interns by college" rows={summary.reports.by_college} onPick={applyFilters} />
              <BarList title="Interns by internship duration" rows={summary.reports.by_duration} onPick={applyFilters} />
              <BarList title="Interns by status" rows={summary.reports.by_status} onPick={applyFilters} />
              <div className="in-report">
                <div className="iv-card-title">Stipend spend (Onboarding + Active)</div>
                <div className="in-spend">
                  <div><span className="iv-row-label">Monthly run-rate</span><strong>{money(summary.reports.stipend.monthly_run_rate)}</strong></div>
                  <div><span className="iv-row-label">Committed for these internships</span><strong>{money(summary.reports.stipend.committed_total)}</strong></div>
                  <div><span className="iv-row-label">Paid / unpaid interns</span><strong>{summary.reports.stipend.paid} / {summary.reports.stipend.unpaid}</strong></div>
                  <div><span className="iv-row-label">All internships started to date</span><strong>{money(summary.reports.stipend.all_time_total)}</strong></div>
                </div>
              </div>
              <BarList title="Monthly stipend by department" rows={summary.reports.stipend.by_department} onPick={applyFilters}
                measure={r => r.monthly} format={money} empty="No stipends being paid." />
            </div>
          )
        )}
      </div>
    </PageShell>
  );
}
