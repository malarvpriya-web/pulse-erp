import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';

// Single shared polling interval (ms)
const POLL_INTERVAL = 30000;

/**
 * useNotifications — single source of truth for notification data.
 *
 * Both Topbar and NotificationDropdown should use this hook.
 * It polls /notifications and /notifications/unread-count every 30s.
 * Empty array from the API is treated as a valid empty state (not a fallback trigger).
 */
export function useNotifications() {
  const [notifs,      setNotifs]      = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading,     setLoading]     = useState(false);
  const intervalRef = useRef(null);

  const fetchNotifs = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      const [nRes, cRes] = await Promise.all([
        api.get('/notifications', { params: { limit: 20 } }),
        api.get('/notifications/unread-count'),
      ]);
      const raw = nRes.data?.data || nRes.data;
      // Always set from API — empty array is a real state
      if (Array.isArray(raw)) setNotifs(raw);
      setUnreadCount(cRes.data?.count ?? 0);
    } catch {
      // Silently fail — don't clear existing items on network hiccup
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    fetchNotifs(true);
    intervalRef.current = setInterval(fetchNotifs, POLL_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [fetchNotifs]);

  const markRead = useCallback(async (id) => {
    // Optimistic update
    setNotifs(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await api.put(`/notifications/${id}/read`);
    } catch {
      // Revert optimistic update on failure
      setNotifs(prev => prev.map(n => n.id === id ? { ...n, is_read: false } : n));
      setUnreadCount(prev => prev + 1);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    // Optimistic update
    setNotifs(prev => prev.map(n => ({ ...n, is_read: true })));
    setUnreadCount(0);
    try {
      await api.put('/notifications/mark-all-read');
    } catch {
      // Refresh to get real state
      fetchNotifs();
    }
  }, [fetchNotifs]);

  const deleteNotif = useCallback(async (id) => {
    const wasUnread = notifs.find(n => n.id === id)?.is_read === false;
    // Optimistic update
    setNotifs(prev => prev.filter(n => n.id !== id));
    if (wasUnread) setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await api.delete(`/notifications/${id}`);
    } catch {
      // Refresh to get real state on failure
      fetchNotifs();
    }
  }, [notifs, fetchNotifs]);

  return {
    notifs,
    unreadCount,
    loading,
    refresh: () => fetchNotifs(true),
    markRead,
    markAllRead,
    deleteNotif,
  };
}