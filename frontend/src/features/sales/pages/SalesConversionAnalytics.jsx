import { useState, useEffect, useCallback, useRef } from 'react';
import { BarChart3 } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, Legend,
} from 'recharts';
import api from '@/services/api/client';
import { PageHero, PageShell, Stat } from '@/components/pulse-ui';

// ── Formatters ─────────────────────────────────────────────────────────────────
// null/undefined means the figure was never measured — an em dash, not zero.
// A real, measured 0 still renders as ₹0 / 0.0%.
const unmeasured = n => n === null || n === undefined || n === '';
const fmtINR = n => {
  if (unmeasured(n)) return '—';
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)} L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};
const fmtPct = n => (unmeasured(n) ? '—' : `${parseFloat(n || 0).toFixed(1)}%`);

const C = {
  primary: '#6B3FDB', light: '#f5f3ff', border: '#e9e4ff',
  green: '#16a34a', red: '#dc2626', amber: '#6d28d9', blue: '#2563eb',
  card: { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12 },
};

const FUNNEL_STEPS = [
  { key: 'enquiries',    label: 'Enquiries',    color: '#6b7280' },
  { key: 'leads',        label: 'Qualified Leads', color: '#3b82f6' },
  { key: 'opportunities',label: 'Opportunities', color: '#8b5cf6' },
  { key: 'quotations',   label: 'Quotations',   color: '#6d28d9' },
  { key: 'orders',       label: 'Orders Won',   color: '#16a34a' },
];

const RATIO_LABELS = {
  enquiry_to_lead:           'Enquiry → Lead',
  lead_to_opportunity:       'Lead → Opportunity',
  opportunity_to_quotation:  'Opportunity → Quote',
  quotation_to_order:        'Quote → Order',
  enquiry_to_order:          'End-to-End (Enquiry → Order)',
};

// Each step's linked rate is only as trustworthy as the share of that stage
// carrying a foreign key back to the stage before it. `enquiry_to_lead` has no
// linkage figure — both sides of it are the same `leads` row — and
// `enquiry_to_order` spans three joins, so neither appears here.
const LINK_COVERAGE = {
  lead_to_opportunity:      'opportunities_with_lead',
  opportunity_to_quotation: 'quotations_with_opportunity',
  quotation_to_order:       'orders_with_quotation',
};
const LINK_COVERAGE_LABELS = {
  opportunities_with_lead:     'opportunities are linked to a lead',
  quotations_with_opportunity: 'quotations are linked to an opportunity',
  orders_with_quotation:       'orders are linked to a quotation',
};

function KpiCard({ label, value, sub, color = C.primary }) {
  // Delegates to the design-system card so this page's KPIs match every other
  // page's. Signature unchanged, so no call site needed editing.
  return <Stat label={label} value={value} sub={sub} color={color} />;
}

function PctBar({ value, max = 100, color = C.primary }) {
  // null means the denominator was empty. Coercing it to 0 draws an empty bar
  // labelled "0.0%", which is a measurement — "we converted none of them" —
  // rather than the absence of one.
  if (value === null || value === undefined) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 4, height: 8 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af', minWidth: 38, textAlign: 'right' }}>—</span>
      </div>
    );
  }
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 4, height: 8 }}>
        <div style={{ width: `${pct}%`, background: color, height: 8, borderRadius: 4, transition: 'width .3s' }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color, minWidth: 38, textAlign: 'right' }}>{fmtPct(value)}</span>
    </div>
  );
}

const TABS = ['Funnel Overview', 'Salesperson Analytics', 'Win / Loss Analysis', 'Monthly Trends', 'Customer Analytics', 'Product Analytics'];
const FY_YEARS = (() => { const y = new Date().getFullYear(); return [y-1, y-2, y].sort((a,b) => b-a); })();

const PRODUCT_COLORS = ['#6B3FDB','#2563eb','#16a34a','#6d28d9','#ef4444','#06b6d4','#8b5cf6'];

/**
 * `embedded` — rendered as a tab inside SalesIntelligence, which already owns
 * the page shell and hero. Without it this component stacked a second hero
 * ("Sales Target & Conversion Analytics") and a second tab strip underneath
 * the hub's own. It stays false for the standalone /SalesConversionAnalytics
 * route, which has no shell of its own.
 */
