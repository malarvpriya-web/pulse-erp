import axios from 'axios';

const AUTH_KEYS = ['token', 'user', 'role', 'permissions'];
const BASE_URL  = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

// ── Token refresh state ───────────────────────────────────────────────────────
// Collapses concurrent 401 responses into a single refresh attempt.
// All pending requests subscribe and replay once the new token arrives.
let isRefreshing = false;
let refreshQueue = []; // Array of { resolve, reject }

function drainQueue(token, error) {
  refreshQueue.forEach(({ resolve, reject }) => error ? reject(error) : resolve(token));
  refreshQueue = [];
}

function hardLogout(reason = 'session_expired') {
  AUTH_KEYS.forEach(k => localStorage.removeItem(k));
  sessionStorage.setItem('auth_redirect', reason);
  window.location.replace('/');
}

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const status  = err.response?.status;
    const url     = err.config?.url ?? '';
    const origReq = err.config;

    // ── 401 handling with silent token refresh ────────────────────────────────
    if (
      status === 401 &&
      !url.includes('/auth/login') &&
      !url.includes('/auth/refresh') &&
      !origReq._retried
    ) {
      origReq._retried = true; // prevent retry loops

      const currentToken = localStorage.getItem('token');
      if (!currentToken) {
        // No token but stale auth keys may remain — clear them without redirecting.
        // A hard redirect here causes an infinite loop when unauthenticated pages
        // (e.g. /health) return 401. React Router guards handle the redirect naturally.
        AUTH_KEYS.forEach(k => localStorage.removeItem(k));
        return Promise.reject(err);
      }

      if (isRefreshing) {
        // Another request already started a refresh — queue this one
        return new Promise((resolve, reject) => {
          refreshQueue.push({
            resolve: (newToken) => {
              origReq.headers.Authorization = `Bearer ${newToken}`;
              resolve(api(origReq));
            },
            reject,
          });
        });
      }

      isRefreshing = true;

      try {
        const { data } = await axios.post(
          `${BASE_URL}/auth/refresh`,
          {},
          { headers: { Authorization: `Bearer ${currentToken}` } }
        );

        const newToken = data.token;
        localStorage.setItem('token', newToken);
        if (data.user) {
          localStorage.setItem('user',  JSON.stringify(data.user));
          localStorage.setItem('role',  data.user.role);
          // 'role' is only the primary role — persist the full set too, or
          // role-gated UI regresses to single-role behaviour after a refresh.
          if (Array.isArray(data.user.roles) && data.user.roles.length) {
            localStorage.setItem('roles', JSON.stringify(data.user.roles.map(r => String(r).toLowerCase())));
          }
        }

        // Notify AuthContext about the new token without a full page reload
        window.dispatchEvent(new CustomEvent('pulse:token-refreshed', { detail: data }));

        drainQueue(newToken, null);
        origReq.headers.Authorization = `Bearer ${newToken}`;
        return api(origReq);
      } catch (refreshErr) {
        drainQueue(null, refreshErr);
        hardLogout();
        return Promise.reject(refreshErr);
      } finally {
        isRefreshing = false;
      }
    }

    if (status === 403) {
      const wrapped = new Error(
        err.response?.data?.message || 'You do not have permission to perform this action.'
      );
      wrapped.status = 403;
      wrapped.originalError = err;
      return Promise.reject(wrapped);
    }

    if (status >= 500) {
      const wrapped = new Error(
        err.response?.data?.message ||
        err.response?.data?.error ||
        'A server error occurred. Please try again later.'
      );
      wrapped.status = status;
      wrapped.originalError = err;
      return Promise.reject(wrapped);
    }

    return Promise.reject(err);
  }
);

export default api;
