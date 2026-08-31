// frontend/src/features/analytics/pages/CEOIntelligenceDashboard.jsx
// Phase 49H — CEO Customer & Vendor Intelligence Dashboard
// 16-section strategic executive view across 8 tabs
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw, TrendingUp, TrendingDown, IndianRupee, Users,
  ShoppingCart, AlertTriangle, AlertCircle, CheckCircle, Activity,
  Target, Zap, BarChart2, Briefcase, ArrowUpRight, ArrowDownRight,
  Clock, Shield, ShieldCheck, Package, UserCog, Gauge, Ticket,
  FileText, UserCheck, ChevronLeft, ChevronRight, Minus,
  LayoutDashboard,
} from 'lucide-react';
import {
  AreaChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import RevenueForecastPanel   from './RevenueForecastPanel';
import CustomerRiskPanel      from './CustomerRiskPanel';
import VendorRiskPanel        from './VendorRiskPanel';
import CollectionRiskPanel    from './CollectionRiskPanel';
import SupplyChainRiskPanel   from './SupplyChainRiskPanel';
import ProjectProfitabilityPanel from './ProjectProfitabilityPanel';
import StrategicAlertsPanel   from './StrategicAlertsPanel';
import AIInsightsPanel        from './AIInsightsPanel';
// Merged in from CeoDashboard: the LLM-backed brief and the client-side rule engine.
import AIInsightCard          from '@/features/ai/components/AIInsightCard';
import { generateInsights }   from '../services/insightsEngine';
import { DashboardFilterBar, PageHero, PageShell, Stat } from '@/components/pulse-ui';
import useDashboardFilters from '@/hooks/useDashboardFilters';

// ── formatters ────────────────────────────────────────────────────────────────
const fmtL = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};
const fmtPct = (n) => `${parseFloat(n || 0).toFixed(1)}%`;
const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');

// ── constants ─────────────────────────────────────────────────────────────────
const C = {
  primary: '#6B3FDB', light: '#f5f3ff', border: '#e9e4ff',
  green: '#16a34a', red: '#dc2626', amber: '#6d28d9', blue: '#2563eb',
  cyan: '#0891b2', rose: '#e11d48',
};

// Labels are deliberately short single nouns — at 10 tabs the full titles
// ("Customer Intelligence", "Collections & AMC", …) overflowed the strip and forced a
// horizontal scrollbar that hid the last tab. The longer title is kept in `title` for
// hover, and each panel still carries its full name in its own SectionHeader.
const TABS = [
  { id: 'executive',   label: 'Executive',      title: 'Executive Summary',      icon: Activity },
  { id: 'customers',   label: 'Customers',      title: 'Customer Intelligence',  icon: Users },
  { id: 'sales',       label: 'Sales',          title: 'Sales Command',          icon: TrendingUp },
  { id: 'vendors',     label: 'Vendors',        title: 'Vendor Intelligence',    icon: Package },
  { id: 'projects',    label: 'Projects',       title: 'Projects & P&L',         icon: Briefcase },
  { id: 'collections', label: 'Collections',    title: 'Collections & AMC',      icon: IndianRupee },
  { id: 'workforce',   label: 'Workforce',      title: 'Workforce Intelligence', icon: UserCog },
  { id: 'operations',  label: 'Operations',     title: 'Operations Command',     icon: Gauge },
  { id: 'warroom',     label: 'War Room',       title: 'War Room · Strategic Alerts', icon: AlertTriangle },
  { id: 'manifest',    label: 'Business Lines', title: 'Business Line Intelligence',  icon: BarChart2 },
];

// Operations drill-through tiles — `route` is the autoRouter page name
const OPS_TILES = [
  { key: 'active_projects',    label: 'Active Projects',    icon: Briefcase,   color: C.primary, route: 'ProjectsDashboard' },
  { key: 'open_tickets',       label: 'Open Tickets',       icon: Ticket,      color: C.blue,    route: 'AllTickets' },
  { key: 'pending_invoices',   label: 'Pending Invoices',   icon: FileText,    color: C.amber,   route: 'InvoicesNew' },
  { key: 'overdue_tasks',      label: 'Overdue Tasks',      icon: Clock,       color: C.red,     route: 'Projects', alertWhenPositive: true },
  { key: 'timesheets_pending', label: 'Timesheets Pending', icon: BarChart2,   color: '#8b5cf6', route: 'Timesheets' },
  { key: 'open_recruitments',  label: 'Open Recruitments',  icon: UserCheck,   color: C.green,   route: 'RecruitmentDashboard' },
  { key: 'low_stock',          label: 'Low Stock Items',    icon: Package,     color: '#7c5cf0', route: 'InventoryDashboard', alertWhenPositive: true },
  { key: 'tasks_completed',    label: 'Tasks Done (MTD)',   icon: CheckCircle, color: '#14b8a6', route: 'Projects' },
  { key: 'on_leave',           label: 'On Leave Today',     icon: Users,       color: '#6366f1', route: 'AllLeaves' },
];

const DEPT_COLORS   = [C.primary, C.blue, C.green, C.amber, '#8b5cf6', C.cyan, C.red];
const GENDER_COLORS = { male: C.blue, female: '#ec4899', 'not specified': '#9ca3af', other: C.green };
const ALERT_BG  = { high: '#fff5f5', medium: '#f5f3ff', low: '#f0f9ff', info: C.light };
const ALERT_CLR = { high: C.red, medium: C.amber, low: C.blue, info: C.primary };

const HEALTH_COLORS = {
  Excellent: C.green, Good: C.blue, Watchlist: C.amber, Critical: C.red,
  Preferred: C.green, Approved: C.blue, Blocked: C.red,
};

// 'unknown' is a real state: two of these signals used to be hardcoded green.
// A grey dot says "not measured", which is honest; a green one was not.
const TRAFFIC_ICON = { green: '🟢', amber: '🟡', red: '🔴', unknown: '⚪' };
const TRAFFIC_TITLE = {
  green: 'Healthy', amber: 'Needs attention', red: 'Action required',
  unknown: 'Not measured — the underlying data is not recorded yet',
};
const TRAFFIC_LABEL = {
  revenue: 'Revenue', profitability: 'Profitability',
  collections: 'Collections', projects: 'Projects', supply_chain: 'Supply Chain',
};

const PIE_COLORS = [C.green, C.blue, C.amber, C.red];

// Negative of `.page-content`'s padding (Layout.css --spacing-md). Used to dock this
// page's sticky header against the top of the app's scroll container — see the comment
// on the page root below for why `top: 0` alone leaves a bleed-through strip.
const PC_PAD_NEG = 'calc(var(--spacing-md, 20px) * -1)';

// Persistent KPI strip, merged in from CeoDashboard. Lives in the sticky header so the
// six headline numbers stay on screen on every tab — that persistence IS the feature.
// `projectsOnTrack` comes from /analytics/ceo/kpis, which this page already called but
// never rendered anywhere.
const KPI_STRIP = [
  { key: 'revenue',         icon: IndianRupee, color: C.green,   money: true },
  { key: 'arr',             icon: Zap,         color: C.rose,    money: true, sub: 'Active AMC contracts' },
  { key: 'headcount',       icon: Users,       color: C.blue },
  { key: 'attrition',       icon: Activity,    color: C.amber,   invert: true },
  { key: 'openPipeline',    icon: Target,      color: C.primary, money: true },
  // Derived (not stored): open, not past its end date, and within 110% of budget.
  { key: 'projectsOnTrack', icon: CheckCircle, color: C.cyan, sub: 'On schedule and within budget' },
];

