import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]               = useState(null);
  const [role, setRole]               = useState(null);
  const [token, setToken]             = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    const storedUser  = localStorage.getItem('user');
    const storedRole  = localStorage.getItem('role');
    const storedPerms = localStorage.getItem('permissions');

    if (storedToken && storedUser && storedRole) {
      setToken(storedToken);
      setUser(JSON.parse(storedUser));
      setRole(storedRole);
      setPermissions(storedPerms ? JSON.parse(storedPerms) : []);
    }
    setInitializing(false);
  }, []);

  const login = useCallback(async (email, password) => {
    const loginRes = await api.post('/auth/login', { email, password });
    const { token: newToken, user: newUser } = loginRes.data;

    const permsRes = await api.get('/auth/permissions', {
      headers: { Authorization: `Bearer ${newToken}` }
    });
    const newPerms = permsRes.data.permissions || [];

    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(newUser));
    localStorage.setItem('role', newUser.role);
    localStorage.setItem('permissions', JSON.stringify(newPerms));

    setToken(newToken);
    setUser(newUser);
    setRole(newUser.role);
    setPermissions(newPerms);

    return newUser;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('role');
    localStorage.removeItem('permissions');
    setToken(null);
    setUser(null);
    setRole(null);
    setPermissions([]);
    window.location.href = '/';
  }, []);

  const hasPermission = useCallback((module, action) => {
    if (role === 'super_admin' || role === 'admin') return true;
    const modulePermission = permissions.find(p => p.module === module);
    if (!modulePermission) return false;
    const actionMap = {
      view: 'can_view', add: 'can_add', edit: 'can_edit',
      delete: 'can_delete', approve: 'can_approve', export: 'can_export'
    };
    return modulePermission[actionMap[action]] === true;
  }, [role, permissions]);

  const getVisibleModules = useCallback(() => {
    if (role === 'super_admin' || role === 'admin') return null;
    return permissions.filter(p => p.can_view).map(p => p.module);
  }, [role, permissions]);

  return (
    <AuthContext.Provider value={{
      user, role, token, permissions,
      isLoggedIn: !!token,
      initializing,
      login, logout, hasPermission, getVisibleModules
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export default AuthContext;
