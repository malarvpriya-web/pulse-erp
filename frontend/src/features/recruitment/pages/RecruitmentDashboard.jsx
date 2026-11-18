import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Briefcase, Users, RefreshCw, MapPin, LayoutDashboard, ListChecks,
  UserCheck, AlertTriangle,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, Cell, PieChart, Pie,
} from 'recharts';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import DataTable from '@/components/core/DataTable';
import { fmtDate } from '@/utils/dateFormatter';
import useDashboardFilters from '@/hooks/useDashboardFilters';
import useAppStore from '@/store/useAppStore';
import { STAGE_LABELS, ALL_STAGES, stageColor, openingStatus, sourceLabel } from '../shared/constants';
import './RecruitmentDashboard.css';
import { DashboardFilterBar, PageHero, PageShell } from '@/components/pulse-ui';

/**
 * Recruitment Dashboard — analytics only.
 *
 * Reading, not acting: what is open, where candidates stand and where they
 * come from. Work happens elsewhere, and this page links there.
 *
 * Removed 2026-11-17 (recruitment page audit D1–D4): its own kanban, interview
 * list and Schedule-Interview / Create-Offer forms. Pipeline Snapshot, a third
 * overview page, was deleted at the same time; My Work is the action page.
 *
 * Dashboard review 2026-11-17:
 *  - Each tile opens the list behind its number, filtered the same way (the
 *    links used to open unfiltered pages). A number with no matching list
 *    (hires in a period) is not a link.
 *  - Interviews today and offers awaiting answer are NOT shown here: they are
 *    action items and appear on My Work only (overlap removed 2026-11-17).
 *  - Hires follow the period and say which period; "this month" was really FY.
 *  - A failed request shows an error, not zeros that look like real data.
 *  - "Open positions" lists open and on-hold roles (all statuses on request).
 *  - The stage chart is named for what it is: where everyone is now.
 */
const SOURCE_COLORS = ['#6B3FDB', '#22c55e', '#0ea5e9', '#ec4899', '#f59e0b', '#06b6d4', '#64748b'];
const fmt = (v) => v ?? 0;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const OPEN_STATUSES = ['open', 'on_hold'];
const FEEDS = {
  kpis:      'headline numbers',
  positions: 'job openings',
  stages:    'candidates by stage',
  sources:   'candidate sources',
};

