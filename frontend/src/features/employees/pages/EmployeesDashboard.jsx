// PATH: frontend/src/features/employees/pages/EmployeesDashboard.jsx
/**
 * Employees ▸ Dashboard — the page HR opens first thing in the morning.
 *
 * It answers, without a scroll and without a hover: how many people do we
 * have, who is joining, who joined recently, who is on probation, whose
 * documents are expiring, who is leaving, what the hiring/attrition trend is,
 * and which departments hold how many. Every number links to its records.
 *
 * ── Period semantics (read before adding a card) ───────────────────────────
 * Three different time scopes live on this page and each is labelled on the
 * metric itself, because a number whose window you have to guess is worse
 * than no number:
 *
 *   AS OF TODAY   headcount, status, department, gender, skill, tenure, data
 *                 quality. Point-in-time population. The period filter must
 *                 NOT move these — "how many people work here" cannot have a
 *                 different answer because you looked at last quarter.
 *   SELECTED      new hires, exits, attrition, the trend chart. Activity.
 *   NEXT N DAYS   joinees, exits, documents, confirmations, birthdays. A
 *                 rolling forward window that also keeps anything overdue.
 *                 Never period-scoped: a narrow filter must not hide work.
 *
 * The API states which is which in `period_scoped` / `point_in_time`.
 *
 * ── Joinees are not hires ──────────────────────────────────────────────────
 * An upcoming joinee is a candidate with an accepted offer and no employee
 * record. They are deliberately absent from headcount and from New Hires, and
 * they create no employee row — see upcomingJoinees.service.js.
 */
import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Users, UserCheck, UserPlus, Clock, TrendingUp, UserX, RefreshCw,
  AlertCircle, LayoutDashboard, ArrowUpRight, AlertTriangle, CalendarPlus,
  DoorOpen,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, LabelList,
  ComposedChart, Area, Line,
} from 'recharts';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';
import { PageHero, PageShell, DashboardFilterBar } from '@/components/pulse-ui';
import useDashboardFilters from '@/hooks/useDashboardFilters';
// Bucket colours only — the dashboard receives already-bucketed labels from
// the API, and re-deriving them in the browser is how the two drift apart.
import { BUCKET_COLORS, bucketOf } from '../employeeStatus';
import { setEmployeeListFilter } from '../employeeListFilter';
import './EmployeesDashboard.css';

const P     = '#6B3FDB';
const LIGHT = '#f5f3ff';

const PIE_COLORS    = ['#6B3FDB', '#a78bfa', '#c4b5fd', '#ddd6fe', '#ede9fe', '#8b5cf6'];
const GENDER_COLORS = { Male: '#6B3FDB', Female: '#ec4899', Other: '#10b981', 'Not specified': '#d1d5db' };

/** Rolling forward window for the action strip. Not period-scoped. */
const ALERT_WINDOW_DAYS = 30;

/** Departments shown before the rest collapse into an explicit "Others" bar. */
const DEPT_TOP_N = 8;

/** Compact forms of the server's period labels, for the KPI scope line. */
const SHORT_PERIOD = {
  mtd: 'This month', qtd: 'This quarter', ytd: 'Calendar YTD', fytd: 'This FY',
  last7: 'Last 7 days', last30: 'Last 30 days', last90: 'Last 90 days',
  last6m: 'Last 6 months', last12m: 'Last 12 months', all: 'All time',
};

/** Stable empties, so an absent payload does not churn every downstream memo. */
const EMPTY_ARR = Object.freeze([]);
const EMPTY_OBJ = Object.freeze({});

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * A share of the population the chart is drawn from, so "4 (12.1%)" always
 * reconciles with the bar beside it. One decimal, trimmed when it is a round
 * number — "91%" reads better than "91.0%", and "12.1%" carries information
 * that "12%" loses.
 */
function pct(n, total) {
  if (!total) return null;
  const v = Math.round((n / total) * 1000) / 10;
  return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
}

/** "4 (12.1%)" */
function countPct(n, total) {
  const p = pct(n, total);
  return p ? `${n} (${p})` : String(n);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

/**
 * Average tenure in the unit an HR manager actually reasons in. "0.2 yrs" is
 * a number you have to convert in your head before it means anything.
 */
function tenureDisplay(years, months) {
  if (!years && !months) return { main: '—', sub: 'No joining dates recorded' };
  if (months != null && months < 18) {
    return { main: `${months} mo`, sub: years ? `${years} yrs` : null };
  }
  return { main: `${years} yrs`, sub: months ? `${months} mo` : null };
}

const sum = (rows, key = 'count') => (rows || []).reduce((n, r) => n + (Number(r[key]) || 0), 0);

// ─── Small presentational pieces ─────────────────────────────────────────────

/**
 * A KPI tile. `onClick` makes it a real <button>, which is what gives it
 * keyboard focus and a screen-reader role — the affordance is not just the
 * arrow and the hover. `scope` names the window the number covers.
 */
function KPI({ icon: Icon, label, value, sub, scope, color = P, loading, index = 0, onClick, title }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={`empdash-kpi dk-anim ${onClick ? 'empdash-clickable' : 'empdash-static'}`}
      style={{ '--dk-i': index }}
    >
      {onClick && <span className="empdash-go" aria-hidden="true"><ArrowUpRight size={12} /></span>}
      <span className="empdash-kpi-ico" style={{ background: LIGHT }}>
        <Icon size={15} color={color} />
      </span>
      <span className="empdash-kpi-body">
        <span className="empdash-kpi-label">{label}</span>
        {loading
          ? <span className="empdash-skel" style={{ display: 'block', height: 20, width: 48 }} />
          : <span className="empdash-kpi-value">{value}</span>}
        {!loading && sub && <span className="empdash-kpi-sub">{sub}</span>}
        {!loading && scope && <span className="empdash-scope">{scope}</span>}
      </span>
    </Tag>
  );
}

/**
 * The headcount tile: a value that opens everyone, and a composition line whose
 * three segments each open their own slice.
 *
 * ⚠ It is NOT one big <button> like the other tiles. Nesting the three segment
 * buttons inside an outer button is invalid HTML and browsers flatten it — the
 * inner clicks would either not fire or fire both handlers. So the card is a
 * plain container and each target is its own button.
 */
