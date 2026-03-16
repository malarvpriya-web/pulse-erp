import React, { useState, useEffect, useRef } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import {
  Users, TrendingUp, TrendingDown, DollarSign, AlertTriangle,
  CheckCircle, Clock, RefreshCw, Activity, ShoppingCart,
  FileText, UserCheck, Briefcase, Bell, Maximize2, X,
  ArrowRight, ChevronRight
} from 'lucide-react';
import api from '../services/api/client';
import './SuperAdminDashboard.css';

const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6'];

const fmt = (n) => {
  if (n >= 1000000) return `₹${(n/1000000).toFixed(1)}M`;
  if (n >= 100000)  return `₹${(n/100000).toFixed(1)}L`;
  if (n >= 1000)    return `₹${(n/1000).toFixed(0)}K`;
  return `₹${n}`;
};

const TrendBadge = ({ value }) => {
  const up = value >= 0;
  return (
    <span className={`sad-trend ${up ? 'up' : 'down'}`}>
      {up ? <TrendingUp size={11}/> : <TrendingDown size={11}/>}
      {Math.abs(value)}%
    </span>
  );
};

// ── Expand Modal ─────────────────────────────────────────────────────────────
const ExpandModal = ({ title, onClose, children }) => (
  <div className="sad-modal-overlay" onClick={onClose}>
    <div className="sad-modal" onClick={e => e.stopPropagation()}>
      <div className="sad-modal-header">
        <h3>{title}</h3>
        <button className="sad-modal-close" onClick={onClose}><X size={18}/></button>
      </div>
      <div className="sad-modal-body">{children}</div>
    </div>
  </div>
);

// ── KPI Card ─────────────────────────────────────────────────────────────────
const KPICard = ({ icon: Icon, label, value, trend, color, sub, onClick }) => (
  <div className="sad-kpi" style={{'--c': color}} onClick={onClick}
    role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}>
    <div className="sad-kpi-icon"><Icon size={20}/></div>
    <div className="sad-kpi-body">
      <p className="sad-kpi-label">{label}</p>
      <h3 className="sad-kpi-val">{value}</h3>
      {sub && <p className="sad-kpi-sub">{sub}</p>}
    </div>
    <div className="sad-kpi-right">
      {trend !== undefined && <TrendBadge value={trend}/>}
      {onClick && <ChevronRight size={14} className="sad-kpi-arrow"/>}
    </div>
  </div>
);

// ── Widget Card ───────────────────────────────────────────────────────────────
const Widget = ({ title, onExpand, children, scroll }) => (
  <div className="sad-widget">
    <div className="sad-widget-hd">
      <span className="sad-widget-title">{title}</span>
      {onExpand && (
        <button className="sad-icon-btn" onClick={onExpand} title="Expand">
          <Maximize2 size={14}/>
        </button>
      )}
    </div>
    <div className={scroll ? 'sad-widget-body sad-scroll' : 'sad-widget-body'}>
      {children}
    </div>
  </div>
);

// ── Custom Pie label ──────────────────────────────────────────────────────────
const PieLabel = ({ cx, cy, midAngle, outerRadius, percent, name }) => {
  const RAD = Math.PI / 180;
  const x = cx + (outerRadius + 20) * Math.cos(-midAngle * RAD);
  const y = cy + (outerRadius + 20) * Math.sin(-midAngle * RAD);
  if (percent < 0.05) return null;
  return (
    <text x={x} y={y} fill="#6b7280" textAnchor={x > cx ? 'start' : 'end'}
      dominantBaseline="central" fontSize={11}>
      {`${(percent*100).toFixed(0)}%`}
    </text>
  );
};

// ── Activity time-ago ─────────────────────────────────────────────────────────
const timeAgo = (dateStr) => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
};

