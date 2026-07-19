/**
 * DiagnosticPanel — "Why did this happen" root-cause analysis panel.
 * All data via props. Zero internal API calls.
 */
import { SkeletonCard } from '../core/Skeletons';
import { EmptyState }   from '../core/EmptyStates';
import { ErrorState }   from '../core/ErrorStates';

const SEVERITY_CONFIG = {
  critical: { bg: '#fee2e2', color: '#991b1b', border: '#dc2626', label: 'Critical' },
  high:     { bg: '#fef3c7', color: '#92400e', border: '#f59e0b', label: 'High' },
  medium:   { bg: '#dbeafe', color: '#1e40af', border: '#3b82f6', label: 'Medium' },
  low:      { bg: '#dcfce7', color: '#14532d', border: '#10b981', label: 'Low' },
};

function ProbabilityBar({ probability, label }) {
  const pct  = Math.round(probability * 100);
  const color = pct >= 70 ? '#dc2626' : pct >= 50 ? '#f59e0b' : '#6b7280';
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3, fontSize: 12, color: '#374151' }}>
        <span>{label}</span>
        <span style={{ fontWeight: 700, color }}>{pct}% likelihood</span>
      </div>
      <div style={{ height: 5, background: '#f0f0f4', borderRadius: 4 }}>
        <div style={{ height: 5, width: `${pct}%`, background: color, borderRadius: 4, transition: 'width .4s ease' }} />
      </div>
    </div>
  );
}

function CorrelationBar({ score }) {
  const abs    = Math.abs(score);
  const color  = score > 0.5 ? '#10b981' : score < -0.5 ? '#dc2626' : '#9ca3af';
  const filled = abs * 50; // half the bar for direction
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {/* Negative side */}
      <div style={{ width: 50, height: 6, background: '#f0f0f4', borderRadius: 4, display: 'flex', justifyContent: 'flex-end' }}>
        {score < 0 && (
          <div style={{ width: `${filled * 2}%`, height: 6, background: '#dc2626', borderRadius: 4 }} />
        )}
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color, minWidth: 36, textAlign: 'center' }}>
        {score > 0 ? '+' : ''}{score.toFixed(2)}
      </span>
      {/* Positive side */}
      <div style={{ width: 50, height: 6, background: '#f0f0f4', borderRadius: 4 }}>
        {score > 0 && (
          <div style={{ width: `${filled * 2}%`, height: 6, background: '#10b981', borderRadius: 4 }} />
        )}
      </div>
    </div>
  );
}

function AnomalyCard({ anomaly }) {
  const sev = SEVERITY_CONFIG[anomaly.severity] || SEVERITY_CONFIG.medium;
  const deviation = anomaly.deviation;

  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderLeft: `4px solid ${sev.border}`,
      borderRadius: 10,
      padding: 16,
      marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10, gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{anomaly.metric}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            Detected: {new Date(anomaly.time_detected).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
        <span style={{ background: sev.bg, color: sev.color, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, whiteSpace: 'nowrap' }}>
          {sev.label}
        </span>
      </div>

      {/* Observed vs Expected */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ background: '#f9fafb', borderRadius: 8, padding: '8px 14px', flex: 1, minWidth: 100 }}>
          <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginBottom: 3 }}>Observed</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#dc2626' }}>{anomaly.observed}</div>
        </div>
        <div style={{ background: '#f9fafb', borderRadius: 8, padding: '8px 14px', flex: 1, minWidth: 100 }}>
          <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginBottom: 3 }}>Expected</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#15803d' }}>{anomaly.expected}</div>
        </div>
        <div style={{ background: sev.bg, borderRadius: 8, padding: '8px 14px', flex: 1, minWidth: 100 }}>
          <div style={{ fontSize: 10, color: sev.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3 }}>Deviation</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: sev.color }}>
            {deviation > 0 ? '+' : ''}{deviation}
          </div>
        </div>
      </div>

      {/* Root causes */}
      {anomaly.possible_causes?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Root Cause Analysis</div>
          {anomaly.possible_causes.map((c, i) => (
            <ProbabilityBar key={i} label={c.cause} probability={c.probability} />
          ))}
        </div>
      )}

      {/* Affected depts */}
      {anomaly.affected_depts?.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#6b7280', marginRight: 4 }}>Affected:</span>
          {anomaly.affected_depts.map(d => (
            <span key={d} style={{ background: '#f3f4f6', color: '#374151', fontSize: 11, padding: '2px 8px', borderRadius: 5, fontWeight: 500 }}>{d}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * @prop {Object}   data     — { anomalies[], correlations[] }
 * @prop {boolean}  loading
 * @prop {string}   error
 * @prop {Function} onAction
 */
export default function DiagnosticPanel({ data, loading = false, error = null, onAction: _onAction = () => {} }) {
  if (loading) {
    return (
      <div>
        {[1, 2].map(i => <SkeletonCard key={i} rows={5} />)}
      </div>
    );
  }

  if (error) return <ErrorState error={error} compact />;

  if (!data?.anomalies?.length && !data?.correlations?.length) {
    return (
      <EmptyState
        type="analytics"
        title="No anomalies detected"
        subtitle="The system found no significant deviations in the selected period."
        compact
      />
    );
  }

  return (
    <div>
      {/* Anomalies section */}
      {data.anomalies?.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 12 }}>
            🔍 Detected Anomalies ({data.anomalies.length})
          </div>
          {data.anomalies.map(a => <AnomalyCard key={a.id} anomaly={a} />)}
        </div>
      )}

      {/* Correlation matrix */}
      {data.correlations?.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 12 }}>
            📈 Correlation Analysis
          </div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' }}>Factor A</th>
                  <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' }}>Factor B</th>
                  <th style={{ padding: '10px 16px', textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' }}>Correlation</th>
                  <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' }}>Insight</th>
                </tr>
              </thead>
              <tbody>
                {data.correlations.map((c, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '12px 16px', fontWeight: 600, color: '#374151' }}>{c.factor_a}</td>
                    <td style={{ padding: '12px 16px', fontWeight: 600, color: '#374151' }}>{c.factor_b}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                      <CorrelationBar score={c.correlation} />
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 12, color: '#6b7280', fontStyle: 'italic' }}>{c.insight}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
