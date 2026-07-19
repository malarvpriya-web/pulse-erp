// PATH: frontend/src/components/core/ChartWrapper.jsx
/**
 * ChartWrapper — adds expand/fullscreen, export, and loading skeleton
 * to any chart component.
 *
 * @example
 * <ChartWrapper title="Revenue Trend" subtitle="Last 12 months" height={240}
 *   filters={<select>...</select>} onExport={() => {}}>
 *   <ResponsiveContainer>...</ResponsiveContainer>
 * </ChartWrapper>
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, Download, Filter, X, RefreshCw } from 'lucide-react';

// ---------------------------------------------------------------------------
// Shimmer skeleton
// ---------------------------------------------------------------------------
function ChartSkeleton({ height }) {
  return (
    <div style={{ height, borderRadius: 8, overflow: 'hidden', position: 'relative', background: '#f5f3ff' }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(90deg, #f5f3ff 25%, #e9e4ff 50%, #f5f3ff 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.4s infinite',
      }} />
      <style>{`@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function ChartWrapper({
  title,
  subtitle,
  children,
  height      = 240,
  onExport,
  filters,
  loading     = false,
  lastUpdated,
  className,
  style,
}) {
  const [fullscreen,     setFullscreen]     = useState(false);
  const [showFilters,    setShowFilters]    = useState(false);
  const [exportDropdown, setExportDropdown] = useState(false);
  const containerRef = useRef(null);
  const exportRef    = useRef(null);

  // Close export dropdown on outside click
  useEffect(() => {
    if (!exportDropdown) return;
    const handler = (e) => {
      if (exportRef.current && !exportRef.current.contains(e.target)) setExportDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportDropdown]);

  // Escape key closes fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [fullscreen]);

  const handleExport = useCallback(async (format = 'svg') => {
    setExportDropdown(false);
    if (onExport) { onExport(format); return; }

    if (format === 'print') { window.print(); return; }

    // Try html2canvas if available
    try {
      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(containerRef.current, { backgroundColor: '#ffffff', scale: 2 });
      const link = document.createElement('a');
      link.download = `${title || 'chart'}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      return;
    } catch (_) {}

    // SVG fallback: find SVG inside container and download it
    const svgEl = containerRef.current?.querySelector('svg');
    if (svgEl) {
      const serializer = new XMLSerializer();
      const svgStr = serializer.serializeToString(svgEl);
      const blob = new Blob([svgStr], { type: 'image/svg+xml' });
      const url  = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `${title || 'chart'}.svg`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    }
  }, [onExport, title]);

  const cardStyle = {
    background: '#fff',
    border: '1px solid #f0f0f4',
    borderRadius: 12,
    overflow: 'hidden',
    ...style,
  };

  const header = (
    <div style={{
      padding: '14px 18px 10px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      borderBottom: '1px solid #f5f3ff',
    }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{subtitle}</div>}
        {lastUpdated && (
          <div style={{ fontSize: 11, color: '#c4b5fd', marginTop: 2 }}>
            Updated {typeof lastUpdated === 'string' ? lastUpdated : new Date(lastUpdated).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {filters && (
          <button
            onClick={() => setShowFilters(p => !p)}
            title="Toggle filters"
            style={{
              padding: '5px 8px', border: 'none', borderRadius: 6, cursor: 'pointer',
              background: showFilters ? '#f5f3ff' : 'transparent',
              color: showFilters ? '#7c3aed' : '#9ca3af',
            }}>
            <Filter size={14} />
          </button>
        )}
        <div ref={exportRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setExportDropdown(p => !p)}
            title="Export chart"
            style={{ padding: '5px 8px', border: 'none', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: '#9ca3af' }}>
            <Download size={14} />
          </button>
          {exportDropdown && (
            <div style={{
              position: 'absolute', right: 0, top: '100%', zIndex: 100,
              background: '#fff', border: '1px solid #e9e4ff', borderRadius: 8,
              boxShadow: '0 8px 24px rgba(124,58,237,0.12)',
              minWidth: 130, padding: '4px 0',
            }}>
              {[['SVG', 'svg'], ['PNG', 'png'], ['Print', 'print']].map(([label, fmt]) => (
                <button key={fmt} onClick={() => handleExport(fmt)} style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '8px 14px', border: 'none', background: 'transparent',
                  cursor: 'pointer', fontSize: 13, color: '#374151',
                }}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => setFullscreen(true)}
          title="Expand fullscreen"
          style={{ padding: '5px 8px', border: 'none', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: '#9ca3af' }}>
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );

  const filterPanel = filters && showFilters && (
    <div style={{ padding: '10px 18px', background: '#fafafe', borderBottom: '1px solid #f5f3ff' }}>
      {filters}
    </div>
  );

  const body = (
    <div ref={containerRef} style={{ padding: '12px 8px 8px' }}>
      {loading ? <ChartSkeleton height={height} /> : children}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Fullscreen modal
  // ---------------------------------------------------------------------------
  const fullscreenModal = fullscreen && createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      background: 'rgba(0,0,0,0.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 32,
    }} onClick={(e) => { if (e.target === e.currentTarget) setFullscreen(false); }}>
      <div style={{
        width: '90vw', height: '85vh',
        background: '#fff', borderRadius: 16,
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 80px rgba(0,0,0,0.35)',
        overflow: 'hidden',
      }}>
        {/* Fullscreen header */}
        <div style={{
          padding: '16px 24px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderBottom: '1px solid #f0f0f4',
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 18, color: '#111827' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{subtitle}</div>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => handleExport('png')} style={{
              padding: '7px 14px', background: '#f5f3ff', color: '#7c3aed',
              border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', fontSize: 13,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <Download size={14} /> Export
            </button>
            <button onClick={() => setFullscreen(false)} style={{
              padding: '7px 12px', background: 'transparent', border: '1px solid #f0f0f4',
              borderRadius: 8, cursor: 'pointer', color: '#6b7280',
            }}>
              <X size={16} />
            </button>
          </div>
        </div>
        {/* Filters always visible in fullscreen */}
        {filters && (
          <div style={{ padding: '10px 24px', background: '#fafafe', borderBottom: '1px solid #f5f3ff' }}>
            {filters}
          </div>
        )}
        {/* Chart expanded */}
        <div style={{ flex: 1, padding: '16px 16px 12px', overflow: 'hidden' }}>
          {loading ? <ChartSkeleton height="100%" /> : (
            // Clone children and pass expanded height
            <div style={{ width: '100%', height: '100%' }}>
              {children}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );

  return (
    <>
      <div className={className} style={cardStyle}>
        {header}
        {filterPanel}
        {body}
      </div>
      {fullscreenModal}
    </>
  );
}
