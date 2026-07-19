import logo from '../assets/logo.png';

export default function AppLoadingScreen() {
  return (
    <>
      <style>{`
        @keyframes pulse-bar {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div style={{
        position: 'fixed', inset: 0, zIndex: 99998,
        background: 'linear-gradient(135deg, #f8f9ff 0%, #eef2ff 50%, #f0fdf4 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 24,
      }}>
        <div style={{ animation: 'fade-in-up 0.5s ease', textAlign: 'center' }}>
          <img src={logo} alt="Logo" style={{ height: 56, marginBottom: 12 }} />
          <h1 style={{ fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 }}>
            Manifest Technologies
          </h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
            Pulse ERP — Loading…
          </p>
        </div>

        {/* Loading bar */}
        <div style={{
          width: 220, height: 4, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: '40%',
            background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
            borderRadius: 4,
            animation: 'pulse-bar 1.2s ease-in-out infinite',
          }} />
        </div>
      </div>
    </>
  );
}
