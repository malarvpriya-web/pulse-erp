import * as React from 'react';
import api from '@/services/api/client';

const WARN_AFTER_MS   = 7 * 60 * 60 * 1000; // warn at 7 h (1 h before 8 h default token)
const LOGOUT_AFTER_MS = 8 * 60 * 60 * 1000; // hard logout at 8 h
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];

export default function useSessionManager({ onLogout } = {}) {
  const [showWarning,        setShowWarning]        = React.useState(false);
  const [sessionTimeRemaining, setTimeRemaining]    = React.useState(LOGOUT_AFTER_MS - WARN_AFTER_MS);

  const lastActivityRef  = React.useRef(Date.now());
  const warnTimerRef     = React.useRef(null);
  const logoutTimerRef   = React.useRef(null);
  const countdownRef     = React.useRef(null);
  const isLoggedInRef    = React.useRef(!!localStorage.getItem('token'));

  const forceLogout = React.useCallback(() => {
    setShowWarning(false);
    clearTimeout(warnTimerRef.current);
    clearTimeout(logoutTimerRef.current);
    clearInterval(countdownRef.current);
    if (onLogout) {
      onLogout();
    } else {
      ['token', 'user', 'role', 'permissions'].forEach(k => localStorage.removeItem(k));
      sessionStorage.setItem('auth_redirect', 'session_expired');
      window.location.replace('/');
    }
  }, [onLogout]);

  const startCountdown = React.useCallback(() => {
    clearInterval(countdownRef.current);
    let remaining = LOGOUT_AFTER_MS - WARN_AFTER_MS;
    setTimeRemaining(remaining);
    countdownRef.current = setInterval(() => {
      remaining -= 1000;
      setTimeRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(countdownRef.current);
        forceLogout();
      }
    }, 1000);
  }, [forceLogout]);

  const scheduleTimers = React.useCallback(() => {
    clearTimeout(warnTimerRef.current);
    clearTimeout(logoutTimerRef.current);
    clearInterval(countdownRef.current);
    setShowWarning(false);

    warnTimerRef.current = setTimeout(() => {
      setShowWarning(true);
      startCountdown();
    }, WARN_AFTER_MS);

    logoutTimerRef.current = setTimeout(() => {
      forceLogout();
    }, LOGOUT_AFTER_MS);
  }, [startCountdown, forceLogout]);

  const recordActivity = React.useCallback(() => {
    lastActivityRef.current = Date.now();
    if (!showWarning) scheduleTimers();
  }, [showWarning, scheduleTimers]);

  const extendSession = React.useCallback(async () => {
    try {
      const res = await api.post('/auth/refresh');
      if (res?.data?.token) {
        const { token: newToken, user: newUser } = res.data;
        localStorage.setItem('token', newToken);
        if (newUser) {
          localStorage.setItem('user', JSON.stringify(newUser));
          localStorage.setItem('role', newUser.role);
          // 'role' is the primary role only — keep the full set in sync too.
          if (Array.isArray(newUser.roles) && newUser.roles.length) {
            localStorage.setItem('roles', JSON.stringify(newUser.roles.map(r => String(r).toLowerCase())));
          }
        }
        // Notify AuthContext so its React state also reflects the new token
        window.dispatchEvent(new CustomEvent('pulse:token-refreshed', { detail: res.data }));
      }
    } catch {
      // Refresh failed (revoked, expired beyond grace) — hard logout
      forceLogout();
      return;
    }
    lastActivityRef.current = Date.now();
    setShowWarning(false);
    scheduleTimers();
  }, [scheduleTimers, forceLogout]);

  // Register activity listeners and start initial timers
  React.useEffect(() => {
    if (!isLoggedInRef.current) return;
    scheduleTimers();
    const handler = () => recordActivity();
    ACTIVITY_EVENTS.forEach(ev => window.addEventListener(ev, handler, { passive: true }));
    return () => {
      ACTIVITY_EVENTS.forEach(ev => window.removeEventListener(ev, handler));
      clearTimeout(warnTimerRef.current);
      clearTimeout(logoutTimerRef.current);
      clearInterval(countdownRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-register activity listener when showWarning changes
  React.useEffect(() => {
    if (!isLoggedInRef.current) return;
    const handler = () => recordActivity();
    ACTIVITY_EVENTS.forEach(ev => window.addEventListener(ev, handler, { passive: true }));
    return () => {
      ACTIVITY_EVENTS.forEach(ev => window.removeEventListener(ev, handler));
    };
  }, [recordActivity]);

  return { showWarning, sessionTimeRemaining, extendSession, forceLogout };
}
