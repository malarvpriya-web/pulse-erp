// PATH: frontend/src/pages/ExecutiveDashboard.jsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  TrendingUp, TrendingDown, Users, IndianRupee, Briefcase, AlertTriangle,
  CheckCircle, RefreshCw, Bell, Target, Zap, Minus, Wallet, Gauge,
  Trophy, Truck, UserPlus, BarChart2, Inbox,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import api from '@/services/api/client';
import RequireRole from '@/components/auth/RequireRole';
import DashCard from '@/components/dashboard/DashCard';
import useDashboardFilters, { PERIOD_OPTIONS } from '@/hooks/useDashboardFilters';
import {
  DashboardFilterBar, PageHero, PageShell, StatBand, Stat,
} from '@/components/pulse-ui';
import '@/components/dashboard/dashkit.css';
import './ExecutiveDashboard.css';

const P = '#6B3FDB';

const fmt = n => {
  if (!n && n !== 0) return '₹0';
  const v = parseFloat(n);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 10_000_000) return `${sign}₹${(a / 10_000_000).toFixed(1)}Cr`;
  if (a >= 100_000)    return `${sign}₹${(a / 100_000).toFixed(1)}L`;
  if (a >= 1_000)      return `${sign}₹${(a / 1_000).toFixed(0)}K`;
  return `${sign}₹${a.toFixed(0)}`;
};

// ── Rule-based AI insights ─────────────────────────────────────────────────
function generateInsights({ revTrend, attritionRate, pendingApprovals, pipelineValue, alertCount, conversionRate, netMargin, hasRevenueData, hasHeadcountData }) {
  const out = [];

  // No-data state: guide user to enter data rather than showing misleading 0% stats
  if (!hasRevenueData) {
    out.push({ type: 'info', emoji: '📊', text: 'No financial data entered yet. Record invoices in the Finance module to unlock revenue insights.' });
  } else if (revTrend > 10) {
    out.push({ type: 'success', emoji: '📈', text: `Revenue up ${revTrend}% MoM — strong growth momentum. Consider accelerating Q4 targets.` });
  } else if (revTrend < -5) {
    out.push({ type: 'danger',  emoji: '📉', text: `Revenue declined ${Math.abs(revTrend)}% MoM — review pipeline conversion and close rates.` });
  } else {
    out.push({ type: 'info',    emoji: '💹', text: `Revenue stable at ${revTrend > 0 ? '+' : ''}${revTrend}% MoM. Focus on deal acceleration in open opportunities.` });
  }

  if (!hasHeadcountData) {
    out.push({ type: 'info', emoji: '👥', text: 'No employee records found. Add employees in the HR module to enable workforce insights.' });
  } else if (attritionRate > 15) {
    out.push({ type: 'danger',  emoji: '👥', text: `Attrition at ${attritionRate}% exceeds 12% benchmark — HR should urgently review retention programs.` });
  } else if (attritionRate > 10) {
    out.push({ type: 'warning', emoji: '⚠️',  text: `Attrition at ${attritionRate}% is above ideal. Consider pulse surveys and growth plans for at-risk employees.` });
  } else {
    out.push({ type: 'success', emoji: '🌱', text: `Attrition at ${attritionRate}% is within the healthy range. Employee satisfaction initiatives appear to be working.` });
  }

  if (pendingApprovals > 10)
    out.push({ type: 'warning', emoji: '⏰', text: `${pendingApprovals} approvals pending — resolution delays may impact team productivity and morale.` });

  if (pipelineValue > 0) {
    const rate   = conversionRate != null ? conversionRate : 22;
    const label  = conversionRate != null ? `${rate.toFixed(1)}%` : '22% (est.)';
    const forecast = fmt(pipelineValue * (rate / 100));
    out.push({ type: 'info', emoji: '🎯', text: `Sales pipeline at ${fmt(pipelineValue)}. At ${label} conversion, forecast this month: ~${forecast}.` });
  }

  if (netMargin !== null) {
    if (netMargin >= 20)
      out.push({ type: 'success', emoji: '💰', text: `Net margin at ${netMargin}% — healthy profitability. Consider reinvesting surplus into growth initiatives.` });
    else if (netMargin >= 5)
      out.push({ type: 'info',    emoji: '📊', text: `Net margin at ${netMargin}% — within acceptable range. Look for cost optimisation opportunities.` });
    else if (netMargin < 0)
      out.push({ type: 'danger',  emoji: '🔴', text: `Negative net margin at ${netMargin}% — immediate review of expense structure and revenue acceleration required.` });
  }

  if (alertCount > 3)
    out.push({ type: 'warning', emoji: '🔔', text: `${alertCount} active alerts need attention — unresolved alerts may impact operations continuity.` });

  return out.slice(0, 4);
}

