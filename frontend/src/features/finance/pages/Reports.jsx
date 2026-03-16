import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import {
  Download, RefreshCw, Calendar, TrendingUp, TrendingDown,
  FileText, BarChart2, DollarSign, Scale, Activity,
  ChevronRight, ChevronDown, Printer, Filter
} from 'lucide-react';
import api from '@/services/api/client';
import './Reports.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt = (n, showSign=false) => {
  const v = parseFloat(n||0);
  const abs = Math.abs(v);
  let str = abs >= 10000000 ? `₹${(abs/10000000).toFixed(2)} Cr`
          : abs >= 100000   ? `₹${(abs/100000).toFixed(2)} L`
          : abs >= 1000     ? `₹${(abs/1000).toFixed(0)}K`
          : `₹${abs.toFixed(0)}`;
  if (showSign && v < 0) str = `(${str})`;
  return str;
};

const fmtFull = (n) => {
  const v = parseFloat(n||0);
  const sign = v < 0 ? '-' : '';
  return `${sign}₹${Math.abs(v).toLocaleString('en-IN', {minimumFractionDigits:0})}`;
};

const REPORT_TABS = [
  { id:'pl',      label:'Profit & Loss',   icon: TrendingUp   },
  { id:'bs',      label:'Balance Sheet',   icon: Scale        },
  { id:'cf',      label:'Cash Flow',       icon: Activity     },
  { id:'tb',      label:'Trial Balance',   icon: BarChart2    },
  { id:'ar',      label:'AR Aging',        icon: FileText     },
  { id:'ap',      label:'AP Aging',        icon: DollarSign   },
];

// ── Collapsible section ───────────────────────────────────────────────────────
const Section = ({ title, total, children, defaultOpen=true, accent='#6366f1' }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rpt-section">
      <div className="rpt-section-hd" onClick={() => setOpen(o=>!o)}
        style={{ borderLeftColor: accent }}>
        <div className="rpt-section-title-wrap">
          {open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
          <span className="rpt-section-title">{title}</span>
        </div>
        <span className="rpt-section-total" style={{ color: accent }}>
          {fmtFull(total)}
        </span>
      </div>
      {open && <div className="rpt-section-body">{children}</div>}
    </div>
  );
};

