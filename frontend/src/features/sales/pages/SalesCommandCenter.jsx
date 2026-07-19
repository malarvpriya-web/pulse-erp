import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, Cell, PieChart, Pie,
} from 'recharts';
import {
  TrendingUp, TrendingDown, Target, Users, ShoppingCart, AlertTriangle,
  Award, Clock, IndianRupee, Activity, ChevronRight, Bell, Filter,
  RefreshCw, Download,
} from 'lucide-react';
import api from '@/services/api/client';

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtCr = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)} L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};
const fmtPct = (n) => `${parseFloat(n || 0).toFixed(1)}%`;

const getFYStart = () => {
  const m = new Date().getMonth();
  return m >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
};
const fyLabel = (y) => `FY ${y}-${String(y + 1).slice(2)}`;

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  primary: '#6B3FDB', light: '#f5f3ff', border: '#e9e4ff',
  green: '#16a34a', red: '#dc2626', amber: '#d97706', blue: '#2563eb',
  card: { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12 },
};

const PRODUCT_COLORS = ['#6B3FDB','#2563eb','#16a34a','#d97706','#ef4444','#06b6d4','#8b5cf6'];

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = C.primary, icon: Icon, trend }) {
  return (
    <div style={{ ...C.card, padding: '18px 20px', position: 'relative', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{label}</div>
          <div style={{ fontSize: 26, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
          {sub && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 5 }}>{sub}</div>}
        </div>
        {Icon && (
          <div style={{ width: 40, height: 40, borderRadius: 10, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon size={20} color={color} />
          </div>
        )}
      </div>
      {trend !== undefined && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          {trend >= 0
            ? <TrendingUp size={13} color={C.green} />
            : <TrendingDown size={13} color={C.red} />}
          <span style={{ color: trend >= 0 ? C.green : C.red, fontWeight: 600 }}>{Math.abs(trend).toFixed(1)}%</span>
          <span style={{ color: '#9ca3af' }}>vs last period</span>
        </div>
      )}
    </div>
  );
}

// ── Achievement Gauge ─────────────────────────────────────────────────────────
function AchievementGauge({ pct }) {
  const v = Math.min(parseFloat(pct || 0), 100);
  const color = v >= 100 ? C.green : v >= 70 ? C.amber : C.red;
  const r = 54; const circ = 2 * Math.PI * r;
  const dash = (v / 100) * circ;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <svg width={130} height={130} viewBox="0 0 130 130">
        <circle cx={65} cy={65} r={r} fill="none" stroke="#f3f4f6" strokeWidth={10} />
        <circle cx={65} cy={65} r={r} fill="none" stroke={color} strokeWidth={10}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeLinecap="round"
          transform="rotate(-90 65 65)" />
        <text x={65} y={60} textAnchor="middle" fontSize={22} fontWeight={700} fill={color}>{v.toFixed(0)}%</text>
        <text x={65} y={78} textAnchor="middle" fontSize={11} fill="#9ca3af">Achievement</text>
      </svg>
    </div>
  );
}

// ── Progress Bar ──────────────────────────────────────────────────────────────
function ProgressBar({ value, max = 100, color = C.primary, height = 8 }) {
  const pct = max > 0 ? Math.min((parseFloat(value) / parseFloat(max)) * 100, 100) : 0;
  return (
    <div style={{ background: '#f3f4f6', borderRadius: height, height, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: height, transition: 'width .4s' }} />
    </div>
  );
}

// ── Severity Badge ────────────────────────────────────────────────────────────
function AlertBadge({ severity }) {
  const map = { critical: [C.red, '#fee2e2'], warning: [C.amber, '#fef3c7'], info: [C.blue, '#dbeafe'] };
  const [col, bg] = map[severity] || map.info;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: bg, color: col, textTransform: 'uppercase' }}>
      {severity}
    </span>
  );
}

const TABS = ['Executive', 'Scorecards', 'Customers', 'Products', 'Lost Deals', 'Traceability', 'Alerts'];

