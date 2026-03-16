import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './NotificationCenter.css';

const NotificationCenter = () => {
  const [notifications, setNotifications] = useState([]);
  const [filter, setFilter] = useState('all');
  const [showDecisionForm, setShowDecisionForm] = useState(false);
  const [selectedNotification, setSelectedNotification] = useState(null);
  const [formData, setFormData] = useState({
    employeeName: '',
    managerName: '',
    email: '',
    jobPerformance: '',
    workQuality: '',
    productivity: '',
    attendance: '',
    teamwork: '',
    adaptability: '',
    compliance: '',
    notes: ''
  });

  useEffect(() => {
    fetchNotifications();
  }, [filter]);

  const fetchNotifications = async () => {
    try {
      const token = localStorage.getItem('token');
      let url = 'http://localhost:5000/api/notifications';
      if (filter !== 'all') {
        url += `?is_read=${filter === 'read'}`;
      }
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setNotifications(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const markAsRead = async (id) => {
    try {
      const token = localStorage.getItem('token');
      await axios.put(`http://localhost:5000/api/notifications/${id}/read`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchNotifications();
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleProbationAction = async (notif, action) => {
    setSelectedNotification({ ...notif, action });
    setFormData({
      employeeName: '',
      managerName: localStorage.getItem('userName') || '',
      email: '',
      jobPerformance: '',
      workQuality: '',
      productivity: '',
      attendance: '',
      teamwork: '',
      adaptability: '',
      compliance: '',
      notes: ''
    });
    setShowDecisionForm(true);
  };

  const handleLeaveAction = async (notif, action) => {
    try {
      const token = localStorage.getItem('token');
      await axios.post(`http://localhost:5000/api/leaves-new/approve`, {
        application_id: notif.reference_id,
        action,
        approver_role: notif.approver_role
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      alert(`Leave ${action} successfully`);
      fetchNotifications();
    } catch (error) {
      console.error('Error:', error);
      alert(`Failed to ${action} leave`);
    }
  };

  const submitDecisionForm = async () => {
    try {
      const token = localStorage.getItem('token');
      await axios.post(`http://localhost:5000/api/probation/decision`, {
        notification_id: selectedNotification.id,
        action: selectedNotification.action,
        ...formData,
        timestamp: new Date().toISOString()
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      alert(`Probation ${selectedNotification.action} submitted successfully`);
      setShowDecisionForm(false);
      fetchNotifications();
    } catch (error) {
      console.error('Error:', error);
      alert(`Failed to submit decision`);
    }
  };

  const markAllAsRead = async () => {
    try {
      const token = localStorage.getItem('token');
      await axios.put('http://localhost:5000/api/notifications/mark-all-read', {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchNotifications();
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const deleteNotification = async (id) => {
    try {
      const token = localStorage.getItem('token');
      await axios.delete(`http://localhost:5000/api/notifications/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchNotifications();
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const getTypeColor = (type) => {
    const colors = {
      info: '#dbeafe',
      success: '#dcfce7',
      warning: '#fef3c7',
      error: '#fee2e2',
      approval: '#e0e7ff'
    };
    return colors[type] || '#f3f4f6';
  };

  return (
    <div className="notifications-page">
      <div className="notifications-header">
        <h1>Notifications</h1>
        <div className="header-actions">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="filter-select">
            <option value="all">All</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
          <button className="primary-btn" onClick={markAllAsRead}>Mark All as Read</button>
          <button className="primary-btn" onClick={() => {
            setSelectedNotification({ id: 1, action: 'approve' });
            setShowDecisionForm(true);
          }}>Test Form</button>
        </div>
      </div>

      <div className="notifications-list">
        {notifications.map(notif => (
          <div key={notif.id} className={`notification-card ${notif.is_read ? 'read' : 'unread'}`}>
            <div className="notification-header">
              <span className="notification-type" style={{ background: getTypeColor(notif.notification_type) }}>
                {notif.notification_type}
              </span>
              <span className="notification-time">
                {new Date(notif.created_at).toLocaleString()}
              </span>
            </div>
            <h3>{notif.title}</h3>
            <p>{notif.message}</p>
            {notif.module_name && (
              <span className="notification-module">Module: {notif.module_name}</span>
            )}
            <div className="notification-actions">
              {notif.notification_type === 'approval' && notif.module_name === 'Probation' && !notif.is_read && (
                <>
                  <button className="action-btn" style={{ background: '#dcfce7', color: '#166534' }} onClick={() => handleProbationAction(notif, 'approve')}>
                    ✅ Approve
                  </button>
                  <button className="action-btn" style={{ background: '#fee2e2', color: '#991b1b' }} onClick={() => handleProbationAction(notif, 'reject')}>
                    ❌ Reject
                  </button>
                  <button className="action-btn" style={{ background: '#fef3c7', color: '#92400e' }} onClick={() => handleProbationAction(notif, 'extend')}>
                    ⏱️ Extend
                  </button>
                </>
              )}
              {notif.notification_type === 'approval' && notif.module_name === 'Leave' && !notif.is_read && (
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
              <button className="action-btn delete" onClick={() => deleteNotification(notif.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}

        {notifications.length === 0 && (
          <div className="empty-state">
            <p>No notifications</p>
          </div>
        )}
      </div>

      {showDecisionForm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 9999, overflow: 'auto', padding: '20px'
        }}>
          <div style={{
            background: 'white', padding: '30px', borderRadius: '12px',
            width: '700px', maxWidth: '95%', maxHeight: '90vh', overflow: 'auto'
          }}>
            <h2 style={{ marginBottom: '20px', fontSize: '24px', textAlign: 'center' }}>
              Probation Decision - {selectedNotification?.action?.toUpperCase()}
            </h2>
            
            <div style={{ display: 'grid', gap: '15px' }}>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>Employee Name *</label>
                <input style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px' }}
                  value={formData.employeeName} onChange={(e) => setFormData({ ...formData, employeeName: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>Reporting Manager *</label>
                <input style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px' }}
                  value={formData.managerName} onChange={(e) => setFormData({ ...formData, managerName: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>Email *</label>
                <input type="email" style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px' }}
                  value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>1. Job Performance & Achievements</label>
                <textarea style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px', minHeight: '60px' }}
                  value={formData.jobPerformance} onChange={(e) => setFormData({ ...formData, jobPerformance: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>2. Work Quality</label>
                <textarea style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px', minHeight: '60px' }}
                  value={formData.workQuality} onChange={(e) => setFormData({ ...formData, workQuality: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>3. Productivity & Deadlines</label>
                <textarea style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px', minHeight: '60px' }}
                  value={formData.productivity} onChange={(e) => setFormData({ ...formData, productivity: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>4. Attendance & Punctuality</label>
                <textarea style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px', minHeight: '60px' }}
                  value={formData.attendance} onChange={(e) => setFormData({ ...formData, attendance: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>5. Teamwork & Collaboration</label>
                <textarea style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px', minHeight: '60px' }}
                  value={formData.teamwork} onChange={(e) => setFormData({ ...formData, teamwork: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>6. Adaptability & Learning</label>
                <textarea style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px', minHeight: '60px' }}
                  value={formData.adaptability} onChange={(e) => setFormData({ ...formData, adaptability: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>7. Compliance</label>
                <textarea style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px', minHeight: '60px' }}
                  value={formData.compliance} onChange={(e) => setFormData({ ...formData, compliance: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '16px', fontWeight: '600', display: 'block', marginBottom: '5px' }}>Notes</label>
                <textarea style={{ width: '100%', padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '16px', minHeight: '80px' }}
                  value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
              <button onClick={submitDecisionForm} style={{
                flex: 1, padding: '12px', background: '#0284c7', color: 'white',
                border: 'none', borderRadius: '8px', fontSize: '18px', fontWeight: '600', cursor: 'pointer'
              }}>Submit</button>
              <button onClick={() => setShowDecisionForm(false)} style={{
                flex: 1, padding: '12px', background: '#e5e7eb', color: '#374151',
                border: 'none', borderRadius: '8px', fontSize: '18px', fontWeight: '600', cursor: 'pointer'
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationCenter;
