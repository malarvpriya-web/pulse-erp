/**
 * PrescriptivePanel — "What should we do" recommendations panel.
 * All data via props. Zero internal API calls.
 */
import { useState } from 'react';
import { Zap, User, TrendingUp, AlertCircle, CheckCircle, Clock, XCircle } from 'lucide-react';
import { SkeletonCard } from '../core/Skeletons';
import { EmptyState } from '../core/EmptyStates';
import { ErrorState } from '../core/ErrorStates';

const PRIORITY_CONFIG = {
  critical: { bg: '#fee2e2', color: '#991b1b', border: '#dc2626', label: 'Critical', dot: '#dc2626' },
  high:     { bg: '#fef3c7', color: '#92400e', border: '#f59e0b', label: 'High',     dot: '#f59e0b' },
  medium:   { bg: '#dbeafe', color: '#1e40af', border: '#3b82f6', label: 'Medium',   dot: '#3b82f6' },
  low:      { bg: '#dcfce7', color: '#14532d', border: '#10b981', label: 'Low',      dot: '#10b981' },
};

const STATUS_OPTIONS = [
  { value: 'pending',     label: 'Pending',     icon: Clock,        color: '#9ca3af' },
  { value: 'in_progress', label: 'In Progress',  icon: TrendingUp,   color: '#3b82f6' },
  { value: 'done',        label: 'Done',         icon: CheckCircle,  color: '#10b981' },
  { value: 'dismissed',   label: 'Dismissed',    icon: XCircle,      color: '#6b7280' },
];

const ACTION_ICONS = {
  notify:   '📢',
  schedule: '📅',
  hire:     '👤',
  review:   '🔍',
  train:    '🎓',
  approve:  '✅',
  escalate: '⬆️',
  default:  '⚡',
};

function ImpactBar({ impact, label }) {
  const pct = Math.min(100, Math.max(0, impact));
  const color = pct >= 70 ? '#10b981' : pct >= 40 ? '#3b82f6' : '#9ca3af';
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
        <span>Expected Impact</span>
        <span style={{ fontWeight: 700, color }}>{label || `${pct}% improvement`}</span>
      </div>
      <div style={{ height: 5, background: '#f0f0f4', borderRadius: 4 }}>
        <div style={{ height: 5, width: `${pct}%`, background: color, borderRadius: 4, transition: 'width .4s ease' }} />
      </div>
    </div>
  );
}