export default function SalesConversionAnalytics({ embedded = false }) {
  const [tab, setTab]               = useState('Funnel Overview');
  const [ratios, setRatios]         = useState(null);
  const [monthly, setMonthly]       = useState([]);
  const [spPerf, setSPPerf]         = useState([]);
  const [wonLost, setWonLost]       = useState(null);
  const [customers, setCustomers]   = useState(null);
  const [products, setProducts]     = useState([]);
  const [loading, setLoading]       = useState(true);
  // Which panels came back broken. allSettled means a rejected request leaves
  // its panel's state null and the tab renders its "no data yet" empty state —
  // indistinguishable from a genuinely empty pipeline unless the failure is
  // named. Every one of these endpoints was returning a silent zero until
  // 2026-08-27; an unreported fetch failure is the same bug one layer up.
  const [failed, setFailed]         = useState([]);
  const [fyYear, setFyYear]         = useState(FY_YEARS[0]);
  const mountedRef = useRef(true);
  // Re-arm on mount, do not just disarm on unmount. StrictMode mounts, unmounts
  // and remounts every component in dev: the cleanup set this to false and
  // nothing ever set it back, so every `if (mountedRef.current)` guard below
  // failed on the surviving mount and the page hung on "Loading…" forever.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const panels = [
        ['Funnel Overview',        () => api.get('/sales-funnel/conversion-ratios')],
        ['Monthly Trends',         () => api.get('/sales-funnel/monthly', { params: { months: 12 } })],
        ['Salesperson Analytics',  () => api.get('/sales-funnel/salesperson-performance', { params: { fy_year: fyYear } })],
        ['Win / Loss Analysis',    () => api.get('/sales-funnel/won-lost-analysis')],
        ['Customer Analytics',     () => api.get('/sales-command-center/customer-analytics')],
        ['Product Analytics',      () => api.get('/sales-command-center/product-analytics')],
      ];
      const [ratiosRes, monthlyRes, spRes, wlRes, custRes, prodRes] =
        await Promise.allSettled(panels.map(([, run]) => run()));
      if (!mountedRef.current) return;
      const arr = r => (Array.isArray(r.value.data) ? r.value.data : []);
      if (ratiosRes.status === 'fulfilled')  setRatios(ratiosRes.value.data);
      if (monthlyRes.status === 'fulfilled') setMonthly(arr(monthlyRes));
      if (spRes.status === 'fulfilled')      setSPPerf(arr(spRes));
      if (wlRes.status === 'fulfilled')      setWonLost(wlRes.value.data);
      if (custRes.status === 'fulfilled')    setCustomers(custRes.value.data);
      if (prodRes.status === 'fulfilled')    setProducts(arr(prodRes));

      setFailed([ratiosRes, monthlyRes, spRes, wlRes, custRes, prodRes]
        .map((r, i) => (r.status === 'rejected'
          ? { tab: panels[i][0], message: r.reason?.response?.data?.error || r.reason?.message || 'Request failed' }
          : null))
        .filter(Boolean));
    } finally { if (mountedRef.current) setLoading(false); }
  }, [fyYear]);

  useEffect(() => { load(); }, [load]);

  const funnel     = ratios?.funnel || {};
  const convRatios = ratios?.ratios || {};
  const linked     = ratios?.linked || null;

  // For the visual funnel (custom, since recharts funnel needs specific version)
  const maxFunnelVal = Math.max(...FUNNEL_STEPS.map(s => funnel[s.key] || 0), 1);

  // The weakest step, for the KEY INSIGHT panel. It used to be a two-way
  // comparison of quote-to-order against opportunity-to-quote, so the advice
  // ignored the other three steps entirely and could name a step that was
  // performing fine. A step above 100% is not a drop-off at all — it means the
  // stage holds records the previous stage never saw — so it is excluded here
  // and called out separately below.
  const STEP_KEYS = ['enquiry_to_lead', 'lead_to_opportunity', 'opportunity_to_quotation', 'quotation_to_order'];
  const weakestStep = STEP_KEYS
    .map(k => ({ key: k, value: convRatios[k] }))
    .filter(s => typeof s.value === 'number' && s.value <= 100)
    .sort((a, b) => a.value - b.value)[0] || null;

  // The thinnest link in the chain, surfaced only when it is thin enough to
  // change how the numbers above should be read.
  const weakestLinkage = Object.entries(linked?.coverage || {})
    .map(([key, value]) => ({ key, value }))
    .filter(c => typeof c.value === 'number' && c.value < 75 && LINK_COVERAGE_LABELS[c.key])
    .sort((a, b) => a.value - b.value)[0] || null;

  if (loading) return <div style={{ padding: 32, color: '#6b7280' }}>Loading conversion analytics…</div>;

  const totalWon   = wonLost?.won ?? 0;
  const totalLost  = wonLost?.lost ?? 0;
  const totalOpen  = wonLost?.open ?? 0;
  // null means nothing has closed yet. `?? 0` would print "0.0% win rate" over
  // an untouched pipeline, which reads as losing every deal.
  const winRate    = wonLost?.win_rate ?? null;

  const body = (
    <>
      {failed.length > 0 && (
        <div style={{
          marginBottom: 16, padding: '12px 16px', borderRadius: 10,
          background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 13,
        }}>
          <strong>{failed.length} of 6 panels failed to load.</strong> The figures below exclude them.
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {failed.map(f => <li key={f.tab}>{f.tab} — {f.message}</li>)}
          </ul>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: `1px solid ${C.border}` }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: 600,
            color: tab === t ? C.primary : '#6b7280',
            borderBottom: tab === t ? `2px solid ${C.primary}` : '2px solid transparent',
            marginBottom: -1,
          }}>{t}</button>
        ))}
      </div>

      {/* ── Funnel Overview ──────────────────────────────────────────────────── */}
      {tab === 'Funnel Overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* KPI cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
            {FUNNEL_STEPS.map(s => (
              <KpiCard key={s.key} label={s.label} value={(funnel[s.key] || 0).toLocaleString()} sub="all time" color={s.color} />
            ))}
            {/* Labelled for what it measures. Sitting unqualified next to
                "Orders Won 6" it read as an order win rate and contradicted it:
                this is the opportunity stage's rate, and it counts only deals
                that have actually closed. */}
            <KpiCard
              label="Opportunity Win Rate"
              value={winRate === null ? '—' : fmtPct(winRate)}
              sub={winRate === null
                ? `no closed deals · ${totalOpen} open`
                : `${totalWon} won of ${totalWon + totalLost} closed`}
              color={winRate === null ? '#9ca3af' : winRate >= 30 ? C.green : winRate >= 15 ? C.amber : C.red}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* Visual Funnel */}
            <div style={{ ...C.card, padding: 24 }}>
              <h3 style={{ margin: '0 0 20px', fontSize: 15, fontWeight: 600 }}>Conversion Funnel</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {FUNNEL_STEPS.map((s, i) => {
                  const val  = funnel[s.key] || 0;
                  const pct  = (val / maxFunnelVal) * 100;
                  const prev = i > 0 ? (funnel[FUNNEL_STEPS[i - 1].key] || 0) : null;
                  const conv = prev > 0 ? (val / prev) * 100 : null;
                  // A step above 100% is not a conversion — the stage holds more
                  // records than the one before it, because records get created
                  // straight into it (a quotation raised with no opportunity).
                  // Printing "↓ 450.0% conversion", as this did, states the
                  // opposite of what happened.
                  const overflow = conv !== null && conv > 100;
                  return (
                    <div key={s.key}>
                      {conv !== null && (
                        <div
                          title={overflow
                            ? `${val - prev} ${s.label.toLowerCase()} exist with no ${FUNNEL_STEPS[i - 1].label.toLowerCase()} behind them`
                            : undefined}
                          style={{ textAlign: 'center', fontSize: 11, color: overflow ? C.amber : '#9ca3af', marginBottom: 2 }}
                        >
                          {overflow
                            ? `↕ ${(val - prev).toLocaleString()} more than ${FUNNEL_STEPS[i - 1].label} — entered here`
                            : `↓ ${conv.toFixed(1)}% conversion`}
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ flex: 1, position: 'relative', height: 36 }}>
                          <div style={{
                            width: `${pct}%`, height: '100%', background: s.color, borderRadius: 6, opacity: 0.85,
                            display: 'flex', alignItems: 'center', paddingLeft: 12, minWidth: 60, transition: 'width .3s',
                          }}>
                            <span style={{ color: '#fff', fontWeight: 700, fontSize: 15 }}>{val.toLocaleString()}</span>
                          </div>
                        </div>
                        <span style={{ width: 130, fontSize: 13, color: '#374151', fontWeight: 500 }}>{s.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Conversion Ratios */}
            <div style={{ ...C.card, padding: 24 }}>
              <h3 style={{ margin: '0 0 20px', fontSize: 15, fontWeight: 600 }}>Conversion Ratios</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {Object.entries(RATIO_LABELS).map(([key, label]) => {
                  const v        = convRatios[key];
                  const overflow = typeof v === 'number' && v > 100;
                  // The same step measured along the real foreign keys, with the
                  // share of records that carry one. A linked rate computed over
                  // 1 of 9 quotations is not a conversion rate, so the coverage
                  // it rests on is printed beside it rather than assumed.
                  const lk  = linked?.ratios?.[key];
                  const cov = linked?.coverage?.[LINK_COVERAGE[key]];
                  return (
                    <div key={key}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 13, color: '#374151' }}>{label}</span>
                        {overflow && (
                          <span style={{ fontSize: 11, fontWeight: 700, color: C.amber }}>
                            {v.toFixed(1)}% · stage gained records
                          </span>
                        )}
                      </div>
                      <PctBar
                        value={v ?? null}
                        color={overflow ? C.amber : key === 'enquiry_to_order' ? C.green : key === 'quotation_to_order' ? C.primary : C.blue}
                      />
                      {typeof lk === 'number' && (
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
                          {lk.toFixed(1)}% traced through linked records
                          {typeof cov === 'number' && <> · {cov.toFixed(0)}% of this stage is linked</>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ marginTop: 24, padding: 14, background: C.light, borderRadius: 10 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, fontWeight: 600 }}>KEY INSIGHT</div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>
                  {typeof convRatios.enquiry_to_order === 'number' ? (
                    <>
                      For every <strong>100 enquiries</strong>, you win{' '}
                      <strong style={{ color: C.primary }}>
                        {convRatios.enquiry_to_order.toFixed(0)} orders
                      </strong>.{' '}
                    </>
                  ) : (
                    <>No enquiries recorded yet, so there is no end-to-end rate to report. </>
                  )}
                  {weakestStep && (
                    <>
                      The weakest step is <strong>{RATIO_LABELS[weakestStep.key]}</strong> at{' '}
                      <strong>{weakestStep.value.toFixed(1)}%</strong>.{' '}
                    </>
                  )}
                  {weakestLinkage && (
                    <>
                      Only <strong>{weakestLinkage.value.toFixed(0)}%</strong> of{' '}
                      {LINK_COVERAGE_LABELS[weakestLinkage.key]}, so the step rates above are
                      stage volumes, not traced conversions.
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Salesperson Analytics ────────────────────────────────────────────── */}
      {tab === 'Salesperson Analytics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>Financial Year:</label>
            <select value={fyYear} onChange={e => setFyYear(parseInt(e.target.value))}
              style={{ padding: '6px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13 }}>
              {FY_YEARS.map(y => <option key={y} value={y}>FY {y}-{String(y+1).slice(2)}</option>)}
            </select>
          </div>

          {spPerf.length > 0 ? (
            <>
              {/* Bar chart */}
              <div style={{ ...C.card, padding: 20 }}>
                <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Revenue Achieved per Salesperson</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={spPerf.slice(0, 8)} layout="vertical" margin={{ left: 0, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" horizontal={false} />
                    <XAxis type="number" tickFormatter={fmtINR} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="salesperson_name" tick={{ fontSize: 11 }} width={110} />
                    <Tooltip formatter={v => fmtINR(v)} />
                    <Bar dataKey="achieved" name="Achieved" radius={[0,4,4,0]}>
                      {spPerf.slice(0, 8).map((_, i) => <Cell key={i} fill={`hsl(${260 + i * 20}, 65%, ${55 + i * 3}%)`} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Table */}
              <div style={{ ...C.card, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead style={{ background: C.light }}>
                      <tr>
                        {['Salesperson', 'Target', 'Achieved', 'Achievement %', 'Orders Won', 'Quotes Sent', 'Win Rate'].map(h => (
                          <th key={h} style={{ padding: '10px 14px', textAlign: ['Target','Achieved','Achievement %','Orders Won','Quotes Sent','Win Rate'].includes(h) ? 'right' : 'left', fontWeight: 600, color: '#374151', fontSize: 12 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {spPerf.map((s, i) => {
                        // null = no annual target on file. `|| 0` printed a red
                        // "0.0%" bar against people who had simply never been
                        // given a number to hit.
                        const achPct  = typeof s.achievement_pct === 'number' ? s.achievement_pct : null;
                        const achCol  = achPct === null ? '#9ca3af' : achPct >= 100 ? C.green : achPct >= 70 ? C.amber : C.red;
                        const winRate = s.quotes_sent > 0 ? (s.orders_won / s.quotes_sent) * 100 : null;
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid #f9f9fb', background: s.unattributed ? '#fffbeb' : undefined }}>
                            <td style={{ padding: '10px 14px', fontWeight: 600, color: s.unattributed ? '#92400e' : '#111827' }}>
                              {s.salesperson_name}
                              {s.unattributed && (
                                <div style={{ fontWeight: 400, fontSize: 11, color: '#b45309' }}>
                                  booked orders whose creator has no employee record
                                </div>
                              )}
                            </td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', color: '#374151' }}>{s.unattributed ? '—' : fmtINR(s.annual_target)}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600 }}>{fmtINR(s.achieved)}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                                <div style={{ width: 60, background: '#f3f4f6', borderRadius: 4, height: 6 }}>
                                  {achPct !== null && (
                                    <div style={{ width: `${Math.min(achPct, 100)}%`, background: achCol, height: 6, borderRadius: 4 }} />
                                  )}
                                </div>
                                <span style={{ fontSize: 12, fontWeight: 700, color: achCol, minWidth: 36 }}>
                                  {achPct === null ? '—' : fmtPct(achPct)}
                                </span>
                              </div>
                            </td>
                            <td style={{ padding: '10px 14px', textAlign: 'right' }}>{s.orders_won}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right' }}>{s.quotes_sent || '—'}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: winRate === null ? '#9ca3af' : winRate >= 30 ? C.green : C.amber }}>
                              {winRate === null ? '—' : fmtPct(winRate)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div style={{ ...C.card, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
              <div style={{ fontWeight: 600, color: '#374151' }}>No salesperson targets set for FY {fyYear}</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Go to Sales → Sales Targets to assign individual targets.</div>
            </div>
          )}
        </div>
      )}

      {/* ── Win / Loss Analysis ──────────────────────────────────────────────── */}
      {tab === 'Win / Loss Analysis' && wonLost && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
            <KpiCard label="Opportunities Won" value={wonLost.won} sub={fmtINR(wonLost.won_value)} color={C.green} />
            <KpiCard label="Opportunities Lost" value={wonLost.lost} sub={fmtINR(wonLost.lost_value)} color={C.red} />
            {/* Win rate is over CLOSED deals only — the old "All opportunities"
                sub-label described a denominator this number never used, and
                the open pipeline it implied is now its own card. */}
            <KpiCard
              label="Win Rate"
              value={winRate === null ? '—' : fmtPct(winRate)}
              sub={winRate === null ? 'nothing closed yet' : `of ${totalWon + totalLost} closed deals`}
              color={winRate === null ? '#9ca3af' : winRate >= 30 ? C.green : C.amber}
            />
            <KpiCard label="Still Open" value={totalOpen} sub="not yet won or lost" color={C.primary} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* Lost Reasons */}
            <div style={{ ...C.card, padding: 20 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600, color: C.red }}>Lost Deal Analysis</h3>
              {wonLost.lost_reasons?.length === 0
                ? <div style={{ color: '#9ca3af', textAlign: 'center', paddingTop: 24 }}>No lost deal data yet</div>
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {wonLost.lost_reasons?.map((r, i) => (
                      <div key={i}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>{r.reason}</span>
                          <span style={{ fontSize: 12, color: '#6b7280' }}>{r.count} deals · {fmtINR(r.value)}</span>
                        </div>
                        <PctBar
                          value={wonLost.lost > 0 ? (r.count / wonLost.lost) * 100 : null}
                          color={C.red}
                        />
                      </div>
                    ))}
                  </div>
                )
              }
            </div>

            {/* Salesperson Win Rates */}
            <div style={{ ...C.card, padding: 20 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Win Rate by Salesperson</h3>
              {wonLost.salesperson_win_rates?.length === 0
                ? <div style={{ color: '#9ca3af', textAlign: 'center', paddingTop: 24 }}>No opportunity data yet</div>
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {wonLost.salesperson_win_rates?.map((s, i) => (
                      <div key={i}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontSize: 13, color: '#374151', fontWeight: 600 }}>{s.salesperson}</span>
                          <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#6b7280' }}>
                            <span style={{ color: C.green }}>✓ {s.won}</span>
                            <span style={{ color: C.red }}>✗ {s.lost}</span>
                            <span style={{ fontWeight: 700, color: '#374151' }}>{fmtINR(s.revenue)}</span>
                          </div>
                        </div>
                        <PctBar value={s.win_rate ?? null} color={s.win_rate >= 40 ? C.green : s.win_rate >= 20 ? C.amber : C.red} />
                      </div>
                    ))}
                  </div>
                )
              }
            </div>
          </div>

          {/* Won vs Lost bar chart */}
          {(wonLost.won > 0 || wonLost.lost > 0) && (
            <div style={{ ...C.card, padding: 20 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Revenue: Won vs Lost Opportunities</h3>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={[
                  { name: 'Won', value: wonLost.won_value, fill: '#16a34a' },
                  { name: 'Lost', value: wonLost.lost_value, fill: '#dc2626' },
                ]}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                  <XAxis dataKey="name" />
                  <YAxis tickFormatter={fmtINR} width={75} />
                  <Tooltip formatter={v => fmtINR(v)} />
                  <Bar dataKey="value" radius={[6,6,0,0]}>
                    {[{ fill: '#16a34a' }, { fill: '#dc2626' }].map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* ── Monthly Trends ────────────────────────────────────────────────────── */}
      {tab === 'Monthly Trends' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {monthly.length > 0 ? (
            <>
              {/* Funnel counts trend */}
              <div style={{ ...C.card, padding: 20 }}>
                <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Monthly Funnel Counts (12 months)</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={monthly}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="enquiries"     stroke="#6b7280" name="Enquiries"     dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="leads"         stroke="#3b82f6" name="Leads"         dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="opportunities" stroke="#8b5cf6" name="Opportunities" dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="quotations"    stroke="#6d28d9" name="Quotations"    dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="orders"        stroke="#16a34a" name="Orders"        dot={false} strokeWidth={2} strokeDasharray="5 5" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Revenue trend */}
              <div style={{ ...C.card, padding: 20 }}>
                <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Monthly Revenue (Orders Booked)</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={monthly}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={fmtINR} tick={{ fontSize: 11 }} width={75} />
                    <Tooltip formatter={v => fmtINR(v)} />
                    <Bar dataKey="revenue" name="Revenue" fill={C.primary} radius={[4,4,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Monthly table */}
              <div style={{ ...C.card, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead style={{ background: C.light }}>
                      <tr>
                        {['Month', 'Enquiries', 'Leads', 'Opportunities', 'Quotations', 'Orders', 'Revenue'].map(h => (
                          <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Month' ? 'left' : 'right', fontWeight: 600, color: '#374151', fontSize: 12 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...monthly].reverse().map((m, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f9f9fb' }}>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: '#374151' }}>{m.month}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right' }}>{m.enquiries}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right' }}>{m.leads}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right' }}>{m.opportunities}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right' }}>{m.quotations}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, color: C.green }}>{m.orders}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, color: C.primary }}>{fmtINR(m.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div style={{ ...C.card, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>📈</div>
              <div style={{ fontWeight: 600, color: '#374151' }}>No monthly data yet</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Pipeline activity will appear here as leads, opportunities, and orders are created.</div>
            </div>
          )}
        </div>
      )}

      {/* ── Customer Analytics ───────────────────────────────────────────────── */}
      {tab === 'Customer Analytics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {!customers ? (
            <div style={{ ...C.card, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>👥</div>
              <div style={{ fontWeight: 600, color: '#374151' }}>No customer data yet</div>
            </div>
          ) : (
            <>
              {/* Repeat business */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
                <KpiCard label="Total Customers" value={(customers.repeat_business?.total_customers || 0).toLocaleString()} color={C.blue} />
                <KpiCard label="Repeat Customers" value={(customers.repeat_business?.repeat_customers || 0).toLocaleString()} color={C.green}
                  sub={`${parseFloat(customers.repeat_business?.repeat_pct || 0).toFixed(1)}% repeat rate`} />
                <KpiCard label="Top Customer Rev" value={fmtINR(customers.top_customers?.[0]?.total_revenue || 0)} color={C.primary}
                  sub={customers.top_customers?.[0]?.customer_name} />
              </div>

              {/* Top customers table */}
              <div style={{ ...C.card, overflow: 'hidden' }}>
                <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', fontSize: 14, fontWeight: 700, color: '#374151' }}>Top Customers by Revenue</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead style={{ background: C.light }}>
                      <tr>
                        {['#','Customer','City','Revenue','Margin %','Orders','Win Rate'].map(h => (
                          <th key={h} style={{ padding: '10px 14px', textAlign: ['#','Customer','City'].includes(h) ? 'left' : 'right', fontWeight: 600, color: '#374151', fontSize: 11 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(customers.top_customers || []).slice(0, 15).map((c, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f9f9fb' }}>
                          <td style={{ padding: '9px 14px', color: '#9ca3af', fontWeight: 700 }}>{i + 1}</td>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: '#1f2937' }}>{c.customer_name || '—'}</td>
                          <td style={{ padding: '9px 14px', color: '#6b7280' }}>{c.city || '—'}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: C.green }}>{fmtINR(c.total_revenue)}</td>
                          <td
                            title={c.margin_pct === null
                              ? `No margin recorded: none of this customer's ${c.total_orders} orders trace back to an opportunity`
                              : undefined}
                            style={{ padding: '9px 14px', textAlign: 'right', color: c.margin_pct === null ? '#9ca3af' : c.margin_pct >= 15 ? C.green : C.amber }}
                          >{fmtPct(c.margin_pct)}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'right' }}>{c.total_orders}</td>
                          <td
                            title={c.win_rate === null ? `${c.customer_name || 'This customer'} has no closed opportunities` : undefined}
                            style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, color: c.win_rate === null ? '#9ca3af' : c.win_rate >= 30 ? C.green : C.amber }}
                          >{fmtPct(c.win_rate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Product Analytics ────────────────────────────────────────────────── */}
      {tab === 'Product Analytics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {products.length === 0 ? (
            <div style={{ ...C.card, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>📦</div>
              <div style={{ fontWeight: 600, color: '#374151' }}>No product line data yet</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Tag your opportunities, quotations, and orders with a product line (HVDC, STATCOM, SST, Automation, Services, AMC…)</div>
            </div>
          ) : (
            <>
              {/* Revenue bar */}
              <div style={{ ...C.card, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Revenue by Product Line</div>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={products.slice(0, 8)} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" horizontal={false} />
                    <XAxis type="number" tickFormatter={fmtINR} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="product_line" tick={{ fontSize: 11 }} width={110} />
                    <Tooltip formatter={v => fmtINR(v)} />
                    <Bar dataKey="revenue" name="Revenue" radius={[0, 4, 4, 0]}>
                      {products.slice(0, 8).map((_, i) => (
                        <Cell key={i} fill={PRODUCT_COLORS[i % PRODUCT_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Product table */}
              <div style={{ ...C.card, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead style={{ background: C.light }}>
                      <tr>
                        {['Product Line','Revenue','Orders','Won','Lost','Win Rate','Pipeline (Wtd)'].map(h => (
                          <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Product Line' ? 'left' : 'right', fontWeight: 600, color: '#374151', fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((p, i) => (
                        <tr key={p.product_line} style={{ borderBottom: '1px solid #f9f9fb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                          <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1f2937' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 10, height: 10, borderRadius: '50%', background: PRODUCT_COLORS[i % PRODUCT_COLORS.length], flexShrink: 0 }} />
                              {p.product_line}
                            </div>
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: C.green }}>{fmtINR(p.revenue)}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' }}>{p.orders}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: C.green }}>{p.won}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: C.red }}>{p.lost}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: parseFloat(p.win_rate) >= 30 ? C.green : C.amber }}>{fmtPct(p.win_rate)}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: C.primary }}>{fmtINR(p.pipeline_weighted)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );

  if (embedded) return body;

  return (
    <PageShell dock={
      <PageHero
        icon={BarChart3}
        eyebrow="Sales"
        title="Sales Target & Conversion Analytics"
        subtitle="Funnel conversion, win rates, salesperson performance, and lost deal analysis"
      />
    }>
      {body}
    </PageShell>
  );
}
