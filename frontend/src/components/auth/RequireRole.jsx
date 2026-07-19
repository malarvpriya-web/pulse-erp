/**
 * RequireRole — RBAC guard component.
 * Wraps content that should only be accessible to specific roles.
 */
import { Navigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

export function RequireRole({ roles = [], children, fallback = null }) {
  const { isLoggedIn, role } = useAuth();

  if (!isLoggedIn) {
    return <Navigate to="/" replace />;
  }

  if (roles.length > 0 && !roles.includes(role)) {
    return fallback || (
      <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}><Lock size={48} color="#9ca3af" strokeWidth={1.5} /></div>
        <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#374151' }}>
          Access Restricted
        </h3>
        <p style={{ margin: 0, fontSize: 14, color: '#9ca3af' }}>
          You don't have permission to view this page.
        </p>
      </div>
    );
  }

  return children;
}

export default RequireRole;
