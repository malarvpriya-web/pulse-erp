// frontend/src/features/crm/pages/CustomerHealthDashboard.jsx
// Phase 49F — Customer Health Score Engine — CEO/Management Command Center
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from 'recharts';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  excellent: '#16a34a',
  good:      '#2563eb',
  watchlist: '#d97706',
  critical:  '#dc2626',
  primary:   '#6B3FDB',
  border:    '#e9e4ff',
  surface:   '#f8f7fd',
  card:      { background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 14 },
};

const STATUS_COLOR = {
  Excellent: C.excellent,
  Good:      C.good,
  Watchlist: C.watchlist,
  Critical:  C.critical,
};

const RISK_COLOR = {
  low:      { bg: '#dcfce7', color: '#16a34a' },
  medium:   { bg: '#fef9c3', color: '#854d0e' },
  high:     { bg: '#fee2e2', color: '#dc2626' },
  critical: { bg: '#fce7f3', color: '#9d174d' },
};

const SEGMENT_COLOR = {
  'Strategic':     { bg: '#ede9fe', color: '#6B3FDB' },
  'Key Account':   { bg: '#dbeafe', color: '#2563eb' },
  'Growth Account':{ bg: '#dcfce7', color: '#16a34a' },
  'Standard Account': { bg: '#f3f4f6', color: '#374151' },
  'At-Risk Account':  { bg: '#fee2e2', color: '#dc2626' },
};

