// frontend/src/features/analytics/pages/CEOIntelligenceDashboard.jsx
// Phase 49H — CEO Customer & Vendor Intelligence Dashboard
// 16-section strategic executive view across 8 tabs
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import {
  RefreshCw, TrendingUp, TrendingDown, IndianRupee, Users, ShoppingCart,
  AlertTriangle, CheckCircle, Activity, Target, Zap, BarChart2,
  Briefcase, ArrowUpRight, ArrowDownRight, Clock, Shield, Package,
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
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
  green: '#16a34a', red: '#dc2626', amber: '#d97706', blue: '#2563eb',
  cyan: '#0891b2', rose: '#e11d48',
};

const TABS = [
  { id: 'executive',   label: 'Executive Summary',    icon: Activity },
  { id: 'customers',   label: 'Customer Intelligence', icon: Users },
  { id: 'sales',       label: 'Sales Command',         icon: TrendingUp },
  { id: 'vendors',     label: 'Vendor Intelligence',   icon: Package },
  { id: 'projects',    label: 'Projects & P&L',        icon: Briefcase },
  { id: 'collections', label: 'Collections & AMC',     icon: IndianRupee },
  { id: 'warroom',     label: 'War Room',              icon: AlertTriangle },
  { id: 'manifest',    label: 'Business Lines',        icon: BarChart2 },
];

const HEALTH_COLORS = {
  Excellent: C.green, Good: C.blue, Watchlist: C.amber, Critical: C.red,
  Preferred: C.green, Approved: C.blue, Blocked: C.red,
};

const TRAFFIC_ICON = { green: '🟢', amber: '🟡', red: '🔴' };
const TRAFFIC_LABEL = {
  revenue: 'Revenue', profitability: 'Profitability',
  collections: 'Collections', projects: 'Projects', supply_chain: 'Supply Chain',
};

const PIE_COLORS = [C.green, C.blue, C.amber, C.red];

