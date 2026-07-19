/**
 * Skeleton loader system — animated shimmer placeholders.
 * Use while data is loading to prevent layout shift.
 */

const shimmerStyle = {
  background: 'linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)',
  backgroundSize: '200% 100%',
  animation: 'skeletonShimmer 1.5s infinite',
  borderRadius: 6,
};

/* Inject keyframe once */
if (typeof document !== 'undefined' && !document.getElementById('skeleton-style')) {
  const style = document.createElement('style');
  style.id = 'skeleton-style';
  style.textContent = `
    @keyframes skeletonShimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
  `;
  document.head.appendChild(style);
}

export function SkeletonLine({ width = '100%', height = 14, mb = 8, style: extra = {} }) {
  return (
    <div style={{ ...shimmerStyle, width, height, marginBottom: mb, ...extra }} />
  );
}

export function SkeletonCard({ rows = 3 }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #ebebf0', borderRadius: 12, padding: 18 }}>
      <SkeletonLine width="60%" height={16} mb={14} />
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonLine key={i} width={i % 2 === 0 ? '100%' : '80%'} height={12} mb={10} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 6 }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #ebebf0', borderRadius: 12, overflow: 'hidden' }}>
      {/* Header row */}
      <div style={{ display: 'flex', gap: 12, padding: '12px 16px', background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
        {Array.from({ length: cols }, (_, i) => (
          <SkeletonLine key={i} width={`${100 / cols}%`} height={11} mb={0} />
        ))}
      </div>
      {/* Body rows */}
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'flex', gap: 12, padding: '11px 16px', borderBottom: '1px solid #f9fafb' }}>
          {Array.from({ length: cols }, (_, c) => (
            <SkeletonLine key={c} width={`${100 / cols}%`} height={13} mb={0}
              style={{ opacity: 0.5 + (c === 0 ? 0.5 : 0) }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonKPI({ count = 4 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)`, gap: 14 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ background: '#fff', border: '1px solid #ebebf0', borderRadius: 12, padding: 18, display: 'flex', gap: 12 }}>
          <div style={{ ...shimmerStyle, width: 40, height: 40, borderRadius: 10, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <SkeletonLine width="50%" height={10} mb={8} />
            <SkeletonLine width="70%" height={22} mb={6} />
            <SkeletonLine width="40%" height={10} mb={0} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonChart({ height = 240 }) {
  return (
    <div style={{ ...shimmerStyle, width: '100%', height, borderRadius: 10 }} />
  );
}

export function SkeletonAvatar({ size = 40 }) {
  return (
    <div style={{ ...shimmerStyle, width: size, height: size, borderRadius: '50%', flexShrink: 0 }} />
  );
}

export function SkeletonBadge({ width = 80 }) {
  return (
    <div style={{ ...shimmerStyle, width, height: 22, borderRadius: 20 }} />
  );
}

export function SkeletonText({ lines = 3, lastWidth = '60%' }) {
  return (
    <div>
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonLine
          key={i}
          width={i === lines - 1 ? lastWidth : '100%'}
          height={13}
          mb={i === lines - 1 ? 0 : 8}
        />
      ))}
    </div>
  );
}
