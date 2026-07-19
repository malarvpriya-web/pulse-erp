// PATH: frontend/src/components/core/FYSelector.jsx
/**
 * FYSelector — Compact financial year selector pill with optional progress bar.
 *
 * Reads from and writes to FYContext. Drop anywhere in the layout.
 *
 * @example
 * <FYSelector showProgress />
 * <FYSelector compact />
 */
import { useState, useRef, useEffect } from 'react';
import { ChevronDown, CalendarDays, TrendingUp } from 'lucide-react';
import { useFY } from '@/context/FYContext';

export default function FYSelector({ showProgress = false, compact = false }) {
  const { selectedFY, setSelectedFY, fyLabel, fyProgress, fyStart, fyEnd, availableFYs, isCurrentFY } = useFY();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      {/* Pill trigger */}
      <button
        onClick={() => setOpen(p => !p)}
        title="Select Financial Year"
        style={{
          display:      'flex',
          alignItems:   'center',
          gap:          6,
          padding:      compact ? '4px 10px' : '6px 14px',
          background:   isCurrentFY ? '#7c3aed' : '#f5f3ff',
          color:        isCurrentFY ? '#fff' : '#7c3aed',
          border:       `1px solid ${isCurrentFY ? '#7c3aed' : '#e9e4ff'}`,
          borderRadius: 20,
          cursor:       'pointer',
          fontSize:     compact ? 12 : 13,
          fontWeight:   600,
          whiteSpace:   'nowrap',
          transition:   'all 0.15s',
        }}>
        <CalendarDays size={compact ? 13 : 14} />
        {fyLabel}
        {!isCurrentFY && (
          <span style={{
            fontSize: 10, background: '#fef3c7', color: '#d97706',
            padding: '1px 5px', borderRadius: 8, fontWeight: 600,
          }}>
            Past
          </span>
        )}
        <ChevronDown size={12} style={{ opacity: 0.7, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
      </button>

      {/* Optional progress bar */}
      {showProgress && isCurrentFY && (() => {
        const today    = new Date();
        const start    = new Date(fyStart);
        const end      = new Date(fyEnd);
        const totalDays   = Math.round((end - start) / 86400000) + 1;
        const elapsedDays = Math.round((today - start) / 86400000);
        const daysLeft    = totalDays - elapsedDays;
        const monthsLeft  = Math.ceil(daysLeft / 30.44);
        const barColor    = fyProgress < 50 ? '#10b981' : fyProgress < 80 ? '#f59e0b' : '#ef4444';
        const fmt = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
        const tooltip = `${elapsedDays} of ${totalDays} days elapsed (${fmt(start)} – ${fmt(today)})`;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              title={tooltip}
              style={{ flex: 1, height: 3, background: '#e9e4ff', borderRadius: 2, overflow: 'hidden', cursor: 'help' }}
            >
              <div style={{
                width: `${fyProgress}%`, height: '100%',
                background: `linear-gradient(90deg, ${barColor}, ${barColor}cc)`,
                borderRadius: 2, transition: 'width 0.5s',
              }} />
            </div>
            <span style={{ fontSize: 10, color: '#9ca3af', whiteSpace: 'nowrap' }}>
              {fyProgress}% · {monthsLeft}m left
            </span>
          </div>
        );
      })()}

      {/* Dropdown */}
      {open && (
        <div style={{
          position:   'absolute',
          top:        '100%',
          left:       0,
          zIndex:     300,
          marginTop:  6,
          background: '#fff',
          border:     '1px solid #e9e4ff',
          borderRadius: 10,
          boxShadow:  '0 8px 24px rgba(124,58,237,0.13)',
          minWidth:   180,
          padding:    '6px 0',
          maxHeight:  260,
          overflowY:  'auto',
        }}>
          <div style={{ padding: '4px 12px 8px', borderBottom: '1px solid #f5f3ff' }}>
            <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, letterSpacing: '0.04em' }}>
              SELECT FINANCIAL YEAR
            </span>
          </div>
          {availableFYs.map(f => {
            const isSel = f.fy === selectedFY;
            const isCur = f.fy === availableFYs.find(x => {
              const today = new Date();
              return today >= x.start && today <= x.end;
            })?.fy;
            return (
              <button
                key={f.fy}
                onClick={() => { setSelectedFY(f.fy); setOpen(false); }}
                style={{
                  display:    'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width:      '100%',
                  padding:    '8px 14px',
                  border:     'none',
                  background: isSel ? '#f5f3ff' : 'transparent',
                  color:      isSel ? '#7c3aed' : '#374151',
                  cursor:     'pointer',
                  fontSize:   13,
                  textAlign:  'left',
                  fontWeight: isSel ? 600 : 400,
                }}>
                {f.label}
                <div style={{ display: 'flex', gap: 4 }}>
                  {isCur && (
                    <span style={{
                      fontSize: 10, background: '#dcfce7', color: '#16a34a',
                      padding: '1px 6px', borderRadius: 8, fontWeight: 600,
                    }}>
                      Current
                    </span>
                  )}
                  {isSel && (
                    <span style={{ color: '#7c3aed', fontSize: 14, fontWeight: 700 }}>✓</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
