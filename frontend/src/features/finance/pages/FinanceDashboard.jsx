import { useState, useEffect, useCallback, useRef } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell, PieChart, Pie
} from 'recharts';
import {
  TrendingUp, TrendingDown, IndianRupee, FileText, AlertTriangle,
  CheckCircle, Clock, RefreshCw, ArrowUpRight, ArrowDownRight,
  CreditCard, Banknote, Receipt, Building2, ChevronRight,
  Maximize2, X, Calendar, Filter
} from 'lucide-react';
import {
  getFinanceDashboard, getInvoices,
} from '../services/financeService';
import { fmt, fmtN } from '../financeUtils';
import api from '@/services/api/client';
import { useFY } from '@/context/FYContext';
import FYSelector from '@/components/core/FYSelector';
import './FinanceDashboard.css';

const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899'];

const TrendBadge = ({ value, suffix='%' }) => {
  const up = value >= 0;
  return (
    <span className={`fd-trend ${up?'up':'down'}`}>
      {up ? <TrendingUp size={11}/> : <TrendingDown size={11}/>}
      {Math.abs(value)}{suffix}
    </span>
  );
};

const KPI = ({ icon:IconComp, label, value, sub, trend, color, alert, onClick }) => (
  <div className={`fd-kpi${alert?' fd-kpi-alert':''}`}
    style={{'--c':color}} onClick={onClick}
    role={onClick?'button':undefined} tabIndex={onClick?0:undefined}>
    <div className="fd-kpi-icon"><IconComp size={19}/></div>
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
  const { fyParams, fyLabel } = useFY();
  const [data,          setData]         = useState({});
  const [loading,       setLoading]      = useState(false);
  const [lastSync,      setLastSync]     = useState(new Date());
  const [expand,        setExpand]       = useState(null);
  const [period,        setPeriod]       = useState('month'); // month | quarter | year
  const [activeTab,     setActiveTab]    = useState('overview'); // overview | receivables | payables | gst
  const [bankAcctCount, setBankAcctCount] = useState(null); // null = loading, 0 = no accounts

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const periodMap = { month: '6m', quarter: '6m', year: 'cy' };
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const gstPeriod = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2,'0')}`;
    const liveFY = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    // Budget & TDS panels follow the globally selected Financial Year.
    const selFYStart = parseInt(fyParams.fy.replace(/\D/g, '').slice(0, 4), 10) || liveFY;
    const fyQ = `${selFYStart}-${String(selFYStart + 1).slice(-2)}`;
    // Show the elapsed quarter for the live FY, else the final quarter for a closed FY.
    const currentQtr = selFYStart === liveFY ? Math.ceil((now.getMonth() + 1) / 3) : 4;
    try {
      const [dash, charts, budgets, inv, gstr3b, tdsSummary, dueSoonBills, bankSummary] = await Promise.allSettled([
        getFinanceDashboard({ fyStart: fyParams.fyStart, fyEnd: fyParams.fyEnd }),
        api.get('/finance/dashboard/charts'),
        api.get('/budgets', { params: { financial_year: selFYStart } }),
        getInvoices({ limit: 10 }),
        api.get('/gst/gstr3b', { params: { period: gstPeriod } }),
        api.get('/tds/quarterly-summary', { params: { financial_year: fyQ, quarter: `Q${currentQtr}` } }),
        api.get('/finance/bills/due-soon', { params: { days: 30 } }),
        api.get('/finance/bank-accounts/summary'),
      ]);
      if (!isMounted.current) return;
      setData({
        dash        : dash.status        === 'fulfilled' ? dash.value                                      : {},
        charts      : charts.status      === 'fulfilled' ? charts.value.data                               : null,
        budgets     : budgets.status     === 'fulfilled' ? (Array.isArray(budgets.value.data) ? budgets.value.data : []) : [],
        inv         : inv.status         === 'fulfilled' ? inv.value                                       : [],
        gstr3b      : gstr3b.status      === 'fulfilled' ? gstr3b.value.data                               : null,
        tdsSummary  : tdsSummary.status  === 'fulfilled' ? tdsSummary.value.data                           : null,
        dueSoonBills: dueSoonBills.status === 'fulfilled' ? (dueSoonBills.value.data?.bills || dueSoonBills.value.data || []) : [],
      });
      if (bankSummary.status === 'fulfilled') {
        setBankAcctCount(parseInt(bankSummary.value.data?.account_count ?? 0));
      }
      setLastSync(new Date());
    } catch(e) { console.error(e); }
    finally { if (isMounted.current) setLoading(false); }
  }, [period, fyParams.fy, fyParams.fyStart, fyParams.fyEnd]);

  useEffect(() => { load(); }, [load]);

   // ── derived ────────────────────────────────────────────────────────────
  const dash    = data.dash    || {};
  const charts  = data.charts  || null;

  const monthRev  = dash.monthly_revenue  ?? 0;
  const monthExp  = dash.monthly_expenses ?? 0;
  const netProfit = monthRev - monthExp;
  const profitPct = monthRev ? Math.round((netProfit/monthRev)*100) : 0;
  const overdueAmt   = dash.overdue_amount    ?? 0;
  const overdueCount = dash.overdue_invoices  ?? 0;
  const dueSoon      = dash.due_soon_invoices ?? 0;
  const pendingAppr  = dash.pending_approvals ?? 0;
  const ar = dash.accounts_receivable ?? 0;
  const ap = dash.accounts_payable    ?? 0;

  // Revenue vs Expenses — from real chart data
  const revChart = charts?.revenueExpenses?.length > 0 ? charts.revenueExpenses : [];

  // Expense Breakdown — from real bill breakdown
  const expChart = charts?.expenseBreakdown?.length > 0 ? charts.expenseBreakdown : [];
  const totalExp = expChart.reduce((s,e)=>s+e.value,0);

  // Cash Flow — from real payment data
  const cashFlowData = charts?.cashFlow?.length > 0
    ? charts.cashFlow
    : revChart.map(m => ({ month: m.month, inflow: m.revenue, outflow: m.expenses }));

  const agingAR = (dash.arAging || []).map(r => ({ bucket: r.bucket, amount: r.amount, count: 0 }));
  const agingAP = (dash.apAging || []).map(r => ({ bucket: r.bucket, amount: r.amount, count: 0 }));

  // AP "Due in 7 Days" — filter real bills list, not the 30-day aging bucket
  const _7daysFromNow = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  const apDue7Days = (data.dueSoonBills || []).filter(b => b.due_date && b.due_date <= _7daysFromNow);
  const apDue7DaysAmt = apDue7Days.reduce((s, b) => s + parseFloat(b.amount || b.total_amount || 0), 0);
  const apDue7DaysLabel = apDue7Days.length > 0 ? `${apDue7Days.length} bill${apDue7Days.length > 1 ? 's' : ''} — ${fmt(apDue7DaysAmt)}` : '—';

  // GST data — derived from live API responses (gstr3b + tds quarterly summary)
  const _now          = new Date();
  const _filingMon    = _now.toLocaleString('en-IN', { month: 'short' });
  const _prevMonYear  = new Date(_now.getFullYear(), _now.getMonth() - 1, 1)
                          .toLocaleString('en-IN', { month: 'short', year: 'numeric' });
  const _gstr3bOverdue = _now.getDate() > 20;
  const _tdsOverdue    = _now.getDate() > 7;

  const gstr3bData = data.gstr3b || {};
  const tdsData    = data.tdsSummary;

  // Extract live values from GSTR-3B API response
  // API returns: { outward_supplies: { total_tax }, itc_available: { total_itc }, net_tax_payable }
  const _outputGST = parseFloat(
    gstr3bData?.outward_supplies?.total_tax ?? gstr3bData?.net_tax_payable ?? 0
  );
  const _inputITC  = parseFloat(gstr3bData?.itc_available?.total_itc ?? 0);
  const _itcAvail  = parseFloat(gstr3bData?.itc_available?.total_itc ?? 0);
  const _itcUsed   = parseFloat(gstr3bData?.itc_available?.itc_utilized ?? (_itcAvail * 0));
  const _netGST    = parseFloat(gstr3bData?.net_tax_payable ?? Math.max(0, _outputGST - _inputITC));

  // Extract live TDS total from quarterly summary
  // API returns: { total_tds_deducted, total_tds_paid, ... }
  const _tdsTotal  = tdsData
    ? (Array.isArray(tdsData)
        ? tdsData.reduce((s, r) => s + parseFloat(r.total_tds_deducted || r.tds_amount || 0), 0)
        : parseFloat(tdsData.total_tds_deducted ?? tdsData.total_tds ?? 0))
    : 0;

  const gstData = {
    gstr1:  { status: 'Filed',   period: _prevMonYear, due: `11 ${_filingMon}`, liability: _outputGST },
    gstr3b: { status: _gstr3bOverdue ? 'Overdue' : 'Pending', period: _prevMonYear, due: `20 ${_filingMon}`, liability: _netGST },
    gstr2b: { status: 'Available', period: _prevMonYear, due: '—', itc: _itcAvail },
    tds:    { status: _tdsOverdue ? 'Overdue' : 'Due', period: _prevMonYear, due: `7 ${_filingMon}`, amount: _tdsTotal },
    itc:    { available: _itcAvail, utilized: _itcUsed, balance: Math.max(0, _itcAvail - _itcUsed) },
    summary: [
      { label: 'Output GST (Sales)',    amount: _outputGST, type: 'liability' },
      { label: 'Input ITC (Purchases)', amount: _inputITC,  type: 'credit' },
      { label: 'Net GST Payable',       amount: _netGST,    type: 'payable' },
      { label: 'TDS Deducted',          amount: _tdsTotal,  type: 'liability' },
    ],
  };

  const rawInv = data.inv?.rows || data.inv?.invoices || data.inv?.data || data.inv;
  const topInvoices = Array.isArray(rawInv) ? rawInv.slice(0,8) : [];

  // Budget vs Actuals — from real /finance/budgets data, fallback to empty state
  const budgetData = (data.budgets || [])
    .filter(b => b.department && parseFloat(b.total_amount) > 0)
    .slice(0, 6)
    .map(b => ({
      dept:   b.department,
      budget: parseFloat(b.total_amount)   || 0,
      actual: parseFloat(b.total_actual)   || 0,
    }));

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

      {/* No bank accounts banner */}
      {bankAcctCount === 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, padding: '10px 16px', marginBottom: 12,
          background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8,
          fontSize: 13, color: '#92400e',
        }}>
          <span>
            <strong>⚠ No bank accounts configured</strong> — Cash Position and Payment Batches are unavailable until you add one.
          </span>
          <button
            onClick={() => setPage?.('BankAccounts')}
            style={{
              padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: '#6B3FDB', color: '#fff', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap',
            }}>
            Add Bank Account
          </button>
        </div>
      )}

      {/* Header */}
      <div className="fd-header">
        <div>
          <h2 className="fd-title">Finance Dashboard</h2>
          <p className="fd-sub">Last updated: {lastSync.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</p>
        </div>
        <div className="fd-header-r">
          <FYSelector />
          <div className="fd-period-tabs">
            {['month','quarter','year'].map(p=>(
              <button key={p} className={`fd-period-tab${period===p?' active':''}`}
                onClick={()=>setPeriod(p)}>
                {p.charAt(0).toUpperCase()+p.slice(1)}
              </button>
            ))}
          </div>
          <button className="fd-refresh-btn" onClick={load} disabled={loading}>
            <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}}/> {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="fd-kpis">
        <KPI icon={TrendingUp}   label={dash.fy_scoped ? 'Revenue (FY)' : 'Monthly Revenue'}  value={fmt(monthRev)}
          color="#6366f1" sub={dash.fy_scoped ? fyLabel : (dash.ytd_revenue ? `YTD: ${fmt(dash.ytd_revenue)}` : undefined)}
          onClick={()=>setPage&&setPage('FinanceReports')}/>
        <KPI icon={TrendingDown} label={dash.fy_scoped ? 'Expenses (FY)' : 'Monthly Expenses'} value={fmt(monthExp)}
          color="#ef4444" sub={monthRev > 0 ? `${((monthExp/monthRev)*100).toFixed(0)}% of revenue` : undefined}/>
        <KPI icon={IndianRupee}   label={dash.fy_scoped ? 'Net Profit (FY)' : 'Net Profit'}       value={fmt(netProfit)}
          trend={profitPct} color="#10b981"
          sub={`Margin: ${profitPct}%`}/>
        <KPI icon={Banknote}     label="Cash Balance"     value={dash.cash_balance != null ? fmt(dash.cash_balance) : '—'}
          color="#3b82f6" sub={ar || ap ? `AR: ${fmt(ar)} · AP: ${fmt(ap)}` : ''}/>
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
                </div>
                <div className="fd-cm-item">
                  <span className="fd-cm-dot" style={{background:'#ef4444'}}/>
                  <span>Expenses</span>
                  <strong>{fmt(monthExp)}</strong>
                </div>
                <div className="fd-cm-item">
                  <span className="fd-cm-dot" style={{background:'#10b981'}}/>
                  <span>Net Profit</span>
                  <strong>{fmt(netProfit)}</strong>
                  {monthRev > 0 && <TrendBadge value={profitPct}/>}
                </div>
              </div>
              <RevExpChart height={190}/>
            </Card>
          </div>

          {/* P&L Summary */}
          <div className="fc4">
            <Card title="P&L Summary">
              <div className="fd-pl">
                <div className="fd-pl-section">
                  <p className="fd-pl-heading">Income</p>
                  <div className="fd-pl-row"><span>Sales Revenue</span><span className="green">{fmt(monthRev)}</span></div>
                  <div className="fd-pl-row total"><span>Gross Income</span><span className="green">{fmt(monthRev)}</span></div>
                </div>
                <div className="fd-pl-section">
                  <p className="fd-pl-heading">Expenses</p>
                  <div className="fd-pl-row total"><span>Total Expenses</span><span className="red">{fmt(monthExp)}</span></div>
                </div>
                <div className="fd-pl-net">
                  <span>Net Profit</span>
                  <span className={netProfit>=0?'green':'red'}>{fmt(netProfit)}</span>
                </div>
                <div className="fd-pl-margin">
                  <span>Profit Margin</span>
                  <strong className={netProfit>=0?'green':'red'}>{profitPct}%</strong>
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
                  <IndianRupee size={16} color="#6366f1"/>
                  <span>Cash Balance</span>
                  <strong className="blue">{fmt(dash.cash_balance ?? 0)}</strong>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={165}>
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
            <Card title="Expense Breakdown — This Month">
              {expChart.length > 0 ? (
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
                        <span className="fd-exp-pct">{totalExp>0?((e.value/totalExp)*100).toFixed(1):'0.0'}%</span>
                        <span className="fd-exp-amt">{fmt(e.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="fd-empty">
                  <Receipt size={24} color="#9ca3af"/>
                  <p>No expense data for this month</p>
                </div>
              )}
            </Card>
          </div>

          {/* Budget vs Actual */}
          <div className="fc6">
            <Card title="Budget vs Actual — This Year"
              action={{label:'Manage Budgets', fn:()=>setPage&&setPage('BudgetManagement')}}>
              {budgetData.length > 0 ? budgetData.map((b,i)=>{
                const pct = b.budget > 0 ? Math.round((b.actual/b.budget)*100) : 0;
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
              }) : (
                <div className="fd-empty">
                  <Receipt size={24} color="#9ca3af"/>
                  <p>No budgets configured for this year</p>
                  <button className="fd-text-btn"
                    onClick={()=>setPage&&setPage('BudgetManagement')}>
                    Set up budgets
                  </button>
                </div>
              )}
            </Card>
          </div>

          {/* Recent Invoices */}
          <div className="fc6">
            <Card title="Recent Invoices" badge={topInvoices.length||undefined}
              action={{label:'View All', fn:()=>setPage&&setPage('Invoices')}}>
              {topInvoices.length > 0 ? (
                <div className="fd-inv-list">
                  {topInvoices.slice(0,6).map((inv,i)=>(
                    <div key={i} className="fd-inv-row">
                      <div className="fd-inv-icon"><FileText size={14}/></div>
                      <div className="fd-inv-info">
                        <span className="fd-inv-num">{inv.invoice_number}</span>
                        <span className="fd-inv-party">{inv.party_name || inv.customer_name || '—'}</span>
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
              ) : (
                <div className="fd-empty">
                  <FileText size={24} color="#9ca3af"/>
                  <p>No invoices yet</p>
                </div>
              )}
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
              {(gstData.gstr3b.status==='Pending'||gstData.gstr3b.status==='Overdue') && (
                <div className={`fd-alert fd-alert-${gstData.gstr3b.status==='Overdue'?'high':'med'}`}>
                  <AlertTriangle size={14}/>
                  <span>GSTR-3B {gstData.gstr3b.status==='Overdue'?'OVERDUE':'filing due'} {gstData.gstr3b.due} — ₹{fmtN(gstData.summary[2].amount)} payable</span>
                </div>
              )}
              {(gstData.tds.status==='Due'||gstData.tds.status==='Overdue') && (
                <div className={`fd-alert fd-alert-${gstData.tds.status==='Overdue'?'high':'med'}`}>
                  <Calendar size={14}/>
                  <span>TDS payment {gstData.tds.status==='Overdue'?'OVERDUE':'due'} {gstData.tds.due} — ₹{fmtN(gstData.tds.amount)}</span>
                </div>
              )}
              {budgetData.filter(b=>(b.actual/b.budget)>1).map((b,i)=>(
                <div key={i} className="fd-alert fd-alert-high">
                  <AlertTriangle size={14}/>
                  <span>{b.dept} is {Math.round((b.actual/b.budget-1)*100)}% over budget this month</span>
                </div>
              ))}
              {pendingAppr > 0 && (
                <div className="fd-alert fd-alert-low">
                  <CheckCircle size={14}/>
                  <span>{pendingAppr} items pending your approval</span>
                </div>
              )}
              {overdueCount===0 && dueSoon===0 && pendingAppr===0 && budgetData.filter(b=>(b.actual/b.budget)>1).length===0 && (
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
                  <span className="fd-aging-val">{fmt(overdueAmt)}</span>
                </div>
                <div className="fd-aging-kpi">
                  <span className="fd-aging-label">Collected (FY)</span>
                  <span className="fd-aging-val green">{fmt(dash.cash_inflow ?? 0)}</span>
                </div>
                <div className="fd-aging-kpi">
                  <span className="fd-aging-label">Cash Balance</span>
                  <span className="fd-aging-val green">{fmt(dash.cash_balance ?? 0)}</span>
                </div>
              </div>
              <div className="fd-aging-bars">
                {agingAR.length > 0 ? agingAR.map((a,i)=>{
                  const pct = ar > 0 ? Math.round((a.amount/ar)*100) : 0;
                  const color = i===0?'#10b981':i===1?'#f59e0b':i===2?'#ef4444':'#991b1b';
                  return (
                    <div key={i} className="fd-aging-row">
                      <span className="fd-aging-bucket">{a.bucket}</span>
                      <div className="fd-aging-track">
                        <div className="fd-aging-bar" style={{width:`${pct}%`,background:color}}/>
                      </div>
                      <span className="fd-aging-pct">{pct}%</span>
                      <span className="fd-aging-amt">{fmt(a.amount)}</span>
                    </div>
                  );
                }) : (
                  <div className="fd-empty"><p>No outstanding receivables</p></div>
                )}
              </div>
            </Card>
          </div>
          <div className="fc12">
            <Card title="Outstanding Invoices" badge={topInvoices.filter(i=>i.status!=='paid').length||undefined}
              action={{label:'Create Invoice', fn:()=>setPage&&setPage('InvoicesNew')}}>
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
                      <td>{inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                      <td>
                        <span className="fd-status-badge"
                          style={{background:statusColor(inv.status)+'18',color:statusColor(inv.status)}}>
                          {inv.status}
                        </span>
                      </td>
                      <td>
                        <button className="fd-action-btn" onClick={() => setPage && setPage('Invoices')}>
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
                  <span className="fd-aging-val">{fmt(agingAP.filter(a=>a.bucket!=='Current').reduce((s,a)=>s+a.amount,0))}</span>
                </div>
                <div className="fd-aging-kpi">
                  <span className="fd-aging-label">Paid (FY)</span>
                  <span className="fd-aging-val">{fmt(dash.cash_outflow ?? 0)}</span>
                </div>
                <div className="fd-aging-kpi">
                  <span className="fd-aging-label">Due in 7 Days</span>
                  <span className="fd-aging-val orange">{apDue7Days.length > 0 ? fmt(apDue7DaysAmt) : '—'}</span>
                </div>
              </div>
              <div className="fd-aging-bars">
                {agingAP.length > 0 ? agingAP.map((a,i)=>{
                  const pct = ap > 0 ? Math.round((a.amount/ap)*100) : 0;
                  const color = i===0?'#10b981':i===1?'#f59e0b':i===2?'#ef4444':'#991b1b';
                  return (
                    <div key={i} className="fd-aging-row">
                      <span className="fd-aging-bucket">{a.bucket}</span>
                      <div className="fd-aging-track">
                        <div className="fd-aging-bar" style={{width:`${pct}%`,background:color}}/>
                      </div>
                      <span className="fd-aging-pct">{pct}%</span>
                      <span className="fd-aging-amt">{fmt(a.amount)}</span>
                    </div>
                  );
                }) : (
                  <div className="fd-empty"><p>No outstanding payables</p></div>
                )}
              </div>
            </Card>
          </div>
          <div className="fc8">
            <Card title="Upcoming Payments — Next 30 Days"
              action={{label:'View Bills', fn:()=>setPage&&setPage('SupplierBills')}}>
              {(data.dueSoonBills || []).length > 0 ? (
                <table className="fd-table">
                  <thead><tr><th>Bill #</th><th>Supplier</th><th>Amount</th><th>Due Date</th><th>Status</th></tr></thead>
                  <tbody>
                    {(data.dueSoonBills || []).slice(0,6).map((b,i)=>(
                      <tr key={i}>
                        <td className="fd-td-mono">{b.bill_number}</td>
                        <td>{b.party_name || b.supplier_name || '—'}</td>
                        <td className="fd-td-amt">{fmt(b.total_amount)}</td>
                        <td>{b.due_date ? new Date(b.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                        <td><span className="fd-status-badge" style={{background:statusColor(b.status)+'18',color:statusColor(b.status)}}>{b.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="fd-empty">
                  <Building2 size={24} color="#9ca3af"/>
                  <p>No bills due in the next 30 days</p>
                  <button className="fd-text-btn" onClick={()=>setPage&&setPage('SupplierBills')}>View all bills</button>
                </div>
              )}
            </Card>
          </div>
          <div className="fc4">
            <Card title="Payment Summary">
              <div className="fd-pay-summary">
                <div className="fd-ps-item">
                  <span className="fd-ps-label">Total Payable</span>
                  <span className="fd-ps-val">{fmt(ap)}</span>
                </div>
                <div className="fd-ps-item">
                  <span className="fd-ps-label">Paid (FY)</span>
                  <span className="fd-ps-val">{fmt(dash.cash_outflow ?? 0)}</span>
                </div>
                <div className="fd-ps-item red">
                  <span className="fd-ps-label">Overdue Bills</span>
                  <span className="fd-ps-val red">{fmt(agingAP.filter(a=>a.bucket!=='Current').reduce((s,a)=>s+a.amount,0))}</span>
                </div>
                <div className="fd-ps-item">
                  <span className="fd-ps-label">Pending Approvals</span>
                  <span className="fd-ps-val orange">{pendingAppr}</span>
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
                      {(g.status==='Filed'||g.status==='Available') && <CheckCircle size={12}/>}
                      {(g.status==='Pending'||g.status==='Overdue') && <AlertTriangle size={12}/>}
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
            <Card title={`GST Summary — ${_prevMonYear}`}>
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
                {(Array.isArray(data.tdsSummary) && data.tdsSummary.length > 0
                  ? data.tdsSummary.map(t => ({ section: t.section || t.tds_section, desc: t.description || t.section, amount: parseFloat(t.tds_amount || 0), rate: t.rate ? `${t.rate}%` : '—' }))
                  : gstData.tds.amount > 0
                    ? [{ section: 'Various', desc: 'TDS Deducted (all sections)', amount: gstData.tds.amount, rate: '—' }]
                    : [{ section: '—', desc: 'No TDS transactions this quarter', amount: 0, rate: '—' }]
                ).map((t,i)=>(
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