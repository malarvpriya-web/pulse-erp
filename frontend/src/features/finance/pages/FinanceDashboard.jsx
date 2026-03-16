import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell, PieChart, Pie
} from 'recharts';
import {
  TrendingUp, TrendingDown, DollarSign, FileText, AlertTriangle,
  CheckCircle, Clock, RefreshCw, ArrowUpRight, ArrowDownRight,
  CreditCard, Banknote, Receipt, Building2, ChevronRight,
  Maximize2, X, Calendar, Filter
} from 'lucide-react';
import {
  getFinanceDashboard, getInvoices,
} from '../services/financeService';
import api from '@/services/api/client';
import './FinanceDashboard.css';

const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899'];

const fmt = (n) => {
  if (!n && n !== 0) return '₹0';
  const num = parseFloat(n);
  if (num >= 10000000) return `₹${(num/10000000).toFixed(2)}Cr`;
  if (num >= 100000)   return `₹${(num/100000).toFixed(1)}L`;
  if (num >= 1000)     return `₹${(num/1000).toFixed(0)}K`;
  return `₹${num.toFixed(0)}`;
};

const fmtN = (n) => parseFloat(n||0).toLocaleString('en-IN',{maximumFractionDigits:0});

const TrendBadge = ({ value, suffix='%' }) => {
  const up = value >= 0;
  return (
    <span className={`fd-trend ${up?'up':'down'}`}>
      {up ? <TrendingUp size={11}/> : <TrendingDown size={11}/>}
      {Math.abs(value)}{suffix}
    </span>
  );
};

const KPI = ({ icon:Icon, label, value, sub, trend, color, alert, onClick }) => (
  <div className={`fd-kpi${alert?' fd-kpi-alert':''}`}
    style={{'--c':color}} onClick={onClick}
    role={onClick?'button':undefined} tabIndex={onClick?0:undefined}>
    <div className="fd-kpi-icon"><Icon size={19}/></div>
    <div className="fd-kpi-body">
      <p className="fd-kpi-label">{label}</p>
      <h3 className="fd-kpi-val">{value}</h3>
      {sub && <p className="fd-kpi-sub">{sub}</p>}
    </div>
    {trend !== undefined && <TrendBadge value={trend}/>}
  </div>
);

const Card = ({ title, children, action, expand, badge }) => (
  <div className="fd-card">
    <div className="fd-card-hd">
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <span className="fd-card-title">{title}</span>
        {badge && <span className="fd-badge">{badge}</span>}
      </div>
      <div style={{display:'flex',gap:6}}>
        {action && <button className="fd-text-btn" onClick={action.fn}>{action.label}</button>}
        {expand && <button className="fd-icon-btn" onClick={expand}><Maximize2 size={13}/></button>}
      </div>
    </div>
    <div className="fd-card-body">{children}</div>
  </div>
);

const ExpandModal = ({ title, onClose, children }) => (
  <div className="fd-overlay" onClick={onClose}>
    <div className="fd-modal" onClick={e=>e.stopPropagation()}>
      <div className="fd-modal-hd">
        <h3>{title}</h3>
        <button className="fd-icon-btn" onClick={onClose}><X size={16}/></button>
      </div>
      <div className="fd-modal-body">{children}</div>
    </div>
  </div>
);

const statusColor = (s) => {
  if (!s) return '#9ca3af';
  const m = s.toLowerCase();
  if (m.includes('paid')||m.includes('approved')) return '#10b981';
  if (m.includes('overdue')) return '#ef4444';
  if (m.includes('pending')) return '#f59e0b';
  if (m.includes('draft')) return '#9ca3af';
  return '#6366f1';
};

