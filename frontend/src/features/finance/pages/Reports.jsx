import { useState, useEffect, useCallback, useRef } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import {
  Download, RefreshCw, Calendar, TrendingUp, TrendingDown, FileText,
  BarChart2, IndianRupee, Scale, Activity, ChevronRight, ChevronDown,
  Printer, Filter, BarChart3,
} from 'lucide-react';
import api from '@/services/api/client';
import { useFY } from '@/context/FYContext';
import FYSelector from '@/components/core/FYSelector';
import './Reports.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

// ── helpers ──────────────────────────────────────────────────────────────────
function exportCSV(rows, filename) {
  if (!rows?.length) return;
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(','), ...rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${filename}-${Date.now()}.csv` });
  a.click(); URL.revokeObjectURL(url);
}

function buildExportData(tab, pl, bs, cf, trialBalance, arAging, apAging) {
  switch (tab) {
    case 'pl': return {
      rows: [
        ...pl.revenue.items.map(i => ({ Section: 'Revenue', Item: i.name, Amount: i.amount })),
        { Section: 'Total Revenue', Item: '', Amount: pl.revenue.total },
        ...pl.cogs.items.map(i => ({ Section: 'COGS', Item: i.name, Amount: i.amount })),
        { Section: 'Total COGS', Item: '', Amount: pl.cogs.total },
        { Section: 'Gross Profit', Item: '', Amount: pl.grossProfit },
        ...pl.opex.items.map(i => ({ Section: 'Operating Expenses', Item: i.name, Amount: i.amount })),
        { Section: 'Total OpEx', Item: '', Amount: pl.opex.total },
        { Section: 'Operating Profit', Item: '', Amount: pl.operatingProfit },
        { Section: 'Other Income', Item: '', Amount: pl.otherIncome },
        { Section: 'Net Profit', Item: '', Amount: pl.netProfit },
      ],
      name: 'profit-loss',
    };
    case 'bs': return {
      rows: [
        ...bs.assets.current.items.map(i => ({ Section: 'Current Assets', Item: i.name, Amount: i.amount })),
        { Section: 'Total Current Assets', Item: '', Amount: bs.assets.current.total },
        ...bs.assets.fixed.items.map(i => ({ Section: 'Fixed Assets', Item: i.name, Amount: i.amount })),
        { Section: 'Total Fixed Assets', Item: '', Amount: bs.assets.fixed.total },
        { Section: 'TOTAL ASSETS', Item: '', Amount: bs.assets.total },
        ...bs.liabilities.current.items.map(i => ({ Section: 'Current Liabilities', Item: i.name, Amount: i.amount })),
        { Section: 'Total Current Liabilities', Item: '', Amount: bs.liabilities.current.total },
        ...bs.liabilities.longterm.items.map(i => ({ Section: 'Long-term Liabilities', Item: i.name, Amount: i.amount })),
        { Section: 'Total Long-term Liabilities', Item: '', Amount: bs.liabilities.longterm.total },
        ...bs.equity.items.map(i => ({ Section: 'Equity', Item: i.name, Amount: i.amount })),
        { Section: 'Total Equity', Item: '', Amount: bs.equity.total },
        { Section: 'TOTAL LIABILITIES & EQUITY', Item: '', Amount: bs.liabilities.total + bs.equity.total },
      ],
      name: 'balance-sheet',
    };
    // Exports the same per-account cash movement the Cash Flow tab renders —
    // the screen and the CSV must not be built from different figures.
    case 'cf': return {
      rows: [
        ...cf.accounts.map(a => ({
          Account_Code: a.code, Account: a.name,
          Cash_In: a.cashIn, Cash_Out: a.cashOut, Net_Movement: a.net,
        })),
        { Account_Code: '', Account: 'TOTAL', Cash_In: cf.totalIn, Cash_Out: cf.totalOut, Net_Movement: cf.netChange },
      ],
      name: 'cash-movement',
    };
    case 'tb': return {
      rows: trialBalance.map(r => ({ Account_Code: r.code, Account: r.account, Debit: r.debit || 0, Credit: r.credit || 0 })),
      name: 'trial-balance',
    };
    case 'ar': return {
      rows: arAging.map(r => ({ Customer: r.party, Current: r.current, '31_60_days': r.d30, '61_90_days': r.d60, '91_180_days': r.d90, Over_180_days: r.over90, Total: r.current + r.d30 + r.d60 + r.d90 + r.over90 })),
      name: 'ar-aging',
    };
    case 'ap': return {
      rows: apAging.map(r => ({ Supplier: r.party, Current: r.current, '31_60_days': r.d30, '61_90_days': r.d60, '91_180_days': r.d90, Over_180_days: r.over90, Total: r.current + r.d30 + r.d60 + r.d90 + r.over90 })),
      name: 'ap-aging',
    };
    default: return null;
  }
}

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
  { id:'ap',      label:'AP Aging',        icon: IndianRupee   },
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

// ── API → view-model adapters ────────────────────────────────────────────────
// This page used to fall back to a hardcoded specimen company (₹378,000 revenue,
// ₹66,000 net profit) whenever the response did not carry the exact key it
// probed for — and because it probed `data.pl?.revenue` while the API returns
// `total_revenue`, the specimen won on EVERY successful load. The trial balance
// was hardcoded outright and never requested at all.
//
// These adapters map the real Accounting Engine responses onto the shapes the
// render layer already expects. They return zeroed structures when there is no
// data and never invent a figure; `hasData` lets the UI say so explicitly
// rather than present zeros as a finished report.
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const groupOf = (rows, nameKey, amountKey) => {
  const items = (rows || [])
    .map(r => ({ name: r[nameKey] ?? r.account_name ?? '—', amount: num(r[amountKey]) }))
    .filter(i => i.amount !== 0);
  return { items, total: items.reduce((s, i) => s + i.amount, 0) };
};

const EMPTY_PL = {
  revenue: { total: 0, items: [] }, cogs: { total: 0, items: [] },
  opex: { total: 0, items: [] }, grossProfit: 0, operatingProfit: 0,
  otherIncome: 0, netProfit: 0, hasData: false,
};

// Source: GET /finance/accounting/profit-loss (GL, company-scoped).
// The chart of accounts only models the `cogs` and `other` sub-types, so there
// is no ledger basis for an interest/tax/depreciation split — the page no
// longer claims EBITDA, Interest Expense or Tax Provision lines it cannot
// derive. Operating Profit and Other Income are what the GL actually gives.
function adaptPL(d) {
  if (!d) return EMPTY_PL;
  const revenue = groupOf((d.revenue_accounts || []).filter(a => a.sub_type !== 'other'), 'account_name', 'net_amount');
  const cogsRows = (d.expense_accounts || []).filter(a => a.sub_type === 'cogs');
  const cogs = groupOf(cogsRows, 'account_name', 'net_amount');
  const opex = groupOf(d.operating_expenses || [], 'account_name', 'net_amount');
  return {
    revenue: { items: revenue.items, total: num(d.total_revenue) || revenue.total },
    cogs:    { items: cogs.items,    total: num(d.cogs)          || cogs.total },
    opex:    { items: opex.items,    total: num(d.total_opex)    || opex.total },
    grossProfit:     num(d.gross_profit),
    operatingProfit: num(d.operating_profit),
    otherIncome:     num(d.other_income),
    netProfit:       num(d.net_profit),
    hasData: (d.revenue_accounts?.length || 0) + (d.expense_accounts?.length || 0) > 0,
  };
}

const EMPTY_BS = {
  assets: { current: { total: 0, items: [] }, fixed: { total: 0, items: [] }, total: 0 },
  liabilities: { current: { total: 0, items: [] }, longterm: { total: 0, items: [] }, total: 0 },
  equity: { total: 0, items: [] }, balanced: true, hasData: false,
};

// Source: GET /finance/accounting/balance-sheet (GL, company-scoped).
function adaptBS(d) {
  if (!d) return EMPTY_BS;
  const cur  = groupOf(d.current_assets, 'name', 'balance');
  const fix  = groupOf(d.fixed_assets, 'name', 'balance');
  const cl   = groupOf(d.current_liabilities, 'name', 'balance');
  const ltl  = groupOf(d.long_term_liabilities, 'name', 'balance');
  const eq   = groupOf(d.equity_accounts, 'name', 'balance');
  const retained = num(d.retained_earnings);
  const equityItems = retained !== 0
    ? [...eq.items, { name: 'Retained Earnings (prior years)', amount: retained }]
    : eq.items;
  return {
    assets: {
      current: { items: cur.items, total: num(d.total_current_assets) },
      fixed:   { items: fix.items, total: num(d.total_fixed_assets) },
      total:   num(d.total_assets),
    },
    liabilities: {
      current:  { items: cl.items,  total: num(d.total_current_liabilities) },
      longterm: { items: ltl.items, total: num(d.total_long_term_liabilities) },
      total:    num(d.total_current_liabilities) + num(d.total_long_term_liabilities),
    },
    equity: { items: equityItems, total: num(d.total_equity) },
    balanced: d.balanced !== false,
    hasData: cur.items.length + fix.items.length + cl.items.length + ltl.items.length + equityItems.length > 0,
  };
}

// Source: GET /finance/reports/cash-flow — posted GL movement on the cash and
// bank accounts. It reports movement per account; it does NOT classify activity
// into operating/investing/financing, so this page no longer presents those
// three sections. A classified statement needs the accounts tagged first.
function adaptCF(d) {
  const rows = (d?.accounts || []).map(a => ({
    code: a.account_code, name: a.account_name,
    cashIn: num(a.cash_in), cashOut: num(a.cash_out), net: num(a.net_movement),
  }));
  return {
    accounts: rows,
    totalIn:  num(d?.total_cash_in),
    totalOut: num(d?.total_cash_out),
    netChange: num(d?.net_change),
    hasData: rows.length > 0,
  };
}

// Source: GET /finance/accounting/trial-balance — closing DR/CR per account.
function adaptTB(d) {
  const byType = d?.accounts_by_type || {};
  const rows = Object.values(byType).flat().map(a => ({
    code: a.account_code, account: a.account_name, type: a.account_type,
    debit: num(a.closing_dr), credit: num(a.closing_cr),
  })).filter(r => r.debit !== 0 || r.credit !== 0);
  rows.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  return {
    rows,
    debitTotal:  num(d?.grand_total_closing_debit),
    creditTotal: num(d?.grand_total_closing_credit),
    balanced: d?.balanced !== false,
    hasData: rows.length > 0,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function FinancialReports() {
  const { fyParams } = useFY();
  const fyMountRef = useRef(true);
  const [activeTab,  setActiveTab]  = useState('pl');
  const [loading,    setLoading]    = useState(false);
  const [data,       setData]       = useState({});
  const [period,     setPeriod]     = useState('month'); // month|quarter|year|custom
  const [dateRange,  setDateRange]  = useState(() => {
    // Default to prior complete month
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last  = new Date(now.getFullYear(), now.getMonth(), 0);
    return {
      start: first.toISOString().split('T')[0],
      end:   last.toISOString().split('T')[0],
    };
  });
  const [compareMode, setCompareMode] = useState(false);
  const [apAgingLive, setApAgingLive] = useState(null);
  const [arAgingLive, setArAgingLive] = useState(null);

  // P&L, balance sheet and trial balance come from the Accounting Engine
  // (/finance/accounting/*): those handlers are company-scoped and read the
  // posted GL. /finance/reports/* returns a flat, unscoped shape this page
  // could not consume, which is what silently triggered the specimen figures.
  const load = useCallback(async () => {
    setLoading(true);
    const [pl, bs, cf, tb] = await Promise.allSettled([
      api.get('/finance/accounting/profit-loss',   { params: { period_from: dateRange.start, period_to: dateRange.end } }),
      api.get('/finance/accounting/balance-sheet', { params: { as_of_date: dateRange.end } }),
      api.get('/finance/reports/cash-flow',        { params: { start_date: dateRange.start, end_date: dateRange.end } }),
      api.get('/finance/accounting/trial-balance', { params: { date_from: dateRange.start, date_to: dateRange.end } }),
    ]);
    // A failed request is reported, not silently rendered as zero.
    const errOf = (r) => r.status === 'rejected'
      ? (r.reason?.response?.data?.error || r.reason?.message || 'Request failed')
      : null;
    setData({
      pl: pl.status==='fulfilled' ? pl.value.data : null,
      bs: bs.status==='fulfilled' ? bs.value.data : null,
      cf: cf.status==='fulfilled' ? cf.value.data : null,
      tb: tb.status==='fulfilled' ? tb.value.data : null,
      errors: { pl: errOf(pl), bs: errOf(bs), cf: errOf(cf), tb: errOf(tb) },
    });
    setLoading(false);
  }, [dateRange]);

  useEffect(() => { load(); }, [load]);

  // When the global Financial Year changes, snap the report period to that FY.
  // Skip the very first render so the default "prior month" view is preserved.
  useEffect(() => {
    if (fyMountRef.current) { fyMountRef.current = false; return; }
    setPeriod('year');
    setDateRange({ start: fyParams.fyStart, end: fyParams.fyEnd });
  }, [fyParams.fyStart, fyParams.fyEnd]);

  useEffect(() => {
    if (activeTab === 'ap' && !apAgingLive) {
      api.get('/finance/supplier-outstanding', { params: { as_of_date: dateRange.end } })
        .then(r => {
          const rows = r.data?.rows ?? [];
          setApAgingLive(rows.map(row => ({
            party:  row.supplier_name ?? 'Unknown',
            current: +row.not_yet_due || 0,
            d30:     +row.due_1_30    || 0,
            d60:     +row.due_31_60   || 0,
            d90:     +row.due_61_90   || 0,
            over90:  +row.due_90plus  || 0,
          })));
        })
        .catch(() => {});
    }
    if (activeTab === 'ar' && !arAgingLive) {
      api.get('/finance/customer-outstanding', { params: { as_of_date: dateRange.end } })
        .then(r => {
          const rows = r.data?.rows ?? [];
          const map = {};
          rows.forEach(row => {
            const k = row.customer_name ?? 'Unknown';
            if (!map[k]) map[k] = { party: k, current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
            const b   = +row.balance || 0;
            const bkt = row.ageing_bucket;
            if (bkt === 'current') map[k].current += b;
            else if (bkt === '1-30')  map[k].d30    += b;
            else if (bkt === '31-60') map[k].d60    += b;
            else if (bkt === '61-90') map[k].d90    += b;
            else                      map[k].over90 += b;
          });
          setArAgingLive(Object.values(map));
        })
        .catch(() => {});
    }
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePeriodChange = (p) => {
    setPeriod(p);
    const now = new Date();
    let start, end;
    if (p === 'month') {
      // Prior complete month
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last  = new Date(now.getFullYear(), now.getMonth(), 0);
      start = first.toISOString().split('T')[0];
      end   = last.toISOString().split('T')[0];
    } else if (p === 'quarter') {
      // Current India FY quarter (FY starts April)
      const fyOffset = now.getMonth() >= 3 ? now.getMonth() - 3 : now.getMonth() + 9;
      const qtr      = Math.floor(fyOffset / 3);
      const fyYear   = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      start = new Date(fyYear, 3 + qtr * 3, 1).toISOString().split('T')[0];
      end   = now.toISOString().split('T')[0];
    } else if (p === 'year') {
      // India FY: April 1 – March 31
      const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      start = `${fyYear}-04-01`;
      end   = now.toISOString().split('T')[0];
    } else { return; }
    setDateRange({ start, end });
  };

  // ── Live report data ────────────────────────────────────────────────────
  // Every figure below comes from the API response. There is no specimen
  // fallback: when a report has no data or its request failed, the UI says so.
  const pl = adaptPL(data.pl);
  const bs = adaptBS(data.bs);
  const cf = adaptCF(data.cf);
  const tb = adaptTB(data.tb);
  const trialBalance  = tb.rows;
  const tbDebitTotal  = tb.debitTotal;
  const tbCreditTotal = tb.creditTotal;

  const arAging = arAgingLive ?? [];
  const apAging = apAgingLive ?? [];

  const errors   = data.errors || {};
  const tabError = errors[activeTab] || null;
  const tabHasData = {
    pl: pl.hasData, bs: bs.hasData, cf: cf.hasData, tb: tb.hasData,
    ar: arAging.length > 0, ap: apAging.length > 0,
  }[activeTab];

  const plChartData = [
    { name:'Revenue',    value: pl.revenue.total, fill:'#6366f1' },
    { name:'COGS',       value: pl.cogs.total,    fill:'#ef4444' },
    { name:'OpEx',       value: pl.opex.total,    fill:'#7c5cf0' },
    { name:'Net Profit', value: pl.netProfit,     fill:'#10b981' },
  ];

  const cfChartData = cf.accounts.map(a => ({
    name: a.name, value: a.net, fill: a.net >= 0 ? '#10b981' : '#ef4444',
  }));

  // A ratio with no denominator is N/A, never a hardcoded reassuring number.
  const ratio = (n, d, digits = 2) => (d > 0 ? (n / d).toFixed(digits) : null);
  const pctOf = (n, d, digits = 1) => (d > 0 ? ((n / d) * 100).toFixed(digits) : null);
  const profitMargin = pctOf(pl.netProfit,   pl.revenue.total);
  const grossMargin  = pctOf(pl.grossProfit, pl.revenue.total);
  const currentRatio = ratio(bs.assets.current.total, bs.liabilities.current.total);
  const debtToEquity = ratio(bs.liabilities.total,    bs.equity.total);

  return (
    <PageShell dock={
      <PageHero
        icon={BarChart3}
        eyebrow="Finance"
        title="Financial Reports"
      />
    }>

      {/* Header */}
      <div className="rpt-header">
        <div>

          <p className="rpt-sub">
            {new Date(dateRange.start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
            {' — '}
            {new Date(dateRange.end).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
          </p>
        </div>
        <div className="rpt-header-r">
          <FYSelector />
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
            onClick={()=>setCompareMode(c=>!c)}
            title="Period comparison — coming in next release">
            <Filter size={13}/> Compare
          </button>
          <button className="rpt-btn-outline" onClick={() => window.print()}><Printer size={14}/> Print</button>
          <button className="rpt-btn-outline" onClick={() => { const d = buildExportData(activeTab, pl, bs, cf, trialBalance, arAging, apAging); if (d) exportCSV(d.rows, d.name); }}><Download size={14}/> Export CSV</button>
          <button className="rpt-refresh" onClick={load}>
            <RefreshCw size={14}/> Refresh
          </button>
        </div>
      </div>

      {compareMode && (
        <div className="rpt-compare-notice">
          Period comparison is coming soon. Use Custom date range to manually compare two periods.
        </div>
      )}

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
          <IndianRupee size={16} color="#10b981"/>
          <div>
            <p className="rpt-kpi-label">Net Profit</p>
            <p className="rpt-kpi-val">{fmt(pl.netProfit)}</p>
          </div>
        </div>
        <div className="rpt-kpi">
          <BarChart2 size={16} color="#8b5cf6"/>
          <div>
            <p className="rpt-kpi-label">Gross Margin</p>
            <p className="rpt-kpi-val">{grossMargin === null ? <span className="rpt-kpi-na">N/A</span> : `${grossMargin}%`}</p>
          </div>
        </div>
        <div className="rpt-kpi">
          <Activity size={16} color="#3b82f6"/>
          <div>
            <p className="rpt-kpi-label">Net Margin</p>
            <p className="rpt-kpi-val">{profitMargin === null ? <span className="rpt-kpi-na">N/A</span> : `${profitMargin}%`}</p>
          </div>
        </div>
        <div className="rpt-kpi">
          <Scale size={16} color="#7c5cf0"/>
          <div>
            <p className="rpt-kpi-label">Current Ratio</p>
            <p className="rpt-kpi-val">{currentRatio === null ? <span className="rpt-kpi-na">N/A</span> : `${currentRatio}x`}</p>
          </div>
        </div>
        <div className="rpt-kpi">
          <IndianRupee size={16} color="#ef4444"/>
          <div>
            <p className="rpt-kpi-label">Debt / Equity</p>
            <p className="rpt-kpi-val">{debtToEquity === null ? <span className="rpt-kpi-na">N/A</span> : debtToEquity}</p>
          </div>
        </div>
        <div className="rpt-kpi" title={!cf.hasData ? 'No posted movement on any cash or bank account in this period' : 'Net posted movement across cash and bank accounts'}>
          <Activity size={16} color="#10b981"/>
          <div>
            <p className="rpt-kpi-label">Net Cash Movement</p>
            <p className="rpt-kpi-val">
              {cf.hasData ? fmt(cf.netChange) : <span className="rpt-kpi-na">N/A</span>}
            </p>
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

      {/* An unavailable report and an empty one are different facts, and neither
          is "zero". Both are stated instead of being papered over with specimen
          figures — the report is still rendered underneath so the period and
          headings stay visible. */}
      {!loading && tabError && (
        <div className="rpt-state rpt-state-error" role="alert">
          <strong>This report could not be loaded.</strong>
          <span>{tabError}</span>
          <button className="rpt-btn-outline" onClick={load}>
            <RefreshCw size={14}/> Retry
          </button>
        </div>
      )}

      {!loading && !tabError && !tabHasData && (
        <div className="rpt-state rpt-state-empty">
          <strong>No posted transactions in this period.</strong>
          <span>
            Nothing has been posted to the ledger between{' '}
            {new Date(dateRange.start).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'})}
            {' and '}
            {new Date(dateRange.end).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'})}.
            Widen the period, or post entries first.
          </span>
        </div>
      )}

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
                    {grossMargin !== null && (
                      <span className="rpt-margin-badge">{grossMargin}% margin</span>
                    )}
                    <span className="rpt-gp-val">{fmtFull(pl.grossProfit)}</span>
                  </div>
                </div>

                <Section title="Operating Expenses" total={-pl.opex.total} accent="#7c5cf0">
                  {pl.opex.items.map((item,i)=>(
                    <LineRow key={i} label={item.name} value={-item.amount} indent={1} negative/>
                  ))}
                  <LineRow label="Total OpEx" value={-pl.opex.total} bold total negative/>
                </Section>

                {/* EBITDA, Interest Expense and Tax Provision are not shown:
                    the chart of accounts models only the `cogs` and `other`
                    sub-types, so there is no ledger basis for a depreciation,
                    interest or tax split. These are what the GL does give. */}
                <div className="rpt-ebitda">
                  <span>Operating Profit</span>
                  <span>{fmtFull(pl.operatingProfit)}</span>
                </div>

                {pl.otherIncome !== 0 && (
                  <div className="rpt-below-ebitda">
                    <LineRow label="Other Income" value={pl.otherIncome}/>
                  </div>
                )}

                <div className="rpt-net-profit">
                  <div>
                    <span>Net Profit / (Loss)</span>
                    {profitMargin !== null && (
                      <span className="rpt-np-margin">{profitMargin}% net margin</span>
                    )}
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
                  {(() => {
                    // Only metrics this period's ledger actually supports.
                    // 'Revenue Growth (MoM)' used to render a fixed '+18%' and
                    // EBITDA/Tax Rate depended on splits the GL does not model.
                    const opMargin    = pctOf(pl.operatingProfit, pl.revenue.total);
                    const expenseRatio = pctOf(pl.cogs.total + pl.opex.total, pl.revenue.total, 0);
                    return [
                      {label:'Gross Margin',     value: grossMargin,   suffix:'%', good: parseFloat(grossMargin) > 30 },
                      {label:'Net Margin',       value: profitMargin,  suffix:'%', good: parseFloat(profitMargin) > 15 },
                      {label:'Operating Margin', value: opMargin,      suffix:'%', good: parseFloat(opMargin) > 10,
                        tooltip:'Operating Profit ÷ Revenue' },
                      {label:'Expense Ratio',    value: expenseRatio,  suffix:'%', good:false,
                        tooltip:'Total Expenses (COGS + OpEx) as % of Revenue' },
                    ];
                  })().map((m,i)=>(
                    <div key={i} className="rpt-metric-row" title={m.tooltip}>
                      <span>{m.label}</span>
                      <span className={m.value === null ? 'rpt-metric-na' : (m.good ? 'rpt-metric-good' : 'rpt-metric-warn')}>
                        {m.value === null ? 'N/A' : `${m.value}${m.suffix ?? ''}`}
                      </span>
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
                    As of {new Date(dateRange.end).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
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
                    <Section title="Long-term Liabilities" total={bs.liabilities.longterm.total} accent="#7c5cf0">
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
                    {/* The API decides this with a rounding tolerance; an exact
                        JS equality check on floats reported false imbalances. */}
                    <div className={`rpt-bs-balanced ${bs.balanced ? 'balanced' : 'unbalanced'}`}>
                      {bs.balanced
                        ? '✓ Balance sheet is balanced'
                        : `⚠ Balance sheet does not balance — difference ${fmtFull(Math.abs(bs.assets.total - (bs.liabilities.total + bs.equity.total)))}`}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rpt-side">
                <div className="rpt-chart-card">
                  <h4>Asset Composition</h4>
                  {/* Guarded: with no assets these divisions produced NaN%. */}
                  {(() => {
                    const share = (part) => (bs.assets.total > 0 ? (part / bs.assets.total) * 100 : 0);
                    const cur = share(bs.assets.current.total);
                    const fix = share(bs.assets.fixed.total);
                    return (
                      <>
                        <div className="rpt-bs-bar">
                          <div className="rpt-bs-bar-fill" style={{width:`${cur}%`,background:'#3b82f6'}}/>
                          <div className="rpt-bs-bar-fill" style={{width:`${fix}%`,background:'#6366f1'}}/>
                        </div>
                        <div className="rpt-bs-bar-legend">
                          <span><span style={{background:'#3b82f6'}} className="rpt-dot"/>Current {cur.toFixed(0)}%</span>
                          <span><span style={{background:'#6366f1'}} className="rpt-dot"/>Fixed {fix.toFixed(0)}%</span>
                        </div>
                      </>
                    );
                  })()}
                </div>
                <div className="rpt-ratios-card">
                  <h4>Balance Sheet Ratios</h4>
                  {/* Quick Ratio is omitted, not faked: it needs inventory
                      separated from other current assets, which this response
                      does not carry. It previously rendered a fixed '1.8x'. */}
                  {[
                    {label:'Current Ratio',  value: currentRatio, suffix:'x', good: parseFloat(currentRatio) >= 2},
                    {label:'Debt-to-Equity', value: debtToEquity, good: parseFloat(debtToEquity) < 1},
                    {label:'Debt-to-Assets', value: ratio(bs.liabilities.total, bs.assets.total), good:true},
                    {label:'Equity Ratio',   value: pctOf(bs.equity.total, bs.assets.total, 0), suffix:'%', good:true},
                  ].map((m,i)=>(
                    <div key={i} className="rpt-metric-row">
                      <span>{m.label}</span>
                      <span className={m.value === null ? 'rpt-metric-na' : (m.good ? 'rpt-metric-good' : 'rpt-metric-warn')}>
                        {m.value === null ? 'N/A' : `${m.value}${m.suffix ?? ''}`}
                      </span>
                    </div>
                  ))}
                  <div className="rpt-metric-row">
                    <span>Working Capital</span>
                    <span className="rpt-metric-good">
                      {fmt(bs.assets.current.total - bs.liabilities.current.total)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Cash Flow ───────────────────────────────────────── */}
          {activeTab === 'cf' && (
            <div className="rpt-two-col">
              {/* This was headed "Cash Flow Statement — Indirect Method" over
                  operating/investing/financing sections. No endpoint classifies
                  cash movement that way; the specimen numbers underneath it did.
                  What /finance/reports/cash-flow actually returns is posted GL
                  movement per cash and bank account, so that is what is shown,
                  under its real name. A classified statement needs the cash
                  accounts tagged by activity first. */}
              <div className="rpt-report-wrap">
                <div className="rpt-report-hd">
                  <h3>Cash Movement by Account</h3>
                  <span className="rpt-report-period">Posted general ledger</span>
                </div>

                <Section title="Cash &amp; Bank Accounts" total={cf.netChange} accent="#10b981">
                  {cf.accounts.map((a,i)=>(
                    <LineRow key={i} label={`${a.code} · ${a.name}`} value={a.net} indent={1}
                      negative={a.net < 0}/>
                  ))}
                  <LineRow label="Net Movement" value={cf.netChange} bold total/>
                </Section>

                <div className="rpt-cf-opening">
                  <span>Total Cash In</span>
                  <strong>{fmtFull(cf.totalIn)}</strong>
                </div>

                <div className="rpt-cf-closing">
                  <span>Total Cash Out</span>
                  <strong>{fmtFull(cf.totalOut)}</strong>
                </div>

                <div className="rpt-cf-net">
                  <span>Net Change in Cash</span>
                  <span className={cf.netChange >= 0 ? 'rpt-np-pos' : 'rpt-np-neg'}>
                    {cf.netChange >= 0 ? '+' : ''}{fmtFull(cf.netChange)}
                  </span>
                </div>
              </div>

              <div className="rpt-side">
                <div className="rpt-chart-card">
                  <h4>Net Movement by Account</h4>
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
                {/* 'Cash Ratio 1.8x' and 'Cash Coverage 8.4x' were fixed
                    strings — they never varied with the data. Removed rather
                    than re-derived: both need current liabilities, which this
                    endpoint does not return. */}
                <div className="rpt-ratios-card">
                  <h4>Cash Summary</h4>
                  {[
                    {label:'Total Cash In',  value: fmt(cf.totalIn),   good: true },
                    {label:'Total Cash Out', value: fmt(cf.totalOut),  good: true },
                    {label:'Net Movement',   value: fmt(cf.netChange), good: cf.netChange >= 0 },
                    {label:'Accounts',       value: String(cf.accounts.length), good: true },
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
                  As of {new Date(dateRange.end).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
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
                  {/* `balanced` comes from the API, which compares with a
                      rounding tolerance rather than exact float equality. */}
                  <tr className={`rpt-tb-balance ${tb.balanced ? 'balanced' : 'unbalanced'}`}>
                    <td colSpan={4}>
                      {tb.balanced
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
                  As of {new Date(dateRange.end).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                </span>
              </div>
              <div className="rpt-aging-summary">
                {[
                  {label:'Current (0–30d)', value: arAging.reduce((s,r)=>s+r.current,0), color:'#10b981'},
                  {label:'31–60 days',       value: arAging.reduce((s,r)=>s+r.d30,0),    color:'#7c5cf0'},
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
                  As of {new Date(dateRange.end).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                </span>
              </div>
              <div className="rpt-aging-summary">
                {[
                  {label:'Current (0–30d)', value: apAging.reduce((s,r)=>s+r.current,0), color:'#10b981'},
                  {label:'31–60 days',       value: apAging.reduce((s,r)=>s+r.d30,0),    color:'#7c5cf0'},
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
    </PageShell>
  );
}