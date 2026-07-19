/**
 * AutonomousAlerts — "What the system did automatically" panel.
 * Shows auto-executed actions, pending approvals, and alert history.
 * All data via props. Zero internal API calls.
 */
import { useState } from 'react';
import { CheckCircle, Clock, AlertTriangle, Zap, User, Bell, XCircle } from 'lucide-react';
import { SkeletonCard } from '../core/Skeletons';
import { EmptyState } from '../core/EmptyStates';
import { ErrorState } from '../core/ErrorStates';

const ALERT_TYPE_CONFIG = {
  auto_executed: { bg: '#f0fdf4', border: '#86efac', color: '#15803d', icon: Zap,           label: 'Auto-Executed' },
  pending:       { bg: '#fefce8', border: '#fde047', color: '#854d0e', icon: Clock,         label: 'Pending Approval' },
  acknowledged:  { bg: '#f0f9ff', border: '#7dd3fc', color: '#0369a1', icon: CheckCircle,   label: 'Acknowledged' },
  resolved:      { bg: '#f0fdf4', border: '#86efac', color: '#166534', icon: CheckCircle,   label: 'Resolved' },
  dismissed:     { bg: '#f9fafb', border: '#e5e7eb', color: '#6b7280', icon: XCircle,       label: 'Dismissed' },
  failed:        { bg: '#fff1f2', border: '#fecdd3', color: '#9f1239', icon: AlertTriangle, label: 'Failed' },
};

const SEVERITY_DOT = {
  critical: '#dc2626',
  high:     '#f59e0b',
  medium:   '#3b82f6',
  low:      '#10b981',
};