// ── sub-components ────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = C.primary, icon: Icon, trend, warn }) {
  const activeColor = warn ? C.red : color;
  return (
    <div style={{
      background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14,
      padding: '13px 15px', borderLeft: `4px solid ${activeColor}`,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        {Icon && (
          <div style={{ width: 32, height: 32, borderRadius: 8, background: `${activeColor}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon size={16} color={activeColor} />
          </div>
        )}
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color: activeColor, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af' }}>{sub}</div>}
      {trend !== undefined && trend !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, marginTop: 4 }}>
          {trend >= 0
            ? <ArrowUpRight size={13} color={C.green} />
            : <ArrowDownRight size={13} color={C.red} />}
          <span style={{ color: trend >= 0 ? C.green : C.red, fontWeight: 700 }}>{Math.abs(trend).toFixed(1)}%</span>
          <span style={{ color: '#9ca3af' }}>vs last period</span>
        </div>
      )}
    </div>
  );
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
            <span style={{ fontSize: 18 }}>{TRAFFIC_ICON[status] || '⚪'}</span>
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
function ExecutiveSummaryTab({ summary, customerSummary, vendorSummary, projectSummary }) {
  const kpis = summary?.kpis || {};
  const lights = summary?.traffic_lights || {};
  const trend = summary?.revenue_trend || [];

  const fyLabel = (() => {
    const m = new Date().getMonth();
    const y = new Date().getFullYear();
    const fy = m >= 3 ? y : y - 1;
    return `FY ${fy}-${String(fy + 1).slice(2)}`;
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* KPI Grid */}
      <div>
        <SectionHeader title="Executive KPIs" sub={`Company-wide performance · ${fyLabel}`} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10 }}>
          <KpiCard label="Revenue This Month" value={fmtL(kpis.revenue_this_month)} color={C.green} icon={IndianRupee} />
          <KpiCard label="Revenue YTD" value={fmtL(kpis.revenue_ytd)} color={C.primary} icon={TrendingUp} sub={fyLabel} />
          <KpiCard label="Outstanding Collections" value={fmtL(kpis.outstanding_collections)} color={C.amber} icon={Clock} warn={kpis.outstanding_collections > kpis.revenue_ytd * 0.25} />
          <KpiCard label="Pipeline Value" value={fmtL(kpis.pipeline_value)} color={C.blue} icon={Target} />
          <KpiCard label="Forecast Revenue" value={fmtL(kpis.forecast_revenue)} color={C.cyan} icon={Zap} sub="Next 3 months" />
          <KpiCard label="Cash Position" value={fmtL(kpis.cash_position)} color={kpis.cash_position >= 0 ? C.green : C.red} icon={Shield} />
          <KpiCard label="AMC Annual Revenue" value={fmtL(kpis.amc_revenue_annual)} color={C.rose} icon={Activity} />
          <KpiCard label="Active Customers" value={fmtNum(kpis.active_customers)} color={C.primary} icon={Users} />
        </div>
      </div>

      {/* Traffic Lights + Revenue Trend */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12 }}>
        <TrafficLight lights={lights} />
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '13px 15px' }}>
          {(() => {
            const trendChart = (h = 160) => (
              <ResponsiveContainer width="100%" height={h}>
                <AreaChart data={trend}>
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
                  <Area type="monotone" dataKey="revenue" stroke={C.primary} fill="url(#revGrad)" name="Revenue" strokeWidth={2} />
                  <Area type="monotone" dataKey="outstanding" stroke={C.amber} fill="none" name="Outstanding" strokeWidth={2} strokeDasharray="4 2" />
                </AreaChart>
              </ResponsiveContainer>
            );
            return (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Revenue Trend (6 Months)</div>
                  {trend.length > 0 && (
                    <ChartExpandButton title="Revenue Trend" subtitle="Revenue vs outstanding · last 6 months">
                      {trendChart(440)}
                    </ChartExpandButton>
                  )}
                </div>
                {trendChart(150)}
              </>
            );
          })()}
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
      {view === 'growth' && <CustomerGrowthView growth={growth} />}
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

function CustomerGrowthView({ growth }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SectionHeader title="Fastest Growing Customers" sub="Year-over-year revenue growth leaders" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {growth.map((c, i) => (
          <div key={c.id} style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{c.name}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{c.city || ''} {c.state || ''}</div>
              </div>
              <div style={{
                fontSize: 18, fontWeight: 800,
                color: c.revenue_growth_pct > 0 ? C.green : C.red,
                display: 'flex', alignItems: 'center', gap: 2,
              }}>
                {c.revenue_growth_pct > 0 ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}
                {Math.abs(c.revenue_growth_pct)}%
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
              <div><div style={{ fontSize: 10, color: '#9ca3af' }}>Revenue</div><div style={{ fontSize: 13, fontWeight: 700 }}>{fmtL(c.revenue)}</div></div>
              <div><div style={{ fontSize: 10, color: '#9ca3af' }}>Health</div>
                <span style={{ fontSize: 11, fontWeight: 700, color: c.health_color }}>{c.health_label}</span>
              </div>
            </div>
            {c.upsell_opportunity && (
              <div style={{ marginTop: 8, padding: '4px 8px', background: '#f0fdf4', borderRadius: 6, fontSize: 11, color: C.green, fontWeight: 600 }}>
                Opportunity: {c.upsell_opportunity}
              </div>
            )}
          </div>
        ))}
        {growth.length === 0 && (
          <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 40, color: '#9ca3af' }}>
            No growth data available — prior year revenue comparison needed.
          </div>
        )}
      </div>
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
              {['Vendor', 'Spend', 'Health', 'OTD %', 'Open NCRs', 'Risk'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vendors.map((v, i) => (
              <tr key={v.id} style={{ borderBottom: `1px solid #f3f4f6`, background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                <td style={{ padding: '8px 12px', fontWeight: 600, color: '#111827' }}>
                  {v.name}
                  {v.single_source && <span style={{ marginLeft: 6, fontSize: 10, background: '#fef3c7', color: '#92400e', padding: '1px 5px', borderRadius: 4 }}>SS</span>}
                  {v.critical_vendor && <span style={{ marginLeft: 4, fontSize: 10, background: '#fee2e2', color: '#991b1b', padding: '1px 5px', borderRadius: 4 }}>CV</span>}
                </td>
                <td style={{ padding: '8px 12px', fontWeight: 700, color: C.primary }}>{fmtL(v.po_value)}</td>
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

// ── Manifest Tab ──────────────────────────────────────────────────────────────
function ManifestTab({ data }) {
  const manifest = data?.manifest || [];
  const BL_COLORS = { HVDC: '#6B3FDB', STATCOM: '#2563eb', SST: '#16a34a', Automation: '#d97706', Service: '#0891b2', AMC: '#e11d48', Other: '#9ca3af' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionHeader title="Business Line Intelligence" sub="Revenue, pipeline, margin and forecast by product line" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
        {manifest.map(bl => {
          const color = BL_COLORS[bl.business_line] || C.primary;
          return (
            <div key={bl.business_line} style={{
              background: '#fff', border: `1px solid ${C.border}`,
              borderRadius: 14, padding: '13px 15px', borderLeft: `4px solid ${color}`,
            }}>
              <div style={{ fontSize: 15, fontWeight: 800, color, marginBottom: 12 }}>{bl.business_line}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {[
                  { lbl: 'Revenue', val: fmtL(bl.revenue) },
                  { lbl: 'Pipeline', val: fmtL(bl.pipeline) },
                  { lbl: 'Margin', val: fmtPct(bl.margin_pct) },
                  { lbl: 'Projects', val: fmtNum(bl.project_count) },
                  { lbl: 'Customers', val: fmtNum(bl.customer_count) },
                  { lbl: 'AMC Revenue', val: fmtL(bl.amc_revenue) },
                  { lbl: 'Forecast', val: fmtL(bl.forecast) },
                  { lbl: 'Profit', val: fmtL(bl.profit), colorOverride: bl.profit >= 0 ? C.green : C.red },
                ].map(({ lbl, val, colorOverride }) => (
                  <div key={lbl}>
                    <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{lbl}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: colorOverride || '#111827' }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {manifest.length === 0 && (
          <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 40, color: '#9ca3af' }}>
            No business line data. Assign product_line to projects in project settings.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared helper ─────────────────────────────────────────────────────────────
function RiskBadge({ level }) {
  const cfg = {
    Critical: { bg: '#fee2e2', color: C.red },
    High:     { bg: '#fef3c7', color: '#92400e' },
    Medium:   { bg: '#fef9c3', color: '#78350f' },
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
export default function CEOIntelligenceDashboard({ setPage }) {
  const [activeTab, setActiveTab]       = useState('executive');
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
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const [exec, cust, vend, proj, coll, svc, alerts, mfst] = await Promise.all([
        api.get('/ceo-intelligence/executive-summary').catch(() => ({ data: null })),
        api.get('/ceo-intelligence/customers').catch(() => ({ data: null })),
        api.get('/ceo-intelligence/vendors').catch(() => ({ data: null })),
        api.get('/ceo-intelligence/projects').catch(() => ({ data: null })),
        api.get('/ceo-intelligence/collections').catch(() => ({ data: null })),
        api.get('/ceo-intelligence/service-amc').catch(() => ({ data: null })),
        api.get('/ceo-intelligence/strategic-alerts').catch(() => ({ data: null })),
        api.get('/ceo-intelligence/manifest').catch(() => ({ data: null })),
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
      setLastSync(new Date());
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const alertCount = alertsData?.counts?.red || 0;

  return (
    <div style={{ minHeight: '100vh', background: '#f8f7ff', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ background: '#fff', borderBottom: `1px solid ${C.border}`, padding: '12px 18px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 900, color: '#111827', margin: 0, letterSpacing: '-0.5px' }}>
              CEO Intelligence Dashboard
            </h1>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
              Strategic Executive View · Customer & Vendor Intelligence
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {alertCount > 0 && (
              <button onClick={() => setActiveTab('warroom')} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
                background: '#fee2e2', border: `1px solid ${C.red}`, borderRadius: 8,
                color: C.red, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}>
                <AlertTriangle size={14} /> {alertCount} Red Alert{alertCount !== 1 ? 's' : ''}
              </button>
            )}
            {lastSync && (
              <span style={{ fontSize: 11, color: '#9ca3af' }}>
                Synced {lastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <button onClick={load} disabled={loading} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px',
              background: C.primary, border: 'none', borderRadius: 8,
              color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>
              <RefreshCw size={13} style={{ animation: loading ? 'spin 0.8s linear infinite' : 'none' }} />
              Refresh
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginTop: 14, overflowX: 'auto' }}>
          {TABS.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            const isWarRoom = tab.id === 'warroom' && alertCount > 0;
            return (
              <button key={tab.id} role="tab" aria-selected={isActive} onClick={() => setActiveTab(tab.id)} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px',
                borderRadius: 8, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                background: isActive ? C.primary : isWarRoom ? '#fee2e2' : 'transparent',
                color: isActive ? '#fff' : isWarRoom ? C.red : '#6b7280',
                fontSize: 12, fontWeight: isActive ? 700 : 500,
              }}>
                <Icon size={13} />
                {tab.label}
                {tab.id === 'warroom' && alertCount > 0 && (
                  <span style={{ background: C.red, color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 800, padding: '1px 5px' }}>{alertCount}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: '14px 18px 20px' }}>
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
              />
            )}
            {activeTab === 'customers' && <CustomerIntelligenceTab data={customerData} />}
            {activeTab === 'sales' && <RevenueForecastPanel summary={summary} customerData={customerData} />}
            {activeTab === 'vendors' && <VendorIntelligenceTab data={vendorData} />}
            {activeTab === 'projects' && <ProjectProfitabilityPanel data={projectData} />}
            {activeTab === 'collections' && <CollectionRiskPanel data={collectionData} serviceData={serviceData} />}
            {activeTab === 'warroom' && <StrategicAlertsPanel data={alertsData} onRefresh={load} />}
            {activeTab === 'manifest' && <ManifestTab data={manifestData} />}
          </>
        )}
      </div>
    </div>
  );
}