export default function FinanceDashboard({ setPage }) {
  const [data,       setData]      = useState({});
  const [loading,    setLoading]   = useState(true);
  const [lastSync,   setLastSync]  = useState(new Date());
  const [expand,     setExpand]    = useState(null);
  const [period,     setPeriod]    = useState('month'); // month | quarter | year
  const [activeTab,  setActiveTab] = useState('overview'); // overview | receivables | payables | gst

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, rev, exp, appr, cash] = await Promise.allSettled([
        getFinanceDashboard(),
        api.get('/dashboard/revenue'),
        api.get('/dashboard/expenses'),
        api.get('/dashboard/approvals'),
        api.get('/dashboard/cash'),
      ]);
      const inv = await getInvoices({ limit: 10 });
      setData({
        dash : dash.status  === 'fulfilled' ? dash.value  : {},
        rev  : rev.status   === 'fulfilled' ? rev.value.data   : null,
        exp  : exp.status   === 'fulfilled' ? exp.value.data   : null,
        appr : appr.status  === 'fulfilled' ? appr.value.data  : null,
        inv,
        cash : cash.status  === 'fulfilled' ? cash.value.data  : {},
      });
      setLastSync(new Date());
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

   // ── derived ────────────────────────────────────────────────────────────
  const dash = data.dash || {};
  const rev  = data.rev;
  const exp  = data.exp;
  const cash = data.cash || {};

  const monthRev  = dash.monthly_revenue  || rev?.thisMonth  || 84000;
  const monthExp  = dash.monthly_expenses || 62000;
  const netProfit = monthRev - monthExp;
  const profitPct = monthRev ? Math.round((netProfit/monthRev)*100) : 0;
  const overdueAmt   = dash.overdue_amount   || 0;
  const overdueCount = dash.overdue_invoices || 0;
  const dueSoon      = dash.due_soon_invoices|| 0;
  const pendingAppr  = dash.pending_approvals|| 0;
  const ar = cash.accountsReceivable || 185000;
  const ap = cash.accountsPayable    || 94000;

  const revChart = rev
    ? rev.months.map((m,i)=>({month:m, revenue:rev.values[i], expenses:rev.values[i]*0.72}))
    : [{month:'Oct',revenue:48000,expenses:34000},{month:'Nov',revenue:55000,expenses:39000},
       {month:'Dec',revenue:62000,expenses:44000},{month:'Jan',revenue:58000,expenses:42000},
       {month:'Feb',revenue:71000,expenses:50000},{month:'Mar',revenue:84000,expenses:60000}];

  const expChart = exp
    ? exp.labels.map((l,i)=>({name:l,value:exp.values[i]}))
    : [{name:'Salaries',value:42000},{name:'Operations',value:12000},
       {name:'Marketing',value:8500},{name:'Travel',value:4200},
       {name:'IT',value:6300},{name:'Other',value:3100}];
  const totalExp = expChart.reduce((s,e)=>s+e.value,0);

  const cashFlowData = [
    {month:'Oct',inflow:52000,outflow:38000},{month:'Nov',inflow:61000,outflow:43000},
    {month:'Dec',inflow:68000,outflow:47000},{month:'Jan',inflow:63000,outflow:45000},
    {month:'Feb',inflow:77000,outflow:53000},{month:'Mar',inflow:91000,outflow:62000},
  ];

  const agingAR = [
    {bucket:'0–30 days', amount:85000, count:8},
    {bucket:'31–60 days',amount:52000, count:5},
    {bucket:'61–90 days',amount:31000, count:3},
    {bucket:'>90 days',  amount:17000, count:2},
  ];
  const agingAP = [
    {bucket:'0–30 days', amount:44000, count:6},
    {bucket:'31–60 days',amount:28000, count:4},
    {bucket:'61–90 days',amount:14000, count:2},
    {bucket:'>90 days',  amount:8000,  count:1},
  ];

  const gstData = {
    gstr1:  {status:'Filed',  period:'Feb 2026', due:'11 Mar', liability:38400},
    gstr3b: {status:'Pending',period:'Feb 2026', due:'20 Mar', liability:38400},
    gstr2b: {status:'Available',period:'Feb 2026',due:'—',     itc:24800},
    tds:    {status:'Due',    period:'Feb 2026', due:'7 Mar',  amount:12600},
    itc:    {available:24800, utilized:18200,    balance:6600},
    summary:[
      {label:'Output GST (Sales)',  amount:38400, type:'liability'},
      {label:'Input ITC (Purchases)',amount:24800,type:'credit'},
      {label:'Net GST Payable',     amount:13600, type:'payable'},
      {label:'TDS Deducted',        amount:12600, type:'liability'},
    ]
  };

 const rawInv = data.inv?.rows || data.inv?.invoices || data.inv?.data || data.inv;