export default function SalesCommandCenter() {
  const [tab,           setTab]           = useState('Executive');
  const [fyYear,        setFyYear]        = useState(getFYStart());
  const [loading,       setLoading]       = useState(true);
  const [summary,       setSummary]       = useState(null);
  const [scorecards,    setScorecards]    = useState([]);
  const [customers,     setCustomers]     = useState(null);
  const [products,      setProducts]      = useState([]);
  const [lostDeals,     setLostDeals]     = useState(null);
  const [traceability,  setTraceability]  = useState([]);
  const [alerts,        setAlerts]        = useState([]);
  const [closures,      setClosures]      = useState([]);
  const [teamTargets,   setTeamTargets]   = useState([]);
  const [monthlyData,   setMonthlyData]   = useState([]);
  const abortRef = useRef(null);
  const FY_YEARS = [getFYStart() + 1, getFYStart(), getFYStart() - 1];

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const [sRes, scRes, cRes, pRes, ldRes, trRes, alRes, clRes, ttRes, mRes] = await Promise.allSettled([
        api.get(`/sales-command-center/summary?fy_year=${fyYear}`,          { signal: ctrl.signal }),
        api.get(`/sales-command-center/salesperson-scorecard?fy_year=${fyYear}`, { signal: ctrl.signal }),
        api.get('/sales-command-center/customer-analytics',                 { signal: ctrl.signal }),
        api.get('/sales-command-center/product-analytics',                  { signal: ctrl.signal }),
        api.get('/sales-command-center/lost-deal-analysis',                 { signal: ctrl.signal }),
        api.get('/sales-command-center/traceability?limit=30',              { signal: ctrl.signal }),
        api.get('/sales-command-center/alerts',                             { signal: ctrl.signal }),
        api.get('/sales-command-center/upcoming-closures?days=30',          { signal: ctrl.signal }),
        api.get(`/sales-command-center/team-targets?fy_year=${fyYear}`,     { signal: ctrl.signal }),
        api.get(`/sales/forecasts/by-month?period_year=${fyYear}`,          { signal: ctrl.signal }),
      ]);
      if (ctrl.signal.aborted) return;
      if (sRes.status === 'fulfilled')  setSummary(sRes.value.data);
      if (scRes.status === 'fulfilled') setScorecards(scRes.value.data || []);
      if (cRes.status === 'fulfilled')  setCustomers(cRes.value.data);
      if (pRes.status === 'fulfilled')  setProducts(pRes.value.data || []);
      if (ldRes.status === 'fulfilled') setLostDeals(ldRes.value.data);
      if (trRes.status === 'fulfilled') setTraceability(trRes.value.data || []);
      if (alRes.status === 'fulfilled') setAlerts(alRes.value.data || []);
      if (clRes.status === 'fulfilled') setClosures(clRes.value.data || []);
      if (ttRes.status === 'fulfilled') setTeamTargets(ttRes.value.data || []);
      if (mRes.status === 'fulfilled')  setMonthlyData(mRes.value.data || []);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [fyYear]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const criticalAlerts = alerts.filter(a => a.severity === 'critical').length;

  // ── Month chart data (India FY Apr-Mar display)
  const MONTH_LABELS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
  const chartData = MONTH_LABELS.map((mo, i) => {
    const calMonth = i < 9 ? i + 4 : i - 8;
    const row = monthlyData.find(r => parseInt(r.month) === calMonth) || {};
    return { month: mo, target: parseFloat(row.target || 0), achieved: parseFloat(row.achieved || 0), forecast: parseFloat(row.forecasted || 0) };
  });

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh', fontFamily: 'inherit' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Sales Command Center</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            CEO · Sales Manager · Salesperson Intelligence — {fyLabel(fyYear)}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {criticalAlerts > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: '#fee2e2', borderRadius: 20, cursor: 'pointer' }}
              onClick={() => setTab('Alerts')}>
              <Bell size={14} color={C.red} />
              <span style={{ fontSize: 12, fontWeight: 700, color: C.red }}>{criticalAlerts} critical</span>
            </div>
          )}
          <select value={fyYear} onChange={e => setFyYear(parseInt(e.target.value))}
            style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', background: '#fff' }}>
            {FY_YEARS.map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
          </select>
          <button onClick={load} style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: `2px solid ${C.border}`, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '9px 18px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
            color: tab === t ? C.primary : '#6b7280',
            borderBottom: tab === t ? `2px solid ${C.primary}` : '2px solid transparent',
            marginBottom: -2,
          }}>
            {t}
            {t === 'Alerts' && alerts.length > 0 && (
              <span style={{ marginLeft: 6, background: criticalAlerts > 0 ? C.red : C.amber, color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 6px' }}>
                {alerts.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <Activity size={32} style={{ marginBottom: 12, opacity: 0.4 }} />
          <div>Loading Sales Intelligence…</div>
        </div>
      )}

      {/* ── EXECUTIVE TAB ──────────────────────────────────────────────────────── */}
      {!loading && tab === 'Executive' && summary && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Top KPI Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
            <KpiCard label="Annual Target"    value={fmtCr(summary.total_target)}    icon={Target}      color={C.primary} sub={fyLabel(fyYear)} />
            <KpiCard label="Revenue Achieved" value={fmtCr(summary.achieved_revenue)} icon={IndianRupee}  color={C.green}   sub={`${summary.achieved_orders} orders`} />
            <KpiCard label="Achievement %"    value={fmtPct(summary.achievement_pct)} icon={Award}       color={summary.achievement_pct >= 100 ? C.green : summary.achievement_pct >= 70 ? C.amber : C.red} sub={`Gap: ${fmtCr(summary.gap_value)}`} />
            <KpiCard label="Pipeline Value"   value={fmtCr(summary.pipeline_value)}   icon={Activity}    color={C.blue}    sub={`${summary.open_opportunities} open deals`} />
            <KpiCard label="Forecast (Wtd)"   value={fmtCr(summary.forecast_value)}   icon={TrendingUp}  color="#8b5cf6"   sub="Probability-weighted" />
            <KpiCard label="Win Rate"         value={fmtPct(summary.win_rate)}         icon={Users}       color={summary.win_rate >= 30 ? C.green : C.amber} sub="Opportunities" />
          </div>

          {/* Gauge + Funnel summary */}
          <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20 }}>
            {/* Achievement gauge */}
            <div style={{ ...C.card, padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 12 }}>Team Achievement</div>
              <AchievementGauge pct={summary.achievement_pct} />
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Target: <strong>{fmtCr(summary.total_target)}</strong></div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Achieved: <strong style={{ color: C.green }}>{fmtCr(summary.achieved_revenue)}</strong></div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Gap: <strong style={{ color: C.red }}>{fmtCr(summary.gap_value)}</strong></div>
              </div>
            </div>

            {/* Funnel stages */}
            <div style={{ ...C.card, padding: 24 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 16 }}>Pipeline Funnel</div>
              {[
                { label: 'Total Leads',       value: summary.total_leads,         color: '#6b7280' },
                { label: 'Opportunities',     value: summary.total_opportunities, color: C.blue },
                { label: 'Quotations Sent',   value: summary.total_quotations,    color: C.amber },
                { label: 'Orders Booked',     value: summary.total_orders,        color: C.green },
              ].map((stage, i) => {
                const max = summary.total_leads || 1;
                return (
                  <div key={stage.label} style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                      <span style={{ fontSize: 13, color: '#6b7280' }}>{stage.label}</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: stage.color }}>{(stage.value || 0).toLocaleString()}</span>
                    </div>
                    <ProgressBar value={stage.value} max={max} color={stage.color} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Target vs Achieved vs Forecast chart */}
          <div style={{ ...C.card, padding: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 16 }}>Monthly: Target vs Achieved vs Forecast — {fyLabel(fyYear)}</div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={fmtCr} tick={{ fontSize: 11 }} width={80} />
                <Tooltip formatter={v => fmtCr(v)} />
                <Legend />
                <Bar dataKey="target"   name="Target"   fill="#e5e7eb" radius={[3,3,0,0]} />
                <Bar dataKey="achieved" name="Achieved" fill={C.green} radius={[3,3,0,0]} />
                <Bar dataKey="forecast" name="Forecast" fill={C.primary} radius={[3,3,0,0]} opacity={0.7} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Team Targets + Upcoming closures */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* Team targets */}
            <div style={{ ...C.card, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Team / Region / BU Targets</div>
              {teamTargets.length === 0 ? (
                <div style={{ color: '#9ca3af', textAlign: 'center', padding: '20px 0', fontSize: 13 }}>
                  No team targets set. Add from Scorecards tab.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {teamTargets.map((t, i) => (
                    <div key={i}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 13, color: '#374151', fontWeight: 600 }}>
                          {t.group_name}
                          <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400, marginLeft: 6 }}>{t.target_type}</span>
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: t.achievement_pct >= 100 ? C.green : t.achievement_pct >= 70 ? C.amber : C.red }}>
                          {fmtPct(t.achievement_pct)}
                        </span>
                      </div>
                      <ProgressBar value={t.achieved_revenue} max={t.target_revenue}
                        color={t.achievement_pct >= 100 ? C.green : t.achievement_pct >= 70 ? C.amber : C.red} />
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>
                        {fmtCr(t.achieved_revenue)} / {fmtCr(t.target_revenue)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Upcoming closures */}
            <div style={{ ...C.card, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Upcoming Closures (30 days)</div>
              {closures.length === 0 ? (
                <div style={{ color: '#9ca3af', textAlign: 'center', padding: '20px 0', fontSize: 13 }}>No upcoming closures</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {closures.slice(0, 6).map((c, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0', borderBottom: i < 5 ? '1px solid #f9f9fb' : 'none' }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937' }}>{c.name}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.customer} · {c.salesperson}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.primary }}>{fmtCr(c.expected_value)}</div>
                        <div style={{ fontSize: 11, color: c.days_to_close <= 7 ? C.red : C.amber }}>
                          {c.days_to_close}d · {c.probability_percentage}%
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── SCORECARDS TAB ─────────────────────────────────────────────────────── */}
      {!loading && tab === 'Scorecards' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {scorecards.length === 0 ? (
            <div style={{ ...C.card, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              <Target size={36} style={{ marginBottom: 12, opacity: 0.3 }} />
              <div style={{ fontWeight: 600, color: '#374151' }}>No scorecards yet</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Set annual targets in Sales → Sales Targets to generate scorecards.</div>
            </div>
          ) : (
            <>
              {/* Top performers summary */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
                {[...scorecards].sort((a, b) => b.achievement_pct - a.achievement_pct).slice(0, 3).map((s, i) => (
                  <div key={s.id} style={{ ...C.card, padding: 18, borderLeft: `4px solid ${[C.green, C.amber, C.primary][i]}` }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, marginBottom: 4 }}>{['TOP PERFORMER', '2ND PLACE', '3RD PLACE'][i]}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#1f2937' }}>{s.name}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{s.designation || '—'}</div>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <div><div style={{ fontSize: 11, color: '#9ca3af' }}>Revenue</div><div style={{ fontSize: 14, fontWeight: 700, color: C.green }}>{fmtCr(s.achieved_revenue)}</div></div>
                      <div><div style={{ fontSize: 11, color: '#9ca3af' }}>Achievement</div><div style={{ fontSize: 14, fontWeight: 700, color: [C.green, C.amber, C.primary][i] }}>{fmtPct(s.achievement_pct)}</div></div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Scorecard table */}
              <div style={{ ...C.card, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead style={{ background: C.light }}>
                      <tr>
                        {['Salesperson','Target Rev','Achieved','Achievement','Gap','Orders Won','Win Rate','Quote CVR','Avg Deal','Pipeline','Commission'].map(h => (
                          <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Salesperson' ? 'left' : 'right', fontWeight: 600, color: '#374151', fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {scorecards.map((s, i) => {
                        const ach = parseFloat(s.achievement_pct || 0);
                        const color = ach >= 100 ? C.green : ach >= 70 ? C.amber : C.red;
                        return (
                          <tr key={s.id} style={{ borderBottom: '1px solid #f9f9fb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                            <td style={{ padding: '10px 14px' }}>
                              <div style={{ fontWeight: 600, color: '#1f2937' }}>{s.name}</div>
                              <div style={{ fontSize: 11, color: '#9ca3af' }}>{s.designation || '—'}</div>
                            </td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6b7280' }}>{fmtCr(s.target_revenue)}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: C.green }}>{fmtCr(s.achieved_revenue)}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                                <div style={{ width: 50, background: '#f3f4f6', borderRadius: 3, height: 5 }}>
                                  <div style={{ width: `${Math.min(ach, 100)}%`, height: 5, background: color, borderRadius: 3 }} />
                                </div>
                                <span style={{ fontWeight: 700, color, minWidth: 36 }}>{fmtPct(ach)}</span>
                              </div>
                            </td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', color: C.red }}>{fmtCr(s.gap_value)}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right' }}>{s.orders_won}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: parseFloat(s.win_rate) >= 30 ? C.green : C.amber }}>{fmtPct(s.win_rate)}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right' }}>{fmtPct(s.quote_conversion_rate)}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right' }}>{fmtCr(s.avg_deal_size)}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', color: C.blue }}>{fmtCr(s.pipeline_value)}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: C.primary }}>{fmtCr(s.commission_earned)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Bottom performers warning */}
              {scorecards.filter(s => parseFloat(s.achievement_pct) < 50).length > 0 && (
                <div style={{ ...C.card, padding: 18, borderLeft: `4px solid ${C.red}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <AlertTriangle size={16} color={C.red} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.red }}>Below 50% Achievement — Action Required</span>
                  </div>
                  {scorecards.filter(s => parseFloat(s.achievement_pct) < 50).map(s => (
                    <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid #f9f9fb' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{s.name}</span>
                      <span style={{ fontSize: 13, color: C.red, fontWeight: 700 }}>{fmtPct(s.achievement_pct)} of {fmtCr(s.target_revenue)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── CUSTOMERS TAB ──────────────────────────────────────────────────────── */}
      {!loading && tab === 'Customers' && customers && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Repeat business KPI */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
            <KpiCard label="Total Customers" value={(customers.repeat_business?.total_customers || 0).toLocaleString()} icon={Users} color={C.blue} />
            <KpiCard label="Repeat Customers" value={(customers.repeat_business?.repeat_customers || 0).toLocaleString()} icon={Award} color={C.green} sub={`${fmtPct(customers.repeat_business?.repeat_pct)} repeat rate`} />
            <KpiCard label="Top Customer Revenue" value={fmtCr(customers.top_customers?.[0]?.total_revenue)} icon={IndianRupee} color={C.primary} sub={customers.top_customers?.[0]?.customer_name} />
          </div>

          {/* Customer categories */}
          {customers.categories?.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div style={{ ...C.card, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Won Revenue by Customer Category</div>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={customers.categories.slice(0, 6)} dataKey="won_value" nameKey="category" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                      {customers.categories.slice(0, 6).map((_, i) => <Cell key={i} fill={PRODUCT_COLORS[i % PRODUCT_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={v => fmtCr(v)} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ ...C.card, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Category Breakdown</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {customers.categories.map((c, i) => (
                    <div key={c.category}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={{ fontSize: 13, color: '#374151', fontWeight: 500 }}>{c.category}</span>
                        <div style={{ display: 'flex', gap: 10, fontSize: 12, color: '#6b7280' }}>
                          <span>{c.won} won of {c.opportunities}</span>
                          <span style={{ fontWeight: 700, color: PRODUCT_COLORS[i % PRODUCT_COLORS.length] }}>{fmtCr(c.won_value)}</span>
                        </div>
                      </div>
                      <ProgressBar value={c.won} max={c.opportunities || 1} color={PRODUCT_COLORS[i % PRODUCT_COLORS.length]} height={6} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Top customers table */}
          <div style={{ ...C.card, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', fontSize: 14, fontWeight: 700, color: '#374151' }}>Top Customers by Revenue</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ background: C.light }}>
                  <tr>
                    {['#','Customer','City','Category','Revenue','Margin','Margin %','Orders','Win Rate','Last Order'].map(h => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: ['#','Customer','City','Category','Last Order'].includes(h) ? 'left' : 'right', fontWeight: 600, color: '#374151', fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customers.top_customers.map((c, i) => (
                    <tr key={c.id || i} style={{ borderBottom: '1px solid #f9f9fb' }}>
                      <td style={{ padding: '10px 14px', color: '#9ca3af', fontWeight: 700 }}>{i + 1}</td>
                      <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1f2937' }}>{c.customer_name || '—'}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{c.city || '—'}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ fontSize: 11, background: '#f0f0f4', padding: '2px 8px', borderRadius: 10, color: '#374151' }}>{c.category || '—'}</span>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: C.green }}>{fmtCr(c.total_revenue)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#374151' }}>{fmtCr(c.total_margin)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: parseFloat(c.margin_pct) >= 15 ? C.green : C.amber }}>{fmtPct(c.margin_pct)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right' }}>{c.total_orders}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: parseFloat(c.win_rate) >= 30 ? C.green : C.amber }}>{fmtPct(c.win_rate)}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{c.last_order_date ? new Date(c.last_order_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── PRODUCTS TAB ───────────────────────────────────────────────────────── */}
      {!loading && tab === 'Products' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {products.length === 0 ? (
            <div style={{ ...C.card, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              <Activity size={36} style={{ marginBottom: 12, opacity: 0.3 }} />
              <div style={{ fontWeight: 600, color: '#374151' }}>No product line data yet</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Tag your opportunities and quotations with a product line (HVDC, STATCOM, SST, etc.)</div>
            </div>
          ) : (
            <>
              {/* Product revenue bar */}
              <div style={{ ...C.card, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Revenue by Product Line</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={products.slice(0, 8)} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" horizontal={false} />
                    <XAxis type="number" tickFormatter={fmtCr} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="product_line" tick={{ fontSize: 11 }} width={110} />
                    <Tooltip formatter={v => fmtCr(v)} />
                    <Bar dataKey="revenue" name="Revenue" radius={[0, 4, 4, 0]}>
                      {products.slice(0, 8).map((_, i) => <Cell key={i} fill={PRODUCT_COLORS[i % PRODUCT_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Product analytics table */}
              <div style={{ ...C.card, overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead style={{ background: C.light }}>
                      <tr>
                        {['Product Line','Revenue','Margin','Margin %','Orders','Won Opp','Lost Opp','Win Rate','Pipeline (Wtd)','Quoted Value'].map(h => (
                          <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Product Line' ? 'left' : 'right', fontWeight: 600, color: '#374151', fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((p, i) => (
                        <tr key={p.product_line} style={{ borderBottom: '1px solid #f9f9fb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                          <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1f2937' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 10, height: 10, borderRadius: '50%', background: PRODUCT_COLORS[i % PRODUCT_COLORS.length] }} />
                              {p.product_line}
                            </div>
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: C.green }}>{fmtCr(p.revenue)}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' }}>{fmtCr(p.margin)}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: parseFloat(p.margin_pct) >= 15 ? C.green : C.amber }}>{fmtPct(p.margin_pct)}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' }}>{p.orders}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: C.green }}>{p.won}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: C.red }}>{p.lost}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: parseFloat(p.win_rate) >= 30 ? C.green : C.amber }}>{fmtPct(p.win_rate)}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: C.primary }}>{fmtCr(p.pipeline_weighted)}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6b7280' }}>{fmtCr(p.quoted_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Win rate by product pie */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                <div style={{ ...C.card, padding: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Revenue Share by Product Line</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={products.filter(p => p.revenue > 0)} dataKey="revenue" nameKey="product_line" cx="50%" cy="50%" outerRadius={75} label={({ name, percent }) => percent > 0.05 ? `${(percent*100).toFixed(0)}%` : ''}>
                        {products.map((_, i) => <Cell key={i} fill={PRODUCT_COLORS[i % PRODUCT_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={v => fmtCr(v)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ ...C.card, padding: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Pipeline by Product Line</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {products.filter(p => p.pipeline_weighted > 0).slice(0, 6).map((p, i) => (
                      <div key={p.product_line}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontSize: 13, color: '#374151' }}>{p.product_line}</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: PRODUCT_COLORS[i % PRODUCT_COLORS.length] }}>{fmtCr(p.pipeline_weighted)}</span>
                        </div>
                        <ProgressBar value={p.pipeline_weighted} max={Math.max(...products.map(x => x.pipeline_weighted || 0), 1)} color={PRODUCT_COLORS[i % PRODUCT_COLORS.length]} height={6} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── LOST DEALS TAB ─────────────────────────────────────────────────────── */}
      {!loading && tab === 'Lost Deals' && lostDeals && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
            <KpiCard label="Total Lost Deals" value={(lostDeals.total_lost || 0).toLocaleString()} icon={TrendingDown} color={C.red} />
            <KpiCard label="Total Lost Value" value={fmtCr(lostDeals.total_lost_value)} icon={IndianRupee} color={C.red} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {/* By reason */}
            <div style={{ ...C.card, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.red, marginBottom: 14 }}>Lost Reasons</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(lostDeals.by_reason || []).map((r, i) => (
                  <div key={r.reason}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontSize: 13, color: '#374151' }}>{r.reason}</span>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>{r.count} deals · {fmtCr(r.lost_value)}</span>
                    </div>
                    <ProgressBar value={r.count} max={lostDeals.total_lost || 1} color={C.red} height={6} />
                  </div>
                ))}
              </div>
            </div>

            {/* By competitor */}
            <div style={{ ...C.card, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Top Competitors</div>
              {(lostDeals.by_competitor || []).length === 0 ? (
                <div style={{ color: '#9ca3af', textAlign: 'center', padding: '20px 0', fontSize: 13 }}>No competitor data. Tag lost opportunities with competitor names.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {lostDeals.by_competitor.map((c, i) => (
                    <div key={c.competitor} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f9f9fb' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 22, height: 22, borderRadius: '50%', background: PRODUCT_COLORS[i % PRODUCT_COLORS.length], display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{c.competitor}</span>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.red }}>{c.deals_lost} deals</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtCr(c.value_lost)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Lost by salesperson */}
          {(lostDeals.by_salesperson || []).length > 0 && (
            <div style={{ ...C.card, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Lost Deals by Salesperson</div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={lostDeals.by_salesperson} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="salesperson" tick={{ fontSize: 11 }} width={110} />
                  <Tooltip formatter={v => `${v} deals`} />
                  <Bar dataKey="lost" fill={C.red} radius={[0, 4, 4, 0]} name="Lost Deals" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Top lost deal list */}
          <div style={{ ...C.card, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', fontSize: 14, fontWeight: 700, color: '#374151' }}>Top Lost Deals</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: C.light }}>
                <tr>
                  {['Deal','Value','Reason','Competitor','Product','Salesperson','Lost On'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(lostDeals.top_lost_deals || []).map((d, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f9f9fb' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1f2937' }}>{d.name}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 700, color: C.red }}>{fmtCr(d.expected_value)}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{d.lost_reason || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{d.competitor || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{d.product_line || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>{d.salesperson || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#9ca3af' }}>{d.lost_at ? new Date(d.lost_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── TRACEABILITY TAB ───────────────────────────────────────────────────── */}
      {!loading && tab === 'Traceability' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ ...C.card, padding: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Filter size={14} color="#6b7280" />
            <span style={{ fontSize: 13, color: '#6b7280' }}>
              CEO Traceability — full pipeline audit trail: Lead → Opportunity → Quotation → Order → Project
            </span>
          </div>
          {traceability.length === 0 ? (
            <div style={{ ...C.card, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              <Clock size={36} style={{ marginBottom: 12, opacity: 0.3 }} />
              <div style={{ fontWeight: 600, color: '#374151' }}>No pipeline data yet</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>As leads are converted through the pipeline, full traceability will appear here.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {traceability.map((t, i) => (
                <div key={t.lead_id || i} style={{ ...C.card, padding: 16 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0, alignItems: 'center', fontSize: 12 }}>
                    {/* Lead */}
                    <div style={{ padding: '4px 10px', background: '#f3f4f6', borderRadius: 6 }}>
                      <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 600 }}>LEAD</div>
                      <div style={{ fontWeight: 600, color: '#374151' }}>{t.lead_name || '—'}</div>
                      <div style={{ color: '#9ca3af' }}>{t.lead_owner || '—'}</div>
                    </div>
                    {t.opportunity_id && <><ChevronRight size={14} color="#d1d5db" style={{ margin: '0 4px' }} />
                    <div style={{ padding: '4px 10px', background: '#ede9fe', borderRadius: 6 }}>
                      <div style={{ fontSize: 10, color: '#6B3FDB', fontWeight: 600 }}>OPPORTUNITY</div>
                      <div style={{ fontWeight: 600, color: '#374151' }}>{t.opportunity_name}</div>
                      <div style={{ color: '#9ca3af' }}>{t.opp_owner} · {fmtCr(t.opportunity_value)}</div>
                    </div></>}
                    {t.quotation_id && <><ChevronRight size={14} color="#d1d5db" style={{ margin: '0 4px' }} />
                    <div style={{ padding: '4px 10px', background: '#fef3c7', borderRadius: 6 }}>
                      <div style={{ fontSize: 10, color: C.amber, fontWeight: 600 }}>QUOTATION</div>
                      <div style={{ fontWeight: 600, color: '#374151' }}>{t.quotation_number}</div>
                      <div style={{ color: '#9ca3af' }}>{t.quotation_owner} · {fmtCr(t.quotation_value)}</div>
                    </div></>}
                    {t.sales_order_id && <><ChevronRight size={14} color="#d1d5db" style={{ margin: '0 4px' }} />
                    <div style={{ padding: '4px 10px', background: '#d1fae5', borderRadius: 6 }}>
                      <div style={{ fontSize: 10, color: C.green, fontWeight: 600 }}>SALES ORDER</div>
                      <div style={{ fontWeight: 600, color: '#374151' }}>{t.order_number}</div>
                      <div style={{ color: '#9ca3af' }}>{t.order_owner} · {fmtCr(t.order_value)}</div>
                    </div></>}
                    {t.project_id && <><ChevronRight size={14} color="#d1d5db" style={{ margin: '0 4px' }} />
                    <div style={{ padding: '4px 10px', background: '#dbeafe', borderRadius: 6 }}>
                      <div style={{ fontSize: 10, color: C.blue, fontWeight: 600 }}>PROJECT</div>
                      <div style={{ fontWeight: 600, color: '#374151' }}>{t.project_code}</div>
                      <div style={{ color: '#9ca3af' }}>{t.project_status}</div>
                    </div></>}
                  </div>
                  {/* Margin info */}
                  {t.order_margin > 0 && (
                    <div style={{ marginTop: 8, fontSize: 11, color: '#9ca3af' }}>
                      Margin: <strong style={{ color: C.green }}>{fmtCr(t.order_margin)}</strong>
                      {t.product_line && <> · Product: <strong style={{ color: C.primary }}>{t.product_line}</strong></>}
                      {t.lead_source && <> · Source: <strong>{t.lead_source}</strong></>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── ALERTS TAB ─────────────────────────────────────────────────────────── */}
      {!loading && tab === 'Alerts' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {alerts.length === 0 ? (
            <div style={{ ...C.card, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              <Bell size={36} style={{ marginBottom: 12, opacity: 0.3 }} />
              <div style={{ fontWeight: 600, color: '#374151' }}>No active alerts</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>All sales targets and pipeline health look good.</div>
            </div>
          ) : (
            alerts.map((a, i) => {
              const bgMap = { critical: '#fff5f5', warning: '#fffbeb', info: '#eff6ff' };
              const borderMap = { critical: C.red, warning: C.amber, info: C.blue };
              return (
                <div key={i} style={{ ...C.card, padding: 16, borderLeft: `4px solid ${borderMap[a.severity] || C.primary}`, background: bgMap[a.severity] || '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <AlertTriangle size={15} color={borderMap[a.severity]} />
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>{a.title}</span>
                    </div>
                    <AlertBadge severity={a.severity} />
                  </div>
                  <div style={{ fontSize: 13, color: '#6b7280', marginLeft: 23 }}>{a.message}</div>
                  {a.entity_type && a.entity_type !== 'system' && (
                    <div style={{ marginLeft: 23, marginTop: 4, fontSize: 11, color: '#9ca3af' }}>
                      {a.entity_type.charAt(0).toUpperCase() + a.entity_type.slice(1)}: {a.entity_name || a.entity_id}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