// ── Style maps ─────────────────────────────────────────────────────────────
// `warning` is the LAVENDER attention step, not amber — there is no orange
// anywhere in the app since 2026-08-20 (see components/pulse-ui/pulse-hero.css).
const INSIGHT_STYLE = {
  success: { bg: '#f0fdf4', border: '#bbf7d0', text: '#166534' },
  warning: { bg: '#f5f3ff', border: '#ddd6fe', text: '#5b21b6' },
  danger:  { bg: '#fef2f2', border: '#fecaca', text: '#991b1b' },
  info:    { bg: '#f5f3ff', border: '#e9e4ff', text: '#5b21b6' },
};
const ALERT_STYLE = {
  high:   { bg: '#fef2f2', border: '#fecaca', dot: '#dc2626' },
  medium: { bg: '#f5f3ff', border: '#ddd6fe', dot: '#6d28d9' },
  low:    { bg: '#eff6ff', border: '#bfdbfe', dot: '#2563eb' },
};
const STAGE_COLORS = [P, '#8b5cf6', '#6d28d9', '#a78bfa', '#10b981'];
const DEPT_COLORS  = [P, '#8b5cf6', '#6d28d9', '#a78bfa', '#c4b5fd', '#ddd6fe'];

// Quick-nav chips — rendered into the filter bar's actions slot so they cost no
// vertical band of their own.
const QUICK_NAV = [
  { label: 'Finance',   page: 'FinanceDashboardNew', color: '#10b981' },
  { label: 'Sales',     page: 'SalesDashboard',      color: '#3b82f6' },
  { label: 'HR',        page: 'HRDashboard',         color: P },
  { label: 'Projects',  page: 'ProjectsDashboard',   color: '#8b5cf6' },
  { label: 'Approvals', page: 'ApprovalCenter',      color: '#ef4444' },
  { label: 'Reports',   page: 'Reports',             color: '#6b7280' },
];

// ── Custom tooltip ─────────────────────────────────────────────────────────
const RevTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="exd-tip">
      <div className="exd-tip-lbl">{label}</div>
      <div className="exd-tip-val">{fmt(payload[0].value)}</div>
    </div>
  );
};

/* Department axis tick. Recharts' default category tick is its own <Text>
 * component, which WORD-WRAPS to the axis `width` — so "Human Resources"
 * became two lines and collided with the rows above and below it in a 100px
 * plot. A plain <text> never wraps; the full name stays in the tooltip. */
const DeptTick = ({ x, y, payload }) => {
  const v = String(payload?.value ?? '');
  return (
    <text x={x} y={y} dy={3} textAnchor="end" fontSize={10} fill="#6b7280">
      {v.length > 13 ? `${v.slice(0, 12)}…` : v}
    </text>
  );
};

/* Delta chip. `inverse` flips good/bad for metrics where a fall is the win. */
const Delta = ({ value, suffix = '%', inverse = false, flat = 0 }) => {
  if (value == null || Number.isNaN(value)) return null;
  const dir  = Math.abs(value) <= flat ? 0 : value > 0 ? 1 : -1;
  const good = dir === 0 ? null : inverse ? dir < 0 : dir > 0;
  const Icon = dir === 0 ? Minus : dir > 0 ? TrendingUp : TrendingDown;
  const tone = good === null ? 'is-flat' : good ? 'is-good' : 'is-bad';
  return (
    <span className={`exd-delta ${tone}`}>
      <Icon size={12} strokeWidth={2.5} />
      {value > 0 ? '+' : ''}{value}{suffix}
    </span>
  );
};

/* Empty state that FILLS the card body instead of padding it out — a fixed
 * 46px pad is what pushes a height-locked card past its grid row. */
const Empty = ({ icon: Icon, text, color = '#d1d5db' }) => (
  <div className="exd-empty">
    <Icon size={22} color={color} />
    <p>{text}</p>
  </div>
);

