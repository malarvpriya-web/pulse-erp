import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import RequireRole from '@/components/auth/RequireRole';
import {
  RefreshCw, TrendingUp, Users, IndianRupee, BarChart2,
  AlertCircle, CheckCircle, Activity, Target, ArrowUpRight,
  ArrowDownRight, Minus, Zap, ShieldCheck, Package, Ticket,
  FileText, Clock, Briefcase, UserCheck, ChevronLeft, ChevronRight,
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Line, Legend,
  PieChart, Pie, Cell,
} from 'recharts';
import api from '@/services/api/client';
import { generateInsights } from '../services/insightsEngine';
import AIInsightCard from '@/features/ai/components/AIInsightCard';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import './CeoDashboard.css';

/* ── formatters ── */
const fmtL = (n) => {
  if (n == null || isNaN(n)) return '—';
  if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(1)}Cr`;
  if (n >= 100_000)    return `₹${(n / 100_000).toFixed(1)}L`;
  if (n >= 1_000)      return `₹${(n / 1_000).toFixed(0)}K`;
  return `₹${n}`;
};
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
const fmtPct = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);

const KPI_META = [
  { key: 'revenue',          icon: IndianRupee, color: '#10b981' },
  { key: 'arr',              icon: TrendingUp,  color: '#6B3FDB', sub: 'MRR × 12' },
  { key: 'headcount',        icon: Users,       color: '#3b82f6' },
  { key: 'attrition',        icon: Activity,    color: '#f59e0b' },
  { key: 'openPipeline',     icon: Target,      color: '#8b5cf6' },
  { key: 'projectsOnTrack',  icon: CheckCircle, color: '#06b6d4' },
];

const TABS = [
  { id: 'overview',   label: 'Overview' },
  { id: 'people',     label: 'People' },
  { id: 'sales',      label: 'Sales & Pipeline' },
  { id: 'operations', label: 'Operations' },
];

const PIPE_COLORS   = ['#6B3FDB', '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b'];
const DEPT_COLORS   = ['#6B3FDB', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ef4444'];
const GENDER_COLORS = { male: '#3b82f6', female: '#ec4899', 'not specified': '#9ca3af', other: '#10b981' };
const ALERT_BG = { high: '#fff5f5', medium: '#fffbeb', low: '#f0f9ff', info: '#f5f3ff' };
const ALERT_CLR= { high: '#ef4444', medium: '#f59e0b', low: '#3b82f6', info: '#6B3FDB' };

const OPS_TILES = [
  { key: 'active_projects',    label: 'Active Projects',    icon: Briefcase,  color: '#6B3FDB', route: 'ProjectsDashboard' },
  { key: 'open_tickets',       label: 'Open Tickets',       icon: Ticket,     color: '#3b82f6', route: 'AllTickets' },
  { key: 'pending_invoices',   label: 'Pending Invoices',   icon: FileText,   color: '#f59e0b', route: 'InvoicesNew' },
  { key: 'overdue_tasks',      label: 'Overdue Tasks',      icon: Clock,      color: '#ef4444', route: 'Projects' },
  { key: 'timesheets_pending', label: 'Timesheets Pending', icon: BarChart2,  color: '#8b5cf6', route: 'Timesheets' },
  { key: 'open_recruitments',  label: 'Open Recruitments',  icon: UserCheck,  color: '#10b981', route: 'RecruitmentDashboard' },
  { key: 'low_stock',          label: 'Low Stock Items',    icon: Package,    color: '#f97316', route: 'InventoryDashboard' },
  { key: 'tasks_completed',    label: 'Tasks Done (MTD)',   icon: CheckCircle,color: '#14b8a6', route: 'Projects' },
  { key: 'on_leave',           label: 'On Leave Today',     icon: Users,      color: '#6366f1', route: 'AllLeaves' },
];

/* ══════════════════════════════════════════════════════════════════════════ */
export default function CeoDashboard() {
  const navigate = useNavigate();

  const [tab,        setTab]        = useState('overview');
  const [loading,    setLoading]    = useState(false);
  const [kpis,       setKpis]       = useState({});
  const [hc,         setHc]         = useState({});
  const [attrition,  setAttrition]  = useState({});
  const [deptWf,     setDeptWf]     = useState([]);
  const [salesKPI,   setSalesKPI]   = useState({});
  const [revChart,   setRevChart]   = useState([]);
  const [pipeStages, setPipeStages] = useState([]);
  const [expenses,   setExpenses]   = useState([]);
  const [opsData,    setOpsData]    = useState({});
  const [alerts,     setAlerts]     = useState([]);
  const [lastSync,   setLastSync]   = useState(null);
  /* ── Commercial Intelligence state ── */
  const [topCustomers, setTopCustomers] = useState([]);
  const [topVendors,   setTopVendors]   = useState([]);
  const [travelByEmp,  setTravelByEmp]  = useState([]);
  const [travelByProj, setTravelByProj] = useState([]);
  const [projMargins,  setProjMargins]  = useState([]);
  const [commLoading,  setCommLoading]  = useState(true);

  /* ── Period / YoY state ── */
  const [period,  setPeriod]  = useState('6m');
  const [year,    setYear]    = useState(new Date().getFullYear());
  const [showYoY, setShowYoY] = useState(false);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  /* ── Revenue-only loader (re-runs on period / year / showYoY changes) ── */
  const loadRevenue = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ period, year: String(year) });
    if (showYoY) params.set('compare', 'true');
    const r = await api.get(`/dashboard/revenue?${params.toString()}`).catch(() => ({ data: {} }));
    if (!isMounted.current) return;
    const raw = r?.data ?? {};
    if (Array.isArray(raw?.months) && raw.months.length) {
      const shorts = Array.isArray(raw.shortMonths) ? raw.shortMonths : raw.months.map(m => m.split(' ')[0]);
      setRevChart(shorts.map((m, i) => ({
        month: m,
        revenue: raw.values?.[i] ?? 0,
        ...(showYoY && Array.isArray(raw.prevValues) && raw.prevValues.length
          ? { prevRevenue: raw.prevValues[i] ?? 0 }
          : {}),
      })));
    } else {
      setRevChart([]);
    }
    if (isMounted.current) setLoading(false);
  }, [period, year, showYoY]);

  const load = useCallback(async () => {
    setLoading(true);
    const [kpiR, hcR, attrR, deptR, salesR, pipeR, expR, opsR, alertR] =
      await Promise.allSettled([
        api.get('/analytics/ceo/kpis'),
        api.get('/analytics/headcount'),
        api.get('/analytics/attrition'),
        api.get('/analytics/dept-workforce'),
        api.get('/analytics/sales'),
        api.get('/dashboard/sales'),
        api.get('/dashboard/expenses'),
        api.get('/dashboard/operations'),
        api.get('/dashboard/alerts'),
      ]);

    if (!isMounted.current) return;

    /* helpers */
    const fulfilled = (r) => r.status === 'fulfilled';
    const getData   = (r) => fulfilled(r) ? (r.value.data ?? {}) : {};

    setKpis(getData(kpiR)?.kpis ?? {});
    setHc(getData(hcR)?.data ?? {});
    setAttrition(getData(attrR)?.data ?? {});

    const deptRaw = getData(deptR)?.data;
    setDeptWf(Array.isArray(deptRaw) ? deptRaw : []);

    setSalesKPI(getData(salesR)?.data ?? {});

    const pipeRaw = getData(pipeR)?.stages;
    setPipeStages(Array.isArray(pipeRaw) ? pipeRaw : []);

    const expRaw = getData(expR);
    if (Array.isArray(expRaw?.labels) && expRaw.labels.length) {
      setExpenses(expRaw.labels.map((l, i) => ({ category: l, amount: expRaw.values?.[i] ?? 0 })));
    } else {
      setExpenses([]);
    }

    setOpsData(getData(opsR));

    const alertRaw = getData(alertR)?.alerts;
    setAlerts(Array.isArray(alertRaw) ? alertRaw : []);

    setLastSync(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
    setLoading(false);
  }, []);

  useEffect(() => { load(); },        [load]);
  useEffect(() => { loadRevenue(); }, [loadRevenue]);

  const loadCommercial = useCallback(async () => {
    setCommLoading(true);
    const [tcR, tvR, teR, tpR, pmR] = await Promise.allSettled([
      api.get('/project-profitability/top-customers'),
      api.get('/vendor-portal/scorecards/top'),
      api.get('/travel/analytics/by-employee'),
      api.get('/travel/analytics/by-project'),
      api.get('/project-profitability/all'),
    ]);
    if (!isMounted.current) return;
    const g = (r) => r.status === 'fulfilled' ? (r.value?.data ?? []) : [];
    setTopCustomers(g(tcR));
    setTopVendors(g(tvR));
    setTravelByEmp(g(teR));
    setTravelByProj(g(tpR));
    setProjMargins(g(pmR));
    setCommLoading(false);
  }, []);
  useEffect(() => { loadCommercial(); }, [loadCommercial]);

  /* rule-based insights */
  const insights = useMemo(() => generateInsights({
    attritionRate:  attrition.rate,
    revenueGrowth:  kpis.revenue?.growth,
    pipelineValue:  kpis.openPipeline?.value,
    salesTarget:    3_500_000,
    projectsAtRisk: 0,
    deptUtilization: deptWf.map(d => ({ utilization: d.headcount })),
  }), [kpis, attrition, deptWf]);

  /* ── KPI tile value formatter ── */
  const kpiVal = (key, item) => {
    if (!item) return '—';
    if (item.unit === '%')  return fmtPct(item.value);
    if (item.outOf != null) return `${item.value ?? 0}/${item.outOf ?? 0}`;
    if (typeof item.value === 'number' && item.value > 10_000) return fmtL(item.value);
    return fmtNum(item.value);
  };

  const GrowthChip = ({ growth, invert = false }) => {
    if (growth == null || growth === 0)
      return <span className="ceo-kpi-growth neu"><Minus size={10}/>&nbsp;—</span>;
    const positive = invert ? growth < 0 : growth > 0;
    return (
      <span className={`ceo-kpi-growth ${positive ? 'up' : 'down'}`}>
        {positive ? <ArrowUpRight size={10}/> : <ArrowDownRight size={10}/>}
        &nbsp;{Math.abs(growth).toFixed(1)}%
      </span>
    );
  };

  /* derived */
  const pipeMax    = pipeStages.reduce((m, s) => Math.max(m, s.value ?? 0), 0) || 1;
  const deptMax    = deptWf.reduce((m, d) => Math.max(m, d.headcount ?? 0), 0) || 1;
  const genderRows = Array.isArray(hc.by_gender) ? hc.by_gender : [];
  const genderTotal= genderRows.reduce((s, g) => s + (g.count ?? 0), 0) || 1;
  const expTotal   = expenses.reduce((s, e) => s + (e.amount ?? 0), 0) || 1;
  const pipeTotal  = pipeStages.reduce((s, s2) => s + (s2.value ?? 0), 0);
  const alertsReal = alerts.filter(a => a.type !== 'info');

  // Shared revenue chart renderer — compact card and expanded modal use the same markup
  const revTrendChart = (h = '100%') => (
    <ResponsiveContainer width="100%" height={h}>
      <AreaChart data={revChart} margin={{ top:4, right:6, bottom:0, left:-12 }}>
        <defs>
          <linearGradient id="ceoRevGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#6B3FDB" stopOpacity={0.22}/>
            <stop offset="95%" stopColor="#6B3FDB" stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6"/>
        <XAxis dataKey="month" tick={{ fontSize:10, fill:'#9ca3af' }}/>
        <YAxis tick={{ fontSize:10, fill:'#9ca3af' }} tickFormatter={v => fmtL(v)}/>
        <Tooltip formatter={v => [fmtL(v), 'Revenue']} contentStyle={{ fontSize:12, borderRadius:8, border:'1px solid #f0f0f4' }}/>
        <Legend wrapperStyle={{ fontSize:11 }}/>
        <Area type="monotone" dataKey="revenue" stroke="#6B3FDB" strokeWidth={2} fill="url(#ceoRevGrad)" name="This Period"/>
        {showYoY && (
          <Line type="monotone" dataKey="prevRevenue" stroke="#9ca3af" strokeWidth={1.5}
                strokeDasharray="5 3" dot={false} name="Prior Year"/>
        )}
      </AreaChart>
    </ResponsiveContainer>
  );

  /* ── Executive-alerts body (shared) ── */
  const renderExecAlerts = () => {
    if (loading) {
      return Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="ceo-sk" style={{ height: 40, marginBottom: 8, borderRadius: 9 }}/>
      ));
    }
    if (insights.length === 0) {
      return (
        <div className="ceo-ai-pill" style={{ background: '#f0fdf4' }}>
          <CheckCircle size={13} color="#10b981" style={{ flexShrink: 0, marginTop: 2 }}/>
          <span className="ceo-ai-text">All key metrics are within normal range — no rule-based alerts to surface.</span>
        </div>
      );
    }
    const cMap = { danger:'#ef4444', warning:'#f59e0b', success:'#10b981', info:'#3b82f6' };
    const bMap = { danger:'#fee2e2', warning:'#fef3c7', success:'#dcfce7', info:'#dbeafe' };
    return insights.map((ins, i) => (
      <div key={i} className="ceo-ai-pill" style={{ background: bMap[ins.type] || '#f3f4f6' }}>
        <AlertCircle size={13} color={cMap[ins.type] || '#6b7280'} style={{ flexShrink: 0, marginTop: 2 }}/>
        <span className="ceo-ai-text">{ins.message}</span>
      </div>
    ));
  };

  return (
    <RequireRole roles={['super_admin', 'admin']}>
    <div className="ceo-root">

      {/* ══ Header ══════════════════════════════════════════════════════════ */}
      <div className="ceo-topbar">
        <div>
          <h1 className="ceo-title">CEO Dashboard</h1>
          <p className="ceo-subtitle">
            Executive overview — revenue, people, pipeline &amp; operations
            <span className="ceo-live">LIVE</span>
          </p>
        </div>
        <div className="ceo-topbar-actions">
          {lastSync && <span className="ceo-sync">Synced {lastSync}</span>}
          <button className="ceo-refresh-btn" onClick={() => { load(); loadRevenue(); loadCommercial(); }} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'ceo-spin' : ''}/>
            Refresh
          </button>
        </div>
      </div>

      {/* ══ KPI strip (always visible) ══════════════════════════════════════ */}
      <div className="ceo-kpi-strip">
        {KPI_META.map(({ key, icon: Icon, color, sub }) => {
          const item = kpis[key] ?? {};
          return (
            <div key={key} className="ceo-kpi-tile">
              {loading ? (
                <>
                  <div className="ceo-sk" style={{ width:30, height:30, borderRadius:8, marginBottom:8 }}/>
                  <div className="ceo-sk" style={{ width:'70%', height:10, marginBottom:8 }}/>
                  <div className="ceo-sk" style={{ width:'50%', height:18, marginBottom:6 }}/>
                  <div className="ceo-sk" style={{ width:'35%', height:10 }}/>
                </>
              ) : (
                <>
                  <div className="ceo-kpi-top">
                    <div className="ceo-kpi-ico" style={{ background: `${color}18` }}>
                      <Icon size={15} color={color}/>
                    </div>
                    <GrowthChip growth={item.growth} invert={key === 'attrition'}/>
                  </div>
                  <div className="ceo-kpi-lbl">{item.label ?? key}</div>
                  <div className="ceo-kpi-val">{kpiVal(key, item)}</div>
                  {sub && <div className="ceo-kpi-sub">{item.sub ?? sub}</div>}
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* ══ Tabs ════════════════════════════════════════════════════════════ */}
      <div className="ceo-tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`ceo-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'operations' && alertsReal.length > 0 && (
              <span className="ceo-tab-badge">{alertsReal.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ══ Panels ══════════════════════════════════════════════════════════ */}
      <div className="ceo-panel">

        {/* ─────────────────────────── OVERVIEW ─────────────────────────── */}
        {tab === 'overview' && (
          <div className="ceo-grid-overview">

            {/* Sales + People summary strip */}
            <div className="ceo-stat-strip">
              {[
                { label:'Pipeline Value',   val: fmtL(salesKPI.pipelineValue)    },
                { label:'Conversion Rate',  val: fmtPct(salesKPI.conversionRate) },
                { label:'Avg Deal Size',    val: fmtL(salesKPI.avgDealSize)      },
                { label:'Active Headcount', val: fmtNum(hc.active)               },
                { label:'On Leave Today',   val: fmtNum(hc.onLeave)              },
                { label:'New Hires (MTD)',  val: fmtNum(hc.newHires)             },
              ].map(({ label, val }) => (
                <div key={label} className="ceo-stat">
                  <div className="ceo-stat-val">{loading ? '—' : val}</div>
                  <div className="ceo-stat-lbl">{label}</div>
                </div>
              ))}
            </div>

            {/* Revenue trend */}
            <div className="ceo-card">
              <div className="ceo-card-hd">
                <div>
                  <div className="ceo-card-title">Revenue Trend</div>
                  <div className="ceo-card-sub">From paid invoices</div>
                </div>
                <div className="ceo-chart-controls">
                  {kpis.revenue?.growth != null && (
                    <span className={`ceo-trend-pill ${kpis.revenue.growth >= 0 ? 'up' : 'down'}`}>
                      {kpis.revenue.growth >= 0 ? '+' : ''}{Number(kpis.revenue.growth).toFixed(1)}% YoY
                    </span>
                  )}
                  <button
                    className={`ceo-yoy-btn${showYoY ? ' active' : ''}`}
                    onClick={() => setShowYoY(v => !v)}
                    title="Toggle year-over-year comparison line"
                  >YoY</button>
                  {period !== '6m' && (
                    <div className="ceo-year-nav">
                      <button className="ceo-year-nav-btn" onClick={() => setYear(y => y - 1)}><ChevronLeft size={12}/></button>
                      <span className="ceo-year-nav-lbl">{year}</span>
                      <button className="ceo-year-nav-btn" onClick={() => setYear(y => y + 1)}><ChevronRight size={12}/></button>
                    </div>
                  )}
                  <div className="ceo-period-tabs">
                    {[['6m','6M'],['cy','CY'],['fy','FY']].map(([val, lbl]) => (
                      <button key={val} className={`ceo-period-btn${period === val ? ' active' : ''}`}
                              onClick={() => setPeriod(val)}>{lbl}</button>
                    ))}
                  </div>
                  {revChart.length > 0 && (
                    <ChartExpandButton title="Revenue Trend" subtitle="From paid invoices">
                      {revTrendChart(440)}
                    </ChartExpandButton>
                  )}
                </div>
              </div>
              {loading ? (
                <div className="ceo-chart-fill"><div className="ceo-sk" style={{ height:'100%', borderRadius:8 }}/></div>
              ) : revChart.length === 0 ? (
                <div className="ceo-chart-fill ceo-center"><span className="ceo-empty">No revenue data yet</span></div>
              ) : (
                <div className="ceo-chart-fill">{revTrendChart('100%')}</div>
              )}
            </div>

            {/* Side column: AI insights + executive alerts */}
            <div className="ceo-ov-side">
              <div className="ceo-card">
                <div className="ceo-ai-hd">
                  <div className="ceo-ai-icon"><Zap size={14} color="#fff"/></div>
                  <div>
                    <div className="ceo-ai-title">AI Executive Insights</div>
                    <div className="ceo-ai-sub">Analysis of live data</div>
                  </div>
                  <span className="ceo-ai-badge">ChatGPT</span>
                </div>
                <div className="ceo-card-body">
                  <AIInsightCard dashboardData={{ kpis, hc, attrition, salesKPI, opsData }}/>
                </div>
              </div>

              <div className="ceo-card">
                <div className="ceo-card-hd">
                  <div>
                    <div className="ceo-card-title">Executive Alerts</div>
                    <div className="ceo-card-sub">Rule-based signal detection</div>
                  </div>
                  <ShieldCheck size={15} color={insights.length ? '#6B3FDB' : '#10b981'}/>
                </div>
                <div className="ceo-card-body">{renderExecAlerts()}</div>
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────── PEOPLE ───────────────────────────── */}
        {tab === 'people' && (
          <div className="ceo-grid-2x2">

            {/* Headcount snapshot */}
            <div className="ceo-card">
              <div className="ceo-card-hd">
                <div>
                  <div className="ceo-card-title">Headcount Snapshot</div>
                  <div className="ceo-card-sub">Live employee counts</div>
                </div>
              </div>
              <div className="ceo-card-body">
                <div className="ceo-hc-grid">
                  {[
                    { label:'Total',      val:hc.total,      color:'#6B3FDB' },
                    { label:'Active',     val:hc.active,     color:'#10b981' },
                    { label:'New Hires',  val:hc.newHires,   color:'#3b82f6' },
                    { label:'Departures', val:hc.departures, color:'#ef4444' },
                  ].map(({ label, val, color }) => (
                    <div key={label} className="ceo-hc-tile">
                      <div className="ceo-hc-val" style={{ color }}>{loading ? '—' : fmtNum(val)}</div>
                      <div className="ceo-hc-lbl">{label}</div>
                    </div>
                  ))}
                </div>
                <div className="ceo-attr-bar" style={{ background: attrition.rate > 15 ? '#fee2e2' : attrition.rate > 10 ? '#fef3c7' : '#f0fdf4' }}>
                  <span className="ceo-attr-bar-lbl">Attrition Rate</span>
                  <span className="ceo-attr-bar-val" style={{ color: attrition.rate > 15 ? '#ef4444' : attrition.rate > 10 ? '#f59e0b' : '#16a34a' }}>
                    {loading ? '—' : fmtPct(attrition.rate)}
                  </span>
                </div>
              </div>
            </div>

            {/* Attrition analysis */}
            <div className="ceo-card">
              <div className="ceo-card-hd">
                <div>
                  <div className="ceo-card-title">Attrition Analysis</div>
                  <div className="ceo-card-sub">12-month rolling</div>
                </div>
              </div>
              <div className="ceo-card-body">
                <div className="ceo-attr-hero">
                  <div className="ceo-attr-rate" style={{ color: attrition.rate > 15 ? '#ef4444' : attrition.rate > 10 ? '#f59e0b' : '#10b981' }}>
                    {loading ? '—' : fmtPct(attrition.rate)}
                  </div>
                  <div className="ceo-attr-lbl">Attrition Rate</div>
                  <div className="ceo-attr-bench">Industry benchmark: 10–12%</div>
                </div>
                <div className="ceo-attr-grid">
                  {[
                    { label:'Voluntary',   val: fmtPct(attrition.voluntary)   },
                    { label:'Involuntary', val: fmtPct(attrition.involuntary) },
                    { label:'Avg Tenure',  val: attrition.avgTenure ? `${Number(attrition.avgTenure).toFixed(1)}y` : '—' },
                    { label:'At Risk',     val: fmtNum(attrition.atRisk)       },
                  ].map(({ label, val }) => (
                    <div key={label} className="ceo-attr-stat">
                      <div className="ceo-attr-stat-val">{loading ? '—' : val}</div>
                      <div className="ceo-attr-stat-lbl">{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Dept workforce */}
            <div className="ceo-card">
              <div className="ceo-card-hd">
                <div>
                  <div className="ceo-card-title">Dept Workforce</div>
                  <div className="ceo-card-sub">Headcount by department</div>
                </div>
              </div>
              <div className="ceo-card-body">
                {loading ? (
                  Array.from({ length:6 }).map((_, i) => (
                    <div key={i} className="ceo-sk" style={{ height:13, marginBottom:13, borderRadius:4 }}/>
                  ))
                ) : deptWf.length === 0 ? (
                  <div className="ceo-empty">No department data</div>
                ) : deptWf.slice(0, 8).map((d, i) => (
                  <div key={d.dept || i} className="ceo-dept-row">
                    <span className="ceo-dept-name" title={d.dept}>{d.dept || 'Unknown'}</span>
                    <div className="ceo-dept-track">
                      <div className="ceo-dept-fill" style={{ width:`${((d.headcount ?? 0) / deptMax) * 100}%`, background:DEPT_COLORS[i % DEPT_COLORS.length] }}/>
                    </div>
                    <span className="ceo-dept-n">{d.headcount ?? 0}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Gender diversity */}
            <div className="ceo-card">
              <div className="ceo-card-hd">
                <div>
                  <div className="ceo-card-title">Gender Diversity</div>
                  <div className="ceo-card-sub">Active workforce breakdown</div>
                </div>
              </div>
              <div className="ceo-card-body">
                {loading ? (
                  <div className="ceo-sk" style={{ height:'100%', minHeight:140, borderRadius:8 }}/>
                ) : genderRows.length === 0 ? (
                  <div className="ceo-empty">No gender data</div>
                ) : (
                  <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                    <PieChart width={110} height={110}>
                      <Pie
                        data={genderRows.map(g => ({ name: g.gender || 'Not Specified', value: g.count ?? 0 }))}
                        cx={55} cy={55} innerRadius={30} outerRadius={50}
                        dataKey="value" paddingAngle={2}
                      >
                        {genderRows.map((g, i) => {
                          const key = (g.gender || '').toLowerCase();
                          return <Cell key={i} fill={GENDER_COLORS[key] || DEPT_COLORS[i % DEPT_COLORS.length]}/>;
                        })}
                      </Pie>
                      <Tooltip formatter={v => [v, '']} contentStyle={{ fontSize:11, borderRadius:6 }}/>
                    </PieChart>
                    <div className="ceo-gender-bars" style={{ flex:1 }}>
                      {genderRows.map((g) => {
                        const pct  = Math.round(((g.count ?? 0) / genderTotal) * 100);
                        const key  = (g.gender || '').toLowerCase();
                        const color= GENDER_COLORS[key] || '#6B3FDB';
                        return (
                          <div key={g.gender || 'other'} className="ceo-gender-row">
                            <div className="ceo-gender-meta">
                              <span className="ceo-gender-lbl">{g.gender || 'Not Specified'}</span>
                              <span className="ceo-gender-pct" style={{ color }}>{pct}% ({g.count ?? 0})</span>
                            </div>
                            <div className="ceo-gender-track">
                              <div className="ceo-gender-fill" style={{ width:`${pct}%`, background:color }}/>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ────────────────────── SALES & PIPELINE ──────────────────────── */}
        {tab === 'sales' && (
          <div className="ceo-grid-2x2">

            {/* Sales pipeline stages */}
            <div className="ceo-card">
              <div className="ceo-card-hd">
                <div>
                  <div className="ceo-card-title">Sales Pipeline by Stage</div>
                  <div className="ceo-card-sub">Open CRM opportunities</div>
                </div>
              </div>
              <div className="ceo-card-body">
                {loading ? (
                  <div className="ceo-sk" style={{ height:'100%', minHeight:140, borderRadius:8 }}/>
                ) : pipeStages.length === 0 ? (
                  <div className="ceo-empty">No pipeline data</div>
                ) : (
                  <>
                    <div className="ceo-pipe-rows">
                      {pipeStages.map((s, i) => {
                        const val = s.value ?? 0;
                        const pct = Math.round((val / pipeMax) * 100);
                        return (
                          <div key={s.stage || i}>
                            <div className="ceo-pipe-meta">
                              <span className="ceo-pipe-stage">{s.stage || 'Unknown'}</span>
                              <span className="ceo-pipe-val" style={{ color:PIPE_COLORS[i % PIPE_COLORS.length] }}>
                                {fmtL(val)}&nbsp;<span style={{ color:'#9ca3af', fontWeight:400 }}>({s.count ?? 0})</span>
                              </span>
                            </div>
                            <div className="ceo-pipe-track">
                              <div className="ceo-pipe-fill" style={{ width:`${pct}%`, background:PIPE_COLORS[i % PIPE_COLORS.length] }}/>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="ceo-pipe-total">
                      <span className="ceo-pipe-total-lbl">Total Pipeline Value</span>
                      <span className="ceo-pipe-total-val">{fmtL(pipeTotal)}</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Expense breakdown */}
            <div className="ceo-card">
              <div className="ceo-card-hd">
                <div>
                  <div className="ceo-card-title">Expense Breakdown</div>
                  <div className="ceo-card-sub">Current month by category</div>
                </div>
              </div>
              <div className="ceo-card-body">
                {loading ? (
                  <div className="ceo-sk" style={{ height:'100%', minHeight:140, borderRadius:8 }}/>
                ) : expenses.length === 0 ? (
                  <div className="ceo-empty">No expense data</div>
                ) : (
                  <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                    <PieChart width={110} height={110}>
                      <Pie
                        data={expenses.slice(0,5).map(e => ({ name:e.category, value:e.amount ?? 0 }))}
                        cx={55} cy={55} innerRadius={30} outerRadius={50}
                        dataKey="value" paddingAngle={2}
                      >
                        {expenses.slice(0,5).map((_, i) => <Cell key={i} fill={PIPE_COLORS[i % PIPE_COLORS.length]}/>)}
                      </Pie>
                      <Tooltip formatter={v => [fmtL(v), '']} contentStyle={{ fontSize:11, borderRadius:6 }}/>
                    </PieChart>
                    <div style={{ flex:1 }}>
                      {expenses.slice(0,5).map((e, i) => {
                        const amt = e.amount ?? 0;
                        const pct = Math.round((amt / expTotal) * 100);
                        return (
                          <div key={e.category || i} className="ceo-exp-row">
                            <div className="ceo-exp-dot" style={{ background:PIPE_COLORS[i % PIPE_COLORS.length] }}/>
                            <span className="ceo-exp-name">{e.category || 'Other'}</span>
                            <span className="ceo-exp-amt">{fmtL(amt)}</span>
                            <span className="ceo-exp-pct">{pct}%</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Top customers */}
            <div className="ceo-card">
              <div className="ceo-card-hd">
                <div>
                  <div className="ceo-card-title">Top Customers by Revenue</div>
                  <div className="ceo-card-sub">With gross margin</div>
                </div>
              </div>
              <div className="ceo-card-body">
                {commLoading ? (
                  <div className="ceo-sk" style={{ height:'100%', minHeight:140, borderRadius:8 }}/>
                ) : topCustomers.length === 0 ? (
                  <div className="ceo-empty">No data yet</div>
                ) : topCustomers.slice(0,6).map((c, i) => (
                  <div key={i} className="ceo-rank-row">
                    <div className="ceo-rank-l">
                      <div className="ceo-rank-badge" style={{ background:PIPE_COLORS[i % PIPE_COLORS.length] }}>{i+1}</div>
                      <span className="ceo-rank-name">{c.customer_name || c.name || 'Customer'}</span>
                    </div>
                    <div className="ceo-rank-r">
                      <div className="ceo-rank-val">{fmtL(c.total_revenue || c.revenue || 0)}</div>
                      {c.gross_margin_pct != null && (
                        <div className="ceo-rank-meta" style={{ color: c.gross_margin_pct >= 20 ? '#10b981' : c.gross_margin_pct >= 10 ? '#f59e0b' : '#ef4444' }}>
                          {Number(c.gross_margin_pct).toFixed(1)}% margin
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Top vendors */}
            <div className="ceo-card">
              <div className="ceo-card-hd">
                <div>
                  <div className="ceo-card-title">Top Vendors by Score</div>
                  <div className="ceo-card-sub">Scorecard &amp; risk rating</div>
                </div>
              </div>
              <div className="ceo-card-body">
                {commLoading ? (
                  <div className="ceo-sk" style={{ height:'100%', minHeight:140, borderRadius:8 }}/>
                ) : topVendors.length === 0 ? (
                  <div className="ceo-empty">No scorecards yet</div>
                ) : topVendors.slice(0,6).map((v, i) => {
                  const score = Number(v.avg_score || v.overall_score || 0);
                  const riskColor = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';
                  return (
                    <div key={i} className="ceo-rank-row">
                      <div className="ceo-rank-l">
                        <div className="ceo-rank-badge" style={{ background:riskColor }}>{i+1}</div>
                        <span className="ceo-rank-name">{v.vendor_name}</span>
                      </div>
                      <div className="ceo-rank-r">
                        <div className="ceo-rank-val" style={{ color:riskColor }}>{score.toFixed(1)}</div>
                        <div className="ceo-rank-meta" style={{ color:'#9ca3af' }}>{v.risk_rating || ''} Risk</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ────────────────────────── OPERATIONS ────────────────────────── */}
        {tab === 'operations' && (
          <div className="ceo-grid-ops">

              {/* Operations overview grid — full-width band, all 9 tiles in one row */}
              <div className="ceo-card ceo-ops-main">
                <div className="ceo-card-hd">
                  <div>
                    <div className="ceo-card-title">Operations Overview</div>
                    <div className="ceo-card-sub">Live counts across all modules</div>
                  </div>
                </div>
                <div className="ceo-card-body">
                  <div className="ceo-ops-grid">
                    {OPS_TILES.map(({ key, label, icon: Icon, color, route }) => {
                      const val = opsData[key] ?? 0;
                      const isAlert = (key === 'overdue_tasks' || key === 'low_stock') && val > 0;
                      return (
                        <div key={key} className={`ceo-op${isAlert ? ' ceo-op-alert' : ''}`}
                             style={{ '--c': color }}
                             onClick={() => navigate(`/${route}`)}
                             title={`Go to ${label}`}>
                          <div className="ceo-op-ico"><Icon size={14}/></div>
                          <div className="ceo-op-val" style={{ color: isAlert ? color : undefined }}>
                            {loading ? '—' : fmtNum(val)}
                          </div>
                          <div className="ceo-op-lbl">{label}</div>
                          {isAlert && <div className="ceo-op-dot"/>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

            <div className="ceo-ops-bottom">

              {/* System alerts */}
              <div className="ceo-card">
                <div className="ceo-card-hd">
                  <div>
                    <div className="ceo-card-title">System Alerts</div>
                    <div className="ceo-card-sub">Pending actions requiring attention</div>
                  </div>
                  {alertsReal.length > 0 && (
                    <span className="ceo-tab-badge">{alertsReal.length}</span>
                  )}
                </div>
                <div className="ceo-card-body">
                  {loading ? (
                    Array.from({ length:4 }).map((_, i) => (
                      <div key={i} className="ceo-sk" style={{ height:36, marginBottom:8, borderRadius:9 }}/>
                    ))
                  ) : alerts.length === 0 ? (
                    <div className="ceo-all-clear">
                      <CheckCircle size={24} color="#10b981"/>
                      <p>All systems healthy</p>
                      <span>No alerts requiring action</span>
                    </div>
                  ) : (
                    alerts.map((a, i) => {
                      const sev   = (a.priority || a.severity || a.level || 'info').toLowerCase();
                      const color = ALERT_CLR[sev] || '#6b7280';
                      const bg    = ALERT_BG[sev]  || '#f5f3ff';
                      return (
                        <div key={i} className="ceo-alert-item" style={{ background:bg }}>
                          <div className="ceo-alert-dot" style={{ background:color }}/>
                          <span className="ceo-alert-msg">{a.message || a.title || '—'}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Travel by employee */}
              <div className="ceo-card">
                <div className="ceo-card-hd">
                  <div>
                    <div className="ceo-card-title">Travel Cost by Employee</div>
                    <div className="ceo-card-sub">Top spenders</div>
                  </div>
                </div>
                <div className="ceo-card-body">
                  {commLoading ? (
                    <div className="ceo-sk" style={{ height:'100%', minHeight:120, borderRadius:8 }}/>
                  ) : travelByEmp.length === 0 ? (
                    <div className="ceo-empty">No travel data</div>
                  ) : travelByEmp.slice(0,6).map((e, i) => {
                    const amt = Number(e.total_cost || e.amount || 0);
                    const maxAmt = Number(travelByEmp[0]?.total_cost || travelByEmp[0]?.amount || 1);
                    return (
                      <div key={i} className="ceo-bar-row">
                        <div className="ceo-bar-meta">
                          <span className="ceo-bar-name">{e.employee_name || e.name || 'Employee'}</span>
                          <span className="ceo-bar-amt">{fmtL(amt)}</span>
                        </div>
                        <div className="ceo-bar-track">
                          <div className="ceo-bar-fill" style={{ width:`${Math.max((amt/maxAmt)*100, 2)}%`, background:'#6B3FDB' }}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Travel by project */}
              <div className="ceo-card">
                <div className="ceo-card-hd">
                  <div>
                    <div className="ceo-card-title">Travel Cost by Project</div>
                    <div className="ceo-card-sub">Top projects</div>
                  </div>
                </div>
                <div className="ceo-card-body">
                  {commLoading ? (
                    <div className="ceo-sk" style={{ height:'100%', minHeight:120, borderRadius:8 }}/>
                  ) : travelByProj.length === 0 ? (
                    <div className="ceo-empty">No travel-project data</div>
                  ) : travelByProj.slice(0,6).map((p, i) => {
                    const amt = Number(p.total_cost || p.amount || 0);
                    const maxAmt = Number(travelByProj[0]?.total_cost || travelByProj[0]?.amount || 1);
                    return (
                      <div key={i} className="ceo-bar-row">
                        <div className="ceo-bar-meta">
                          <span className="ceo-bar-name">{p.project_name || p.project_number || 'Project'}</span>
                          <span className="ceo-bar-amt">{fmtL(amt)}</span>
                        </div>
                        <div className="ceo-bar-track">
                          <div className="ceo-bar-fill" style={{ width:`${Math.max((amt/maxAmt)*100, 2)}%`, background:'#06b6d4' }}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Project profitability */}
              <div className="ceo-card">
                <div className="ceo-card-hd">
                  <div>
                    <div className="ceo-card-title">Project Profitability</div>
                    <div className="ceo-card-sub">Revenue vs cost &amp; margin</div>
                  </div>
                </div>
                <div className="ceo-card-body">
                  {commLoading ? (
                    <div className="ceo-sk" style={{ height:'100%', minHeight:120, borderRadius:8 }}/>
                  ) : projMargins.length === 0 ? (
                    <div className="ceo-empty">No project margin data</div>
                  ) : (
                    <table className="ceo-table">
                      <thead>
                        <tr>{['Project','Revenue','Profit','Margin'].map(h => <th key={h}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {projMargins.slice(0,10).map((p, i) => {
                          const margin = Number(p.gross_margin_pct || 0);
                          const mc = margin >= 20 ? '#10b981' : margin >= 10 ? '#f59e0b' : '#ef4444';
                          return (
                            <tr key={i}>
                              <td className="name" title={p.project_name || p.project_number || ''}>{p.project_name || p.project_number || '—'}</td>
                              <td>{fmtL(p.contract_value || 0)}</td>
                              <td style={{ fontWeight:600, color: Number(p.actual_profit||0) >= 0 ? '#10b981' : '#ef4444' }}>{fmtL(p.actual_profit || 0)}</td>
                              <td><span className="ceo-pill" style={{ background:`${mc}18`, color:mc }}>{margin.toFixed(1)}%</span></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
    </RequireRole>
  );
}
