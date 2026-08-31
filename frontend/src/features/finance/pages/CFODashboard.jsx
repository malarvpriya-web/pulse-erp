/* CFO Dashboard — the finance module's executive cockpit.
 *
 * DESIGN (2026-08-26) — this page is now on the app-wide Pulse hero language
 * (manual §116/§120), the same stack ExecutiveDashboard and AdminDashboard use:
 * `PageShell` + `PageHero` + the canonical `<DashboardFilterBar>` in the frozen
 * dock, then a `StatBand` of white metric cards, then a `DashCard` grid. It
 * previously kept a bespoke `Card`/`Modal` pair and a six-up strip of coloured
 * gradient tiles — exactly the drift the hero rollout removed from the other
 * 411 pages.
 *
 * ⚠ WHY IT WAS REBUILT, not just restyled. The 2026-08-20 hero codemod replaced
 * this page's root `<div className="cfo-root">` with `<PageShell>` and did not
 * carry the class across. `CFODashboard.css` scopes EVERY rule under
 * `.cfo-root` on purpose (see that file's header), so dropping the class
 * orphaned the entire 280-line sheet: measured at 1366×768 the page had no
 * grid, no cards, no KPI tiles, and scrolled 1920px — every figure rendered as
 * bare text on the page background. An esbuild/vitest run cannot see this;
 * only a rendered screenshot can. `PageShell className="cfo-root"` below is the
 * load-bearing line — do not remove it.
 *
 * ⚠ The period buttons used to be five `.plh-cta`s in the hero's `actions` slot,
 * which wraps: the hero grew a second row and clipped the band. A period/filter
 * control belongs in its own dock child, never in `actions`.
 *
 * FILTER (2026-08-26) — this page is now on the canonical dashboard filter
 * contract (manual §107): `useDashboardFilters` + `<DashboardFilterBar>` on the
 * client, `resolveRange()` on the server. It used to carry a hand-rolled
 * YTD/Q1–Q4 strip in its own vocabulary, which is why it sat on §107's
 * "still hand-rolled" list.
 *
 * ⚠⚠ The filter does NOT own every number on this page, and the bar says so.
 * Only revenue, spend, the GL P&L and the ratios/gauges derived from them are
 * period activity. Cash, AR, AP and every alert are point-in-time balances and
 * backlog — a narrow period must never hide work awaiting action — and the
 * three trend charts carry their own fixed windows. The endpoint ships that
 * split as `period_scoped` and the window as `period_label`; label cards from
 * the RESPONSE, never from the preset that was sent (manual §121).
 */
import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, BarChart, Bar, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell, PieChart, Pie, ReferenceLine,
} from 'recharts';
import {
  TrendingUp, TrendingDown, IndianRupee, AlertTriangle, CheckCircle,
  RefreshCw, ArrowUpRight, ArrowDownRight, Wallet, Flame,
  BarChart2, Activity, Info, LayoutDashboard, Scale, PieChart as PieIcon,
  LineChart as LineIcon, Bell, Landmark,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmt } from '../financeUtils';
import { useFY } from '@/context/FYContext';
import DashCard from '@/components/dashboard/DashCard';
import { DashboardFilterBar, PageHero, PageShell, StatBand, Stat } from '@/components/pulse-ui';
import useDashboardFilters from '@/hooks/useDashboardFilters';
import './CFODashboard.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const P = '#6B3FDB';
const COLORS = ['#6B3FDB', '#10b981', '#7c5cf0', '#6366f1', '#8b5cf6', '#a78bfa', '#4338ca', '#c084fc'];

/** Headline money — Cr / L, signed. Scale off the MAGNITUDE: comparing a signed
 *  value against 1e7/1e5 leaves every negative unabbreviated, which is how
 *  `₹-3,73,100` ended up in a chip next to `₹2.42 L` (see `money` below). */
const fmtCr = (n) => {
  const v = parseFloat(n || 0);
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  return a >= 10000000 ? `${sign}₹${(a / 10000000).toFixed(2)} Cr`
       : a >= 100000   ? `${sign}₹${(a / 100000).toFixed(2)} L`
       : `${sign}₹${a.toLocaleString('en-IN')}`;
};

const pct = (a, b) => b ? ((a / b) * 100).toFixed(1) : '0.0';

/**
 * Signed money, abbreviated.
 *
 * `financeUtils.fmt` compares against 1e7/1e5/1e3 and so never abbreviates a
 * NEGATIVE amount — it returned the raw `₹-373100`. That is invisible on a page
 * of positive figures and painfully visible on this one, where outflow, net cash
 * flow and three waterfall columns are all negative: the chips rendered
 * `₹-373100` beside `₹4.7L` and the Y axis printed `₹-500000` beside `₹5.0L`.
 * Abbreviate the MAGNITUDE and carry the sign separately.
 */
const money = (n) => {
  const v = parseFloat(n || 0);
  return `${v < 0 ? '-' : ''}${fmt(Math.abs(v))}`;
};

