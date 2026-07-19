// frontend/src/features/crm/pages/CustomerHealthWidget.jsx
// Phase 49F-17 — Customer 360 Header integration
// Usage: <CustomerHealthWidget customerId={id} />
// Shows: Health Score ring, status badge, trend direction, risk indicator
import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';

const STATUS_STYLE = {
  Excellent: { color: '#16a34a', bg: '#dcfce7', ring: '#16a34a' },
  Good:      { color: '#2563eb', bg: '#dbeafe', ring: '#2563eb' },
  Watchlist: { color: '#d97706', bg: '#fef3c7', ring: '#d97706' },
  Critical:  { color: '#dc2626', bg: '#fee2e2', ring: '#dc2626' },
};

const RISK_DOT = {
  low:      { color: '#16a34a', label: 'Low Risk' },
  medium:   { color: '#d97706', label: 'Medium Risk' },
  high:     { color: '#dc2626', label: 'High Risk' },
  critical: { color: '#9d174d', label: 'Critical Risk' },
};

const TREND_ICON = { up: '↑', down: '↓', stable: '→' };
const TREND_COLOR = { up: '#16a34a', down: '#dc2626', stable: '#6b7280' };

export default function CustomerHealthWidget({ customerId, compact = false }) {
  const [health, setHealth]   = useState(null);
  const [trend, setTrend]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCard, setCard]   = useState(false);
  const abortRef              = useRef(null);

  useEffect(() => {
    if (!customerId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);

    Promise.all([
      api.get(`/crm/health-engine/customer/${customerId}`, { signal: ctrl.signal }),
      api.get(`/crm/health-engine/customer/${customerId}/trend`, { signal: ctrl.signal }),
    ]).then(([h, t]) => {
      setHealth(h.data);
      setTrend(Array.isArray(t.data) ? t.data.slice(-3) : []);
      setLoading(false);
    }).catch(e => { if (e.name !== 'CanceledError') setLoading(false); });

    return () => ctrl.abort();
  }, [customerId]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: .5 }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#e9e4ff', animation: 'pulse 1s infinite' }} />
        <div style={{ width: 60, height: 14, background: '#e9e4ff', borderRadius: 4 }} />
      </div>
    );
  }

  if (!health) return null;

  const score  = health.health_score || 0;
  const status = health.health_status || 'Critical';
  const style  = STATUS_STYLE[status] || STATUS_STYLE.Critical;
  const lastTrend = trend.length >= 2
    ? (trend[trend.length - 1].health_score > trend[trend.length - 2].health_score ? 'up'
    :  trend[trend.length - 1].health_score < trend[trend.length - 2].health_score ? 'down' : 'stable')
    : 'stable';

  const maxRisk = [
    health.payment_default_risk,
    health.revenue_loss_risk,
    health.project_escalation_risk,
    health.service_escalation_risk,
  ].reduce((highest, r) => {
    const order = { low: 0, medium: 1, high: 2, critical: 3 };
    return (order[r] || 0) > (order[highest] || 0) ? r : highest;
  }, 'low');

  if (compact) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {/* Mini ring */}
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: `conic-gradient(${style.ring} ${score}%, #e9e4ff 0)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: 22, height: 22, borderRadius: '50%', background: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 9, fontWeight: 800, color: style.color,
          }}>{score}</div>
        </div>
        <span style={{
          padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
          background: style.bg, color: style.color,
        }}>{status}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: TREND_COLOR[lastTrend] }}>
          {TREND_ICON[lastTrend]}
        </span>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {/* Health Badge — click to expand */}
      <div
        onClick={() => setCard(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
          background: '#fff', border: `2px solid ${style.ring}`, borderRadius: 12,
          cursor: 'pointer', transition: 'box-shadow .15s',
          boxShadow: showCard ? '0 4px 16px rgba(0,0,0,.12)' : '0 1px 4px rgba(0,0,0,.06)',
        }}
      >
        {/* Score ring */}
        <div style={{
          width: 52, height: 52, borderRadius: '50%',
          background: `conic-gradient(${style.ring} ${score}%, #f0f0f4 0)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: '50%', background: '#fff',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: style.color, lineHeight: 1 }}>{score}</span>
            <span style={{ fontSize: 8, color: '#9ca3af' }}>/ 100</span>
          </div>
        </div>

        {/* Status + trend */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{
              padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700,
              background: style.bg, color: style.color,
            }}>{status}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: TREND_COLOR[lastTrend] }}>
              {TREND_ICON[lastTrend]}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: RISK_DOT[maxRisk]?.color || '#16a34a', display: 'inline-block',
            }} />
            <span style={{ fontSize: 11, color: '#6b7280' }}>{RISK_DOT[maxRisk]?.label}</span>
            {health.segment && (
              <span style={{ fontSize: 11, color: '#6B3FDB', marginLeft: 6 }}>• {health.segment}</span>
            )}
          </div>
        </div>
      </div>

      {/* Popup detail card */}
      {showCard && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 8,
          background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,.14)', padding: 16, zIndex: 100, minWidth: 280,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: '#111827' }}>
            Score Breakdown
          </div>

          {[
            ['Revenue',     health.revenue_score    || 0, 20],
            ['Collections', health.collection_score || 0, 20],
            ['Margin',      health.margin_score     || 0, 15],
            ['Projects',    health.project_score    || 0, 10],
            ['Quality',     health.quality_score    || 0, 10],
            ['Service',     health.service_score    || 0, 10],
            ['AMC',         health.amc_score        || 0,  5],
            ['Engagement',  health.engagement_score || 0,  5],
            ['Risk',        health.risk_score       || 0,  5],
          ].map(([label, val, max]) => {
            const pct   = Math.min(100, (val / max) * 100);
            const color = pct >= 80 ? '#16a34a' : pct >= 60 ? '#2563eb' : pct >= 40 ? '#d97706' : '#dc2626';
            return (
              <div key={label} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                  <span style={{ fontSize: 11, color: '#6b7280' }}>{label}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color }}>{val}/{max}</span>
                </div>
                <div style={{ height: 5, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
                </div>
              </div>
            );
          })}

          {/* Risk flags */}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #f3f4f6' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 6 }}>Risk Flags</div>
            {[
              ['Revenue Loss',      health.revenue_loss_risk],
              ['Payment Default',   health.payment_default_risk],
              ['Project Escalation',health.project_escalation_risk],
              ['Service Escalation',health.service_escalation_risk],
              ['AMC Non-renewal',   health.amc_nonrenewal_risk],
            ].map(([label, risk]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>{label}</span>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 10,
                  background: RISK_DOT[risk]?.color + '20', color: RISK_DOT[risk]?.color,
                }}>{(risk || 'low').charAt(0).toUpperCase() + (risk || 'low').slice(1)}</span>
              </div>
            ))}
          </div>

          {/* Last calculated */}
          {health.calculated_at && (
            <div style={{ marginTop: 8, fontSize: 10, color: '#9ca3af', textAlign: 'right' }}>
              Calculated: {new Date(health.calculated_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
