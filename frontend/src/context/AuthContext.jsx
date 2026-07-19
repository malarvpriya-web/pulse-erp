import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';

const AuthContext = createContext(null);

const MODULE_ALIASES = {
  leave: ['leave', 'leaves'],
  leaves: ['leaves', 'leave'],
};

const normalizeRole = (value) => String(value || '').toLowerCase();

// Roles are many-to-many (user_roles). `role` is only the PRIMARY role — any UI
// gate that reads it alone will hide menus from someone whose extra roles grant
// them. Gate on `roles` / hasAnyRole() instead.
const deriveRoles = (user, fallbackRole) => {
  const list = Array.isArray(user?.roles) ? user.roles : null;
  if (list?.length) return list.map(normalizeRole);
  const single = normalizeRole(fallbackRole ?? user?.role);
  return single ? [single] : [];
};

// Re-fetch permissions at most once per this window when the tab regains focus
const PERM_REFETCH_INTERVAL = 5 * 60 * 1000;

export function AuthProvider({ children }) {
  const [user,        setUser]        = useState(null);
  const [role,        setRole]        = useState(null);
  const [roles,       setRoles]       = useState([]);
  const [token,       setToken]       = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [menuOverrides, setMenuOverrides] = useState({});
  const [needsSetup,  setNeedsSetup]  = useState(false);
  const [initializing, setInitializing] = useState(true);

  const lastPermFetch = useRef(0);

  // ── Restore session from localStorage ──────────────────────────────────────
  useEffect(() => {
    let active = true;
    const storedToken = localStorage.getItem('token');
    const storedUser  = localStorage.getItem('user');
    const storedRole  = localStorage.getItem('role');
    const storedRoles = localStorage.getItem('roles');
    const storedPerms = localStorage.getItem('permissions');
    const storedMenu  = localStorage.getItem('menuOverrides');

    if (storedToken && storedUser && storedRole) {
      const parsedUser = JSON.parse(storedUser);
      setToken(storedToken);
      setUser(parsedUser);
      setRole(storedRole);
      // Sessions that predate the roles array fall back to [role] — no re-login.
      let restoredRoles = [];
      try { restoredRoles = storedRoles ? JSON.parse(storedRoles) : []; } catch { restoredRoles = []; }
      if (!Array.isArray(restoredRoles) || !restoredRoles.length) {
        restoredRoles = deriveRoles(parsedUser, storedRole);
      }
      setRoles(restoredRoles);
      try {
        const parsedPerms = storedPerms ? JSON.parse(storedPerms) : [];
        setPermissions(Array.isArray(parsedPerms) ? parsedPerms : []);
      } catch { setPermissions([]); }
      try { setMenuOverrides(storedMenu ? JSON.parse(storedMenu) : {}); } catch { setMenuOverrides({}); }
      if (restoredRoles.includes('super_admin')) {
        // Always query the DB — localStorage must never be the authority for wizard state.
        api.get('/settings/setup-progress', {
          headers: { Authorization: `Bearer ${storedToken}` },
        }).then(({ data }) => {
          if (active) setNeedsSetup(data.needsSetup === true);
        }).catch(() => {
          // On network error keep wizard hidden — avoids false positive on transient blip.
        });
      }
    }
    setInitializing(false);
    return () => { active = false; };
  }, []);

  // ── Shared login finalisation ───────────────────────────────────────────────
  const loginWithToken = useCallback(async (newToken, newUser) => {
    const permsRes = await api.get('/auth/permissions', {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    const newPerms = Array.isArray(permsRes.data.permissions) ? permsRes.data.permissions : [];
    const newMenu  = permsRes.data.menuOverrides || {};

    const newRoles = deriveRoles(newUser, newUser.role);

    localStorage.setItem('token',         newToken);
    localStorage.setItem('user',          JSON.stringify(newUser));
    localStorage.setItem('role',          newUser.role);
    localStorage.setItem('roles',         JSON.stringify(newRoles));
    localStorage.setItem('permissions',   JSON.stringify(newPerms));
    localStorage.setItem('menuOverrides', JSON.stringify(newMenu));

    setToken(newToken);
    setUser(newUser);
    setRole(newUser.role);
    setRoles(newRoles);
    setPermissions(newPerms);
    setMenuOverrides(newMenu);

    if (newRoles.includes('super_admin')) {
      try {
        const { data } = await api.get('/settings/setup-progress', {
          headers: { Authorization: `Bearer ${newToken}` },
        });
        setNeedsSetup(data.needsSetup === true);
      } catch {
        // Don't show wizard on transient error — user can navigate to it manually.
      }
    }

    return newUser;
  }, []);

  const login = useCallback(async (email, password, rememberMe = false) => {
    const { data } = await api.post('/auth/login', { email, password, rememberMe });
    return loginWithToken(data.token, data.user);
  }, [loginWithToken]);

  // ── Logout — stamps logout_at on the server so any live tokens are revoked ─
  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch { /* best-effort — proceed regardless */ }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('role');
    localStorage.removeItem('roles');
    localStorage.removeItem('permissions');
    localStorage.removeItem('menuOverrides');
    sessionStorage.removeItem('wizard_seen');
    sessionStorage.removeItem('wizard_current_step');
    sessionStorage.removeItem('setup_progress_cache');
    setToken(null);
    setUser(null);
    setRole(null);
    setRoles([]);
    setPermissions([]);
    setMenuOverrides({});
    setNeedsSetup(false);
    window.location.replace('/');
  }, []);

  // ── Listen for tokens silently refreshed by the axios 401 interceptor ─────
  useEffect(() => {
    const handler = (e) => {
      const { token: newToken, user: newUser } = e.detail || {};
      if (!newToken) return;
      localStorage.setItem('token', newToken);
      if (newUser) {
        const refreshedRoles = deriveRoles(newUser, newUser.role);
        localStorage.setItem('user', JSON.stringify(newUser));
        localStorage.setItem('role', newUser.role);
        localStorage.setItem('roles', JSON.stringify(refreshedRoles));
        setUser(newUser);
        setRole(newUser.role);
        setRoles(refreshedRoles);
      }
      setToken(newToken);
    };
    window.addEventListener('pulse:token-refreshed', handler);
    return () => window.removeEventListener('pulse:token-refreshed', handler);
  }, []);

  // ── Re-fetch permissions when the tab regains focus or on a 15-minute timer ──
  // Guards against stale permissions after an admin changes them server-side.
  // The interval covers tabs that never lose focus (e.g. kiosk / always-open session).
  useEffect(() => {
    if (!token) return;

    const refreshPerms = async () => {
      if (Date.now() - lastPermFetch.current < PERM_REFETCH_INTERVAL) return;
      lastPermFetch.current = Date.now();
      try {
        const { data } = await api.get('/auth/permissions');
        const newPerms = Array.isArray(data.permissions) ? data.permissions : [];
        const newMenu  = data.menuOverrides || {};
        localStorage.setItem('permissions', JSON.stringify(newPerms));
        localStorage.setItem('menuOverrides', JSON.stringify(newMenu));
        setPermissions(newPerms);
        setMenuOverrides(newMenu);
        if (data.role) {
          localStorage.setItem('role', data.role);
          setRole(data.role);
        }
        // Picks up role grants/revocations made by an admin mid-session.
        if (Array.isArray(data.roles) && data.roles.length) {
          const refreshed = data.roles.map(normalizeRole);
          localStorage.setItem('roles', JSON.stringify(refreshed));
          setRoles(refreshed);
        }
      } catch { /* stale permissions are better than crashing */ }
    };

    window.addEventListener('focus', refreshPerms);
    const timer = setInterval(refreshPerms, PERM_REFETCH_INTERVAL);
    return () => {
      window.removeEventListener('focus', refreshPerms);
      clearInterval(timer);
    };
  }, [token]);

  // ── Role helpers ────────────────────────────────────────────────────────────
  // True when ANY role held matches — the multi-role equivalent of `role === x`.
  const hasAnyRole = useCallback((...codes) => {
    const want = codes.flat().map(normalizeRole);
    return roles.some(r => want.includes(r));
  }, [roles]);

  // True only when `employee` is the ONLY role held. Mirrors the backend's
  // isEmployee fork in home.service.js — hold any second role and you are not
  // an employee-only view.
  const isEmployeeOnly = roles.length > 0 && roles.every(r => r === 'employee');

  // ── Permission helpers ──────────────────────────────────────────────────────
  const hasPermission = useCallback((module, action) => {
    if (hasAnyRole('super_admin', 'admin')) return true;
    const moduleNames = MODULE_ALIASES[module] || [module];
    // Guard against a non-array permissions value (e.g. legacy localStorage that
    // stored an object) — never let a bad shape crash the whole app.
    const permList = Array.isArray(permissions) ? permissions : [];
    const modulePermission = permList.find(p => moduleNames.includes(p.module));
    if (!modulePermission) return false;
    const actionMap = {
      view: 'can_view', add: 'can_add', edit: 'can_edit',
      delete: 'can_delete', approve: 'can_approve', export: 'can_export',
    };
    return modulePermission[actionMap[action]] === true;
  }, [hasAnyRole, permissions]);

  const getVisibleModules = useCallback(() => {
    if (hasAnyRole('super_admin', 'admin')) return null;
    const permList = Array.isArray(permissions) ? permissions : [];
    return permList.filter(p => p.can_view).map(p => p.module);
  }, [hasAnyRole, permissions]);

  // Admin-configured page access override for a registry module id.
  // Returns 'hidden' | 'view' | 'edit' when explicitly set, else null (use defaults).
  // super_admin is never restricted so it can always reach the config screen.
  const menuAccess = useCallback((moduleId) => {
    if (hasAnyRole('super_admin')) return null;
    return menuOverrides?.[moduleId] ?? null;
  }, [hasAnyRole, menuOverrides]);

  const clearNeedsSetup = useCallback(() => setNeedsSetup(false), []);

  // ── Merge partial updates into the current user (e.g. after editing profile) ─
  // Keeps AuthContext + localStorage in sync so the topbar and rest of the app
  // reflect a saved display name immediately instead of falling back to login id.
  const updateUser = useCallback((patch) => {
    if (!patch) return;
    setUser(prev => {
      const next = { ...(prev || {}), ...patch };
      localStorage.setItem('user', JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <AuthContext.Provider value={{
      user, role, roles, token, permissions, menuOverrides, needsSetup,
      isLoggedIn: !!token,
      initializing,
      hasAnyRole, isEmployeeOnly,
      login, loginWithToken, logout, hasPermission, getVisibleModules, menuAccess,
      clearNeedsSetup, updateUser,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export default AuthContext;