/** Signed change chip — the house `.exd-delta` shape, scoped to this page. */
const Delta = ({ value, invert = false }) => {
  if (value == null || !isFinite(value)) return null;
  const good = invert ? value <= 0 : value >= 0;
  const flat = Math.abs(value) < 0.05;
  return (
    <span className={`cfo-delta ${flat ? 'is-flat' : good ? 'is-good' : 'is-bad'}`}>
      {flat ? '—' : good ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {Math.abs(value).toFixed(1)}%
    </span>
  );
};

/** Empty state that fills its card body rather than padding out a fixed box. */
const Empty = ({ icon: Icon = Info, text }) => (
  <div className="cfo-empty">
    <Icon size={18} />
    <p>{text}</p>
  </div>
);

// ── Gauge component ───────────────────────────────────────────────────────────
const Gauge = ({ value, label, color }) => {
  const pctVal = Math.min(Math.max(value, 0), 100);
  const r = 34, cx = 44, cy = 44;
  const circumference = Math.PI * r;
  const dash = (pctVal / 100) * circumference;
  return (
    <div className="cfo-gauge">
      <svg viewBox="0 0 88 54" role="img" aria-label={`${label} ${pctVal.toFixed(0)} percent`}>
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none" stroke="#f1f1f5" strokeWidth="8" strokeLinecap="round" />
        {/* Only drawn above zero: a round line-cap on a zero-length dash still
            paints a dot, so a 0% gauge rendered a floating blob that read as a
            small non-zero reading. */}
        {pctVal > 0 && (
          <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`} />
        )}
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize="14" fontWeight="700" fill="#0f172a">
          {pctVal.toFixed(0)}%
        </text>
        <text x={cx} y={cy + 7} textAnchor="middle" fontSize="8" fill="#94a3b8">{label}</text>
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
        const color = b.type === 'total' ? P
                    : b.value >= 0       ? '#10b981' : '#ef4444';
        return (
          <div key={i} className="cfo-wf-col">
            <div className="cfo-wf-bar-wrap">
              <div className="cfo-wf-spacer" style={{ height: `${100 - bottomPct - heightPct}%` }} />
              <div className="cfo-wf-bar" style={{ height: `${heightPct}%`, background: color }} />
              <div className="cfo-wf-base" style={{ height: `${bottomPct}%` }} />
            </div>
            <div className="cfo-wf-val" style={{ color }}>
              {b.value >= 0 ? '+' : ''}{money(b.value)}
            </div>
            <div className="cfo-wf-label">{b.label}</div>
          </div>
        );
      })}
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────
// Keys here MUST match the `action` strings /dashboard/cfo emits. They did not:
// the backend sent 'Follow Up' / 'Review' / 'View' while this map was keyed on
// 'View Invoices' / 'Reconcile' / …, so every lookup returned undefined and every
// alert button on this page was silently inert. Both sides now use these keys, and
// tests/suites/16-kpi-reconciliation.spec.ts asserts they stay in step.
const ALERT_ACTION_PAGE = {
  'View Invoices':   'InvoicesNew',
  'Manage Expenses': 'Expenses',
  'View Projects':   'ProjectsDashboard',
  'Review Leaves':   'LeaveApprovals',
  'View Inventory':  'InventoryDashboard',
  'View Bills':      'SupplierBills',
  'Process Payments':'PaymentBatch',
  'Review Budget':   'BudgetManagement',
  'View Reports':    'FinanceReports',
};

export default function CFODashboard({ setPage }) {
  const { fyParams } = useFY();
  const [loading,  setLoading]  = useState(false);
  const [data,     setData]     = useState({});
  const [lastSync, setLastSync] = useState(new Date());
  const [loadError, setLoadError] = useState(null);

  // The page filter. `params` is memoised on its own values, so it is safe as
  // the `load` dependency — its identity only changes when a filter changes.
  const filters = useDashboardFilters({ defaultPeriod: 'fytd', storageKey: 'cfo-dashboard' });
  const { params } = filters;

  // Re-fetches whenever a filter or the selected Financial Year changes.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fyYear = parseInt(fyParams.fy.replace(/\D/g, '').slice(0, 4), 10);
      const [cfoRes, revRes] = await Promise.allSettled([
        api.get('/dashboard/cfo', { params }),
        // Keeps the legacy `fy` vocabulary on purpose: /dashboard/revenue is
        // shared with CEO Intelligence and §107 preserved its 6m|cy|fy presets
        // rather than migrating them. This series is the FY revenue history
        // behind the headline chart, and the page filter must not move it —
        // the card names its own window in the subtitle.
        api.get(`/dashboard/revenue?period=fy&year=${fyYear + 1}`),
      ]);
      setData({
        cfo : cfoRes.status === 'fulfilled' ? cfoRes.value.data : null,
        rev : revRes.status === 'fulfilled' ? revRes.value.data : null,
      });
      // A failed /dashboard/cfo used to render as a dashboard full of zeros —
      // indistinguishable from a company with no activity. Named explicitly now.
      setLoadError(
        cfoRes.status === 'rejected'
          ? (cfoRes.reason?.response?.status === 403
              ? 'You do not have finance:view permission — this dashboard needs it.'
              : `Could not load financial data (${cfoRes.reason?.response?.status || 'network error'}). Figures below are not current.`)
          : null
      );
      setLastSync(new Date());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [params, fyParams.fy]);

  useEffect(() => { load(); }, [load]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const cfo  = data.cfo  || {};
  const rev  = data.rev;
  const kpis = cfo.kpis  || {};
  const ratiosApi = cfo.ratios  || {};
  const gaugesApi = cfo.gauges  || {};

  const acct        = cfo.accounting  || {};
  // `glPosted` is false when no journal entries exist for the period. Accrual
  // KPIs then render "Not posted" instead of a number, because a zero here would
  // be indistinguishable from a genuine break-even.
  const glPosted    = acct.glPosted === true;
  /**
   * Why the accrual figures are missing, in the backend's words.
   *
   * The cards used to hardcode "No journal entries for this period". That is one
   * of two very different situations, and the wrong one here: this company's
   * ledger holds nine posted entries, all carrying a NULL company_id, so a
   * company-scoped CFO correctly sees none of them. Telling the accountant the
   * books are empty sends them to post entries that already exist; telling them
   * the entries are unattributed sends them to the actual problem. The endpoint
   * distinguishes the two in `accounting.basis`, so use it rather than guessing.
   */
  const glUnavailableReason = acct.basis || 'No journal entries for this period';
  /* ⚠ `??`, not `||`. `rev?.ytd` is the FULL FINANCIAL YEAR from
   * /dashboard/revenue and exists only as a fallback for when /dashboard/cfo
   * itself failed. With `||`, a period that legitimately earned nothing made
   * `kpis.revenue` falsy and silently substituted the whole-FY figure —
   * reproduced at `period=last90`, where the server returned 0 and the page
   * displayed ₹2.42 L labelled "last 90 days", then propagated it into the
   * chips, the P&L waterfall and every margin. Harmless while the only window
   * was FY-to-date; a confidently wrong number the moment the filter could
   * select an empty one. */
  const revenue     = kpis.revenue ?? rev?.ytd ?? 0;
  const opex        = kpis.opex        || 0;
  const grossProfit = kpis.grossProfit || 0;
  const netProfit   = kpis.netProfit   ?? null;
  const ebitda      = kpis.ebitda      ?? null;
  const cashBalance = kpis.cashBalance || 0;
  const ar          = kpis.ar          || 0;
  const ap          = kpis.ap          || 0;
  const dso         = kpis.dso         || 0;
  const dpo         = kpis.dpo         || 0;
  const monthlyBurn = kpis.monthlyBurn || 0;
  const runway      = kpis.runway;

  const thisMonth = rev?.thisMonth || 0;
  const lastMonth = rev?.lastMonth || 0;
  const revTrend  = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth * 100) : null;

  // Monthly revenue.
  //
  // This chart used to carry three series, two of which were invented from the
  // third: `target = revenue * 1.1` and `profit = revenue * 0.28`. Neither
  // multiplier came from anywhere, and both were drawn beside real revenue with
  // no visual distinction, on the CFO's headline chart. There is no revenue
  // target table in this schema and monthly profit is not derivable from the
  // invoice ledger alone, so both series are gone rather than approximated. The
  // chart now plots what is actually known — revenue per month — and the P&L
  // Bridge beside it carries profitability, sourced from the posted ledger.
  const revenueChart = (() => {
    if (rev && (rev.months || []).length > 0) {
      return rev.months.map((m, i) => ({ month: m, revenue: rev.values?.[i] || 0 }));
    }
    return (cfo.historicalRevenue || []).map(r => ({ month: r.month, revenue: r.revenue }));
  })();

  const cashFlowMonthly = cfo.cashFlowMonthly || [];
  const forecastData    = cfo.forecastData    || [];
  const forecastMeta    = cfo.forecastMeta    || {};
  const expChart        = cfo.expByCategory   || [];
  const alertsData      = cfo.alerts          || [];
  const highAlerts      = alertsData.filter(a => a.level === 'high').length;

  /* The window the SERVER actually used, in its words. Labelling a card from
     the preset the client sent is how a filter change silently relabels a
     number it did not move — `all` resolves to the first day of the book, and
     `custom` to whatever survived validation, neither of which the client
     knows. Falls back to the preset only before the first response lands. */
  const periodLabel = cfo.period_label || filters.period;

  // P&L waterfall. EBITDA and Net Profit are only shown once the general ledger
  // has entries posted for the period — see `accounting.glPosted`. They used to
  // be JS approximations (grossProfit * 0.78, then + opex * 0.05).
  const plWaterfall = [
    { label: 'Revenue',    value: revenue,                    type: 'positive' },
    { label: 'OpEx',       value: -(revenue - grossProfit),   type: 'negative' },
    { label: 'Gross P',    value: grossProfit,                type: 'total'    },
    ...(glPosted ? [
      { label: 'EBITDA',     value: ebitda,     type: 'total' },
      { label: 'Net Profit', value: netProfit,  type: 'total' },
    ] : []),
  ];

  /* A GL margin is null for two different reasons, and they must not share a
   * label. Surfaced by the filter: pick a window holding a posted entry but no
   * revenue (e.g. 2026-04-01 → 2026-06-30) and the Net Profit KPI reads
   * "₹0 · 0.0% margin · posted ledger" while the ratio tile beside it read
   * "Not posted" — the same books described two contradictory ways on one
   * screen. `glPosted` distinguishes them: no entries at all vs. entries with
   * nothing to divide by. Neither ever gets a status colour (manual §111). */
  const marginUnavailable = glPosted ? 'No revenue' : 'Not posted';
  const marginDesc = glPosted
    ? 'From posted ledger — no revenue in this window to divide by'
    : 'No journal entries posted';

  // Financial ratios: use real API values where possible
  const ratiosData = [
    {
      label: 'Current Ratio',
      value: ratiosApi.currentRatio != null ? `${ratiosApi.currentRatio}x` : 'N/A',
      bench: '2.0x',
      status: ratiosApi.currentRatio != null ? (ratiosApi.currentRatio >= 2 ? 'good' : ratiosApi.currentRatio >= 1 ? 'warn' : 'bad') : 'na',
      desc: 'AR / AP',
    },
    {
      label: 'Quick Ratio',
      value: ratiosApi.quickRatio != null ? `${ratiosApi.quickRatio}x` : 'N/A',
      bench: '1.0x',
      status: ratiosApi.quickRatio != null ? (ratiosApi.quickRatio >= 1 ? 'good' : 'warn') : 'na',
      desc: '(Cash + AR) / AP',
    },
    {
      label: 'Gross Margin',
      value: ratiosApi.grossMargin != null ? `${ratiosApi.grossMargin}%` : 'N/A',
      bench: '30%',
      status: ratiosApi.grossMargin == null ? 'na' : ratiosApi.grossMargin >= 30 ? 'good' : 'warn',
      desc: 'Gross profit margin',
    },
    {
      label: 'Net Margin',
      value: ratiosApi.netMargin != null ? `${ratiosApi.netMargin}%` : marginUnavailable,
      bench: '15%',
      status: ratiosApi.netMargin == null ? 'na' : ratiosApi.netMargin >= 15 ? 'good' : 'warn',
      desc: ratiosApi.netMargin != null ? 'From posted ledger' : marginDesc,
    },
    {
      label: 'EBITDA Margin',
      value: ratiosApi.ebitdaMargin != null ? `${ratiosApi.ebitdaMargin}%` : marginUnavailable,
      bench: '20%',
      status: ratiosApi.ebitdaMargin == null ? 'na' : ratiosApi.ebitdaMargin >= 20 ? 'good' : 'warn',
      desc: ratiosApi.ebitdaMargin != null ? 'From posted ledger' : marginDesc,
    },
    {
      label: 'A/R Days',
      value: dso > 0 ? `${dso}d` : 'N/A',
      bench: '<45d',
      status: dso <= 0 ? 'na' : dso <= 45 ? 'good' : 'warn',
      desc: 'Collection cycle',
    },
    {
      label: 'A/P Days',
      value: dpo > 0 && dpo <= 365 ? `${dpo}d` : 'N/A',
      bench: '<60d',
      status: dpo <= 0 || dpo > 365 ? 'na' : dpo <= 60 ? 'good' : 'warn',
      desc: 'Payment cycle',
    },
  ];

  // These five used to sit in the grid above carrying `status: 'good'` with a
  // value of '—', so they rendered as green check-marks — the UI asserted a
  // healthy ratio for a number that was never computed. They stay named and
  // visible, but as a footnote rather than as five tiles: they hold no figure,
  // and spending five of twelve tiles on them is what pushed this card past the
  // height it has. Hovering a chip says what each one needs. They are never
  // given a status colour or an icon, so an unmeasured ratio can still never
  // read as a passing one.
  const untrackedRatios = [
    { label: 'Debt/Equity',       desc: 'Requires a balance sheet · bench <1.0' },
    { label: 'ROE',               desc: 'Requires equity accounts · bench 15%' },
    { label: 'ROA',               desc: 'Requires a fixed-asset register · bench 8%' },
    { label: 'Inventory Turns',   desc: 'Requires COGS postings · bench 4.0x' },
    { label: 'Interest Coverage', desc: 'Requires a debt register · bench >3x' },
  ];

  // Total operating spend behind the Cost Structure card (donut + ranked list).
  const expTotal = expChart.reduce((s, e) => s + e.value, 0);
  const expMax   = Math.max(...expChart.map(e => e.value), 1);
  // The in-card legend is capped so a company with a long chart of accounts
  // cannot push the card past its row; Expand shows every category.
  const EXP_VISIBLE = 5;

  // Gauge values from API (computed as meaningful %)
  const collectionsPct = gaugesApi.collectionsPct ?? 0;
  const cashRatioPct   = gaugesApi.cashRatioPct   ?? 0;
  const liquidityPct   = gaugesApi.liquidityPct   ?? 0;

  const workingCapital = ar - ap;
  const netMarginVal   = ratiosApi.netMargin;

  // ── Reusable chart renderers ─────────────────────────────────────────────
  // In-card charts take height="100%" and fill whatever the fit grid hands
  // them; the modal copies pass a fixed pixel height.
  const RevenueChart = ({ height = '100%' }) => (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={revenueChart} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="cfoRevGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={P} stopOpacity={0.22} />
            <stop offset="95%" stopColor={P} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false} axisLine={{ stroke: '#eceaf4' }} />
        <YAxis tickFormatter={money} tick={{ fontSize: 10, fill: '#9ca3af' }} tickLine={false} axisLine={false} width={54} />
        <Tooltip formatter={v => [money(v), 'Revenue']} />
        {/* An <Area> needs two points to draw anything: a financial year one
            month old plotted as a lone dot on an empty grid, which reads as a
            broken chart rather than as a young FY. The series is NOT swapped for
            the trailing-9-month `historicalRevenue` to pad it out — that is a
            different window, and a wrong window renders as a plausible chart
            rather than a visible error (manual §121.5). One month is drawn as
            one bar instead, and the subtitle names the window. */}
        {revenueChart.length < 2
          ? <Bar dataKey="revenue" fill={P} name="Revenue" radius={[4, 4, 0, 0]} maxBarSize={64} />
          : <Area type="monotone" dataKey="revenue" stroke={P} strokeWidth={2.5}
              fill="url(#cfoRevGrad)" name="Revenue"
              dot={{ r: 3, fill: P, strokeWidth: 0 }}
              activeDot={{ r: 5, fill: P, stroke: '#fff', strokeWidth: 2 }} />}
        <ReferenceLine y={0} stroke="#eceaf4" />
      </ComposedChart>
    </ResponsiveContainer>
  );

  // `compact` is the in-card rendering: the legend costs ~26px of a band that is
  // only ~160px tall at 1366×768, and the two series are already named by the
  // inflow/outflow chips above the chart. The expanded modal keeps it.
  const CashFlowChart = ({ height = '100%', compact = false }) => {
    if (!cashFlowMonthly.length) {
      return <Empty icon={BarChart2} text="No cash flow data for this period" />;
    }
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={cashFlowMonthly} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: compact ? 10 : 12, fill: '#9ca3af' }} tickLine={false} axisLine={{ stroke: '#eceaf4' }} />
          <YAxis tickFormatter={money} tick={{ fontSize: compact ? 10 : 11, fill: '#9ca3af' }}
            tickLine={false} axisLine={false} width={compact ? 50 : 62} />
          <Tooltip formatter={(v, n) => [money(v), n]} />
          {!compact && <Legend wrapperStyle={{ fontSize: 12 }} />}
          <ReferenceLine y={0} stroke="#eceaf4" />
          <Bar dataKey="operating" fill="#10b981" name="Operating CF" radius={[3, 3, 0, 0]} />
          <Bar dataKey="net"       fill={P}       name="Net CF"       radius={[3, 3, 0, 0]} opacity={0.55} />
        </BarChart>
      </ResponsiveContainer>
    );
  };

  const ForecastChart = ({ height = '100%', compact = false }) => (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={forecastData} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="cfoOptGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={P} stopOpacity={0.14} />
            <stop offset="95%" stopColor={P} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: compact ? 10 : 12, fill: '#9ca3af' }} tickLine={false} axisLine={{ stroke: '#eceaf4' }} />
        <YAxis tickFormatter={money} tick={{ fontSize: compact ? 10 : 11, fill: '#9ca3af' }}
          tickLine={false} axisLine={false} width={compact ? 50 : 62} />
        <Tooltip formatter={(v, n) => [money(v), n]} />
        {!compact && <Legend wrapperStyle={{ fontSize: 12 }} />}
        <Area type="monotone" dataKey="optimistic"   stroke={P}         fill="url(#cfoOptGrad)" strokeWidth={1.5} name="Optimistic" />
        <Area type="monotone" dataKey="base"         stroke="#10b981"   fill="none"             strokeWidth={2.5} name="Base Case" />
        <Area type="monotone" dataKey="conservative" stroke="#7c5cf0"   fill="none"             strokeWidth={1.5} strokeDasharray="5 3" name="Conservative" />
      </AreaChart>
    </ResponsiveContainer>
  );

  const CostLegend = ({ rows }) => (
    <div className="cfo-cost-legend">
      {rows.map((e, i) => (
        <div key={i} className="cfo-cost-item">
          <div className="cfo-cost-row">
            <span className="cfo-cost-dot" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="cfo-cost-name" title={e.name}>{e.name}</span>
            <span className="cfo-cost-amt">{money(e.value)}</span>
            <span className="cfo-cost-pct">{pct(e.value, expTotal)}%</span>
          </div>
          <div className="cfo-cost-track">
            <div className="cfo-cost-bar"
              style={{ width: `${(e.value / expMax) * 100}%`, background: COLORS[i % COLORS.length] }} />
          </div>
        </div>
      ))}
    </div>
  );

  const alertLevelIcon = (level) => {
    if (level === 'high' || level === 'medium') return <AlertTriangle size={13} />;
    if (level === 'info') return <Info size={13} />;
    return <CheckCircle size={13} />;
  };

  // ── Stat band ────────────────────────────────────────────────────────────
  // The six numbers this page exists for, in one row of the app's standard
  // white metric cards. This replaces a bespoke strip of six coloured gradient
  // tiles that existed nowhere else in the product.
  const stats = [
    {
      key: 'revenue', icon: IndianRupee, tone: 'primary', label: 'Revenue',
      value: fmtCr(revenue), trend: revTrend != null ? Number(revTrend.toFixed(1)) : null,
      sub: revTrend != null ? `${periodLabel} · vs last month` : periodLabel,
      page: 'FinanceDashboardNew',
    },
    {
      key: 'profit', icon: Wallet,
      tone: netProfit == null ? 'neutral' : netProfit >= 0 ? 'success' : 'danger',
      label: 'Net Profit',
      value: netProfit == null ? 'Not posted' : fmtCr(netProfit),
      warn: netProfit != null && netProfit < 0,
      sub: netProfit == null
        ? glUnavailableReason
        : (acct.glRevenue > 0
            ? `${pct(netProfit, acct.glRevenue)}% margin · posted ledger`
            : 'posted ledger · no revenue to margin against'),
      page: 'FinancialStatements',
    },
    {
      key: 'ebitda', icon: BarChart2, tone: ebitda == null ? 'neutral' : 'plum',
      label: 'EBITDA',
      value: ebitda == null ? 'Not posted' : fmtCr(ebitda),
      sub: ebitda == null
        ? glUnavailableReason
        : (acct.glRevenue > 0
            ? `${pct(ebitda, acct.glRevenue)}% margin · posted ledger`
            : 'posted ledger · no revenue to margin against'),
      page: 'FinancialStatements',
    },
    {
      key: 'cash', icon: Landmark, tone: 'info', label: 'Cash & Equivalents',
      value: fmtCr(cashBalance),
      // Point-in-time: receipts less payments to date, not period activity.
      sub: `Live · AP ${fmtCr(ap)}`,
      page: 'BankAccounts',
    },
    {
      key: 'ar', icon: Activity, tone: 'lavender', label: 'Accounts Receivable',
      value: fmtCr(ar),
      // The balance is live; DSO is the rate over the filtered window.
      sub: dso > 0 ? `Live · ${dso}d DSO` : 'Live · DSO N/A',
      page: 'CustomerOutstanding',
    },
    {
      key: 'burn', icon: Flame, tone: monthlyBurn > 0 ? 'danger' : 'neutral',
      label: 'Monthly Burn Rate',
      value: monthlyBurn > 0 ? fmtCr(monthlyBurn) : '—',
      sub: runway != null ? `Runway ${runway} mo` : 'Runway: N/A',
      page: 'Expenses',
    },
  ];

  // ── Frozen dock: hero + period strip + (only on failure) the error banner ──
  const chrome = (
    <>
      <PageHero
        icon={LayoutDashboard}
        eyebrow="Finance"
        title="CFO Dashboard"
        subtitle="Executive financial cockpit — revenue, margin, cash and working capital"
        meta={[
          { value: fmtCr(revenue), label: `revenue · ${periodLabel.toLowerCase()}` },
          ...(netMarginVal != null
            ? [{ value: `${netMarginVal}%`, label: 'net margin', tone: netMarginVal >= 15 ? 'good' : netMarginVal >= 0 ? 'warn' : 'bad' }]
            : []),
          { value: fmtCr(workingCapital), label: 'working capital', tone: workingCapital >= 0 ? 'good' : 'bad' },
          { value: highAlerts, label: `high-priority alert${highAlerts === 1 ? '' : 's'}`, tone: highAlerts > 0 ? 'bad' : 'good' },
        ]}
        actions={
          <>
            <span className="plh-pill">
              Updated {lastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <button className="plh-cta" onClick={load} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'plh-spin' : undefined} />
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </>
        }
      />

      {/* The canonical filter bar, as a dock child — NOT in the hero's `actions`
          slot, which wraps. The caption is not decoration: this endpoint's
          payload is a deliberate activity/backlog split, and a filter bar that
          silently governs only part of the page is worse than no filter bar. */}
      <DashboardFilterBar
        filters={filters}
        actions={
          <span
            className="cfo-filter-note"
            title={[
              'Period-driven: revenue, operating spend, the posted-ledger P&L, and every '
                + 'ratio and gauge derived from them.',
              'Point-in-time by design: cash, AR, AP and the alert feed — these are balances '
                + 'and work awaiting action, and a narrow period must not hide them.',
              'Own fixed window: Monthly Revenue (financial year), Cash Flow (trailing 6 '
                + 'months) and the forecast built from it. Each card names its window.',
            ].join('\n\n')}
          >
            Revenue, spend &amp; P&amp;L only — cash, AR/AP and alerts stay live
          </span>
        }
      />

      {/* A dead endpoint must never render as an empty state. One compact line:
          it lives in the dock, so every px it takes is a px the grid loses. */}
      {loadError && (
        <div className="cfo-banner">
          <AlertTriangle size={14} className="cfo-banner-ico" />
          <span>{loadError}</span>
          <button className="cfo-banner-btn" onClick={load}>Retry</button>
        </div>
      )}
    </>
  );

  return (
    <PageShell className="cfo-root" dock={chrome}>
      <div className="cfo-fit">

        {/* ── Band 1 · the headline numbers ─────────────────────────────── */}
        <StatBand cols={6}>
          {stats.map((s, i) => (
            <Stat
              key={s.key} index={i} icon={s.icon} tone={s.tone} label={s.label}
              value={s.value} sub={s.sub} trend={s.trend} warn={s.warn}
              loading={loading}
              onClick={s.page && setPage ? () => setPage(s.page) : undefined}
            />
          ))}
        </StatBand>

        {/* ── Band 2 · money in, money moving, things on fire ───────────── */}
        <DashCard
          index={0} className="cfo-c5"
          title="Monthly Revenue" icon={<LineIcon size={14} />} iconColor={P}
          subtitle={`Paid invoices by invoice date · ${fyParams.fy} · ${revenueChart.length} month${revenueChart.length === 1 ? '' : 's'}`}
          expandable={revenueChart.length > 0}
          onViewAll={setPage ? () => setPage('InvoicesNew') : undefined}
          viewAllLabel="Invoices"
          headerRight={
            <span className="cfo-hdr-stat">
              <span>This month <b>{money(thisMonth)}</b></span>
              <Delta value={revTrend} />
            </span>
          }
          expandedChildren={revenueChart.length ? <RevenueChart height={440} /> : null}
        >
          <div className="cfo-chips">
            <span className="cfo-chip"><i style={{ background: P }} />Revenue <b>{fmtCr(revenue)}</b></span>
            <span className="cfo-chip"><i style={{ background: '#10b981' }} />Gross Profit <b>{fmtCr(grossProfit)}</b></span>
            <span className="cfo-chip"><i style={{ background: '#7c5cf0' }} />OpEx <b>{fmtCr(opex)}</b></span>
          </div>
          {revenueChart.length > 0
            ? <div className="cfo-chart"><RevenueChart /></div>
            : <Empty icon={BarChart2} text="No revenue data for this period" />}
        </DashCard>

        <DashCard
          index={1} className="cfo-c4"
          title="Cash Flow" icon={<ArrowUpRight size={14} />} iconColor="#10b981"
          subtitle={`Trailing ${cashFlowMonthly.length} month${cashFlowMonthly.length === 1 ? '' : 's'} · not filtered`}
          expandable={cashFlowMonthly.length > 0}
          expandedChildren={<CashFlowChart height={440} />}
        >
          <div className="cfo-cf-kpis">
            <div className="cfo-cf-kpi green">
              <ArrowUpRight size={12} /><span>Inflow</span>
              <strong>{money(cashFlowMonthly.reduce((s, r) => s + Math.max(r.operating, 0), 0))}</strong>
            </div>
            <div className="cfo-cf-kpi red">
              <ArrowDownRight size={12} /><span>Outflow</span>
              <strong>{money(cashFlowMonthly.reduce((s, r) => s + Math.min(r.operating, 0), 0))}</strong>
            </div>
            <div className="cfo-cf-kpi violet">
              <span>Net</span>
              <strong>{money(cashFlowMonthly.reduce((s, r) => s + r.net, 0))}</strong>
            </div>
          </div>
          <div className="cfo-chart"><CashFlowChart compact /></div>
        </DashCard>

        {/* The ONE card allowed to scroll inside itself: the alert feed is the
            only panel here whose row count grows with the business. */}
        <DashCard
          index={2} className="cfo-c3"
          title="Executive Alerts" icon={<Bell size={14} />} iconColor="#ef4444"
          subtitle={alertsData.length
            ? `${alertsData.length} open${highAlerts ? ` · ${highAlerts} high priority` : ''} · point-in-time`
            : 'nothing needs attention'}
          expandable={alertsData.length > 0}
          expandedChildren={
            <div className="cfo-alerts">
              {alertsData.map((a, i) => (
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
              ))}
            </div>
          }
        >
          {alertsData.length > 0 ? (
            <div className="cfo-alerts cfo-scroll">
              {alertsData.map((a, i) => (
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
              ))}
            </div>
          ) : <Empty icon={CheckCircle} text="No alerts" />}
        </DashCard>

        {/* ── Band 3 · the four analytical panels ───────────────────────── */}
        <DashCard
          index={3} className="cfo-c3"
          title="P&L Bridge" icon={<BarChart2 size={14} />} iconColor="#7c5cf0"
          subtitle={glPosted ? `${periodLabel} · posted ledger` : `${periodLabel} · ${glUnavailableReason}`}
        >
          {/* The three margins sit side by side rather than stacked: as three
              rows they took 78px of a 180px card at 1366×768 and left the
              waterfall below them a sliver. */}
          <div className="cfo-pl-summary">
            <div className="cfo-pl-stat">
              <span>Gross</span>
              <strong className={grossProfit >= 0 ? 'green' : 'red'}>{pct(grossProfit, revenue)}%</strong>
            </div>
            {/* Accrual margins divide by the LEDGER's revenue, never by the
                cash-basis figure. `acct.glRevenue || revenue` silently swapped
                in the cash number whenever the ledger booked no revenue for the
                window, pairing an accrual numerator with a cash denominator and
                printing a confident 0.0%. An em dash when there is nothing to
                divide by. */}
            <div className="cfo-pl-stat">
              <span>EBITDA</span>
              <strong className={ebitda == null || !(acct.glRevenue > 0) ? '' : ebitda >= 0 ? 'green' : 'red'}>
                {ebitda == null || !(acct.glRevenue > 0) ? '—' : `${pct(ebitda, acct.glRevenue)}%`}
              </strong>
            </div>
            <div className="cfo-pl-stat">
              <span>Net</span>
              <strong className={netProfit == null || !(acct.glRevenue > 0) ? '' : netProfit >= 0 ? 'green' : 'red'}>
                {netProfit == null || !(acct.glRevenue > 0) ? '—' : `${pct(netProfit, acct.glRevenue)}%`}
              </strong>
            </div>
          </div>
          {revenue > 0
            ? <WaterfallChart data={plWaterfall} />
            : <Empty icon={BarChart2} text="No data for this period" />}
        </DashCard>

        <DashCard
          index={4} className="cfo-c3"
          title="Revenue Forecast" icon={<TrendingUp size={14} />} iconColor="#6366f1"
          subtitle={forecastData.length
            ? `Next ${forecastData.length} months · ${forecastMeta.growth_rate != null ? `${forecastMeta.growth_rate}% growth` : 'trend-based'}`
            : 'not enough history'}
          expandable={forecastData.length > 0}
          headerRight={
            forecastMeta.method
              ? <span className="cfo-hdr-note" title={`${forecastMeta.method}${forecastMeta.band ? ` — ${forecastMeta.band}` : ''}`}>
                  <Info size={12} /> basis
                </span>
              : null
          }
          expandedChildren={
            <>
              <ForecastChart height={420} />
              {forecastMeta.method && (
                <p className="cfo-modal-note">
                  <strong>Method:</strong> {forecastMeta.method}
                  {forecastMeta.basis_months ? ` · built from ${forecastMeta.basis_months} months of history` : ''}
                  {forecastMeta.band ? ` · ${forecastMeta.band}` : ''}
                </p>
              )}
            </>
          }
        >
          {forecastData.length > 0 ? (
            <>
              <div className="cfo-chips">
                <span className="cfo-chip"><i style={{ background: P }} />Optimistic</span>
                <span className="cfo-chip"><i style={{ background: '#10b981' }} />Base</span>
                <span className="cfo-chip"><i style={{ background: '#7c5cf0' }} />Conservative</span>
              </div>
              <div className="cfo-chart"><ForecastChart compact /></div>
            </>
          ) : <Empty icon={TrendingUp} text="Insufficient historical data for a forecast" />}
        </DashCard>

        {/* Cost Structure.

            This was two cards side by side — "Expense Breakdown" (ranked bars)
            and "Expense Structure" (donut + legend) — both reading the same
            `expByCategory` payload and both spending a full card slot on it.
            They are one card now: the donut carries the shape, the ranked list
            carries the amounts and shares that the bar card used to.

            Before that, the bar card rendered five hardcoded departments —
            Engineering .36, Sales .30, Operations .23, Marketing .18, HR .14 —
            multiplied against total OpEx. Those shares sum to 1.21, so the
            "split" exceeded the amount being split by 21%, and the department
            names matched nothing in the employee master. */}
        <DashCard
          index={5} className="cfo-c3"
          title="Cost Structure" icon={<PieIcon size={14} />} iconColor="#8b5cf6"
          subtitle={expChart.length
            ? `${expChart.length} categor${expChart.length === 1 ? 'y' : 'ies'} · ${fmtCr(expTotal)} total`
            : `By category · ${periodLabel}`}
          expandable={expChart.length > EXP_VISIBLE}
          expandedChildren={
            <div className="cfo-cost-split cfo-cost-split--modal">
              <div className="cfo-pie-wrap">
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={expChart} cx="50%" cy="50%" innerRadius="56%" outerRadius="88%"
                      dataKey="value" paddingAngle={3}>
                      {expChart.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={v => [money(v), '']} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <CostLegend rows={expChart} />
            </div>
          }
        >
          {expChart.length > 0 ? (
            <div className="cfo-cost-split">
              <div className="cfo-pie-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={expChart} cx="50%" cy="50%" innerRadius="56%" outerRadius="88%"
                      dataKey="value" paddingAngle={3}>
                      {expChart.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={v => [money(v), '']} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="cfo-cost-side">
                <CostLegend rows={expChart.slice(0, EXP_VISIBLE)} />
                {expChart.length > EXP_VISIBLE && (
                  <div className="cfo-more">
                    +{expChart.length - EXP_VISIBLE} more — Expand to see all
                  </div>
                )}
              </div>
            </div>
          ) : (
            <Empty
              icon={PieIcon}
              text={`No expense claims recorded for ${periodLabel}. Category cost attribution needs claims tagged to a cost centre.`}
            />
          )}
        </DashCard>

        {/* Working Capital Gauges.

            The three stat rows under the gauges used to be Working Capital,
            AR/AP Ratio and Quick Ratio. The last two are already tiles in Key
            Financial Ratios — Current Ratio *is* AR/AP — but they were computed
            here in JS and there from `ratiosApi`, so the same figure had two
            independent sources that could disagree on screen. Only Working
            Capital, which appears nowhere else, is kept. */}
        <DashCard
          index={6} className="cfo-c3"
          title="Working Capital Health" icon={<Scale size={14} />} iconColor="#10b981"
          subtitle="Live AR · AP · cash · point-in-time"
        >
          <div className="cfo-gauges">
            <Gauge value={collectionsPct} label="Collections" color="#10b981" />
            <Gauge value={cashRatioPct}   label="Cash/AP"     color={P} />
            <Gauge value={liquidityPct}   label="Liquidity"   color="#7c5cf0" />
          </div>
          <div className="cfo-wc-stat">
            <span>Working Capital (AR − AP)</span>
            <strong className={workingCapital >= 0 ? 'green' : 'red'}>{fmtCr(workingCapital)}</strong>
          </div>
        </DashCard>

        {/* ── Band 4 · the ratio strip ───────────────────────────────────────
            A strip, not a card: the heading sits inline and the seven measured
            ratios flow beside it, so the band costs ~2 text lines rather than a
            whole card row. The five ratios this schema cannot compute are named
            in the footnote — never as tiles, and never with a status colour. */}
        <div className="cfo-ratios">
          <div className="cfo-ratios-hd">
            <span className="cfo-ratios-title">Key Financial Ratios</span>
            <span className="cfo-ratios-sub">
              {glPosted ? 'Posted ledger + live balances' : 'Live balances — ledger not posted'}
            </span>
            <span className="cfo-ratio-untracked">
              <span className="cfo-ru-label">Not tracked</span>
              {untrackedRatios.map((r, i) => (
                <span key={i} className="cfo-ru-chip" title={r.desc}>{r.label}</span>
              ))}
            </span>
          </div>
          <div className="cfo-ratios-grid">
            {ratiosData.map((r, i) => (
              <div key={i} className={`cfo-ratio-item cfo-ratio-${r.status}`} title={r.desc}>
                <div className="cfo-ratio-label">{r.label}</div>
                <div className="cfo-ratio-row">
                  <span className="cfo-ratio-val">{r.value}</span>
                  <span className="cfo-ratio-bench">{r.bench}</span>
                </div>
                {r.status === 'na' ? null
                  : r.status === 'good'
                    ? <CheckCircle size={11} className="cfo-ratio-icon green" />
                    : <AlertTriangle size={11} className="cfo-ratio-icon violet" />}
              </div>
            ))}
          </div>
        </div>

      </div>
    </PageShell>
  );
}