function HeadcountKPI({ total, parts, loading, index = 0, onOpenAll, onOpenPart }) {
  return (
    <div className="empdash-kpi empdash-kpi--headcount dk-anim" style={{ '--dk-i': index }}>
      <span className="empdash-kpi-ico" style={{ background: LIGHT }}>
        <Users size={15} color={P} />
      </span>
      <span className="empdash-kpi-body">
        <span className="empdash-kpi-label">Current Headcount</span>
        {loading ? (
          <span className="empdash-skel" style={{ display: 'block', height: 20, width: 48 }} />
        ) : (
          <button
            type="button" className="empdash-headline" onClick={onOpenAll}
            title="Open all current employees"
          >
            {total}
            <ArrowUpRight size={11} aria-hidden="true" />
          </button>
        )}
        {!loading && (
          <span className="empdash-parts">
            {parts.filter(p => p.count > 0).map((p, i) => (
              <Fragment key={p.status}>
                {/* An explicit separator: at narrow widths the segments wrap
                    and, with only whitespace between them, "31 Active" and
                    "1 Probation" ran together as "31 Active1 Probation". */}
                {i > 0 && <span className="empdash-part-sep" aria-hidden="true">·</span>}
                <button
                  type="button" className="empdash-part"
                  style={{ '--part': BUCKET_COLORS[p.status] || P }}
                  onClick={() => onOpenPart(p.status)}
                  title={`Open ${p.count} ${p.status} employee${p.count === 1 ? '' : 's'}`}
                >
                  <b>{p.count}</b> {p.status}
                </button>
              </Fragment>
            ))}
          </span>
        )}
        {!loading && <span className="empdash-scope">As of today</span>}
      </span>
    </div>
  );
}

/**
 * An action tile: a count, an optional SEPARATE overdue count, and a scope.
 *
 * Overdue is never folded into the main number. "3 expiring" and "2 already
 * expired" are different pieces of work, and the second one is the urgent one
 * — it is also the one a `BETWEEN CURRENT_DATE AND …` window silently drops
 * on the day it starts to matter.
 */
function ActionTile({
  icon, label, count, overdue = 0, overdueLabel = 'overdue', warn = false,
  scope, bg, color, loading, index = 0, onClick, onOverdueClick, title, overdueTitle,
}) {
  // When the badge has a destination of its own the tile cannot be one big
  // <button> — nesting buttons is invalid HTML and browsers flatten it. The
  // main count and the overdue count are different pieces of work, so when
  // they lead to different lists they get different targets.
  const splitTargets = Boolean(onOverdueClick) && overdue > 0;
  const Shell = splitTargets ? 'div' : 'button';
  const Main  = splitTargets ? 'button' : 'span';
  return (
    <Shell
      type={splitTargets ? undefined : 'button'}
      onClick={splitTargets ? undefined : onClick}
      title={splitTargets ? undefined : title}
      className={`empdash-action dk-anim${splitTargets ? '' : ' empdash-clickable'}`}
      style={{ '--dk-i': index }}
    >
      {!splitTargets && <span className="empdash-go" aria-hidden="true"><ArrowUpRight size={12} /></span>}
      <span className="empdash-action-ico" style={{ background: bg, color }}>{icon}</span>
      <span className="empdash-action-body">
        <span className="empdash-action-label">{label}</span>
        {loading ? (
          <span className="empdash-skel" style={{ display: 'block', height: 19, width: 40 }} />
        ) : (
          <span className="empdash-action-counts">
            <Main
              type={splitTargets ? 'button' : undefined}
              onClick={splitTargets ? onClick : undefined}
              title={splitTargets ? title : undefined}
              className={`empdash-action-main${count ? '' : ' is-zero'}${splitTargets ? ' is-target' : ''}`}
            >
              {count}
            </Main>
            {overdue > 0 && (
              splitTargets ? (
                <button
                  type="button" onClick={onOverdueClick} title={overdueTitle || overdueLabel}
                  className={`empdash-overdue-badge is-target${warn ? ' is-warn' : ''}`}
                >
                  <AlertTriangle size={9} aria-hidden="true" />
                  {overdue} {overdueLabel}
                </button>
              ) : (
                <span className={`empdash-overdue-badge${warn ? ' is-warn' : ''}`}>
                  <AlertTriangle size={9} aria-hidden="true" />
                  {overdue} {overdueLabel}
                </span>
              )
            )}
          </span>
        )}
        {!loading && scope && <span className="empdash-action-sub">{scope}</span>}
      </span>
    </Shell>
  );
}

