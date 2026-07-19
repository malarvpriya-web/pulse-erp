import { AlertTriangle, Home, ArrowLeft } from 'lucide-react';

export default function NotFound({ setPage }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      minHeight: '60vh', padding: 40, textAlign: 'center',
    }}>
      <div style={{
        width: 80, height: 80, borderRadius: '50%',
        background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 24,
      }}>
        <AlertTriangle size={36} color="#f59e0b" />
      </div>

      <h1 style={{ fontSize: 64, fontWeight: 900, color: '#e5e7eb', margin: '0 0 8px', lineHeight: 1 }}>
        404
      </h1>
      <h2 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: '0 0 8px' }}>
        Page Not Found
      </h2>
      <p style={{ fontSize: 14, color: '#6b7280', maxWidth: 380, margin: '0 0 32px', lineHeight: 1.6 }}>
        The page you're looking for doesn't exist or may have been moved.
        Check the navigation menu for the right section.
      </p>

      <div style={{ display: 'flex', gap: 12 }}>
        <button
          onClick={() => setPage && setPage('Home')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '10px 20px', borderRadius: 8, border: 'none',
            background: '#6366f1', color: '#fff', cursor: 'pointer',
            fontSize: 14, fontWeight: 600,
          }}
        >
          <Home size={15} /> Go Home
        </button>
        <button
          onClick={() => window.history.back()}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '10px 20px', borderRadius: 8, border: '1px solid #e5e7eb',
            background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 14,
          }}
        >
          <ArrowLeft size={15} /> Go Back
        </button>
      </div>
    </div>
  );
}
