/**
 * Phase 49G-17/18/24 — VendorHealthTrend
 *
 * 12-month health score trend for a single vendor.
 * Shows health_score line + status classification + dimension sub-trends.
 */
import { useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import api from '@/services/api/client';

const STATUS_BANDS = [
  { min: 90, max: 100, color: '#dcfce7', label: 'Preferred Zone' },
  { min: 75, max: 90,  color: '#dbeafe', label: 'Approved Zone' },
  { min: 50, max: 75,  color: '#fef3c7', label: 'Watchlist Zone' },
  { min: 0,  max: 50,  color: '#fee2e2', label: 'Critical Zone' },
];

const STATUS_COLOR = {
  Preferred: '#16a34a', Approved: '#2563eb', Watchlist: '#d97706', Critical: '#dc2626',
};

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  const color = STATUS_COLOR[d?.health_status] || '#6b7280';
  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
      padding: '10px 14px', fontSize: 12, boxShadow: '0 4px 12px rgba(0,0,0,.1)',
    }}>
      <div style={{ fontWeight: 700, color: '#111827', marginBottom: 6 }}>{label}</div>
      <div style={{ color, fontWeight: 700, fontSize: 16 }}>
        {d?.health_score?.toFixed(1)} — {d?.health_status}
      </div>
      {payload.slice(1).map(p => (
        <div key={p.dataKey} style={{ color: p.color, marginTop: 3 }}>
          {p.name}: {p.value?.toFixed(1)}
        </div>
      ))}
    </div>
  );
}

export default function VendorHealthTrend({ vendorId }) {
  const [trend, setTrend]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showDims, setShowDims] = useState(false);

  useEffect(() => {
    if (!vendorId) return;
    setLoading(true);
    api.get(`/vendor-health/${vendorId}/trend`)
      .then(r => setTrend(r.data || []))
      .catch(() => setTrend([]))
      .finally(() => setLoading(false));
  }, [vendorId]);

  if (loading) return (
    <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
      Loading trend…
    </div>
  );

  if (!trend.length) return (
    <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>📈</div>
      No historical data yet. Health score will be tracked monthly after first calculation.
    </div>
  );

  // Annotate rows with status color for dot rendering
  const chartData = trend.map(row => ({
    ...row,
    month_label:    row.month_label,
    health_score:   parseFloat(row.health_score   || 0),
    quality_score:  parseFloat(row.quality_score  || 0),
    delivery_score: parseFloat(row.delivery_score || 0),
    cost_score:     parseFloat(row.cost_score     || 0),
    compliance_score: parseFloat(row.compliance_score || 0),
  }));

  // Summary stats
  const scores = chartData.map(d => d.health_score);
  const latest = scores.at(-1) ?? 0;
  const prev   = scores.at(-2);
  const delta  = prev != null ? (latest - prev) : null;
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* ── KPIs ── */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Current Score',  value: `${latest.toFixed(1)}`, color: STATUS_COLOR[trend.at(-1)?.health_status] || '#6B3FDB' },
          { label: 'MoM Change',     value: delta != null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}` : '—',
            color: delta == null ? '#6b7280' : delta >= 0 ? '#16a34a' : '#dc2626' },
          { label: '12M High',       value: maxScore.toFixed(1), color: '#16a34a' },
          { label: '12M Low',        value: minScore.toFixed(1), color: '#dc2626' },
          { label: 'Current Status', value: trend.at(-1)?.health_status || '—',
            color: STATUS_COLOR[trend.at(-1)?.health_status] || '#6b7280' },
        ].map(kpi => (
          <div key={kpi.label} style={{
            flex: 1, minWidth: 100, background: '#fff', border: '1px solid #f0f0f4',
            borderRadius: 10, padding: '12px 16px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: kpi.color }}>{kpi.value}</div>
            <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600,
                          textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 4 }}>
              {kpi.label}
            </div>
          </div>
        ))}
      </div>

      {/* ── Main trend chart ── */}
      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>
            12-Month Health Score Trend
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                          color: '#6b7280', cursor: 'pointer' }}>
            <input type="checkbox" checked={showDims}
              onChange={e => setShowDims(e.target.checked)} />
            Show dimensions
          </label>
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
            <XAxis dataKey="month_label" tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#9ca3af' }} />
            <Tooltip content={<CustomTooltip />} />
            {showDims && <Legend wrapperStyle={{ fontSize: 11 }} />}

            {/* Reference lines for zone boundaries */}
            <ReferenceLine y={90} stroke="#16a34a" strokeDasharray="6 4"
              label={{ value: 'Preferred', position: 'right', fontSize: 10, fill: '#16a34a' }} />
            <ReferenceLine y={75} stroke="#2563eb" strokeDasharray="6 4"
              label={{ value: 'Approved', position: 'right', fontSize: 10, fill: '#2563eb' }} />
            <ReferenceLine y={50} stroke="#d97706" strokeDasharray="6 4"
              label={{ value: 'Watchlist', position: 'right', fontSize: 10, fill: '#d97706' }} />

            {/* Health score — main line */}
            <Line type="monotone" dataKey="health_score" name="Health Score"
              stroke="#6B3FDB" strokeWidth={3} dot={{ r: 5, fill: '#6B3FDB', strokeWidth: 2, stroke: '#fff' }}
              activeDot={{ r: 7 }} />

            {/* Dimension lines — only when toggled */}
            {showDims && <>
              <Line type="monotone" dataKey="quality_score"    name="Quality"    stroke="#16a34a" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="delivery_score"   name="Delivery"   stroke="#2563eb" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="cost_score"       name="Cost"       stroke="#f59e0b" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="compliance_score" name="Compliance" stroke="#ec4899" strokeWidth={1.5} dot={false} />
            </>}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── Monthly breakdown table ── */}
      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f4', fontSize: 13,
                      fontWeight: 700, color: '#374151' }}>
          Monthly Breakdown
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#fafafa' }}>
                {['Month', 'Health Score', 'Status', 'Quality', 'Delivery', 'Cost', 'Compliance'].map(h => (
                  <th key={h} style={{ padding: '8px 14px', fontSize: 11, fontWeight: 700,
                                       color: '#6b7280', textAlign: 'left', borderBottom: '1px solid #f0f0f4',
                                       textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...chartData].reverse().map((row, i) => {
                const sc = STATUS_COLOR[row.health_status] || '#6b7280';
                return (
                  <tr key={i} style={{ borderBottom: '1px solid #f8f8fc' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#fafafa'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}>
                    <td style={{ padding: '9px 14px', fontSize: 13, fontWeight: 600, color: '#374151' }}>
                      {row.month_label}
                    </td>
                    <td style={{ padding: '9px 14px', fontSize: 14, fontWeight: 800, color: sc }}>
                      {row.health_score.toFixed(1)}
                    </td>
                    <td style={{ padding: '9px 14px' }}>
                      <span style={{
                        padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                        color: sc, background: sc + '22',
                      }}>
                        {row.health_status}
                      </span>
                    </td>
                    <td style={{ padding: '9px 14px', fontSize: 13, color: '#374151' }}>
                      {row.quality_score.toFixed(1)}
                    </td>
                    <td style={{ padding: '9px 14px', fontSize: 13, color: '#374151' }}>
                      {row.delivery_score.toFixed(1)}
                    </td>
                    <td style={{ padding: '9px 14px', fontSize: 13, color: '#374151' }}>
                      {row.cost_score.toFixed(1)}
                    </td>
                    <td style={{ padding: '9px 14px', fontSize: 13, color: '#374151' }}>
                      {row.compliance_score.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