function timeSince(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  if (mins < 60)   return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)    return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function AlertCard({ alert, onAction }) {
  const [localStatus, setLocalStatus] = useState(alert.status);
  const cfg = ALERT_TYPE_CONFIG[localStatus] || ALERT_TYPE_CONFIG.pending;
  const StatusIcon = cfg.icon;
  const sevColor = SEVERITY_DOT[alert.severity] || '#9ca3af';

  const handleAck = () => {
    setLocalStatus('acknowledged');
    onAction({ type: 'alert_ack', payload: { id: alert.id } });
  };

  const handleResolve = () => {
    setLocalStatus('resolved');
    onAction({ type: 'alert_resolve', payload: { id: alert.id } });
  };

  const handleApprove = () => {
    setLocalStatus('auto_executed');
    onAction({ type: 'prescribe', payload: { id: alert.id, approved: true } });
  };

  const handleDismiss = () => {
    setLocalStatus('dismissed');
    onAction({ type: 'alert_ack', payload: { id: alert.id, dismissed: true } });
  };

  return (
    <div style={{
      background: cfg.bg,
      border: `1px solid ${cfg.border}`,
      borderRadius: 10,
      padding: 14,
      marginBottom: 10,
      opacity: localStatus === 'dismissed' ? 0.5 : 1,
      transition: 'opacity .2s',
    }}>
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: sevColor, flexShrink: 0, marginTop: 3 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{alert.title}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>
              {alert.module} · {timeSince(alert.triggered_at)}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#fff', border: `1px solid ${cfg.border}`, borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap' }}>
          <StatusIcon size={11} color={cfg.color} />
          <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color }}>{cfg.label}</span>
        </div>
      </div>

      {/* Description */}
      <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5, marginBottom: 10 }}>{alert.description}</div>

      {/* Auto-action taken (if any) */}
      {alert.auto_action && (
        <div style={{ background: '#fff', border: '1px solid #d1fae5', borderRadius: 8, padding: '7px 12px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={13} color="#15803d" />
          <div>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d' }}>Auto-action: </span>
            <span style={{ fontSize: 11, color: '#374151' }}>{alert.auto_action}</span>
          </div>
        </div>
      )}

      {/* Pending approval details */}
      {localStatus === 'pending' && alert.pending_action && (
        <div style={{ background: '#fff', border: '1px solid #fde047', borderRadius: 8, padding: '7px 12px', marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#854d0e', marginBottom: 3 }}>⏳ Awaiting Approval</div>
          <div style={{ fontSize: 12, color: '#374151' }}>{alert.pending_action}</div>
        </div>
      )}

      {/* Affected entities */}
      {alert.affected?.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
          {alert.affected.map(a => (
            <span key={a} style={{ display: 'flex', alignItems: 'center', gap: 3, background: '#f3f4f6', color: '#374151', fontSize: 11, padding: '2px 8px', borderRadius: 5 }}>
              <User size={9} /> {a}
            </span>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {localStatus === 'pending' && (
          <>
            <button onClick={handleApprove} style={{ padding: '5px 12px', background: '#15803d', color: '#fff', border: 'none', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
              ✓ Approve Action
            </button>
            <button onClick={handleDismiss} style={{ padding: '5px 12px', background: '#fff', color: '#6b7280', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
              Dismiss
            </button>
          </>
        )}
        {(localStatus === 'auto_executed' || localStatus === 'failed') && (
          <>
            {localStatus !== 'acknowledged' && (
              <button onClick={handleAck} style={{ padding: '5px 12px', background: '#0369a1', color: '#fff', border: 'none', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                ✓ Acknowledge
              </button>
            )}
            <button onClick={handleResolve} style={{ padding: '5px 12px', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
              Mark Resolved
            </button>
          </>
        )}
        {localStatus === 'acknowledged' && (
          <button onClick={handleResolve} style={{ padding: '5px 12px', background: '#166534', color: '#fff', border: 'none', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
            ✓ Mark Resolved
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * @prop {Object}   data     — { alerts[], stats{} }
 * @prop {boolean}  loading
 * @prop {string}   error
 * @prop {Function} onAction
 */
export default function AutonomousAlerts({ data, loading = false, error = null, onAction = () => {} }) {
  const [activeTab, setActiveTab] = useState('all');

  if (loading) {
    return (
      <div>
        {[1, 2, 3].map(i => <SkeletonCard key={i} rows={3} />)}
      </div>
    );
  }

  if (error) return <ErrorState error={error} compact />;

  if (!data?.alerts?.length) {
    return (
      <EmptyState
        type="alerts"
        title="No active alerts"
        subtitle="The autonomous system has no pending or recent alerts."
        compact
      />
    );
  }

  const { alerts, stats = {} } = data;

  const TABS = [
    { key: 'all',          label: `All (${alerts.length})` },
    { key: 'pending',      label: `Pending (${alerts.filter(a => a.status === 'pending').length})` },
    { key: 'auto_executed',label: `Auto-Executed (${alerts.filter(a => a.status === 'auto_executed').length})` },
    { key: 'resolved',     label: `Resolved (${alerts.filter(a => a.status === 'resolved' || a.status === 'acknowledged').length})` },
  ];

  const visible = activeTab === 'all'
    ? alerts
    : activeTab === 'resolved'
      ? alerts.filter(a => a.status === 'resolved' || a.status === 'acknowledged')
      : alerts.filter(a => a.status === activeTab);

  return (
    <div>
      {/* Stats strip */}
      {Object.keys(stats).length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {Object.entries(stats).map(([key, s]) => (
            <div key={key} style={{ flex: 1, minWidth: 90, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: s.color || '#111827' }}>{s.value}</div>
              <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '1px solid #e5e7eb', overflowX: 'auto' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '8px 14px',
              border: 'none',
              borderBottom: `2px solid ${activeTab === t.key ? '#6366f1' : 'transparent'}`,
              background: 'transparent',
              fontSize: 12,
              fontWeight: activeTab === t.key ? 700 : 500,
              color: activeTab === t.key ? '#6366f1' : '#6b7280',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Alert cards */}
      {visible.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '24px', color: '#9ca3af', fontSize: 13 }}>No alerts in this category.</div>
      ) : (
        visible.map(alert => (
          <AlertCard key={alert.id} alert={alert} onAction={onAction} />
        ))
      )}

      {/* Legend */}
      <div style={{ marginTop: 16, padding: '10px 14px', background: '#f9fafb', borderRadius: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', width: '100%', marginBottom: 4 }}>Severity Legend</div>
        {Object.entries(SEVERITY_DOT).map(([sev, color]) => (
          <div key={sev} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#374151' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
            {sev.charAt(0).toUpperCase() + sev.slice(1)}
          </div>
        ))}
      </div>
    </div>
  );
}
