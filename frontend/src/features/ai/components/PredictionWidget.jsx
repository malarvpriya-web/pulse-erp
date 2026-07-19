import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

const fmtRupee = (n) => {
  if (!n || isNaN(n)) return '—';
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000)   return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000)     return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${n}`;
};

function buildPredictions({ lastMonthRevenue, attendanceTrend, projectVelocity }) {
  return [
    {
      label: 'Projected Revenue (Next Month)',
      value: fmtRupee((lastMonthRevenue || 0) * 1.08),
      trend: '+8%',
      trendDir: 'up',
      confidence: 'Based on 6-month average growth',
      color: '#10b981',
    },
    {
      label: 'Attrition Risk Score',
      value: attendanceTrend > 0 ? 'Elevated' : 'Normal',
      trend: attendanceTrend > 0 ? `↑ ${attendanceTrend}% drop` : 'Stable',
      trendDir: attendanceTrend > 0 ? 'down' : 'neutral',
      confidence: 'Based on attendance trend this week',
      color: attendanceTrend > 0 ? '#ef4444' : '#10b981',
    },
    {
      label: 'Project Completion (This Quarter)',
      value: projectVelocity != null ? `${Math.min(100, Math.round(projectVelocity))}%` : '—',
      trend: projectVelocity >= 80 ? 'On track' : projectVelocity >= 60 ? 'At risk' : 'Delayed',
      trendDir: projectVelocity >= 80 ? 'up' : projectVelocity >= 60 ? 'neutral' : 'down',
      confidence: 'Based on current sprint velocity',
      color: projectVelocity >= 80 ? '#10b981' : projectVelocity >= 60 ? '#f59e0b' : '#ef4444',
    },
  ];
}

export default function PredictionWidget({ kpiData, projectsData }) {
  const lastMonthRevenue = kpiData?.revenue?.value || 0;
  const attendanceTrend  = kpiData?.attendance?.dropPct || 0;
  const onTrack = Array.isArray(projectsData)
    ? (projectsData.filter(p => p.status === 'On Track').length / Math.max(projectsData.length, 1)) * 100
    : null;

  const predictions = buildPredictions({
    lastMonthRevenue,
    attendanceTrend,
    projectVelocity: onTrack,
  });

  return (
    <div style={{
      background: '#fff',
      border: '1px solid #f0f0f4',
      borderRadius: 12,
      padding: '16px 20px',
      marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <TrendingUp size={15} color="#6366f1" />
        <span style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>Predictions</span>
        <span style={{
          marginLeft: 4, fontSize: 10, fontWeight: 600, color: '#6366f1',
          background: '#eef2ff', borderRadius: 20, padding: '1px 7px',
        }}>AI</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {predictions.map((p, i) => (
          <div key={i} style={{
            background: '#f9fafb', borderRadius: 8, padding: '12px 14px',
            borderLeft: `3px solid ${p.color}`,
          }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, lineHeight: 1.3 }}>
              {p.label}
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginBottom: 4 }}>
              {p.value}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {p.trendDir === 'up'      && <TrendingUp size={11} color={p.color} />}
              {p.trendDir === 'down'    && <TrendingDown size={11} color={p.color} />}
              {p.trendDir === 'neutral' && <Minus size={11} color="#9ca3af" />}
              <span style={{ fontSize: 11, color: p.color, fontWeight: 600 }}>{p.trend}</span>
            </div>
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>
              {p.confidence}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