const activityColors = {
  Auth: '#6366f1', Leaves: '#10b981', Finance: '#f59e0b',
  Employees: '#3b82f6', CRM: '#8b5cf6', default: '#9ca3af'
};

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function SuperAdminDashboard({ setPage }) {
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [lastSync,   setLastSync]   = useState(new Date());
  const [expand,     setExpand]     = useState(null); // 'revenue' | 'expense'
  const [revRange,   setRevRange]   = useState('6m'); // '6m' | '1y'
  const [actFilter,  setActFilter]  = useState('24h');
  const [activity,   setActivity]   = useState([]);

  const navigate = (page) => setPage && setPage(page);

  const load = async () => {
    setLoading(true);
    try {
      const [dash, rev, exp, wf, appr, alerts, sales, act] = await Promise.allSettled([
        api.get('/dashboard/data'),
        api.get('/dashboard/revenue'),
        api.get('/dashboard/expenses'),
        api.get('/dashboard/workforce'),
        api.get('/dashboard/approvals'),
        api.get('/dashboard/alerts'),
        api.get('/dashboard/sales'),
        api.get('/dashboard/activity'),
      ]);
      setData({
        dash   : dash.status   === 'fulfilled' ? dash.value.data   : {},
        rev    : rev.status    === 'fulfilled' ? rev.value.data    : null,
        exp    : exp.status    === 'fulfilled' ? exp.value.data    : null,
        wf     : wf.status     === 'fulfilled' ? wf.value.data     : null,
        appr   : appr.status   === 'fulfilled' ? appr.value.data   : null,
        alerts : alerts.status === 'fulfilled' ? alerts.value.data : null,
        sales  : sales.status  === 'fulfilled' ? sales.value.data  : null,
      });
      setActivity(act.status === 'fulfilled' ? (act.value.data?.activities || []) : []);
      setLastSync(new Date());
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const greet = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  };

    // ── derived ──────────────────────────────────────────────────────────────
  const rev      = data?.rev;
  const exp      = data?.exp;
  const wf       = data?.wf;
  const appr     = data?.appr;
  const alertArr = data?.alerts?.alerts || [];
  const sales    = data?.sales?.stages  || [];
  const kpis     = data?.dash?.kpis     || [];

  const revenueChart = rev
    ? rev.months.map((m,i) => ({ month: m, revenue: rev.values[i] }))
    : [
        {month:'Oct',revenue:48000},{month:'Nov',revenue:55000},
        {month:'Dec',revenue:62000},{month:'Jan',revenue:58000},
        {month:'Feb',revenue:71000},{month:'Mar',revenue:84000},
      ];

  const expChart = exp
    ? exp.labels.map((l,i) => ({ name:l, value:exp.values[i] }))
    : [
        {name:'Salaries',value:42000},{name:'Operations',value:12000},
        {name:'Marketing',value:8500},{name:'Travel',value:4200},
        {name:'IT',value:6300},{name:'Other',value:3100},
      ];

  const totalExp = expChart.reduce((s,e) => s + e.value, 0);

  const salesChart = sales.length ? sales : [
    {stage:'Prospecting',count:12,value:120000},
    {stage:'Qualification',count:8,value:95000},
    {stage:'Proposal',count:5,value:67000},
    {stage:'Negotiation',count:3,value:48000},
    {stage:'Closed Won',count:6,value:82000},
  ];

  const ytd       = rev?.ytd       || revenueChart.reduce((s,r) => s+r.revenue, 0);
  const thisMonth = rev?.thisMonth || revenueChart.at(-1)?.revenue || 0;
  const lastMonth = rev?.lastMonth || revenueChart.at(-2)?.revenue || 0;
  const revTrend  = lastMonth ? Math.round(((thisMonth-lastMonth)/lastMonth)*100) : 0;
  const totalEmp  = wf?.total  || 0;
  const pendAppr  = appr?.total || 0;

  // filter activity by time
  const filteredActivity = activity.filter(a => {
    const diff = Date.now() - new Date(a.created_at).getTime();
    if (actFilter === '24h') return diff < 86400000;
    if (actFilter === '48h') return diff < 172800000;
    return diff < 604800000; // 7d
  });

  // ── Revenue chart component (reused in expand) ───────────────────────────
  const RevenueChartContent = ({ height = 220 }) => (
    <>
      <div className="sad-chart-meta">
        <span className="sad-big">{fmt(ytd)}<span className="sad-big-lbl"> YTD</span></span>
        <TrendBadge value={revTrend}/>
        <span className="sad-this-month">This month: {fmt(thisMonth)}</span>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={revenueChart} margin={{top:10,right:10,left:0,bottom:0}}>
          <defs>
            <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.3}/>
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
          <XAxis dataKey="month" tick={{fontSize:12}}/>
          <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:11}}/>
          <Tooltip formatter={v=>[fmt(v),'Revenue']}/>
          <Area type="monotone" dataKey="revenue" stroke="#6366f1" strokeWidth={2.5}
            fill="url(#rg)" dot={{r:4,fill:'#6366f1'}}/>
        </AreaChart>
      </ResponsiveContainer>
    </>
  );

  // ── Expense chart component (reused in expand) ───────────────────────────
  const ExpenseChartContent = ({ height = 180 }) => (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={expChart} cx="50%" cy="50%" innerRadius={50} outerRadius={75}
            dataKey="value" paddingAngle={3}
            labelLine={false} label={<PieLabel/>}>
            {expChart.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
          </Pie>
          <Tooltip formatter={v=>[fmt(v),'']}/>
        </PieChart>
      </ResponsiveContainer>
      <div className="sad-exp-legend">
        {expChart.map((e,i) => (
          <div key={i} className="sad-exp-row">
            <span className="sad-exp-dot" style={{background:COLORS[i%COLORS.length]}}/>
            <span className="sad-exp-name">{e.name}</span>
            <span className="sad-exp-pct">{((e.value/totalExp)*100).toFixed(1)}%</span>
            <span className="sad-exp-amt">{fmt(e.value)}</span>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div className="sad-root">

      {/* Expand modals */}
      {expand === 'revenue' && (
        <ExpandModal title="Revenue Trend — Last 6 Months" onClose={()=>setExpand(null)}>
          <RevenueChartContent height={400}/>
        </ExpandModal>
      )}
      {expand === 'expense' && (
        <ExpandModal title="Expense Breakdown" onClose={()=>setExpand(null)}>
          <ExpenseChartContent height={320}/>
        </ExpandModal>
      )}

      {/* Top bar */}
      <div className="sad-topbar">
        <div>
          <h2 className="sad-greeting">{greet()}, Super Admin</h2>
          <p className="sad-date">
            {new Date().toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'long',year:'numeric'})}
          </p>
        </div>
        <div className="sad-topbar-r">
          <span className="sad-sync">Last updated: {lastSync.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</span>
          <button className="sad-refresh-btn" onClick={()=>{setLoading(true);load();}}>
            <RefreshCw size={14}/> Refresh
          </button>
        </div>
      </div>

      {/* KPI strip — clickable */}
      <div className="sad-kpis">
        <KPICard icon={DollarSign} label="Total Revenue (YTD)" value={fmt(ytd)}
          trend={revTrend} color="#6366f1" sub={`This month: ${fmt(thisMonth)}`}
          onClick={()=>navigate('FinanceDashboard')}/>
        <KPICard icon={Users} label="Total Employees" value={totalEmp}
          trend={wf?.newHires||0} color="#10b981"
          sub={`${wf?.newHires||0} new this month`}
          onClick={()=>navigate('EmployeesDashboard')}/>
        <KPICard icon={Clock} label="Pending Approvals" value={pendAppr}
          color="#f59e0b" sub="Requires your action"
          onClick={()=>navigate('ApprovalCenter')}/>
        <KPICard icon={Briefcase} label="Active Projects"
          value={kpis.find(k=>k.label==='Open Projects')?.value||8}
          trend={4} color="#3b82f6" sub="Across all departments"
          onClick={()=>navigate('Projects')}/>
        <KPICard icon={UserCheck} label="Attendance Rate"
          value={`${wf?.attendanceRate||94}%`}
          trend={2} color="#8b5cf6" sub="Today vs last week"
          onClick={()=>navigate('AttendanceDashboard')}/>
        <KPICard icon={AlertTriangle} label="Open Alerts"
          value={alertArr.filter(a=>a.priority==='high').length||alertArr.length||0}
          color="#ef4444" sub="High priority items"/>
      </div>

      {/* Main grid */}
      <div className="sad-grid">

        {/* Revenue Trend */}
        <div className="g8">
          <Widget title="Revenue Trend (Last 6 Months)" onExpand={()=>setExpand('revenue')}>
            <RevenueChartContent height={220}/>
          </Widget>
        </div>

        {/* Expense Breakdown donut */}
        <div className="g4">
          <Widget title="Expense Breakdown" onExpand={()=>setExpand('expense')}>
            <ExpenseChartContent height={160}/>
          </Widget>
        </div>

        {/* Sales Pipeline */}
        <div className="g6">
          <Widget title="Sales Pipeline">
            <div className="sad-pipeline">
              {salesChart.map((s,i) => {
                const max = Math.max(...salesChart.map(x=>x.value));
                const pct = max ? Math.round((s.value/max)*100) : 0;
                return (
                  <div key={i} className="sad-pl-row">
                    <span className="sad-pl-stage">{s.stage}</span>
                    <div className="sad-pl-track">
                      <div className="sad-pl-bar" style={{width:`${pct}%`,background:COLORS[i%COLORS.length]}}/>
                    </div>
                    <span className="sad-pl-cnt">{s.count}</span>
                    <span className="sad-pl-val">{fmt(s.value)}</span>
                  </div>
                );
              })}
            </div>
          </Widget>
        </div>

        {/* Workforce */}
        <div className="g3">
          <Widget title="Workforce">
            <div className="sad-wf-wrap">
              <div className="sad-wf-circle">
                <span className="sad-wf-num">{totalEmp}</span>
                <span className="sad-wf-lbl">Employees</span>
              </div>
            </div>
            <div className="sad-wf-stats">
              <div className="sad-wf-s"><span className="green">{wf?.newHires||5}</span><small>New Hires</small></div>
              <div className="sad-wf-s"><span className="red">{wf?.attrition||2}</span><small>Attrition</small></div>
              <div className="sad-wf-s"><span className="blue">{wf?.attendanceRate||94}%</span><small>Attendance</small></div>
            </div>
            {(wf?.byDepartment||[]).slice(0,4).map((d,i)=>(
              <div key={i} className="sad-dept">
                <span className="sad-dept-name">{d.department}</span>
                <div className="sad-dept-track">
                  <div className="sad-dept-bar" style={{width:`${Math.round((d.count/(totalEmp||1))*100)}%`,background:COLORS[i]}}/>
                </div>
                <span className="sad-dept-n">{d.count}</span>
              </div>
            ))}
          </Widget>
        </div>

        {/* Alerts */}
        <div className="g3">
          <Widget title="System Alerts">
            {alertArr.length === 0
              ? <div className="sad-empty"><CheckCircle size={26} color="#10b981"/><p>All clear</p></div>
              : alertArr.map((a,i)=>(
                  <div key={i} className={`sad-alert sad-alert-${a.priority}`}>
                    <AlertTriangle size={13}/><span>{a.message}</span>
                  </div>
                ))
            }
          </Widget>
        </div>

        {/* Pending Approvals */}
        <div className="g6">
          <Widget title="Pending Approvals">
            <div className="sad-appr-summary">
              {(appr?.summary||[]).map((s,i)=>(
                <div key={i} className="sad-appr-chip">
                  <FileText size={14} color={COLORS[i]}/>
                  <span>{s.type}</span>
                  <strong style={{background:COLORS[i]}}>{s.count}</strong>
                </div>
              ))}
            </div>
            <div className="sad-appr-list">
              {(appr?.pending||[]).slice(0,5).map((p,i)=>(
                <div key={i} className="sad-appr-row">
                  <div className="sad-avatar">{(p.employee_name||'E').charAt(0)}</div>
                  <div className="sad-appr-info">
                    <span className="sad-appr-name">{p.employee_name}</span>
                    <span className="sad-appr-meta">{p.type} · {p.start_date ? new Date(p.start_date).toLocaleDateString('en-IN') : 'Pending'}</span>
                  </div>
                  <span className="sad-badge-pending">Pending</span>
                </div>
              ))}
              {(!appr?.pending||appr.pending.length===0)&&(
                <div className="sad-empty"><CheckCircle size={22} color="#10b981"/><p>No pending approvals</p></div>
              )}
            </div>
          </Widget>
        </div>

        {/* Monthly Expense Bar */}
        <div className="g6">
          <Widget title="Monthly Cost Breakdown">
            <div className="sad-cost-grid">
              <div className="sad-cost-summary">
                <div className="sad-cost-total">
                  <p className="sad-cost-label">Total Operating Cost</p>
                  <p className="sad-cost-val">{fmt(totalExp)}</p>
                </div>
                <div className="sad-cost-breakdown">
                  {expChart.map((e,i) => (
                    <div key={i} className="sad-cost-row">
                      <div className="sad-cost-bar-wrap">
                        <div className="sad-cost-fill" style={{width:`${((e.value/totalExp)*100).toFixed(0)}%`,background:COLORS[i%COLORS.length]}}/>
                      </div>
                      <span className="sad-cost-cat">{e.name}</span>
                      <span className="sad-cost-pct">{((e.value/totalExp)*100).toFixed(1)}%</span>
                      <span className="sad-cost-amt">{fmt(e.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="sad-cost-chart">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={expChart} margin={{top:5,right:5,left:0,bottom:30}}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
                    <XAxis dataKey="name" tick={{fontSize:10}} angle={-30} textAnchor="end"/>
                    <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:10}}/>
                    <Tooltip formatter={v=>[fmt(v),'']}/>
                    <Bar dataKey="value" radius={[4,4,0,0]}>
                      {expChart.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </Widget>
        </div>

        {/* Operations Overview */}
        <div className="g6">
          <Widget title="Operations Overview" scroll>
            <div className="sad-ops-grid">
              {[
                {icon:Activity,     label:'Active Projects',    value:8,  color:'#3b82f6', page:'Projects'},
                {icon:Bell,         label:'Open Tickets',       value:6,  color:'#f59e0b', page:'Tickets'},
                {icon:ShoppingCart, label:'Low Stock Items',    value:3,  color:'#ef4444', page:'StockSummary'},
                {icon:FileText,     label:'Pending Invoices',   value:14, color:'#6366f1', page:'FinanceReports'},
                {icon:UserCheck,    label:'On Leave Today',     value:4,  color:'#8b5cf6', page:'AllLeaves'},
                {icon:CheckCircle,  label:'Tasks Completed',    value:28, color:'#10b981', page:'Projects'},
                {icon:Clock,        label:'Overdue Tasks',      value:3,  color:'#ef4444', page:'Projects'},
                {icon:Briefcase,    label:'Timesheets Pending', value:7,  color:'#f59e0b', page:'Timesheets'},
                {icon:Users,        label:'Open Recruitments',  value:4,  color:'#8b5cf6', page:'RecruitmentDashboard'},
              ].map((o,i)=>(
                <div key={i} className="sad-ops-item"
                  onClick={()=>navigate(o.page)} role="button" tabIndex={0}>
                  <div className="sad-ops-icon" style={{background:o.color+'18',color:o.color}}>
                    <o.icon size={17}/>
                  </div>
                  <div>
                    <p className="sad-ops-val">{o.value}</p>
                    <p className="sad-ops-lbl">{o.label}</p>
                  </div>
                  <ChevronRight size={13} className="sad-ops-arrow"/>
                </div>
              ))}
            </div>
          </Widget>
        </div>

        {/* Recent Activity */}
        <div className="g6">
          <Widget title="Recent Activity">
            <div className="sad-act-header">
              {['24h','48h','7d'].map(f=>(
                <button
                  key={f}
                  className={`sad-act-tab ${actFilter===f?'active':''}`}
                  onClick={()=>setActFilter(f)}
                >
                  Last {f==='7d'?'7 Days':f}
                </button>
              ))}
              <span className="sad-act-count">{filteredActivity.length} events</span>
            </div>
            <div className="sad-act-scrollable">
              {filteredActivity.length === 0 ? (
                <div className="sad-empty">
                  <Activity size={24} color="#d1d5db"/>
                  <p>No activity in this period</p>
                </div>
              ) : (
                <div className="sad-act-list">
                  {filteredActivity.slice(0,20).map((a,i)=>(
                    <div key={i} className="sad-act-row">
                      <div className="sad-act-dot" style={{background:activityColors[a.module]||activityColors.default}}/>
                      <div className="sad-act-info">
                        <span className="sad-act-action">{a.action}</span>
                        <span className="sad-act-desc">{a.description}</span>
                      </div>
                      <span className="sad-act-module" style={{background:(activityColors[a.module]||activityColors.default)+'18',color:activityColors[a.module]||activityColors.default}}>
                        {a.module}
                      </span>
                      <span className="sad-act-time">{timeAgo(a.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Widget>
        </div>

      </div>
    </div>
  );
}