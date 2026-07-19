// frontend/src/features/crm/pages/CustomerHealthTrend.jsx
// Phase 49F-13/24 — 12-month health trend chart + dimension breakdown over time
// Usage: <CustomerHealthTrend customerId={id} />
import { useState, useEffect, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Legend,
} from 'recharts';
import api from '@/services/api/client';

const STATUS_BAND = [
  { y: 90, label: 'Excellent', color: '#16a34a22' },
  { y: 75, label: 'Good',      color: '#2563eb22' },
  { y: 50, label: 'Watchlist', color: '#d9770622' },
];

const STATUS_LINE_COLOR = {
  Excellent: '#16a34a',
  Good:      '#2563eb',
  Watchlist: '#d97706',
  Critical:  '#dc2626',
};

const DIMENSIONS = [
  { key: 'revenue_score',    label: 'Revenue',     color: '#6B3FDB', max: 20 },
  { key: 'collection_score', label: 'Collections', color: '#2563eb', max: 20 },
  { key: 'margin_score',     label: 'Margin',      color: '#16a34a', max: 15 },
  { key: 'project_score',    label: 'Projects',    color: '#d97706', max: 10 },
  { key: 'quality_score',    label: 'Quality',     color: '#6B3FDB', max: 10 },
  { key: 'service_score',    label: 'Service',     color: '#0ea5e9', max: 10 },
  { key: 'amc_score',        label: 'AMC',         color: '#f59e0b', max:  5 },
  { key: 'engagement_score', label: 'Engagement',  color: '#ec4899', max:  5 },
  { key: 'risk_score',       label: 'Risk Buffer', color: '#6b7280', max:  5 },
];

function MonthLabel({ snapshot_month }) {
  const d = new Date(snapshot_month);
  return d.toLocaleString('en-IN', { month: 'short', year: '2-digit' });
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  return (
    <div style={{
      background: '#fff', border: '1px solid #e9e4ff', borderRadius: 8,
      padding: '10px 14px', fontSize: 12, boxShadow: '0 4px 12px rgba(0,0,0,.1)',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 6, color: '#111827' }}>{label}</div>
      {payload.map(({ name, value, color }) => (
        <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ color }}>{name}</span>
          <span style={{ fontWeight: 600 }}>{value}</span>
        </div>
      ))}
      {p?.health_status && (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #f3f4f6', color: STATUS_LINE_COLOR[p.health_status] || '#374151' }}>
          {p.health_status}
          {p.trend_direction && <span style={{ marginLeft: 8 }}>
            {p.trend_direction === 'up' ? '↑' : p.trend_direction === 'down' ? '↓' : '→'}
          </span>}
        </div>
      )}
    </div>
  );
};

export default function CustomerHealthTrend({ customerId, showDimensions = false }) {
  const [data, setData]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView]       = useState('score');  // 'score' | 'dimensions'
  const abortRef              = useRef(null);

  useEffect(() => {
    if (!customerId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);

    api.get(`/crm/health-engine/customer/${customerId}/trend`, { signal: ctrl.signal })
      .then(r => {
        const rows = Array.isArray(r.data) ? r.data : [];
        setData(rows.map(row => ({
          ...row,
          month: new Date(row.snapshot_month).toLocaleString('en-IN', { month: 'short', year: '2-digit' }),
        })));
        setLoading(false);
      })
      .catch(e => { if (e.name !== 'CanceledError') setLoading(false); });

    return () => ctrl.abort();
  }, [customerId]);

  if (loading) return (
    <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
      Loading trend data…
    </div>
  );

  if (data.length === 0) return (
    <div style={{ height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
      <div style={{ fontSize: 36, marginBottom: 8 }}>📈</div>
      <div>No historical data yet. Snapshots are recorded monthly.</div>
    </div>
  );

  return (
    <div>
      {/* View toggle */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 14, borderBottom: '1px solid #e9e4ff' }}>
        {[['score', 'Health Score'], ['dimensions', 'Dimension Breakdown']].map(([key, label]) => (
          <button key={key} onClick={() => setView(key)}
            style={{
              border: 'none', background: 'none', padding: '6px 14px',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
              color: view === key ? '#6B3FDB' : '#6b7280',
              borderBottom: view === key ? '2px solid #6B3FDB' : '2px solid transparent',
              marginBottom: -1,
            }}
          >{label}</button>
        ))}
      </div>

      {view === 'score' ? (
        <>
          {/* Status change timeline */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
            {data.map(d => (
              <div key={d.snapshot_month} style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: STATUS_LINE_COLOR[d.health_status] || '#9ca3af',
                }} />
                <span style={{ fontSize: 9, color: '#9ca3af' }}>{d.month}</span>
              </div>
            ))}
          </div>

          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
              <Tooltip content={<CustomTooltip />} />
              {/* Threshold bands */}
              <ReferenceLine y={90} stroke="#16a34a" strokeDasharray="4 2" strokeOpacity={.5} />
              <ReferenceLine y={75} stroke="#2563eb" strokeDasharray="4 2" strokeOpacity={.5} />
              <ReferenceLine y={50} stroke="#d97706" strokeDasharray="4 2" strokeOpacity={.5} />
              <Line
                type="monotone" dataKey="health_score" name="Health Score"
                stroke="#6B3FDB" strokeWidth={2.5}
                dot={({ cx, cy, payload }) => (
                  <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={5}
                    fill={STATUS_LINE_COLOR[payload.health_status] || '#6B3FDB'}
                    stroke="#fff" strokeWidth={2} />
                )}
              />
            </LineChart>
          </ResponsiveContainer>

          {/* Score change summary */}
          {data.length >= 2 && (() => {
            const last = data[data.length - 1];
            const prev = data[data.length - 2];
            const delta = last.health_score - prev.health_score;
            return (
              <div style={{
                marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap',
              }}>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  Current: <strong style={{ color: STATUS_LINE_COLOR[last.health_status] }}>{last.health_score} ({last.health_status})</strong>
                </div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  vs last month:{' '}
                  <strong style={{ color: delta >= 0 ? '#16a34a' : '#dc2626' }}>
                    {delta >= 0 ? '+' : ''}{delta} pts
                  </strong>
                </div>
                {last.trend_direction && (
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    Trend: <strong>{last.trend_direction === 'up' ? '↑ Improving' : last.trend_direction === 'down' ? '↓ Declining' : '→ Stable'}</strong>
                  </div>
                )}
              </div>
            );
          })()}
        </>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {DIMENSIONS.map(d => (
              <Bar key={d.key} dataKey={d.key} name={d.label} fill={d.color} stackId="a" />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
