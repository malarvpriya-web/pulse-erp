import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Bell, Clock, AlertTriangle, UserCheck, Info, CheckCircle2,
  Check, Trash2, Inbox,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './NotificationCenter.css';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { fmtDate } from '@/utils/dateFormatter';

const DECISION_MAP = { approve: 'Confirm', reject: 'Terminate', extend: 'Extend Probation' };

/* Icon + colour per notification type. Mirrors the topbar bell's NOTIF_CFG so
   the same notification reads identically in the dropdown and here. */
const TYPE_CFG = {
  probation_warning: { Icon: Clock,         color: '#6d28d9', bg: '#f5f3ff', label: 'Probation' },
  probation_due:     { Icon: AlertTriangle, color: '#dc2626', bg: '#fef2f2', label: 'Probation' },
  approval:          { Icon: UserCheck,     color: '#7c3aed', bg: '#f5f3ff', label: 'Approval'  },
  success:           { Icon: CheckCircle2,  color: '#16a34a', bg: '#f0fdf4', label: 'Success'   },
  error:             { Icon: AlertTriangle, color: '#dc2626', bg: '#fef2f2', label: 'Alert'     },
  warning:           { Icon: AlertTriangle, color: '#6d28d9', bg: '#f5f3ff', label: 'Warning'   },
  info:              { Icon: Info,          color: '#0369a1', bg: '#eff6ff', label: 'Info'      },
  default:           { Icon: Bell,          color: '#6b7280', bg: '#f9fafb', label: 'System'    },
};
const typeCfg = (t) => TYPE_CFG[t] || TYPE_CFG.default;

const FILTERS = [
  { key: 'all',    label: 'All'    },
  { key: 'unread', label: 'Unread' },
  { key: 'read',   label: 'Read'   },
];

const DAY = 86400000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };

/* Calendar-day buckets, not rolling 24h — 11pm yesterday belongs under
   "Yesterday", not "Today". */
function dayGroup(ts) {
  const today = startOfDay(new Date());
  const then = startOfDay(ts);
  if (Number.isNaN(then)) return 'Earlier';
  if (then === today) return 'Today';
  if (then === today - DAY) return 'Yesterday';
  if (then > today - 7 * DAY) return 'This week';
  return 'Earlier';
}
const GROUP_ORDER = ['Today', 'Yesterday', 'This week', 'Earlier'];

/* Relative for the last day, then the app-standard DD Mon YY. */
function shortTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return fmtDate(ts);
}

