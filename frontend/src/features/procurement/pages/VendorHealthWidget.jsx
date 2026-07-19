/**
 * Phase 49G — VendorHealthWidget
 *
 * Embeds into Vendor 360 header. Shows:
 *  - Health Score gauge (large)
 *  - Classification badge
 *  - Strategic flags (red banners)
 *  - 8-dimension radar chart
 *  - Early warnings list
 *  - Project impact
 */
import { useState, useEffect, useCallback } from 'react';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer, Tooltip,
} from 'recharts';
import api from '@/services/api/client';

// ── Design tokens ──────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  Preferred: { color: '#16a34a', bg: '#dcfce7', icon: '★' },
  Approved:  { color: '#2563eb', bg: '#dbeafe', icon: '✓' },
  Watchlist: { color: '#d97706', bg: '#fef3c7', icon: '⚠' },
  Critical:  { color: '#dc2626', bg: '#fee2e2', icon: '✕' },
};

const WARN_COLORS = {
  Critical: '#dc2626', High: '#ea580c', Medium: '#d97706', Low: '#6b7280',
};

const DIM_LABELS = {
  quality_score:     'Quality',
  delivery_score:    'Delivery',
  cost_score:        'Cost',
  support_score:     'Support',
  compliance_score:  'Compliance',
  financial_score:   'Financial',
  dependency_score:  'Dependency',
  risk_score:        'Risk Events',
};

const DIM_MAX = {
  quality_score:    25,
  delivery_score:   20,
  cost_score:       15,
  support_score:    10,
  compliance_score: 10,
  financial_score:  10,
  dependency_score:  5,
  risk_score:        5,
};

// ── Sub-components ─────────────────────────────────────────────────────────────
function HealthGauge({ score, status }) {
  const cfg    = STATUS_CONFIG[status] || STATUS_CONFIG.Watchlist;
  const r      = 52;
  const circ   = 2 * Math.PI * r;
  const pct    = Math.min(score / 100, 1);

  return (
    <div style={{ position: 'relative', width: 130, height: 130, flexShrink: 0 }}>
      <svg width="130" height="130" viewBox="0 0 130 130">
        <circle cx="65" cy="65" r={r} fill="none" stroke="#f0f0f4" strokeWidth="12" />
        <circle cx="65" cy="65" r={r} fill="none" stroke={cfg.color} strokeWidth="12"
          strokeDasharray={`${pct * circ} ${circ}`}
          strokeLinecap="round" transform="rotate(-90 65 65)" />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ fontSize: 28, fontWeight: 900, color: cfg.color, lineHeight: 1 }}>
          {Math.round(score)}
        </div>
        <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, marginTop: 2 }}>/ 100</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.Watchlist;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '4px 14px', borderRadius: 20, fontSize: 13, fontWeight: 700,
      color: cfg.color, background: cfg.bg,
    }}>
      {cfg.icon} {status}
    </span>
  );
}

function StrategicFlag({ label, color = '#dc2626' }) {
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 4,
      fontSize: 11, fontWeight: 700, color: '#fff', background: color,
      textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>
      {label}
    </span>
  );
}

function DimBar({ label, score, max, color }) {
  const pct = Math.min((score / 100) * 100, 100);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color }}>
          {Math.round(score * (max / 100) * 10) / 10} / {max}
        </span>
      </div>
      <div style={{ height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3,
                      transition: 'width .5s ease' }} />
      </div>
    </div>
  );
}

function WarningRow({ w }) {
  const color = WARN_COLORS[w.severity] || '#6b7280';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 12px', background: '#fff8f8', borderLeft: `3px solid ${color}`,
      borderRadius: 6, marginBottom: 6,
    }}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>
        {w.severity === 'Critical' ? '🔴' : w.severity === 'High' ? '🟠' : '🟡'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color }}>
          {w.warning_type?.replace(/_/g, ' ')}
        </div>
        <div style={{ fontSize: 12, color: '#374151', marginTop: 2 }}>{w.message}</div>
      </div>
    </div>
  );
}

