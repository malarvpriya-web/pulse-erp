import { useEffect, useState, useCallback, useMemo } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import {
  PieChart, Pie, Cell, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList,
} from 'recharts';
import '@/components/dashboard/dashkit.css';

/* ── formatting ── */
const fmt = (n) => (parseInt(n) || 0).toLocaleString('en-IN');
const fmtNum = (n) => {
  const v = parseFloat(n) || 0;
  return Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
};

const STATUS_COLOR = {
  planned:     { bg: '#fef9c3', color: '#854d0e' },
  released:    { bg: '#e0f2fe', color: '#0369a1' },
  in_progress: { bg: '#dbeafe', color: '#1e40af' },
  on_hold:     { bg: '#fef3c7', color: '#d97706' },
  completed:   { bg: '#dcfce7', color: '#166534' },
  cancelled:   { bg: '#fee2e2', color: '#991b1b' },
};
// Donut slice colors per status (reserved semantic hues, fixed order)
const STATUS_HUE = {
  planned: '#eab308', released: '#0ea5e9', in_progress: '#2563eb',
  on_hold: '#f59e0b', completed: '#10b981', cancelled: '#9ca3af',
};
// Ordinal quality-rating ramp (best → worst)
const RATING_META = [
  { key: 'excellent', label: 'Excellent',    color: '#16a34a' },
  { key: 'good',      label: 'Good',         color: '#84cc16' },
  { key: 'fair',      label: 'Fair',         color: '#f59e0b' },
  { key: 'poor',      label: 'Poor',         color: '#f97316' },
  { key: 'critical',  label: 'Critical',     color: '#ef4444' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'planned', label: 'Planned' },
  { value: 'released', label: 'Released' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const TABS = ['Overview', 'Production Lines', 'Delay Analysis', 'Performance Metrics', 'Detailed Status'];

/* ── small components ── */
function KPICard({ label, value, sub, color, bg, index = 0 }) {
  return (
    <div className="dk-anim" style={{
      background: bg, borderRadius: 11, padding: '13px 15px',
      border: `1px solid ${color}30`, '--dk-i': index,
    }}>
      <div style={{ fontSize: 24, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 12, color: '#374151', fontWeight: 600, marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }) {
  const s = STATUS_COLOR[status] || { bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: s.bg, color: s.color }}>
      {(status || '').replace(/_/g, ' ')}
    </span>
  );
}

function ChartCard({ title, children, subtitle, right }) {
  return (
    <div className="dk-anim" style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 11, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #e9e4ff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 13.5 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{subtitle}</div>}
        </div>
        {right}
      </div>
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

function EmptyChart({ label = 'No data for this period' }) {
  return <div style={{ height: 230, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13 }}>{label}</div>;
}

// Legend row (identity is never color-alone: swatch + label + value)
function Legend({ items }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 10, justifyContent: 'center' }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151' }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: it.color, display: 'inline-block' }} />
          {it.label} <b style={{ color: '#111827' }}>{it.value}</b>
        </span>
      ))}
    </div>
  );
}