function Card({ title, subtitle, children, span = null, actions, index = 0, onTitleClick, viewAllLabel = 'View all' }) {
  return (
    <div
      className="empdash-card dk-anim"
      style={{ ...(span ? { gridColumn: `span ${span}` } : null), '--dk-i': index }}
    >
      {title && (
        <div className="empdash-card-hd">
          <div className="empdash-card-title">
            <span>{title}</span>
            {subtitle && <span className="empdash-card-sub">{subtitle}</span>}
          </div>
          <div className="empdash-card-actions">
            {onTitleClick && (
              <button type="button" className="empdash-linkbtn" onClick={onTitleClick}>
                {viewAllLabel} <ArrowUpRight size={10} />
              </button>
            )}
            {actions}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

function EmptyChart({ height = 160, message = 'No data available' }) {
  return <div className="empdash-empty" style={{ minHeight: height }}>{message}</div>;
}

function ChartSkeleton({ height = 160 }) {
  return <div className="empdash-skel" style={{ height, background: '#f9fafb' }} />;
}

const ChartTip = ({ active, payload, label, hint, total }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 8, padding: '6px 10px', fontSize: 11, boxShadow: '0 4px 14px rgba(0,0,0,.07)' }}>
      {label && <div style={{ fontWeight: 600, marginBottom: 3, color: '#374151' }}>{label}</div>}
      {payload.filter(p => p.value != null).map((p, i) => (
        <div key={i} style={{ color: p.color || P }}>
          {p.name}: <b>{p.value}</b>{total ? ` (${pct(p.value, total)})` : ''}
        </div>
      ))}
      {hint && <div style={{ color: '#9ca3af', marginTop: 3, fontSize: 10 }}>{hint}</div>}
    </div>
  );
};

function Avatar({ name }) {
  const initials = (name || '?').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return <span className="empdash-avatar">{initials || '?'}</span>;
}

function PersonRow({ name, meta, tag, tagTone, onClick, title }) {
  return (
    <button type="button" className="empdash-emp-row" onClick={onClick} title={title}>
      <Avatar name={name} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="empdash-emp-name" style={{ display: 'block' }}>{name}</span>
        <span className="empdash-emp-meta" style={{ display: 'block' }}>{meta}</span>
      </span>
      {tag && <span className={`empdash-tag${tagTone ? ` is-${tagTone}` : ''}`}>{tag}</span>}
    </button>
  );
}

function SkeletonRows({ n = 4 }) {
  return Array.from({ length: n }).map((_, i) => (
    <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px solid #f5f5f7' }}>
      <div className="empdash-skel" style={{ width: 26, height: 26, borderRadius: 7 }} />
      <div style={{ flex: 1 }}>
        <div className="empdash-skel" style={{ height: 10, width: '58%', marginBottom: 5 }} />
        <div className="empdash-skel" style={{ height: 8, width: '38%' }} />
      </div>
    </div>
  ));
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function EmployeesDashboard({ setPage, setSelectedEmployee }) {
  const [analytics,     setAnalytics]     = useState(null);
  const [recentHires,   setRecentHires]   = useState(EMPTY_ARR);
  const [birthdays,     setBirthdays]     = useState(EMPTY_ARR);
  const [anniversaries, setAnniversaries] = useState(EMPTY_ARR);
  const [confirmations, setConfirmations] = useState(EMPTY_ARR);
  const [expiringDocs,  setExpiringDocs]  = useState(EMPTY_ARR);
  const [upcomingExits, setUpcomingExits] = useState(EMPTY_ARR);
  const [joinees,       setJoinees]       = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [listLoading,   setListLoading]   = useState(true);
  const [error,         setError]         = useState(null);
  const [lastRefresh,   setLastRefresh]   = useState(null);
  const [showAllDepts,  setShowAllDepts]  = useState(false);
  // The Documents tile opens HR's register, which is gated on
  // employee_documents (§207). This dashboard is gated on employees:view,
  // which managers also hold, so the tile is drawn for grant holders only.
  const { hasPermission } = useAuth();
  const canOpenDocs = hasPermission('employee_documents', 'view');

  const filters = useDashboardFilters({
    defaultPeriod: 'fytd',
    dimensions: { department: 'all' },
    storageKey: 'employees-dashboard',
  });
  const { params } = filters;

  const abortRef = useRef(null);

  const load = useCallback(async (queryParams) => {
    // The HR action window is rolling, never period-scoped — but it IS
    // department-scoped, or the action strip would show the whole company
    // beside a headcount filtered to one department, under one heading.
    const deptParam = queryParams?.department && queryParams.department !== 'all'
      ? { department: queryParams.department }
      : {};
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;

    setLoading(true);
    setListLoading(true);
    setError(null);

    try {
      const res = await api.get('/employees/analytics', { params: queryParams, signal });
      if (signal.aborted) return;
      setAnalytics(res.data || null);
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED' || signal.aborted) return;
      setError(err.response?.data?.error || err.message || 'Failed to load analytics');
    } finally {
      if (!signal.aborted) setLoading(false);
    }

    if (signal.aborted) return;

    const [hiresRes, bdRes, annRes, confRes, expRes, exitRes, joinRes] =
      await Promise.allSettled([
        api.get('/employees', { params: { status: 'all' }, signal }),
        api.get('/hr-widgets/upcoming-birthdays',     { params: { days: ALERT_WINDOW_DAYS, ...deptParam }, signal }),
        api.get('/hr-widgets/upcoming-anniversaries', { params: { days: ALERT_WINDOW_DAYS, ...deptParam }, signal }),
        api.get('/hr-widgets/pending-confirmations',  { params: { days: ALERT_WINDOW_DAYS, ...deptParam }, signal }),
        api.get('/hr-widgets/expiring-documents',     { params: { days: ALERT_WINDOW_DAYS, ...deptParam }, signal }),
        api.get('/hr-widgets/upcoming-exits',         { params: { days: ALERT_WINDOW_DAYS, ...deptParam }, signal }),
        api.get('/hr-widgets/upcoming-joinees',       { params: { days: ALERT_WINDOW_DAYS, ...deptParam }, signal }),
      ]);

    if (signal.aborted) return;

    const arr = (r) => (r.status === 'fulfilled' && Array.isArray(r.value.data) ? r.value.data : EMPTY_ARR);

    // The five most recent joiners, however far back that reaches. The old
    // version hardcoded 30 days and rendered "no new hires" on a page whose
    // New Hires KPI read 27.
    const all = arr(hiresRes);
    setRecentHires(
      all.filter(e => e.joining_date)
        .sort((a, b) => String(b.joining_date).localeCompare(String(a.joining_date)))
        .slice(0, 4),
    );

    setBirthdays(arr(bdRes));
    setAnniversaries(arr(annRes));
    setConfirmations(arr(confRes));
    setExpiringDocs(arr(expRes));
    setUpcomingExits(arr(exitRes));
    setJoinees(joinRes.status === 'fulfilled' ? joinRes.value.data : null);

    if (!signal.aborted) {
      setListLoading(false);
      setLastRefresh(new Date());
    }
  }, []);

  useEffect(() => {
    load(params);
    return () => abortRef.current?.abort();
  }, [params, load]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const s          = analytics?.summary         ?? EMPTY_OBJ;
  const period     = analytics?.period          ?? EMPTY_OBJ;
  const deptData   = analytics?.deptBreakdown   ?? EMPTY_ARR;
  const genderData = analytics?.genderBreakdown ?? EMPTY_ARR;
  const skillData  = analytics?.skillBreakdown  ?? EMPTY_ARR;
  const tenureData = analytics?.tenureGroups    ?? EMPTY_ARR;
  const statusData = analytics?.statusBreakdown ?? EMPTY_ARR;
  const trendData  = analytics?.hiringTrend     ?? EMPTY_ARR;
  const dq         = analytics?.dataQuality     ?? EMPTY_OBJ;

  const periodLabel = period.label || 'this period';
  /**
   * The same window, short enough for a 180px KPI tile. The server's
   * `period.label` is written for prose ("This financial year") and truncated
   * to "THIS FINANCIAL YE…" in the tile's scope line, which reads as a broken
   * string rather than a time scope. Cards and captions keep the long form.
   */
  const shortPeriod = SHORT_PERIOD[period.key] || (period.key === 'custom'
    ? `${formatDate(period.from)}–${formatDate(period.to)}`
    : periodLabel);
  const total       = s.total ?? 0;
  const joineeSum   = joinees?.summary ?? EMPTY_OBJ;

  const hasTrend = trendData.length > 0 && trendData.some(m => m.hires || m.exits);
  const tenureKpi = tenureDisplay(s.avgTenure, s.avgTenureMonths);
  const netChange = (s.newHires ?? 0) - (s.exits ?? 0);

  /**
   * Totals for the trend summary, taken from the SERIES the chart plots.
   *
   * Deriving them from the same array the chart renders is what makes the
   * caption incapable of disagreeing with the picture above it — and the
   * series itself is period-scoped and department-scoped by the API, so these
   * track the New Hires KPI and the Workforce Movement ledger automatically.
   */
  const trendHires = sum(trendData, 'hires');
  const trendExits = sum(trendData, 'exits');
  const trendNet   = trendHires - trendExits;

  /** Split counts for the action tiles. */
  const docsExpired     = expiringDocs.filter(d => d.expiry_state === 'expired').length;
  const docsExpiring    = expiringDocs.length - docsExpired;
  const exitsOverdue    = upcomingExits.filter(e => e.exit_state === 'overdue').length;
  /**
   * Overdue exits belonging to the NOTICE cohort specifically.
   *
   * ⚠ Not `exitsOverdue`. On live data all four overdue exits belong to
   * employees who are still `Active` (three of them) or already `resigned` —
   * none is the one person on Notice. Putting the global figure on the Notice
   * tile read "1 … 4 past last working day", which is not only wrong but
   * arithmetically impossible.
   */
  const noticeOverdue   = upcomingExits.filter(
    e => e.exit_state === 'overdue' && bucketOf(e.employee_status) === 'Notice',
  ).length;
  const exitsUpcoming   = upcomingExits.length - exitsOverdue;
  const confOverdue     = confirmations.filter(c => c.confirmation_state === 'overdue').length;
  const confUndated     = confirmations.filter(c => c.confirmation_state === 'undated').length;
  const confDue         = confirmations.length - confOverdue - confUndated;
  // The exact rows each number counted, so a click opens that population and
  // nothing else. The tile used to count "due in the next 30 days" and open
  // EVERY probationer; its overdue badge did the same when overdue and
  // undated were both present. Department-filtered counts stay filtered too.
  const confDueIds       = confirmations.filter(c => c.confirmation_state === 'due').map(c => c.id);
  const confAttentionIds = confirmations.filter(c => c.confirmation_state !== 'due').map(c => c.id);

  /**
   * Departments, with the tail collapsed into an explicit "Others" bar.
   * Never silently dropped — the old query's `LIMIT 12` against 14 live
   * departments is exactly the failure this replaces. Others carries its own
   * count, and the toggle shows every row.
   */
  const deptChartData = useMemo(() => {
    if (showAllDepts || deptData.length <= DEPT_TOP_N + 1) return deptData;
    const head = deptData.slice(0, DEPT_TOP_N);
    const tail = deptData.slice(DEPT_TOP_N);
    return [...head, {
      department: `Others (${tail.length})`,
      count:     sum(tail),
      active:    sum(tail, 'active'),
      probation: sum(tail, 'probation'),
      notice:    sum(tail, 'notice'),
      other:     sum(tail, 'other'),
      isOthers:  true,
    }];
  }, [deptData, showAllDepts]);

  /** department → "5 · 15%" for the chart's right-hand value axis. */
  const deptTotals = useMemo(
    () => Object.fromEntries(deptChartData.map(d => [d.department, `${d.count} · ${pct(d.count, total) ?? ''}`])),
    [deptChartData, total],
  );

  // Department options come from the UNFILTERED breakdown, so picking one does
  // not collapse the dropdown to the value already selected.
  const activeDept = filters.dimensions.department;
  /**
   * The department filter narrows EVERY number on this page, and it persists
   * in sessionStorage — so the page can come back scoped from a previous
   * visit. Without saying so, "Hiring vs Attrition · This financial year"
   * describes one department while looking exactly like the whole company:
   * Procurement, for instance, reads "2 hires" against a company total of 27.
   */
  const activeDeptLabel = activeDept && activeDept !== 'all' ? activeDept : null;
  const [deptOptionSource, setDeptOptionSource] = useState(EMPTY_ARR);
  useEffect(() => {
    if ((!activeDept || activeDept === 'all') && deptData.length) {
      setDeptOptionSource(deptData.map(d => d.department));
    }
  }, [activeDept, deptData]);
  const deptOptions = useMemo(
    () => deptOptionSource.map(d => ({ value: d, label: d })),
    [deptOptionSource],
  );

  // ── Navigation ─────────────────────────────────────────────────────────────

  const goEmployees = useCallback((filter) => {
    setEmployeeListFilter({ origin: 'EmployeesDashboard', ...filter });
    setPage?.('EmployeesData');
  }, [setPage]);

  const openEmployee = useCallback((emp) => {
    if (!emp?.id) return;
    try {
      sessionStorage.setItem('selectedEmployeeId', String(emp.id));
      sessionStorage.setItem('selectedEmployee', JSON.stringify(emp));
    } catch { /* private mode — the profile page falls back to its own fetch */ }
    setSelectedEmployee?.(emp);
    setPage?.('EmployeeProfile', { id: emp.id });
  }, [setPage, setSelectedEmployee]);

  /** New hires drill-down: the same window the KPI counted. */
  const goNewHires = useCallback(() => goEmployees({
    joinedFrom: period.from,
    joinedTo:   period.to,
    label:      `Joined ${periodLabel}${period.from ? ` (${formatDate(period.from)} – ${formatDate(period.to)})` : ''}`,
  }), [goEmployees, period.from, period.to, periodLabel]);

  const goExits   = useCallback(() => setPage?.('ExEmployees'), [setPage]);

  /**
   * Notice-period staff. They are still on the payroll, so this is the
   * employee register filtered to Notice — not the ex-employee list. The list
   * page turns this filter into its notice columns (last working day, days
   * remaining, exit-request status), which only matter for this cohort.
   */
  const goNotice = useCallback(() => goEmployees({
    status: 'Notice',
    label: 'Employment status: Notice period',
  }), [goEmployees]);

  /** Document register, pre-filtered to whichever bucket has the work in it. */
  const openDocs = useCallback((which) => {
    setEmployeeListFilter({
      origin: 'EmployeesDashboard',
      expiry: which,
      label: which === 'expired'
        ? 'Documents that have already expired'
        : `Documents expiring or expired within ${ALERT_WINDOW_DAYS} days`,
    });
    setPage?.('EmployeeDocuments');
  }, [setPage]);
  // Joinees are candidates with an accepted offer, so their records live in
  // recruitment — NOT in the employee register, which is the whole point.
  //
  // OnboardingCenter, not OfferManagement: the hub is the row the sidebar
  // actually offers (Offers · Checklist · Employee creation) and it opens on
  // the offers tab, so the user lands somewhere they recognise. Both carry
  // module 'recruitment'; hr, hr_manager and hr_exec all hold recruitment:view,
  // so the HR audience for this page can open it. ⚠ payroll_admin cannot —
  // they see the count but the drill-through will 403 to Unauthorized.
  const goJoinees = useCallback(() => setPage?.('OnboardingCenter'), [setPage]);

  // ── Charts ─────────────────────────────────────────────────────────────────
  // Every chart prints its counts AND its share of the same population the
  // chart is drawn from, so the percentages always reconcile with the bars.

  const genderChart = (h, r) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie
          data={genderData} dataKey="count" nameKey="gender"
          cx="50%" cy="50%" outerRadius={r} labelLine={false} fontSize={10}
          label={({ value }) => countPct(value, sum(genderData))}
          onClick={(d) => d?.gender && goEmployees({ gender: d.gender, label: `Gender: ${d.gender}` })}
        >
          {genderData.map((entry, i) => (
            <Cell key={entry.gender} fill={GENDER_COLORS[entry.gender] || PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip content={<ChartTip hint="Click to open these employees" total={sum(genderData)} />} />
        <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
      </PieChart>
    </ResponsiveContainer>
  );

  const skillChart = (h, r) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie
          data={skillData} dataKey="count" nameKey="skill"
          cx="50%" cy="50%" outerRadius={r} labelLine={false} fontSize={10}
          label={({ value }) => countPct(value, sum(skillData))}
          onClick={(d) => d?.skill && goEmployees({ skill: d.skill, label: `Skill type: ${d.skill}` })}
        >
          {skillData.map((entry, i) => <Cell key={entry.skill} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
        </Pie>
        <Tooltip content={<ChartTip hint="Click to open these employees" total={sum(skillData)} />} />
        <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
      </PieChart>
    </ResponsiveContainer>
  );

  const tenureChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={tenureData} margin={{ top: 15, right: 10, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0eeff" vertical={false} />
        <XAxis dataKey="bucket" tick={{ fontSize: 9.5 }} interval={0} />
        <YAxis tick={{ fontSize: 9.5 }} allowDecimals={false} />
        <Tooltip content={<ChartTip hint="Click a bar to open these employees" total={total} />} cursor={{ fill: '#faf8ff' }} />
        <Bar
          dataKey="count" name="Employees" radius={[4, 4, 0, 0]}
          onClick={(d) => d?.bucket && goEmployees({ tenure: d.bucket, label: `Tenure: ${d.bucket}` })}
        >
          {tenureData.map((entry, i) => <Cell key={entry.bucket} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
          <LabelList
            dataKey="count" position="top" fontSize={9.5} fill="#4b5563"
            formatter={(v) => (v > 0 ? `${v}·${pct(v, total)}` : '')}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  /**
   * Department headcount: one stacked bar per department whose segments are
   * mutually exclusive and sum to that department's headcount.
   *
   * ⚠ The count sits in a right-hand category axis, NOT a <LabelList>.
   * recharts emits a rect only for NON-ZERO values, so whichever stacked
   * series carried the label was missing from every department with none of
   * that status — with live data the last series was zero everywhere and the
   * chart rendered no totals at all. An axis emits a tick per category
   * unconditionally.
   */
  const deptChart = (h, data = deptChartData) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 4, left: 2, bottom: 0 }} barCategoryGap="18%">
        <CartesianGrid strokeDasharray="3 3" stroke="#f0eeff" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 9.5 }} allowDecimals={false} />
        <YAxis yAxisId="dept" type="category" dataKey="department" tick={{ fontSize: 9.5 }} width={74} interval={0} />
        <YAxis
          yAxisId="total" type="category" dataKey="department" orientation="right"
          tickLine={false} axisLine={false} width={56} interval={0}
          tick={{ fontSize: 9.5, fill: '#4b5563', fontWeight: 600 }}
          tickFormatter={(d) => deptTotals[d] ?? ''}
        />
        <Tooltip content={<ChartTip hint="Click to open this department" total={total} />} cursor={{ fill: '#faf8ff' }} />
        <Legend iconSize={8} wrapperStyle={{ fontSize: 9.5 }} />
        {[
          ['active',    'Active'],
          ['probation', 'Probation'],
          ['notice',    'Notice'],
          ['other',     'Other'],
        ].map(([key, name], i, arr) => (
          <Bar
            key={key} yAxisId="dept" dataKey={key} name={name} stackId="hc"
            fill={BUCKET_COLORS[name]}
            radius={i === arr.length - 1 ? [0, 3, 3, 0] : 0}
            onClick={(d) => {
              // "Others" is an aggregate of several departments, so there is
              // no single department to open — expand instead of navigating
              // somewhere that would not match what was clicked.
              if (d?.isOthers) { setShowAllDepts(true); return; }
              if (d?.department) goEmployees({ department: d.department, label: `Department: ${d.department}` });
            }}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );

  const statusChart = (h, inner, outer) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie
          data={statusData} dataKey="count" nameKey="status"
          cx="50%" cy="50%" innerRadius={inner} outerRadius={outer} paddingAngle={3}
          label={({ value }) => countPct(value, total)} labelLine={false} fontSize={10}
          onClick={(d) => d?.status && goEmployees({ status: d.status, label: `Status: ${d.status}` })}
        >
          {statusData.map(entry => (
            <Cell key={entry.status} fill={BUCKET_COLORS[entry.status] || P} />
          ))}
        </Pie>
        <Tooltip content={<ChartTip hint="Click to open these employees" total={total} />} />
        {/* The status NAME lives in the legend, not on the slice. Spelling
            "Active 31 (93.9%)" onto a slice inside a span-3 card clipped it
            to "tive 31 (93.9%)" at the card edge. */}
        <Legend iconSize={8} wrapperStyle={{ fontSize: 9.5 }} />
        <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 19, fontWeight: 700, fill: '#111827' }}>
          {total}
        </text>
        <text x="50%" y="57%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 8.5, fill: '#9ca3af' }}>
          as of today
        </text>
      </PieChart>
    </ResponsiveContainer>
  );

  /**
   * Hiring vs attrition. The month axis comes from the SELECTED PERIOD, not
   * from the months that happen to contain a hire — nothing here hardcodes a
   * month, and the series arrives with a zero row for every empty month.
   */
  const trendChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <ComposedChart data={trendData} margin={{ top: 16, right: 24, left: -26, bottom: 0 }}>
        <defs>
          <linearGradient id="empdashHires" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={P} stopOpacity={0.20} />
            <stop offset="95%" stopColor={P} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0eeff" vertical={false} />
        <XAxis
          dataKey="month" tick={{ fontSize: 9.5 }}
          interval={trendData.length > 18 ? 'preserveStartEnd' : 0}
          angle={trendData.length > 10 ? -35 : 0}
          textAnchor={trendData.length > 10 ? 'end' : 'middle'}
          height={trendData.length > 10 ? 38 : 18}
        />
        <YAxis tick={{ fontSize: 9.5 }} allowDecimals={false} />
        <Tooltip content={<ChartTip hint="Hires and exits completed in that month" />} cursor={{ fill: '#faf8ff' }} />
        <Legend iconSize={8} wrapperStyle={{ fontSize: 9.5 }} />
        {/* linear, not monotone: these are discrete monthly counts, and a
            spline through 0, 0, 1, 24, 2, 0 draws a bell curve implying
            hiring ramped through the two empty months before it. */}
        <Area
          type="linear" dataKey="hires" name="New hires"
          stroke={P} strokeWidth={2} fill="url(#empdashHires)"
          dot={{ r: 2 }} activeDot={{ r: 4 }}
        >
          <LabelList dataKey="hires" position="top" fontSize={9.5} fill={P}
            formatter={(v) => (v > 0 ? v : '')} />
        </Area>
        <Line
          type="linear" dataKey="exits" name="Exits"
          stroke="#dc2626" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }}
        >
          <LabelList dataKey="exits" position="bottom" fontSize={9.5} fill="#dc2626"
            formatter={(v) => (v > 0 ? v : '')} />
        </Line>
      </ComposedChart>
    </ResponsiveContainer>
  );

  const deptChartHeight = showAllDepts
    ? Math.max(180, Math.min(deptChartData.length * 21 + 34, 460))
    : 212;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <PageShell dock={<PageHero icon={LayoutDashboard} eyebrow="Employees" title="Employee Overview" />}>
      <div className="empdash-page">

        <DashboardFilterBar
          filters={filters}
          periodLabel="Period"
          dimensions={[{ key: 'department', label: 'Department', options: deptOptions, allLabel: 'All Departments', width: 140 }]}
          actions={(
            <button type="button" className="empdash-linkbtn" onClick={() => load(params)} disabled={loading}>
              <RefreshCw size={12} style={{ animation: loading ? 'empdash-spin 1s linear infinite' : 'none' }} />
              Refresh
            </button>
          )}
        />

        <p className="empdash-caption">
          Headcount and workforce composition are <strong>as of today</strong>; hiring, exits and
          attrition cover <strong>{periodLabel}</strong>
          {period.from ? ` (${formatDate(period.from)} – ${formatDate(period.to)})` : ''};
          HR actions look <strong>{ALERT_WINDOW_DAYS} days ahead</strong> and keep anything overdue.
          {lastRefresh && ` · Updated ${lastRefresh.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`}
          {activeDeptLabel && (
            <span className="empdash-scopechip">
              Every figure filtered to <strong>{activeDeptLabel}</strong>
            </span>
          )}
        </p>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 9, padding: '8px 12px', marginBottom: 9, display: 'flex', gap: 8, alignItems: 'center', color: '#dc2626', fontSize: 12 }}>
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {/* ── KPI band ──
            Seven compact tiles, no large cards. Avg. Tenure is deliberately
            NOT here: it is an analytical number, not something HR acts on
            this morning, so it lives on the Tenure chart it describes. */}
        <div className="empdash-kpis">
          <HeadcountKPI
            index={0} total={total} loading={loading}
            parts={[
              { status: 'Active',    count: s.active ?? 0 },
              { status: 'Probation', count: s.probation ?? 0 },
              { status: 'Notice',    count: s.notice ?? 0 },
              { status: 'Other',     count: s.other ?? 0 },
            ]}
            onOpenAll={() => goEmployees({ status: 'All', label: 'All current employees' })}
            onOpenPart={(status) => (status === 'Notice' ? goNotice() : goEmployees({ status, label: `Status: ${status}` }))}
          />
          <KPI
            index={1} icon={UserCheck} label="Active" value={s.active ?? '—'}
            sub={total > 0 ? `${pct(s.active, total)} of headcount` : 'Confirmed'}
            scope="As of today" loading={loading} color={BUCKET_COLORS.Active}
            onClick={() => goEmployees({ status: 'Active', label: 'Status: Active' })}
            title="Open active employees"
          />
          <KPI
            index={2} icon={Clock} label="On Probation" value={s.probation ?? '—'}
            sub={confUndated || confOverdue
              ? `${confUndated + confOverdue} need attention`
              : (total > 0 ? `${pct(s.probation, total)} of headcount` : 'Pending confirmation')}
            scope="As of today" loading={loading} color={BUCKET_COLORS.Probation}
            onClick={() => goEmployees({ status: 'Probation', label: 'Status: Probation' })}
            title="Open employees on probation"
          />
          {/* Notice period had no action of its own: it was a word inside the
              headcount subtitle. It is a distinct HR workflow — these people
              are still on the payroll but have a last working day. */}
          <KPI
            index={3} icon={DoorOpen} label="Notice Period" value={s.notice ?? 0}
            sub={noticeOverdue ? `${noticeOverdue} past last working day` : 'Serving notice'}
            scope="As of today" loading={loading} color={BUCKET_COLORS.Notice}
            onClick={goNotice}
            title="Open employees serving notice"
          />
          <KPI
            index={4} icon={CalendarPlus} label="Upcoming Joinees"
            value={joineeSum.total ?? 0}
            sub={
              joineeSum.next7
                ? `${joineeSum.next7} within 7 days`
                : joineeSum.pendingAcceptance
                  ? `${joineeSum.pendingAcceptance} pending acceptance`
                  : 'Accepted offers only'
            }
            scope={`Next ${ALERT_WINDOW_DAYS} days`} loading={listLoading} color="#0891b2"
            onClick={goJoinees}
            title="Open offers and onboarding"
          />
          <KPI
            index={5} icon={UserPlus} label="New Hires" value={s.newHires ?? '—'}
            sub={total > 0 ? `${pct(s.newHires, total)} of headcount` : undefined}
            scope={shortPeriod} loading={loading} color="#3b82f6"
            onClick={goNewHires}
            title={`Open employees who joined ${periodLabel}`}
          />
          <KPI
            index={6} icon={UserX} label="Attrition Rate"
            value={s.attritionRate != null ? `${s.attritionRate}%` : '—'}
            sub={`${s.exits ?? 0} exit${s.exits === 1 ? '' : 's'} · avg HC ${s.avgHeadcount ?? 0}`}
            scope={shortPeriod} loading={loading} color="#dc2626"
            onClick={goExits}
            title="Open ex-employees"
          />
        </div>

        {/* ── HR actions ──
            One area, not six free-floating boxes. Every row is an exception
            worth a click, the overdue count is always its own badge, and the
            two event counters sit at the end where an empty one costs a line
            rather than a panel. */}
        <div className="empdash-actionbar">
          <span className="empdash-actionbar-hd">
            <AlertTriangle size={11} aria-hidden="true" />
            Needs attention
            <span className="empdash-actionbar-scope">next {ALERT_WINDOW_DAYS} days · overdue always shown</span>
          </span>
          <div className="empdash-actions">
            {canOpenDocs && (
              <ActionTile
                index={7} icon="📄" label="Documents" bg="#fef2f2" color="#dc2626"
                count={docsExpiring} overdue={docsExpired} overdueLabel="expired"
                scope="Expiring" loading={listLoading}
                onClick={() => openDocs('expiring')}
                title="Open documents expiring soon"
                onOverdueClick={() => openDocs('expired')}
                overdueTitle="Open documents that have already expired"
              />
            )}
            <ActionTile
              index={8} icon="🚪" label="Exits" bg="#fffbeb" color="#b45309"
              count={exitsUpcoming} overdue={exitsOverdue} overdueLabel="overdue"
              scope="Upcoming" loading={listLoading}
              onClick={() => setPage?.('ExitManagement')}
              title="Open exit management"
            />
            <ActionTile
              index={9} icon="⏳" label="Confirmations" bg="#f5f3ff" color="#6d28d9"
              count={confDue} overdue={confOverdue + confUndated}
              overdueLabel={confOverdue && confUndated ? 'overdue / no date' : confUndated && !confOverdue ? 'no date set' : 'overdue'}
              // A deliberately BROADER overview than the probation reminder:
              // ALERT_WINDOW_DAYS (30) is the window every "next N days" tile
              // on this page shares. The reminder job and the home alert use
              // the company's probation_review_reminder_days (default 14) —
              // see backend shared/probationDates.js. Same stored end date and
              // the same calendar-day rule (today counts as due); only the
              // horizon differs, and the label says which.
              scope={`Next ${ALERT_WINDOW_DAYS} days`} loading={listLoading}
              onClick={() => goEmployees({
                ids: confDueIds,
                label: `Probation ends today or in the next ${ALERT_WINDOW_DAYS} days`,
              })}
              title={`Open the probations ending today or in the next ${ALERT_WINDOW_DAYS} days`}
              // The actionable subset, not the whole cohort: overdue, plus any
              // probation with no end date (which never raises a reminder).
              onOverdueClick={() => goEmployees({
                ids: confAttentionIds,
                label: confUndated && !confOverdue
                  ? 'On probation with no end date set'
                  : confOverdue && !confUndated
                    ? 'Probation ended — confirmation overdue'
                    : 'Probation overdue or with no end date set',
              })}
              overdueTitle="Open the probations that need attention"
            />
            <ActionTile
              index={10} icon="🧩" label="Data Quality" bg="#f1f5f9" color="#475569"
              count={dq.critical ?? 0} overdue={dq.incomplete ?? 0} overdueLabel="incomplete" warn
              scope="Records" loading={loading}
              onClick={() => goEmployees({
                missing: 'critical',
                label: 'Missing joining date, probation end date or bank details',
              })}
              title="Open records whose gaps block a workflow"
              onOverdueClick={() => goEmployees({
                missing: 'any',
                label: 'Records with incomplete master data',
              })}
              overdueTitle="Open records with incomplete master data"
            />
            <ActionTile
              index={11} icon="🎂" label="Birthdays" bg="#fdf2f8" color="#ec4899"
              count={birthdays.length} scope="Events" loading={listLoading}
              // The ids, not just a label: "whose birthday falls in the
              // window" is not a predicate the list page can express, and a
              // label alone would open all 33 employees under a chip
              // promising a handful of birthdays.
              onClick={() => goEmployees({
                ids: birthdays.map(b => b.id),
                label: `Birthdays in the next ${ALERT_WINDOW_DAYS} days`,
              })}
              title="Open these employees"
            />
            <ActionTile
              index={12} icon="🎉" label="Anniversaries" bg={LIGHT} color={P}
              count={anniversaries.length} scope="Events" loading={listLoading}
              onClick={() => goEmployees({
                ids: anniversaries.map(a => a.id),
                label: `Work anniversaries in the next ${ALERT_WINDOW_DAYS} days`,
              })}
              title="Open these employees"
            />
          </div>
        </div>

        {/* ── Movement + trend ── */}
        <div className="empdash-row">
          <Card
            index={13} span={4}
            title="Workforce Movement"
            subtitle={activeDeptLabel ? `${periodLabel} · ${activeDeptLabel}` : periodLabel}
          >
            {loading ? <ChartSkeleton height={96} /> : (
              <>
                <div className="empdash-movement">
                  <span className="empdash-mv">
                    <span className="empdash-mv-label">Opening</span>
                    <span className="empdash-mv-value" style={{ color: '#374151' }}>{s.headcountStart ?? 0}</span>
                    <span className="empdash-mv-note">{formatDate(period.from)}</span>
                  </span>
                  <span className="empdash-mv-op" aria-hidden="true">+</span>
                  <button type="button" className="empdash-mv is-link" onClick={goNewHires} title="Open these joiners">
                    <span className="empdash-mv-label">Hires</span>
                    <span className="empdash-mv-value" style={{ color: '#16a34a' }}>{s.newHires ?? 0}</span>
                    <span className="empdash-mv-note">joined</span>
                  </button>
                  <span className="empdash-mv-op" aria-hidden="true">−</span>
                  <button type="button" className="empdash-mv is-link" onClick={goExits} title="Open ex-employees">
                    <span className="empdash-mv-label">Exits</span>
                    <span className="empdash-mv-value" style={{ color: '#dc2626' }}>{s.exits ?? 0}</span>
                    <span className="empdash-mv-note">left</span>
                  </button>
                  <span className="empdash-mv-op" aria-hidden="true">=</span>
                  <span className="empdash-mv" style={{ background: '#f5f3ff', borderColor: '#ddd4fb' }}>
                    <span className="empdash-mv-label">Closing</span>
                    <span className="empdash-mv-value" style={{ color: P }}>{s.headcountEnd ?? 0}</span>
                    <span className="empdash-mv-note">{formatDate(period.to)}</span>
                  </span>
                </div>
                {/* A second band, deliberately BELOW the ledger rule: these
                    are derived or forward-looking figures, and a joinee has
                    not started, so folding them into closing headcount would
                    report people who are not on the payroll. */}
                <div className="empdash-movement" style={{ marginTop: 5 }}>
                  <span className="empdash-mv">
                    <span className="empdash-mv-label">Net change</span>
                    <span className="empdash-mv-value" style={{ color: netChange >= 0 ? '#16a34a' : '#dc2626' }}>
                      {netChange >= 0 ? '+' : ''}{netChange}
                    </span>
                    {/* shortPeriod, not periodLabel: this cell is ~100px and
                        "This financial year" overflows it by a hair. */}
                    <span className="empdash-mv-note">{shortPeriod}</span>
                  </span>
                  <span className="empdash-mv">
                    <span className="empdash-mv-label">Attrition</span>
                    <span className="empdash-mv-value" style={{ color: '#dc2626' }}>{s.attritionRate ?? 0}%</span>
                    <span className="empdash-mv-note">of avg {s.avgHeadcount ?? 0}</span>
                  </span>
                  <button type="button" className="empdash-mv is-link" onClick={goJoinees} title="Open offers and onboarding">
                    <span className="empdash-mv-label">Joining</span>
                    <span className="empdash-mv-value" style={{ color: '#0891b2' }}>{joineeSum.total ?? 0}</span>
                    <span className="empdash-mv-note">not yet staff</span>
                  </button>
                </div>
                <div className="empdash-mv-foot">
                  <span>
                    Opening and closing are headcount on those two dates; hires and exits are
                    what happened between them.
                  </span>
                </div>
                {(s.headcountStart ?? 0) + (s.newHires ?? 0) - (s.exits ?? 0) !== (s.headcountEnd ?? 0) && (
                  <div className="empdash-hint">
                    Opening + hires − exits does not equal closing: some records have no joining
                    or exit date recorded. See Needs Attention.
                  </div>
                )}
              </>
            )}
          </Card>

          <Card
            index={14} span={8}
            title="Hiring vs Attrition"
            subtitle={activeDeptLabel ? `${periodLabel} · ${activeDeptLabel}` : periodLabel}
            actions={!loading && hasTrend && (
              <ChartExpandButton title={`Hiring vs Attrition — ${periodLabel}`}>{trendChart(420)}</ChartExpandButton>
            )}
          >
            {loading ? <ChartSkeleton height={150} />
              : trendData.length === 0 ? <EmptyChart height={150} message="No months in the selected period" />
                : (
                  <>
                    {trendChart(150)}
                    <div className="empdash-hint">
                      {/* Summed over the WHOLE period series the chart is
                          drawn from — never the last point, the visible
                          points, or the non-zero ones. `trendHires` and
                          `trendExits` are the same figures the New Hires KPI
                          and the Workforce Movement ledger use, and a
                          regression test asserts all three agree. */}
                      <strong>{trendHires}</strong> hire{trendHires === 1 ? '' : 's'}
                      {' · '}<strong>{trendExits}</strong> exit{trendExits === 1 ? '' : 's'}
                      {' · net '}<strong>{trendNet >= 0 ? '+' : ''}{trendNet}</strong>
                      {' across '}{trendData.length} month{trendData.length === 1 ? '' : 's'}
                      {activeDeptLabel && ` in ${activeDeptLabel}`}
                      {!hasTrend && ' — no hiring or exits recorded in this window'}
                      {period.trendTruncated && ` — chart shows the most recent ${trendData.length} months; the KPIs cover all of ${periodLabel}`}
                    </div>
                  </>
                )}
          </Card>
        </div>

        {/* ── Composition ── */}
        <div className="empdash-row">
          <Card
            index={15} span={5}
            title="Department Headcount"
            subtitle={`${deptData.length} depts · ${sum(deptData)} people`}
            onTitleClick={deptData.length > DEPT_TOP_N + 1 ? () => setShowAllDepts(v => !v) : undefined}
            viewAllLabel={showAllDepts ? 'Show top 8' : `Show all ${deptData.length}`}
            actions={!loading && deptData.length > 0 && (
              <ChartExpandButton title="Department Headcount">
                {deptChart(Math.max(430, deptData.length * 26), deptData)}
              </ChartExpandButton>
            )}
          >
            {loading ? <ChartSkeleton height={212} />
              : deptData.length === 0 ? <EmptyChart height={212} />
                : deptChart(deptChartHeight)}
          </Card>

          <Card
            index={16} span={3}
            title="Employment Status" subtitle="as of today"
            onTitleClick={() => goEmployees({ status: 'All', label: 'All current employees' })}
            actions={!loading && statusData.length > 0 && (
              <ChartExpandButton title="Employment Status">{statusChart(430, 105, 165)}</ChartExpandButton>
            )}
          >
            {loading ? <ChartSkeleton height={212} />
              : statusData.length === 0 ? <EmptyChart height={212} />
                : (
                  <>
                    {statusChart(186, 42, 68)}
                    <div className="empdash-hint">
                      Sums to {sum(statusData)} (100%) — matches Current Headcount.
                      {s.exited ? ` ${s.exited} ex-employee${s.exited === 1 ? '' : 's'} excluded.` : ''}
                    </div>
                  </>
                )}
          </Card>

          <Card
            index={17} span={4}
            title="Tenure Distribution"
            subtitle={tenureKpi.main !== '—' ? `avg ${tenureKpi.main} · as of today` : 'as of today'}
            actions={!loading && tenureData.some(g => g.count > 0) && (
              <ChartExpandButton title="Tenure Distribution">{tenureChart(430)}</ChartExpandButton>
            )}
          >
            {loading ? <ChartSkeleton height={212} />
              : !tenureData.some(g => g.count > 0) ? <EmptyChart height={212} />
                : (
                  <>
                    {tenureChart(186)}
                    <div className="empdash-hint">
                      Sums to {sum(tenureData)} (100%) — matches Current Headcount
                      {s.tenureUnknown ? `, including ${s.tenureUnknown} with no join date` : ''}.
                    </div>
                  </>
                )}
          </Card>
        </div>

        {/* ── Demographics + recent hires ──
            The "Upcoming Joinees" and "On Probation" list cards that used to
            sit here are GONE. Both restated a number the KPI band already
            carries, and the probation card's only unique content — who has no
            probation end date — is an exception, so it belongs in the
            Confirmations action, which now drills straight to it. Summary in
            the KPI row, detail on the destination page, never both. */}
        <div className="empdash-row">
          <Card
            index={18} span={3}
            title="Gender" subtitle={`${sum(genderData)} · 100%`}
            actions={!loading && genderData.length > 0 && (
              <ChartExpandButton title="Gender Distribution">{genderChart(430, 150)}</ChartExpandButton>
            )}
          >
            {loading ? <ChartSkeleton height={152} />
              : genderData.length === 0 ? <EmptyChart height={152} />
                : genderChart(152, 44)}
          </Card>

          <Card
            index={19} span={3}
            title="Skill Type" subtitle={`${sum(skillData)} · 100%`}
            actions={!loading && skillData.length > 0 && (
              <ChartExpandButton title="Skill Type Distribution">{skillChart(430, 150)}</ChartExpandButton>
            )}
          >
            {loading ? <ChartSkeleton height={152} />
              : skillData.length === 0 ? <EmptyChart height={152} />
                : skillChart(152, 40)}
          </Card>

          <Card
            index={20} span={6}
            title="Recent New Hires"
            subtitle={recentHires.length ? `latest ${recentHires.length} · ${shortPeriod} total ${s.newHires ?? 0}` : undefined}
            onTitleClick={goNewHires}
          >
            {listLoading ? <SkeletonRows n={4} />
              : recentHires.length === 0 ? (
                <EmptyChart height={100} message="No employee has a recorded joining date" />
              ) : (
                <div className="empdash-hirelist">
                  {recentHires.map((emp, i) => (
                    <PersonRow
                      key={emp.id || i}
                      name={[emp.first_name, emp.last_name].filter(Boolean).join(' ') || emp.name || '—'}
                      meta={`${emp.department || emp.designation || '—'} · ${formatDate(emp.joining_date)}`}
                      onClick={() => openEmployee(emp)}
                      title="Open employee"
                    />
                  ))}
                </div>
              )}
          </Card>
        </div>

        <style>{'@keyframes empdash-spin { to { transform: rotate(360deg); } }'}</style>
      </div>
    </PageShell>
  );
}
