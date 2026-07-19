// PATH: frontend/src/components/dashboard/DashboardEngine.jsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  IndianRupee, Users, Target, Briefcase, Clock, AlertTriangle,
  RefreshCw, ChevronRight, Zap, ArrowUpRight, Activity,
  HeadphonesIcon, Package, FileText, UserCheck, CheckCircle,
  TrendingUp, TrendingDown,
} from 'lucide-react';
import {
  AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import api from '../../services/api/client';
import './DashboardEngine.css';

/* ── constants ──────────────────────────────────────────────────────────────*/
const BRAND   = '#6B3FDB';
const PALETTE = ['#6B3FDB','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#14b8a6','#f97316'];
const AV_POOL = ['#6d28d9','#0369a1','#047857','#b45309','#be123c','#0f766e','#7c2d12','#1e40af'];
const ACT_C   = { Auth:'#6B3FDB', Leaves:'#10b981', Finance:'#f59e0b', Employees:'#3b82f6', CRM:'#8b5cf6', default:'#9ca3af' };
const STAGE_C = [BRAND,'#8b5cf6','#f59e0b','#ef4444','#10b981'];

const INSIGHT_STYLE = {
  success: { bg:'#f0fdf4', border:'#bbf7d0', text:'#166534' },
  warning: { bg:'#fffbeb', border:'#fde68a', text:'#92400e' },
  danger:  { bg:'#fef2f2', border:'#fecaca', text:'#991b1b' },
  info:    { bg:'#f5f3ff', border:'#e9e4ff', text:'#5b21b6' },
};

/* ── helpers ────────────────────────────────────────────────────────────────*/
const fmt = n => {
  if (!n && n !== 0) return '₹0';
  const v = parseFloat(n);
  if (v >= 10_000_000) return `₹${(v/10_000_000).toFixed(1)}Cr`;
  if (v >= 100_000)    return `₹${(v/100_000).toFixed(1)}L`;
  if (v >= 1_000)      return `₹${(v/1_000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};
const fmtD = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const ago  = ts => {
  if (!ts) return '';
  const m = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
};
function aBg(n='') {
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) & 0xffffffff;
  return AV_POOL[Math.abs(h) % AV_POOL.length];
}

/* ── AI insights ────────────────────────────────────────────────────────────*/
function buildInsights({ revTrend, pendAppr, pipeline, alertCount }) {
  const out = [];
  if (revTrend > 10)
    out.push({ t:'success', e:'📈', tx:`Revenue up ${revTrend}% MoM — strong growth. Consider accelerating Q4 targets.` });
  else if (revTrend < -5)
    out.push({ t:'danger',  e:'📉', tx:`Revenue down ${Math.abs(revTrend)}% MoM. Review pipeline conversion and close rates.` });
  else
    out.push({ t:'info',    e:'💹', tx:`Revenue stable at ${revTrend >= 0 ? '+' : ''}${revTrend}% MoM. Focus on deal acceleration.` });

  if (pendAppr > 10)
    out.push({ t:'warning', e:'⏰', tx:`${pendAppr} approvals pending. Delays may impact team productivity.` });
  else if (pendAppr > 0)
    out.push({ t:'info',    e:'📋', tx:`${pendAppr} approval${pendAppr > 1 ? 's' : ''} awaiting action. Target <48 hr resolution.` });
  else
    out.push({ t:'success', e:'✅', tx:`All approvals cleared. Excellent team response time.` });

  if (pipeline > 0) {
    const fc = fmt(pipeline * 0.22);
    out.push({ t:'info', e:'🎯', tx:`Pipeline at ${fmt(pipeline)}. At 22% conversion, estimated close: ~${fc} this month.` });
  }

  if (alertCount > 3)
    out.push({ t:'warning', e:'🔔', tx:`${alertCount} active alerts. Unresolved issues may impact operations continuity.` });
  else
    out.push({ t:'success', e:'🟢', tx:`System health is good. ${alertCount || 'No'} active alert${alertCount !== 1 ? 's' : ''}.` });

  return out.slice(0, 4);
}

/* ── custom tooltip ─────────────────────────────────────────────────────────*/
const RevTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:8, padding:'8px 12px', fontSize:12 }}>
      <div style={{ fontWeight:600, color:'#374151', marginBottom:3 }}>{label}</div>
      <div style={{ color:BRAND, fontWeight:700 }}>{fmt(payload[0].value)}</div>
    </div>
  );
};

/* ── loading skeleton ───────────────────────────────────────────────────────*/
const Skeleton = () => (
  <div className="de-loading">
    <div className="de-loading-hd">
      <div className="de-sk" style={{ width:240, height:28, borderRadius:8 }}/>
      <div style={{ display:'flex', gap:8 }}>
        <div className="de-sk" style={{ width:100, height:34, borderRadius:8 }}/>
        <div className="de-sk" style={{ width:80,  height:34, borderRadius:8 }}/>
      </div>
    </div>
    <div className="de-loading-kpis">
      {Array.from({ length:6 }).map((_,i) => (
        <div key={i} className="de-sk" style={{ height:112, borderRadius:12 }}/>
      ))}
    </div>
    <div className="de-sk" style={{ height:80, borderRadius:12, marginBottom:20 }}/>
    <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:16, marginBottom:16 }}>
      <div className="de-sk" style={{ height:260, borderRadius:12 }}/>
      <div className="de-sk" style={{ height:260, borderRadius:12 }}/>
    </div>
    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:16 }}>
      {Array.from({ length:3 }).map((_,i) => (
        <div key={i} className="de-sk" style={{ height:220, borderRadius:12 }}/>
      ))}
    </div>
  </div>
);

/* ══════════════════════════════════════════════════════════════════════════ */
export default function DashboardEngine({ role: _role, setPage }) {
  const [rev,      setRev]      = useState({ months:[], values:[], ytd:0, thisMonth:0, lastMonth:0 });
  const [exp,      setExp]      = useState({ labels:[], values:[] });
  const [wf,       setWf]       = useState({ total:0, active:0, newHires:0, attendanceRate:0, byDepartment:[] });
  const [appr,     setAppr]     = useState({ total:0, pending:[], summary:[] });
  const [alerts,   setAlerts]   = useState([]);
  const [sales,    setSales]    = useState([]);
  const [activity, setActivity] = useState([]);
  const [ops,      setOps]      = useState({});
  const [cash,     setCash]     = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [lastSync, setLastSync] = useState(new Date());
  const [actTab,   setActTab]   = useState('24h');
  const [mfg,           setMfg]           = useState({});
  const [myLeave,       setMyLeave]       = useState([]);
  const [myTasks,       setMyTasks]       = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [projHealth,    setProjHealth]    = useState({});
  const [celebs,        setCelebs]        = useState(null);
  const [holidays,      setHolidays]      = useState([]);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const nav = useCallback(p => setPage && setPage(p), [setPage]);

  const load = useCallback(async (quiet = false) => {
    if (quiet) setSpinning(true);
    else setLoading(true);
    const [rR, eR, wR, apR, alR, slR, acR, opR, cpR, mfR, mlR, mtR, anR, phR, cbR, hlR] = await Promise.allSettled([
      api.get('/dashboard/revenue'),
      api.get('/dashboard/expenses'),
      api.get('/dashboard/workforce'),
      api.get('/dashboard/approvals'),
      api.get('/dashboard/alerts'),
      api.get('/dashboard/sales'),
      api.get('/dashboard/activity'),
      api.get('/dashboard/operations'),
      api.get('/dashboard/cash'),
      api.get('/dashboard/manufacturing'),
      api.get('/hr/leaves/my-balance'),
      api.get('/tasks/my-tasks?status=open'),
      api.get('/announcements?limit=3'),
      api.get('/dashboard/project-health'),
      api.get('/dashboard/celebrations'),
      api.get('/holidays?upcoming=true'),
    ]);

    if (!isMounted.current) return;

    if (rR.status  === 'fulfilled' && rR.value.data?.months?.length)  setRev(rR.value.data);
    if (eR.status  === 'fulfilled' && eR.value.data)                   setExp(eR.value.data);
    if (wR.status  === 'fulfilled' && wR.value.data)                   setWf(prev => ({ ...prev, ...wR.value.data }));
    if (apR.status === 'fulfilled' && apR.value.data)                  setAppr(apR.value.data);
    if (alR.status === 'fulfilled') {
      const d = alR.value.data;
      setAlerts(d?.alerts || (Array.isArray(d) ? d : []));
    }
    if (slR.status === 'fulfilled') {
      const d = slR.value.data;
      setSales(d?.stages || (Array.isArray(d) ? d : []));
    }
    if (acR.status === 'fulfilled') {
      const d = acR.value.data;
      setActivity(d?.activities || (Array.isArray(d) ? d : []));
    }
    if (opR.status === 'fulfilled' && opR.value.data)  setOps(opR.value.data);
    if (cpR.status === 'fulfilled' && cpR.value.data)  setCash(cpR.value.data);
    if (mfR.status === 'fulfilled' && mfR.value.data)  setMfg(mfR.value.data);
    if (mlR.status === 'fulfilled' && mlR.value.data) {
      const d = mlR.value.data;
      setMyLeave(Array.isArray(d) ? d : (d?.balances || d?.leaves || []));
    }
    if (mtR.status === 'fulfilled' && mtR.value.data) {
      const d = mtR.value.data;
      setMyTasks(Array.isArray(d) ? d : (d?.tasks || []));
    }
    if (anR.status === 'fulfilled' && anR.value.data) {
      const d = anR.value.data;
      setAnnouncements(Array.isArray(d) ? d : (d?.announcements || d?.data || []));
    }
    if (phR.status === 'fulfilled' && phR.value.data) {
      setProjHealth(phR.value.data);
    }
    if (cbR.status === 'fulfilled' && cbR.value.data) {
      setCelebs(cbR.value.data);
    }
    if (hlR.status === 'fulfilled') {
      const d = hlR.value.data;
      setHolidays(Array.isArray(d) ? d.slice(0, 5) : []);
    }

    setLastSync(new Date());
    setLoading(false);
    setSpinning(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => load(true), 300000);
    return () => clearInterval(t);
  }, [load]);

  /* ── derived ──────────────────────────────────────────────────────────── */
  const revChart  = (rev.months || []).map((m, i) => ({ month: m, revenue: rev.values?.[i] || 0 }));
  const expChart  = (exp.labels || []).map((l, i) => ({ name: l, value: exp.values?.[i] || 0 }));
  const totalExp  = expChart.reduce((s, e) => s + (e.value || 0), 0);
  const ytd       = rev.ytd || revChart.reduce((s, r) => s + r.revenue, 0);
  const thisMo    = rev.thisMonth  || revChart.at(-1)?.revenue || 0;
  const lastMo    = rev.lastMonth  || revChart.at(-2)?.revenue || 0;
  const revTrend  = lastMo ? Math.round(((thisMo - lastMo) / lastMo) * 100) : 0;
  const pipeline  = sales.reduce((s, st) => s + (st.value || 0), 0);
  const highAl    = alerts.filter(a => a.priority === 'high').length;
  const pendAppr  = appr?.total || 0;
  const cashBal   = cash?.balance || 0;

  const insights = useMemo(() => buildInsights({ revTrend, pendAppr, pipeline, alertCount: alerts.length }),
    [revTrend, pendAppr, pipeline, alerts.length]);

  const filteredAct = useMemo(() => {
    const now = Date.now();
    return activity.filter(a => {
      if (!a.created_at) return false;
      const d = now - new Date(a.created_at).getTime();
      if (isNaN(d)) return false;
      return actTab === '24h' ? d < 86400000 : actTab === '48h' ? d < 172800000 : d < 604800000;
    });
  }, [activity, actTab]);

  const greet = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  };
  const userName = localStorage.getItem('name') || localStorage.getItem('userName') || 'there';

  /* ── KPI config ───────────────────────────────────────────────────────── */
  const kpis = [
    { icon:IndianRupee,    color:'kv', label:'Revenue YTD',      value:fmt(ytd),              sub:`${revTrend>=0?'+':''}${revTrend}% vs last month`,  page:'FinanceDashboardNew' },
    { icon:Users,         color:'kg', label:'Total Employees',   value:wf.total||0,           sub:`${wf.newHires||0} joined this month`,              page:'EmployeesDashboard'  },
    { icon:Target,        color:'kb', label:'Sales Pipeline',    value:fmt(pipeline),         sub:`${sales.reduce((s,x)=>s+(x.count||0),0)} open deals`, page:'SalesDashboard'   },
    { icon:Briefcase,     color:'ky', label:'Active Projects',   value:ops.active_projects||0,sub:'Across all departments',                           page:'ProjectsDashboard'  },
    { icon:Clock,         color:'kp', label:'Pending Approvals', value:pendAppr,              sub:'Requires your action',                             page:'ApprovalCenter'     },
    { icon:AlertTriangle, color:'kr', label:'Open Alerts',       value:alerts.length,         sub:`${highAl} high priority`,                          page:null                 },
  ];


  if (loading) return <Skeleton />;

  return (
    <div className="de-root">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="de-header">
        <div>
          <h1 className="de-title">{greet()}, {userName.split(' ')[0]} 👋</h1>
          <p className="de-subtitle">
            {new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
            &nbsp;·&nbsp;
            <span style={{ color:BRAND, fontWeight:500 }}>ERP Dashboard</span>
            &nbsp;&nbsp;
            <span className="de-live">LIVE</span>
          </p>
        </div>
        <div className="de-header-r">
          <span className="de-sync">Synced {lastSync.toLocaleTimeString('en-IN',{ hour:'2-digit', minute:'2-digit' })}</span>
          <button className="de-btn primary" onClick={() => load(true)} disabled={spinning}>
            <RefreshCw size={13} className={spinning ? 'de-spinning' : ''} />
            {spinning ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── KPI Strip ─────────────────────────────────────────────────────── */}
      <div className="de-kpi-grid">
        {kpis.map((k, i) => (
          <div key={i} className={`de-kpi ${k.color}`}
            onClick={() => k.page && nav(k.page)}
            style={{ cursor: k.page ? 'pointer' : 'default' }}
          >
            <div className="de-kpi-top">
              <div className="de-kpi-ico"><k.icon size={17} color="#fff"/></div>
              <span className="de-kpi-label">{k.label}</span>
            </div>
            <div className="de-kpi-val">{k.value}</div>
            <div className="de-kpi-bot">
              <span className="de-kpi-sub">{k.sub}</span>
              {k.page && <ChevronRight size={13} className="de-kpi-arrow"/>}
            </div>
          </div>
        ))}
      </div>

      {/* ── AI Insights ───────────────────────────────────────────────────── */}
      <div className="de-insights">
        <div className="de-insights-hd">
          <div className="de-ai-icon"><Zap size={16} color={BRAND}/></div>
          <div>
            <div className="de-insights-title">AI Business Insights</div>
            <div className="de-insights-sub">Generated from live KPI data</div>
          </div>
          <span className="de-insights-badge">{insights.length} insights</span>
        </div>
        <div className="de-insights-grid">
          {insights.map((ins, i) => {
            const c = INSIGHT_STYLE[ins.t];
            return (
              <div key={i} className="de-insight-pill"
                style={{ background:c.bg, border:`1px solid ${c.border}` }}>
                <span className="de-insight-emoji">{ins.e}</span>
                <span className="de-insight-text" style={{ color:c.text }}>{ins.tx}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Row 2: Revenue Trend + Sales Pipeline ─────────────────────────── */}
      <div className="de-row2">

        {/* Revenue Trend */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">Revenue Trend</div>
              <div className="de-card-sub">Monthly performance · last {revChart.length} months</div>
            </div>
            <div style={{ display:'flex', alignItems:'center' }}>
              <span style={{ fontSize:12, color:'#9ca3af' }}>YTD: <strong style={{ color:'#1a1a2e' }}>{fmt(ytd)}</strong></span>
              <span className={`de-trend-pill ${revTrend >= 0 ? 'up' : 'down'}`}>
                {revTrend >= 0 ? '▲' : '▼'} {Math.abs(revTrend)}%
              </span>
            </div>
          </div>
          {revChart.length === 0 ? (
            <div className="de-empty"><span className="de-empty-ico">📊</span><p className="de-empty-msg">No revenue data yet</p></div>
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <AreaChart data={revChart} margin={{ top:4, right:8, left:0, bottom:0 }}>
                <defs>
                  <linearGradient id="deRevGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={BRAND} stopOpacity={0.18}/>
                    <stop offset="95%" stopColor={BRAND} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false}/>
                <XAxis dataKey="month" tick={{ fontSize:11, fill:'#9ca3af' }} axisLine={false} tickLine={false}/>
                <YAxis tickFormatter={v => fmt(v)} tick={{ fontSize:11, fill:'#9ca3af' }} axisLine={false} tickLine={false} width={50}/>
                <Tooltip content={<RevTooltip/>}/>
                <Area type="monotone" dataKey="revenue" stroke={BRAND} strokeWidth={2.5}
                  fill="url(#deRevGrad)"
                  dot={{ r:3, fill:'#fff', stroke:BRAND, strokeWidth:2 }}
                  activeDot={{ r:5, fill:BRAND, stroke:'#fff', strokeWidth:2 }}/>
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Sales Pipeline */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">Sales Pipeline</div>
              <div className="de-card-sub">{sales.length} stages</div>
            </div>
            <button className="de-card-link" onClick={() => nav('SalesDashboard')}>
              View <ArrowUpRight size={11}/>
            </button>
          </div>
          {sales.length === 0 ? (
            <div className="de-empty"><span className="de-empty-ico">📭</span><p className="de-empty-msg">No pipeline data</p></div>
          ) : (
            <>
              <div className="de-pipe-row">
                {sales.map((s, i) => {
                  const max = Math.max(...sales.map(x => x.value));
                  const pct = max ? Math.round((s.value / max) * 100) : 0;
                  return (
                    <div key={i}>
                      <div className="de-pipe-labels">
                        <span className="de-pipe-stage">{s.stage}</span>
                        <span className="de-pipe-val" style={{ color:STAGE_C[i%STAGE_C.length] }}>{fmt(s.value)}</span>
                      </div>
                      <div className="de-pipe-track">
                        <div className="de-pipe-fill" style={{ width:`${pct}%`, background:STAGE_C[i%STAGE_C.length] }}/>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="de-pipe-total">
                <div className="de-pipe-total-lbl">Total Pipeline Value</div>
                <div className="de-pipe-total-val">{fmt(pipeline)}</div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Row 3: Expense Breakdown + Cash Position + Operations ─────────── */}
      <div className="de-row3">

        {/* Expense Breakdown */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">Expense Breakdown</div>
              <div className="de-card-sub">Total: {fmt(totalExp)}</div>
            </div>
            <button className="de-card-link" onClick={() => nav('FinanceDashboardNew')}>
              Reports <ArrowUpRight size={11}/>
            </button>
          </div>
          {expChart.length === 0 ? (
            <div className="de-empty"><span className="de-empty-ico">💸</span><p className="de-empty-msg">No expense data</p></div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={130}>
                <PieChart>
                  <Pie data={expChart} cx="50%" cy="50%" innerRadius={38} outerRadius={56}
                    dataKey="value" paddingAngle={3}>
                    {expChart.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]}/>)}
                  </Pie>
                  <Tooltip formatter={v => [fmt(v), '']} contentStyle={{ borderRadius:8, border:'1px solid #f0f0f4', fontSize:12 }}/>
                </PieChart>
              </ResponsiveContainer>
              <div className="de-exp-leg">
                {expChart.map((e, i) => (
                  <div key={i} className="de-exp-row">
                    <span className="de-exp-dot" style={{ background:PALETTE[i % PALETTE.length] }}/>
                    <span className="de-exp-name">{e.name}</span>
                    <span className="de-exp-amt">{fmt(e.value)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Cash Position */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">Cash Position</div>
              <div className="de-card-sub">Live bank & receivables</div>
            </div>
            <button className="de-card-link" onClick={() => nav('BankAccounts')}>
              Bank <ArrowUpRight size={11}/>
            </button>
          </div>
          <div className="de-cash-bal-lbl">Net Cash Balance</div>
          <div className="de-cash-bal-val" style={{ color: cashBal >= 0 ? '#10b981' : '#ef4444' }}>
            {fmt(Math.abs(cashBal))}
          </div>
          {cashBal < 0 && <div className="de-cash-warn">⚠ Deficit — review payables</div>}
          <div className="de-cash-grid">
            {[
              { label:'Receivable', val:cash?.accountsReceivable||0, color:'#10b981' },
              { label:'Payable',    val:cash?.accountsPayable||0,    color:'#ef4444' },
              { label:'Inflow MTD', val:cash?.inflow||0,             color:'#3b82f6' },
              { label:'Outflow MTD',val:cash?.outflow||0,            color:'#8b5cf6' },
            ].map((c, i) => (
              <div key={i} className="de-cash-item">
                <div className="de-ci-lbl">{c.label}</div>
                <div className="de-ci-val" style={{ color:c.color }}>{fmt(c.val)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Operations Status */}
        <div className="de-card">
          <div className="de-card-hd">
            <div className="de-card-title">Operations at a Glance</div>
          </div>
          <div className="de-ops-grid">
            {[
              { icon:Activity,       label:'Active Projects',  val:ops.active_projects||0,   color:'#3b82f6', page:'ProjectsDashboard'  },
              { icon:HeadphonesIcon, label:'Open Tickets',     val:ops.open_tickets||0,       color:'#f59e0b', page:'AllTickets'          },
              { icon:Package,        label:'Low Stock',        val:ops.low_stock||0,          color:'#ef4444', page:'StockSummary'        },
              { icon:FileText,       label:'Pending Invoices', val:ops.pending_invoices||0,   color:BRAND,     page:'InvoicesNew'         },
              { icon:UserCheck,      label:'On Leave Today',   val:ops.on_leave||0,           color:'#8b5cf6', page:'AllLeaves'           },
              { icon:CheckCircle,    label:'Tasks Done MTD',   val:ops.tasks_completed||0,    color:'#10b981', page:'KanbanBoard'         },
              { icon:Clock,          label:'Overdue Tasks',    val:ops.overdue_tasks||0,      color:'#ef4444', page:'KanbanBoard'         },
              { icon:Briefcase,      label:'Open Positions',   val:ops.open_recruitments||0,  color:'#8b5cf6', page:'JobOpenings'         },
              { icon:Users,          label:'Timesheets Pend.', val:ops.timesheets_pending||0, color:'#f59e0b', page:'TimesheetApprovals'  },
            ].map((o, i) => (
              <div key={i} className="de-op" style={{'--c':o.color}} onClick={() => nav(o.page)}>
                <div className="de-op-ico"><o.icon size={13}/></div>
                <div className="de-op-val">{o.val}</div>
                <div className="de-op-lbl">{o.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Row 4: Activity + Pending Approvals ───────────────────────────── */}
      <div className="de-row4">

        {/* Recent Activity */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">Recent Activity</div>
              <div className="de-card-sub">Audit trail across all modules</div>
            </div>
            <button className="de-card-link" onClick={() => nav('AuditLogs')}>
              Full Log <ArrowUpRight size={11}/>
            </button>
          </div>
          <div className="de-act-tabs">
            {[['24h','Last 24h'],['48h','Last 48h'],['7d','7 Days']].map(([f, l]) => (
              <button key={f} className={`de-act-tab${actTab === f ? ' active' : ''}`}
                onClick={() => setActTab(f)}>{l}</button>
            ))}
            <span className="de-act-count">{filteredAct.length} events</span>
          </div>
          <div className="de-act-scroll">
            {filteredAct.length === 0 ? (
              <div className="de-empty"><span className="de-empty-ico">🗂</span><p className="de-empty-msg">No activity in this period</p></div>
            ) : filteredAct.slice(0, 20).map((a, i) => {
              const c = ACT_C[a.module] || ACT_C.default;
              return (
                <div key={i} className="de-act-row">
                  <div className="de-act-dot" style={{ background:c }}/>
                  <div className="de-act-info">
                    <div className="de-act-action">{a.action}</div>
                    <div className="de-act-desc">{a.description}</div>
                  </div>
                  <div className="de-act-r">
                    {a.module && (
                      <span className="de-act-mod" style={{ background:`${c}14`, color:c }}>{a.module}</span>
                    )}
                    <span className="de-act-time">{ago(a.created_at)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Pending Approvals */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">Pending Approvals</div>
              <div className="de-card-sub">{pendAppr > 0 ? `${pendAppr} awaiting action` : 'All cleared'}</div>
            </div>
            <button className="de-card-link" onClick={() => nav('ApprovalCenter')}>
              View all <ArrowUpRight size={11}/>
            </button>
          </div>

          {(appr?.summary || []).length > 0 && (
            <div className="de-appr-chips">
              {appr.summary.map((s, i) => (
                <span key={i} className="de-chip">
                  <span className="de-chip-dot" style={{ background:PALETTE[i] }}/>
                  {s.type}
                  <strong style={{ background:PALETTE[i] }}>{s.count}</strong>
                </span>
              ))}
            </div>
          )}

          {(appr?.pending || []).length === 0 ? (
            <div className="de-clear">
              <CheckCircle size={26} color="#10b981"/>
              <p>No pending approvals</p>
              <span>All approvals have been processed</span>
            </div>
          ) : (
            (appr?.pending || []).slice(0, 6).map((p, i) => {
              const name = `${p.employee_name || 'Employee'}`;
              return (
                <div key={i} className="de-appr-row" onClick={() => nav('ApprovalCenter')}>
                  <div className="de-av" style={{ background:aBg(name) }}>{name[0].toUpperCase()}</div>
                  <div className="de-appr-info">
                    <div className="de-appr-name">{name}</div>
                    <div className="de-appr-meta">{p.type} · {fmtD(p.start_date)}</div>
                  </div>
                  <span className="de-pend-badge">Pending</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Row 5: Manufacturing CC + Project Health + Profitability ─────── */}
      <div className="de-row3" style={{ marginTop: 16 }}>

        {/* Manufacturing Command Center */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">Manufacturing Command</div>
              <div className="de-card-sub">Live production floor status</div>
            </div>
            <button className="de-card-link" onClick={() => nav('ProductionOrders')}>
              Floor <ArrowUpRight size={11}/>
            </button>
          </div>
          <div className="de-ops-grid" style={{ gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
            {[
              { label:'Production Orders', val:mfg.production_orders||0, color:'#6B3FDB', page:'ProductionOrders'  },
              { label:'Open NCRs',         val:mfg.open_ncrs||0,          color:'#ef4444', page:'QualityNCR'        },
              { label:'Pending FAT',        val:mfg.pending_fat||0,        color:'#f59e0b', page:'TestHistorian'     },
              { label:'ECN Approvals',      val:mfg.ecn_pending||0,        color:'#8b5cf6', page:'EngineeringChanges'},
              { label:'MRP Shortages',      val:mfg.mrp_shortages||ops.low_stock||0, color:'#ef4444', page:'StockSummary' },
              { label:'AMC Renewals Due',   val:mfg.amc_renewals||0,       color:'#f59e0b', page:'AMCContracts'      },
            ].map((o, i) => (
              <div key={i} className="de-op" style={{'--c':o.color}} onClick={() => nav(o.page)}>
                <div className="de-op-val" style={{ fontSize:20 }}>{o.val}</div>
                <div className="de-op-lbl">{o.label}</div>
              </div>
            ))}
          </div>
          {(mfg.open_service_tickets ?? ops.open_tickets ?? 0) > 0 && (
            <div style={{ marginTop:10, padding:'7px 10px', borderRadius:8, background:'#fff7ed', border:'1px solid #fed7aa', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <span style={{ fontSize:12, color:'#92400e', fontWeight:500 }}>Open Service Tickets</span>
              <span style={{ fontSize:14, fontWeight:700, color:'#f59e0b' }}>{mfg.open_service_tickets ?? ops.open_tickets}</span>
            </div>
          )}
        </div>

        {/* Project Health */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">Project Health</div>
              <div className="de-card-sub">Active projects status</div>
            </div>
            <button className="de-card-link" onClick={() => nav('ProjectsDashboard')}>
              View <ArrowUpRight size={11}/>
            </button>
          </div>
          <div className="de-ph-kpis">
            {[
              { label:'Active',       val: projHealth.active_projects  || ops.active_projects  || 0, color:'#3b82f6' },
              { label:'Overdue Tasks',val: projHealth.overdue_tasks    || ops.overdue_tasks     || 0, color:'#ef4444' },
              { label:'At Risk',      val: projHealth.at_risk          || 0,                          color:'#f59e0b' },
              { label:'Done MTD',     val: projHealth.completed_this_month || ops.tasks_completed|| 0, color:'#10b981' },
            ].map((p, i) => (
              <div key={i} className="de-ph-kpi">
                <div className="de-ph-val" style={{ color: p.color }}>{p.val}</div>
                <div className="de-ph-lbl">{p.label}</div>
              </div>
            ))}
          </div>
          {projHealth.budget_used != null && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'#9ca3af', marginBottom:4 }}>
                <span>Budget Utilization</span>
                <span style={{ color:'#1a1a2e', fontWeight:600 }}>{projHealth.budget_used}%</span>
              </div>
              <div className="de-pipe-track">
                <div className="de-pipe-fill" style={{
                  width: `${Math.min(projHealth.budget_used, 100)}%`,
                  background: projHealth.budget_used > 90 ? '#ef4444' : projHealth.budget_used > 75 ? '#f59e0b' : '#10b981',
                }}/>
              </div>
            </div>
          )}
        </div>

        {/* Profitability */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">Profitability</div>
              <div className="de-card-sub">Revenue vs expenses · this month</div>
            </div>
          </div>
          {(() => {
            const net      = thisMo - totalExp;
            const margin   = thisMo > 0 ? Math.round((net / thisMo) * 100) : 0;
            const isProfit = net >= 0;
            return (
              <div className="de-profit-wrap">
                <div className="de-profit-items">
                  {[
                    { label:'Revenue',    val: fmt(thisMo),          color:'#3b82f6' },
                    { label:'Expenses',   val: fmt(totalExp),         color:'#ef4444' },
                    { label:'Net Profit', val: fmt(Math.abs(net)),    color: isProfit ? '#10b981' : '#ef4444' },
                  ].map((p, i) => (
                    <div key={i} className="de-profit-item">
                      <span className="de-profit-lbl">{p.label}</span>
                      <span className="de-profit-val" style={{ color: p.color }}>
                        {i === 2 && !isProfit ? '−' : ''}{p.val}
                      </span>
                    </div>
                  ))}
                </div>
                <div className={`de-profit-margin ${isProfit ? 'up' : 'down'}`}>
                  {isProfit ? '▲' : '▼'} {Math.abs(margin)}% net margin this month
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── Row 6A: Celebrations + Upcoming Holidays ─────────────────────── */}
      {(celebs || holidays.length > 0) && (
        <div className="de-row3" style={{ marginTop: 16 }}>

          {/* Birthdays & Anniversaries */}
          <div className="de-card" style={{ gridColumn: 'span 2' }}>
            <div className="de-card-hd">
              <div>
                <div className="de-card-title">Celebrations</div>
                <div className="de-card-sub">Birthdays & work anniversaries</div>
              </div>
            </div>
            {(() => {
              const bdToday   = celebs?.birthdays?.today     || [];
              const bdWeek    = celebs?.birthdays?.this_week || [];
              const annToday  = celebs?.anniversaries?.today      || [];
              const annMonth  = celebs?.anniversaries?.this_month || [];
              const total = bdToday.length + bdWeek.length + annToday.length + annMonth.length;
              if (!celebs || total === 0) {
                return <div className="de-empty"><span className="de-empty-ico">🎉</span><p className="de-empty-msg">No celebrations today</p></div>;
              }
              return (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {bdToday.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>🎂 Birthdays Today</div>
                      {bdToday.map((p, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                          <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#6B3FDB', flexShrink: 0 }}>
                            {p.name[0].toUpperCase()}
                          </div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937' }}>{p.name}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{p.department}{p.age ? ` · Turns ${p.age}` : ''}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {annToday.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>🎉 Work Anniversaries Today</div>
                      {annToday.map((p, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                          <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#10b981', flexShrink: 0 }}>
                            {p.name[0].toUpperCase()}
                          </div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937' }}>{p.name}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{p.years} year{p.years !== 1 ? 's' : ''} · {p.department}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {bdWeek.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>🎂 Birthdays This Week</div>
                      {bdWeek.map((p, i) => (
                        <div key={i} style={{ fontSize: 13, color: '#374151', padding: '4px 0' }}>{p.name} <span style={{ color: '#9ca3af', fontSize: 11 }}>({p.department})</span></div>
                      ))}
                    </div>
                  )}
                  {annMonth.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>🎉 Anniversaries This Month</div>
                      {annMonth.map((p, i) => (
                        <div key={i} style={{ fontSize: 13, color: '#374151', padding: '4px 0' }}>{p.name} — {p.years}yr <span style={{ color: '#9ca3af', fontSize: 11 }}>({p.department})</span></div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Upcoming Holidays */}
          <div className="de-card">
            <div className="de-card-hd">
              <div>
                <div className="de-card-title">Upcoming Holidays</div>
                <div className="de-card-sub">From the holiday calendar</div>
              </div>
            </div>
            {holidays.length === 0 ? (
              <div className="de-empty"><span className="de-empty-ico">📅</span><p className="de-empty-msg">No upcoming holidays</p></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {holidays.map((h, i) => {
                  const d = new Date(h.date);
                  const isToday = d.toDateString() === new Date().toDateString();
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px', borderRadius: 8,
                      background: isToday ? '#f5f3ff' : '#f9fafb',
                      border: `1px solid ${isToday ? '#e9e4ff' : '#e5e7eb'}`,
                    }}>
                      <div style={{
                        width: 36, flexShrink: 0, textAlign: 'center',
                        fontSize: 13, fontWeight: 700,
                        color: isToday ? '#6B3FDB' : '#374151',
                      }}>
                        <div>{d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</div>
                        <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>{d.toLocaleDateString('en-IN', { month: 'short' })}</div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</div>
                        {h.type && <div style={{ fontSize: 11, color: '#9ca3af' }}>{h.type}</div>}
                      </div>
                      {isToday && <span style={{ fontSize: 10, fontWeight: 700, color: '#6B3FDB', background: '#ede9fe', padding: '2px 7px', borderRadius: 20 }}>Today</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Row 6: My Leave + My Tasks + Announcements ────────────────────── */}
      <div className="de-row3" style={{ marginTop: 16, marginBottom: 8 }}>

        {/* My Leave Balance */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">My Leave Balance</div>
              <div className="de-card-sub">Remaining days by type</div>
            </div>
            <button className="de-card-link" onClick={() => nav('AllLeaves')}>
              Apply <ArrowUpRight size={11}/>
            </button>
          </div>
          {myLeave.length === 0 ? (
            <div className="de-empty"><span className="de-empty-ico">🌴</span><p className="de-empty-msg">No leave data</p></div>
          ) : (
            <div className="de-leave-list">
              {myLeave.map((l, i) => {
                const total = l.total || l.entitled || 0;
                const used  = l.used  || 0;
                const bal   = l.balance != null ? l.balance : (total - used);
                const pct   = total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
                const c     = PALETTE[i % PALETTE.length];
                return (
                  <div key={i} className="de-leave-row">
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                      <span className="de-leave-type">{l.type || l.leave_type}</span>
                      <span className="de-leave-bal" style={{ color: c }}>{bal} days left</span>
                    </div>
                    <div className="de-pipe-track">
                      <div className="de-pipe-fill" style={{ width:`${pct}%`, background: c }}/>
                    </div>
                    <div style={{ fontSize:10, color:'#9ca3af', marginTop:2 }}>{used}/{total} used</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* My Open Tasks */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">My Open Tasks</div>
              <div className="de-card-sub">{myTasks.length} pending</div>
            </div>
            <button className="de-card-link" onClick={() => nav('KanbanBoard')}>
              Board <ArrowUpRight size={11}/>
            </button>
          </div>
          {myTasks.length === 0 ? (
            <div className="de-empty"><span className="de-empty-ico">✅</span><p className="de-empty-msg">No open tasks</p></div>
          ) : (
            <div className="de-tasks-list">
              {myTasks.slice(0, 5).map((t, i) => {
                const pri  = (t.priority || 'medium').toLowerCase();
                const priC = { high:'#ef4444', medium:'#f59e0b', low:'#10b981', critical:'#7c3aed' }[pri] || '#9ca3af';
                const od   = t.due_date && new Date(t.due_date) < new Date();
                return (
                  <div key={i} className="de-task-row">
                    <span className="de-task-pri" style={{ background:`${priC}18`, color: priC }}>{pri}</span>
                    <div className="de-task-title">{t.task_title || t.title || t.name}</div>
                    {t.due_date && (
                      <div className="de-task-due" style={{ color: od ? '#ef4444' : '#9ca3af' }}>
                        {od ? '⚠ ' : ''}{fmtD(t.due_date)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Announcements */}
        <div className="de-card">
          <div className="de-card-hd">
            <div>
              <div className="de-card-title">Announcements</div>
              <div className="de-card-sub">Latest updates</div>
            </div>
          </div>
          {announcements.length === 0 ? (
            <div className="de-empty"><span className="de-empty-ico">📢</span><p className="de-empty-msg">No announcements</p></div>
          ) : (
            <div className="de-ann-list">
              {announcements.map((a, i) => {
                const isRead = a.is_read || a.read || false;
                return (
                  <div key={i} className="de-ann-row">
                    <div className={`de-ann-indicator ${isRead ? 'read' : 'unread'}`}/>
                    <div className="de-ann-body">
                      <div className="de-ann-title" style={{ fontWeight: isRead ? 500 : 700 }}>
                        {a.title}
                      </div>
                      {a.body && (
                        <div className="de-ann-preview">
                          {a.body.length > 75 ? a.body.slice(0, 75) + '…' : a.body}
                        </div>
                      )}
                      <div className="de-ann-time">{ago(a.created_at || a.date)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