// /analytics/ceo/kpis returns per-metric shapes: `unit:'%'` for rates, `outOf` for
// ratios, plain numbers otherwise. Mirrors CeoDashboard's formatter exactly so the
// strip reads identically to the page it replaces.
// `money` marks the currency tiles explicitly, so a genuine ₹0 (ARR with no AMC contracts
// on file) still renders as ₹0 rather than a bare "0" beside "₹2.4 L".
const kpiVal = (item, meta = {}) => {
  if (!item) return '—';
  if (item.unit === '%') return fmtPct(item.value);
  if (item.outOf != null) return `${item.value ?? 0}/${item.outOf ?? 0}`;
  if (meta.money) return fmtL(item.value);
  if (typeof item.value === 'number' && item.value > 10_000) return fmtL(item.value);
  return fmtNum(item.value);
};

// ── sub-components ────────────────────────────────────────────────────────────
// Arrow shows the actual direction of change; colour shows whether that direction is
// good. CeoDashboard pointed the arrow at the sentiment instead, so a falling attrition
// rate drew an up-arrow — kept the colour rule, fixed the arrow.
function GrowthChip({ growth, invert = false }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0,
    fontSize: 10, fontWeight: 700, borderRadius: 5, padding: '1px 5px', lineHeight: 1.4,
  };
  if (growth == null || growth === 0) {
    return <span style={{ ...base, background: 'rgba(156,163,175,0.14)', color: '#9ca3af' }}><Minus size={9} />—</span>;
  }
  const good = invert ? growth < 0 : growth > 0;
  const c = good ? C.green : C.red;
  const Arrow = growth > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span style={{ ...base, background: `${c}16`, color: c }}>
      <Arrow size={9} />{Math.abs(growth).toFixed(1)}%
    </span>
  );
}

