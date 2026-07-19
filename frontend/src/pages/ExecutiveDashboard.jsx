// PATH: frontend/src/pages/ExecutiveDashboard.jsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  TrendingUp, TrendingDown, Users, IndianRupee, Briefcase, AlertTriangle,
  CheckCircle, RefreshCw, ChevronRight, Bell, Target, Zap,
  Trophy, Truck, UserPlus, BarChart2, Inbox,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import api from '@/services/api/client';
import RequireRole from '@/components/auth/RequireRole';
import DashCard from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';
import './ExecutiveDashboard.css';

const P = '#6B3FDB';

const fmt = n => {
  if (!n && n !== 0) return '₹0';
  const v = parseFloat(n);
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(1)}Cr`;
  if (v >= 100_000)    return `₹${(v / 100_000).toFixed(1)}L`;
  if (v >= 1_000)      return `₹${(v / 1_000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
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
const INSIGHT_STYLE = {
  success: { bg: '#f0fdf4', border: '#bbf7d0', text: '#166534' },
  warning: { bg: '#fffbeb', border: '#fde68a', text: '#92400e' },
  danger:  { bg: '#fef2f2', border: '#fecaca', text: '#991b1b' },
  info:    { bg: '#f5f3ff', border: '#e9e4ff', text: '#5b21b6' },
};
const ALERT_STYLE = {
  high:   { bg: '#fef2f2', border: '#fecaca', dot: '#dc2626' },
  medium: { bg: '#fffbeb', border: '#fde68a', dot: '#d97706' },
  low:    { bg: '#eff6ff', border: '#bfdbfe', dot: '#2563eb' },
};
const STAGE_COLORS = [P, '#8b5cf6', '#f59e0b', '#ef4444', '#10b981'];
const DEPT_COLORS  = [P, '#8b5cf6', '#6d28d9', '#a78bfa', '#c4b5fd', '#ddd6fe'];

// Quick-nav chips shown in the page header (replaces the old Quick Navigation card)
const QUICK_NAV = [
  { label: 'Finance',   page: 'FinanceDashboardNew', color: '#10b981' },
  { label: 'Sales',     page: 'SalesDashboard',      color: '#3b82f6' },
  { label: 'HR',        page: 'HRDashboard',         color: P },
  { label: 'Projects',  page: 'ProjectsDashboard',   color: '#f59e0b' },
  { label: 'Approvals', page: 'ApprovalCenter',      color: '#ef4444' },
  { label: 'Reports',   page: 'Reports',             color: '#6b7280' },
];

// ── Custom tooltip ─────────────────────────────────────────────────────────
const RevTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, color: '#374151', marginBottom: 3 }}>{label}</div>
      <div style={{ color: P, fontWeight: 700 }}>{fmt(payload[0].value)}</div>
    </div>
  );
};

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
  const [topCustomers, setTopCustomers] = useState([]);
  const [topVendors,   setTopVendors]   = useState([]);
  const [hcTrend,      setHcTrend]      = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [lastSync,     setLastSync]     = useState(new Date());
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    // Cancel any in-flight request from a previous load
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    setLoading(true);

    const today = new Date();
    const ytdStart = `${today.getFullYear()}-01-01`;
    const ytdEnd   = today.toISOString().split('T')[0];
    const signal   = abortRef.current.signal;

    const [dashR, revR, wfR, alertsR, salesR, crmR, attrR, plR, custR, vendR, hcR, opsR] = await Promise.allSettled([
      api.get('/dashboard/data',        { signal }),
      api.get('/dashboard/revenue',     { signal }),
      api.get('/dashboard/workforce',   { signal }),
      api.get('/dashboard/alerts',      { signal }),
      api.get('/dashboard/sales',       { signal }),
      api.get('/analytics/sales',       { signal }),
      api.get('/analytics/attrition',   { signal }),
      api.get(`/finance/reports/profit-loss?start_date=${ytdStart}&end_date=${ytdEnd}`, { signal }),
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

    setLastSync(new Date());
    setLoading(false);
  }, []);

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
  const highAlerts = alerts.filter(a => a.priority === 'high').length;
  const netMargin  = pl.totalRevenue > 0 ? Math.round((pl.netProfit / pl.totalRevenue) * 100) : null;

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

  // KPI config
  const kpis = [
    {
      icon: IndianRupee, label: 'Revenue YTD', tint: '#6B3FDB',
      value: loading ? null : fmt(ytd),
      sub: `${revTrend >= 0 ? '+' : ''}${revTrend}% vs last month`,
      page: 'FinanceDashboardNew',
    },
    {
      icon: Users, label: 'Total Headcount', tint: '#10b981',
      value: loading ? null : (wf.total || 0),
      sub: `${wf.total || 0} active employees`,
      page: 'EmployeesDashboard',
    },
    {
      icon: Target, label: 'Sales Pipeline', tint: '#3b82f6',
      value: loading ? null : fmt(pipeline),
      sub: `${sales.reduce((s, x) => s + (x.count || 0), 0)} open deals`,
      page: 'SalesDashboard',
    },
    {
      icon: Briefcase, label: 'Active Projects', tint: '#f59e0b',
      value: loading ? null : (opsActive !== null ? opsActive : '—'),
      sub: 'Across departments',
      page: 'ProjectsDashboard',
    },
    {
      icon: netMargin != null && netMargin >= 0 ? TrendingUp : TrendingDown,
      label: 'Net Profit (YTD)',
      tint: netMargin == null ? '#f59e0b' : netMargin >= 15 ? '#10b981' : netMargin >= 0 ? '#f59e0b' : '#ef4444',
      value: loading ? null : (pl.totalRevenue > 0 ? fmt(pl.netProfit) : '—'),
      sub: netMargin != null ? `${netMargin >= 0 ? '+' : ''}${netMargin}% net margin` : 'No P&L data yet',
      page: 'FinanceDashboardNew',
    },
    {
      icon: attrition > 12 ? TrendingDown : TrendingUp,
      label: 'Attrition Rate',
      tint: attrition > 12 ? '#ef4444' : '#10b981',
      value: loading ? null : `${attrition}%`,
      sub: attrition > 12 ? 'Above 12% benchmark' : 'Within healthy range',
      page: 'EmployeesDashboard',
    },
    {
      icon: AlertTriangle, label: 'Open Alerts', tint: alerts.length > 3 ? '#ef4444' : '#f59e0b',
      value: loading ? null : alerts.length,
      sub: `${highAlerts} high priority`,
      page: null,
    },
  ];

  // Reusable chart renderers so the compact card and the expanded modal share markup
  const revenueChart = (h = 200) => (
    <ResponsiveContainer width="100%" height={h}>
      <AreaChart data={revChart} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id="exdRevGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={P} stopOpacity={0.18} />
            <stop offset="95%" stopColor={P} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#9ca3af' }} />
        <YAxis tickFormatter={v => fmt(v)} tick={{ fontSize: 11, fill: '#9ca3af' }} />
        <Tooltip content={<RevTooltip />} />
        <Area type="monotone" dataKey="revenue" stroke={P} strokeWidth={2.5}
          fill="url(#exdRevGrad)" dot={{ r: 4, fill: P, strokeWidth: 0 }} />
      </AreaChart>
    </ResponsiveContainer>
  );

  const workforceChart = (h = 175) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={wf.byDepartment?.slice(0, 6) || []} layout="vertical"
        margin={{ top: 0, right: 24, left: 72, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 11, fill: '#9ca3af' }} />
        <YAxis type="category" dataKey="department" tick={{ fontSize: 11, fill: '#6b7280' }} width={70} />
        <Tooltip formatter={v => [v, 'Employees']} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
          {(wf.byDepartment || []).map((_, i) => (
            <Cell key={i} fill={DEPT_COLORS[i % DEPT_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const headcountChart = (h = 180) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={hcTrend.slice(-12)} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#9ca3af' }} />
        <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} />
        <Tooltip formatter={(v, n) => [v, n]} />
        <Bar dataKey="hires" name="Hires" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={14} />
        <Bar dataKey="attrition" name="Attrition" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={14} />
      </BarChart>
    </ResponsiveContainer>
  );

  return (
    <RequireRole roles={['super_admin', 'admin', 'manager']}>
    <div className="dk-page exd-fit">

      {/* ── Header ── */}
      <div className="dk-head">
        <div>
          <h1 className="dk-title">{greet()}, {userName.split(' ')[0]} 👋</h1>
          <p className="dk-subtitle">
            {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
            {' · '}Executive Overview
          </p>
        </div>
        <div className="exd-quicknav">
          {QUICK_NAV.map(q => (
            <button key={q.page} className="exd-chip" onClick={() => setPage(q.page)}>
              <span className="exd-chip-dot" style={{ background: q.color }} />
              {q.label}
            </button>
          ))}
        </div>
        <div className="dk-head-actions">
          <span className="dk-sync">
            Updated {lastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
          </span>
          {highAlerts > 0 && (
            <span className="dk-btn" style={{ color: '#b91c1c', borderColor: '#fecaca', background: '#fef2f2' }}>
              <Bell size={13} /> {highAlerts} alert{highAlerts > 1 ? 's' : ''}
            </span>
          )}
          <button className="dk-btn primary" onClick={load} disabled={loading}>
            <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── KPI strip ── */}
      <div className="dk-kpis">
        {kpis.map((k, i) => (
          <div
            key={i}
            className={`dk-kpi ${k.page ? 'clickable' : ''}`}
            style={{ '--dk-i': i }}
            onClick={() => k.page && setPage(k.page)}
          >
            <div className="dk-kpi-top">
              <span className="dk-kpi-ico" style={{ background: `${k.tint}18`, color: k.tint }}>
                <k.icon size={15} />
              </span>
              <span className="dk-kpi-label">{k.label}</span>
            </div>
            {k.value === null
              ? <div className="dk-kpi-sk" />
              : <div className="dk-kpi-val">{k.value}</div>}
            <div className="dk-kpi-sub">
              <span>{k.sub}</span>
              {k.page && <ChevronRight size={13} color="#c4c4d0" />}
            </div>
          </div>
        ))}
      </div>

      {/* ── AI Insights ── */}
      <div className="dk-insights">
        <div className="dk-insights-hd">
          <div className="dk-ai-icon"><Zap size={16} color={P} /></div>
          <div>
            <div className="dk-insights-title">AI Business Insights</div>
            <div className="dk-insights-sub">
              Last updated {lastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
          <span className="dk-insights-badge">{insights.length} insight{insights.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="dk-insights-grid">
          {insights.map((ins, i) => {
            const c = INSIGHT_STYLE[ins.type];
            return (
              <div key={i} className="dk-insight" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
                <span className="dk-insight-emoji">{ins.emoji}</span>
                <span style={{ color: c.text }}>{ins.text}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Main cockpit grid: 4 cols × 2 rows under the fit contract ── */}
      <div className="exd-main">
        <DashCard
          index={0} className="exd-span2"
          title="Revenue Trend" icon={<TrendingUp size={14} />} iconColor={P}
          subtitle={`Monthly · last ${revChart.length} months`}
          expandable={revChart.length > 0}
          headerRight={
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11.5, color: '#9ca3af' }}>YTD <b style={{ color: '#1a1a2e' }}>{fmt(ytd)}</b></span>
              <span style={{ fontSize: 11, fontWeight: 700, color: revTrend >= 0 ? '#16a34a' : '#dc2626' }}>
                {revTrend >= 0 ? '▲' : '▼'} {Math.abs(revTrend)}%
              </span>
            </span>
          }
          expandedChildren={revChart.length ? revenueChart(420) : null}
        >
          {revChart.length === 0
            ? <div className="dk-empty"><BarChart2 size={26} color="#d1d5db" /><p>No revenue data yet</p></div>
            : <div className="exd-chartfill">{revenueChart('100%')}</div>}
        </DashCard>

        <DashCard
          index={1} title="Sales Pipeline" icon={<Target size={14} />} iconColor="#3b82f6"
          subtitle={`${sales.length} stages`}
          onViewAll={() => setPage('SalesDashboard')}
        >
          {sales.length === 0 ? (
            <div className="dk-empty"><Inbox size={26} color="#d1d5db" /><p>No pipeline data</p></div>
          ) : (
            <>
              <div className="dk-rank-list exd-list">
                {sales.map((s, i) => {
                  const max = Math.max(...sales.map(x => x.value));
                  const pct = max ? Math.round((s.value / max) * 100) : 0;
                  const col = STAGE_COLORS[i % STAGE_COLORS.length];
                  return (
                    <div key={i} className="dk-rank-row">
                      <div className="dk-bar-labels">
                        <span style={{ color: '#374151', fontWeight: 500 }}>{s.stage}</span>
                        <span style={{ color: col, fontWeight: 700 }}>{fmt(s.value)}</span>
                      </div>
                      <div className="dk-bar-track">
                        <div className="dk-bar-fill" style={{ width: `${pct}%`, background: col }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="dk-stats">
                <div className="dk-stat">
                  <div className="dk-stat-val" style={{ color: P }}>{fmt(pipeline)}</div>
                  <div className="dk-stat-lbl">Total Pipeline Value</div>
                </div>
              </div>
            </>
          )}
        </DashCard>

        <DashCard
          index={2} title="Smart Alerts" icon={<Bell size={14} />} iconColor="#ef4444"
          subtitle={highAlerts > 0 ? `${highAlerts} high priority` : 'All clear'}
          expandable={alerts.length > 3}
          expandedChildren={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {alerts.map((a, i) => {
                const s = ALERT_STYLE[a.priority] || ALERT_STYLE.low;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px', borderRadius: 8, background: s.bg, border: `1px solid ${s.border}`, fontSize: 12.5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
                    <span>{a.message}</span>
                  </div>
                );
              })}
            </div>
          }
        >
          {alerts.length === 0 ? (
            <div className="dk-empty"><CheckCircle size={26} color="#10b981" /><p>No active alerts</p></div>
          ) : (
            <div className="exd-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {alerts.slice(0, 5).map((a, i) => {
                const s = ALERT_STYLE[a.priority] || ALERT_STYLE.low;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, background: s.bg, border: `1px solid ${s.border}`, fontSize: 12, flexShrink: 0 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.message}</span>
                  </div>
                );
              })}
            </div>
          )}
        </DashCard>

        <DashCard
          index={3} title="Workforce by Dept" icon={<Users size={14} />} iconColor="#10b981"
          onViewAll={() => setPage('EmployeesDashboard')} viewAllLabel="Details"
          expandable={(wf.byDepartment || []).length > 0}
          expandedChildren={(wf.byDepartment || []).length ? workforceChart(420) : null}
        >
          {(wf.byDepartment || []).length === 0
            ? <div className="dk-empty"><Users size={26} color="#d1d5db" /><p>No workforce data yet</p></div>
            : <div className="exd-chartfill">{workforceChart('100%')}</div>}
          <div className="dk-stats">
            {[
              { label: 'Total', value: wf.total || 0, color: '#1a1a2e' },
              { label: 'Active', value: wf.active || 0, color: '#10b981' },
              { label: 'New Hires', value: wf.newHires || 0, color: P },
            ].map(s => (
              <div key={s.label} className="dk-stat">
                <div className="dk-stat-val" style={{ color: s.color }}>{s.value}</div>
                <div className="dk-stat-lbl">{s.label}</div>
              </div>
            ))}
          </div>
        </DashCard>

        <DashCard
          index={4} title="Headcount Trend" icon={<UserPlus size={14} />} iconColor="#10b981"
          onViewAll={() => setPage('EmployeesDashboard')} viewAllLabel="Details"
          expandable={hcTrend.length > 0}
          expandedChildren={hcTrend.length ? headcountChart(420) : null}
        >
          {hcTrend.length === 0
            ? <div className="dk-empty"><TrendingUp size={26} color="#d1d5db" /><p>No trend data yet</p></div>
            : <div className="exd-chartfill">{headcountChart('100%')}</div>}
          <div style={{ display: 'flex', gap: 14, marginTop: 6, paddingLeft: 4, flexShrink: 0 }}>
            {[{ label: 'Hires', color: '#10b981' }, { label: 'Attrition', color: '#ef4444' }].map(l => (
              <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6b7280' }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: l.color, display: 'inline-block' }} />
                {l.label}
              </span>
            ))}
          </div>
        </DashCard>

        <DashCard
          index={5} title="Top Customers" icon={<Trophy size={14} />} iconColor="#f59e0b"
          onViewAll={() => setPage('CustomerOutstanding')}
        >
          {topCustomers.length === 0 ? (
            <div className="dk-empty"><Trophy size={26} color="#d1d5db" /><p>No customer data yet</p></div>
          ) : (
            <div className="dk-rank-list exd-list">
              {topCustomers.slice(0, 5).map((c, i) => {
                const max = topCustomers[0]?.revenue || 1;
                const pct = Math.round((c.revenue / max) * 100);
                return (
                  <div key={i} className="dk-rank-row">
                    <div className="dk-rank-meta">
                      <span className="dk-rank-name"><span className="dk-rank-num">#{i + 1}</span>{c.name || c.customer_name}</span>
                      <span className="dk-rank-val" style={{ color: P }}>{fmt(c.revenue)}</span>
                    </div>
                    <div className="dk-bar-track"><div className="dk-bar-fill" style={{ width: `${pct}%`, background: P, opacity: 0.75 }} /></div>
                  </div>
                );
              })}
            </div>
          )}
        </DashCard>

        <DashCard
          index={6} title="Top Vendors" icon={<Truck size={14} />} iconColor="#6b7280"
          onViewAll={() => setPage('SupplierOutstanding')}
        >
          {topVendors.length === 0 ? (
            <div className="dk-empty"><Truck size={26} color="#d1d5db" /><p>No vendor data yet</p></div>
          ) : (
            <div className="dk-rank-list exd-list">
              {topVendors.slice(0, 5).map((v, i) => {
                const max = topVendors[0]?.spend || 1;
                const pct = Math.round((v.spend / max) * 100);
                return (
                  <div key={i} className="dk-rank-row">
                    <div className="dk-rank-meta">
                      <span className="dk-rank-name"><span className="dk-rank-num">#{i + 1}</span>{v.name || v.vendor_name}</span>
                      <span className="dk-rank-val" style={{ color: '#dc2626' }}>{fmt(v.spend)}</span>
                    </div>
                    <div className="dk-bar-track"><div className="dk-bar-fill" style={{ width: `${pct}%`, background: '#dc2626', opacity: 0.55 }} /></div>
                  </div>
                );
              })}
            </div>
          )}
        </DashCard>
      </div>

    </div>
    </RequireRole>
  );
}
