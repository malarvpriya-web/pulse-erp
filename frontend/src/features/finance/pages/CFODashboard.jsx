import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell, PieChart, Pie, ReferenceLine
} from 'recharts';
import {
  TrendingUp, TrendingDown, IndianRupee, AlertTriangle,
  CheckCircle, RefreshCw, Maximize2, X, ArrowUpRight,
  ArrowDownRight, Briefcase, CreditCard, BarChart2, Activity,
  Info
} from 'lucide-react';
import api from '@/services/api/client';
import { fmt } from '../financeUtils';
import { useFY } from '@/context/FYContext';
import FYSelector from '@/components/core/FYSelector';
import './CFODashboard.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899','#14b8a6'];

const fmtCr = (n) => {
  const v = parseFloat(n || 0);
  return v >= 10000000 ? `₹${(v / 10000000).toFixed(2)} Cr`
       : v >= 100000   ? `₹${(v / 100000).toFixed(2)} L`
       : `₹${v.toLocaleString('en-IN')}`;
};

const pct = (a, b) => b ? ((a / b) * 100).toFixed(1) : '0.0';

const Trend = ({ value, suffix = '%', invert = false }) => {
  const positive = invert ? value <= 0 : value >= 0;
  return (
    <span className={`cfo-trend ${positive ? 'up' : 'down'}`}>
      {positive ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {Math.abs(value).toFixed(1)}{suffix}
    </span>
  );
};

const Modal = ({ title, onClose, children }) => (
  <div className="cfo-overlay" onClick={onClose}>
    <div className="cfo-modal" onClick={e => e.stopPropagation()}>
      <div className="cfo-modal-hd">
        <h3>{title}</h3>
        <button className="cfo-icon-btn" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="cfo-modal-body">{children}</div>
    </div>
  </div>
);

const Card = ({ title, sub, children, expand, className = '' }) => (
  <div className={`cfo-card ${className}`}>
    <div className="cfo-card-hd">
      <div>
        <span className="cfo-card-title">{title}</span>
        {sub && <span className="cfo-card-sub"> · {sub}</span>}
      </div>
      {expand && (
        <button className="cfo-icon-btn" onClick={expand}><Maximize2 size={13} /></button>
      )}
    </div>
    {children}
  </div>
);

// ── Gauge component ───────────────────────────────────────────────────────────
const Gauge = ({ value, label, color }) => {
  const pctVal = Math.min(Math.max(value, 0), 100);
  const r = 54, cx = 70, cy = 70;
  const circumference = Math.PI * r;
  const dash = (pctVal / 100) * circumference;
  return (
    <div className="cfo-gauge">
      <svg width="140" height="80" viewBox="0 0 140 80">
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none" stroke="#f3f4f6" strokeWidth="12" strokeLinecap="round" />
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`} />
        <text x={cx} y={cy - 8} textAnchor="middle" fontSize="18" fontWeight="700" fill="#111827">
          {pctVal.toFixed(0)}%
        </text>
        <text x={cx} y={cy + 8} textAnchor="middle" fontSize="10" fill="#9ca3af">{label}</text>
      </svg>
    </div>
  );
};

// ── Waterfall chart ───────────────────────────────────────────────────────────
const buildWaterfallBars = (data) => {
  let running = 0;
  return data.map(d => {
    const base = d.type === 'total' ? 0 : running;
    if (d.type !== 'total') running += d.value;
    return { ...d, base, display: Math.abs(d.value) };
  });
};

const WaterfallChart = ({ data }) => {
  const bars = buildWaterfallBars(data);
  const maxVal = Math.max(...bars.map(b => b.base + b.display), 1);
  return (
    <div className="cfo-waterfall">
      {bars.map((b, i) => {
        const heightPct = (b.display / maxVal) * 100;
        const bottomPct = (b.base / maxVal) * 100;
        const color = b.type === 'total' ? '#6366f1'
                    : b.value >= 0       ? '#10b981' : '#ef4444';
        return (
          <div key={i} className="cfo-wf-col">
            <div className="cfo-wf-bar-wrap">
              <div className="cfo-wf-spacer" style={{ height: `${100 - bottomPct - heightPct}%` }} />
              <div className="cfo-wf-bar" style={{ height: `${heightPct}%`, background: color }} />
              <div className="cfo-wf-base" style={{ height: `${bottomPct}%` }} />
            </div>
            <div className="cfo-wf-val" style={{ color }}>
              {b.value >= 0 ? '+' : ''}{fmt(b.value)}
            </div>
            <div className="cfo-wf-label">{b.label}</div>
          </div>
        );
      })}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────
const ALERT_ACTION_PAGE = {
  'View Invoices': 'Invoices',
  'View Bills': 'SupplierBills',
  'Reconcile': 'BankReconciliation',
  'Process Payments': 'PaymentBatch',
  'Review Budget': 'BudgetManagement',
  'View Reports': 'FinanceReports',
  'Manage Expenses': 'Expenses',
};

export default function CFODashboard({ setPage }) {
  const { fyParams } = useFY();
  const [loading,  setLoading]  = useState(false);
  const [data,     setData]     = useState({});
  const [lastSync, setLastSync] = useState(new Date());
  const [expand,   setExpand]   = useState(null);
  const [period,   setPeriod]   = useState('YTD');

  // Re-fetches whenever the period or selected Financial Year changes
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fyYear = parseInt(fyParams.fy.replace(/\D/g, '').slice(0, 4), 10);
      const [cfoRes, revRes] = await Promise.allSettled([
        api.get(`/dashboard/cfo?period=${period}&fyStart=${fyParams.fyStart}`),
        api.get(`/dashboard/revenue?period=fy&year=${fyYear + 1}`),
      ]);
      setData({
        cfo : cfoRes.status === 'fulfilled' ? cfoRes.value.data : null,
        rev : revRes.status === 'fulfilled' ? revRes.value.data : null,
      });
      setLastSync(new Date());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [period, fyParams.fy, fyParams.fyStart]);

  useEffect(() => { load(); }, [load]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const cfo  = data.cfo  || {};
  const rev  = data.rev;
  const kpis = cfo.kpis  || {};
  const ratiosApi = cfo.ratios  || {};
  const gaugesApi = cfo.gauges  || {};

  const revenue     = kpis.revenue     || rev?.ytd || 0;
  const opex        = kpis.opex        || 0;
  const grossProfit = kpis.grossProfit || 0;
  const netProfit   = kpis.netProfit   || 0;
  const ebitda      = kpis.ebitda      || 0;
  const cashBalance = kpis.cashBalance || 0;
  const ar          = kpis.ar          || 0;
  const ap          = kpis.ap          || 0;
  const dso         = kpis.dso         || 0;
  const dpo         = kpis.dpo         || 0;
  const monthlyBurn = kpis.monthlyBurn || 0;
  const runway      = kpis.runway;

  const thisMonth = rev?.thisMonth || 0;
  const lastMonth = rev?.lastMonth || 0;
  const revTrend  = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth * 100) : 0;

  // Revenue vs Target chart: prefer /dashboard/revenue (more months), fall back to historical
  const revenueChart = (() => {
    if (rev && (rev.months || []).length > 0) {
      return (rev.months).map((m, i) => {
        const v = rev.values?.[i] || 0;
        return { month: m, revenue: v, target: Math.round(v * 1.1), profit: Math.round(v * 0.28) };
      });
    }
    return (cfo.historicalRevenue || []).map(r => ({
      month: r.month,
      revenue: r.revenue,
      target: Math.round(r.revenue * 1.1),
      profit: Math.round(r.revenue * 0.28),
    }));
  })();

  const cashFlowMonthly = cfo.cashFlowMonthly || [];
  const forecastData    = cfo.forecastData    || [];
  const expChart        = cfo.expByCategory   || [];
  const alertsData      = cfo.alerts          || [];

  // P&L waterfall uses real API values
  const plWaterfall = [
    { label: 'Revenue',    value: revenue,                    type: 'positive' },
    { label: 'OpEx',       value: -(revenue - grossProfit),   type: 'negative' },
    { label: 'Gross P',    value: grossProfit,                type: 'total'    },
    { label: 'EBITDA',     value: ebitda,                     type: 'total'    },
    { label: 'Net Profit', value: netProfit,                  type: 'total'    },
  ];

  // Financial ratios: use real API values where possible
  const ratiosData = [
    {
      label: 'Current Ratio',
      value: ratiosApi.currentRatio != null ? `${ratiosApi.currentRatio}x` : 'N/A',
      bench: '2.0x',
      status: ratiosApi.currentRatio != null ? (ratiosApi.currentRatio >= 2 ? 'good' : ratiosApi.currentRatio >= 1 ? 'warn' : 'bad') : 'good',
      desc: 'AR / AP',
    },
    {
      label: 'Quick Ratio',
      value: ratiosApi.quickRatio != null ? `${ratiosApi.quickRatio}x` : 'N/A',
      bench: '1.0x',
      status: ratiosApi.quickRatio != null ? (ratiosApi.quickRatio >= 1 ? 'good' : 'warn') : 'good',
      desc: '(Cash + AR) / AP',
    },
    {
      label: 'Gross Margin',
      value: `${ratiosApi.grossMargin ?? 0}%`,
      bench: '30%',
      status: (ratiosApi.grossMargin ?? 0) >= 30 ? 'good' : 'warn',
      desc: 'Gross profit margin',
    },
    {
      label: 'Net Margin',
      value: `${ratiosApi.netMargin ?? 0}%`,
      bench: '15%',
      status: (ratiosApi.netMargin ?? 0) >= 15 ? 'good' : 'warn',
      desc: 'Net profit margin',
    },
    {
      label: 'EBITDA Margin',
      value: `${ratiosApi.ebitdaMargin ?? 0}%`,
      bench: '20%',
      status: (ratiosApi.ebitdaMargin ?? 0) >= 20 ? 'good' : 'warn',
      desc: 'Operational efficiency',
    },
    {
      label: 'A/R Days',
      value: dso > 0 ? `${dso}d` : 'N/A',
      bench: '<45d',
      status: dso > 0 && dso <= 45 ? 'good' : dso > 45 ? 'warn' : 'good',
      desc: 'Collection cycle',
    },
    {
      label: 'A/P Days',
      value: dpo > 0 && dpo <= 365 ? `${dpo}d` : 'N/A',
      bench: '<60d',
      status: dpo > 0 && dpo <= 60 ? 'good' : (dpo > 60 && dpo <= 365) ? 'warn' : 'good',
      desc: 'Payment cycle',
    },
    { label: 'Debt/Equity',      value: '—', bench: '<1.0', status: 'good', desc: 'No balance sheet' },
    { label: 'ROE',              value: '—', bench: '15%',  status: 'good', desc: 'No equity data'   },
    { label: 'ROA',              value: '—', bench: '8%',   status: 'good', desc: 'No assets table'  },
    { label: 'Inventory Turns',  value: '—', bench: '4.0x', status: 'good', desc: 'No COGS tracked'  },
    { label: 'Interest Coverage',value: '—', bench: '>3x',  status: 'good', desc: 'No debt table'    },
  ];

  // Gauge values from API (computed as meaningful %)
  const collectionsPct = gaugesApi.collectionsPct ?? 0;
  const cashRatioPct   = gaugesApi.cashRatioPct   ?? 0;
  const liquidityPct   = gaugesApi.liquidityPct   ?? 0;

  const RevenueVsTargetChart = ({ height = 240 }) => (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={revenueChart} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="cfoRevGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="month" tick={{ fontSize: 12 }} />
        <YAxis tickFormatter={v => `₹${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v, n) => [fmt(v), n === 'revenue' ? 'Revenue' : n === 'target' ? 'Target' : 'Profit']} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="revenue" stroke="#6366f1" strokeWidth={2.5}
          fill="url(#cfoRevGrad)" name="revenue" />
        <Line type="monotone" dataKey="target" stroke="#f59e0b" strokeWidth={2}
          strokeDasharray="6 3" dot={false} name="target" />
        <ReferenceLine y={0} stroke="#e5e7eb" />
        <Bar dataKey="profit" fill="#10b981" opacity={0.7} radius={[3, 3, 0, 0]} name="profit" />
      </ComposedChart>
    </ResponsiveContainer>
  );

  const CashFlowChart = ({ height = 220 }) => {
    if (!cashFlowMonthly.length) {
      return <div className="cfo-empty">No cash flow data for this period</div>;
    }
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={cashFlowMonthly} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} />
          <YAxis tickFormatter={v => `₹${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v, n) => [fmt(v), n]} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine y={0} stroke="#e5e7eb" />
          <Bar dataKey="operating" fill="#10b981" name="Operating CF" radius={[3, 3, 0, 0]} />
          <Bar dataKey="net"       fill="#6366f1" name="Net CF"       radius={[3, 3, 0, 0]} opacity={0.5} />
        </BarChart>
      </ResponsiveContainer>
    );
  };

  const alertLevelIcon = (level) => {
    if (level === 'high' || level === 'medium') return <AlertTriangle size={13} />;
    if (level === 'info') return <Info size={13} />;
    return <CheckCircle size={13} />;
  };

  return (
    <div className="cfo-root">

      {expand && (
        <Modal title={
          expand === 'revenue'  ? 'Revenue vs Target — Full View' :
          expand === 'cashflow' ? 'Cash Flow Analysis — Full View' :
          expand === 'forecast' ? 'Revenue Forecast — Next 6 Months' : ''
        } onClose={() => setExpand(null)}>
          {expand === 'revenue'  && <RevenueVsTargetChart height={420} />}
          {expand === 'cashflow' && <CashFlowChart height={420} />}
          {expand === 'forecast' && forecastData.length > 0 && (
            <ResponsiveContainer width="100%" height={420}>
              <AreaChart data={forecastData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="optGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => `₹${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v, n) => [fmt(v), n]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="optimistic"   stroke="#6366f1" fill="url(#optGrad)" strokeWidth={1.5} name="Optimistic" />
                <Area type="monotone" dataKey="base"         stroke="#10b981" fill="none"           strokeWidth={2.5} name="Base Case" />
                <Area type="monotone" dataKey="conservative" stroke="#f59e0b" fill="none"           strokeWidth={1.5} strokeDasharray="5 3" name="Conservative" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Modal>
      )}

      {/* Header */}
      <div className="cfo-header">
        <div>
          <div className="cfo-title-row">
            <h2 className="cfo-title">CFO Dashboard</h2>
            <span className="cfo-badge">Executive View</span>
          </div>
          <p className="cfo-sub">
            {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
            · Last updated: {lastSync.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            {loading && <span style={{ marginLeft: 8, color: '#6366f1' }}>· Refreshing…</span>}
          </p>
        </div>
        <div className="cfo-header-r">
          <FYSelector />
          <div className="cfo-period">
            {['YTD', 'Q1', 'Q2', 'Q3', 'Q4'].map(p => (
              <button key={p}
                className={`cfo-period-tab${period === p ? ' active' : ''}`}
                onClick={() => setPeriod(p)}
                disabled={loading}>{p}</button>
            ))}
          </div>
          <button className="cfo-refresh" onClick={load} disabled={loading}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* ── Tier 1: Executive KPIs ─────────────────────────────── */}
      <div className="cfo-exec-kpis">

        <div className="cfo-exec-kpi cfo-kpi-rev">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">Revenue ({period})</p>
            <h2 className="cfo-exec-val">{fmtCr(revenue)}</h2>
            <div className="cfo-exec-meta">
              {lastMonth > 0 && <Trend value={revTrend} />}
              <span className="cfo-exec-vs">vs last month</span>
            </div>
          </div>
          <div className="cfo-exec-kpi-chart">
            <ResponsiveContainer width="100%" height={60}>
              <AreaChart data={revenueChart} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="sparkRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#fff" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#fff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="revenue" stroke="#fff" strokeWidth={2}
                  fill="url(#sparkRev)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="cfo-exec-kpi cfo-kpi-profit">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">Net Profit</p>
            <h2 className="cfo-exec-val">{fmtCr(netProfit)}</h2>
            <div className="cfo-exec-meta">
              <span className="cfo-margin-badge">{pct(netProfit, revenue)}% margin</span>
            </div>
          </div>
          <div className="cfo-exec-icon"><IndianRupee size={32} opacity={0.3} /></div>
        </div>

        <div className="cfo-exec-kpi cfo-kpi-ebitda">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">EBITDA</p>
            <h2 className="cfo-exec-val">{fmtCr(ebitda)}</h2>
            <div className="cfo-exec-meta">
              <span className="cfo-margin-badge">{pct(ebitda, revenue)}% margin</span>
            </div>
          </div>
          <div className="cfo-exec-icon"><BarChart2 size={32} opacity={0.3} /></div>
        </div>

        <div className="cfo-exec-kpi cfo-kpi-cash">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">Cash & Equivalents</p>
            <h2 className="cfo-exec-val">{fmtCr(cashBalance)}</h2>
            <div className="cfo-exec-meta">
              <ArrowUpRight size={13} />
              <span className="cfo-exec-vs">AP: {fmtCr(ap)}</span>
            </div>
          </div>
          <div className="cfo-exec-icon"><CreditCard size={32} opacity={0.3} /></div>
        </div>

        <div className="cfo-exec-kpi cfo-kpi-ar">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">Accounts Receivable</p>
            <h2 className="cfo-exec-val">{fmtCr(ar)}</h2>
            <div className="cfo-exec-meta">
              <span className="cfo-exec-vs">{dso > 0 ? `${dso} days DSO` : 'DSO: N/A'}</span>
            </div>
          </div>
          <div className="cfo-exec-icon"><Activity size={32} opacity={0.3} /></div>
        </div>

        <div className="cfo-exec-kpi cfo-kpi-burn">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">Monthly Burn Rate</p>
            <h2 className="cfo-exec-val">{monthlyBurn > 0 ? fmtCr(monthlyBurn) : '—'}</h2>
            <div className="cfo-exec-meta">
              <span className="cfo-exec-vs">
                {runway != null ? `Runway: ${runway} mo` : 'Runway: N/A'}
              </span>
            </div>
          </div>
          <div className="cfo-exec-icon"><Briefcase size={32} opacity={0.3} /></div>
        </div>

      </div>

      {/* ── Tier 2: Charts Row ─────────────────────────────────── */}
      <div className="cfo-grid">

        {/* Revenue vs Target */}
        <div className="cg8">
          <Card title="Revenue vs Target" sub="Paid invoices by month"
            expand={() => setExpand('revenue')}>
            <div className="cfo-chart-meta">
              <div className="cfo-cm-chip cfo-cm-rev">
                <span>Revenue</span><strong>{fmtCr(revenue)}</strong>
                {lastMonth > 0 && <Trend value={revTrend} />}
              </div>
              <div className="cfo-cm-chip cfo-cm-target">
                <span>Target (+10%)</span><strong>{fmtCr(revenue * 1.1)}</strong>
                <span className="cfo-cm-gap">Gap: {fmtCr(revenue * 0.1)}</span>
              </div>
              <div className="cfo-cm-chip cfo-cm-profit">
                <span>Gross Profit</span><strong>{fmtCr(grossProfit)}</strong>
              </div>
            </div>
            {revenueChart.length > 0
              ? <RevenueVsTargetChart height={220} />
              : <div className="cfo-empty">No revenue data for this period</div>}
          </Card>
        </div>

        {/* P&L Bridge */}
        <div className="cg4">
          <Card title="P&L Bridge" sub={period}>
            <div className="cfo-pl-summary">
              <div className="cfo-pl-row">
                <span>Gross Margin</span>
                <strong className={grossProfit >= 0 ? 'green' : 'red'}>{pct(grossProfit, revenue)}%</strong>
              </div>
              <div className="cfo-pl-row">
                <span>EBITDA Margin</span>
                <strong className={ebitda >= 0 ? 'green' : 'red'}>{pct(ebitda, revenue)}%</strong>
              </div>
              <div className="cfo-pl-row">
                <span>Net Margin</span>
                <strong className={netProfit >= 0 ? 'green' : 'red'}>{pct(netProfit, revenue)}%</strong>
              </div>
            </div>
            {revenue > 0
              ? <WaterfallChart data={plWaterfall} />
              : <div className="cfo-empty">No data for this period</div>}
          </Card>
        </div>

        {/* Cash Flow */}
        <div className="cg6">
          <Card title="Cash Flow Breakdown" sub="Inflow vs Outflow by month"
            expand={() => setExpand('cashflow')}>
            <div className="cfo-cf-kpis">
              <div className="cfo-cf-kpi green">
                <ArrowUpRight size={14} /><span>Total Inflow</span>
                <strong>{fmt(cashFlowMonthly.reduce((s, r) => s + Math.max(r.operating, 0), 0))}</strong>
              </div>
              <div className="cfo-cf-kpi red">
                <ArrowDownRight size={14} /><span>Total Outflow</span>
                <strong>{fmt(cashFlowMonthly.reduce((s, r) => s + Math.min(r.operating, 0), 0))}</strong>
              </div>
              <div className="cfo-cf-kpi amber">
                <span>Net</span>
                <strong>{fmt(cashFlowMonthly.reduce((s, r) => s + r.net, 0))}</strong>
              </div>
            </div>
            <CashFlowChart height={190} />
          </Card>
        </div>

        {/* Revenue Forecast */}
        <div className="cg6">
          <Card title="Revenue Forecast" sub="Next 6 months · 3 scenarios (trend-based)"
            expand={() => setExpand('forecast')}>
            <div className="cfo-forecast-legend">
              <span className="cfo-fl-item" style={{ color: '#6366f1' }}>● Optimistic</span>
              <span className="cfo-fl-item" style={{ color: '#10b981' }}>● Base Case</span>
              <span className="cfo-fl-item" style={{ color: '#f59e0b' }}>● Conservative</span>
            </div>
            {forecastData.length > 0 ? (
              <ResponsiveContainer width="100%" height={210}>
                <AreaChart data={forecastData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="optG" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.12} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={v => `₹${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v, n) => [fmt(v), n]} />
                  <Area type="monotone" dataKey="optimistic"   stroke="#6366f1" fill="url(#optG)" strokeWidth={1.5} />
                  <Area type="monotone" dataKey="base"         stroke="#10b981" fill="none"        strokeWidth={2.5} />
                  <Area type="monotone" dataKey="conservative" stroke="#f59e0b" fill="none"        strokeWidth={1.5} strokeDasharray="5 3" />
                </AreaChart>
              </ResponsiveContainer>
            ) : <div className="cfo-empty">Insufficient historical data for forecast</div>}
          </Card>
        </div>

        {/* Financial Ratios */}
        <div className="cg6">
          <Card title="Key Financial Ratios" sub="Computed from live data">
            <div className="cfo-ratios-grid">
              {ratiosData.map((r, i) => (
                <div key={i} className={`cfo-ratio-item cfo-ratio-${r.status}`}>
                  <div className="cfo-ratio-label">{r.label}</div>
                  <div className="cfo-ratio-val">{r.value}</div>
                  <div className="cfo-ratio-bench">Bench: {r.bench}</div>
                  {r.status === 'good'
                    ? <CheckCircle size={12} className="cfo-ratio-icon green" />
                    : <AlertTriangle size={12} className="cfo-ratio-icon amber" />}
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Department Expenses — estimated split of total opex across departments */}
        <div className="cg6">
          <Card title="Department Expenses" sub="Estimated split from total OpEx">
            <div style={{ padding: '8px 0 4px', fontSize: 11, color: '#9ca3af' }}>
              Revenue attribution requires project tagging — showing expense data only
            </div>
            {opex > 0 ? (
              <div className="cfo-roi-list">
                {[
                  { dept: 'Engineering', share: 0.36 },
                  { dept: 'Sales',       share: 0.30 },
                  { dept: 'Operations',  share: 0.23 },
                  { dept: 'Marketing',   share: 0.18 },
                  { dept: 'HR',          share: 0.14 },
                ].map((d, i) => {
                  const cost = Math.round(opex * d.share);
                  const maxCost = Math.round(opex * 0.36);
                  return (
                    <div key={i} className="cfo-roi-row">
                      <div className="cfo-roi-dept">{d.dept}</div>
                      <div className="cfo-roi-bars">
                        <div className="cfo-roi-bar-wrap">
                          <div className="cfo-roi-cost-bar"
                            style={{ width: `${(cost / maxCost) * 100}%`, background: '#f59e0b' }} />
                        </div>
                      </div>
                      <div className="cfo-roi-nums">
                        <span className="cfo-roi-cost">~{fmt(cost)}</span>
                        <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>est.</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="cfo-empty">No expense data for {period}</div>
            )}
          </Card>
        </div>

        {/* Working Capital Gauges */}
        <div className="cg4">
          <Card title="Working Capital Health">
            <div className="cfo-gauges">
              <Gauge value={collectionsPct} label="Collections" color="#10b981" />
              <Gauge value={cashRatioPct}   label="Cash/AP"     color="#6366f1" />
              <Gauge value={liquidityPct}   label="Liquidity"   color="#f59e0b" />
            </div>
            <div className="cfo-wc-stats">
              <div className="cfo-wc-stat">
                <span>Working Capital</span>
                <strong className={ar - ap >= 0 ? 'green' : 'red'}>{fmtCr(ar - ap)}</strong>
              </div>
              <div className="cfo-wc-stat">
                <span>AR / AP Ratio</span>
                <strong className="green">
                  {ap > 0 ? `${(ar / ap).toFixed(1)}x` : 'N/A'}
                </strong>
              </div>
              <div className="cfo-wc-stat">
                <span>Quick Ratio</span>
                <strong className="green">
                  {ap > 0 ? `${((cashBalance + ar) / ap).toFixed(1)}x` : 'N/A'}
                </strong>
              </div>
            </div>
          </Card>
        </div>

        {/* Expense by Category */}
        <div className="cg4">
          <Card title="Expense Structure" sub={`${period} breakdown`}>
            {expChart.length > 0 ? (
              <>
                <div className="cfo-exp-total">
                  <span>Total OpEx</span>
                  <strong>{fmtCr(expChart.reduce((s, e) => s + e.value, 0))}</strong>
                </div>
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart>
                    <Pie data={expChart} cx="50%" cy="50%" innerRadius={48} outerRadius={72}
                      dataKey="value" paddingAngle={3}>
                      {expChart.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={v => [fmt(v), '']} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="cfo-exp-legend">
                  {expChart.map((e, i) => {
                    const total = expChart.reduce((s, x) => s + x.value, 0) || 1;
                    return (
                      <div key={i} className="cfo-exp-row">
                        <span className="cfo-exp-dot" style={{ background: COLORS[i % COLORS.length] }} />
                        <span className="cfo-exp-name">{e.name}</span>
                        <span className="cfo-exp-pct">{pct(e.value, total)}%</span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="cfo-empty">No expense claim data for {period}</div>
            )}
          </Card>
        </div>

        {/* Executive Alerts */}
        <div className="cg4">
          <Card title="Executive Alerts">
            {alertsData.length > 0 ? alertsData.map((a, i) => (
              <div key={i} className={`cfo-alert cfo-alert-${a.level}`}>
                <div className="cfo-alert-body">
                  {alertLevelIcon(a.level)}
                  <span>{a.msg}</span>
                </div>
                {a.action && (
                  <button className="cfo-alert-action" onClick={() => {
                    const page = ALERT_ACTION_PAGE[a.action];
                    if (page && setPage) setPage(page);
                  }}>{a.action}</button>
                )}
              </div>
            )) : (
              <div className="cfo-empty">No alerts</div>
            )}
          </Card>
        </div>

      </div>
    </div>
  );
}
