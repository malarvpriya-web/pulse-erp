import { useState } from 'react';

export default function PWAInstallBanner({ isOnline, canInstall, installApp, updateAvailable, applyUpdate }) {
  const [installDismissed, setInstallDismissed] = useState(false);

  return (
    <>
      {/* ── Offline indicator (red bar top of screen) ── */}
      {!isOnline && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: '#dc2626', color: '#fff',
          padding: '6px 16px', textAlign: 'center',
          fontSize: 13, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <span>●</span>
          You are offline — some features may be unavailable
        </div>
      )}

      {/* ── Update available banner ── */}
      {updateAvailable && (
        <div style={{
          position: 'fixed', top: isOnline ? 0 : 32, left: 0, right: 0, zIndex: 9998,
          background: '#7c3aed', color: '#fff',
          padding: '8px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
          fontSize: 13, fontWeight: 500,
        }}>
          <span>🔄 Update available — click to refresh Pulse ERP</span>
          <button
            onClick={applyUpdate}
            style={{
              background: '#fff', color: '#7c3aed', border: 'none', borderRadius: 6,
              padding: '4px 14px', cursor: 'pointer', fontWeight: 700, fontSize: 13,
            }}
          >
            Refresh now
          </button>
        </div>
      )}

      {/* ── Install prompt banner (bottom of screen) ── */}
      {canInstall && !installDismissed && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9997,
          background: '#fff', borderTop: '2px solid #e9e4ff',
          padding: '12px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
          boxShadow: '0 -4px 16px rgba(124,58,237,0.12)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40, height: 40, background: '#7c3aed', borderRadius: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20, flexShrink: 0,
            }}>
              ⚡
            </div>
            <div>
              <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 14 }}>
                Install Pulse ERP for quick access
              </div>
              <div style={{ color: '#6b7280', fontSize: 12 }}>
                Works offline · No app store needed · Instant launch
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={installApp}
              style={{
                background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8,
                padding: '9px 22px', cursor: 'pointer', fontWeight: 700, fontSize: 14,
              }}
            >
              Install
            </button>
            <button
              onClick={() => setInstallDismissed(true)}
              style={{
                background: '#f3f4f6', color: '#6b7280', border: 'none', borderRadius: 8,
                padding: '9px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 14,
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );
}
