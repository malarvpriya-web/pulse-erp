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

// ── Rate-limit (429) retry budget ─────────────────────────────────────────────
// Deliberately small: this smooths a burst, it is not a way to sit out a real
// throttle. Anything longer than RL_MAX_WAIT_SEC is reported to the user.
const RL_MAX_RETRIES  = 2;
const RL_MAX_WAIT_SEC = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    // ── 429 handling ──────────────────────────────────────────────────────────
    // The global limiter (300/min/IP) is a backstop for scripted floods, but a
    // burst of navigation — or several pages each fanning out to a handful of
    // endpoints — can clip it. The server replies with Retry-After and a clean
    // body, so honour it here once, centrally, instead of every page inventing
    // its own retry.
    //
    // Only GET/HEAD are replayed. Auto-retrying a POST/PUT/DELETE risks a
    // duplicate write, and the server never told us the first one didn't land.
    // A long Retry-After is surfaced immediately rather than freezing the UI
    // for the rest of the window.
    if (status === 429) {
      const method = String(origReq?.method || 'get').toLowerCase();
      const retryAfterSec = Number(
        err.response?.headers?.['retry-after'] ?? err.response?.data?.retry_after ?? 0
      );
      const attempts = origReq._rlRetries ?? 0;

      if (
        origReq &&
        (method === 'get' || method === 'head') &&
        attempts < RL_MAX_RETRIES &&
        retryAfterSec > 0 &&
        retryAfterSec <= RL_MAX_WAIT_SEC
      ) {
        origReq._rlRetries = attempts + 1;
        // Jitter so a page that fired several requests together doesn't
        // resend them in the same instant and trip the limiter again.
        await sleep(retryAfterSec * 1000 + Math.random() * 400);
        return api(origReq);
      }

      const wrapped = new Error(
        err.response?.data?.error ||
        'Too many requests. Please wait a moment and try again.'
      );
      wrapped.status = 429;
      wrapped.retryAfter = retryAfterSec || null;
      wrapped.response = err.response;
      wrapped.originalError = err;
      return Promise.reject(wrapped);
    }

    if (status === 403) {
      const wrapped = new Error(
        err.response?.data?.message || 'You do not have permission to perform this action.'
      );
      wrapped.status = 403;
      wrapped.response = err.response;
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
      wrapped.response = err.response;
      wrapped.originalError = err;
      return Promise.reject(wrapped);
    }

    return Promise.reject(err);
  }
);

export default api;
