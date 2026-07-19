// frontend/src/features/crm/pages/CustomerRiskPanel.jsx
// Phase 49F-15 — Customer Risk Prediction Panel
// Usage: <CustomerRiskPanel customerId={id} customerName="Tata Power" />
// Shows: 5 risk dimensions with severity, predicted impact, recommended actions
import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const RISK_CONFIG = {
  low:      { icon: '🟢', label: 'Low',      color: '#16a34a', bg: '#dcfce7', textColor: '#15803d' },
  medium:   { icon: '🟡', label: 'Medium',   color: '#d97706', bg: '#fef3c7', textColor: '#92400e' },
  high:     { icon: '🔴', label: 'High',     color: '#dc2626', bg: '#fee2e2', textColor: '#991b1b' },
  critical: { icon: '🚨', label: 'Critical', color: '#9d174d', bg: '#fce7f3', textColor: '#831843' },
};

const RISK_DEFINITIONS = {
  revenue_loss_risk: {
    title:   'Revenue Loss Risk',
    icon:    '💰',
    desc:    'Likelihood of revenue declining in next 12 months based on order frequency, growth trend, and pipeline.',
    actions: {
      low:      'Continue regular account review cadence.',
      medium:   'Schedule quarterly business review. Explore cross-sell / upsell opportunities.',
      high:     'Urgent sales visit required. Identify root cause. Present roadmap.',
      critical: 'Escalate to CEO / VP Sales. Immediate customer retention plan.',
    },
  },
  payment_default_risk: {
    title:   'Payment Default Risk',
    icon:    '🏦',
    desc:    'Probability of payment default based on overdue invoices, outstanding aging, and collection history.',
    actions: {
      low:      'No immediate action needed.',
      medium:   'Review credit limit. Send gentle payment reminders.',
      high:     'Initiate collections follow-up. Put new orders on hold pending clearance.',
      critical: 'Escalate to Finance/Legal. Halt dispatches until dues cleared.',
    },
  },
  project_escalation_risk: {
    title:   'Project Escalation Risk',
    icon:    '🏗️',
    desc:    'Risk of project delays, cost overruns, or customer escalation based on active project health.',
    actions: {
      low:      'Normal project governance in place.',
      medium:   'Review milestone progress. Identify delayed tasks.',
      high:     'Project health meeting required. Prepare recovery plan.',
      critical: 'Customer escalation imminent. Senior PM intervention required.',
    },
  },
  service_escalation_risk: {
    title:   'Service Escalation Risk',
    icon:    '🎫',
    desc:    'Risk of customer escalation based on open ticket age, critical issues, and resolution performance.',
    actions: {
      low:      'Maintain SLA performance.',
      medium:   'Review open tickets. Ensure critical tickets prioritized.',
      high:     'Assign senior engineer. Proactive customer call within 24 hours.',
      critical: 'Customer satisfaction at risk. Immediate management intervention.',
    },
  },
  amc_nonrenewal_risk: {
    title:   'AMC Non-Renewal Risk',
    icon:    '🔄',
    desc:    'Risk of AMC contract not being renewed based on expiry dates, payment status, and service satisfaction.',
    actions: {
      low:      'Send renewal reminder 90 days before expiry.',
      medium:   'Proactive renewal visit. Present service report and value proposition.',
      high:     'Urgent renewal follow-up. Offer extended warranty or discount incentive.',
      critical: 'AMC lapsed or about to lapse. Emergency account save required.',
    },
  },
};

const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