function KpiStrip({ kpis }) {
  const k = kpis || {};
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))', gap: 8, marginTop: 12 }}>
      {KPI_STRIP.map(({ key, icon: Icon, color, sub, invert, money }) => {
        const item = k[key];
        return (
          <div key={key} style={{
            background: '#fff', border: `1px solid ${C.border}`, borderLeft: `3px solid ${color}`,
            borderRadius: 10, padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 3,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <Icon size={12} color={color} style={{ flexShrink: 0 }} />
                <span style={{
                  fontSize: 10, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase',
                  letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{item?.label ?? key}</span>
              </div>
              <GrowthChip growth={item?.growth} invert={invert} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' }}>
              {kpiVal(item, { money })}
            </div>
            {(item?.sub ?? sub) && <div style={{ fontSize: 10, color: '#9ca3af' }}>{item?.sub ?? sub}</div>}
          </div>
        );
      })}
    </div>
  );
}

// Client-side rule engine, merged in from CeoDashboard. `Card` is hoisted from below.
function ExecutiveAlertsCard({ insights }) {
  const cMap = { danger: C.red, warning: C.amber, success: C.green, info: C.blue };
  const bMap = { danger: '#fee2e2', warning: '#ede9fe', success: '#dcfce7', info: '#dbeafe' };
  const rows = insights || [];
  return (
    <Card
      title="Executive Alerts"
      sub="Rule-based signal detection"
      right={<ShieldCheck size={15} color={rows.length ? C.primary : C.green} />}
    >
      {rows.length === 0 ? (
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '9px 11px', background: '#f0fdf4', borderRadius: 9 }}>
          <CheckCircle size={13} color={C.green} style={{ flexShrink: 0, marginTop: 3 }} />
          <span style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>
            All key metrics are within normal range — no rule-based alerts to surface.
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {rows.map((ins, i) => (
            <div key={ins.rule ?? i} style={{
              display: 'flex', gap: 9, alignItems: 'flex-start', padding: '9px 11px',
              background: bMap[ins.type] || '#f3f4f6', borderRadius: 9,
            }}>
              <AlertCircle size={13} color={cMap[ins.type] || '#6b7280'} style={{ flexShrink: 0, marginTop: 3 }} />
              <span style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>{ins.message}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function KpiCard({ label, value, sub, color = C.primary, icon: Icon, trend, warn }) {
  // Delegates to the design-system card so this page's KPIs match every other
  // page's. Signature unchanged, so no call site needed editing.
  return <Stat label={label} value={value} sub={sub} color={color} icon={Icon} trend={trend} warn={warn} />;
}

function TrafficLight({ lights }) {
  return (
    <div style={{
      background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14,
      padding: '13px 15px',
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Business Health Signals
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Object.entries(lights || {}).map(([key, status]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>{TRAFFIC_LABEL[key] || key}</span>
            <span style={{ fontSize: 18 }} title={TRAFFIC_TITLE[status] || 'Not measured'}>
              {TRAFFIC_ICON[status] || '⚪'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionHeader({ title, sub }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: '#111827', margin: 0 }}>{title}</h2>
      {sub && <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>{sub}</p>}
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60 }}>
      <div style={{ width: 36, height: 36, border: `3px solid ${C.border}`, borderTopColor: C.primary, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
    </div>
  );
}

function HealthPieChart({ data, title }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '13px 15px' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 12 }}>{title}</div>
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <Pie data={data} dataKey="count" nameKey="label" cx="50%" cy="50%" outerRadius={70} innerRadius={40}>
            {data.map((d, i) => (
              <Cell key={d.label} fill={HEALTH_COLORS[d.label] || PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v, n) => [v, n]} />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Executive Summary Tab ─────────────────────────────────────────────────────
function ExecutiveSummaryTab({
  summary, customerSummary, vendorSummary, projectSummary,
  ceoKpis, salesKpi, insights, revChart, hasOutstanding,
  period, setPeriod, year, setYear, showYoY, setShowYoY,
}) {
  // Forecast provenance, surfaced by /ceo-intelligence/executive-summary.
  const summaryMeta = summary;
  const kpis = summary?.kpis || {};
  const lights = summary?.traffic_lights || {};
  const ck = ceoKpis || {};

  // Labelled from the response, never from a fresh `new Date()`. The window is
  // the page filter's now, so a hardcoded "FY 2026-27" here would keep claiming
  // the financial year while the numbers below showed last month.
  const fyLabel = summaryMeta?.period?.label || 'This financial year';

  const periodLabel = period === '6m' ? 'Last 6 months' : period === 'cy' ? `CY ${year}` : `FY ${year}-${String(year + 1).slice(2)}`;

  const trendChart = (h = 160) => (
    <ResponsiveContainer width="100%" height={h}>
      <AreaChart data={revChart}>
        <defs>
          <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={C.primary} stopOpacity={0.2} />
            <stop offset="95%" stopColor={C.primary} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={v => fmtL(v)} tick={{ fontSize: 10 }} width={60} />
        <Tooltip formatter={v => fmtL(v)} />
        <Legend iconSize={9} wrapperStyle={{ fontSize: 11 }} />
        <Area type="monotone" dataKey="revenue" stroke={C.primary} fill="url(#revGrad)" name="Revenue" strokeWidth={2} />
        {hasOutstanding && (
          <Area type="monotone" dataKey="outstanding" stroke={C.amber} fill="none" name="Outstanding" strokeWidth={2} strokeDasharray="4 2" />
        )}
        {showYoY && (
          <Line type="monotone" dataKey="prevRevenue" stroke="#9ca3af" strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Prior Year" />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );

  const ctrlBtn = (active) => ({
    padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700,
    border: `1px solid ${active ? C.primary : C.border}`,
    background: active ? C.primary : '#fff', color: active ? '#fff' : '#6b7280',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* KPI Grid */}
      <div>
        <SectionHeader title="Executive KPIs" sub={`Company-wide performance · ${fyLabel}`} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }}>
          {/* Revenue YTD, ARR and Pipeline Value are NOT repeated here — the
              sticky KPI strip above carries them on every tab, and rendering
              them twice on one screen invited the two copies to drift apart.
              "AMC Annual Revenue" is also gone: it ran the identical query as
              ARR and differed only in label. */}
          <KpiCard label="Revenue This Month" value={fmtL(kpis.revenue_this_month)} color={C.green} icon={IndianRupee} trend={ck.revenue?.growth} />
          <KpiCard label="Outstanding Collections" value={fmtL(kpis.outstanding_collections)} color={C.amber} icon={Clock} sub="Unpaid, excluding cancelled" warn={kpis.outstanding_collections > kpis.revenue_ytd * 0.25} />
          <KpiCard label="Avg Deal Size" value={salesKpi?.avgDealSize != null ? fmtL(salesKpi.avgDealSize) : '—'} color={C.blue} icon={ShoppingCart} sub="Won opportunities" />
          {/* The forecast names its own assumption: the backend reports whether
              the win rate was measured from closed opportunities or defaulted. */}
          <KpiCard
            label="Forecast Revenue"
            value={fmtL(kpis.forecast_revenue)}
            color={C.cyan}
            icon={Zap}
            sub={summaryMeta?.forecast_basis
              ? `Next 3 months · ${summaryMeta.forecast_is_measured ? 'measured' : 'assumed'} win rate`
              : 'Next 3 months'}
          />
          <KpiCard label="Net Cash Movement" value={fmtL(kpis.cash_position)} color={kpis.cash_position >= 0 ? C.green : C.red} icon={Shield} sub="Revenue in the selected period, less open payables" />
          <KpiCard label="Active Customers" value={fmtNum(kpis.active_customers)} color={C.primary} icon={Users} sub="With at least one invoice" />
        </div>
      </div>

      {/* Traffic Lights + Revenue Trend */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12 }}>
        <TrafficLight lights={lights} />
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '13px 15px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Revenue Trend</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>From paid invoices · {periodLabel}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button onClick={() => setShowYoY(v => !v)} style={ctrlBtn(showYoY)} title="Toggle year-over-year comparison line">YoY</button>
              {period !== '6m' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 2, border: `1px solid ${C.border}`, borderRadius: 6, padding: '2px 4px' }}>
                  <button onClick={() => setYear(y => y - 1)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 2, display: 'flex' }}><ChevronLeft size={12} color="#6b7280" /></button>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#374151', minWidth: 30, textAlign: 'center' }}>{year}</span>
                  <button onClick={() => setYear(y => y + 1)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 2, display: 'flex' }}><ChevronRight size={12} color="#6b7280" /></button>
                </div>
              )}
              <div style={{ display: 'flex', gap: 3 }}>
                {[['6m', '6M'], ['cy', 'CY'], ['fy', 'FY']].map(([val, lbl]) => (
                  <button key={val} onClick={() => setPeriod(val)} style={ctrlBtn(period === val)}>{lbl}</button>
                ))}
              </div>
              {revChart.length > 0 && (
                <ChartExpandButton title="Revenue Trend" subtitle={`From paid invoices · ${periodLabel}`}>
                  {trendChart(440)}
                </ChartExpandButton>
              )}
            </div>
          </div>
          {revChart.length === 0
            ? <div style={{ height: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 12 }}>No revenue data yet</div>
            : trendChart(150)}
        </div>
      </div>

      {/* Quick Stats Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {[
          { label: 'Total Customers', value: fmtNum(customerSummary?.total_customers), color: C.blue, icon: Users },
          { label: 'Total Vendors', value: fmtNum(vendorSummary?.total_vendors), color: C.cyan, icon: Package },
          { label: 'Active Projects', value: fmtNum(projectSummary?.active_projects), color: C.primary, icon: Briefcase },
          { label: 'Delayed Projects', value: fmtNum(projectSummary?.delayed_count), color: C.red, icon: AlertTriangle, warn: projectSummary?.delayed_count > 0 },
        ].map(k => <KpiCard key={k.label} {...k} />)}
      </div>

      {/* The Expense Breakdown donut that used to sit here has moved out.
          It ran the identical query as the CFO Dashboard's Expense Structure
          card (expense_claim_items grouped by category) and rendered the same
          numbers on a second page. Expense structure is a finance surface; the
          CEO view keeps the rule-based alerts, which are strategic. */}
      <ExecutiveAlertsCard insights={insights} />
    </div>
  );
}

// ── Customer Intelligence Tab ─────────────────────────────────────────────────
function CustomerIntelligenceTab({ data }) {
  const [view, setView] = useState('overview'); // overview | risk | growth
  const summary = data?.summary || {};
  const dist = data?.health_distribution || [];
  const customers = data?.customers || [];
  const atRisk = data?.at_risk || [];
  const growth = data?.growth_leaders || [];
  const decliners = data?.growth_decliners || [];
  const growthBasis = data?.growth_basis || null;

  const healthCards = [
    { label: 'Excellent', count: summary.excellent_count || 0, color: C.green },
    { label: 'Good',      count: summary.good_count      || 0, color: C.blue },
    { label: 'Watchlist', count: summary.watchlist_count || 0, color: C.amber },
    { label: 'Critical',  count: summary.critical_count  || 0, color: C.red },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Health Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        <KpiCard label="Total Customers" value={fmtNum(summary.total_customers)} color={C.primary} icon={Users} />
        {healthCards.map(h => (
          <KpiCard key={h.label} label={`${h.label} Customers`} value={fmtNum(h.count)} color={h.color} />
        ))}
      </div>

      {/* Sub-nav */}
      <div style={{ display: 'flex', gap: 8 }}>
        {[['overview','Top 20 Customers'], ['risk','Customer Risk Center'], ['growth','Growth Center']].map(([id, lbl]) => (
          <button key={id} onClick={() => setView(id)} style={{
            padding: '7px 16px', borderRadius: 8, border: `1px solid ${view === id ? C.primary : C.border}`,
            background: view === id ? C.primary : '#fff', color: view === id ? '#fff' : '#374151',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>{lbl}</button>
        ))}
      </div>

      {view === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16 }}>
          <CustomerTable customers={customers} />
          <HealthPieChart data={dist} title="Customer Health Distribution" />
        </div>
      )}

      {view === 'risk' && <CustomerRiskPanel atRisk={atRisk} />}
      {view === 'growth' && (
        <CustomerGrowthView growth={growth} decliners={decliners} basis={growthBasis} />
      )}
    </div>
  );
}

function CustomerTable({ customers }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, fontSize: 13, fontWeight: 700, color: '#374151' }}>
        Top 20 Customers by Revenue
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['Customer', 'Revenue', 'Outstanding', 'Margin', 'Health', 'Risk'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {customers.map((c, i) => (
              <tr key={c.id} style={{ borderBottom: `1px solid #f3f4f6`, background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                <td style={{ padding: '8px 12px', fontWeight: 600, color: '#111827' }}>{c.name}</td>
                <td style={{ padding: '8px 12px', color: C.green, fontWeight: 700 }}>{fmtL(c.revenue)}</td>
                <td style={{ padding: '8px 12px', color: c.outstanding > 0 ? C.amber : '#6b7280' }}>{fmtL(c.outstanding)}</td>
                <td style={{ padding: '8px 12px' }}>{c.margin_pct != null ? fmtPct(c.margin_pct) : '—'}</td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: `${c.health_color}18`, color: c.health_color }}>
                    {c.health_label}
                  </span>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <RiskBadge level={c.risk_level} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// One account on the growth board. The same card serves the risers and the
// fallers - only the colour and the arrow differ - so the two lists stay
// visually comparable instead of reading as unrelated widgets.
function GrowthCard({ c, onConvert, converting, converted, convertErr }) {
  const pct = c.revenue_growth_pct;
  const isNew = c.is_new_revenue;
  const up = isNew || pct > 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{c.name}</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
            {[c.city, c.state].filter(Boolean).join(', ') || '—'}
          </div>
        </div>
        {/* A customer with no billing in the prior window has no percentage to
            show - an infinite or 100% figure would be an invention. It gets a
            badge instead, and its rank comes from what it actually billed. */}
        {isNew ? (
          <span style={{
            fontSize: 11, fontWeight: 800, letterSpacing: .4, whiteSpace: 'nowrap',
            color: C.green, background: '#f0fdf4', border: '1px solid #bbf7d0',
            borderRadius: 999, padding: '3px 9px',
          }}>NEW REVENUE</span>
        ) : (
          <div style={{
            fontSize: 18, fontWeight: 800, whiteSpace: 'nowrap',
            color: up ? C.green : C.red,
            display: 'flex', alignItems: 'center', gap: 2,
          }}>
            <Arrow size={16} />
            {pct == null ? '—' : `${Math.abs(pct)}%`}
          </div>
        )}
      </div>

      {/* The two figures the percentage is computed from. Without them the
          number is unauditable, and a -100% on a small account reads exactly
          like a -100% on the largest one. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>Billed · this period</div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{fmtL(c.billed_current)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>Billed · prior period</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#6b7280' }}>{fmtL(c.billed_prior)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>Collected (period)</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.green }}>{fmtL(c.revenue)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>Health</div>
          <span style={{ fontSize: 11, fontWeight: 700, color: c.health_color }}>{c.health_label}</span>
        </div>
      </div>

      {c.upsell_opportunity && !converted && (
        <button
          onClick={() => onConvert(c)}
          disabled={converting}
          title="Create a real CRM opportunity from this signal"
          style={{
            marginTop: 8, width: '100%', padding: '6px 8px', background: '#f0fdf4',
            border: 'none', borderRadius: 6, fontSize: 11, color: C.green, fontWeight: 600,
            cursor: converting ? 'not-allowed' : 'pointer', textAlign: 'left',
          }}>
          {converting ? 'Creating opportunity…' : `Opportunity: ${c.upsell_opportunity} — Convert →`}
        </button>
      )}
      {converted && (
        <div style={{ marginTop: 8, padding: '4px 8px', background: '#eff6ff', borderRadius: 6, fontSize: 11, color: C.blue, fontWeight: 600 }}>
          ✓ Opportunity #{converted.id} created
        </div>
      )}
      {convertErr && (
        <div style={{ marginTop: 8, padding: '4px 8px', background: '#fef2f2', borderRadius: 6, fontSize: 11, color: C.red, fontWeight: 600 }}>
          {convertErr}
        </div>
      )}
    </div>
  );
}

const GROWTH_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 };

function CustomerGrowthView({ growth = [], decliners = [], basis = null }) {
  const [converting, setConverting] = useState(null);
  const [converted,  setConverted]  = useState({});
  const [convertErr, setConvertErr] = useState({});

  const convert = async (c) => {
    setConverting(c.id);
    setConvertErr(p => ({ ...p, [c.id]: null }));
    try {
      const res = await api.post(`/ceo-intelligence/customers/${c.id}/convert-upsell`, { reason: c.upsell_opportunity });
      setConverted(p => ({ ...p, [c.id]: res.data }));
    } catch (err) {
      setConvertErr(p => ({ ...p, [c.id]: err?.response?.data?.error || 'Failed to create opportunity' }));
    } finally {
      setConverting(null);
    }
  };

  const cardProps = (c) => ({
    c,
    onConvert: convert,
    converting: converting === c.id,
    converted: converted[c.id],
    convertErr: convertErr[c.id],
  });

  // `basis` names the two windows the server actually compared. It is not always
  // a year-over-year read: on a company with under a year of invoices there is no
  // year-ago period to compare against, and this panel used to sit empty behind a
  // "prior year revenue comparison needed" message rather than saying so. The
  // subtitle now states the windows that produced the numbers below.
  const sub = basis?.label || 'Year-over-year revenue growth leaders';
  const measured = basis?.measured_customers ?? (growth.length + decliners.length);
  const nothingMeasured = growth.length === 0 && decliners.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SectionHeader title="Fastest Growing Customers" sub={sub} />

      {growth.length > 0 && (
        <div style={GROWTH_GRID}>
          {growth.map(c => <GrowthCard key={c.id} {...cardProps(c)} />)}
        </div>
      )}

      {/* Every account contracting is a finding, not an absence of data. Saying
          so beats the old empty state, which was indistinguishable from a
          broken endpoint. */}
      {growth.length === 0 && !nothingMeasured && (
        <div style={{
          padding: '12px 14px', borderRadius: 10, fontSize: 12.5,
          background: '#f5f3ff', border: '1px solid #ddd6fe', color: '#5b21b6',
        }}>
          <strong>No account grew over this period.</strong>{' '}
          {measured} customer{measured === 1 ? '' : 's'} billed in one of the two windows, and every
          one of them billed less than before. The contraction is ranked below.
        </div>
      )}

      {decliners.length > 0 && (
        <>
          <SectionHeader
            title="Steepest Declines"
            sub="Same two windows — accounts whose billing fell the most"
          />
          <div style={GROWTH_GRID}>
            {decliners.map(c => <GrowthCard key={c.id} {...cardProps(c)} />)}
          </div>
        </>
      )}

      {nothingMeasured && (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
          No customer billed anything in either comparison window
          {basis ? ` (${basis.current_from} onward, and the period before it)` : ''} — there is
          no movement to rank yet.
        </div>
      )}
    </div>
  );
}

// ── Vendor Intelligence Tab ───────────────────────────────────────────────────
function VendorIntelligenceTab({ data }) {
  const [view, setView] = useState('overview');
  const summary = data?.summary || {};
  const dist = data?.health_distribution || [];
  const vendors = data?.vendors || [];
  const highRisk = data?.high_risk || [];
  const singleSource = data?.single_source_vendors || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        <KpiCard label="Total Vendors" value={fmtNum(summary.total_vendors)} color={C.primary} icon={Package} />
        <KpiCard label="Preferred" value={fmtNum(summary.preferred_count)} color={C.green} />
        <KpiCard label="Approved"  value={fmtNum(summary.approved_count)}  color={C.blue} />
        <KpiCard label="Watchlist" value={fmtNum(summary.watchlist_count)} color={C.amber} />
        <KpiCard label="Blocked"   value={fmtNum(summary.blocked_count)}   color={C.red} warn={summary.blocked_count > 0} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {[['overview','Top Vendors'], ['risk','Risk Center'], ['supplychain','Supply Chain Exposure']].map(([id, lbl]) => (
          <button key={id} onClick={() => setView(id)} style={{
            padding: '7px 16px', borderRadius: 8, border: `1px solid ${view === id ? C.primary : C.border}`,
            background: view === id ? C.primary : '#fff', color: view === id ? '#fff' : '#374151',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>{lbl}</button>
        ))}
      </div>

      {view === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16 }}>
          <VendorTable vendors={vendors} />
          <HealthPieChart data={dist} title="Vendor Health Distribution" />
        </div>
      )}
      {view === 'risk' && <VendorRiskPanel highRisk={highRisk} />}
      {view === 'supplychain' && <SupplyChainRiskPanel singleSource={singleSource} data={data} />}
    </div>
  );
}

function VendorTable({ vendors }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, fontSize: 13, fontWeight: 700, color: '#374151' }}>
        Top Vendors by Spend
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['Vendor', 'Spend', 'Score', 'Health', 'OTD %', 'Open NCRs', 'Risk'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vendors.map((v, i) => (
              <tr key={v.id} style={{ borderBottom: `1px solid #f3f4f6`, background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                <td style={{ padding: '8px 12px', fontWeight: 600, color: '#111827' }}>
                  {v.name}
                  {v.single_source && <span style={{ marginLeft: 6, fontSize: 10, background: '#ede9fe', color: '#5b21b6', padding: '1px 5px', borderRadius: 4 }}>SS</span>}
                  {v.critical_vendor && <span style={{ marginLeft: 4, fontSize: 10, background: '#fee2e2', color: '#991b1b', padding: '1px 5px', borderRadius: 4 }}>CV</span>}
                </td>
                <td style={{ padding: '8px 12px', fontWeight: 700, color: C.primary }}>{fmtL(v.po_value)}</td>
                {/* Scorecard average, merged in from CeoDashboard's "Top Vendors by Score".
                    /ceo-intelligence/vendors already returned overall_score — it was just
                    never rendered. Scale is 0–100 (backend/src/shared/vendorScore.js): this
                    cell used to read `/5` and band at 4/3/2, inferred from the seeded 1-5
                    placeholder rows rather than from the 0–100 sliders that write the table. */}
                <td style={{ padding: '8px 12px', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                             color: v.overall_score >= 90 ? C.green : v.overall_score >= 75 ? C.blue : v.overall_score >= 50 ? C.amber : C.red }}>
                  {v.overall_score > 0 ? `${Number(v.overall_score).toFixed(0)}/100` : '—'}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: `${v.health_color}18`, color: v.health_color }}>
                    {v.health_label}
                  </span>
                </td>
                <td style={{ padding: '8px 12px', color: v.on_time_delivery_pct != null && v.on_time_delivery_pct < 80 ? C.red : '#374151' }}>
                  {v.on_time_delivery_pct != null ? fmtPct(v.on_time_delivery_pct) : '—'}
                </td>
                <td style={{ padding: '8px 12px', color: v.open_ncrs > 0 ? C.red : '#6b7280' }}>{v.open_ncrs}</td>
                <td style={{ padding: '8px 12px' }}><RiskBadge level={v.risk_level} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Business Lines Tab ────────────────────────────────────────────────────────
//
// This tab used to render six fixed cards — HVDC, STATCOM, SST, Automation,
// Service, AMC — matched by exact string against `product_lines.display_name`,
// whose real values are 'ACB', 'APFC - 440V', 'MV-VAJRA' and similar. The two
// vocabularies never overlapped, so all forty-eight figures on this tab read ₹0
// permanently. The endpoint now returns the taxonomy from `product_lines`
// itself, plus an explicit coverage figure, so the tab reports how much of the
// portfolio is actually classified instead of implying the business did no work.
function BusinessLinesTab({ data }) {
  const manifest = data?.manifest || [];
  const coverage = data?.coverage || {};
  const amc      = data?.amc || {};
  const palette  = [C.primary, C.blue, C.green, C.amber, C.cyan, C.rose, '#8b5cf6', '#7c5cf0'];
  const unclassified = coverage.unclassified_projects ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeader
        title="Business Line Intelligence"
        sub="Revenue, pipeline and margin by product line — taxonomy read live from Product Setup"
      />

      {/* Classification coverage. A tab about product-line performance is only as
          good as the share of work actually tagged to a product line, so that
          share is stated up front rather than left for the reader to infer. */}
      {coverage.total_projects > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10,
          background: unclassified > 0 ? '#f5f3ff' : '#f0fdf4',
          border: `1px solid ${unclassified > 0 ? '#ddd6fe' : '#bbf7d0'}`,
          fontSize: 12, color: unclassified > 0 ? '#5b21b6' : '#166534',
        }}>
          {unclassified > 0 ? <AlertTriangle size={14} /> : <CheckCircle size={14} />}
          <span>
            {coverage.classified_projects} of {coverage.total_projects} project(s) are assigned to a product line.
            {unclassified > 0 && ` ${unclassified} unassigned project(s) appear under "Unassigned" — set a product line on each in Project Settings to attribute them.`}
          </span>
        </div>
      )}

      {amc.contracts > 0 && (
        <div style={{ fontSize: 11.5, color: '#6b7280' }}>
          AMC contracts are held at portfolio level (no product line on the contract):
          <strong style={{ color: '#111827' }}> {fmtL(amc.revenue)}</strong> across {amc.contracts} active contract(s).
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {manifest.map((bl, i) => {
          const color = bl.business_line === 'Unassigned' ? '#9ca3af' : palette[i % palette.length];
          const rows = [
            { lbl: 'Revenue',   val: fmtL(bl.revenue) },
            { lbl: 'Pipeline',  val: fmtL(bl.pipeline) },
            // Margin is only shown once cost has actually been booked — an
            // uncosted line used to render as 0% margin, which reads as a loss.
            { lbl: 'Margin',    val: bl.has_cost_data ? fmtPct(bl.margin_pct) : '—',
              muted: !bl.has_cost_data },
            { lbl: 'Projects',  val: fmtNum(bl.project_count) },
            { lbl: 'Customers', val: fmtNum(bl.customer_count) },
            { lbl: 'Opportunities', val: fmtNum(bl.opportunity_count) },
            { lbl: 'Forecast',  val: fmtL(bl.forecast) },
            { lbl: 'Profit',    val: bl.has_cost_data ? fmtL(bl.profit) : '—',
              muted: !bl.has_cost_data,
              colorOverride: bl.has_cost_data ? (bl.profit >= 0 ? C.green : C.red) : undefined },
          ];
          return (
            <div key={bl.business_line} style={{
              background: '#fff', border: `1px solid ${C.border}`,
              borderRadius: 14, padding: '13px 15px', borderLeft: `4px solid ${color}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color }}>{bl.business_line}</div>
                {!bl.has_cost_data && bl.project_count > 0 && (
                  <span style={{ fontSize: 10, color: '#9ca3af', background: '#f3f4f6', padding: '2px 7px', borderRadius: 5 }}>
                    cost not booked
                  </span>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {rows.map(({ lbl, val, colorOverride, muted }) => (
                  <div key={lbl}>
                    <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{lbl}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: muted ? '#9ca3af' : (colorOverride || '#111827') }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {manifest.length === 0 && (
          <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 40, color: '#9ca3af' }}>
            No product lines configured. Add them under Master Data → Product Setup, then assign one to each project.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Workforce Tab ─────────────────────────────────────────────────────────────
function Card({ title, sub, children, right }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '13px 15px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{title}</div>
          {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// Horizontal bar list — shared by dept workforce and both travel-cost breakdowns
function BarList({ rows, emptyMsg = 'No data', color = C.primary, colorByIndex = false }) {
  if (!rows || rows.length === 0) {
    return <div style={{ padding: '20px 0', textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>{emptyMsg}</div>;
  }
  const max = rows.reduce((m, r) => Math.max(m, r.value ?? 0), 0) || 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((r, i) => {
        const c = colorByIndex ? DEPT_COLORS[i % DEPT_COLORS.length] : color;
        // index key, not label — labels are not guaranteed unique across rows
        return (
          <div key={i}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: '#374151', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }} title={r.label}>{r.label}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: c }}>{r.display}</span>
            </div>
            <div style={{ height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(((r.value ?? 0) / max) * 100, 2)}%`, height: '100%', background: c, borderRadius: 3 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WorkforceTab({ headcount, attrition, deptWf }) {
  const hc = headcount || {};
  const at = attrition || {};
  const rate = at.rate;
  const rateColor = rate > 15 ? C.red : rate > 10 ? C.amber : C.green;

  const genderRows = Array.isArray(hc.by_gender) ? hc.by_gender : [];
  const genderTotal = genderRows.reduce((s, g) => s + (g.count ?? 0), 0) || 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeader title="Workforce Intelligence" sub="Headcount, attrition and workforce composition" />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }}>
        <KpiCard label="Total Headcount" value={fmtNum(hc.total)} color={C.primary} icon={Users} />
        <KpiCard label="Active" value={fmtNum(hc.active)} color={C.green} icon={UserCheck} />
        <KpiCard label="New Hires (MTD)" value={fmtNum(hc.newHires)} color={C.blue} icon={ArrowUpRight} />
        <KpiCard label="Departures" value={fmtNum(hc.departures)} color={C.red} icon={ArrowDownRight} />
        <KpiCard label="On Leave Today" value={fmtNum(hc.onLeave)} color={C.cyan} icon={Clock} />
        <KpiCard label="Attrition Rate" value={rate != null ? fmtPct(rate) : '—'} color={rateColor} icon={Activity} warn={rate > 15} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Attrition analysis */}
        <Card title="Attrition Analysis" sub="12-month rolling">
          <div style={{ textAlign: 'center', padding: '10px 0 14px', borderBottom: `1px solid ${C.border}`, marginBottom: 12 }}>
            <div style={{ fontSize: 34, fontWeight: 900, color: rateColor, lineHeight: 1 }}>
              {rate != null ? fmtPct(rate) : '—'}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
              Attrition Rate
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>Industry benchmark: 10–12%</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {[
              { label: 'Voluntary',   val: at.voluntary   != null ? fmtPct(at.voluntary)   : '—' },
              { label: 'Involuntary', val: at.involuntary != null ? fmtPct(at.involuntary) : '—' },
              { label: 'Avg Tenure',  val: at.avgTenure   != null ? `${Number(at.avgTenure).toFixed(1)}y` : '—' },
              { label: 'At Risk',     val: fmtNum(at.atRisk) },
            ].map(({ label, val }) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#111827' }}>{val}</div>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Gender diversity */}
        <Card title="Gender Diversity" sub="Active workforce breakdown">
          {genderRows.length === 0 ? (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>No gender data</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <PieChart width={120} height={120}>
                <Pie
                  data={genderRows.map(g => ({ name: g.gender || 'Not Specified', value: g.count ?? 0 }))}
                  cx={60} cy={60} innerRadius={32} outerRadius={54} dataKey="value" paddingAngle={2}
                >
                  {genderRows.map((g, i) => (
                    <Cell key={i} fill={GENDER_COLORS[(g.gender || '').toLowerCase()] || DEPT_COLORS[i % DEPT_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={v => [v, '']} contentStyle={{ fontSize: 11, borderRadius: 6 }} />
              </PieChart>
              <div style={{ flex: 1 }}>
                <BarList
                  rows={genderRows.map(g => ({
                    label: g.gender || 'Not Specified',
                    value: g.count ?? 0,
                    display: `${Math.round(((g.count ?? 0) / genderTotal) * 100)}% (${g.count ?? 0})`,
                  }))}
                  colorByIndex
                />
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Departmental Workforce" sub="Headcount by department">
        <BarList
          rows={(deptWf || []).slice(0, 10).map(d => ({
            label: d.dept || 'Unknown',
            value: d.headcount ?? 0,
            display: fmtNum(d.headcount ?? 0),
          }))}
          emptyMsg="No department data"
          colorByIndex
        />
      </Card>
    </div>
  );
}

// ── Operations Tab ────────────────────────────────────────────────────────────
function OperationsTab({ opsData, alerts, travelByEmp, travelByProj, onNavigate }) {
  const ops = opsData || {};
  const alertRows = Array.isArray(alerts) ? alerts : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionHeader title="Operations Command" sub="Live counts across all modules · click any tile to drill through" />

      {/* Drill-through tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {OPS_TILES.map(({ key, label, icon: Icon, color, route, alertWhenPositive }) => {
          const val = ops[key] ?? 0;
          const isAlert = alertWhenPositive && val > 0;
          return (
            <button
              key={key}
              onClick={() => onNavigate(route)}
              title={`Go to ${label}`}
              style={{
                background: '#fff', border: `1px solid ${isAlert ? color : C.border}`,
                borderRadius: 14, padding: '13px 15px', cursor: 'pointer', textAlign: 'left',
                display: 'flex', flexDirection: 'column', gap: 6, position: 'relative',
                borderLeft: `4px solid ${color}`, font: 'inherit',
              }}
            >
              <div style={{ width: 30, height: 30, borderRadius: 8, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon size={15} color={color} />
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: isAlert ? color : '#111827', lineHeight: 1.1 }}>{fmtNum(val)}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600 }}>{label}</div>
              {isAlert && <div style={{ position: 'absolute', top: 10, right: 10, width: 7, height: 7, borderRadius: '50%', background: color }} />}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* System alerts */}
        <Card
          title="System Alerts"
          sub="Pending actions requiring attention"
          right={alertRows.length > 0 && (
            <span style={{ background: C.red, color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 800, padding: '2px 7px' }}>
              {alertRows.length}
            </span>
          )}
        >
          {alertRows.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <CheckCircle size={26} color={C.green} />
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginTop: 8 }}>All systems healthy</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>No alerts requiring action</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {alertRows.map((a, i) => {
                const sev = (a.priority || a.severity || a.level || 'info').toLowerCase();
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 11px',
                    background: ALERT_BG[sev] || C.light, borderRadius: 9,
                  }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: ALERT_CLR[sev] || '#6b7280', marginTop: 5, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>{a.message || a.title || '—'}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Travel cost by employee */}
        <Card title="Travel Cost by Employee" sub="Top spenders">
          <BarList
            // travel.routes.js returns `total_spend` — NOT total_cost/amount, which is why
            // CeoDashboard's copy of these two cards always rendered ₹0.
            rows={(travelByEmp || []).slice(0, 8).map(e => {
              const amt = Number(e.total_spend ?? e.total_cost ?? e.amount ?? 0);
              return { label: e.employee_name || e.name || 'Employee', value: amt, display: fmtL(amt) };
            })}
            emptyMsg="No travel data"
            color={C.primary}
          />
        </Card>
      </div>

      <Card title="Travel Cost by Project" sub="Top projects by travel spend">
        <BarList
          rows={(travelByProj || []).slice(0, 8).map(p => {
            const amt = Number(p.total_spend ?? p.total_cost ?? p.amount ?? 0);
            // the endpoint returns no project_name — project_number alone is a bare
            // number, so qualify it with the customer when we have one
            const base = p.project_name || p.project_number || 'Project';
            return {
              label: p.customer_name ? `${base} · ${p.customer_name}` : base,
              value: amt,
              display: fmtL(amt),
            };
          })}
          emptyMsg="No travel-project data"
          color={C.cyan}
        />
      </Card>
    </div>
  );
}

// ── Shared helper ─────────────────────────────────────────────────────────────
function RiskBadge({ level }) {
  const cfg = {
    Critical: { bg: '#fee2e2', color: C.red },
    High:     { bg: '#ede9fe', color: '#5b21b6' },
    Medium:   { bg: '#ede9fe', color: '#4c1d95' },
    Low:      { bg: '#dcfce7', color: C.green },
  };
  const s = cfg[level] || cfg.Low;
  return (
    <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color }}>
      {level || 'Low'}
    </span>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function CEOIntelligenceDashboard({ setPage }) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab]       = useState('executive');
  const [warroomView, setWarroomView]   = useState('alerts'); // alerts | ai
  const [loading, setLoading]           = useState(true);
  const [lastSync, setLastSync]         = useState(null);
  const [summary, setSummary]           = useState(null);
  const [customerData, setCustomerData] = useState(null);
  const [vendorData, setVendorData]     = useState(null);
  const [projectData, setProjectData]   = useState(null);
  const [collectionData, setCollectionData] = useState(null);
  const [serviceData, setServiceData]   = useState(null);
  const [alertsData, setAlertsData]     = useState(null);
  const [manifestData, setManifestData] = useState(null);
  /* ── merged-in from CEO Dashboard ── */
  const [ceoKpis, setCeoKpis]           = useState(null);
  const [salesKpi, setSalesKpi]         = useState(null);
  const [salesTargets, setSalesTargets] = useState([]);
  const [pipeStages, setPipeStages]     = useState([]);
  const [headcount, setHeadcount]       = useState(null);
  const [attrition, setAttrition]       = useState(null);
  const [deptWf, setDeptWf]             = useState([]);
  const [opsData, setOpsData]           = useState(null);
  const [sysAlerts, setSysAlerts]       = useState([]);
  const [travelByEmp, setTravelByEmp]   = useState([]);
  const [travelByProj, setTravelByProj] = useState([]);
  /* ── revenue period / YoY ── */
  // Named failures. Every call on this page used `.catch(nil)`, which turned a
  // 500, a 403 and a genuinely empty response into the same `null` — so a reader
  // could not tell a broken endpoint from a quiet business day.
  const [failures, setFailures]   = useState([]);
  const [revSeries, setRevSeries] = useState([]);
  // Revenue Trend's own 6M/CY/FY control. Distinct from the page filter below:
  // it drives /dashboard/revenue, which keeps the legacy 6m|cy|fy vocabulary the
  // shared contract preserved on purpose (§107) — do not merge the two.
  const [period, setPeriod]       = useState('6m');
  const [year, setYear]           = useState(new Date().getFullYear());
  const [showYoY, setShowYoY]     = useState(false);

  // The page filter. `params` is memoised on its values, so it is safe as the
  // `load` dependency — it only changes identity when a filter actually changes.
  const filters = useDashboardFilters({ defaultPeriod: 'fytd', storageKey: 'ceo-intelligence' });
  const { params } = filters;

  const abortRef = useRef(null);

  // Drill-through: prefer the injected page-switcher, fall back to the router
  const go = useCallback((page) => {
    if (typeof setPage === 'function') setPage(page);
    else navigate(`/${page}`);
  }, [setPage, navigate]);

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    // Records which call failed and why, instead of discarding the error.
    const problems = [];
    const track = (label) => (err) => {
      problems.push({
        label,
        status: err?.response?.status ?? 0,
        forbidden: err?.response?.status === 403,
      });
      return { data: null };
    };
    try {
      const [
        exec, cust, vend, proj, coll, svc, alerts, mfst,
        ck, sales, pipe, tgts, hc, attr, dept, ops, sysAlert, tEmp, tProj,
      ] = await Promise.all([
        // `params` goes only to the endpoints whose numbers are period ACTIVITY.
        // Collections aging, AMC expiry and the strategic alerts are backlog —
        // work awaiting action — and a narrow period must never hide it, so they
        // are called unfiltered on purpose (§107's activity/backlog rule).
        api.get('/ceo-intelligence/executive-summary', { params }).catch(track('Executive summary')),
        api.get('/ceo-intelligence/customers', { params }).catch(track('Customer intelligence')),
        api.get('/ceo-intelligence/vendors', { params }).catch(track('Vendor intelligence')),
        api.get('/ceo-intelligence/projects', { params }).catch(track('Project profitability')),
        api.get('/ceo-intelligence/collections').catch(track('Collections aging')),
        api.get('/ceo-intelligence/service-amc').catch(track('Service & AMC')),
        api.get('/ceo-intelligence/strategic-alerts').catch(track('Strategic alerts')),
        api.get('/ceo-intelligence/manifest', { params }).catch(track('Business lines')),
        api.get('/analytics/ceo/kpis').catch(track('Headline KPIs')),
        api.get('/analytics/sales').catch(track('Sales KPIs')),
        // Pipeline stages. /dashboard/sales is the source CeoDashboard used and the one that
        // actually exists — /sales-command-center/pipeline has never been a route.
        api.get('/dashboard/sales').catch(track('Pipeline stages')),
        // Real sales targets for the rule engine (CeoDashboard hardcoded ₹35L here).
        // The route is /team-targets; a plain /targets 404s.
        api.get('/sales-command-center/team-targets').catch(track('Sales targets')),
        api.get('/analytics/headcount').catch(track('Headcount')),
        api.get('/analytics/attrition').catch(track('Attrition')),
        api.get('/analytics/dept-workforce').catch(track('Department workforce')),
        api.get('/dashboard/operations').catch(track('Operations counters')),
        api.get('/dashboard/alerts').catch(track('System alerts')),
        api.get('/travel/analytics/by-employee').catch(track('Travel by employee')),
        api.get('/travel/analytics/by-project').catch(track('Travel by project')),
      ]);
      if (ctrl.signal.aborted) return;
      setSummary(exec.data);
      setCustomerData(cust.data);
      setVendorData(vend.data);
      setProjectData(proj.data);
      setCollectionData(coll.data);
      setServiceData(svc.data);
      setAlertsData(alerts.data);
      setManifestData(mfst.data);

      setCeoKpis(ck.data?.kpis ?? null);
      setSalesKpi(sales.data?.data ?? null);
      setPipeStages(Array.isArray(pipe.data?.stages) ? pipe.data.stages : []);
      setSalesTargets(Array.isArray(tgts.data) ? tgts.data : []);
      setHeadcount(hc.data?.data ?? null);
      setAttrition(attr.data?.data ?? null);
      setDeptWf(Array.isArray(dept.data?.data) ? dept.data.data : []);
      setOpsData(ops.data ?? null);
      setSysAlerts(Array.isArray(sysAlert.data?.alerts) ? sysAlert.data.alerts : []);

      setTravelByEmp(Array.isArray(tEmp.data) ? tEmp.data : []);
      setTravelByProj(Array.isArray(tProj.data) ? tProj.data : []);
      setFailures(problems);
      setLastSync(new Date());
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [params]);

  // Revenue series reloads on its own whenever period / year / YoY change
  const loadRevenue = useCallback(async () => {
    const params = new URLSearchParams({ period, year: String(year) });
    if (showYoY) params.set('compare', 'true');
    const r = await api.get(`/dashboard/revenue?${params.toString()}`).catch(() => ({ data: {} }));
    const raw = r?.data ?? {};
    if (Array.isArray(raw.months) && raw.months.length) {
      const shorts = Array.isArray(raw.shortMonths) ? raw.shortMonths : raw.months.map(m => String(m).split(' ')[0]);
      setRevSeries(shorts.map((m, i) => ({
        month: m,
        revenue: raw.values?.[i] ?? 0,
        ...(showYoY && Array.isArray(raw.prevValues) && raw.prevValues.length
          ? { prevRevenue: raw.prevValues[i] ?? 0 }
          : {}),
      })));
    } else {
      setRevSeries([]);
    }
  }, [period, year, showYoY]);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);
  useEffect(() => { loadRevenue(); }, [loadRevenue]);

  // Overlay the outstanding series (only executive-summary carries it) onto the
  // 6-month view; fall back to that trend entirely if /dashboard/revenue is empty.
  const execTrend = summary?.revenue_trend || [];
  const shortOf = (ym) => {
    const mi = parseInt(String(ym).split('-')[1], 10) - 1;
    return mi >= 0 && mi < 12 ? MONTH_SHORT[mi] : String(ym);
  };
  let revChart;
  if (period === '6m' && revSeries.length === 0) {
    revChart = execTrend.map(r => ({ month: shortOf(r.month), revenue: r.revenue, outstanding: r.outstanding }));
  } else if (period === '6m') {
    const outMap = Object.fromEntries(execTrend.map(r => [shortOf(r.month), r.outstanding]));
    revChart = revSeries.map(r => ({ ...r, outstanding: outMap[r.month] }));
  } else {
    revChart = revSeries;
  }

  // Rule engine merged in from CeoDashboard — but fed live data. CeoDashboard passed
  // salesTarget as the literal 3_500_000, projectsAtRisk as the literal 0 (so that rule
  // could never fire) and mapped department *headcount* into a field named `utilization`.
  // Here the target is summed from real per-salesperson targets and at-risk is the real
  // project health count. Inputs we genuinely don't have (burn rate, offer acceptance,
  // dept utilisation) are left out — every rule guards on `!= null`, so they self-suppress
  // rather than firing against invented numbers.
  const insights = useMemo(() => {
    const projects = projectData?.projects || [];
    const projectsAtRisk = projects.length
      ? projects.filter(p => p.health_label === 'At Risk' || p.health_label === 'Critical').length
      : projectData?.summary?.delayed_count;
    const targetTotal = (Array.isArray(salesTargets) ? salesTargets : [])
      .reduce((s, t) => s + (parseFloat(t.target_revenue) || 0), 0);
    return generateInsights({
      attritionRate:  attrition?.rate,
      revenueGrowth:  ceoKpis?.revenue?.growth,
      pipelineValue:  ceoKpis?.openPipeline?.value,
      salesTarget:    targetTotal > 0 ? targetTotal : null,
      projectsAtRisk,
    });
  }, [attrition, ceoKpis, projectData, salesTargets]);

  const alertCount = alertsData?.counts?.red || 0;
  const subNavBtn = (active) => ({
    padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600,
    border: `1px solid ${active ? C.primary : C.border}`,
    background: active ? C.primary : '#fff', color: active ? '#fff' : '#374151',
  });

  return (
    // `.page-content` (the app's one scroll container) pays --spacing-md of padding on
    // every side, and a sticky element's constraint rect is the scroll container's
    // CONTENT box — not its padding box. So `top: 0` pinned the header 20px BELOW the
    // top of the scrollport and the tab content scrolled through that 20px strip, above
    // the heading. Cancelling the container's top padding here and matching it on the
    // header's `top` docks the header flush with the scrollport, with no gap to bleed
    // through and no jump between rest and stuck. Top only — the left/right/bottom
    // padding is left alone so the page keeps its current gutters.
    // minHeight is '100%', not '100vh': this lives inside `.page-content`, which is
    // already 100vh minus the topbar minus its own padding. '100vh' overshot that by
    // ~104px and gave even an empty tab a phantom scrollbar.
    // The alert and refresh buttons sit in the hero band beside the title; the ten
    // tabs get a strip of their own underneath. Sharing one flex row meant the tabs
    // started after whatever width those two buttons and the title block had already
    // taken, and the last two — War Room and Business Lines — wrapped onto a second
    // line. With the strip spanning the full dock width all ten sit on one row.
    <PageShell dock={<>
      <PageHero
        icon={LayoutDashboard}
        eyebrow="Analytics"
        title="CEO Intelligence Dashboard"
        subtitle="Strategic Executive View · Customer & Vendor Intelligence"
        actions={<>
          {alertCount > 0 && (
            <button className="plh-cta plh-cta--ghost" onClick={() => setActiveTab('warroom')}>
              <AlertTriangle size={14} /> {alertCount} Red Alert{alertCount !== 1 ? 's' : ''}
            </button>
          )}
          <button className="plh-cta plh-cta--ghost" onClick={load} disabled={loading}>
            <RefreshCw size={13} style={{ animation: loading ? 'spin 0.8s linear infinite' : 'none' }} />
            Refresh
          </button>
        </>}
      />
      <div className="tax-tabs ceo-tabs" role="tablist">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          const isWarRoom = tab.id === 'warroom' && alertCount > 0;
          return (
            <button
              key={tab.id}
              className={`tax-tab${isActive ? ' is-on' : ''}`}
              role="tab"
              aria-selected={isActive}
              title={tab.title}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={14} style={{ flexShrink: 0 }} />
              <span className="ceo-tab-lbl">{tab.label}</span>
              {isWarRoom && <span className="ceo-tab-badge">{alertCount}</span>}
            </button>
          );
        })}
      </div>
      <DashboardFilterBar
        filters={filters}
        actions={
          <span
            className="ceo-filter-note"
            title={'Period-driven: Executive revenue, Customer intelligence, Vendor spend, '
                 + 'Projects and Business Lines. '
                 + 'Point-in-time by design: Collections aging, Service & AMC and Strategic '
                 + 'Alerts — these are work awaiting action, and a narrow period must not hide it.'}
          >
            Applies to activity — collections, AMC and alerts stay point-in-time
          </span>
        }
      />
    </>}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        /* One row, always. Tabs share the leftover width rather than wrapping —
           the label ellipsises long before a tab is pushed to a second line. */
        .ceo-tabs { margin-bottom: 12px; flex-wrap: nowrap; }
        .ceo-tabs .tax-tab { flex: 1 1 auto; min-width: 0; justify-content: center; padding: 7px 10px; }
        .ceo-tabs .ceo-tab-lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ceo-tabs .ceo-tab-badge {
          background: ${C.red}; color: #fff; border-radius: 10px;
          font-size: 10px; font-weight: 800; padding: 1px 5px; flex-shrink: 0;
        }
        /* Too narrow to squeeze ten tabs into: stop shrinking and let the strip
           scroll, which beats ten unreadable stubs. */
        @media (max-width: 900px) {
          .ceo-tabs .tax-tab { flex: 0 0 auto; }
        }
        /* Names what the period does and does not move, so a tab whose numbers
           deliberately ignore it doesn't read as a filter that failed. */
        .ceo-filter-note { font-size: 11px; color: #9ca3af; line-height: 1.3; max-width: 620px; cursor: help; }
        @media (max-width: 1200px) { .ceo-filter-note { display: none; } }
      `}</style>


      {/* Content */}
      <div style={{ padding: '14px 18px 20px' }}>
        {/* Failed sections are named. Without this, a 403 on the finance-backed
            panels looked identical to a company with no invoices. */}
        {!loading && failures.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 14px',
            borderRadius: 10, marginBottom: 14, fontSize: 12.5,
            background: '#f5f3ff', border: '1px solid #ddd6fe', color: '#5b21b6',
          }}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <strong>{failures.length} section{failures.length > 1 ? 's' : ''} could not load.</strong>{' '}
              {failures.some(f => f.forbidden)
                ? 'Some of this data is restricted for your role — it is not missing.'
                : 'These are showing empty because the request failed, not because there is no data.'}
              <div style={{ marginTop: 4, color: '#4c1d95' }}>
                {failures.map(f => `${f.label}${f.status ? ` (${f.status})` : ''}`).join(' · ')}
              </div>
            </div>
          </div>
        )}
        {loading ? (
          <LoadingSpinner />
        ) : (
          <>
            {activeTab === 'executive' && (
              <ExecutiveSummaryTab
                summary={summary}
                customerSummary={customerData?.summary}
                vendorSummary={vendorData?.summary}
                projectSummary={projectData?.summary}
                ceoKpis={ceoKpis}
                salesKpi={salesKpi}
                insights={insights}
                revChart={revChart}
                hasOutstanding={period === '6m'}
                period={period} setPeriod={setPeriod}
                year={year} setYear={setYear}
                showYoY={showYoY} setShowYoY={setShowYoY}
              />
            )}
            {activeTab === 'customers' && <CustomerIntelligenceTab data={customerData} />}
            {activeTab === 'sales' && (
              <RevenueForecastPanel
                summary={summary}
                customerData={customerData}
                pipeStages={pipeStages}
                salesKpi={salesKpi}
                teamTargets={salesTargets}
              />
            )}
            {activeTab === 'vendors' && <VendorIntelligenceTab data={vendorData} />}
            {activeTab === 'projects' && <ProjectProfitabilityPanel data={projectData} />}
            {activeTab === 'collections' && <CollectionRiskPanel data={collectionData} serviceData={serviceData} />}
            {activeTab === 'workforce' && (
              <WorkforceTab headcount={headcount} attrition={attrition} deptWf={deptWf} />
            )}
            {activeTab === 'operations' && (
              <OperationsTab
                opsData={opsData}
                alerts={sysAlerts}
                travelByEmp={travelByEmp}
                travelByProj={travelByProj}
                onNavigate={go}
              />
            )}
            {activeTab === 'warroom' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={() => setWarroomView('alerts')} style={subNavBtn(warroomView === 'alerts')}>Strategic Alerts</button>
                  <button onClick={() => setWarroomView('ai')} style={subNavBtn(warroomView === 'ai')}>AI Insights</button>
                  {/* LLM brief merged in from CeoDashboard — distinct from the rule-based
                      insights above it, so it gets its own label rather than sharing one. */}
                  <button onClick={() => setWarroomView('gpt')} style={subNavBtn(warroomView === 'gpt')}>GPT Executive Brief</button>
                </div>
                {warroomView === 'alerts' && <StrategicAlertsPanel data={alertsData} onRefresh={load} />}
                {warroomView === 'ai' && <AIInsightsPanel />}
                {warroomView === 'gpt' && (
                  <AIInsightCard dashboardData={{
                    kpis: ceoKpis, hc: headcount, attrition, salesKPI: salesKpi,
                    opsData, execSummary: summary?.kpis,
                  }} />
                )}
              </div>
            )}
            {activeTab === 'manifest' && <BusinessLinesTab data={manifestData} />}
          </>
        )}
      </div>
    </PageShell>
  );
}