const LineRow = ({ label, value, indent=0, bold=false, total=false, negative=false }) => (
  <div className={`rpt-line ${bold?'rpt-line-bold':''} ${total?'rpt-line-total':''}`}
    style={{ paddingLeft: `${16 + indent*20}px` }}>
    <span className="rpt-line-label">{label}</span>
    <span className={`rpt-line-val ${negative||parseFloat(value)<0?'rpt-neg':''}`}>
      {fmtFull(value)}
    </span>
  </div>
);

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Reports() {
  const [activeTab,  setActiveTab]  = useState('pl');
  const [loading,    setLoading]    = useState(false);
  const [data,       setData]       = useState({});
  const [period,     setPeriod]     = useState('month'); // month|quarter|year|custom
  const [dateRange,  setDateRange]  = useState({
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end:   new Date().toISOString().split('T')[0],
  });
  const [compareMode, setCompareMode] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pl, bs, cf] = await Promise.allSettled([
        api.get('/finance/reports/profit-loss',  { params: { start_date: dateRange.start, end_date: dateRange.end } }),
        api.get('/finance/reports/balance-sheet',{ params: { as_of_date: dateRange.end } }),
        api.get('/finance/reports/cash-flow',    { params: { start_date: dateRange.start, end_date: dateRange.end } }),
      ]);
      setData({
        pl: pl.status==='fulfilled' ? pl.value.data : null,
        bs: bs.status==='fulfilled' ? bs.value.data : null,
        cf: cf.status==='fulfilled' ? cf.value.data : null,
      });
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, [dateRange]);

  useEffect(() => { load(); }, [load]);

  const handlePeriodChange = (p) => {
    setPeriod(p);
    const now = new Date();
    let start, end = now.toISOString().split('T')[0];
    if (p === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    } else if (p === 'quarter') {
      const q = Math.floor(now.getMonth()/3);
      start = new Date(now.getFullYear(), q*3, 1).toISOString().split('T')[0];
    } else if (p === 'year') {
      start = `${now.getFullYear()}-01-01`;
    } else { return; }
    setDateRange({ start, end });
  };

  // ── Static sample data (used when API returns nothing) ──────────────────
  const pl = data.pl || {
    revenue: { total: 378000, items: [
      { name:'Product Sales',    amount: 295000 },
      { name:'Service Revenue',  amount:  62000 },
      { name:'Other Income',     amount:  21000 },
    ]},
    cogs:    { total: 98000, items: [
      { name:'Raw Materials',    amount:  58000 },
      { name:'Direct Labour',    amount:  28000 },
      { name:'Manufacturing OH', amount:  12000 },
    ]},
    grossProfit: 280000,
    opex: { total: 174000, items: [
      { name:'Salaries & Wages',  amount: 110000 },
      { name:'Rent & Utilities',  amount:  22000 },
      { name:'Marketing',         amount:  18000 },
      { name:'Travel & Conveyance',amount:  8000 },
      { name:'IT & Software',     amount:  10000 },
      { name:'Depreciation',      amount:   6000 },
    ]},
    ebitda: 114000,
    interest: 4000,
    tax: 36000,
    netProfit: 66000,
  };

  const bs = data.bs || {
    assets: {
      current: { total: 285000, items: [
        { name:'Cash & Bank',          amount: 125000 },
        { name:'Accounts Receivable',  amount: 112000 },
        { name:'Inventory',            amount:  38000 },
        { name:'Prepaid Expenses',     amount:  10000 },
      ]},
      fixed: { total: 195000, items: [
        { name:'Property & Equipment', amount: 150000 },
        { name:'Vehicles',             amount:  35000 },
        { name:'Computer Equipment',   amount:  10000 },
      ]},
      total: 480000,
    },
    liabilities: {
      current: { total: 128000, items: [
        { name:'Accounts Payable',     amount:  72000 },
        { name:'Short-term Loans',     amount:  32000 },
        { name:'Accrued Expenses',     amount:  14000 },
        { name:'Tax Payable',          amount:  10000 },
      ]},
      longterm: { total: 72000, items: [
        { name:'Term Loan',            amount:  60000 },
        { name:'Deferred Tax',         amount:  12000 },
      ]},
      total: 200000,
    },
    equity: {
      total: 280000, items: [
        { name:'Share Capital',        amount: 150000 },
        { name:'Retained Earnings',    amount:  64000 },
        { name:'Current Year Profit',  amount:  66000 },
      ],
    },
  };

  const cf = data.cf || {
    operating: { total: 122000, items: [
      { name:'Net Income',                amount:  66000 },
      { name:'Add: Depreciation',         amount:   6000 },
      { name:'Change in Receivables',     amount: -18000 },
      { name:'Change in Inventory',       amount:  -8000 },
      { name:'Change in Payables',        amount:  12000 },
      { name:'Other Operating Changes',   amount:  64000 },
    ]},
    investing: { total: -48000, items: [
      { name:'Purchase of Equipment',     amount: -38000 },
      { name:'Purchase of Investments',   amount: -12000 },
      { name:'Sale of Assets',            amount:   2000 },
    ]},
    financing: { total: -18000, items: [
      { name:'Loan Repayment',            amount: -12000 },
      { name:'Dividends Paid',            amount:  -8000 },
      { name:'New Borrowings',            amount:   2000 },
    ]},
    netChange:     56000,
    openingBalance: 69000,
    closingBalance: 125000,
  };

  const trialBalance = [
    { account:'Cash & Bank',         code:'1010', debit:125000, credit:0 },
    { account:'Accounts Receivable', code:'1200', debit:112000, credit:0 },
    { account:'Inventory',           code:'1300', debit:38000,  credit:0 },
    { account:'Fixed Assets',        code:'1500', debit:195000, credit:0 },
    { account:'Accounts Payable',    code:'2100', debit:0,      credit:72000 },
    { account:'Short-term Loans',    code:'2200', debit:0,      credit:32000 },
    { account:'Tax Payable',         code:'2400', debit:0,      credit:10000 },
    { account:'Term Loan',           code:'2500', debit:0,      credit:60000 },
    { account:'Share Capital',       code:'3100', debit:0,      credit:150000 },
    { account:'Retained Earnings',   code:'3200', debit:0,      credit:64000 },
    { account:'Sales Revenue',       code:'4100', debit:0,      credit:295000 },
    { account:'Service Revenue',     code:'4200', debit:0,      credit:62000 },
    { account:'Cost of Goods Sold',  code:'5100', debit:98000,  credit:0 },
    { account:'Salaries',            code:'6100', debit:110000, credit:0 },
    { account:'Rent & Utilities',    code:'6200', debit:22000,  credit:0 },
    { account:'Marketing Expense',   code:'6300', debit:18000,  credit:0 },
    { account:'IT & Software',       code:'6400', debit:10000,  credit:0 },
    { account:'Depreciation',        code:'6500', debit:6000,   credit:0 },
    { account:'Interest Expense',    code:'7100', debit:4000,   credit:0 },
    { account:'Tax Expense',         code:'7200', debit:36000,  credit:0 },
  ];
  const tbDebitTotal  = trialBalance.reduce((s,r)=>s+r.debit,0);
  const tbCreditTotal = trialBalance.reduce((s,r)=>s+r.credit,0);

  const arAging = [
    { party:'TechCorp Ltd',      current:45000, d30:28000, d60:12000, d90:0,    over90:0     },
    { party:'Alpha Solutions',   current:32000, d30:0,     d60:0,     d90:8000, over90:0     },
    { party:'Gamma Corp',        current:0,     d30:18000, d60:0,     d90:0,    over90:15000 },
    { party:'Beta Systems',      current:22000, d30:0,     d60:9000,  d90:0,    over90:0     },
    { party:'Epsilon Tech',      current:18000, d30:0,     d60:0,     d90:0,    over90:0     },
  ];

  const apAging = [
    { party:'Office Supplies Co', current:12000, d30:0,    d60:5000, d90:0,    over90:0 },
    { party:'Cloud Services Ltd', current:28000, d30:8000, d60:0,    d90:0,    over90:0 },
    { party:'Marketing Agency',   current:0,     d30:0,    d60:0,    d90:12000,over90:8000 },
  ];

  const plChartData = [
    { name:'Revenue', value: pl.revenue.total,  fill:'#6366f1' },
    { name:'COGS',    value: pl.cogs.total,      fill:'#ef4444' },
    { name:'OpEx',    value: pl.opex.total,      fill:'#f59e0b' },
    { name:'Net Profit',value: pl.netProfit,     fill:'#10b981' },
  ];

  const cfChartData = [
    { name:'Operating', value: cf.operating.total, fill: cf.operating.total >= 0 ? '#10b981' : '#ef4444' },
    { name:'Investing',  value: cf.investing.total,  fill: cf.investing.total  >= 0 ? '#10b981' : '#ef4444' },
    { name:'Financing',  value: cf.financing.total,  fill: cf.financing.total  >= 0 ? '#10b981' : '#ef4444' },
  ];

  const profitMargin  = ((pl.netProfit  / pl.revenue.total) * 100).toFixed(1);
  const grossMargin   = ((pl.grossProfit/ pl.revenue.total) * 100).toFixed(1);
  const currentRatio  = (bs.assets.current.total / bs.liabilities.current.total).toFixed(2);
  const debtToEquity  = (bs.liabilities.total / bs.equity.total).toFixed(2);

  return (
    <div className="rpt-root">

      {/* Header */}
      <div className="rpt-header">
        <div>
          <h2 className="rpt-title">Financial Reports</h2>
          <p className="rpt-sub">
            {new Date(dateRange.start).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}
            {' — '}
            {new Date(dateRange.end).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}
          </p>
        </div>
        <div className="rpt-header-r">
          {/* Period picker */}
          <div className="rpt-period">
            {['month','quarter','year','custom'].map(p=>(
              <button key={p} className={`rpt-period-tab${period===p?' active':''}`}
                onClick={() => handlePeriodChange(p)}>
                {p.charAt(0).toUpperCase()+p.slice(1)}
              </button>
            ))}
          </div>
          {period === 'custom' && (
            <div className="rpt-date-range">
              <input type="date" value={dateRange.start}
                onChange={e=>setDateRange(d=>({...d,start:e.target.value}))}/>
              <span>to</span>
              <input type="date" value={dateRange.end}
                onChange={e=>setDateRange(d=>({...d,end:e.target.value}))}/>
            </div>
          )}
          <button className={`rpt-compare-btn${compareMode?' active':''}`}
            onClick={()=>setCompareMode(c=>!c)}>
            <Filter size={13}/> Compare
          </button>
          <button className="rpt-btn-outline"><Printer size={14}/> Print</button>
          <button className="rpt-btn-outline"><Download size={14}/> Export</button>
          <button className="rpt-refresh" onClick={load}>
            <RefreshCw size={14}/> Refresh
          </button>
        </div>
      </div>

      {/* Summary KPIs */}
      <div className="rpt-kpis">
        <div className="rpt-kpi">
          <TrendingUp size={16} color="#6366f1"/>
          <div>
            <p className="rpt-kpi-label">Revenue</p>
            <p className="rpt-kpi-val">{fmt(pl.revenue.total)}</p>
          </div>
        </div>
        <div className="rpt-kpi">
          <TrendingDown size={16} color="#ef4444"/>
          <div>
            <p className="rpt-kpi-label">Total Expenses</p>
            <p className="rpt-kpi-val">{fmt(pl.cogs.total + pl.opex.total)}</p>
          </div>
        </div>
        <div className="rpt-kpi green">
          <DollarSign size={16} color="#10b981"/>
          <div>
            <p className="rpt-kpi-label">Net Profit</p>
            <p className="rpt-kpi-val">{fmt(pl.netProfit)}</p>
          </div>
        </div>
        <div className="rpt-kpi">
          <BarChart2 size={16} color="#8b5cf6"/>
          <div>
            <p className="rpt-kpi-label">Gross Margin</p>
            <p className="rpt-kpi-val">{grossMargin}%</p>
          </div>
        </div>
        <div className="rpt-kpi">
          <Activity size={16} color="#3b82f6"/>
          <div>
            <p className="rpt-kpi-label">Net Margin</p>
            <p className="rpt-kpi-val">{profitMargin}%</p>
          </div>
        </div>
        <div className="rpt-kpi">
          <Scale size={16} color="#f59e0b"/>
          <div>
            <p className="rpt-kpi-label">Current Ratio</p>
            <p className="rpt-kpi-val">{currentRatio}x</p>
          </div>
        </div>
        <div className="rpt-kpi">
          <DollarSign size={16} color="#ef4444"/>
          <div>
            <p className="rpt-kpi-label">Debt / Equity</p>
            <p className="rpt-kpi-val">{debtToEquity}</p>
          </div>
        </div>
        <div className="rpt-kpi">
          <Activity size={16} color="#10b981"/>
          <div>
            <p className="rpt-kpi-label">Cash Position</p>
            <p className="rpt-kpi-val">{fmt(cf.closingBalance)}</p>
          </div>
        </div>
      </div>

      {/* Report tabs */}
      <div className="rpt-tabs">
        {REPORT_TABS.map(t=>(
          <button key={t.id} className={`rpt-tab${activeTab===t.id?' active':''}`}
            onClick={()=>setActiveTab(t.id)}>
            <t.icon size={14}/>
            {t.label}
          </button>
        ))}
      </div>

      {loading && <div className="rpt-loading"><div className="rpt-spinner"/><p>Loading report…</p></div>}

      {!loading && (
        <div className="rpt-body">

          {/* ── P&L ────────────────────────────────────────────── */}
          {activeTab === 'pl' && (
            <div className="rpt-two-col">
              <div className="rpt-report-wrap">
                <div className="rpt-report-hd">
                  <h3>Profit & Loss Statement</h3>
                  <span className="rpt-report-period">
                    {new Date(dateRange.start).toLocaleDateString('en-IN',{month:'short',year:'numeric'})}
                    {' – '}
                    {new Date(dateRange.end).toLocaleDateString('en-IN',{month:'short',year:'numeric'})}
                  </span>
                </div>

                <Section title="Revenue" total={pl.revenue.total} accent="#6366f1">
                  {pl.revenue.items.map((item,i)=>(
                    <LineRow key={i} label={item.name} value={item.amount} indent={1}/>
                  ))}
                  <LineRow label="Total Revenue" value={pl.revenue.total} bold total/>
                </Section>

                <Section title="Cost of Goods Sold (COGS)" total={-pl.cogs.total} accent="#ef4444">
                  {pl.cogs.items.map((item,i)=>(
                    <LineRow key={i} label={item.name} value={-item.amount} indent={1} negative/>
                  ))}
                  <LineRow label="Total COGS" value={-pl.cogs.total} bold total negative/>
                </Section>

                <div className="rpt-gross-profit">
                  <span>Gross Profit</span>
                  <div>
                    <span className="rpt-margin-badge">{grossMargin}% margin</span>
                    <span className="rpt-gp-val">{fmtFull(pl.grossProfit)}</span>
                  </div>
                </div>

                <Section title="Operating Expenses" total={-pl.opex.total} accent="#f59e0b">
                  {pl.opex.items.map((item,i)=>(
                    <LineRow key={i} label={item.name} value={-item.amount} indent={1} negative/>
                  ))}
                  <LineRow label="Total OpEx" value={-pl.opex.total} bold total negative/>
                </Section>

                <div className="rpt-ebitda">
                  <span>EBITDA</span>
                  <span>{fmtFull(pl.ebitda)}</span>
                </div>

                <div className="rpt-below-ebitda">
                  <LineRow label="Interest Expense"  value={-pl.interest} negative/>
                  <LineRow label="Tax Provision"      value={-pl.tax}     negative/>
                </div>

                <div className="rpt-net-profit">
                  <div>
                    <span>Net Profit / (Loss)</span>
                    <span className="rpt-np-margin">{profitMargin}% net margin</span>
                  </div>
                  <span className={pl.netProfit >= 0 ? 'rpt-np-pos' : 'rpt-np-neg'}>
                    {fmtFull(pl.netProfit)}
                  </span>
                </div>
              </div>

              <div className="rpt-side">
                <div className="rpt-chart-card">
                  <h4>Revenue & Cost Breakdown</h4>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={plChartData} margin={{top:5,right:5,left:0,bottom:5}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
                      <XAxis dataKey="name" tick={{fontSize:11}}/>
                      <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:11}}/>
                      <Tooltip formatter={v=>[fmtFull(v),'']}/>
                      <Bar dataKey="value" radius={[4,4,0,0]}>
                        {plChartData.map((d,i)=><Cell key={i} fill={d.fill}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="rpt-ratios-card">
                  <h4>Key Metrics</h4>
                  {[
                    {label:'Gross Margin',    value:`${grossMargin}%`,  good: parseFloat(grossMargin) > 30 },
                    {label:'Net Margin',      value:`${profitMargin}%`, good: parseFloat(profitMargin) > 15 },
                    {label:'EBITDA Margin',   value:`${((pl.ebitda/pl.revenue.total)*100).toFixed(1)}%`, good:true},
                    {label:'Revenue Growth',  value:'+18%',  good:true },
                    {label:'Expense Ratio',   value:`${(((pl.cogs.total+pl.opex.total)/pl.revenue.total)*100).toFixed(0)}%`, good:false },
                    {label:'Tax Rate',        value:`${((pl.tax/pl.netProfit)*100).toFixed(0)}%`, good:true},
                  ].map((m,i)=>(
                    <div key={i} className="rpt-metric-row">
                      <span>{m.label}</span>
                      <span className={m.good ? 'rpt-metric-good' : 'rpt-metric-warn'}>{m.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Balance Sheet ───────────────────────────────────── */}
          {activeTab === 'bs' && (
            <div className="rpt-two-col">
              <div className="rpt-report-wrap">
                <div className="rpt-report-hd">
                  <h3>Balance Sheet</h3>
                  <span className="rpt-report-period">
                    As of {new Date(dateRange.end).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}
                  </span>
                </div>

                <div className="rpt-bs-columns">
                  {/* Assets */}
                  <div className="rpt-bs-col">
                    <div className="rpt-bs-heading" style={{color:'#3b82f6'}}>ASSETS</div>
                    <Section title="Current Assets" total={bs.assets.current.total} accent="#3b82f6">
                      {bs.assets.current.items.map((item,i)=>(
                        <LineRow key={i} label={item.name} value={item.amount} indent={1}/>
                      ))}
                      <LineRow label="Total Current Assets" value={bs.assets.current.total} bold total/>
                    </Section>
                    <Section title="Fixed Assets" total={bs.assets.fixed.total} accent="#6366f1">
                      {bs.assets.fixed.items.map((item,i)=>(
                        <LineRow key={i} label={item.name} value={item.amount} indent={1}/>
                      ))}
                      <LineRow label="Total Fixed Assets" value={bs.assets.fixed.total} bold total/>
                    </Section>
                    <div className="rpt-bs-grand-total" style={{borderColor:'#3b82f6'}}>
                      <span>TOTAL ASSETS</span>
                      <span>{fmtFull(bs.assets.total)}</span>
                    </div>
                  </div>

                  {/* Liabilities + Equity */}
                  <div className="rpt-bs-col">
                    <div className="rpt-bs-heading" style={{color:'#ef4444'}}>LIABILITIES & EQUITY</div>
                    <Section title="Current Liabilities" total={bs.liabilities.current.total} accent="#ef4444">
                      {bs.liabilities.current.items.map((item,i)=>(
                        <LineRow key={i} label={item.name} value={item.amount} indent={1}/>
                      ))}
                      <LineRow label="Total Current Liabilities" value={bs.liabilities.current.total} bold total/>
                    </Section>
                    <Section title="Long-term Liabilities" total={bs.liabilities.longterm.total} accent="#f59e0b">
                      {bs.liabilities.longterm.items.map((item,i)=>(
                        <LineRow key={i} label={item.name} value={item.amount} indent={1}/>
                      ))}
                      <LineRow label="Total Long-term Liabilities" value={bs.liabilities.longterm.total} bold total/>
                    </Section>
                    <Section title="Equity" total={bs.equity.total} accent="#8b5cf6">
                      {bs.equity.items.map((item,i)=>(
                        <LineRow key={i} label={item.name} value={item.amount} indent={1}/>
                      ))}
                      <LineRow label="Total Equity" value={bs.equity.total} bold total/>
                    </Section>
                    <div className="rpt-bs-grand-total" style={{borderColor:'#ef4444'}}>
                      <span>TOTAL LIABILITIES & EQUITY</span>
                      <span>{fmtFull(bs.liabilities.total + bs.equity.total)}</span>
                    </div>
                    <div className={`rpt-bs-balanced ${bs.assets.total === bs.liabilities.total + bs.equity.total ? 'balanced' : 'unbalanced'}`}>
                      {bs.assets.total === bs.liabilities.total + bs.equity.total
                        ? '✓ Balance sheet is balanced'
                        : '⚠ Balance sheet does not balance'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rpt-side">
                <div className="rpt-chart-card">
                  <h4>Asset Composition</h4>
                  <div className="rpt-bs-bar">
                    <div className="rpt-bs-bar-fill" style={{width:`${(bs.assets.current.total/bs.assets.total)*100}%`,background:'#3b82f6'}}/>
                    <div className="rpt-bs-bar-fill" style={{width:`${(bs.assets.fixed.total/bs.assets.total)*100}%`,background:'#6366f1'}}/>
                  </div>
                  <div className="rpt-bs-bar-legend">
                    <span><span style={{background:'#3b82f6'}} className="rpt-dot"/>Current {((bs.assets.current.total/bs.assets.total)*100).toFixed(0)}%</span>
                    <span><span style={{background:'#6366f1'}} className="rpt-dot"/>Fixed {((bs.assets.fixed.total/bs.assets.total)*100).toFixed(0)}%</span>
                  </div>
                </div>
                <div className="rpt-ratios-card">
                  <h4>Balance Sheet Ratios</h4>
                  {[
                    {label:'Current Ratio',    value:`${currentRatio}x`,  good: parseFloat(currentRatio) >= 2},
                    {label:'Quick Ratio',       value:'1.8x',  good: true },
                    {label:'Debt-to-Equity',    value:`${debtToEquity}`,   good: parseFloat(debtToEquity) < 1},
                    {label:'Debt-to-Assets',    value:`${((bs.liabilities.total/bs.assets.total)).toFixed(2)}`, good:true},
                    {label:'Working Capital',   value:fmt(bs.assets.current.total-bs.liabilities.current.total), good:true},
                    {label:'Equity Ratio',      value:`${((bs.equity.total/bs.assets.total)*100).toFixed(0)}%`, good:true},
                  ].map((m,i)=>(
                    <div key={i} className="rpt-metric-row">
                      <span>{m.label}</span>
                      <span className={m.good ? 'rpt-metric-good' : 'rpt-metric-warn'}>{m.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Cash Flow ───────────────────────────────────────── */}
          {activeTab === 'cf' && (
            <div className="rpt-two-col">
              <div className="rpt-report-wrap">
                <div className="rpt-report-hd">
                  <h3>Cash Flow Statement</h3>
                  <span className="rpt-report-period">Indirect Method</span>
                </div>

                <div className="rpt-cf-opening">
                  <span>Opening Cash Balance</span>
                  <strong>{fmtFull(cf.openingBalance)}</strong>
                </div>

                <Section title="Operating Activities" total={cf.operating.total}
                  accent={cf.operating.total >= 0 ? '#10b981' : '#ef4444'}>
                  {cf.operating.items.map((item,i)=>(
                    <LineRow key={i} label={item.name} value={item.amount} indent={1}
                      negative={item.amount < 0}/>
                  ))}
                  <LineRow label="Net Cash from Operating" value={cf.operating.total} bold total/>
                </Section>

                <Section title="Investing Activities" total={cf.investing.total}
                  accent={cf.investing.total >= 0 ? '#10b981' : '#f59e0b'}>
                  {cf.investing.items.map((item,i)=>(
                    <LineRow key={i} label={item.name} value={item.amount} indent={1}
                      negative={item.amount < 0}/>
                  ))}
                  <LineRow label="Net Cash from Investing" value={cf.investing.total} bold total/>
                </Section>

                <Section title="Financing Activities" total={cf.financing.total}
                  accent={cf.financing.total >= 0 ? '#10b981' : '#8b5cf6'}>
                  {cf.financing.items.map((item,i)=>(
                    <LineRow key={i} label={item.name} value={item.amount} indent={1}
                      negative={item.amount < 0}/>
                  ))}
                  <LineRow label="Net Cash from Financing" value={cf.financing.total} bold total/>
                </Section>

                <div className="rpt-cf-net">
                  <span>Net Change in Cash</span>
                  <span className={cf.netChange >= 0 ? 'rpt-np-pos' : 'rpt-np-neg'}>
                    {cf.netChange >= 0 ? '+' : ''}{fmtFull(cf.netChange)}
                  </span>
                </div>

                <div className="rpt-cf-closing">
                  <span>Closing Cash Balance</span>
                  <strong className="rpt-np-pos">{fmtFull(cf.closingBalance)}</strong>
                </div>
              </div>

              <div className="rpt-side">
                <div className="rpt-chart-card">
                  <h4>Cash Flow by Activity</h4>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={cfChartData} margin={{top:5,right:5,left:0,bottom:5}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
                      <XAxis dataKey="name" tick={{fontSize:11}}/>
                      <YAxis tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} tick={{fontSize:11}}/>
                      <Tooltip formatter={v=>[fmtFull(v),'']}/>
                      <Bar dataKey="value" radius={[4,4,0,0]}>
                        {cfChartData.map((d,i)=><Cell key={i} fill={d.fill}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="rpt-ratios-card">
                  <h4>Cash Flow Health</h4>
                  {[
                    {label:'Operating CF',  value: fmt(cf.operating.total),  good: cf.operating.total > 0 },
                    {label:'Free Cash Flow',value: fmt(cf.operating.total + cf.investing.total), good: (cf.operating.total + cf.investing.total) > 0},
                    {label:'Cash Ratio',    value:'1.8x', good:true},
                    {label:'Cash Coverage', value:'8.4x', good:true},
                    {label:'Opening Bal',   value: fmt(cf.openingBalance), good:true},
                    {label:'Closing Bal',   value: fmt(cf.closingBalance), good: cf.closingBalance > cf.openingBalance},
                  ].map((m,i)=>(
                    <div key={i} className="rpt-metric-row">
                      <span>{m.label}</span>
                      <span className={m.good ? 'rpt-metric-good' : 'rpt-metric-warn'}>{m.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Trial Balance ───────────────────────────────────── */}
          {activeTab === 'tb' && (
            <div className="rpt-report-wrap rpt-report-wide">
              <div className="rpt-report-hd">
                <h3>Trial Balance</h3>
                <span className="rpt-report-period">
                  As of {new Date(dateRange.end).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}
                </span>
              </div>
              <table className="rpt-tb-table">
                <thead>
                  <tr>
                    <th>Account Code</th>
                    <th>Account Name</th>
                    <th className="rpt-th-r">Debit (₹)</th>
                    <th className="rpt-th-r">Credit (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {trialBalance.map((row,i)=>(
                    <tr key={i} className="rpt-tb-row">
                      <td className="rpt-tb-code">{row.code}</td>
                      <td>{row.account}</td>
                      <td className="rpt-tb-debit">{row.debit ? fmtFull(row.debit) : '—'}</td>
                      <td className="rpt-tb-credit">{row.credit ? fmtFull(row.credit) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="rpt-tb-totals">
                    <td colSpan={2}>TOTALS</td>
                    <td className="rpt-tb-debit">{fmtFull(tbDebitTotal)}</td>
                    <td className="rpt-tb-credit">{fmtFull(tbCreditTotal)}</td>
                  </tr>
                  <tr className={`rpt-tb-balance ${tbDebitTotal === tbCreditTotal ? 'balanced' : 'unbalanced'}`}>
                    <td colSpan={4}>
                      {tbDebitTotal === tbCreditTotal
                        ? `✓ Trial balance is balanced — Total: ${fmtFull(tbDebitTotal)}`
                        : `⚠ Imbalance detected — Difference: ${fmtFull(Math.abs(tbDebitTotal - tbCreditTotal))}`}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* ── AR Aging ────────────────────────────────────────── */}
          {activeTab === 'ar' && (
            <div className="rpt-report-wrap rpt-report-wide">
              <div className="rpt-report-hd">
                <h3>Accounts Receivable — Aging Report</h3>
                <span className="rpt-report-period">
                  As of {new Date(dateRange.end).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}
                </span>
              </div>
              <div className="rpt-aging-summary">
                {[
                  {label:'Current (0–30d)', value: arAging.reduce((s,r)=>s+r.current,0), color:'#10b981'},
                  {label:'31–60 days',       value: arAging.reduce((s,r)=>s+r.d30,0),    color:'#f59e0b'},
                  {label:'61–90 days',       value: arAging.reduce((s,r)=>s+r.d60,0),    color:'#ef4444'},
                  {label:'>90 days',         value: arAging.reduce((s,r)=>s+r.over90,0), color:'#991b1b'},
                ].map((b,i)=>(
                  <div key={i} className="rpt-aging-bucket" style={{borderTopColor:b.color}}>
                    <span className="rpt-aging-label">{b.label}</span>
                    <span className="rpt-aging-val" style={{color:b.color}}>{fmtFull(b.value)}</span>
                  </div>
                ))}
              </div>
              <table className="rpt-aging-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="rpt-th-r">Current</th>
                    <th className="rpt-th-r">31–60 days</th>
                    <th className="rpt-th-r">61–90 days</th>
                    <th className="rpt-th-r">91–180 days</th>
                    <th className="rpt-th-r">&gt;180 days</th>
                    <th className="rpt-th-r">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {arAging.map((row,i)=>{
                    const total = row.current+row.d30+row.d60+row.d90+row.over90;
                    return (
                      <tr key={i} className="rpt-tb-row">
                        <td>{row.party}</td>
                        <td className="rpt-td-r green">{row.current ? fmtFull(row.current) : '—'}</td>
                        <td className="rpt-td-r amber">{row.d30 ? fmtFull(row.d30) : '—'}</td>
                        <td className="rpt-td-r orange">{row.d60 ? fmtFull(row.d60) : '—'}</td>
                        <td className="rpt-td-r red">{row.d90 ? fmtFull(row.d90) : '—'}</td>
                        <td className="rpt-td-r darkred">{row.over90 ? fmtFull(row.over90) : '—'}</td>
                        <td className="rpt-td-r rpt-td-bold">{fmtFull(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="rpt-tb-totals">
                    <td>TOTAL</td>
                    <td className="rpt-td-r">{fmtFull(arAging.reduce((s,r)=>s+r.current,0))}</td>
                    <td className="rpt-td-r">{fmtFull(arAging.reduce((s,r)=>s+r.d30,0))}</td>
                    <td className="rpt-td-r">{fmtFull(arAging.reduce((s,r)=>s+r.d60,0))}</td>
                    <td className="rpt-td-r">{fmtFull(arAging.reduce((s,r)=>s+r.d90,0))}</td>
                    <td className="rpt-td-r">{fmtFull(arAging.reduce((s,r)=>s+r.over90,0))}</td>
                    <td className="rpt-td-r rpt-td-bold">
                      {fmtFull(arAging.reduce((s,r)=>s+r.current+r.d30+r.d60+r.d90+r.over90,0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* ── AP Aging ────────────────────────────────────────── */}
          {activeTab === 'ap' && (
            <div className="rpt-report-wrap rpt-report-wide">
              <div className="rpt-report-hd">
                <h3>Accounts Payable — Aging Report</h3>
                <span className="rpt-report-period">
                  As of {new Date(dateRange.end).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}
                </span>
              </div>
              <div className="rpt-aging-summary">
                {[
                  {label:'Current (0–30d)', value: apAging.reduce((s,r)=>s+r.current,0), color:'#10b981'},
                  {label:'31–60 days',       value: apAging.reduce((s,r)=>s+r.d30,0),    color:'#f59e0b'},
                  {label:'61–90 days',       value: apAging.reduce((s,r)=>s+r.d60,0),    color:'#ef4444'},
                  {label:'>90 days',         value: apAging.reduce((s,r)=>s+r.over90,0), color:'#991b1b'},
                ].map((b,i)=>(
                  <div key={i} className="rpt-aging-bucket" style={{borderTopColor:b.color}}>
                    <span className="rpt-aging-label">{b.label}</span>
                    <span className="rpt-aging-val" style={{color:b.color}}>{fmtFull(b.value)}</span>
                  </div>
                ))}
              </div>
              <table className="rpt-aging-table">
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th className="rpt-th-r">Current</th>
                    <th className="rpt-th-r">31–60 days</th>
                    <th className="rpt-th-r">61–90 days</th>
                    <th className="rpt-th-r">91–180 days</th>
                    <th className="rpt-th-r">&gt;180 days</th>
                    <th className="rpt-th-r">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {apAging.map((row,i)=>{
                    const total = row.current+row.d30+row.d60+row.d90+row.over90;
                    return (
                      <tr key={i} className="rpt-tb-row">
                        <td>{row.party}</td>
                        <td className="rpt-td-r green">{row.current ? fmtFull(row.current) : '—'}</td>
                        <td className="rpt-td-r amber">{row.d30 ? fmtFull(row.d30) : '—'}</td>
                        <td className="rpt-td-r orange">{row.d60 ? fmtFull(row.d60) : '—'}</td>
                        <td className="rpt-td-r red">{row.d90 ? fmtFull(row.d90) : '—'}</td>
                        <td className="rpt-td-r darkred">{row.over90 ? fmtFull(row.over90) : '—'}</td>
                        <td className="rpt-td-r rpt-td-bold">{fmtFull(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="rpt-tb-totals">
                    <td>TOTAL</td>
                    <td className="rpt-td-r">{fmtFull(apAging.reduce((s,r)=>s+r.current,0))}</td>
                    <td className="rpt-td-r">{fmtFull(apAging.reduce((s,r)=>s+r.d30,0))}</td>
                    <td className="rpt-td-r">{fmtFull(apAging.reduce((s,r)=>s+r.d60,0))}</td>
                    <td className="rpt-td-r">{fmtFull(apAging.reduce((s,r)=>s+r.d90,0))}</td>
                    <td className="rpt-td-r">{fmtFull(apAging.reduce((s,r)=>s+r.over90,0))}</td>
                    <td className="rpt-td-r rpt-td-bold">
                      {fmtFull(apAging.reduce((s,r)=>s+r.current+r.d30+r.d60+r.d90+r.over90,0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

        </div>
      )}
    </div>
  );
}