export default function ExecutiveDashboard({ setPage }) {
  const [rev,      setRev]      = useState({ months: [], values: [], ytd: 0, thisMonth: 0, lastMonth: 0 });
  const [wf,       setWf]       = useState({ total: 0, active: 0, newHires: 0, attrition: 0, byDepartment: [] });
  const [alerts,   setAlerts]   = useState([]);
  const [sales,    setSales]    = useState([]);
  const [opsActive,    setOpsActive]    = useState(null);
  const [pendAppr,     setPendAppr]     = useState(0);
  const [crmStats,     setCrmStats]     = useState({ conversionRate: null });
  const [attrStats,    setAttrStats]    = useState({ rate: null });
  const [pl,           setPl]           = useState({ totalRevenue: 0, totalExpenses: 0, netProfit: 0 });
  // Roles that can open this page (e.g. `manager`) may not hold `finance:view` —
  // the P&L call 403s for them. Rather than show a permanently-stuck "—" tile
  // forever, drop the Net Profit stat entirely when we know it's a permission
  // denial (not a transient failure), same as the other tiles quietly degrade.
  const [plForbidden,  setPlForbidden]  = useState(false);
  const [topCustomers, setTopCustomers] = useState([]);
  const [topVendors,   setTopVendors]   = useState([]);
  const [hcTrend,      setHcTrend]      = useState([]);
  const [loading,      setLoading]      = useState(false);
  // Named failures, so an outage is never rendered as an empty state.
  const [failures,     setFailures]     = useState([]);
  const [lastSync,     setLastSync]     = useState(new Date());
  const abortRef = useRef(null);

  // Revenue and P&L follow the period; alerts, approvals and headcount are
  // point-in-time and stay unfiltered.
  const filters = useDashboardFilters({ defaultPeriod: 'fytd', storageKey: 'executive-dashboard' });
  const { params, bounds: periodBounds } = filters;

  const load = useCallback(async () => {
    // Cancel any in-flight request from a previous load
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    setLoading(true);

    const signal = abortRef.current.signal;
    // P&L took a hardcoded calendar-YTD window; it now follows the period
    // selector. Falls back to calendar YTD when the range is open-ended
    // (period=all), since the P&L endpoint requires both bounds.
    const today = new Date();
    const plStart = periodBounds.from || `${today.getFullYear()}-01-01`;
    const plEnd   = periodBounds.to   || today.toISOString().split('T')[0];

    const [dashR, revR, wfR, alertsR, salesR, crmR, attrR, plR, custR, vendR, hcR, opsR] = await Promise.allSettled([
      api.get('/dashboard/data',        { signal }),
      api.get('/dashboard/revenue',     { signal, params }),
      api.get('/dashboard/workforce',   { signal }),
      // Alerts and approval queues are work-to-do, not period reporting.
      api.get('/dashboard/alerts',      { signal }),
      api.get('/dashboard/sales',       { signal }),
      api.get('/analytics/sales',       { signal }),
      api.get('/analytics/attrition',   { signal }),
      api.get('/finance/reports/profit-loss', { signal, params: { start_date: plStart, end_date: plEnd } }),
      api.get('/dashboard/top-customers',   { signal }),
      api.get('/dashboard/top-vendors',     { signal }),
      api.get('/dashboard/headcount-trend', { signal }),
      api.get('/dashboard/operations',      { signal }),
    ]);

    // Abort check — don't update state if a newer load started
    if (signal.aborted) return;

    if (dashR.status === 'fulfilled') {
      const appr = dashR.value.data?.kpis?.pendingApprovals || dashR.value.data?.pendingApprovals || 0;
      setPendAppr(appr);
    }
    if (revR.status === 'fulfilled' && revR.value.data?.months?.length)
      setRev(revR.value.data);
    if (wfR.status === 'fulfilled' && wfR.value.data)
      setWf(prev => ({ ...prev, ...wfR.value.data }));
    if (alertsR.status === 'fulfilled') {
      const raw = alertsR.value.data;
      // Filter out the backend's "all clear" info placeholder — handled in UI
      const list = raw?.alerts || (Array.isArray(raw) ? raw : []);
      setAlerts(list.filter(a => a.type !== 'info'));
    }
    if (salesR.status === 'fulfilled') {
      const raw = salesR.value.data;
      setSales(raw?.stages || (Array.isArray(raw) ? raw : []));
    }
    if (crmR.status === 'fulfilled') {
      // /analytics/sales wraps result in { data: { conversionRate, ... } }
      const d = crmR.value.data?.data ?? crmR.value.data;
      if (d?.conversionRate != null) setCrmStats({ conversionRate: d.conversionRate });
    }
    if (attrR.status === 'fulfilled') {
      // /analytics/attrition wraps result in { data: { rate, ... } }
      const d = attrR.value.data?.data ?? attrR.value.data;
      if (d?.rate != null) setAttrStats({ rate: d.rate });
    }
    if (plR.status === 'fulfilled') {
      const d = plR.value.data;
      if (d) setPl({ totalRevenue: d.total_revenue || 0, totalExpenses: d.total_expenses || 0, netProfit: d.net_profit || 0 });
    } else if (plR.reason?.response?.status === 403) {
      setPlForbidden(true);
    }
    if (custR.status === 'fulfilled') {
      const d = custR.value.data;
      setTopCustomers(d?.customers || d?.top_customers || (Array.isArray(d) ? d : []));
    }
    if (vendR.status === 'fulfilled') {
      const d = vendR.value.data;
      setTopVendors(d?.vendors || d?.top_vendors || (Array.isArray(d) ? d : []));
    }
    if (hcR.status === 'fulfilled') {
      const d = hcR.value.data;
      setHcTrend(d?.trend || d?.headcount_trend || (Array.isArray(d) ? d : []));
    }
    if (opsR.status === 'fulfilled') {
      setOpsActive(opsR.value.data?.active_projects ?? null);
    }

    // Collect anything that did not come back, excluding the P&L 403 which is a
    // known role limitation already handled by dropping that tile.
    const named = [
      ['Approvals', dashR], ['Revenue', revR], ['Workforce', wfR], ['Alerts', alertsR],
      ['Sales pipeline', salesR], ['Sales KPIs', crmR], ['Attrition', attrR],
      ['Top customers', custR], ['Top vendors', vendR], ['Headcount trend', hcR],
      ['Operations', opsR],
    ];
    setFailures(named
      .filter(([, r]) => r.status === 'rejected')
      .map(([label, r]) => ({ label, status: r.reason?.response?.status ?? 0, forbidden: r.reason?.response?.status === 403 })));

    setLastSync(new Date());
    setLoading(false);
  }, [params, periodBounds]);

  useEffect(() => { load(); }, [load]);

  // Derived values
  const revChart   = (rev.months || []).map((m, i) => ({ month: m, revenue: rev.values?.[i] || 0 }));
  const thisMonth  = rev.thisMonth  || revChart.at(-1)?.revenue  || 0;
  const lastMonth  = rev.lastMonth  || revChart.at(-2)?.revenue  || 0;
  const revTrend   = lastMonth ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100) : 0;
  const ytd        = rev.ytd || revChart.reduce((s, r) => s + r.revenue, 0);
  // Use backend-computed rate when available; fall back to frontend estimate
  const attrition  = attrStats.rate != null
    ? Math.round(attrStats.rate)
    : (wf.total > 0 ? Math.round(((wf.attrition || 0) / wf.total) * 100) : 0);
  const pipeline   = sales.reduce((s, st) => s + (st.value || 0), 0);
  const openDeals  = sales.reduce((s, x) => s + (x.count || 0), 0);
  const highAlerts = alerts.filter(a => a.priority === 'high').length;
  const netMargin  = pl.totalRevenue > 0 ? Math.round((pl.netProfit / pl.totalRevenue) * 100) : null;
  const convRate   = crmStats.conversionRate;
  const forecast   = pipeline > 0 ? pipeline * ((convRate != null ? convRate : 22) / 100) : null;
  const totalHires = hcTrend.reduce((s, r) => s + (r.hires || 0), 0);
  const totalExits = hcTrend.reduce((s, r) => s + (r.attrition || 0), 0);

  const periodLabel = useMemo(
    () => PERIOD_OPTIONS.find(o => o.value === filters.period)?.label || '',
    [filters.period],
  );

  const insights = useMemo(() => generateInsights({
    revTrend, attritionRate: attrition,
    pendingApprovals: pendAppr, pipelineValue: pipeline, alertCount: alerts.length,
    conversionRate: crmStats.conversionRate, netMargin,
    hasRevenueData: rev.months.length > 0,
    hasHeadcountData: wf.total > 0,
  }), [revTrend, attrition, pendAppr, pipeline, alerts.length, crmStats.conversionRate, netMargin, rev.months.length, wf.total]);

  const greet = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  };
  const userName = localStorage.getItem('name') || localStorage.getItem('userName') || 'Executive';

  // ── Stat band ────────────────────────────────────────────────────────────
  // The numbers this page exists for, in one row. Each figure appears EXACTLY
  // once on the page: the card footers that used to repeat Total/Active/New
  // Hires, Hires/Exits and the pipeline total were dropped rather than left to
  // disagree with these (the CFO Dashboard lesson, manual §113).
  const stats = [
    {
      key: 'revenue', icon: IndianRupee, tone: 'primary', label: 'Revenue',
      value: fmt(ytd), trend: revTrend, sub: 'vs last month',
      page: 'FinanceDashboardNew',
    },
    // Dropped entirely when the role cannot read P&L — a permanently stuck "—"
    // is worse than an absent tile.
    ...(plForbidden ? [] : [{
      key: 'profit', icon: Wallet,
      tone: netMargin == null ? 'neutral' : netMargin >= 5 ? 'success' : 'danger',
      label: 'Net Profit',
      value: pl.totalRevenue > 0 ? fmt(pl.netProfit) : '—',
      warn: pl.netProfit < 0,
      sub: netMargin != null ? `${netMargin}% margin · spend ${fmt(pl.totalExpenses)}` : 'no P&L data this period',
      page: 'FinanceDashboardNew',
    }]),
    {
      key: 'pipeline', icon: Target, tone: 'info', label: 'Pipeline',
      value: fmt(pipeline),
      sub: `${openDeals} open · forecast ${forecast != null ? fmt(forecast) : '—'}`,
      page: 'SalesDashboard',
    },
    {
      key: 'headcount', icon: Users, tone: 'success', label: 'Headcount',
      value: wf.total || 0,
      sub: `${wf.active || 0} active · ${wf.newHires || 0} new`,
      page: 'EmployeesDashboard',
    },
    {
      key: 'projects', icon: Briefcase, tone: 'lavender', label: 'Active Projects',
      value: opsActive !== null ? opsActive : '—',
      sub: 'across departments',
      page: 'ProjectsDashboard',
    },
    {
      key: 'approvals', icon: CheckCircle,
      tone: pendAppr > 10 ? 'warning' : 'neutral', label: 'Pending Approvals',
      value: pendAppr,
      sub: pendAppr > 10 ? 'queue is backing up' : 'queue is healthy',
      page: 'ApprovalCenter',
    },
  ];

  // Reusable chart renderers so the card and the expanded modal share markup.
  // In-card charts take height="100%" and fill whatever the fit grid gives
  // them; the modal copies pass a fixed pixel height and a longer window.
  const revenueChart = (h = '100%') => (
    <ResponsiveContainer width="100%" height={h}>
      <AreaChart data={revChart} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="exdRevGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={P} stopOpacity={0.2} />
            <stop offset="95%" stopColor={P} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false} axisLine={{ stroke: '#eceaf4' }} />
        <YAxis tickFormatter={v => fmt(v)} tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false} axisLine={false} width={54} />
        <Tooltip content={<RevTooltip />} />
        <Area type="monotone" dataKey="revenue" stroke={P} strokeWidth={2.5}
          fill="url(#exdRevGrad)" dot={{ r: 3, fill: P, strokeWidth: 0 }}
          activeDot={{ r: 5, fill: P, stroke: '#fff', strokeWidth: 2 }} />
      </AreaChart>
    </ResponsiveContainer>
  );

  const workforceChart = (h = '100%', limit = 6) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={wf.byDepartment?.slice(0, limit) || []} layout="vertical"
        margin={{ top: 0, right: 24, left: 2, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false} axisLine={false} />
        {/* interval=0 forces every department to keep its label — recharts
            silently drops alternate category ticks when the plot is short, and
            at 1366x768 that hid 3 of 6 departments. <DeptTick> then keeps each
            label on ONE line (see its comment). */}
        <YAxis type="category" dataKey="department" tick={<DeptTick />}
          width={78} tickLine={false} axisLine={false} interval={0} />
        <Tooltip formatter={v => [v, 'Employees']} cursor={{ fill: '#f8f7fd' }} />
        <Bar dataKey="count" radius={[0, 5, 5, 0]} maxBarSize={18}>
          {(wf.byDepartment || []).slice(0, limit).map((_, i) => (
            <Cell key={i} fill={DEPT_COLORS[i % DEPT_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const headcountChart = (h = '100%', months = 8) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={hcTrend.slice(-months)} margin={{ top: 4, right: 6, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 9, fill: '#9ca3af' }} tickLine={false} axisLine={{ stroke: '#eceaf4' }} />
        <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} tickLine={false} axisLine={false} width={30} />
        <Tooltip formatter={(v, n) => [v, n]} cursor={{ fill: '#f8f7fd' }} />
        <Bar dataKey="hires" name="Hires" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={12} />
        <Bar dataKey="attrition" name="Exits" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={12} />
      </BarChart>
    </ResponsiveContainer>
  );

  // Top-customers and top-vendors draw the same row shape from different keys;
  // one renderer keeps the two cards from drifting apart.
  const rankList = (rows, { valueOf, nameOf, color }) => (
    <div className="dk-rank-list">
      {rows.map((r, i) => {
        const max = valueOf(rows[0]) || 1;
        const pct = Math.round(((valueOf(r) || 0) / max) * 100);
        return (
          <div key={i} className="dk-rank-row">
            <div className="dk-rank-meta">
              <span className="dk-rank-name" title={nameOf(r)}>
                <span className="dk-rank-num">#{i + 1}</span>{nameOf(r)}
              </span>
              <span className="dk-rank-val" style={{ color }}>{fmt(valueOf(r))}</span>
            </div>
            <div className="dk-bar-track">
              <div className="dk-bar-fill" style={{ width: `${pct}%`, background: color, opacity: 0.75 }} />
            </div>
          </div>
        );
      })}
    </div>
  );

  const quickNav = (
    <div className="exd-quicknav">
      {QUICK_NAV.map(q => (
        <button key={q.page} className="exd-chip" onClick={() => setPage(q.page)}>
          <span className="exd-chip-dot" style={{ background: q.color }} />
          {q.label}
        </button>
      ))}
    </div>
  );

  // Hero + filter bar + (only on failure) the degraded-load banner make up the
  // frozen dock. They stay mounted across refetches so the controls never
  // flicker away mid-interaction.
  const chrome = (
    <>
      <PageHero
        icon={Gauge}
        eyebrow="Executive"
        title="Executive Dashboard"
        subtitle={`${greet()}, ${userName.split(' ')[0]} — company-wide performance at a glance`}
        meta={[
          { value: fmt(ytd), label: periodLabel ? `revenue · ${periodLabel.toLowerCase()}` : 'revenue' },
          ...(netMargin != null
            ? [{ value: `${netMargin}%`, label: 'net margin', tone: netMargin >= 20 ? 'good' : netMargin >= 5 ? 'warn' : 'bad' }]
            : []),
          { value: fmt(pipeline), label: 'pipeline' },
          { value: highAlerts, label: 'high-priority alerts', tone: highAlerts > 0 ? 'bad' : 'good' },
        ]}
        actions={
          <>
            <span className="plh-pill">
              Updated {lastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <button className="plh-cta" onClick={load} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'plh-spin' : undefined} />
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </>
        }
      />

      <DashboardFilterBar filters={filters} actions={quickNav} />

      {!loading && failures.length > 0 && (
        <div className="exd-banner">
          <AlertTriangle size={14} className="exd-banner-ico" />
          <strong>{failures.length} card{failures.length > 1 ? 's' : ''} could not load.</strong>
          <span>
            {failures.some(f => f.forbidden)
              ? 'Some data is restricted for your role.'
              : 'Showing empty because the request failed, not because there is no data.'}
          </span>
          <span className="exd-banner-list">{failures.map(f => `${f.label}${f.status ? ` (${f.status})` : ''}`).join(' · ')}</span>
        </div>
      )}
    </>
  );

  return (
    <RequireRole roles={['super_admin', 'admin', 'manager']}>
    <PageShell className="exd-root" dock={chrome}>
      <div className="exd-fit">

        {/* ── Band 1 · the headline numbers ── */}
        <StatBand cols={stats.length}>
          {stats.map((s, i) => (
            <Stat
              key={s.key} index={i} icon={s.icon} tone={s.tone} label={s.label}
              value={s.value} sub={s.sub} trend={s.trend} warn={s.warn}
              loading={loading} onClick={s.page ? () => setPage(s.page) : undefined}
            />
          ))}
        </StatBand>

        {/* ── Band 2 · money in, money forecast, things on fire ── */}
        <DashCard
          index={0} className="exd-c5"
          title="Revenue Trend" icon={<TrendingUp size={14} />} iconColor={P}
          subtitle={`Monthly · last ${revChart.length} month${revChart.length === 1 ? '' : 's'}`}
          expandable={revChart.length > 0}
          headerRight={
            <span className="exd-hdr-stat">
              <span>This month <b>{fmt(thisMonth)}</b></span>
              <Delta value={revTrend} />
            </span>
          }
          expandedChildren={revChart.length ? revenueChart(460) : null}
        >
          {revChart.length === 0
            ? <Empty icon={BarChart2} text="No revenue data yet" />
            : <div className="exd-chart">{revenueChart()}</div>}
        </DashCard>

        <DashCard
          index={1} className="exd-c4"
          title="Pipeline by Stage" icon={<Target size={14} />} iconColor="#3b82f6"
          subtitle={`${sales.length} stage${sales.length === 1 ? '' : 's'} · ${openDeals} deals${convRate != null ? ` · ${convRate.toFixed(1)}% conversion` : ''}`}
          onViewAll={() => setPage('SalesDashboard')}
          expandable={sales.length > 5}
          expandedChildren={
            <div className="dk-rank-list">
              {sales.map((s, i) => {
                const max = Math.max(...sales.map(x => x.value || 0)) || 1;
                const col = STAGE_COLORS[i % STAGE_COLORS.length];
                return (
                  <div key={i} className="dk-rank-row">
                    <div className="dk-bar-labels">
                      <span className="exd-stage-name">{s.stage}{s.count ? <em> · {s.count}</em> : null}</span>
                      <span style={{ color: col, fontWeight: 700 }}>{fmt(s.value)}</span>
                    </div>
                    <div className="dk-bar-track">
                      <div className="dk-bar-fill" style={{ width: `${Math.round(((s.value || 0) / max) * 100)}%`, background: col }} />
                    </div>
                  </div>
                );
              })}
            </div>
          }
        >
          {sales.length === 0 ? (
            <Empty icon={Inbox} text="No pipeline data" />
          ) : (
            <div className="dk-rank-list">
              {sales.slice(0, 5).map((s, i) => {
                const max = Math.max(...sales.map(x => x.value || 0)) || 1;
                const pct = Math.round(((s.value || 0) / max) * 100);
                const col = STAGE_COLORS[i % STAGE_COLORS.length];
                return (
                  <div key={i} className="dk-rank-row">
                    <div className="dk-bar-labels">
                      <span className="exd-stage-name">
                        {s.stage}{s.count ? <em> · {s.count}</em> : null}
                      </span>
                      <span style={{ color: col, fontWeight: 700 }}>{fmt(s.value)}</span>
                    </div>
                    <div className="dk-bar-track">
                      <div className="dk-bar-fill" style={{ width: `${pct}%`, background: col }} />
                    </div>
                  </div>
                );
              })}
              {sales.length > 5 && (
                <div className="exd-more">+{sales.length - 5} more stage{sales.length - 5 > 1 ? 's' : ''} — Expand to see all</div>
              )}
            </div>
          )}
        </DashCard>

        {/* The ONE card allowed to scroll inside itself: the alert feed is the
            only panel here whose row count grows with the business. */}
        <DashCard
          index={2} className="exd-c3"
          title="Smart Alerts" icon={<Bell size={14} />} iconColor="#ef4444"
          subtitle={highAlerts > 0 ? `${alerts.length} open · ${highAlerts} high priority` : `${alerts.length} open`}
          expandable={alerts.length > 0}
          expandedChildren={
            <div className="exd-alerts">
              {alerts.map((a, i) => {
                const s = ALERT_STYLE[a.priority] || ALERT_STYLE.low;
                return (
                  <div key={i} className="exd-alert" style={{ background: s.bg, borderColor: s.border }}>
                    <span className="exd-alert-dot" style={{ background: s.dot }} />
                    <span className="exd-alert-txt exd-alert-wrap">{a.message}</span>
                  </div>
                );
              })}
            </div>
          }
        >
          {alerts.length === 0 ? (
            <Empty icon={CheckCircle} text="No active alerts" color="#10b981" />
          ) : (
            <div className="exd-alerts exd-scroll">
              {alerts.map((a, i) => {
                const s = ALERT_STYLE[a.priority] || ALERT_STYLE.low;
                return (
                  <div key={i} className="exd-alert" style={{ background: s.bg, borderColor: s.border }}>
                    <span className="exd-alert-dot" style={{ background: s.dot }} />
                    <span className="exd-alert-txt" title={a.message}>{a.message}</span>
                  </div>
                );
              })}
            </div>
          )}
        </DashCard>

        {/* ── Band 3 · people and counterparties ── */}
        <DashCard
          index={3} className="exd-c3"
          title="Workforce by Dept" icon={<Users size={14} />} iconColor="#10b981"
          subtitle={`${wf.total || 0} employees · top ${Math.min(6, (wf.byDepartment || []).length)} depts`}
          onViewAll={() => setPage('EmployeesDashboard')} viewAllLabel="Details"
          expandable={(wf.byDepartment || []).length > 0}
          expandedChildren={(wf.byDepartment || []).length ? workforceChart(460, 20) : null}
        >
          {(wf.byDepartment || []).length === 0
            ? <Empty icon={Users} text="No workforce data yet" />
            : <div className="exd-chart">{workforceChart()}</div>}
        </DashCard>

        <DashCard
          index={4} className="exd-c3"
          title="Hiring vs Attrition" icon={<UserPlus size={14} />} iconColor="#10b981"
          subtitle={`${totalHires} hires · ${totalExits} exits · ${attrition}% attrition`}
          onViewAll={() => setPage('EmployeesDashboard')} viewAllLabel="Details"
          expandable={hcTrend.length > 0}
          expandedChildren={hcTrend.length ? headcountChart(460, 12) : null}
          headerRight={
            <span className="exd-legend">
              <span><i style={{ background: '#10b981' }} />Hires</span>
              <span><i style={{ background: '#ef4444' }} />Exits</span>
            </span>
          }
        >
          {hcTrend.length === 0
            ? <Empty icon={TrendingUp} text="No trend data yet" />
            : <div className="exd-chart">{headcountChart()}</div>}
        </DashCard>

        <DashCard
          index={5} className="exd-c3"
          title="Top Customers" icon={<Trophy size={14} />} iconColor={P}
          subtitle="By revenue contribution"
          onViewAll={() => setPage('CustomerOutstanding')}
          expandable={topCustomers.length > 5}
          expandedChildren={rankList(topCustomers.slice(0, 20), {
            valueOf: c => c.revenue, nameOf: c => c.name || c.customer_name, color: P,
          })}
        >
          {topCustomers.length === 0
            ? <Empty icon={Trophy} text="No customer data yet" />
            : rankList(topCustomers.slice(0, 5), {
                valueOf: c => c.revenue, nameOf: c => c.name || c.customer_name, color: P,
              })}
        </DashCard>

        <DashCard
          index={6} className="exd-c3"
          title="Top Vendors" icon={<Truck size={14} />} iconColor="#6b7280"
          subtitle="By spend"
          onViewAll={() => setPage('SupplierOutstanding')}
          expandable={topVendors.length > 5}
          expandedChildren={rankList(topVendors.slice(0, 20), {
            valueOf: v => v.spend, nameOf: v => v.name || v.vendor_name, color: '#dc2626',
          })}
        >
          {topVendors.length === 0
            ? <Empty icon={Truck} text="No vendor data yet" />
            : rankList(topVendors.slice(0, 5), {
                valueOf: v => v.spend, nameOf: v => v.name || v.vendor_name, color: '#dc2626',
              })}
        </DashCard>

        {/* ── Band 4 · AI insights, as a strip rather than a full card ── */}
        <div className="exd-ai">
          <div className="exd-ai-hd">
            <span className="exd-ai-ico"><Zap size={13} color={P} /></span>
            <span className="exd-ai-title">AI Insights</span>
            <span className="exd-ai-badge">{insights.length}</span>
          </div>
          <div className="exd-ai-list">
            {insights.map((ins, i) => {
              const c = INSIGHT_STYLE[ins.type];
              return (
                <div key={i} className="exd-ai-item" title={ins.text}
                  style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}>
                  <span className="exd-ai-emoji">{ins.emoji}</span>
                  <span className="exd-ai-txt">{ins.text}</span>
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </PageShell>
    </RequireRole>
  );
}
