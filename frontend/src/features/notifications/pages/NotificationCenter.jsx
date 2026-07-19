import React, { useState, useEffect, useCallback } from 'react';
import { Bell } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './NotificationCenter.css';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const DECISION_MAP = { approve: 'Confirm', reject: 'Terminate', extend: 'Extend Probation' };

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

  const getTypeColor = (type) => {
    const colors = {
      info: '#dbeafe', success: '#dcfce7', warning: '#fef3c7',
      error: '#fee2e2', approval: '#e0e7ff',
      probation_warning: '#fef3c7', probation_due: '#fee2e2',
    };
    return colors[type] || '#f3f4f6';
  };

  const unreadCount = notifications.filter(n => !n.is_read).length;

  return (
    <div className="notifications-page">
      <ConfirmDialog
        open={deleteConfirmId !== null}
        title="Delete Notification"
        message="Delete this notification? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirmId(null)}
      />
      <div className="notifications-header">
        <div>
          <h1>Notifications</h1>
          {unreadCount > 0 && (
            <span style={{ fontSize: 14, color: '#6b7280', marginTop: 4, display: 'block' }}>
              {unreadCount} unread
            </span>
          )}
        </div>
        <div className="header-actions">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="filter-select">
            <option value="all">All</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
          {unreadCount > 0 && (
            <button className="primary-btn" onClick={markAllAsRead}>Mark All as Read</button>
          )}
        </div>
      </div>

      <div className="notifications-list">
        {notifications.length === 0 ? (
          <div className="empty-state">
            <Bell size={48} strokeWidth={1.5} style={{ color: 'var(--color-text-tertiary)' }} />
            <p>You're all caught up — no notifications</p>
          </div>
        ) : (
          notifications.map(notif => (
            <div key={notif.id} className={`notification-card ${notif.is_read ? 'read' : 'unread'}`}>
              <div className="notification-header">
                <span className="notification-type" style={{ background: getTypeColor(notif.notification_type) }}>
                  {notif.notification_type?.replace(/_/g, ' ')}
                </span>
                <span className="notification-time">
                  {new Date(notif.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <h3>{notif.title}</h3>
              <p>{notif.message}</p>
              {notif.module_name && (
                <span className="notification-module">Module: {notif.module_name}</span>
              )}
              <div className="notification-actions">
                {isProbationNotif(notif) && !notif.is_read && (
                  <>
                    <button className="action-btn" style={{ background: '#dcfce7', color: '#166534' }} onClick={() => handleProbationAction(notif, 'approve')}>
                      ✅ Confirm
                    </button>
                    <button className="action-btn" style={{ background: '#fef3c7', color: '#92400e' }} onClick={() => handleProbationAction(notif, 'extend')}>
                      ⏱️ Extend
                    </button>
                    <button className="action-btn" style={{ background: '#fee2e2', color: '#991b1b' }} onClick={() => handleProbationAction(notif, 'reject')}>
                      ❌ Terminate
                    </button>
                  </>
                )}
                {isLeaveNotif(notif) && !notif.is_read && (
                  <>
                    <button className="action-btn" style={{ background: '#dcfce7', color: '#166534' }} onClick={() => handleLeaveAction(notif, 'approved')}>
                      ✅ Approve
                    </button>
                    <button className="action-btn" style={{ background: '#fee2e2', color: '#991b1b' }} onClick={() => handleLeaveAction(notif, 'rejected')}>
                      ❌ Reject
                    </button>
                  </>
                )}
                {!notif.is_read && (
                  <button className="action-btn" onClick={() => markAsRead(notif.id)}>
                    Mark as Read
                  </button>
                )}
                <button className="action-btn delete" onClick={() => setDeleteConfirmId(notif.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {showDecisionForm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 9999, padding: '20px',
        }}>
          <div style={{
            background: 'white', padding: '30px', borderRadius: '12px',
            width: '500px', maxWidth: '95%',
          }}>
            <h2 style={{ marginBottom: '20px', fontSize: '22px', textAlign: 'center' }}>
              Probation Decision
            </h2>
            <p style={{ marginBottom: '20px', color: '#6b7280', fontSize: 15, textAlign: 'center' }}>
              {selectedNotification?.title}
            </p>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '6px' }}>Decision *</label>
              <select
                value={formData.decision}
                onChange={(e) => setFormData({ ...formData, decision: e.target.value })}
                style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px' }}
              >
                <option value="">Select Decision</option>
                <option value="Confirm">Confirm</option>
                <option value="Extend Probation">Extend Probation</option>
                <option value="Terminate">Terminate</option>
              </select>
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '6px' }}>
                Performance Rating: {formData.performance_rating}/5
              </label>
              <input
                type="range" min="1" max="5"
                value={formData.performance_rating}
                onChange={(e) => setFormData({ ...formData, performance_rating: parseInt(e.target.value) })}
                style={{ width: '100%' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                <span>1 — Poor</span><span>3 — Average</span><span>5 — Excellent</span>
              </div>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '6px' }}>Comments</label>
              <textarea
                value={formData.comments}
                onChange={(e) => setFormData({ ...formData, comments: e.target.value })}
                rows="4"
                placeholder="Add any remarks or observations..."
                style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '15px', resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={submitDecisionForm} style={{
                flex: 1, padding: '12px', background: '#0284c7', color: 'white',
                border: 'none', borderRadius: '8px', fontSize: '16px', fontWeight: '600', cursor: 'pointer',
              }}>Submit Decision</button>
              <button onClick={() => setShowDecisionForm(false)} style={{
                flex: 1, padding: '12px', background: '#e5e7eb', color: '#374151',
                border: 'none', borderRadius: '8px', fontSize: '16px', fontWeight: '600', cursor: 'pointer',
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationCenter;