function RiskRow({ riskKey, riskLevel, onExpand, expanded }) {
  const def = RISK_DEFINITIONS[riskKey];
  const cfg = RISK_CONFIG[riskLevel] || RISK_CONFIG.low;
  if (!def) return null;

  return (
    <div style={{
      border: `1px solid ${cfg.color}33`,
      borderRadius: 10, marginBottom: 10, overflow: 'hidden',
    }}>
      <div
        onClick={onExpand}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
          background: cfg.bg, cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 20 }}>{def.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{def.title}</div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>{def.desc.slice(0, 70)}…</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>{cfg.icon}</span>
          <span style={{
            padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
            background: '#fff', color: cfg.textColor, border: `1px solid ${cfg.color}55`,
          }}>{cfg.label}</span>
          <span style={{ fontSize: 14, color: '#9ca3af' }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '14px 16px', background: '#fff', borderTop: `1px solid ${cfg.color}22` }}>
          <p style={{ fontSize: 12, color: '#374151', margin: '0 0 12px' }}>{def.desc}</p>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: `${cfg.bg}`, borderRadius: 8, padding: '10px 14px' }}>
            <span style={{ fontSize: 16, flexShrink: 0 }}>💡</span>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: cfg.textColor, marginBottom: 3 }}>Recommended Action</div>
              <div style={{ fontSize: 12, color: '#374151' }}>{def.actions[riskLevel]}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OverallRiskGauge({ risks }) {
  const riskValues = Object.values(risks).map(r => RISK_ORDER[r] || 0);
  const maxVal = Math.max(...riskValues);
  const maxRisk = Object.keys(RISK_ORDER).find(k => RISK_ORDER[k] === maxVal) || 'low';
  const cfg = RISK_CONFIG[maxRisk];

  const critCount   = riskValues.filter(v => v === 3).length;
  const highCount   = riskValues.filter(v => v === 2).length;
  const medCount    = riskValues.filter(v => v === 1).length;

  return (
    <div style={{
      background: cfg.bg, border: `2px solid ${cfg.color}55`, borderRadius: 12,
      padding: '16px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 16,
    }}>
      <div style={{ textAlign: 'center', minWidth: 80 }}>
        <div style={{ fontSize: 36 }}>{cfg.icon}</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: cfg.textColor, marginTop: 4 }}>
          {cfg.label} Risk
        </div>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 6 }}>
          Overall Risk Profile
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {critCount > 0 && <span style={{ fontSize: 12, color: RISK_CONFIG.critical.textColor }}>🚨 {critCount} Critical</span>}
          {highCount > 0 && <span style={{ fontSize: 12, color: RISK_CONFIG.high.textColor }}>🔴 {highCount} High</span>}
          {medCount  > 0 && <span style={{ fontSize: 12, color: RISK_CONFIG.medium.textColor }}>🟡 {medCount} Medium</span>}
          {critCount + highCount + medCount === 0 && <span style={{ fontSize: 12, color: RISK_CONFIG.low.textColor }}>🟢 All Low</span>}
        </div>
      </div>
    </div>
  );
}

export default function CustomerRiskPanel({ customerId, customerName }) {
  const toast = useToast();
  const [health, setHealth]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [expanded, setExpanded] = useState({});
  const abortRef                = useRef(null);

  useEffect(() => {
    if (!customerId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);

    api.get(`/crm/health-engine/customer/${customerId}`, { signal: ctrl.signal })
      .then(r => { setHealth(r.data); setLoading(false); })
      .catch(e => { if (e.name !== 'CanceledError') setLoading(false); });

    return () => ctrl.abort();
  }, [customerId]);

  if (loading) return (
    <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>Loading risk profile…</div>
  );

  if (!health) return (
    <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
      No risk data. Run a health calculation first.
    </div>
  );

  const risks = {
    revenue_loss_risk:        health.revenue_loss_risk        || 'low',
    payment_default_risk:     health.payment_default_risk     || 'low',
    project_escalation_risk:  health.project_escalation_risk  || 'low',
    service_escalation_risk:  health.service_escalation_risk  || 'low',
    amc_nonrenewal_risk:      health.amc_nonrenewal_risk      || 'low',
  };

  // Sort by severity descending
  const riskEntries = Object.entries(risks).sort(
    ([, a], [, b]) => (RISK_ORDER[b] || 0) - (RISK_ORDER[a] || 0)
  );

  const toggle = key => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div style={{ fontFamily: 'Inter, sans-serif' }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#111827' }}>
          Risk Prediction — {customerName || 'Customer'}
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
          AI-assisted risk scoring across 5 commercial dimensions
        </p>
      </div>

      <OverallRiskGauge risks={risks} />

      {riskEntries.map(([key, level]) => (
        <RiskRow
          key={key}
          riskKey={key}
          riskLevel={level}
          expanded={!!expanded[key]}
          onExpand={() => toggle(key)}
        />
      ))}

      {/* Recalculate button */}
      <div style={{ textAlign: 'right', marginTop: 12 }}>
        <button
          onClick={async () => {
            setLoading(true);
            try {
              const r = await api.post(`/crm/health-engine/recalculate/${customerId}`);
              setHealth(r.data);
            } catch (err) { toast.error(err?.response?.data?.error || 'Failed to recalculate health score'); }
            setLoading(false);
          }}
          style={{
            padding: '7px 14px', background: '#6B3FDB', border: 'none',
            borderRadius: 8, color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer',
          }}
        >↻ Recalculate</button>
      </div>
    </div>
  );
}