// ── Main widget ────────────────────────────────────────────────────────────────
export default function VendorHealthWidget({ vendorId, onRecalculate }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [recalc, setRecalc]   = useState(false);
  const [err, setErr]         = useState('');

  const load = useCallback(async () => {
    if (!vendorId) return;
    setLoading(true);
    setErr('');
    try {
      const res = await api.get(`/vendor-health/${vendorId}`);
      setData(res.data);
    } catch {
      // If no score exists, compute on first load
      try {
        const res = await api.post(`/vendor-health/${vendorId}/recalculate`);
        setData(res.data);
      } catch (e) {
        setErr(e.response?.data?.error || 'Failed to load health data');
      }
    } finally { setLoading(false); }
  }, [vendorId]);

  useEffect(() => { load(); }, [load]);

  const handleRecalculate = async () => {
    setRecalc(true);
    try {
      const res = await api.post(`/vendor-health/${vendorId}/recalculate`);
      setData(res.data);
      onRecalculate?.();
    } catch (e) {
      setErr(e.response?.data?.error || 'Recalculation failed');
    } finally { setRecalc(false); }
  };

  if (loading) return (
    <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
      Computing health score…
    </div>
  );

  if (err) return (
    <div style={{ padding: 16, background: '#fee2e2', borderRadius: 8, color: '#dc2626', fontSize: 13 }}>
      {err}
    </div>
  );

  const health    = data?.health || data;
  const flags     = data?.strategic_flags || {};
  const warnings  = data?.warnings || [];
  const impact    = data?.project_impact || {};

  if (!health) return null;

  // Radar chart data
  const radarData = Object.keys(DIM_LABELS).map(key => ({
    dimension: DIM_LABELS[key],
    score:     parseFloat(health[key] || 0),
    fullMark:  100,
  }));

  const scoreColor =
    health.health_score >= 90 ? '#16a34a' :
    health.health_score >= 75 ? '#2563eb' :
    health.health_score >= 50 ? '#d97706' : '#dc2626';

  const strategicFlagDefs = [
    { key: 'is_critical_supplier',  label: 'Critical Supplier' },
    { key: 'is_single_source',      label: 'Single Source' },
    { key: 'is_long_lead',          label: 'Long Lead' },
    { key: 'is_high_spend',         label: 'High Spend' },
    { key: 'is_project_critical',   label: 'Project Critical' },
  ];

  const activeFlags = strategicFlagDefs.filter(f => flags[f.key]);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* ── Header row ── */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 20 }}>
        {/* Gauge */}
        <HealthGauge score={health.health_score} status={health.health_status} />

        {/* Status + flags */}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ marginBottom: 10 }}>
            <StatusBadge status={health.health_status} />
          </div>
          {activeFlags.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {activeFlags.map(f => <StrategicFlag key={f.key} label={f.label} />)}
            </div>
          )}
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
            Last calculated: {health.calculated_at
              ? new Date(health.calculated_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
              : '—'}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#2563eb' }}>
                {Math.round(health.otd_pct || 0)}%
              </div>
              <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600 }}>ON-TIME DELIVERY</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: health.open_ncr_count > 0 ? '#dc2626' : '#16a34a' }}>
                {health.open_ncr_count || 0}
              </div>
              <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600 }}>OPEN NCRs</div>
            </div>
            {Number(impact.project_count) > 0 && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#6B3FDB' }}>
                  {impact.project_count}
                </div>
                <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 600 }}>PROJECTS</div>
              </div>
            )}
          </div>
        </div>

        {/* Recalculate button */}
        <button onClick={handleRecalculate} disabled={recalc} style={{
          padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none',
          borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: recalc ? 'not-allowed' : 'pointer',
          opacity: recalc ? 0.7 : 1, height: 36, alignSelf: 'flex-start',
        }}>
          {recalc ? 'Calculating…' : 'Recalculate'}
        </button>
      </div>

      {/* ── Dimension bars + Radar ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 20 }}>
        {/* Dimension bars */}
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 14,
                        textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Score Breakdown
          </div>
          {Object.keys(DIM_LABELS).map(key => (
            <DimBar
              key={key}
              label={DIM_LABELS[key]}
              score={parseFloat(health[key] || 0)}
              max={DIM_MAX[key]}
              color={scoreColor}
            />
          ))}
        </div>

        {/* Radar chart */}
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8,
                        textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Health Radar
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <RadarChart data={radarData} outerRadius={80}>
              <PolarGrid stroke="#f0f0f4" />
              <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10, fill: '#6b7280' }} />
              <Radar name="Score" dataKey="score" stroke={scoreColor}
                fill={scoreColor} fillOpacity={0.18} strokeWidth={2} />
              <Tooltip formatter={(v) => [`${Math.round(v)}/100`, 'Score']} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Early warnings ── */}
      {warnings.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 12,
                        textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 8 }}>
            Early Warnings
            <span style={{ background: '#fee2e2', color: '#dc2626', borderRadius: 12,
                           padding: '1px 8px', fontSize: 11 }}>
              {warnings.length}
            </span>
          </div>
          {warnings.map((w, i) => <WarningRow key={i} w={w} />)}
        </div>
      )}

      {/* ── Project impact ── */}
      {Number(impact.project_count) > 0 && (
        <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6B3FDB', marginBottom: 6 }}>
            Project Impact
          </div>
          <div style={{ display: 'flex', gap: 24 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#6B3FDB' }}>
                {impact.project_count}
              </div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>Active Projects</div>
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#6B3FDB' }}>
                ₹{((Number(impact.total_project_value) || 0) / 10_000_000).toFixed(2)} Cr
              </div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>Revenue at Risk</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
