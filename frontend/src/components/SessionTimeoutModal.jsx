// frontend/src/components/SessionTimeoutModal.jsx
import { useEffect, useRef } from 'react';
import { AlertTriangle, Lock } from 'lucide-react';

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export default function SessionTimeoutModal({ timeRemaining, onExtend, onLogout }) {
  const totalMs  = 60 * 60 * 1000; // 1 hour warning window
  const pct      = Math.max(0, Math.min(100, (timeRemaining / totalMs) * 100));
  const isUrgent = timeRemaining < 5 * 60 * 1000; // last 5 minutes
  const btnRef   = useRef(null);

  // Auto-focus "Stay Logged In" on mount
  useEffect(() => {
    btnRef.current?.focus();
  }, []);

  // Prevent body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(3px)',
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: 32, maxWidth: 400, width: '90%',
        boxShadow: '0 24px 80px rgba(0,0,0,0.25)',
        border: `2px solid ${isUrgent ? '#fecaca' : '#e9e4ff'}`,
        animation: 'fadeSlideIn 0.2s ease-out',
      }}>
        {/* icon */}
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            {isUrgent
              ? <AlertTriangle size={48} color="#dc2626" strokeWidth={1.5} />
              : <Lock size={48} color="#7c3aed" strokeWidth={1.5} />
            }
          </div>
        </div>

        {/* title */}
        <h2 style={{ margin: '0 0 8px', textAlign: 'center', color: isUrgent ? '#dc2626' : '#4c1d95', fontSize: 20 }}>
          {isUrgent ? 'Session Expiring Soon!' : 'Still there?'}
        </h2>
        <p style={{ margin: '0 0 20px', textAlign: 'center', color: '#6b7280', fontSize: 14, lineHeight: 1.6 }}>
          Your session will automatically log out due to inactivity.
          Click <strong>Stay Logged In</strong> to continue.
        </p>

        {/* countdown ring */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 24 }}>
          <div style={{ position: 'relative', width: 100, height: 100 }}>
            <svg width="100" height="100" viewBox="0 0 100 100">
              {/* track */}
              <circle cx="50" cy="50" r="44" fill="none" stroke="#e9e4ff" strokeWidth="8"/>
              {/* progress */}
              <circle
                cx="50" cy="50" r="44" fill="none"
                stroke={isUrgent ? '#dc2626' : '#7c3aed'}
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 44}`}
                strokeDashoffset={`${2 * Math.PI * 44 * (1 - pct / 100)}`}
                transform="rotate(-90 50 50)"
                style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
              />
            </svg>
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column',
            }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: isUrgent ? '#dc2626' : '#7c3aed', fontFamily: 'monospace' }}>
                {formatTime(timeRemaining)}
              </span>
              <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 600 }}>remaining</span>
            </div>
          </div>
        </div>

        {/* progress bar (linear, below ring) */}
        <div style={{ height: 6, background: '#e9e4ff', borderRadius: 3, marginBottom: 24, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 3,
            width: `${pct}%`,
            background: isUrgent ? '#dc2626' : '#7c3aed',
            transition: 'width 1s linear',
          }}/>
        </div>

        {/* action buttons */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            ref={btnRef}
            onClick={onExtend}
            style={{
              flex: 2, padding: '11px', border: 'none', borderRadius: 10, cursor: 'pointer',
              background: '#7c3aed', color: '#fff', fontWeight: 700, fontSize: 14,
              boxShadow: '0 4px 14px rgba(124,58,237,0.35)',
            }}>
            ✓ Stay Logged In
          </button>
          <button
            onClick={onLogout}
            style={{
              flex: 1, padding: '11px', border: '1px solid #e9e4ff', borderRadius: 10, cursor: 'pointer',
              background: '#fff', color: '#6b7280', fontWeight: 600, fontSize: 13,
            }}>
            Log Out Now
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(-16px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0)     scale(1);    }
        }
      `}</style>
    </div>
  );
}
