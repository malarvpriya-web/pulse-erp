// PATH: frontend/src/features/finance/pages/FinancialStatements.jsx
import { useState, useEffect } from 'react';
import {
  LineChart, Line, BarChart, Bar, RadarChart, Radar, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, ComposedChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { TrendingUp, TrendingDown, Scale, Droplets, BarChart2, Activity } from 'lucide-react';
import api from '@/services/api/client';
import { useFY } from '@/context/FYContext';
import FYSelector from '@/components/core/FYSelector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PURPLE   = '#6B3FDB';
const LIGHT    = '#f5f3ff';
const BORDER   = '#e9e4ff';
const GREEN    = '#10b981';
const AMBER    = '#f59e0b';
const RED      = '#ef4444';

function inr(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e7)  return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5)  return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

function pct(n) { return n === null ? '—' : `${n}%`; }

function StatCard({ label, value, sub, icon: Icon, color = PURPLE, trend }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: '16px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
          {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
        </div>
        {Icon && <div style={{ background: LIGHT, borderRadius: 8, padding: 8, color: PURPLE }}><Icon size={18} /></div>}
      </div>
      {trend !== undefined && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8, fontSize: 12 }}>
          {trend >= 0
            ? <TrendingUp size={12} color={GREEN} />
            : <TrendingDown size={12} color={RED} />}
          <span style={{ color: trend >= 0 ? GREEN : RED }}>{Math.abs(trend)}% vs last FY</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
function EmptyTabState({ title, desc }) {
  return (
    <div style={{ textAlign: 'center', padding: '60px 24px', color: '#9ca3af' }}>
      <BarChart2 size={40} color="#d1d5db" style={{ margin: '0 auto 12px' }} />
      <div style={{ fontSize: 15, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>{title}</div>
      {desc && <div style={{ fontSize: 13 }}>{desc}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Waterfall chart (Income Statement)
// ---------------------------------------------------------------------------
function WaterfallBar({ data }) {
  const colors = { total: PURPLE, negative: RED, positive: GREEN, subtotal: '#6366f1' };
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: 700 }}>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 10, right: 20, left: 20, bottom: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} angle={-30} textAnchor="end" interval={0} />
            <YAxis tickFormatter={v => inr(v)} tick={{ fontSize: 10 }} />
            <Tooltip formatter={v => inr(v)} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}
              label={{ position: 'top', formatter: v => inr(v), fontSize: 10 }}>
              {data.map((entry, i) => (
                <rect key={i} fill={colors[entry.type] || PURPLE} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Balance Sheet accordion section
// ---------------------------------------------------------------------------
function BSSection({ title, total, items, color }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        onClick={() => setOpen(p => !p)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 14px', background: LIGHT, borderRadius: 8, cursor: 'pointer',
          fontWeight: 600, fontSize: 13, color,
        }}>
        <span>{title}</span>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <span>{inr(total)}</span>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && (
        <div style={{ border: `1px solid ${BORDER}`, borderTop: 'none', borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
          {(items || []).map((item, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', padding: '8px 14px',
              fontSize: 13, borderBottom: i < items.length - 1 ? `1px solid ${BORDER}` : 'none',
              background: '#fff',
            }}>
              <span style={{ color: '#374151' }}>{item.name}</span>
              <span style={{ fontWeight: 500, color: '#111827' }}>{inr(Math.abs(item.value))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cash flow section
// ---------------------------------------------------------------------------
function CFSection({ title, data, color }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16, flex: 1 }}>
      <div style={{ fontWeight: 600, fontSize: 13, color, marginBottom: 10 }}>{title}</div>
      {(data.items || []).map((item, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12, borderBottom: `1px solid ${BORDER}` }}>
          <span style={{ color: '#6b7280' }}>{item.name}</span>
          <span style={{ fontWeight: 500, color: item.value < 0 ? RED : '#111827' }}>{inr(item.value)}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontWeight: 700, fontSize: 13, color }}>
        <span>Net</span>
        <span>{inr(data.total)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ratio card
// ---------------------------------------------------------------------------
function RatioCard({ ratio }) {
  const statusColor = { good: GREEN, watch: AMBER, risk: RED, neutral: '#6b7280' };
  const sc = statusColor[ratio.status] || '#6b7280';
  return (
    <div style={{
      background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
      padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>{ratio.name}</div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>Benchmark: {ratio.benchmark}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: sc }}>{ratio.value ?? '—'}</div>
        <div style={{
          fontSize: 10, fontWeight: 600, color: sc,
          background: `${sc}18`, padding: '1px 6px', borderRadius: 6, marginTop: 2, textTransform: 'uppercase',
        }}>
          {ratio.status}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TABS = ['Income Statement', 'Balance Sheet', 'Cash Flow', 'Funds Flow', 'Breakeven', 'Ratios'];

export default function FinancialStatements({ setPage } = {}) {
  const { fyParams, fyLabel } = useFY();
  const [tab,       setTab]       = useState('Income Statement');
  const [income,    setIncome]    = useState(null);
  const [bs,        setBS]        = useState(null);
  const [cf,        setCF]        = useState(null);
  const [ff,        setFF]        = useState(null);
  const [bep,       setBEP]       = useState(null);
  const [ratios,    setRatios]    = useState(null);
  const [loading,   setLoading]   = useState(false);

  useEffect(() => {
    setLoading(true);
    const params = `?fyStart=${fyParams.fyStart}&fyEnd=${fyParams.fyEnd}`;
    // Use correct param names that the backend actually reads
    const plParams = `?period_from=${fyParams.fyStart}&period_to=${fyParams.fyEnd}`;
    const bsParams = `?as_of_date=${fyParams.fyEnd}`;

    const safeFetch = (primary, fallback) =>
      primary.catch(err => {
        if (err.response?.status === 404) return fallback;
        throw err;
      }).catch(() => null);

    Promise.allSettled([
      safeFetch(
        api.get(`/finance/accounting/profit-loss${plParams}`),
        api.get(`/statements/income-statement${params}`)
      ),
      safeFetch(
        api.get(`/finance/accounting/balance-sheet${bsParams}`),
        api.get(`/statements/balance-sheet${params}`)
      ),
      api.get(`/statements/cash-flow${params}`),
      api.get(`/statements/funds-flow${params}`),
      api.get(`/statements/breakeven-analysis${params}`),
      api.get(`/statements/ratios${params}`),
    ]).then(([i, b, c, ffRes, be, r]) => {
      // Normalize GL profit-loss response to match expected income shape
      if (i.status === 'fulfilled' && i.value) {
        const d = i.value.data;
        if (d?.summary && !d?.breakdown) {
          const revenue    = parseFloat(d.summary?.total_income ?? d.total_revenue ?? 0);
          const cogs       = parseFloat(d.summary?.total_cogs ?? d.cogs ?? 0);
          const opEx       = parseFloat(d.summary?.total_operating_expense ?? d.total_opex ?? 0);
          const netProfit  = parseFloat(d.summary?.net_profit ?? d.net_profit ?? 0);
          setIncome({
            summary: {
              revenue, grossProfit: revenue - cogs,
              grossMargin: revenue ? ((revenue - cogs) / revenue * 100).toFixed(1) : 0,
              ebitda: revenue - cogs - opEx, netProfit,
              netMargin: revenue ? (netProfit / revenue * 100).toFixed(1) : 0,
            },
            breakdown: (d.revenue_accounts || d.income || []).map(a => ({
              label: a.account_name || a.name || a.label,
              value: parseFloat(a.net_amount ?? a.net_credit ?? a.net ?? 0),
            })),
            trend: d.monthly_chart || [],
          });
        } else {
          setIncome(d || null);
        }
      } else {
        setIncome(null);
      }

      // Transform flat balance-sheet response into the nested structure the UI expects
      if (b.status === 'fulfilled' && b.value) {
        const raw = b.value.data;
        if (raw && !raw.assets) {
          const clTotal = raw.total_current_liabilities || 0;
          const ltTotal = raw.total_long_term_liabilities || 0;
          const mapItem = a => ({ name: a.name || a.account_name, value: a.balance || 0 });
          setBS({
            assets: {
              total: raw.total_assets || 0,
              current:    { total: raw.total_current_assets || 0, items: (raw.current_assets || []).map(mapItem) },
              nonCurrent: { total: raw.total_fixed_assets   || 0, items: (raw.fixed_assets   || []).map(mapItem) },
            },
            liabilities: {
              total: raw.total_liabilities_equity || 0,
              current:    { total: clTotal, items: (raw.current_liabilities     || []).map(mapItem) },
              nonCurrent: { total: ltTotal, items: (raw.long_term_liabilities   || []).map(mapItem) },
              equity: {
                total: raw.total_equity || 0,
                items: [
                  ...(raw.equity_accounts || []).map(mapItem),
                  { name: 'Retained Earnings (Prev FY)', value: raw.retained_earnings || 0 },
                ],
              },
            },
            ratios: {
              currentRatio:   clTotal > 0 ? ((raw.total_current_assets || 0) / clTotal).toFixed(2) : '—',
              debtToEquity:   (raw.total_equity || 0) > 0
                ? ((clTotal + ltTotal) / raw.total_equity).toFixed(2) : '—',
              workingCapital: (raw.total_current_assets || 0) - clTotal,
            },
            balanced: raw.balanced,
            variance: Math.abs((raw.total_assets || 0) - (raw.total_liabilities_equity || 0)),
          });
        } else {
          setBS(raw || null);
        }
      } else {
        setBS(null);
      }

      setCF(c.status === 'fulfilled' ? c.value?.data ?? null : null);
      setFF(ffRes.status === 'fulfilled' ? ffRes.value?.data ?? null : null);
      setBEP(be.status === 'fulfilled' ? be.value?.data ?? null : null);
      setRatios(r.status === 'fulfilled' ? r.value?.data ?? null : null);
    }).finally(() => setLoading(false));
  }, [fyParams.fyStart, fyParams.fyEnd]);

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>Financial Statements</h1>
            <span style={{
              fontSize: 11, fontWeight: 600, background: '#f0fdf4', color: '#16a34a',
              border: '1px solid #bbf7d0', borderRadius: 6, padding: '2px 8px',
            }}>STATUTORY VIEW</span>
          </div>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            {fyLabel} — Full-year IFRS-structured statements &nbsp;·&nbsp;
            <span style={{ color: '#9ca3af' }}>For management reports use </span>
            <button onClick={() => setPage?.('FinancialReports')} style={{ color: PURPLE, background: 'none', border: 'none', padding: 0, fontWeight: 500, fontSize: 13, cursor: 'pointer' }}>Financial Reports ↗</button>
          </p>
        </div>
        <FYSelector showProgress />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 4, width: 'fit-content' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '7px 16px', border: 'none', borderRadius: 8, cursor: 'pointer',
            background: tab === t ? PURPLE : 'transparent',
            color:      tab === t ? '#fff' : '#6b7280',
            fontSize:   13, fontWeight: tab === t ? 600 : 400,
          }}>{t}</button>
        ))}
      </div>

      {loading && <div style={{ textAlign: 'center', color: '#9ca3af', padding: 60 }}>Loading statements…</div>}

      {/* ── Income Statement ── */}
      {!loading && tab === 'Income Statement' && !income && (
        <EmptyTabState title="No income data for this period" desc="Post invoices or journal entries for this fiscal year to generate this statement." />
      )}
      {!loading && tab === 'Income Statement' && income && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
            <StatCard label="Revenue"       value={inr(income.summary.revenue)}    icon={TrendingUp}   color={PURPLE} />
            <StatCard label="Gross Profit"  value={inr(income.summary.grossProfit)} sub={pct(income.summary.grossMargin)} icon={Scale} color={GREEN} />
            <StatCard label="EBITDA"        value={inr(income.summary.ebitda)}      sub={pct(income.summary.ebitdaMargin)} icon={Activity} color="#6366f1" />
            <StatCard label="Net Profit"    value={inr(income.summary.netProfit)}   sub={pct(income.summary.netMargin)} icon={BarChart2} color={income.summary.netProfit >= 0 ? GREEN : RED} />
          </div>

          {/* Waterfall */}
          <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', marginBottom: 12 }}>P&L Waterfall</div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={income.breakdown} margin={{ top: 10, right: 20, left: 20, bottom: 50 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} angle={-30} textAnchor="end" interval={0} />
                <YAxis tickFormatter={v => inr(v)} tick={{ fontSize: 10 }} />
                <Tooltip formatter={v => [inr(v), 'Amount']} />
                <Bar dataKey="value" radius={[4,4,0,0]}
                  fill={PURPLE}
                  label={{ position: 'top', formatter: v => inr(v), fontSize: 9, fill: '#6b7280' }} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Monthly trend */}
          <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', marginBottom: 12 }}>Monthly Trend</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={income.trend}>
                <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => inr(v)} tick={{ fontSize: 10 }} />
                <Tooltip formatter={v => inr(v)} />
                <Legend />
                <Line type="monotone" dataKey="revenue"     stroke={PURPLE} strokeWidth={2} dot={false} name="Revenue" />
                <Line type="monotone" dataKey="grossProfit" stroke={GREEN}  strokeWidth={2} dot={false} name="Gross Profit" />
                <Line type="monotone" dataKey="netProfit"   stroke="#f59e0b" strokeWidth={2} dot={false} name="Net Profit" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Balance Sheet ── */}
      {!loading && tab === 'Balance Sheet' && !bs && (
        <EmptyTabState title="Balance sheet unavailable" desc="No asset or liability data found. Add bank accounts, fixed assets, or outstanding invoices." />
      )}
      {!loading && tab === 'Balance Sheet' && bs && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Ratio chips */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[
              { label: 'Total Assets',      value: inr(bs.assets.total) },
              { label: 'Current Ratio',     value: bs.ratios.currentRatio },
              { label: 'Debt / Equity',     value: bs.ratios.debtToEquity },
              { label: 'Working Capital',   value: inr(bs.ratios.workingCapital) },
              { label: 'Balance Check',     value: bs.balanced ? '✓ Balanced' : `⚠ Variance ${inr(bs.variance)}`, color: bs.balanced ? GREEN : RED },
            ].map(c => (
              <div key={c.label} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px' }}>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: c.color || '#111827', marginTop: 2 }}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Two-column layout */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: PURPLE, marginBottom: 10 }}>Assets</div>
              <BSSection title={`Current Assets  ·  ${inr(bs.assets.current.total)}`}    total={bs.assets.current.total}    items={bs.assets.current.items}    color={PURPLE} />
              <BSSection title={`Non-Current Assets  ·  ${inr(bs.assets.nonCurrent.total)}`} total={bs.assets.nonCurrent.total} items={bs.assets.nonCurrent.items} color={PURPLE} />
              <div style={{ textAlign: 'right', fontWeight: 700, fontSize: 15, padding: '10px 14px', color: PURPLE }}>Total: {inr(bs.assets.total)}</div>
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#374151', marginBottom: 10 }}>Liabilities & Equity</div>
              <BSSection title={`Current Liabilities  ·  ${inr(bs.liabilities.current.total)}`}    total={bs.liabilities.current.total}    items={bs.liabilities.current.items}    color={RED} />
              <BSSection title={`Non-Current Liabilities  ·  ${inr(bs.liabilities.nonCurrent.total)}`} total={bs.liabilities.nonCurrent.total} items={bs.liabilities.nonCurrent.items} color={AMBER} />
              <BSSection title={`Equity  ·  ${inr(bs.liabilities.equity.total)}`} total={bs.liabilities.equity.total} items={bs.liabilities.equity.items} color={GREEN} />
              <div style={{ textAlign: 'right', fontWeight: 700, fontSize: 15, padding: '10px 14px', color: '#374151' }}>Total: {inr(bs.liabilities.total)}</div>
            </div>
          </div>
        </div>
      )}

      {/* ── Cash Flow ── */}
      {!loading && tab === 'Cash Flow' && !cf && (
        <EmptyTabState title="No cash flow data for this period" desc="Record receipts and payments to generate the cash flow statement." />
      )}
      {!loading && tab === 'Cash Flow' && cf && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[
              { label: 'Operating CF',    value: inr(cf.operating.total), color: cf.operating.total >= 0 ? GREEN : RED },
              { label: 'Investing CF',    value: inr(cf.investing.total), color: cf.investing.total >= 0 ? GREEN : AMBER },
              { label: 'Financing CF',    value: inr(cf.financing.total), color: cf.financing.total >= 0 ? GREEN : AMBER },
              { label: 'Net Cash Change', value: inr(cf.netCashChange),   color: cf.netCashChange >= 0 ? GREEN : RED },
              { label: 'Free Cash Flow',  value: inr(cf.freeCashFlow),    color: cf.freeCashFlow >= 0 ? GREEN : RED },
            ].map(c => (
              <div key={c.label} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px' }}>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: c.color, marginTop: 2 }}>{c.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <CFSection title="Operating Activities" data={cf.operating} color={GREEN} />
            <CFSection title="Investing Activities" data={cf.investing} color={AMBER} />
            <CFSection title="Financing Activities" data={cf.financing} color={PURPLE} />
          </div>

          {/* Waterfall bar */}
          <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', marginBottom: 12 }}>Cash Flow Waterfall</div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={[
                { label: 'Operating', value: cf.operating.total },
                { label: 'Investing',  value: cf.investing.total },
                { label: 'Financing',  value: cf.financing.total },
                { label: 'Net Change', value: cf.netCashChange },
              ]}>
                <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => inr(v)} tick={{ fontSize: 10 }} />
                <Tooltip formatter={v => inr(v)} />
                <ReferenceLine y={0} stroke="#e5e7eb" />
                <Bar dataKey="value" radius={[4,4,0,0]} fill={PURPLE}
                  label={{ position: 'top', formatter: v => inr(v), fontSize: 10, fill: '#374151' }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Funds Flow ── */}
      {!loading && tab === 'Funds Flow' && !ff && (
        <EmptyTabState title="No funds flow data for this period" desc="Post journal entries across balance-sheet accounts to generate the funds flow statement." />
      )}
      {!loading && tab === 'Funds Flow' && ff && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Summary chips */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[
              { label: 'Funds from Operations', value: inr(ff.fundsFromOperations), color: ff.fundsFromOperations >= 0 ? GREEN : RED },
              { label: 'Total Sources',        value: inr(ff.totalSources),      color: PURPLE },
              { label: 'Total Applications',   value: inr(ff.totalApplications), color: AMBER },
              { label: 'Net Increase in WC',   value: inr(ff.workingCapital?.netIncrease), color: ff.workingCapital?.netIncrease >= 0 ? GREEN : RED },
              { label: 'Reconciled',           value: ff.reconciliation?.reconciled ? '✓ Yes' : `⚠ Δ ${inr(ff.reconciliation?.difference)}`, color: ff.reconciliation?.reconciled ? GREEN : AMBER },
            ].map(c => (
              <div key={c.label} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 18px' }}>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: c.color, marginTop: 2 }}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Sources vs Applications */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: PURPLE, marginBottom: 10 }}>Sources of Funds</div>
              {(ff.sources || []).length === 0 ? <div style={{ fontSize: 13, color: '#9ca3af' }}>No sources in this period.</div> :
                (ff.sources || []).map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', fontSize: 13, borderBottom: `1px solid ${BORDER}` }}>
                    <span style={{ color: '#374151' }}>{s.name}{s.detail ? <span style={{ color: '#9ca3af', fontSize: 11, display: 'block' }}>{s.detail}</span> : null}</span>
                    <span style={{ fontWeight: 500, color: '#111827' }}>{inr(s.value)}</span>
                  </div>
                ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontWeight: 700, fontSize: 14, color: PURPLE }}>
                <span>Total Sources</span><span>{inr(ff.totalSources)}</span>
              </div>
            </div>
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: AMBER, marginBottom: 10 }}>Applications of Funds</div>
              {(ff.applications || []).length === 0 ? <div style={{ fontSize: 13, color: '#9ca3af' }}>No applications in this period.</div> :
                (ff.applications || []).map((a, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', fontSize: 13, borderBottom: `1px solid ${BORDER}` }}>
                    <span style={{ color: '#374151' }}>{a.name}</span>
                    <span style={{ fontWeight: 500, color: '#111827' }}>{inr(a.value)}</span>
                  </div>
                ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontWeight: 700, fontSize: 14, color: AMBER }}>
                <span>Total Applications</span><span>{inr(ff.totalApplications)}</span>
              </div>
            </div>
          </div>

          {/* Working Capital schedule */}
          <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: '#111827', marginBottom: 10 }}>Change in Working Capital</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Current Assets (Δ {inr(ff.workingCapital?.increaseInCurrentAssets)})</div>
                {(ff.workingCapital?.assets || []).map((x, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', color: x.change >= 0 ? '#374151' : RED }}>
                    <span>{x.name}</span><span>{inr(x.change)}</span>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Current Liabilities (Δ {inr(ff.workingCapital?.increaseInCurrentLiabilities)})</div>
                {(ff.workingCapital?.liabilities || []).map((x, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', color: '#374151' }}>
                    <span>{x.name}</span><span>{inr(x.change)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: '#9ca3af' }}>{ff.note}</div>
          </div>
        </div>
      )}

      {/* ── Breakeven ── */}
      {!loading && tab === 'Breakeven' && !bep && (
        <EmptyTabState title="Breakeven data unavailable" desc="Revenue and expense data needed to calculate the breakeven point." />
      )}
      {!loading && tab === 'Breakeven' && bep && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
            {[
              { label: 'Revenue',          value: inr(bep.revenue) },
              { label: 'Fixed Cost',       value: inr(bep.fixedCost) },
              { label: 'Variable Cost',    value: inr(bep.variableCost) },
              { label: 'Contribution',     value: inr(bep.contribution) },
              { label: 'CM Ratio',         value: `${bep.cmRatio}%` },
              { label: 'Breakeven Rev',    value: inr(bep.breakevenRevenue), color: AMBER },
              { label: 'Margin of Safety', value: `${bep.marginOfSafety}%`, color: GREEN },
              { label: 'Op. Leverage',     value: bep.operatingLeverage ?? '—' },
            ].map(c => (
              <div key={c.label} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '12px 16px' }}>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: c.color || '#111827', marginTop: 2 }}>{c.value}</div>
              </div>
            ))}
          </div>

          <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', marginBottom: 12 }}>Breakeven Chart</div>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={bep.chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={BORDER} />
                <XAxis dataKey="revenue" tickFormatter={v => inr(v)} tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={v => inr(v)} tick={{ fontSize: 10 }} />
                <Tooltip formatter={v => inr(v)} />
                <Legend />
                <Area type="monotone" dataKey="revenue"   stroke={GREEN}  fill={`${GREEN}18`}  name="Revenue" />
                <Line type="monotone" dataKey="totalCost" stroke={RED}    strokeWidth={2}       name="Total Cost" dot={false} />
                <Line type="monotone" dataKey="fixedCost" stroke={AMBER}  strokeWidth={1.5}     name="Fixed Cost" strokeDasharray="5 5" dot={false} />
                <ReferenceLine x={bep.breakevenRevenue} stroke="#374151" strokeDasharray="4 4" label={{ value: 'BEP', fontSize: 11 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Ratios ── */}
      {!loading && tab === 'Ratios' && !ratios && (
        <EmptyTabState title="Financial ratios unavailable" desc="Insufficient balance sheet or income data to compute ratios." />
      )}
      {!loading && tab === 'Ratios' && ratios && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {Object.entries(ratios.ratios).map(([section, items]) => (
            <div key={section}>
              <div style={{ fontWeight: 600, fontSize: 14, color: PURPLE, marginBottom: 10, textTransform: 'capitalize' }}>{section} Ratios</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                {items.map(r => <RatioCard key={r.name} ratio={r} />)}
              </div>
            </div>
          ))}

          {/* Radar chart of profitability normalized scores */}
          <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', marginBottom: 12 }}>Performance Radar</div>
            <ResponsiveContainer width="100%" height={260}>
              <RadarChart data={[
                { metric: 'Liquidity',     score: Math.min(100, (ratios.ratios.liquidity[0]?.value || 0) / 3 * 100) },
                { metric: 'Profitability', score: Math.min(100, (ratios.ratios.profitability[2]?.value || 0) / 20 * 100) },
                { metric: 'Efficiency',    score: Math.min(100, (ratios.ratios.efficiency[0]?.value || 0) / 2 * 100) },
                { metric: 'Leverage',      score: Math.max(0, 100 - (ratios.ratios.leverage[0]?.value || 0) / 4 * 100) },
                { metric: 'Growth',        score: Math.min(100, Math.max(0, 50 + (income?.summary?.netMargin || 0))) },
              ]}>
                <PolarGrid stroke={BORDER} />
                <PolarAngleAxis dataKey="metric" tick={{ fontSize: 12 }} />
                <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 10 }} />
                <Radar name="Score" dataKey="score" stroke={PURPLE} fill={PURPLE} fillOpacity={0.25} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
