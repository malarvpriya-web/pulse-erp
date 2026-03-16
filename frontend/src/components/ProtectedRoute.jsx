import { useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';

export default function ProtectedRoute({ children, allowedRoles = [] }) {
  const { isLoggedIn, role } = useAuth();

  useEffect(() => {
    if (!isLoggedIn) {
      window.location.href = '/';
      return;
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(role)) {
      window.location.href = '/unauthorized';
    }
  }, [isLoggedIn, role, allowedRoles]);

  if (!isLoggedIn) return null;
  return children;
}