export default function RecruitmentDashboard({ setPage }) {
  const setSelectedJobId = useAppStore(s => s.setSelectedJobId);
  const [tab, setTab]                       = useState('positions');
  const [kpis, setKpis]                     = useState(null);
  const [positions, setPositions]           = useState([]);
  const [pipelineCounts, setPipelineCounts] = useState([]);
  const [sourceData, setSourceData]         = useState([]);
  const [departments, setDepartments]       = useState([]);
  const [failed, setFailed]                 = useState([]);
  const [showAll, setShowAll]               = useState(false);
  const [loading, setLoading]               = useState(false);

  // FY by default: hires and sources are activity, and a financial year is the
  // window HR reports on. Backlog numbers (open roles, active candidates,
  // interviews today, offers awaiting answer) are point-in-time and ignore it.
  const filters = useDashboardFilters({
    defaultPeriod: 'fytd',
    dimensions: { department: 'all' },
    storageKey: 'recruitment-dashboard',
  });
  const { params } = filters;
  const department = params.department || null;

  useEffect(() => {
    let cancelled = false;
    api.get('/recruitment/filter-options')
      .then(r => { if (!cancelled) setDepartments(Array.isArray(r.data?.departments) ? r.data.departments : []); })
      .catch(() => { /* the dropdown falls back to "All departments" */ });
    return () => { cancelled = true; };
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    const deptOnly = department ? { department } : {};
    const [kpiRes, posRes, pipeRes, srcRes] = await Promise.allSettled([
      api.get('/recruitment/dashboard-summary', { params }),
      api.get('/recruitment/openings'),
      api.get('/recruitment/pipeline-summary', { params: deptOnly }),
      api.get('/recruitment/analytics/source', { params }),
    ]);
    const ok = (r) => r.status === 'fulfilled';
    const bad = [];
    if (!ok(kpiRes)) bad.push('kpis');
    if (!ok(posRes)) bad.push('positions');
    if (!ok(pipeRes)) bad.push('stages');
    if (!ok(srcRes)) bad.push('sources');
    setFailed(bad);

    setKpis(ok(kpiRes) ? kpiRes.value.data : null);
    setPositions(ok(posRes) && Array.isArray(posRes.value.data) ? posRes.value.data : []);
    const pipe = ok(pipeRes) && Array.isArray(pipeRes.value.data) ? pipeRes.value.data : [];
    setPipelineCounts([...pipe].sort((a, b) => ALL_STAGES.indexOf(a.stage) - ALL_STAGES.indexOf(b.stage)));
    // Number(): a count that arrives as a string makes the pie draw nothing.
    const src = ok(srcRes) && Array.isArray(srcRes.value.data) ? srcRes.value.data : [];
    setSourceData(src.map(s => ({ ...s, count: Number(s.count) || 0 })).filter(s => s.count > 0));
    setLoading(false);
  }, [params, department]);

  useEffect(() => { loadData(); }, [loadData]);

  // Openings in the chosen department. Department and location fall back to
  // the requisition's when the opening itself has none.
  const deptOf = (p) => p.department || p.req_department || null;
  const inDept = useMemo(
    () => positions.filter(p => !department || deptOf(p) === department),
    [positions, department],
  );
  const openRoles = inDept.filter(p => p.status === 'open');
  const shownRows = showAll ? inDept : inDept.filter(p => OPEN_STATUSES.includes(p.status));
  const hiddenCount = inDept.length - shownRows.length;

  const openJob = (p) => { setSelectedJobId?.(p.id); setPage?.('Candidates', { tab: 'pipeline' }); };
  const showTable = () => {
    setTab('positions');
    setShowAll(false);
    requestAnimationFrame(() => document.getElementById('rec-dash-positions')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const kpiFailed = failed.includes('kpis');
  const val = (v) => (kpiFailed ? '—' : fmt(v));
  // The department travels with the link, so the list opens filtered the same way.
  const deptParam = department ? { dept: department } : {};
  const periodLabel = kpis?.period_label || 'this financial year';
  const seats = kpis?.open_headcount ?? 0;
  const avgTth = kpis?.avg_time_to_hire;

  const tiles = [
    { icon: <Briefcase size={20} color="#6B3FDB" />, label: 'Open roles', val: val(kpis?.open_positions),
      sub: `${plural(seats, 'seat')} still to fill`, bg: '#f5f3ff', go: showTable },
    { icon: <Users size={20} color="#0ea5e9" />, label: 'Active candidates', val: val(kpis?.active_candidates),
      sub: 'Still being considered', bg: '#f0f9ff',
      go: () => setPage?.('Candidates', { tab: 'all', status: 'active', ...deptParam }) },
    // "Interviews today" and "Offers awaiting answer" are today's work queue:
    // they live on My Work only (removed here 2026-11-17 so the two pages don't
    // show the same numbers).
    // Not a link: no list shows "hired in this period", and a tile whose list
    // shows a different number is worse than no link.
    { icon: <UserCheck size={20} color="#22c55e" />, label: `Hired · ${periodLabel}`, val: val(kpis?.hired_in_period),
      sub: avgTth == null ? 'No hires yet to time' : `Avg ${plural(avgTth, 'day')} from application`, bg: '#f0fdf4' },
  ];

  const funnelChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={pipelineCounts} barSize={32} margin={{ bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
        {/* Angled: up to 13 stage names side by side overlapped when flat. */}
        <XAxis dataKey="stage" tickFormatter={s => STAGE_LABELS[s] || s} tick={{ fontSize: 10 }} interval={0}
               angle={-30} textAnchor="end" height={64} />
        <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
        <Tooltip labelFormatter={s => STAGE_LABELS[s] || s} />
        <Bar dataKey="count" name="Candidates" radius={[6, 6, 0, 0]}>
          {pipelineCounts.map((p, i) => <Cell key={i} fill={stageColor(p.stage).color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const sourceChart = (h, inner, outer) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie data={sourceData} cx="50%" cy="50%" innerRadius={inner} outerRadius={outer}
             dataKey="count" nameKey="source" labelLine={false}
             label={({ source, percent }) => `${sourceLabel(source)} ${(percent * 100).toFixed(0)}%`}>
          {sourceData.map((_, i) => <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={(v, n) => [v, sourceLabel(n)]} />
      </PieChart>
    </ResponsiveContainer>
  );

  const empty = (text) => <div style={{ padding: 48, textAlign: 'center', color: 'var(--color-text-muted, #94a3b8)' }}>{text}</div>;
  const couldNotLoad = empty("Couldn't load this. Use Refresh to try again.");

  return (
    <PageShell dock={
      <PageHero
        icon={LayoutDashboard}
        eyebrow="Recruitment"
        title="Recruitment Dashboard"
        subtitle="Open roles, where candidates stand and where they come from"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={loadData} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'rec-spin' : ''} /> Refresh
          </button>
          <button className="plh-cta" onClick={() => setPage?.('RecruitmentWorkQueue')}>
            <ListChecks size={15} /> My Work
          </button>
        </>}
      />
    }>
      <DashboardFilterBar
        filters={filters}
        dimensions={[{
          key: 'department', label: 'Department', allLabel: 'All departments',
          options: departments.map(d => ({ value: d, label: d })),
        }]}
      />

      {failed.length > 0 && !loading && (
        <div role="alert" style={{
          display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px', padding: '10px 14px',
          borderRadius: 10, background: 'var(--color-danger-bg, #fef2f2)', color: 'var(--color-danger, #dc2626)', fontSize: 13,
        }}>
          <AlertTriangle size={16} />
          <span style={{ flex: 1 }}>
            Couldn&apos;t load the {failed.map(f => FEEDS[f]).join(', ')}. What is shown may be incomplete.
          </span>
          <button type="button" className="plh-cta plh-cta--ghost" onClick={loadData}>Try again</button>
        </div>
      )}

      <div className="rec-kpi-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        {tiles.map(k => {
          const body = (<>
            <div className="rec-kpi-icon" style={{ background: k.bg }}>{k.icon}</div>
            <div>
              <div className="rec-kpi-val">{k.val}</div>
              <div className="rec-kpi-label">{k.label}</div>
              <div className="rec-kpi-sub">{k.sub}</div>
            </div>
          </>);
          return k.go
            ? <button key={k.label} type="button" className="rec-kpi-card" onClick={k.go} style={{ textAlign: 'left', cursor: 'pointer' }}>{body}</button>
            : <div key={k.label} className="rec-kpi-card">{body}</div>;
        })}
      </div>

      <div className="rec-tabs">
        {[{ key: 'positions', label: 'Open positions' }, { key: 'analytics', label: 'Stages & sources' }].map(t => (
          <button key={t.key} className={`rec-tab ${tab === t.key ? 'rec-tab-active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'positions' && (
        <div className="rec-card" id="rec-dash-positions">
          <div className="rec-card-head">
            <h2 className="rec-card-title">{showAll ? 'All job openings' : 'Open and on-hold roles'}</h2>
            <span className="rec-card-sub">
              {openRoles.length} open · {plural(seats, 'seat')} to fill
              {(hiddenCount > 0 || showAll) && (
                <> · <button type="button" onClick={() => setShowAll(s => !s)}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary, #6B3FDB)', cursor: 'pointer', fontWeight: 600 }}>
                  {showAll ? 'Hide closed' : `Show ${hiddenCount} closed / other`}
                </button></>
              )}
            </span>
          </div>
          {failed.includes('positions') ? couldNotLoad : (
            <div className="rec-table-scroll">
              <DataTable
                selectable={false}
                emptyText={<>{inDept.length ? 'No open roles right now.' : 'No job openings yet.'} <button onClick={() => setPage?.('Jobs', { tab: 'requisitions' })} style={{ background: 'none', border: 'none', color: 'var(--color-primary, #6B3FDB)', cursor: 'pointer', fontWeight: 600 }}>Go to Jobs →</button></>}
                columns={[
                  { key: 'job_title', label: 'Position', sortable: true, render: (v, p) => (
                    <button type="button" onClick={() => openJob(p)} title="Open this job's pipeline"
                      style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-primary, #6B3FDB)', cursor: 'pointer', fontWeight: 600, textAlign: 'left' }}>
                      {v || p.req_job_title || '—'}
                    </button>
                  ) },
                  { key: 'department', label: 'Department', sortable: true, render: (v, p) => deptOf(p) || '—' },
                  { key: 'location', label: 'Location', render: (v, p) => {
                    const loc = v || p.req_location;
                    return loc ? <span className="rec-loc"><MapPin size={12} />{loc}</span> : '—';
                  } },
                  { key: 'number_of_positions', label: 'Seats', align: 'center', render: (v, p) => `${Number(p.positions_filled) || 0}/${v || 1} filled` },
                  { key: 'applicants_count', label: 'Applicants', align: 'center', render: v => v || 0 },
                  { key: 'status', label: 'Status', sortable: true, render: v => {
                    const st = openingStatus(v);
                    return <span className="rec-stage-chip-sm" style={{ background: st.bg, color: st.color }}>{st.label}</span>;
                  } },
                  { key: 'created_at', label: 'Posted', sortable: true, render: (v, p) => fmtDate(p.posted_date || v) },
                ]}
                rows={shownRows}
              />
            </div>
          )}
        </div>
      )}

      {tab === 'analytics' && (
        <div className="rec-analytics-grid">
          <div className="rec-card">
            <div className="rec-card-head">
              <div>
                <h2 className="rec-card-title" style={{ marginBottom: 0 }}>Candidates by stage</h2>
                <span className="rec-card-sub">Where everyone stands now, including {STAGE_LABELS.future_use || 'Future use'} and {STAGE_LABELS.rejected || 'Rejected'}</span>
              </div>
              {pipelineCounts.length > 0 && (
                <ChartExpandButton title="Candidates by stage" subtitle="Where everyone stands now">{funnelChart(430)}</ChartExpandButton>
              )}
            </div>
            {failed.includes('stages') ? couldNotLoad
              : pipelineCounts.length > 0 ? funnelChart(240) : empty('No candidates yet')}
          </div>
          <div className="rec-card">
            <div className="rec-card-head">
              <div>
                <h2 className="rec-card-title" style={{ marginBottom: 0 }}>Where candidates come from</h2>
                <span className="rec-card-sub">Candidates who came in {periodLabel.toLowerCase()}</span>
              </div>
              {sourceData.length > 0 && (
                <ChartExpandButton title="Sources" subtitle={`Candidates who came in ${periodLabel.toLowerCase()}`}>{sourceChart(430, 110, 165)}</ChartExpandButton>
              )}
            </div>
            {failed.includes('sources') ? couldNotLoad
              : sourceData.length > 0 ? (<>
                {sourceChart(240, 55, 82)}
                {/* Exact counts — slice labels alone are percentages, and one
                    source (100%) is a bare ring with nothing to read. */}
                <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 12 }}>
                  {sourceData.map((s, i) => (
                    <li key={s.source} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: SOURCE_COLORS[i % SOURCE_COLORS.length] }} />
                      {sourceLabel(s.source)} <strong>{s.count}</strong>
                    </li>
                  ))}
                </ul>
              </>) : empty('No candidates in this period')}
          </div>
        </div>
      )}
    </PageShell>
  );
}
