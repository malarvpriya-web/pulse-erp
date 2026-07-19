import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Bell, Calendar, Clock, Plane, User, X, CheckCircle,
  AlertCircle, IndianRupee, MessageSquare, Megaphone, Check
} from 'lucide-react';
import api from '@/services/api/client';
import './NotificationDropdown.css';

const TYPE_CONFIG = {
  leave_approved:     { Icon: CheckCircle,   color: '#10b981' },
  leave_rejected:     { Icon: AlertCircle,   color: '#ef4444' },
  payroll_processed:  { Icon: IndianRupee,    color: '#10b981' },
  complaint_assigned: { Icon: MessageSquare, color: '#f59e0b' },
  complaint_resolved: { Icon: CheckCircle,   color: '#10b981' },
  timesheet_approved: { Icon: Clock,         color: '#3b82f6' },
  timesheet_reminder: { Icon: Clock,         color: '#f59e0b' },
  announcement:       { Icon: Megaphone,     color: '#6366f1' },
  leave:              { Icon: Calendar,      color: '#6366f1' },
  travel:             { Icon: Plane,         color: '#3b82f6' },
  task:               { Icon: User,          color: '#8b5cf6' },
  approval:           { Icon: CheckCircle,   color: '#10b981' },
  info:               { Icon: Bell,          color: '#6b7280' },
};
const typeConfig = t => TYPE_CONFIG[(t||'').toLowerCase()] || TYPE_CONFIG.info;

function relTime(d) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)    return 'just now';
  if (m < 60)   return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m/60)}h ago`;
  if (m < 2880) return 'yesterday';
  return `${Math.floor(m/1440)}d ago`;
}

function dateGroup(d) {
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 86400000)  return 'Today';
  if (diff < 172800000) return 'Yesterday';
  return 'Earlier';
}

function groupByDate(items) {
  const groups = {};
  for (const item of items) {
    const g = dateGroup(item.created_at);
    if (!groups[g]) groups[g] = [];
    groups[g].push(item);
  }
  return groups;
}

export default function NotificationDropdown({ onViewAll }) {
  const [open,  setOpen]  = useState(false);
  const [items, setItems] = useState([]);
  const ref = useRef(null);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const unread = items.filter(n => !n.is_read).length;

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await api.get('/notifications');
      if (!isMounted.current) return;
      const raw = res.data?.data || res.data;
      // Always update from API — empty array is a valid real state, not a fallback trigger
      if (Array.isArray(raw)) {
        setItems(raw);
      }
    } catch {
      // Network/server error — keep current items, don't overwrite with fake data
    }
  }, []);

  // Fetch on mount and every 60 seconds
  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 60000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  // Close on outside click
  useEffect(() => {
    function handleOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  const markRead = async (id) => {
    setItems(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
    try { await api.put(`/notifications/${id}/read`); } catch { /* optimistic */ }
  };

  const markAllRead = async () => {
    setItems(prev => prev.map(n => ({ ...n, is_read: true })));
    try { await api.put('/notifications/mark-all-read'); } catch { /* optimistic */ }
  };

  const dismiss = async (id, e) => {
    e.stopPropagation();
    setItems(prev => prev.filter(n => n.id !== id));
    try { await api.delete(`/notifications/${id}`); } catch { /* optimistic */ }
  };

  const grouped = groupByDate(items);
  const GROUP_ORDER = ['Today', 'Yesterday', 'Earlier'];

  return (
    <div className="ntfd-wrap" ref={ref}>
      <button className="ntfd-bell" onClick={() => setOpen(o => !o)} title="Notifications">
        <Bell size={20} />
        {unread > 0 && <span className="ntfd-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="ntfd-panel">
          <div className="ntfd-header">
            <span className="ntfd-title">Notifications</span>
            {unread > 0 && (
              <button className="ntfd-mark-all" onClick={markAllRead}>
                <Check size={12} style={{ verticalAlign:'middle', marginRight:3 }} />
                Mark all read
              </button>
            )}
          </div>

          <div className="ntfd-list">
            {items.length === 0 ? (
              <div className="ntfd-empty">All caught up! 🎉</div>
            ) : (
              GROUP_ORDER.filter(g => grouped[g]?.length).map(group => (
                <div key={group}>
                  <div style={{ padding:'6px 14px', fontSize:10, fontWeight:700, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'0.06em', borderBottom:'1px solid #f9fafb' }}>
                    {group}
                  </div>
                  {grouped[group].map(n => {
                    const { Icon, color } = typeConfig(n.notification_type);
                    return (
                      <div key={n.id}
                        className={`ntfd-item ${n.is_read ? '' : 'ntfd-item-unread'}`}
                        onClick={() => markRead(n.id)}
                        style={{ cursor: 'pointer' }}>
                        <div className="ntfd-icon" style={{ background: color + '20', color, flexShrink:0 }}>
                          <Icon size={15} />
                        </div>
                        <div className="ntfd-content" style={{ minWidth:0 }}>
                          <div className="ntfd-msg" style={{ fontWeight: n.is_read ? 500 : 700, display:'flex', alignItems:'flex-start', gap:6 }}>
                            {!n.is_read && (
                              <span style={{ width:6, height:6, borderRadius:'50%', background:'#6366f1', marginTop:5, flexShrink:0 }} />
                            )}
                            <span style={{ overflow:'hidden', textOverflow:'ellipsis' }}>{n.title || n.message}</span>
                          </div>
                          {n.title && n.message && (
                            <div style={{ fontSize:11, color:'#6b7280', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {n.message.length > 80 ? n.message.slice(0, 80) + '…' : n.message}
                            </div>
                          )}
                          <div className="ntfd-time">{relTime(n.created_at)}</div>
                        </div>
                        <button className="ntfd-dismiss" onClick={e => dismiss(n.id, e)} title="Dismiss">
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="ntfd-footer">
            <button className="ntfd-view-all" onClick={() => { setOpen(false); onViewAll?.(); }}>
              View All Notifications
            </button>
          </div>
        </div>
      )}
    </div>
  );
}