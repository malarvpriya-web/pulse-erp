/**
 * DescriptivePanel — "What happened" analytics panel.
 * All data via props. Zero internal API calls.
 */
import { useState } from 'react';
import { TrendingUp, TrendingDown, Download, Minus } from 'lucide-react';
import { SkeletonKPI, SkeletonText } from '../core/Skeletons';
import { EmptyState } from '../core/EmptyStates';
import { ErrorState } from '../core/ErrorStates';

const PERIODS = ['This Month', 'Last Month', 'This Quarter', 'YTD', 'Last FY'];

function formatValue(value, format) {
  if (value == null) return '—';
  switch (format) {
    case 'currency':
      if (Math.abs(value) >= 1e7)  return `₹${(value / 1e7).toFixed(1)} Cr`;
      if (Math.abs(value) >= 1e5)  return `₹${(value / 1e5).toFixed(1)} L`;
      if (Math.abs(value) >= 1e3)  return `₹${(value / 1e3).toFixed(0)} K`;
      return `₹${value}`;
    case 'percent':
      return `${Number(value).toFixed(1)}%`;
    case 'number':
    default:
      return Number(value).toLocaleString('en-IN');
  }
}

function calcChange(current, prev) {
  if (!prev || prev === 0) return null;
  return ((current - prev) / prev) * 100;
}

function MetricCard({ metric, onAction }) {
  const change = calcChange(metric.value, metric.prev);
  const isPositive = metric.trendGoodWhenDown ? change < 0 : change >= 0;
  const trendColor = change === null ? '#9ca3af' : isPositive ? '#15803d' : '#dc2626';
  const trendBg    = change === null ? '#f3f4f6' : isPositive ? '#dcfce7'  : '#fee2e2';

  return (
    <div
      onClick={() => onAction({ type: 'drill_down', payload: { metric: metric.label } })}
      style={{
        background: '#fff',
        border: '1px solid #ebebf0',
        borderRadius: 12,
        padding: '16px 18px',
        cursor: 'pointer',
        transition: 'box-shadow .15s',
      }}
      onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,.08)'}
      onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
        {metric.label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color: '#111827', lineHeight: 1.1, marginBottom: 8 }}>
        {formatValue(metric.value, metric.format)}
      </div>
      {change !== null && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, background: trendBg, color: trendColor, fontSize: 11, fontWeight: 700 }}>
          {change >= 0
            ? <TrendingUp size={11} />
            : <TrendingDown size={11} />}
          {Math.abs(change).toFixed(1)}% vs prev
        </div>
      )}
      {change === null && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, background: '#f3f4f6', color: '#9ca3af', fontSize: 11 }}>
          <Minus size={11} /> No comparison
        </div>
      )}
    </div>
  );
}

/**
 * @prop {Object}   data        — { period, metrics[], highlights[] }
 * @prop {boolean}  loading
 * @prop {string}   error
 * @prop {Function} onAction    — ({ type, payload })
 */
export default function DescriptivePanel({ data, loading = false, error = null, onAction = () => {} }) {
  const [selectedPeriod, setSelectedPeriod] = useState(data?.period || PERIODS[0]);

  if (loading) {
    return (
      <div style={{ padding: '4px 0' }}>
        <SkeletonKPI count={4} />
        <div style={{ marginTop: 20 }}><SkeletonText lines={4} /></div>
      </div>
    );
  }

  if (error) return <ErrorState error={error} compact />;

  if (!data?.metrics?.length) {
    return <EmptyState type="analytics" compact action={{ label: 'Refresh Data', onClick: () => onAction({ type: 'filter', payload: {} }) }} />;
  }

  const exportData = () => {
    const rows = data.metrics.map(m => [m.label, m.value, m.prev, formatValue(m.value, m.format)].join(','));
    const csv  = ['Metric,Current,Previous,Formatted', ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `descriptive-${selectedPeriod.replace(/\s+/g, '-')}.csv`; a.click();
    URL.revokeObjectURL(url);
    onAction({ type: 'export', payload: { period: selectedPeriod } });
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Performance Summary</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Key metrics for {selectedPeriod}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={selectedPeriod}
            onChange={e => { setSelectedPeriod(e.target.value); onAction({ type: 'filter', payload: { period: e.target.value } }); }}
            style={{ border: '1px solid #d1d5db', borderRadius: 8, padding: '6px 10px', fontSize: 13, color: '#374151', background: '#fff', cursor: 'pointer' }}
          >
            {PERIODS.map(p => <option key={p}>{p}</option>)}
          </select>
          <button
            onClick={exportData}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, color: '#374151', cursor: 'pointer' }}
          >
            <Download size={13} /> Export
          </button>
        </div>
      </div>

      {/* Metric cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
        {data.metrics.map((m, i) => (
          <MetricCard key={i} metric={m} onAction={onAction} />
        ))}
      </div>

      {/* Highlights */}
      {data.highlights?.length > 0 && (
        <div style={{ background: '#f8faff', border: '1px solid #e0e7ff', borderRadius: 12, padding: '14px 18px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#4338ca', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>
            📋 Key Highlights — {selectedPeriod}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.highlights.map((h, i) => (
              <li key={i} style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{h}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
