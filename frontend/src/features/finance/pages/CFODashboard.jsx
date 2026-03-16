import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell, PieChart, Pie, ReferenceLine
} from 'recharts';
import {
  TrendingUp, TrendingDown, DollarSign, Target, AlertTriangle,
  CheckCircle, RefreshCw, Maximize2, X, ArrowUpRight,
  ArrowDownRight, Briefcase, CreditCard, BarChart2, Activity
} from 'lucide-react';
import api from '@/services/api/client';
import './CFODashboard.css';

// ── helpers ─────────────────────────────────────────────────────────────────
const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6'];

const fmt = (n) => {
  const v = parseFloat(n||0);
  if (v >= 10000000) return `₹${(v/10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v/100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v/1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const fmtCr = (n) => {
  const v = parseFloat(n||0);
  return v >= 10000000 ? `₹${(v/10000000).toFixed(2)} Cr`
       : v >= 100000   ? `₹${(v/100000).toFixed(2)} L`
       : `₹${v.toLocaleString('en-IN')}`;
};

const pct = (a, b) => b ? ((a/b)*100).toFixed(1) : '0.0';

const Trend = ({ value, suffix='%', invert=false }) => {
  const positive = invert ? value <= 0 : value >= 0;
  return (
    <span className={`cfo-trend ${positive?'up':'down'}`}>
      {positive ? <TrendingUp size={11}/> : <TrendingDown size={11}/>}
      {Math.abs(value).toFixed(1)}{suffix}
    </span>
  );
};

const Modal = ({ title, onClose, children }) => (
  <div className="cfo-overlay" onClick={onClose}>
    <div className="cfo-modal" onClick={e=>e.stopPropagation()}>
      <div className="cfo-modal-hd">
        <h3>{title}</h3>
        <button className="cfo-icon-btn" onClick={onClose}><X size={16}/></button>
      </div>
      <div className="cfo-modal-body">{children}</div>
    </div>
  </div>
);

const Card = ({ title, sub, children, expand, className='' }) => (
  <div className={`cfo-card ${className}`}>
    <div className="cfo-card-hd">
      <div>
        <span className="cfo-card-title">{title}</span>
        {sub && <span className="cfo-card-sub"> · {sub}</span>}
      </div>
      {expand && (
        <button className="cfo-icon-btn" onClick={expand}><Maximize2 size={13}/></button>
      )}
    </div>
    {children}
  </div>
);

// ── Gauge component ──────────────────────────────────────────────────────────
const Gauge = ({ value, max, label, color }) => {
  const pctVal = Math.min((value/max)*100, 100);
  const r = 54, cx = 70, cy = 70;
  const circumference = Math.PI * r; // half circle
  const dash = (pctVal/100) * circumference;
  return (
    <div className="cfo-gauge">
      <svg width="140" height="80" viewBox="0 0 140 80">
        <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`}
          fill="none" stroke="#f3f4f6" strokeWidth="12" strokeLinecap="round"/>
        <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`}
          fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}/>
        <text x={cx} y={cy-8} textAnchor="middle" fontSize="18" fontWeight="700" fill="#111827">
          {pctVal.toFixed(0)}%
        </text>
        <text x={cx} y={cy+8} textAnchor="middle" fontSize="10" fill="#9ca3af">{label}</text>
      </svg>
    </div>
  );
};

// ── Waterfall chart ──────────────────────────────────────────────────────────
const WaterfallChart = ({ data }) => {
  let running = 0;
  const bars = data.map(d => {
    const base = d.type === 'total' ? 0 : running;
    if (d.type !== 'total') running += d.value;
    return { ...d, base, display: Math.abs(d.value) };
  });
  const maxVal = Math.max(...bars.map(b => b.base + b.display));
  return (
    <div className="cfo-waterfall">
      {bars.map((b, i) => {
        const heightPct = (b.display / maxVal) * 100;
        const bottomPct = (b.base / maxVal) * 100;
        const color = b.type==='total' ? '#6366f1'
                    : b.value >= 0 ? '#10b981' : '#ef4444';
        return (
          <div key={i} className="cfo-wf-col">
            <div className="cfo-wf-bar-wrap">
              <div className="cfo-wf-spacer" style={{height:`${100-bottomPct-heightPct}%`}}/>
              <div className="cfo-wf-bar" style={{height:`${heightPct}%`,background:color}}/>
              <div className="cfo-wf-base" style={{height:`${bottomPct}%`}}/>
            </div>
            <div className="cfo-wf-val" style={{color}}>
              {b.value >= 0 ? '+' : ''}{fmt(b.value)}
            </div>
            <div className="cfo-wf-label">{b.label}</div>
          </div>
        );
      })}
    </div>
  );
};

// ── Main component ───────────────────────────────────────────────────────────
export default function CFODashboard({ setPage }) {
  const [loading,  setLoading]  = useState(true);
  const [data,     setData]     = useState({});
  const [lastSync, setLastSync] = useState(new Date());
  const [expand,   setExpand]   = useState(null);
  const [period,   setPeriod]   = useState('YTD'); // YTD | Q1 | Q2 | Q3 | Q4

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, rev, exp, cash, ratios] = await Promise.allSettled([
        api.get('/dashboard/data'),
        api.get('/dashboard/revenue'),
        api.get('/dashboard/expenses'),
        api.get('/dashboard/cash'),
        api.get('/finance/reports/profit-loss').catch(() => ({ data: null })),
      ]);
      setData({
        dash   : dash.status   === 'fulfilled' ? dash.value.data   : {},
        rev    : rev.status    === 'fulfilled' ? rev.value.data    : null,
        exp    : exp.status    === 'fulfilled' ? exp.value.data    : null,
        cash   : cash.status   === 'fulfilled' ? cash.value.data   : {},
        ratios : ratios.status === 'fulfilled' ? ratios.value.data : null,
      });
      setLastSync(new Date());
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="cfo-loading">
      <div className="cfo-spinner"/>
      <p>Loading CFO Dashboard…</p>
    </div>
  );

  // ── Derived data ────────────────────────────────────────────────────────
  const rev  = data.rev;
  const exp  = data.exp;
  const cash = data.cash || {};

  const ytd        = rev?.ytd       || 378000;
  const thisMonth  = rev?.thisMonth || 84000;
  const lastMonth  = rev?.lastMonth || 71000;
  const totalExp   = 272000;
  const grossProfit = ytd - totalExp;
  const netProfit   = grossProfit - 48000; // after tax & interest
  const ebitda      = grossProfit + 12000;
  const revTrend    = lastMonth ? ((thisMonth - lastMonth)/lastMonth*100) : 0;

  const revenueChart = rev
    ? rev.months.map((m,i) => ({ month:m, revenue:rev.values[i], target: rev.values[i]*1.1, profit: rev.values[i]*0.28 }))
    : [
        {month:'Oct',revenue:48000,target:52000,profit:13440},
        {month:'Nov',revenue:55000,target:58000,profit:15400},
        {month:'Dec',revenue:62000,target:65000,profit:17360},
        {month:'Jan',revenue:58000,target:65000,profit:16240},
        {month:'Feb',revenue:71000,target:72000,profit:19880},
        {month:'Mar',revenue:84000,target:80000,profit:23520},
      ];

  const expChart = exp
    ? exp.labels.map((l,i) => ({ name:l, value:exp.values[i] }))
    : [
        {name:'Salaries',value:155000},{name:'Operations',value:42000},
        {name:'Marketing',value:28000},{name:'Travel',value:14000},
        {name:'IT',value:18000},{name:'Other',value:15000},
      ];

  const cashFlowMonthly = [
    {month:'Oct',operating:14000,investing:-8000,financing:-2000,net:4000},
    {month:'Nov',operating:18000,investing:-5000,financing:-2000,net:11000},
    {month:'Dec',operating:22000,investing:-12000,financing:5000,net:15000},
    {month:'Jan',operating:16000,investing:-6000,financing:-2000,net:8000},
    {month:'Feb',operating:24000,investing:-8000,financing:-3000,net:13000},
    {month:'Mar',operating:28000,investing:-10000,financing:-2000,net:16000},
  ];

  const plWaterfall = [
    {label:'Revenue',   value:ytd,        type:'positive'},
    {label:'COGS',      value:-98000,      type:'negative'},
    {label:'Gross P',   value:grossProfit, type:'total'},
    {label:'OpEx',      value:-174000,     type:'negative'},
    {label:'EBITDA',    value:ebitda,      type:'total'},
    {label:'Depr.',     value:-8000,       type:'negative'},
    {label:'Interest',  value:-4000,       type:'negative'},
    {label:'Tax',       value:-36000,      type:'negative'},
    {label:'Net Profit',value:netProfit,   type:'total'},
  ];

  const ratiosData = [
    { label:'Current Ratio',    value:'2.4x',  bench:'2.0x', status:'good',    desc:'Liquidity health' },
    { label:'Quick Ratio',      value:'1.8x',  bench:'1.0x', status:'good',    desc:'Acid-test ratio' },
    { label:'Debt-to-Equity',   value:'0.42',  bench:'<1.0', status:'good',    desc:'Leverage ratio' },
    { label:'ROE',              value:'18.2%', bench:'15%',  status:'good',    desc:'Return on equity' },
    { label:'ROA',              value:'9.4%',  bench:'8%',   status:'good',    desc:'Return on assets' },
    { label:'Gross Margin',     value:`${pct(grossProfit,ytd)}%`, bench:'30%', status: parseFloat(pct(grossProfit,ytd)) >= 30 ? 'good' : 'warn', desc:'Gross profit margin' },
    { label:'Net Margin',       value:`${pct(netProfit,ytd)}%`,   bench:'15%', status: parseFloat(pct(netProfit,ytd))   >= 15 ? 'good' : 'warn', desc:'Net profit margin' },
    { label:'EBITDA Margin',    value:`${pct(ebitda,ytd)}%`,      bench:'20%', status: parseFloat(pct(ebitda,ytd))      >= 20 ? 'good' : 'warn', desc:'Operational efficiency' },
    { label:'A/R Days',         value:'38 days', bench:'<45d', status:'good',  desc:'Collection efficiency' },
    { label:'A/P Days',         value:'52 days', bench:'<60d', status:'good',  desc:'Payment cycle' },
    { label:'Inventory Turns',  value:'4.2x',    bench:'4.0x', status:'good',  desc:'Stock efficiency' },
    { label:'Interest Coverage',value:'8.4x',    bench:'>3x',  status:'good',  desc:'Debt service ability' },
  ];

  const forecastData = [
    {month:'Apr',conservative:82000,base:91000,optimistic:98000},
    {month:'May',conservative:85000,base:95000,optimistic:105000},
    {month:'Jun',conservative:88000,base:98000,optimistic:112000},
    {month:'Jul',conservative:90000,base:102000,optimistic:118000},
    {month:'Aug',conservative:92000,base:105000,optimistic:122000},
    {month:'Sep',conservative:95000,base:110000,optimistic:128000},
  ];

  const departmentROI = [
    {dept:'Engineering', revenue:180000, cost:98000,  roi:84},
    {dept:'Sales',       revenue:320000, cost:82000,  roi:290},
    {dept:'Marketing',   revenue:120000, cost:48000,  roi:150},
    {dept:'Operations',  revenue:95000,  cost:62000,  roi:53},
    {dept:'HR',          revenue:0,      cost:38000,  roi:-100},
  ];

  const RevenueVsTargetChart = ({height=240}) => (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={revenueChart} margin={{top:10,right:10,left:0,bottom:0}}>
        <defs>
          <linearGradient id="cfoRevGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.25}/>
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
        <XAxis dataKey="month" tick={{fontSize:12}}/>
        <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:11}}/>
        <Tooltip formatter={(v,n)=>[fmt(v), n==='revenue'?'Revenue':n==='target'?'Target':'Profit']}/>
        <Legend wrapperStyle={{fontSize:12}}/>
        <Area type="monotone" dataKey="revenue" stroke="#6366f1" strokeWidth={2.5}
          fill="url(#cfoRevGrad)" name="revenue"/>
        <Line type="monotone" dataKey="target" stroke="#f59e0b" strokeWidth={2}
          strokeDasharray="6 3" dot={false} name="target"/>
        <Bar dataKey="profit" fill="#10b981" opacity={0.7} radius={[3,3,0,0]} name="profit"/>
      </ComposedChart>
    </ResponsiveContainer>
  );

  const CashFlowChart = ({height=220}) => (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={cashFlowMonthly} margin={{top:10,right:10,left:0,bottom:0}}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
        <XAxis dataKey="month" tick={{fontSize:12}}/>
        <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:11}}/>
        <Tooltip formatter={(v,n)=>[fmt(v),n]}/>
        <Legend wrapperStyle={{fontSize:12}}/>
        <ReferenceLine y={0} stroke="#e5e7eb"/>
        <Bar dataKey="operating"  stackId="a" fill="#10b981" name="Operating" radius={[0,0,0,0]}/>
        <Bar dataKey="investing"  stackId="a" fill="#ef4444" name="Investing"/>
        <Bar dataKey="financing"  stackId="a" fill="#f59e0b" name="Financing"/>
      </BarChart>
    </ResponsiveContainer>
  );

  return (
    <div className="cfo-root">

      {/* Expand modal */}
      {expand && (
        <Modal title={
          expand==='revenue'  ? 'Revenue vs Target — Full View' :
          expand==='cashflow' ? 'Cash Flow Analysis — Full View' :
          expand==='forecast' ? 'Revenue Forecast — Next 6 Months' : ''
        } onClose={()=>setExpand(null)}>
          {expand==='revenue'  && <RevenueVsTargetChart height={420}/>}
          {expand==='cashflow' && <CashFlowChart height={420}/>}
          {expand==='forecast' && (
            <ResponsiveContainer width="100%" height={420}>
              <AreaChart data={forecastData} margin={{top:10,right:10,left:0,bottom:0}}>
                <defs>
                  <linearGradient id="optGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
                <XAxis dataKey="month" tick={{fontSize:12}}/>
                <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:11}}/>
                <Tooltip formatter={(v,n)=>[fmt(v),n]}/>
                <Legend wrapperStyle={{fontSize:12}}/>
                <Area type="monotone" dataKey="optimistic"    stroke="#6366f1" fill="url(#optGrad)" strokeWidth={1.5} name="Optimistic"/>
                <Area type="monotone" dataKey="base"          stroke="#10b981" fill="none"          strokeWidth={2.5} name="Base Case"/>
                <Area type="monotone" dataKey="conservative"  stroke="#f59e0b" fill="none"          strokeWidth={1.5} strokeDasharray="5 3" name="Conservative"/>
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
            {new Date().toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'long',year:'numeric'})}
            · Last updated: {lastSync.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}
          </p>
        </div>
        <div className="cfo-header-r">
          <div className="cfo-period">
            {['YTD','Q1','Q2','Q3','Q4'].map(p=>(
              <button key={p} className={`cfo-period-tab${period===p?' active':''}`}
                onClick={()=>setPeriod(p)}>{p}</button>
            ))}
          </div>
          <button className="cfo-refresh" onClick={load}>
            <RefreshCw size={14}/> Refresh
          </button>
        </div>
      </div>

      {/* ── Tier 1: Executive KPIs ──────────────────────────────── */}
      <div className="cfo-exec-kpis">

        <div className="cfo-exec-kpi cfo-kpi-rev">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">Revenue (YTD)</p>
            <h2 className="cfo-exec-val">{fmtCr(ytd)}</h2>
            <div className="cfo-exec-meta">
              <Trend value={revTrend}/>
              <span className="cfo-exec-vs">vs last month</span>
            </div>
          </div>
          <div className="cfo-exec-kpi-chart">
            <ResponsiveContainer width="100%" height={60}>
              <AreaChart data={revenueChart} margin={{top:5,right:0,left:0,bottom:0}}>
                <defs>
                  <linearGradient id="sparkRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#fff" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#fff" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="revenue" stroke="#fff" strokeWidth={2}
                  fill="url(#sparkRev)" dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="cfo-exec-kpi cfo-kpi-profit">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">Net Profit</p>
            <h2 className="cfo-exec-val">{fmtCr(netProfit)}</h2>
            <div className="cfo-exec-meta">
              <span className="cfo-margin-badge">{pct(netProfit,ytd)}% margin</span>
            </div>
          </div>
          <div className="cfo-exec-icon"><DollarSign size={32} opacity={0.3}/></div>
        </div>

        <div className="cfo-exec-kpi cfo-kpi-ebitda">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">EBITDA</p>
            <h2 className="cfo-exec-val">{fmtCr(ebitda)}</h2>
            <div className="cfo-exec-meta">
              <span className="cfo-margin-badge">{pct(ebitda,ytd)}% margin</span>
            </div>
          </div>
          <div className="cfo-exec-icon"><BarChart2 size={32} opacity={0.3}/></div>
        </div>

        <div className="cfo-exec-kpi cfo-kpi-cash">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">Cash & Equivalents</p>
            <h2 className="cfo-exec-val">{fmtCr(cash.balance||250000)}</h2>
            <div className="cfo-exec-meta">
              <ArrowUpRight size={13}/>
              <span className="cfo-exec-vs">Inflow: {fmt(cash.inflow||12000)}</span>
            </div>
          </div>
          <div className="cfo-exec-icon"><CreditCard size={32} opacity={0.3}/></div>
        </div>

        <div className="cfo-exec-kpi cfo-kpi-ar">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">Accounts Receivable</p>
            <h2 className="cfo-exec-val">{fmtCr(cash.accountsReceivable||185000)}</h2>
            <div className="cfo-exec-meta">
              <span className="cfo-exec-vs">38 days DSO</span>
            </div>
          </div>
          <div className="cfo-exec-icon"><Activity size={32} opacity={0.3}/></div>
        </div>

        <div className="cfo-exec-kpi cfo-kpi-burn">
          <div className="cfo-exec-kpi-body">
            <p className="cfo-exec-label">Monthly Burn Rate</p>
            <h2 className="cfo-exec-val">{fmtCr(totalExp/6)}</h2>
            <div className="cfo-exec-meta">
              <span className="cfo-exec-vs">Runway: 18 months</span>
            </div>
          </div>
          <div className="cfo-exec-icon"><Briefcase size={32} opacity={0.3}/></div>
        </div>

      </div>

      {/* ── Tier 2: Charts Row ───────────────────────────────────── */}
      <div className="cfo-grid">

        {/* Revenue vs Target */}
        <div className="cg8">
          <Card title="Revenue vs Target" sub="Last 6 months"
            expand={()=>setExpand('revenue')}>
            <div className="cfo-chart-meta">
              <div className="cfo-cm-chip cfo-cm-rev">
                <span>Revenue</span><strong>{fmtCr(ytd)}</strong>
                <Trend value={revTrend}/>
              </div>
              <div className="cfo-cm-chip cfo-cm-target">
                <span>Target</span><strong>{fmtCr(ytd*1.08)}</strong>
                <span className="cfo-cm-gap">Gap: {fmtCr(ytd*1.08-ytd)}</span>
              </div>
              <div className="cfo-cm-chip cfo-cm-profit">
                <span>Gross Profit</span><strong>{fmtCr(grossProfit)}</strong>
                <Trend value={5.2}/>
              </div>
            </div>
            <RevenueVsTargetChart height={220}/>
          </Card>
        </div>

        {/* P&L Waterfall */}
        <div className="cg4">
          <Card title="P&L Bridge" sub="YTD">
            <div className="cfo-pl-summary">
              <div className="cfo-pl-row">
                <span>Gross Margin</span>
                <strong className="green">{pct(grossProfit,ytd)}%</strong>
              </div>
              <div className="cfo-pl-row">
                <span>EBITDA Margin</span>
                <strong className="green">{pct(ebitda,ytd)}%</strong>
              </div>
              <div className="cfo-pl-row">
                <span>Net Margin</span>
                <strong className="green">{pct(netProfit,ytd)}%</strong>
              </div>
            </div>
            <WaterfallChart data={plWaterfall}/>
          </Card>
        </div>

        {/* Cash Flow */}
        <div className="cg6">
          <Card title="Cash Flow Breakdown" sub="Operating · Investing · Financing"
            expand={()=>setExpand('cashflow')}>
            <div className="cfo-cf-kpis">
              <div className="cfo-cf-kpi green">
                <ArrowUpRight size={14}/><span>Operating</span>
                <strong>{fmt(cashFlowMonthly.reduce((s,r)=>s+r.operating,0))}</strong>
              </div>
              <div className="cfo-cf-kpi red">
                <ArrowDownRight size={14}/><span>Investing</span>
                <strong>{fmt(cashFlowMonthly.reduce((s,r)=>s+r.investing,0))}</strong>
              </div>
              <div className="cfo-cf-kpi amber">
                <span>Net</span>
                <strong>{fmt(cashFlowMonthly.reduce((s,r)=>s+r.net,0))}</strong>
              </div>
            </div>
            <CashFlowChart height={190}/>
          </Card>
        </div>

        {/* Revenue Forecast */}
        <div className="cg6">
          <Card title="Revenue Forecast" sub="Next 6 months · 3 scenarios"
            expand={()=>setExpand('forecast')}>
            <div className="cfo-forecast-legend">
              <span className="cfo-fl-item" style={{color:'#6366f1'}}>● Optimistic</span>
              <span className="cfo-fl-item" style={{color:'#10b981'}}>● Base Case</span>
              <span className="cfo-fl-item" style={{color:'#f59e0b'}}>● Conservative</span>
            </div>
            <ResponsiveContainer width="100%" height={210}>
              <AreaChart data={forecastData} margin={{top:5,right:10,left:0,bottom:0}}>
                <defs>
                  <linearGradient id="optG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.12}/>
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
                <XAxis dataKey="month" tick={{fontSize:12}}/>
                <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:11}}/>
                <Tooltip formatter={(v,n)=>[fmt(v),n]}/>
                <Area type="monotone" dataKey="optimistic"   stroke="#6366f1" fill="url(#optG)" strokeWidth={1.5}/>
                <Area type="monotone" dataKey="base"         stroke="#10b981" fill="none"        strokeWidth={2.5}/>
                <Area type="monotone" dataKey="conservative" stroke="#f59e0b" fill="none"        strokeWidth={1.5} strokeDasharray="5 3"/>
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        </div>

        {/* Financial Ratios */}
        <div className="cg6">
          <Card title="Key Financial Ratios" sub="vs Industry Benchmark">
            <div className="cfo-ratios-grid">
              {ratiosData.map((r,i)=>(
                <div key={i} className={`cfo-ratio-item cfo-ratio-${r.status}`}>
                  <div className="cfo-ratio-label">{r.label}</div>
                  <div className="cfo-ratio-val">{r.value}</div>
                  <div className="cfo-ratio-bench">Bench: {r.bench}</div>
                  {r.status==='good'
                    ? <CheckCircle size={12} className="cfo-ratio-icon green"/>
                    : <AlertTriangle size={12} className="cfo-ratio-icon amber"/>}
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Department ROI */}
        <div className="cg6">
          <Card title="Department ROI Analysis" sub="Cost vs Revenue contribution">
            <div className="cfo-roi-list">
              {departmentROI.map((d,i)=>{
                const roiPos = d.roi >= 0;
                const maxCost = Math.max(...departmentROI.map(x=>x.cost));
                return (
                  <div key={i} className="cfo-roi-row">
                    <div className="cfo-roi-dept">{d.dept}</div>
                    <div className="cfo-roi-bars">
                      <div className="cfo-roi-bar-wrap">
                        <div className="cfo-roi-cost-bar"
                          style={{width:`${(d.cost/maxCost)*100}%`}}/>
                      </div>
                      {d.revenue > 0 && (
                        <div className="cfo-roi-bar-wrap">
                          <div className="cfo-roi-rev-bar"
                            style={{width:`${(d.revenue/(Math.max(...departmentROI.map(x=>x.revenue))||1))*100}%`}}/>
                        </div>
                      )}
                    </div>
                    <div className="cfo-roi-nums">
                      <span className="cfo-roi-cost">Cost: {fmt(d.cost)}</span>
                      {d.revenue > 0 && <span className="cfo-roi-rev">Rev: {fmt(d.revenue)}</span>}
                    </div>
                    <div className={`cfo-roi-badge ${roiPos?'good':'neg'}`}>
                      {d.roi > 0 ? '+' : ''}{d.roi}%
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        {/* Working Capital Gauges */}
        <div className="cg4">
          <Card title="Working Capital Health">
            <div className="cfo-gauges">
              <Gauge value={74} max={100} label="Collection" color="#10b981"/>
              <Gauge value={62} max={100} label="Cash Ratio"  color="#6366f1"/>
              <Gauge value={88} max={100} label="Liquidity"   color="#f59e0b"/>
            </div>
            <div className="cfo-wc-stats">
              <div className="cfo-wc-stat">
                <span>Working Capital</span>
                <strong className="green">{fmtCr(cash.accountsReceivable - (cash.accountsPayable||94000)||91000)}</strong>
              </div>
              <div className="cfo-wc-stat">
                <span>Current Ratio</span>
                <strong className="green">2.4x</strong>
              </div>
              <div className="cfo-wc-stat">
                <span>Quick Ratio</span>
                <strong className="green">1.8x</strong>
              </div>
            </div>
          </Card>
        </div>

        {/* Expense by Category */}
        <div className="cg4">
          <Card title="Expense Structure" sub="YTD breakdown">
            <div className="cfo-exp-total">
              <span>Total Opex</span>
              <strong>{fmtCr(expChart.reduce((s,e)=>s+e.value,0))}</strong>
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie data={expChart} cx="50%" cy="50%" innerRadius={48} outerRadius={72}
                  dataKey="value" paddingAngle={3}>
                  {expChart.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                </Pie>
                <Tooltip formatter={v=>[fmt(v),'']}/>
              </PieChart>
            </ResponsiveContainer>
            <div className="cfo-exp-legend">
              {expChart.map((e,i)=>(
                <div key={i} className="cfo-exp-row">
                  <span className="cfo-exp-dot" style={{background:COLORS[i%COLORS.length]}}/>
                  <span className="cfo-exp-name">{e.name}</span>
                  <span className="cfo-exp-pct">{pct(e.value,expChart.reduce((s,x)=>s+x.value,0))}%</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Executive Alerts */}
        <div className="cg4">
          <Card title="Executive Alerts">
            {[
              {level:'high',   msg:'Marketing dept 4% over budget',      action:'Review'},
              {level:'medium', msg:'GSTR-3B filing due in 5 days',       action:'File Now'},
              {level:'medium', msg:'3 overdue invoices — ₹48K at risk',  action:'Follow Up'},
              {level:'low',    msg:'Q1 audit report ready for review',   action:'View'},
              {level:'low',    msg:'2 vendor contracts expiring Apr 1',  action:'Renew'},
            ].map((a,i)=>(
              <div key={i} className={`cfo-alert cfo-alert-${a.level}`}>
                <div className="cfo-alert-body">
                  {a.level==='high'
                    ? <AlertTriangle size={13}/>
                    : <CheckCircle size={13}/>}
                  <span>{a.msg}</span>
                </div>
                <button className="cfo-alert-action">{a.action}</button>
              </div>
            ))}
          </Card>
        </div>

      </div>
    </div>
  );
}