const fmtINR = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)} L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toLocaleString('en-IN')}`;
};

// ── Reusable components ───────────────────────────────────────────────────────

function KPICard({ label, count, color, icon, onClick, active, index = 0 }) {
  return (
    <div
      onClick={onClick}
      className="dk-anim"
      style={{
        ...C.card,
        cursor: 'pointer',
        borderColor: active ? color : '#e9e4ff',
        borderWidth: active ? 2 : 1,
        transition: 'all .15s',
        flex: 1,
        '--dk-i': index,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>
        <span style={{ fontSize: 12.5, color: '#6b7280', fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{count}</div>
    </div>
  );
}

function Badge({ label, colors }) {
  const s = colors || { bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{
      padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: s.bg, color: s.color,
    }}>{label}</span>
  );
}

function ScoreBar({ score, max = 100 }) {
  const pct  = Math.min(100, (score / max) * 100);
  const color = score >= 90 ? C.excellent : score >= 75 ? C.good : score >= 50 ? C.watchlist : C.critical;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width .5s', borderRadius: 4 }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color, minWidth: 28, textAlign: 'right' }}>{score}</span>
    </div>
  );
}

function DimensionBar({ label, value, max }) {
  const pct   = Math.min(100, (value / max) * 100);
  const color = pct >= 80 ? C.excellent : pct >= 60 ? C.good : pct >= 40 ? C.watchlist : C.critical;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: '#6b7280' }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color }}>{value}/{max}</span>
      </div>
      <div style={{ height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}

function AlertSeverityIcon({ severity }) {
  return (
    <span style={{
      fontSize: 18,
      filter: severity === 'critical' ? 'drop-shadow(0 0 4px #dc2626)' : 'none',
    }}>
      {severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️'}
    </span>
  );
}

// ── CUSTOMER DETAIL DRAWER ────────────────────────────────────────────────────
function CustomerDetailDrawer({ customer, onClose }) {
  const [detail, setDetail]   = useState(null);
  const [trend, setTrend]     = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!customer) return;
    setLoading(true);
    Promise.all([
      api.get(`/crm/health-engine/customer/${customer.customer_id}`).catch(() => ({ data: null })),
      api.get(`/crm/health-engine/customer/${customer.customer_id}/trend`).catch(() => ({ data: [] })),
    ]).then(([d, t]) => {
      setDetail(d.data);
      setTrend(Array.isArray(t.data) ? t.data : []);
      setLoading(false);
    });
  }, [customer?.customer_id]);

  if (!customer) return null;

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0, width: 480,
      background: '#fff', boxShadow: '-4px 0 20px rgba(0,0,0,.12)',
      zIndex: 1000, overflowY: 'auto', padding: 24,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{customer.customer_name}</h2>
        <button onClick={onClose}
          style={{ border: 'none', background: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
      </div>

      {loading ? (
        <div style={{ color: '#9ca3af', textAlign: 'center', paddingTop: 40 }}>Loading...</div>
      ) : (
        <>
          {/* Score Ring */}
          <div style={{ textAlign: 'center', padding: '20px 0', marginBottom: 16 }}>
            <div style={{
              width: 120, height: 120, borderRadius: '50%', margin: '0 auto',
              background: `conic-gradient(${STATUS_COLOR[customer.health_status] || '#9ca3af'} ${customer.health_score}%, #f3f4f6 0)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                width: 90, height: 90, borderRadius: '50%', background: '#fff',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: STATUS_COLOR[customer.health_status] }}>
                  {customer.health_score}
                </div>
                <div style={{ fontSize: 10, color: '#6b7280' }}>/ 100</div>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <Badge label={customer.health_status}
                colors={RISK_COLOR[customer.health_status?.toLowerCase()] || { bg: '#f3f4f6', color: '#374151' }} />
              &nbsp;
              <Badge label={customer.segment || 'Standard'}
                colors={SEGMENT_COLOR[customer.segment] || { bg: '#f3f4f6', color: '#374151' }} />
            </div>
          </div>

          {/* CEO Traceability: 8 Questions (49F-25) */}
          <div style={{ ...C.card, marginBottom: 16, padding: 16 }}>
            <h4 style={{ margin: '0 0 12px', fontSize: 13, color: '#374151' }}>CEO Traceability</h4>
            {[
              ['Is customer healthy?', customer.health_score >= 75 ? '✅ Yes' : customer.health_score >= 50 ? '⚠️ Watchlist' : '❌ No', customer.health_score >= 75 ? C.excellent : customer.health_score >= 50 ? C.watchlist : C.critical],
              ['Growing?', detail?.scores?.revenue >= 15 ? '✅ Yes' : detail?.scores?.revenue >= 8 ? '→ Stable' : '↓ Declining', detail?.scores?.revenue >= 15 ? C.excellent : C.watchlist],
              ['Profitable?', detail?.scores?.margin >= 10 ? '✅ Yes' : detail?.scores?.margin >= 5 ? '⚠️ Low' : '❌ No', detail?.scores?.margin >= 10 ? C.excellent : C.critical],
              ['Paying on time?', detail?.scores?.collection >= 18 ? '✅ Yes' : detail?.scores?.collection >= 10 ? '⚠️ Delays' : '❌ No', detail?.scores?.collection >= 18 ? C.excellent : C.critical],
              ['Quality issues?', detail?.scores?.quality >= 8 ? '✅ None' : detail?.scores?.quality >= 4 ? '⚠️ Minor' : '❌ Repeated', detail?.scores?.quality >= 8 ? C.excellent : C.critical],
              ['Happy with service?', detail?.scores?.service >= 8 ? '✅ Yes' : detail?.scores?.service >= 4 ? '⚠️ Average' : '❌ No', detail?.scores?.service >= 8 ? C.excellent : C.critical],
              ['Likely to renew AMC?', detail?.scores?.amc >= 4 ? '✅ Yes' : '⚠️ At Risk', detail?.scores?.amc >= 4 ? C.excellent : C.watchlist],
              ['Likely next order?', detail?.scores?.revenue >= 12 && detail?.scores?.collection >= 15 ? '✅ Yes' : '⚠️ Uncertain', detail?.scores?.revenue >= 12 ? C.excellent : C.watchlist],
            ].map(([q, a, color]) => (
              <div key={q} style={{
                display: 'flex', justifyContent: 'space-between', padding: '6px 0',
                borderBottom: '1px solid #f3f4f6', fontSize: 12,
              }}>
                <span style={{ color: '#6b7280' }}>{q}</span>
                <span style={{ fontWeight: 600, color }}>{a}</span>
              </div>
            ))}
          </div>

          {/* Dimension Scores */}
          <div style={{ ...C.card, marginBottom: 16, padding: 16 }}>
            <h4 style={{ margin: '0 0 12px', fontSize: 13, color: '#374151' }}>Score Breakdown</h4>
            <DimensionBar label="Revenue"     value={customer.revenue_score    || 0} max={20} />
            <DimensionBar label="Collections" value={customer.collection_score || 0} max={20} />
            <DimensionBar label="Margin"      value={customer.margin_score     || 0} max={15} />
            <DimensionBar label="Projects"    value={customer.project_score    || 0} max={10} />
            <DimensionBar label="Quality"     value={customer.quality_score    || 0} max={10} />
            <DimensionBar label="Service"     value={customer.service_score    || 0} max={10} />
            <DimensionBar label="AMC"         value={customer.amc_score        || 0} max={5}  />
            <DimensionBar label="Engagement"  value={customer.engagement_score || 0} max={5}  />
            <DimensionBar label="Risk"        value={customer.risk_score       || 0} max={5}  />
          </div>

          {/* Manifest metrics (49F-23) */}
          {(customer.fat_success_pct !== null || customer.sat_success_pct !== null) && (
            <div style={{ ...C.card, marginBottom: 16, padding: 16 }}>
              <h4 style={{ margin: '0 0 12px', fontSize: 13, color: '#374151' }}>Manifest Metrics</h4>
              {[
                ['FAT Success', customer.fat_success_pct != null ? `${customer.fat_success_pct}%` : '—'],
                ['SAT Success', customer.sat_success_pct != null ? `${customer.sat_success_pct}%` : '—'],
                ['Commissioning Success', customer.commissioning_success_pct != null ? `${customer.commissioning_success_pct}%` : '—'],
                ['Warranty Claims', customer.warranty_claims_count ?? '—'],
                ['AMC Renewal Rate', customer.amc_renewal_pct != null ? `${customer.amc_renewal_pct}%` : '—'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12, borderBottom: '1px solid #f3f4f6' }}>
                  <span style={{ color: '#6b7280' }}>{k}</span>
                  <span style={{ fontWeight: 600 }}>{v}</span>
                </div>
              ))}
            </div>
          )}

          {/* 12-Month Trend */}
          {trend.length > 0 && (
            <div style={{ ...C.card, padding: 16 }}>
              <h4 style={{ margin: '0 0 12px', fontSize: 13, color: '#374151' }}>12-Month Trend</h4>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={trend.map(t => ({
                  month: new Date(t.snapshot_month).toLocaleString('en-IN', { month: 'short', year: '2-digit' }),
                  score: t.health_score,
                  status: t.health_status,
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v, n, p) => [`${v}  ${p.payload.status}`, 'Health Score']} />
                  <Line type="monotone" dataKey="score" stroke={C.primary} strokeWidth={2} dot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── CUSTOMER TABLE ────────────────────────────────────────────────────────────
function CustomerTable({ customers, onSelect }) {
  return (
    <div style={{ overflowX: 'auto', maxHeight: '55vh', overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {['Customer', 'Score', 'Status', 'Segment', 'Revenue', 'Collection', 'Margin', 'Service', 'AMC', 'Risk'].map(h => (
              <th key={h} style={{ padding: '9px 12px', textAlign: 'left', color: '#374151', fontWeight: 600, borderBottom: '2px solid #e9e4ff', position: 'sticky', top: 0, background: C.surface, zIndex: 1 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {customers.map((c, i) => (
            <tr key={c.customer_id}
              onClick={() => onSelect(c)}
              style={{
                background: i % 2 === 0 ? '#fff' : '#fafafe',
                cursor: 'pointer',
                transition: 'background .1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#f5f3ff'}
              onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafe'}
            >
              <td style={{ padding: '10px 12px', fontWeight: 600 }}>
                <div>{c.customer_name || c.name}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.city}</div>
              </td>
              <td style={{ padding: '10px 12px' }}>
                <ScoreBar score={c.health_score} />
              </td>
              <td style={{ padding: '10px 12px' }}>
                <Badge label={c.health_status}
                  colors={{ bg: STATUS_COLOR[c.health_status] + '22', color: STATUS_COLOR[c.health_status] }} />
              </td>
              <td style={{ padding: '10px 12px' }}>
                <Badge label={c.segment || '—'} colors={SEGMENT_COLOR[c.segment] || { bg: '#f3f4f6', color: '#374151' }} />
              </td>
              <td style={{ padding: '10px 12px', fontWeight: 600 }}>{c.revenue_score || 0}/20</td>
              <td style={{ padding: '10px 12px', fontWeight: 600 }}>{c.collection_score || 0}/20</td>
              <td style={{ padding: '10px 12px', fontWeight: 600 }}>{c.margin_score || 0}/15</td>
              <td style={{ padding: '10px 12px', fontWeight: 600 }}>{c.service_score || 0}/10</td>
              <td style={{ padding: '10px 12px', fontWeight: 600 }}>{c.amc_score || 0}/5</td>
              <td style={{ padding: '10px 12px' }}>
                <Badge label={c.payment_default_risk || 'low'} colors={RISK_COLOR[c.payment_default_risk || 'low']} />
              </td>
            </tr>
          ))}
          {customers.length === 0 && (
            <tr><td colSpan={10} style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No customers in this category</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── ALERTS PANEL ──────────────────────────────────────────────────────────────
function AlertsPanel({ alerts, onResolve }) {
  return (
    <div>
      {alerts.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
          No active alerts
        </div>
      )}
      {alerts.map(a => (
        <div key={a.id} style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, padding: 14,
          border: '1px solid ' + (a.alert_severity === 'critical' ? '#fecaca' : '#fef3c7'),
          background: a.alert_severity === 'critical' ? '#fff5f5' : '#fffbeb',
          borderRadius: 8, marginBottom: 8,
        }}>
          <AlertSeverityIcon severity={a.alert_severity} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{a.alert_title}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{a.customer_name} — {a.alert_message}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
              {new Date(a.triggered_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
          <button
            onClick={() => onResolve(a.id)}
            style={{
              border: '1px solid #d1d5db', background: '#fff', borderRadius: 6,
              padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: '#374151', whiteSpace: 'nowrap',
            }}
          >Resolve</button>
        </div>
      ))}
    </div>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────────
export default function CustomerHealthDashboard({ setPage }) {
  const [data, setData]           = useState(null);
  const [alerts, setAlerts]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [activeFilter, setFilter] = useState('all');
  const [activeTab, setTab]       = useState('overview');
  const [selected, setSelected]   = useState(null);
  const [search, setSearch]       = useState('');
  const abortRef                  = useRef(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const [d, a] = await Promise.all([
        api.get('/crm/health-engine/dashboard', { signal: ctrl.signal }),
        api.get('/crm/health-engine/alerts',    { signal: ctrl.signal }),
      ]);
      setData(d.data);
      setAlerts(Array.isArray(a.data) ? a.data : []);
    } catch (e) {
      if (e.name !== 'CanceledError') setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const handleResolve = async (alertId) => {
    try {
      await api.patch(`/crm/health-engine/alerts/${alertId}/resolve`);
      setAlerts(prev => prev.filter(a => a.id !== alertId));
    } catch (_) {}
  };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400 }}>
      <div style={{ color: '#9ca3af' }}>Calculating customer health scores…</div>
    </div>
  );
  if (error) return (
    <div style={{ padding: 32, color: C.critical }}>Error: {error}</div>
  );

  const dist  = data?.distribution || {};
  const trend = data?.trend         || [];
  const all   = data?.all_customers || [];

  // Filter customers
  const filtered = all.filter(c => {
    const matchStatus = activeFilter === 'all'      ? true
                      : activeFilter === 'excellent' ? c.health_status === 'Excellent'
                      : activeFilter === 'good'      ? c.health_status === 'Good'
                      : activeFilter === 'watchlist' ? c.health_status === 'Watchlist'
                      : c.health_status === 'Critical';
    const matchSearch = !search || (c.customer_name || '').toLowerCase().includes(search.toLowerCase()) || (c.city || '').toLowerCase().includes(search.toLowerCase());
    return matchStatus && matchSearch;
  });

  const pieData = [
    { name: 'Excellent', value: dist.Excellent || 0, color: C.excellent },
    { name: 'Good',      value: dist.Good      || 0, color: C.good      },
    { name: 'Watchlist', value: dist.Watchlist  || 0, color: C.watchlist },
    { name: 'Critical',  value: dist.Critical   || 0, color: C.critical  },
  ].filter(d => d.value > 0);

  const pieChart = (h, r) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie data={pieData} cx="50%" cy="50%" outerRadius={r} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
          {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );

  const trendChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <LineChart data={trend}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Legend />
        <Line type="monotone" dataKey="avg_score"  stroke={C.primary}   strokeWidth={2} name="Avg Score" />
        <Line type="monotone" dataKey="excellent"  stroke={C.excellent} strokeWidth={1} strokeDasharray="4 2" name="Excellent" />
        <Line type="monotone" dataKey="critical"   stroke={C.critical}  strokeWidth={1} strokeDasharray="4 2" name="Critical" />
      </LineChart>
    </ResponsiveContainer>
  );

  return (
    <div style={{ padding: '16px 18px 20px', fontFamily: 'Inter, sans-serif', background: '#f8f7fd', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#111827' }}>
            Customer Health Dashboard
          </h1>
          <p style={{ margin: '3px 0 0', color: '#6b7280', fontSize: 12.5 }}>
            AI-assisted intelligence across {all.length} customer{all.length !== 1 ? 's' : ''} · {alerts.length} active alert{alerts.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {alerts.length > 0 && (
            <button
              onClick={() => setTab('alerts')}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8,
                color: C.critical, fontWeight: 600, fontSize: 12, cursor: 'pointer',
              }}
            >
              🚨 {alerts.length} Alert{alerts.length !== 1 ? 's' : ''}
            </button>
          )}
          <button
            onClick={load}
            style={{
              padding: '8px 14px', background: C.primary, border: 'none',
              borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer',
            }}
          >↻ Refresh</button>
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <KPICard label="Excellent"  count={dist.Excellent || 0} color={C.excellent} icon="🌟" index={0}
          onClick={() => setFilter(activeFilter === 'excellent' ? 'all' : 'excellent')}
          active={activeFilter === 'excellent'} />
        <KPICard label="Good"       count={dist.Good      || 0} color={C.good}      icon="👍" index={1}
          onClick={() => setFilter(activeFilter === 'good' ? 'all' : 'good')}
          active={activeFilter === 'good'} />
        <KPICard label="Watchlist"  count={dist.Watchlist  || 0} color={C.watchlist} icon="⚠️" index={2}
          onClick={() => setFilter(activeFilter === 'watchlist' ? 'all' : 'watchlist')}
          active={activeFilter === 'watchlist'} />
        <KPICard label="Critical"   count={dist.Critical   || 0} color={C.critical}  icon="🚨" index={3}
          onClick={() => setFilter(activeFilter === 'critical' ? 'all' : 'critical')}
          active={activeFilter === 'critical'} />
      </div>

      {/* Charts Row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 14 }}>

        {/* Distribution Pie */}
        <div className="dk-anim" style={{ ...C.card, '--dk-i': 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 10px' }}>
            <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: '#111827' }}>Health Distribution</h3>
            {pieData.length > 0 && (
              <ChartExpandButton title="Health Distribution" subtitle="Customers by health status">
                {pieChart(420, 150)}
              </ChartExpandButton>
            )}
          </div>
          {pieData.length > 0 ? (
            pieChart(180, 65)
          ) : (
            <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
              No data yet — trigger a recalculation
            </div>
          )}
        </div>

        {/* Trend Line */}
        <div className="dk-anim" style={{ ...C.card, '--dk-i': 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 10px' }}>
            <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: '#111827' }}>Health Trend (12 Months)</h3>
            {trend.length > 0 && (
              <ChartExpandButton title="Health Trend (12 Months)" subtitle="Average health score over time">
                {trendChart(420)}
              </ChartExpandButton>
            )}
          </div>
          {trend.length > 0 ? (
            trendChart(180)
          ) : (
            <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
              Historical data builds after first monthly snapshot
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e9e4ff' }}>
          {[
            ['overview',  'All Customers'],
            ['watchlist', '⚠️ Watchlist'],
            ['critical',  '🚨 Critical'],
            ['alerts',    `🔔 Alerts (${alerts.length})`],
          ].map(([key, label]) => (
            <button key={key} onClick={() => { setTab(key); if (key !== 'alerts' && key !== 'overview') setFilter(key); else if (key === 'overview') setFilter('all'); }}
              style={{
                border: 'none', background: 'none', padding: '10px 18px',
                cursor: 'pointer', fontSize: 13, fontWeight: 600,
                color: activeTab === key ? C.primary : '#6b7280',
                borderBottom: activeTab === key ? `2px solid ${C.primary}` : '2px solid transparent',
                marginBottom: -2,
              }}
            >{label}</button>
          ))}
        </div>
      </div>

      {/* Search */}
      {activeTab !== 'alerts' && (
        <div style={{ marginBottom: 12 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search customer name or city…"
            style={{
              width: 300, padding: '8px 12px', border: '1px solid #e9e4ff',
              borderRadius: 8, fontSize: 13, outline: 'none',
            }}
          />
        </div>
      )}

      {/* Content */}
      <div className="dk-anim" style={{ ...C.card, padding: 0, overflow: 'hidden', '--dk-i': 6 }}>
        {activeTab === 'alerts' ? (
          <div style={{ padding: 16, maxHeight: '55vh', overflowY: 'auto' }}>
            <AlertsPanel alerts={alerts} onResolve={handleResolve} />
          </div>
        ) : (
          <CustomerTable customers={filtered} onSelect={setSelected} />
        )}
      </div>

      {/* Customer Detail Drawer */}
      {selected && (
        <>
          <div
            onClick={() => setSelected(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', zIndex: 999 }}
          />
          <CustomerDetailDrawer customer={selected} onClose={() => setSelected(null)} />
        </>
      )}
    </div>
  );
}