function RecommendationCard({ rec, onAction }) {
  const [status, setStatus] = useState(rec.status || 'pending');
  const pri = PRIORITY_CONFIG[rec.priority] || PRIORITY_CONFIG.medium;
  const statusCfg = STATUS_OPTIONS.find(s => s.value === status) || STATUS_OPTIONS[0];
  const StatusIcon = statusCfg.icon;

  const handleStatusChange = (newStatus) => {
    setStatus(newStatus);
    onAction({ type: 'prescribe', payload: { id: rec.id, status: newStatus } });
  };

  const handleAction = (action) => {
    onAction({ type: action.auto ? 'prescribe' : 'navigate', payload: { id: rec.id, action: action.type, auto: action.auto } });
  };

  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderLeft: `4px solid ${pri.border}`,
      borderRadius: 10,
      padding: 16,
      marginBottom: 12,
      opacity: status === 'dismissed' ? 0.55 : 1,
      transition: 'opacity .2s',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ background: pri.bg, color: pri.color, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>
              {pri.label}
            </span>
            {rec.auto_executable && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 3, background: '#f0fdf4', color: '#15803d', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>
                <Zap size={9} /> Auto
              </span>
            )}
            <span style={{ background: '#f3f4f6', color: '#374151', fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20 }}>
              {rec.category}
            </span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{rec.title}</div>
        </div>
        {/* Status selector */}
        <div style={{ position: 'relative' }}>
          <select
            value={status}
            onChange={e => handleStatusChange(e.target.value)}
            style={{
              border: `1px solid ${statusCfg.color}`,
              borderRadius: 8,
              padding: '5px 10px',
              fontSize: 11,
              color: statusCfg.color,
              background: '#fff',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      </div>

      {/* Problem box */}
      <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#c2410c', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>
          🔴 Problem
        </div>
        <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>{rec.problem}</div>
      </div>

      {/* Recommendation box */}
      <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>
          💡 Recommendation
        </div>
        <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>{rec.recommendation}</div>
      </div>

      {/* Impact bar */}
      <ImpactBar impact={rec.impact_score} label={rec.impact_label} />

      {/* Actions */}
      {rec.actions?.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {rec.actions.map((action, i) => (
            <button
              key={i}
              onClick={() => handleAction(action)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '6px 12px',
                background: action.auto ? '#f0fdf4' : '#f8faff',
                border: `1px solid ${action.auto ? '#86efac' : '#c7d2fe'}`,
                borderRadius: 8,
                fontSize: 12,
                color: action.auto ? '#15803d' : '#4338ca',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              <span>{ACTION_ICONS[action.type] || ACTION_ICONS.default}</span>
              {action.label}
              {action.auto && <Zap size={10} />}
            </button>
          ))}
        </div>
      )}

      {/* Affected employees/depts */}
      {rec.affected?.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          <span style={{ fontSize: 11, color: '#6b7280', marginRight: 2 }}>Affects:</span>
          {rec.affected.map(a => (
            <span key={a} style={{ background: '#f3f4f6', color: '#374151', fontSize: 11, padding: '2px 8px', borderRadius: 5, fontWeight: 500 }}>{a}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * @prop {Object}   data     — { recommendations[], summary{} }
 * @prop {boolean}  loading
 * @prop {string}   error
 * @prop {Function} onAction
 */
export default function PrescriptivePanel({ data, loading = false, error = null, onAction = () => {} }) {
  const [filter, setFilter] = useState('all');

  if (loading) {
    return (
      <div>
        {[1, 2, 3].map(i => <SkeletonCard key={i} rows={4} />)}
      </div>
    );
  }

  if (error) return <ErrorState error={error} compact />;

  if (!data?.recommendations?.length) {
    return (
      <EmptyState
        type="recommendations"
        title="No recommendations right now"
        subtitle="The system found no actionable recommendations for the selected period."
        compact
      />
    );
  }

  const { recommendations, summary = {} } = data;

  const FILTERS = [
    { value: 'all',      label: `All (${recommendations.length})` },
    { value: 'critical', label: `Critical (${recommendations.filter(r => r.priority === 'critical').length})` },
    { value: 'high',     label: `High (${recommendations.filter(r => r.priority === 'high').length})` },
    { value: 'pending',  label: `Pending (${recommendations.filter(r => !r.status || r.status === 'pending').length})` },
  ];

  const visible = filter === 'all'
    ? recommendations
    : filter === 'pending'
      ? recommendations.filter(r => !r.status || r.status === 'pending')
      : recommendations.filter(r => r.priority === filter);

  return (
    <div>
      {/* Summary row */}
      {Object.keys(summary).length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {Object.entries(summary).map(([key, s]) => (
            <div key={key} style={{ flex: 1, minWidth: 100, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#111827' }}>{s.value}</div>
              <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            style={{
              padding: '5px 12px',
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 600,
              border: '1px solid',
              cursor: 'pointer',
              borderColor: filter === f.value ? '#6366f1' : '#e5e7eb',
              background: filter === f.value ? '#6366f1' : '#fff',
              color: filter === f.value ? '#fff' : '#374151',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Cards */}
      <div>
        {visible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px', color: '#9ca3af', fontSize: 13 }}>No recommendations in this category.</div>
        ) : (
          visible.map(rec => (
            <RecommendationCard key={rec.id} rec={rec} onAction={onAction} />
          ))
        )}
      </div>
    </div>
  );
}