const NotificationCenter = () => {
  const toast = useToast();
  const { user } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [filter, setFilter] = useState('all');
  const [showDecisionForm, setShowDecisionForm] = useState(false);
  const [selectedNotification, setSelectedNotification] = useState(null);
  const [formData, setFormData] = useState({ decision: '', performance_rating: 3, comments: '' });
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);

  const fetchNotifications = useCallback(async (options = {}) => {
    try {
      const url = filter !== 'all' ? `/notifications?is_read=${filter === 'read'}` : '/notifications';
      const res = await api.get(url, options);
      const raw = res.data?.data || res.data;
      setNotifications(Array.isArray(raw) ? raw : []);
    } catch (error) {
      if (error.name === 'CanceledError' || error.name === 'AbortError') return;
      console.error('Error:', error);
    }
  }, [filter]);

  useEffect(() => {
    const controller = new AbortController();
    fetchNotifications({ signal: controller.signal });
    return () => controller.abort();
  }, [fetchNotifications]);

  const markAsRead = async (id) => {
    try {
      await api.put(`/notifications/${id}/read`, {});
      fetchNotifications();
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const markAllAsRead = async () => {
    try {
      await api.put('/notifications/mark-all-read', {});
      fetchNotifications();
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const deleteNotification = async (id) => {
    try {
      await api.delete(`/notifications/${id}`);
      fetchNotifications();
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const confirmDelete = async () => {
    const id = deleteConfirmId;
    setDeleteConfirmId(null);
    await deleteNotification(id);
  };

  const handleProbationAction = (notif, action) => {
    setSelectedNotification({ ...notif, action });
    setFormData({ decision: DECISION_MAP[action] || '', performance_rating: 3, comments: '' });
    setShowDecisionForm(true);
  };

  const handleLeaveAction = async (notif, action) => {
    try {
      await api.put(`/leaves/applications/${notif.reference_id}/status`, { status: action });
      await api.put(`/notifications/${notif.id}/read`, {});
      toast.success(`Leave ${action} successfully`);
      fetchNotifications();
    } catch (error) {
      console.error('Error:', error);
      toast.error(`Failed to ${action} leave`);
    }
  };

  const submitDecisionForm = async () => {
    if (!formData.decision) {
      toast.error('Please select a decision');
      return;
    }
    try {
      await api.put(`/probation/by-employee/${selectedNotification.reference_id}`, {
        decision: formData.decision,
        performance_rating: formData.performance_rating,
        comments: formData.comments,
      });
      await api.put(`/notifications/${selectedNotification.id}/read`, {});
      toast.success(`Probation decision "${formData.decision}" submitted successfully`);
      setShowDecisionForm(false);
      fetchNotifications();
    } catch (error) {
      console.error('Error:', error);
      toast.error('Failed to submit decision');
    }
  };

  const isProbationNotif = (notif) =>
    ['probation_warning', 'probation_due', 'approval'].includes(notif.notification_type) &&
    (notif.module_name || '').toLowerCase() === 'probation';

  const isLeaveNotif = (notif) =>
    notif.notification_type === 'approval' &&
    (notif.module_name || '').toLowerCase() === 'leave';

  const unreadCount = notifications.filter(n => !n.is_read).length;

  const groups = useMemo(() => {
    const buckets = {};
    for (const n of notifications) {
      const g = dayGroup(n.created_at);
      (buckets[g] ||= []).push(n);
    }
    return GROUP_ORDER.filter(g => buckets[g]?.length).map(g => [g, buckets[g]]);
  }, [notifications]);

  return (
    <PageShell
      className="nc-root"
      dock={
        <PageHero
          icon={Bell}
          eyebrow="Inbox"
          title="Notifications"
          subtitle={user?.name ? `Everything addressed to ${user.name}` : 'Approvals, alerts and updates addressed to you'}
          meta={[
            { label: 'total', value: notifications.length },
            { label: 'unread', value: unreadCount, tone: unreadCount > 0 ? 'warn' : 'good' },
          ]}
          actions={
            <div className="nc-filter">
              <div className="plh-group">
                {FILTERS.map(f => (
                  <button
                    key={f.key}
                    type="button"
                    className={`plh-cta${filter === f.key ? ' is-active' : ''}`}
                    onClick={() => setFilter(f.key)}
                    aria-pressed={filter === f.key}
                    title={`Show ${f.label.toLowerCase()} notifications`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {unreadCount > 0 && (
                <button type="button" className="plh-cta" onClick={markAllAsRead}>
                  <Check size={13} /> Mark all read
                </button>
              )}
            </div>
          }
        />
      }
    >
      <ConfirmDialog
        open={deleteConfirmId !== null}
        title="Delete Notification"
        message="Delete this notification? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirmId(null)}
      />

      {notifications.length === 0 ? (
        <div className="nc-empty">
          <span className="nc-empty-ico"><Inbox size={22} strokeWidth={1.6} /></span>
          <span className="nc-empty-t">You&apos;re all caught up</span>
          <span className="nc-empty-s">
            {filter === 'all' ? 'No notifications yet' : `No ${filter} notifications`}
          </span>
        </div>
      ) : (
        groups.map(([group, rows]) => (
          <div className="nc-group" key={group}>
            <div className="nc-group-hd">
              <span className="nc-group-label">{group}</span>
              <span className="nc-group-rule" />
              <span className="nc-group-n">{rows.length}</span>
            </div>

            <div className="nc-list">
              {rows.map(notif => {
                const cfg = typeCfg(notif.notification_type);
                const { Icon } = cfg;
                return (
                  <div
                    key={notif.id}
                    className={`nc-row${notif.is_read ? '' : ' nc-row-unread'}`}
                  >
                    <span className="nc-ico" style={{ background: cfg.bg, color: cfg.color }}>
                      <Icon size={14} />
                    </span>

                    <div className="nc-body">
                      <div className="nc-title-row">
                        <span className="nc-title">{notif.title}</span>
                        {notif.module_name && (
                          <span className="nc-module">{notif.module_name}</span>
                        )}
                        <span className="nc-tag" style={{ background: cfg.bg, color: cfg.color }}>
                          {cfg.label}
                        </span>
                      </div>
                      {notif.message && <p className="nc-msg">{notif.message}</p>}
                    </div>

                    <div className="nc-right">
                      <span className="nc-time">{shortTime(notif.created_at)}</span>
                      <div className="nc-acts">
                        {isProbationNotif(notif) && !notif.is_read && (
                          <>
                            <button className="nc-btn nc-btn-ok" onClick={() => handleProbationAction(notif, 'approve')}>
                              Confirm
                            </button>
                            <button className="nc-btn nc-btn-alt" onClick={() => handleProbationAction(notif, 'extend')}>
                              Extend
                            </button>
                            <button className="nc-btn nc-btn-no" onClick={() => handleProbationAction(notif, 'reject')}>
                              Terminate
                            </button>
                          </>
                        )}
                        {isLeaveNotif(notif) && !notif.is_read && (
                          <>
                            <button className="nc-btn nc-btn-ok" onClick={() => handleLeaveAction(notif, 'approved')}>
                              Approve
                            </button>
                            <button className="nc-btn nc-btn-no" onClick={() => handleLeaveAction(notif, 'rejected')}>
                              Reject
                            </button>
                          </>
                        )}
                        {!notif.is_read && (
                          <button
                            className="nc-icon-btn"
                            onClick={() => markAsRead(notif.id)}
                            title="Mark as read"
                            aria-label="Mark as read"
                          >
                            <Check size={13} />
                          </button>
                        )}
                        <button
                          className="nc-icon-btn nc-danger"
                          onClick={() => setDeleteConfirmId(notif.id)}
                          title="Delete"
                          aria-label="Delete notification"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}

      {showDecisionForm && (
        <div className="nc-mask" onClick={() => setShowDecisionForm(false)}>
          <div className="nc-modal" onClick={e => e.stopPropagation()}>
            <div className="nc-modal-hd">
              <h2>Probation Decision</h2>
              <p>{selectedNotification?.title}</p>
            </div>

            <div className="nc-modal-bd">
              <div className="nc-field">
                <label htmlFor="nc-decision">Decision *</label>
                <select
                  id="nc-decision"
                  value={formData.decision}
                  onChange={(e) => setFormData({ ...formData, decision: e.target.value })}
                >
                  <option value="">Select Decision</option>
                  <option value="Confirm">Confirm</option>
                  <option value="Extend Probation">Extend Probation</option>
                  <option value="Terminate">Terminate</option>
                </select>
              </div>

              <div className="nc-field">
                <label htmlFor="nc-rating">
                  Performance Rating <span className="nc-rating-val">{formData.performance_rating}/5</span>
                </label>
                <input
                  id="nc-rating"
                  type="range" min="1" max="5"
                  value={formData.performance_rating}
                  onChange={(e) => setFormData({ ...formData, performance_rating: parseInt(e.target.value, 10) })}
                />
                <div className="nc-range-scale">
                  <span>1 — Poor</span><span>3 — Average</span><span>5 — Excellent</span>
                </div>
              </div>

              <div className="nc-field">
                <label htmlFor="nc-comments">Comments</label>
                <textarea
                  id="nc-comments"
                  value={formData.comments}
                  onChange={(e) => setFormData({ ...formData, comments: e.target.value })}
                  rows="3"
                  placeholder="Add any remarks or observations…"
                />
              </div>
            </div>

            <div className="nc-modal-ft">
              <button className="nc-cancel" onClick={() => setShowDecisionForm(false)}>Cancel</button>
              <button className="nc-submit" onClick={submitDecisionForm}>Submit Decision</button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
};

export default NotificationCenter;