const topInvoices = Array.isArray(rawInv)
  ? rawInv.slice(0,8)
  : [
      {invoice_number:'INV-012',party_name:'TechCorp Ltd',   total_amount:125000,status:'paid',   due_date:'2026-02-28'},
      {invoice_number:'INV-011',party_name:'Alpha Solutions', total_amount:145000,status:'pending',due_date:'2026-03-30'},
      {invoice_number:'INV-010',party_name:'Gamma Corp',      total_amount:93000, status:'overdue',due_date:'2026-03-01'},
      {invoice_number:'INV-009',party_name:'Beta Systems',    total_amount:62000, status:'pending',due_date:'2026-03-25'},
      {invoice_number:'INV-008',party_name:'Epsilon Tech',    total_amount:78000, status:'pending',due_date:'2026-04-05'},
    ];

  const budgetData = [
    {dept:'Engineering',budget:120000,actual:98000},
    {dept:'Marketing',  budget:50000, actual:52000},
    {dept:'Operations', budget:80000, actual:71000},
    {dept:'HR',         budget:30000, actual:24000},
    {dept:'Finance',    budget:25000, actual:22000},
  ];

  const tabs = [
    {id:'overview',    label:'Overview'},
    {id:'receivables', label:'Receivables'},
    {id:'payables',    label:'Payables'},
    {id:'gst',         label:'GST & Tax'},
  ];

  const RevExpChart = ({height=220}) => (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={revChart} margin={{top:10,right:10,left:0,bottom:0}}>
        <defs>
          <linearGradient id="revG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.3}/>
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
          </linearGradient>
          <linearGradient id="expG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.2}/>
            <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
        <XAxis dataKey="month" tick={{fontSize:12}}/>
        <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:11}}/>
        <Tooltip formatter={(v,n)=>[fmt(v), n==='revenue'?'Revenue':'Expenses']}/>
        <Legend wrapperStyle={{fontSize:12}}/>
        <Area type="monotone" dataKey="revenue"  stroke="#6366f1" strokeWidth={2.5} fill="url(#revG)" dot={{r:3}}/>
        <Area type="monotone" dataKey="expenses" stroke="#ef4444" strokeWidth={2}   fill="url(#expG)" dot={{r:3}}/>
      </AreaChart>
    </ResponsiveContainer>
  );

  return (
    <div className="fd-root">

      {expand && (
        <ExpandModal title={expand==='revexp'?'Revenue vs Expenses':expand==='cashflow'?'Cash Flow':'Chart'} onClose={()=>setExpand(null)}>
          {expand==='revexp'   && <RevExpChart height={400}/>}
          {expand==='cashflow' && (
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={cashFlowData} margin={{top:10,right:10,left:0,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
                <XAxis dataKey="month" tick={{fontSize:12}}/>
                <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:11}}/>
                <Tooltip formatter={(v,n)=>[fmt(v),n==='inflow'?'Inflow':'Outflow']}/>
                <Legend wrapperStyle={{fontSize:12}}/>
                <Bar dataKey="inflow"  fill="#10b981" radius={[4,4,0,0]} name="inflow"/>
                <Bar dataKey="outflow" fill="#ef4444" radius={[4,4,0,0]} name="outflow"/>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ExpandModal>
      )}

      {/* Header */}
      <div className="fd-header">
        <div>
          <h2 className="fd-title">Finance Dashboard</h2>
          <p className="fd-sub">Last updated: {lastSync.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</p>
        </div>
        <div className="fd-header-r">
          <div className="fd-period-tabs">
            {['month','quarter','year'].map(p=>(
              <button key={p} className={`fd-period-tab${period===p?' active':''}`}
                onClick={()=>setPeriod(p)}>
                {p.charAt(0).toUpperCase()+p.slice(1)}
              </button>
            ))}
          </div>
          <button className="fd-refresh-btn" onClick={load}>
            <RefreshCw size={14}/> Refresh
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="fd-kpis">
        <KPI icon={TrendingUp}   label="Monthly Revenue"  value={fmt(monthRev)}
          trend={18} color="#6366f1" sub={`YTD: ${fmt(rev?.ytd||378000)}`}
          onClick={()=>setPage&&setPage('FinanceReports')}/>
        <KPI icon={TrendingDown} label="Monthly Expenses" value={fmt(monthExp)}
          trend={-5} color="#ef4444" sub={`${((monthExp/monthRev)*100).toFixed(0)}% of revenue`}/>
        <KPI icon={DollarSign}   label="Net Profit"       value={fmt(netProfit)}
          trend={profitPct} color="#10b981"
          sub={`Margin: ${profitPct}%`}/>
        <KPI icon={Banknote}     label="Cash Balance"     value={fmt(cash.balance||250000)}
          color="#3b82f6" sub={`AR: ${fmt(ar)} · AP: ${fmt(ap)}`}/>
        <KPI icon={AlertTriangle} label="Overdue Invoices" value={overdueCount}
          color="#ef4444" alert={overdueCount>0}
          sub={`${fmt(overdueAmt)} at risk`}
          onClick={()=>setActiveTab('receivables')}/>
        <KPI icon={Clock}        label="Due in 7 Days"    value={`${dueSoon} invoices`}
          color="#f59e0b" sub="Requires follow-up"/>
        <KPI icon={Receipt}      label="GST Payable"      value={fmt(gstData.summary[2].amount)}
          color="#8b5cf6" sub={`Due: ${gstData.gstr3b.due}`}
          onClick={()=>setActiveTab('gst')}/>
        <KPI icon={CheckCircle}  label="Pending Approvals" value={pendingAppr||0}
          color="#f59e0b" sub="Bills & expenses"
          onClick={()=>setPage&&setPage('ApprovalCenter')}/>
      </div>

      {/* Tab navigation */}
      <div className="fd-tabs">
        {tabs.map(t=>(
          <button key={t.id} className={`fd-tab${activeTab===t.id?' active':''}`}
            onClick={()=>setActiveTab(t.id)}>
            {t.label}
            {t.id==='gst' && gstData.gstr3b.status==='Pending' &&
              <span className="fd-tab-dot"/>}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW TAB ─────────────────────────────────────────── */}
      {activeTab==='overview' && (
        <div className="fd-grid">

          {/* Revenue vs Expenses */}
          <div className="fc8">
            <Card title="Revenue vs Expenses" expand={()=>setExpand('revexp')}>
              <div className="fd-chart-meta">
                <div className="fd-cm-item">
                  <span className="fd-cm-dot" style={{background:'#6366f1'}}/>
                  <span>Revenue</span>
                  <strong>{fmt(monthRev)}</strong>
                  <TrendBadge value={18}/>
                </div>
                <div className="fd-cm-item">
                  <span className="fd-cm-dot" style={{background:'#ef4444'}}/>
                  <span>Expenses</span>
                  <strong>{fmt(monthExp)}</strong>
                  <TrendBadge value={-5}/>
                </div>
                <div className="fd-cm-item">
                  <span className="fd-cm-dot" style={{background:'#10b981'}}/>
                  <span>Net Profit</span>
                  <strong>{fmt(netProfit)}</strong>
                  <TrendBadge value={profitPct}/>
                </div>
              </div>
              <RevExpChart height={210}/>
            </Card>
          </div>

          {/* P&L Summary */}
          <div className="fc4">
            <Card title="P&L Summary">
              <div className="fd-pl">
                <div className="fd-pl-section">
                  <p className="fd-pl-heading">Income</p>
                  <div className="fd-pl-row"><span>Sales Revenue</span><span className="green">{fmt(monthRev)}</span></div>
                  <div className="fd-pl-row"><span>Other Income</span><span className="green">{fmt(4200)}</span></div>
                  <div className="fd-pl-row total"><span>Gross Income</span><span className="green">{fmt(monthRev+4200)}</span></div>
                </div>
                <div className="fd-pl-section">
                  <p className="fd-pl-heading">Expenses</p>
                  <div className="fd-pl-row"><span>Cost of Goods</span><span className="red">{fmt(28000)}</span></div>
                  <div className="fd-pl-row"><span>Operating Exp</span><span className="red">{fmt(monthExp-28000)}</span></div>
                  <div className="fd-pl-row total"><span>Total Expenses</span><span className="red">{fmt(monthExp)}</span></div>
                </div>
                <div className="fd-pl-net">
                  <span>Net Profit</span>
                  <span className={netProfit>=0?'green':'red'}>{fmt(netProfit)}</span>
                </div>
                <div className="fd-pl-margin">
                  <span>Profit Margin</span>
                  <strong className="green">{profitPct}%</strong>
                </div>
              </div>
            </Card>
          </div>

          {/* Cash Flow */}
          <div className="fc6">
            <Card title="Cash Flow — Last 6 Months" expand={()=>setExpand('cashflow')}>
              <div className="fd-cf-summary">
                <div className="fd-cf-item">
                  <ArrowUpRight size={16} color="#10b981"/>
                  <span>Total Inflow</span>
                  <strong className="green">{fmt(cashFlowData.reduce((s,r)=>s+r.inflow,0))}</strong>
                </div>
                <div className="fd-cf-item">
                  <ArrowDownRight size={16} color="#ef4444"/>
                  <span>Total Outflow</span>
                  <strong className="red">{fmt(cashFlowData.reduce((s,r)=>s+r.outflow,0))}</strong>
                </div>
                <div className="fd-cf-item">
                  <DollarSign size={16} color="#6366f1"/>
                  <span>Net Position</span>
                  <strong className="blue">{fmt(cash.balance||250000)}</strong>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={cashFlowData} margin={{top:5,right:10,left:0,bottom:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
                  <XAxis dataKey="month" tick={{fontSize:11}}/>
                  <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:11}}/>
                  <Tooltip formatter={(v,n)=>[fmt(v),n==='inflow'?'Inflow':'Outflow']}/>
                  <Bar dataKey="inflow"  fill="#10b981" radius={[3,3,0,0]} name="inflow"/>
                  <Bar dataKey="outflow" fill="#ef4444" radius={[3,3,0,0]} name="outflow"/>
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </div>

          {/* Expense Breakdown */}
          <div className="fc6">
            <Card title="Expense Breakdown">
              <div className="fd-exp-wrap">
                <ResponsiveContainer width="45%" height={160}>
                  <PieChart>
                    <Pie data={expChart} cx="50%" cy="50%" innerRadius={45} outerRadius={70}
                      dataKey="value" paddingAngle={3}>
                      {expChart.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                    </Pie>
                    <Tooltip formatter={v=>[fmt(v),'']}/>
                  </PieChart>
                </ResponsiveContainer>
                <div className="fd-exp-legend">
                  {expChart.map((e,i)=>(
                    <div key={i} className="fd-exp-row">
                      <span className="fd-exp-dot" style={{background:COLORS[i%COLORS.length]}}/>
                      <span className="fd-exp-name">{e.name}</span>
                      <span className="fd-exp-pct">{((e.value/totalExp)*100).toFixed(1)}%</span>
                      <span className="fd-exp-amt">{fmt(e.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          {/* Budget vs Actual */}
          <div className="fc6">
            <Card title="Budget vs Actual — This Month">
              {budgetData.map((b,i)=>{
                const pct = Math.round((b.actual/b.budget)*100);
                const over = pct > 100;
                return (
                  <div key={i} className="fd-budget-row">
                    <span className="fd-budget-dept">{b.dept}</span>
                    <div className="fd-budget-track">
                      <div className="fd-budget-bar" style={{
                        width:`${Math.min(pct,100)}%`,
                        background: over?'#ef4444':'#6366f1'
                      }}/>
                      {over && <div className="fd-budget-over" style={{left:'100%'}}/>}
                    </div>
                    <span className={`fd-budget-pct${over?' over':''}`}>{pct}%</span>
                    <span className="fd-budget-vals">{fmt(b.actual)} / {fmt(b.budget)}</span>
                  </div>
                );
              })}
            </Card>
          </div>

          {/* Recent Invoices */}
          <div className="fc6">
            <Card title="Recent Invoices" badge={topInvoices.length}
              action={{label:'View All', fn:()=>setPage&&setPage('Invoices')}}>
              <div className="fd-inv-list">
                {topInvoices.slice(0,6).map((inv,i)=>(
                  <div key={i} className="fd-inv-row">
                    <div className="fd-inv-icon"><FileText size={14}/></div>
                    <div className="fd-inv-info">
                      <span className="fd-inv-num">{inv.invoice_number}</span>
                      <span className="fd-inv-party">{inv.party_name}</span>
                    </div>
                    <div className="fd-inv-right">
                      <span className="fd-inv-amt">{fmt(inv.total_amount)}</span>
                      <span className="fd-status-badge"
                        style={{background:statusColor(inv.status)+'18',
                                color:statusColor(inv.status)}}>
                        {inv.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Alerts */}
          <div className="fc6">
            <Card title="Finance Alerts">
              {overdueCount > 0 && (
                <div className="fd-alert fd-alert-high">
                  <AlertTriangle size={14}/>
                  <span>{overdueCount} overdue invoice{overdueCount>1?'s':''} — {fmt(overdueAmt)} at risk</span>
                </div>
              )}
              {dueSoon > 0 && (
                <div className="fd-alert fd-alert-med">
                  <Clock size={14}/>
                  <span>{dueSoon} invoice{dueSoon>1?'s':''} due within 7 days</span>
                </div>
              )}
              {gstData.gstr3b.status==='Pending' && (
                <div className="fd-alert fd-alert-high">
                  <AlertTriangle size={14}/>
                  <span>GSTR-3B filing due {gstData.gstr3b.due} — ₹{fmtN(gstData.summary[2].amount)} payable</span>
                </div>
              )}
              {gstData.tds.status==='Due' && (
                <div className="fd-alert fd-alert-med">
                  <Calendar size={14}/>
                  <span>TDS payment due {gstData.tds.due} — ₹{fmtN(gstData.tds.amount)}</span>
                </div>
              )}
              {pendingAppr > 0 && (
                <div className="fd-alert fd-alert-low">
                  <CheckCircle size={14}/>
                  <span>{pendingAppr} items pending your approval</span>
                </div>
              )}
              {overdueCount===0 && dueSoon===0 && pendingAppr===0 && (
                <div className="fd-empty">
                  <CheckCircle size={24} color="#10b981"/>
                  <p>All clear — no urgent alerts</p>
                </div>
              )}
            </Card>
          </div>

        </div>
      )}

      {/* ── RECEIVABLES TAB ──────────────────────────────────────── */}
      {activeTab==='receivables' && (
        <div className="fd-grid">
          <div className="fc12">
            <Card title="Accounts Receivable — Aging Summary">
              <div className="fd-aging-kpis">
                <div className="fd-aging-kpi">
                  <span className="fd-aging-label">Total Outstanding</span>
                  <span className="fd-aging-val">{fmt(ar)}</span>
                </div>
                <div className="fd-aging-kpi red">
                  <span className="fd-aging-label">Overdue</span>
                  <span className="fd-aging-val">{fmt(overdueAmt||48000)}</span>
                </div>
                <div className="fd-aging-kpi">
                  <span className="fd-aging-label">Collected MTD</span>
                  <span className="fd-aging-val green">{fmt(137000)}</span>
                </div>
                <div className="fd-aging-kpi">
                  <span className="fd-aging-label">Collection Rate</span>
                  <span className="fd-aging-val green">74%</span>
                </div>
              </div>
              <div className="fd-aging-bars">
                {agingAR.map((a,i)=>{
                  const pct = Math.round((a.amount/ar)*100);
                  const color = i===0?'#10b981':i===1?'#f59e0b':i===2?'#ef4444':'#991b1b';
                  return (
                    <div key={i} className="fd-aging-row">
                      <span className="fd-aging-bucket">{a.bucket}</span>
                      <div className="fd-aging-track">
                        <div className="fd-aging-bar" style={{width:`${pct}%`,background:color}}/>
                      </div>
                      <span className="fd-aging-pct">{pct}%</span>
                      <span className="fd-aging-amt">{fmt(a.amount)}</span>
                      <span className="fd-aging-cnt">{a.count} inv</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
          <div className="fc12">
            <Card title="Outstanding Invoices" badge={topInvoices.filter(i=>i.status!=='paid').length}
              action={{label:'Create Invoice', fn:()=>setPage&&setPage('Invoices')}}>
              <table className="fd-table">
                <thead>
                  <tr>
                    <th>Invoice #</th><th>Customer</th><th>Amount</th>
                    <th>Due Date</th><th>Status</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {topInvoices.map((inv,i)=>(
                    <tr key={i}>
                      <td className="fd-td-mono">{inv.invoice_number}</td>
                      <td>{inv.party_name}</td>
                      <td className="fd-td-amt">{fmt(inv.total_amount)}</td>
                      <td>{inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-IN') : '—'}</td>
                      <td>
                        <span className="fd-status-badge"
                          style={{background:statusColor(inv.status)+'18',color:statusColor(inv.status)}}>
                          {inv.status}
                        </span>
                      </td>
                      <td>
                        <button className="fd-action-btn">
                          <ChevronRight size={14}/>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </div>
      )}

      {/* ── PAYABLES TAB ─────────────────────────────────────────── */}
      {activeTab==='payables' && (
        <div className="fd-grid">
          <div className="fc12">
            <Card title="Accounts Payable — Aging Summary">
              <div className="fd-aging-kpis">
                <div className="fd-aging-kpi">
                  <span className="fd-aging-label">Total Payable</span>
                  <span className="fd-aging-val">{fmt(ap)}</span>
                </div>
                <div className="fd-aging-kpi red">
                  <span className="fd-aging-label">Overdue Bills</span>
                  <span className="fd-aging-val">{fmt(22000)}</span>
                </div>
                <div className="fd-aging-kpi">
                  <span className="fd-aging-label">Paid MTD</span>
                  <span className="fd-aging-val">{fmt(68000)}</span>
                </div>
                <div className="fd-aging-kpi">
                  <span className="fd-aging-label">Due in 7 Days</span>
                  <span className="fd-aging-val orange">{fmt(28000)}</span>
                </div>
              </div>
              <div className="fd-aging-bars">
                {agingAP.map((a,i)=>{
                  const pct = Math.round((a.amount/ap)*100);
                  const color = i===0?'#10b981':i===1?'#f59e0b':i===2?'#ef4444':'#991b1b';
                  return (
                    <div key={i} className="fd-aging-row">
                      <span className="fd-aging-bucket">{a.bucket}</span>
                      <div className="fd-aging-track">
                        <div className="fd-aging-bar" style={{width:`${pct}%`,background:color}}/>
                      </div>
                      <span className="fd-aging-pct">{pct}%</span>
                      <span className="fd-aging-amt">{fmt(a.amount)}</span>
                      <span className="fd-aging-cnt">{a.count} bills</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
          <div className="fc8">
            <Card title="Upcoming Payments — Next 30 Days">
              {[
                {supplier:'Office Supplies Co',   amount:12000, due:'17 Mar', category:'Operations'},
                {supplier:'Cloud Services Ltd',   amount:28000, due:'20 Mar', category:'IT'},
                {supplier:'Marketing Agency',     amount:45000, due:'25 Mar', category:'Marketing'},
                {supplier:'Rent — Commercial',    amount:85000, due:'1 Apr',  category:'Facilities'},
                {supplier:'Insurance Premium',    amount:18000, due:'5 Apr',  category:'Insurance'},
              ].map((p,i)=>(
                <div key={i} className="fd-pay-row">
                  <div className="fd-pay-icon" style={{background:COLORS[i%COLORS.length]+'18',color:COLORS[i%COLORS.length]}}>
                    <Building2 size={14}/>
                  </div>
                  <div className="fd-pay-info">
                    <span className="fd-pay-supplier">{p.supplier}</span>
                    <span className="fd-pay-cat">{p.category}</span>
                  </div>
                  <div className="fd-pay-right">
                    <span className="fd-pay-amt">{fmt(p.amount)}</span>
                    <span className="fd-pay-due">Due {p.due}</span>
                  </div>
                </div>
              ))}
            </Card>
          </div>
          <div className="fc4">
            <Card title="Payment Summary">
              <div className="fd-pay-summary">
                <div className="fd-ps-item">
                  <span className="fd-ps-label">Scheduled This Week</span>
                  <span className="fd-ps-val">{fmt(40000)}</span>
                </div>
                <div className="fd-ps-item">
                  <span className="fd-ps-label">Scheduled This Month</span>
                  <span className="fd-ps-val">{fmt(188000)}</span>
                </div>
                <div className="fd-ps-item red">
                  <span className="fd-ps-label">Overdue</span>
                  <span className="fd-ps-val red">{fmt(22000)}</span>
                </div>
                <div className="fd-ps-item">
                  <span className="fd-ps-label">Pending Approval</span>
                  <span className="fd-ps-val orange">{fmt(57000)}</span>
                </div>
              </div>
              <button className="fd-full-btn"
                onClick={()=>setPage&&setPage('PaymentBatch')}>
                View Payment Batches <ChevronRight size={14}/>
              </button>
            </Card>
          </div>
        </div>
      )}

      {/* ── GST & TAX TAB ────────────────────────────────────────── */}
      {activeTab==='gst' && (
        <div className="fd-grid">

          {/* GST Filing Status */}
          <div className="fc8">
            <Card title="GST Filing Status">
              <div className="fd-gst-grid">
                {[
                  {form:'GSTR-1', desc:'Outward Supplies', ...gstData.gstr1,   liability:gstData.gstr1.liability},
                  {form:'GSTR-3B',desc:'Monthly Return',   ...gstData.gstr3b,  liability:gstData.gstr3b.liability},
                  {form:'GSTR-2B',desc:'Input Tax Credit',  status:gstData.gstr2b.status, period:gstData.gstr2b.period, due:gstData.gstr2b.due, liability:gstData.gstr2b.itc, isCredit:true},
                ].map((g,i)=>(
                  <div key={i} className={`fd-gst-card fd-gst-${g.status.toLowerCase().replace(' ','-')}`}>
                    <div className="fd-gst-form">{g.form}</div>
                    <div className="fd-gst-desc">{g.desc}</div>
                    <div className="fd-gst-period">{g.period}</div>
                    <div className="fd-gst-amount">
                      {fmt(g.liability)}
                      <span className="fd-gst-amtlbl">{g.isCredit?'ITC Available':'Liability'}</span>
                    </div>
                    <div className={`fd-gst-status fd-gst-s-${g.status.toLowerCase().replace(' ','-')}`}>
                      {g.status==='Filed'     && <CheckCircle size={12}/>}
                      {g.status==='Pending'   && <AlertTriangle size={12}/>}
                      {g.status==='Available' && <CheckCircle size={12}/>}
                      {g.status}
                    </div>
                    {g.due !== '—' && <div className="fd-gst-due">Due: {g.due}</div>}
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* ITC Summary */}
          <div className="fc4">
            <Card title="Input Tax Credit (ITC)">
              <div className="fd-itc">
                <div className="fd-itc-circle">
                  <svg viewBox="0 0 100 100" width="120" height="120">
                    <circle cx="50" cy="50" r="40" fill="none" stroke="#f3f4f6" strokeWidth="10"/>
                    <circle cx="50" cy="50" r="40" fill="none" stroke="#6366f1" strokeWidth="10"
                      strokeDasharray={`${(gstData.itc.utilized/gstData.itc.available)*251} 251`}
                      strokeLinecap="round" transform="rotate(-90 50 50)"/>
                    <text x="50" y="46" textAnchor="middle" fontSize="13" fontWeight="600" fill="#111827">
                      {Math.round((gstData.itc.utilized/gstData.itc.available)*100)}%
                    </text>
                    <text x="50" y="60" textAnchor="middle" fontSize="9" fill="#9ca3af">utilized</text>
                  </svg>
                </div>
                <div className="fd-itc-stats">
                  <div className="fd-itc-stat">
                    <span className="fd-itc-label">Available ITC</span>
                    <span className="fd-itc-val">{fmt(gstData.itc.available)}</span>
                  </div>
                  <div className="fd-itc-stat">
                    <span className="fd-itc-label">Utilized</span>
                    <span className="fd-itc-val">{fmt(gstData.itc.utilized)}</span>
                  </div>
                  <div className="fd-itc-stat green">
                    <span className="fd-itc-label">Balance</span>
                    <span className="fd-itc-val green">{fmt(gstData.itc.balance)}</span>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {/* GST Summary Table */}
          <div className="fc6">
            <Card title="GST Summary — February 2026">
              <table className="fd-table">
                <thead>
                  <tr><th>Description</th><th>Amount</th><th>Type</th></tr>
                </thead>
                <tbody>
                  {gstData.summary.map((s,i)=>(
                    <tr key={i} className={i===gstData.summary.length-1?'fd-tr-total':''}>
                      <td>{s.label}</td>
                      <td className="fd-td-amt">₹{fmtN(s.amount)}</td>
                      <td>
                        <span className="fd-status-badge"
                          style={{
                            background:s.type==='credit'?'#dcfce7':s.type==='payable'?'#fee2e2':'#fef3c7',
                            color:s.type==='credit'?'#16a34a':s.type==='payable'?'#dc2626':'#92400e'
                          }}>
                          {s.type}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          {/* TDS Summary */}
          <div className="fc6">
            <Card title="TDS — Tax Deducted at Source">
              <div className="fd-tds">
                <div className={`fd-tds-status fd-tds-${gstData.tds.status.toLowerCase()}`}>
                  {gstData.tds.status==='Due' ? <AlertTriangle size={16}/> : <CheckCircle size={16}/>}
                  <div>
                    <strong>TDS {gstData.tds.status}</strong>
                    <p>Payment due by {gstData.tds.due}</p>
                  </div>
                </div>
                {[
                  {section:'194C', desc:'Contractor Payments', amount:5200,  rate:'2%'},
                  {section:'194J', desc:'Professional Fees',   amount:4800,  rate:'10%'},
                  {section:'194I', desc:'Rent',                amount:1700,  rate:'2%'},
                  {section:'192',  desc:'Salary TDS',          amount:900,   rate:'Slab'},
                ].map((t,i)=>(
                  <div key={i} className="fd-tds-row">
                    <span className="fd-tds-section">{t.section}</span>
                    <span className="fd-tds-desc">{t.desc}</span>
                    <span className="fd-tds-rate">{t.rate}</span>
                    <span className="fd-tds-amt">{fmt(t.amount)}</span>
                  </div>
                ))}
                <div className="fd-tds-total">
                  <span>Total TDS Payable</span>
                  <strong>{fmt(gstData.tds.amount)}</strong>
                </div>
              </div>
            </Card>
          </div>

        </div>
      )}

    </div>
  );
}