export default function ProductionDashboard({ setPage }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('Overview');

  // filters
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (fromDate) params.from_date = fromDate;
      if (toDate) params.to_date = toDate;
      if (statusFilter) params.status = statusFilter;
      const res = await api.get('/production/dashboard', { params });
      setData(res.data);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to load production dashboard');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // initial load only; filters applied via Refresh

  const criticalDays = data?.config?.critical_days ?? 7;

  const statusChart = useMemo(() => (data?.status_distribution || [])
    .filter(s => s.count > 0)
    .map(s => ({ name: (s.status || '').replace(/_/g, ' '), value: s.count, color: STATUS_HUE[s.status] || '#9ca3af' })),
  [data]);

  const ratingChart = useMemo(() => {
    const rd = data?.rating_distribution || {};
    return RATING_META.map(m => ({ name: m.label, value: rd[m.key] || 0, color: m.color })).filter(r => r.value > 0);
  }, [data]);

  if (loading) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚙️</div>
        Loading Production Dashboard…
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>
        Failed to load dashboard. <button onClick={load} style={{ color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Retry</button>
      </div>
    );
  }

  const { kpis, delayed_orders = [], material_shortage = [], capacity_utilization = [], recent_orders = [] } = data;

  return (
    <div style={{ padding: '16px 18px 24px', background: '#f8f7ff', minHeight: '100vh' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#1f2937' }}>Advanced Production Dashboard</h2>
          <p style={{ margin: 0, fontSize: 12.5, color: '#6b7280' }}>
            Live manufacturing status · each batch = one production order
          </p>
        </div>
        <button onClick={() => setPage('ProductionOrders')}
          style={{ padding: '7px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          + New Order
        </button>
      </div>

      {/* ── Delay Alert Banner (only when delayed batches exist) ── */}
      {delayed_orders.length > 0 && (
        <div className="dk-anim" style={{ background: '#fef2f2', border: '1px solid #fecaca', borderLeft: '4px solid #dc2626', borderRadius: 10, padding: '11px 15px', marginBottom: 12, '--dk-i': 0 }}>
          <div style={{ fontWeight: 700, color: '#dc2626', fontSize: 13.5, marginBottom: 7, display: 'flex', alignItems: 'center', gap: 6 }}>
            🚨 Production Delay Alert — {delayed_orders.length} batch{delayed_orders.length > 1 ? 'es' : ''} overdue
            <span style={{ fontWeight: 500, color: '#991b1b', fontSize: 12 }}>
              · batches over {criticalDays} days late are Critical and will be stopped if not completed by their deadline
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {delayed_orders.slice(0, 6).map((o) => {
              const crit = o.days_delayed > criticalDays;
              return (
                <span key={o.id} style={{
                  background: '#fff', border: `1px solid ${crit ? '#dc2626' : '#fecaca'}`, borderRadius: 6,
                  padding: '4px 10px', fontSize: 12, color: '#991b1b', fontWeight: 600,
                }}>
                  <b style={{ color: '#dc2626' }}>{o.production_order_no}</b> · {o.days_delayed}d late · due {fmtDate(o.planned_end_date)}
                  {crit && <span style={{ marginLeft: 6, background: '#dc2626', color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 10 }}>CRITICAL</span>}
                </span>
              );
            })}
            {delayed_orders.length > 6 && (
              <button onClick={() => setTab('Delay Analysis')} style={{ fontSize: 12, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}>
                +{delayed_orders.length - 6} more →
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Filter Bar ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
        <Field label="From date">
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="To date">
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Status">
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ ...inputStyle, minWidth: 150 }}>
            {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <button onClick={load} style={{ padding: '8px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          ↻ Refresh Dashboard
        </button>
        {(fromDate || toDate || statusFilter) && (
          <button onClick={() => { setFromDate(''); setToDate(''); setStatusFilter(''); setTimeout(load, 0); }}
            style={{ padding: '8px 14px', background: '#f0ebff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Clear
          </button>
        )}
      </div>

      {/* ── KPI Strip (6, color-coded) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 14 }}>
        <KPICard index={0} label="Total Batches"    value={fmt(kpis.total)}          color="#6366f1" bg="#eef2ff" />
        <KPICard index={1} label="In Production"    value={fmt(kpis.in_production)}  color="#8b5cf6" bg="#f5f3ff" />
        <KPICard index={2} label="Delayed"          value={fmt(kpis.delayed)}        color="#f59e0b" bg="#fffbeb" />
        <KPICard index={3} label={`Critical (>${criticalDays}d)`} value={fmt(kpis.critical)} color="#ef4444" bg="#fef2f2" />
        <KPICard index={4} label="Completion Rate"  value={`${kpis.completion_rate}%`} color="#10b981" bg="#ecfdf5" sub={`${fmt(kpis.completed)} completed`} />
        <KPICard index={5} label="On Schedule"      value={fmt(kpis.on_schedule)}    color="#2563eb" bg="#eff6ff" />
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e9e4ff', marginBottom: 14 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '9px 16px', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: 700,
            color: tab === t ? '#6B3FDB' : '#6b7280',
            borderBottom: tab === t ? '2px solid #6B3FDB' : '2px solid transparent',
            marginBottom: -1,
          }}>
            {t}
            {t === 'Delay Analysis' && delayed_orders.length > 0 && (
              <span style={{ marginLeft: 6, background: '#fee2e2', color: '#dc2626', borderRadius: 10, padding: '1px 7px', fontSize: 11 }}>{delayed_orders.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      {tab === 'Overview' && (
        <OverviewTab data={data} statusChart={statusChart} ratingChart={ratingChart}
          capacity_utilization={capacity_utilization} material_shortage={material_shortage}
          recent_orders={recent_orders} setPage={setPage} />
      )}
      {tab === 'Production Lines' && <ProductionLinesTab data={data} />}
      {tab === 'Delay Analysis' && <DelayAnalysisTab delayed={delayed_orders} criticalDays={criticalDays} />}
      {tab === 'Performance Metrics' && <PerformanceTab perf={data.performance || {}} />}
      {tab === 'Detailed Status' && <DetailedStatusTab rows={data.detailed_status || []} criticalDays={criticalDays} setPage={setPage} />}
    </div>
  );
}

/* ═══════════════════ OVERVIEW TAB ═══════════════════ */
function OverviewTab({ data, statusChart, ratingChart, capacity_utilization, material_shortage, recent_orders, setPage }) {
  const moduleChart = (data.module_output || []).slice(0, 8);
  const dailyChart = (data.daily_output || []).map(d => ({ ...d, label: fmtDate(d.day) }));
  const totalStatus = statusChart.reduce((a, b) => a + b.value, 0);
  const totalRating = ratingChart.reduce((a, b) => a + b.value, 0);

  return (
    <>
      {/* Row 1: two donuts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <ChartCard title="Production Status Distribution" subtitle="Batches by current status">
          {totalStatus === 0 ? <EmptyChart /> : (
            <>
              <ResponsiveContainer width="100%" height={230}>
                <PieChart>
                  <Pie data={statusChart} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={58} outerRadius={88} paddingAngle={2} stroke="#fff" strokeWidth={2}>
                    {statusChart.map((e, i) => <Cell key={i} fill={e.color} />)}
                    <LabelList dataKey="value" position="outside" style={{ fontSize: 11, fill: '#374151', fontWeight: 600 }} />
                  </Pie>
                  <Tooltip formatter={(v, n) => [v, n]} />
                </PieChart>
              </ResponsiveContainer>
              <Legend items={statusChart.map(s => ({ label: s.name, value: s.value, color: s.color }))} />
            </>
          )}
        </ChartCard>

        <ChartCard title="Quality Rating Distribution" subtitle="Batches by test pass-rate band">
          {totalRating === 0 ? <EmptyChart label="No quality test results yet" /> : (
            <>
              <ResponsiveContainer width="100%" height={230}>
                <PieChart>
                  <Pie data={ratingChart} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={58} outerRadius={88} paddingAngle={2} stroke="#fff" strokeWidth={2}>
                    {ratingChart.map((e, i) => <Cell key={i} fill={e.color} />)}
                    <LabelList dataKey="value" position="outside" style={{ fontSize: 11, fill: '#374151', fontWeight: 600 }} />
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <Legend items={ratingChart.map(s => ({ label: s.name, value: s.value, color: s.color }))} />
            </>
          )}
        </ChartCard>
      </div>

      {/* Row 2: module bar + daily line */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <ChartCard title="Module / Product Output" subtitle="Batches per product code (top 8)">
          {moduleChart.length === 0 ? <EmptyChart /> : (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={moduleChart} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                <CartesianGrid horizontal={false} stroke="#f0ebff" />
                <XAxis type="number" tick={{ fontSize: 11, fill: '#6b7280' }} allowDecimals={false} />
                <YAxis type="category" dataKey="product_name" width={110} tick={{ fontSize: 11, fill: '#374151' }} />
                <Tooltip formatter={(v) => [v, 'Batches']} />
                <Bar dataKey="orders" fill="#6B3FDB" radius={[0, 4, 4, 0]} barSize={16}>
                  <LabelList dataKey="orders" position="right" style={{ fontSize: 11, fill: '#374151', fontWeight: 600 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Daily Production Output" subtitle="Units completed per day (last 30 days)">
          {dailyChart.length === 0 ? <EmptyChart /> : (
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={dailyChart} margin={{ left: 4, right: 16, top: 8, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke="#f0ebff" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#6b7280' }} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} allowDecimals={false} />
                <Tooltip formatter={(v, n) => [v, n === 'units' ? 'Units' : 'Operations']} />
                <Line type="monotone" dataKey="units" name="Units" stroke="#6B3FDB" strokeWidth={2} dot={{ r: 3, fill: '#6B3FDB' }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      {/* Row 3: resource utilization horizontal bars */}
      <ChartCard title="Resource Utilization" subtitle="Weekly capacity load per work centre / production line">
        {capacity_utilization.length === 0 ? (
          <div style={{ padding: 8, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No work centres configured</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {capacity_utilization.map(wc => {
              const pct = wc.utilization_pct || 0;
              const barColor = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#10b981';
              return (
                <div key={wc.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1f2937' }}>{wc.name}</span>
                    <span style={{ fontSize: 11.5, color: '#6b7280' }}>{fmtNum(wc.week_load)} / {fmtNum(wc.week_capacity)} hrs · <b style={{ color: barColor }}>{pct}%</b></span>
                  </div>
                  <div style={{ height: 9, background: '#f0ebff', borderRadius: 5, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: barColor, borderRadius: 5 }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ChartCard>

      {/* Row 4: shortage + recent */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <ChartCard title="Material Shortage" subtitle={`${material_shortage.length} item(s) not fully issued`}>
          {material_shortage.length === 0 ? (
            <div style={{ padding: 8, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No material shortages</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {material_shortage.slice(0, 8).map((m, i) => (
                <span key={i} style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
                  {m.item_name} ({fmtNum(parseFloat(m.qty_required || 0) - parseFloat(m.qty_issued || 0))} short)
                </span>
              ))}
            </div>
          )}
        </ChartCard>

        <ChartCard title="Recent Batches" right={
          <button onClick={() => setPage('ProductionOrders')} style={{ fontSize: 11, color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>View All →</button>
        }>
          {recent_orders.length === 0 ? (
            <div style={{ padding: 8, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No production orders yet</div>
          ) : (
            <div>
              {recent_orders.map(o => (
                <div key={o.id} style={{ padding: '7px 0', borderBottom: '1px solid #f0ebff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700, color: '#6B3FDB', fontSize: 13 }}>{o.production_order_no}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{o.product_name} · Qty {fmtNum(o.quantity_planned)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <StatusBadge status={o.status} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{fmtDate(o.planned_end_date)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ChartCard>
      </div>
    </>
  );
}

/* ═══════════════════ PRODUCTION LINES TAB ═══════════════════ */
function ProductionLinesTab({ data }) {
  const lines = data.production_lines || [];
  const cap = data.capacity_utilization || [];
  const capById = Object.fromEntries(cap.map(c => [c.id, c]));

  if (lines.length === 0) return <ChartCard title="Production Lines"><EmptyChart label="No work centres / production lines configured" /></ChartCard>;

  return (
    <ChartCard title="Production Lines — live load & capacity" subtitle="Active, queued and completed operations per line">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e9e4ff' }}>
              <th style={th}>Production Line</th>
              <th style={thC}>In Progress</th>
              <th style={thC}>Queued</th>
              <th style={thC}>Completed</th>
              <th style={{ ...th, minWidth: 200 }}>Weekly Utilization</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(l => {
              const c = capById[l.id] || {};
              const pct = c.utilization_pct || 0;
              const barColor = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#10b981';
              return (
                <tr key={l.id} style={{ borderBottom: '1px solid #f5f3ff' }}>
                  <td style={{ ...td, fontWeight: 600, color: '#1f2937' }}>{l.name}</td>
                  <td style={tdC}><Pill n={l.active_ops} color="#2563eb" bg="#eff6ff" /></td>
                  <td style={tdC}><Pill n={l.queued_ops} color="#d97706" bg="#fffbeb" /></td>
                  <td style={tdC}><Pill n={l.done_ops} color="#166534" bg="#ecfdf5" /></td>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 8, background: '#f0ebff', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: barColor, borderRadius: 4 }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: barColor, minWidth: 34 }}>{pct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

/* ═══════════════════ DELAY ANALYSIS TAB ═══════════════════ */
function DelayAnalysisTab({ delayed, criticalDays }) {
  if (delayed.length === 0) {
    return <ChartCard title="Delay Analysis"><div style={{ padding: 20, textAlign: 'center', color: '#16a34a', fontSize: 14, fontWeight: 600 }}>✓ No delayed batches — all on schedule</div></ChartCard>;
  }
  const critical = delayed.filter(o => o.days_delayed > criticalDays);
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
        <KPICard label="Delayed Batches" value={fmt(delayed.length)} color="#f59e0b" bg="#fffbeb" />
        <KPICard label={`Critical (>${criticalDays}d)`} value={fmt(critical.length)} color="#ef4444" bg="#fef2f2" />
        <KPICard label="Worst Delay" value={`${delayed[0]?.days_delayed || 0}d`} color="#dc2626" bg="#fef2f2" />
      </div>
      <ChartCard title="Delayed Batches" subtitle={`Overdue beyond planned end date · Critical after ${criticalDays} days`}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e9e4ff' }}>
                <th style={th}>Batch</th>
                <th style={th}>Product</th>
                <th style={thC}>Status</th>
                <th style={thC}>Due Date</th>
                <th style={thC}>Days Late</th>
                <th style={thC}>Severity</th>
              </tr>
            </thead>
            <tbody>
              {delayed.map(o => {
                const crit = o.days_delayed > criticalDays;
                return (
                  <tr key={o.id} style={{ borderBottom: '1px solid #f5f3ff' }}>
                    <td style={{ ...td, fontWeight: 700, color: '#6B3FDB' }}>{o.production_order_no}</td>
                    <td style={td}>{o.product_name}</td>
                    <td style={tdC}><StatusBadge status={o.status} /></td>
                    <td style={tdC}>{fmtDate(o.planned_end_date)}</td>
                    <td style={{ ...tdC, fontWeight: 700, color: crit ? '#dc2626' : '#d97706' }}>{o.days_delayed}d</td>
                    <td style={tdC}>
                      <span style={{ background: crit ? '#dc2626' : '#fef3c7', color: crit ? '#fff' : '#d97706', borderRadius: 5, padding: '2px 9px', fontSize: 11, fontWeight: 700 }}>
                        {crit ? 'CRITICAL' : 'Delayed'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </>
  );
}

/* ═══════════════════ PERFORMANCE METRICS TAB ═══════════════════ */
function PerformanceTab({ perf }) {
  const tiles = [
    { label: 'Completed Orders', value: fmt(perf.completed_orders), color: '#6366f1', bg: '#eef2ff', sub: 'in selected range' },
    { label: 'On-Time Delivery', value: `${perf.on_time_rate || 0}%`, color: '#10b981', bg: '#ecfdf5', sub: `${fmt(perf.on_time)} of ${fmt(perf.completed_orders)}` },
    { label: 'Avg Cycle Time', value: `${fmtNum(perf.avg_cycle_hrs)}h`, color: '#2563eb', bg: '#eff6ff', sub: 'start → finish' },
    { label: 'Yield Rate', value: `${perf.yield_rate ?? 0}%`, color: '#059669', bg: '#ecfdf5', sub: `${fmtNum(perf.units_produced)} good units` },
    { label: 'Scrap Rate', value: `${perf.scrap_rate ?? 0}%`, color: '#ef4444', bg: '#fef2f2', sub: `${fmtNum(perf.units_scrapped)} scrapped` },
    { label: 'Quality Pass Rate', value: perf.quality_pass_rate == null ? '—' : `${perf.quality_pass_rate}%`, color: '#8b5cf6', bg: '#f5f3ff', sub: perf.quality_tested ? `${fmt(perf.quality_tested)} tests` : 'no tests recorded' },
  ];
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 12 }}>
        {tiles.map((t, i) => <KPICard key={t.label} index={i} {...t} />)}
      </div>
      <ChartCard title="Throughput & Quality" subtitle="Good vs scrapped units and delivery reliability for completed batches">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 24, padding: '4px 8px' }}>
          <Meter label="Yield" pct={perf.yield_rate ?? 0} good detail={`${fmtNum(perf.units_produced)} good / ${fmtNum(perf.units_scrapped)} scrap`} />
          <Meter label="On-time delivery" pct={perf.on_time_rate ?? 0} good detail={`${fmt(perf.on_time)} of ${fmt(perf.completed_orders)} completed on time`} />
        </div>
      </ChartCard>
    </>
  );
}

function Meter({ label, pct, good, detail }) {
  const color = good ? (pct >= 90 ? '#10b981' : pct >= 70 ? '#f59e0b' : '#ef4444') : '#6B3FDB';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#1f2937' }}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 800, color }}>{pct}%</span>
      </div>
      <div style={{ height: 11, background: '#f0ebff', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: color, borderRadius: 6 }} />
      </div>
      <div style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 4 }}>{detail}</div>
    </div>
  );
}

/* ═══════════════════ DETAILED STATUS TAB ═══════════════════ */
function DetailedStatusTab({ rows, criticalDays, setPage }) {
  if (rows.length === 0) return <ChartCard title="Detailed Status"><EmptyChart label="No production orders match the filter" /></ChartCard>;
  return (
    <ChartCard title="Detailed Batch Status" subtitle={`${rows.length} batch(es)`} right={
      <button onClick={() => setPage('ProductionOrders')} style={{ fontSize: 11, color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Open Orders →</button>
    }>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e9e4ff' }}>
              <th style={th}>Batch</th>
              <th style={th}>Product</th>
              <th style={thC}>Status</th>
              <th style={thC}>Qty</th>
              <th style={{ ...th, minWidth: 150 }}>Operation Progress</th>
              <th style={thC}>End Date</th>
              <th style={thC}>Delay</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(o => {
              const totalOps = parseInt(o.total_ops) || 0;
              const doneOps = parseInt(o.done_ops) || 0;
              const pct = totalOps > 0 ? Math.round((doneOps / totalOps) * 100) : 0;
              const crit = o.days_delayed > criticalDays;
              return (
                <tr key={o.id} style={{ borderBottom: '1px solid #f5f3ff' }}>
                  <td style={{ ...td, fontWeight: 700, color: '#6B3FDB' }}>{o.production_order_no}</td>
                  <td style={td}>{o.product_name}</td>
                  <td style={tdC}><StatusBadge status={o.status} /></td>
                  <td style={tdC}>{fmtNum(o.quantity_completed)}/{fmtNum(o.quantity_planned)}</td>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 7, background: '#f0ebff', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: '#6B3FDB', borderRadius: 4 }} />
                      </div>
                      <span style={{ fontSize: 11, color: '#6b7280', minWidth: 44 }}>{doneOps}/{totalOps}</span>
                    </div>
                  </td>
                  <td style={tdC}>{fmtDate(o.planned_end_date)}</td>
                  <td style={tdC}>
                    {o.days_delayed > 0
                      ? <span style={{ color: crit ? '#dc2626' : '#d97706', fontWeight: 700 }}>{o.days_delayed}d</span>
                      : <span style={{ color: '#16a34a' }}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

/* ── tiny helpers ── */
function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}
function Pill({ n, color, bg }) {
  return <span style={{ background: bg, color, borderRadius: 6, padding: '2px 10px', fontSize: 12, fontWeight: 700, minWidth: 28, display: 'inline-block', textAlign: 'center' }}>{fmt(n)}</span>;
}

const inputStyle = { padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, color: '#1f2937', background: '#fff' };
const th = { padding: '8px 10px', fontWeight: 600 };
const thC = { ...th, textAlign: 'center' };
const td = { padding: '9px 10px', color: '#374151' };
const tdC = { ...td, textAlign: 'center' };
