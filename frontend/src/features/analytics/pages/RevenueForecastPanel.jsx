// frontend/src/features/analytics/pages/RevenueForecastPanel.jsx
// Phase 49H — Sales Command Center & Revenue Forecast (Section 5)
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, FunnelChart, Funnel, LabelList,
  ComposedChart, Area,
} from 'recharts';
import { TrendingUp, TrendingDown, Target, Award, AlertTriangle, Users } from 'lucide-react';
import api from '@/services/api/client';

const fmtL = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};
const fmtPct = n => `${parseFloat(n || 0).toFixed(1)}%`;

const C = {
  primary: '#6B3FDB', green: '#16a34a', red: '#dc2626',
  amber: '#d97706', blue: '#2563eb', border: '#e9e4ff',
};

function KpiCard({ label, value, sub, color = C.primary, icon: Icon, trend }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '16px 18px', borderLeft: `4px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        {Icon && <div style={{ width: 30, height: 30, borderRadius: 8, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={15} color={color} /></div>}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
      {trend !== undefined && trend !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, marginTop: 6 }}>
          {trend >= 0 ? <TrendingUp size={12} color={C.green} /> : <TrendingDown size={12} color={C.red} />}
          <span style={{ color: trend >= 0 ? C.green : C.red, fontWeight: 700 }}>{Math.abs(trend).toFixed(1)}%</span>
          <span style={{ color: '#9ca3af' }}>vs last period</span>
        </div>
      )}
    </div>
  );
}

export default function RevenueForecastPanel({ summary, customerData }) {
  const [pipeline, setPipeline] = useState(null);
  const [targets, setTargets]   = useState(null);
  const [loading, setLoading]   = useState(true);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const [pip, tgt] = await Promise.all([
        api.get('/sales-command-center/pipeline').catch(() => ({ data: null })),
        api.get('/sales-command-center/targets').catch(() => ({ data: null })),
      ]);
      if (ctrl.signal.aborted) return;
      setPipeline(pip.data);
      setTargets(tgt.data);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  const kpis = summary?.kpis || {};
  const stages = pipeline?.stages || [];
  const topPerf = pipeline?.top_performers || [];
  const bottomPerf = pipeline?.bottom_performers || [];
  const forecastTrend = summary?.revenue_trend || [];

  // Build funnel data from stages
  const funnelData = stages.map((s, i) => ({
    name: s.stage,
    value: parseFloat(s.total_value || 0),
    count: s.count,
    fill: [C.primary, C.blue, C.green, C.amber, C.red][i % 5],
  }));

  // Target vs achievement
  const tgtData = (targets?.by_salesperson || []).slice(0, 8).map(t => ({
    name: t.name?.split(' ')[0] || 'Unknown',
    target: parseFloat(t.target || 0),
    achieved: parseFloat(t.achieved || 0),
    pct: t.target > 0 ? Math.round((t.achieved / t.target) * 100) : 0,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* KPI Row */}
      <div>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginBottom: 16 }}>Sales Command Center</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
          <KpiCard label="Pipeline Value" value={fmtL(kpis.pipeline_value)} color={C.primary} icon={Target} />
          <KpiCard label="Forecast Revenue" value={fmtL(kpis.forecast_revenue)} color={C.blue} icon={TrendingUp} sub="Next 3 months" />
          <KpiCard label="Revenue YTD" value={fmtL(kpis.revenue_ytd)} color={C.green} icon={Award} />
          <KpiCard
            label="Conversion Rate"
            value={pipeline?.conversion_rate != null ? fmtPct(pipeline.conversion_rate) : '—'}
            color={C.amber}
            icon={Target}
          />
          <KpiCard label="Won Revenue" value={fmtL(pipeline?.won_revenue)} color={C.green} />
          <KpiCard label="Lost Revenue" value={fmtL(pipeline?.lost_revenue)} color={C.red} />
        </div>
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Lead Funnel */}
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Sales Pipeline by Stage</div>
          {funnelData.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {funnelData.map(s => {
                const maxVal = Math.max(...funnelData.map(f => f.value), 1);
                const w = Math.round((s.value / maxVal) * 100);
                return (
                  <div key={s.name}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 12 }}>
                      <span style={{ fontWeight: 600, color: '#374151' }}>{s.name}</span>
                      <span style={{ color: '#9ca3af' }}>{s.count} opp · {fmtL(s.value)}</span>
                    </div>
                    <div style={{ background: '#f3f4f6', borderRadius: 6, height: 12 }}>
                      <div style={{ width: `${w}%`, background: s.fill, height: '100%', borderRadius: 6, transition: 'width .4s' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40, fontSize: 13 }}>No pipeline data available</div>
          )}
        </div>

        {/* Forecast Trend */}
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Revenue vs Outstanding Trend</div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={forecastTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="month" tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={v => fmtL(v)} tick={{ fontSize: 10 }} width={58} />
              <Tooltip formatter={v => fmtL(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="revenue" fill={C.primary} name="Revenue" radius={[4, 4, 0, 0]} />
              <Line type="monotone" dataKey="outstanding" stroke={C.amber} name="Outstanding" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Target vs Achievement */}
      {tgtData.length > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Target vs Achievement — By Salesperson</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={tgtData} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={v => fmtL(v)} tick={{ fontSize: 10 }} width={60} />
              <Tooltip formatter={v => fmtL(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="target" fill="#e5e7eb" name="Target" radius={[4, 4, 0, 0]} />
              <Bar dataKey="achieved" fill={C.green} name="Achieved" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Top / Bottom performers */}
      {(topPerf.length > 0 || bottomPerf.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <PerformerTable title="Top Performers" data={topPerf} color={C.green} icon={Award} />
          <PerformerTable title="Bottom Performers" data={bottomPerf} color={C.red} icon={AlertTriangle} />
        </div>
      )}
    </div>
  );
}

function PerformerTable({ title, data, color, icon: Icon }) {
  return (
    <div style={{ background: '#fff', border: `1px solid #e5e7eb`, borderRadius: 14, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon size={14} color={color} />
        <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>{title}</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f9fafb' }}>
            <th style={{ padding: '7px 12px', textAlign: 'left', color: '#6b7280', fontSize: 11, fontWeight: 600 }}>Name</th>
            <th style={{ padding: '7px 12px', textAlign: 'right', color: '#6b7280', fontSize: 11, fontWeight: 600 }}>Revenue</th>
            <th style={{ padding: '7px 12px', textAlign: 'right', color: '#6b7280', fontSize: 11, fontWeight: 600 }}>Ach%</th>
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 6).map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: '8px 12px', fontWeight: 600, color: '#111827' }}>{r.name || r.salesperson_name || '—'}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right', color, fontWeight: 700 }}>{fmtL(r.revenue || r.achieved || 0)}</td>
              <td style={{ padding: '8px 12px', textAlign: 'right', color: '#6b7280' }}>
                {r.achievement_pct != null ? fmtPct(r.achievement_pct) : '—'}
              </td>
            </tr>
          ))}
          {data.length === 0 && (
            <tr><td colSpan={3} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>No data</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
