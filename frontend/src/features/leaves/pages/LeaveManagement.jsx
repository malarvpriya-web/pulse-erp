import React, { useState, useEffect } from 'react';
import axios from 'axios';
import '../../crm/pages/Leads.css';

const LeaveManagement = () => {
  const [balance, setBalance] = useState([]);
  const [applications, setApplications] = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [showApplyForm, setShowApplyForm] = useState(false);
  const [formData, setFormData] = useState({
    leave_type_id: '',
    start_date: '',
    end_date: '',
    number_of_days: '',
    reason: ''
  });

  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

  useEffect(() => {
    fetchBalance();
    fetchApplications();
    fetchLeaveTypes();
  }, []);

  const fetchBalance = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`http://localhost:5000/api/leaves-new/balance/${currentUser.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setBalance(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchApplications = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`http://localhost:5000/api/leaves-new/applications?employee_id=${currentUser.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setApplications(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchLeaveTypes = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/leaves-new/types', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setLeaveTypes(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleApplyLeave = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      await axios.post('http://localhost:5000/api/leaves-new/apply',
        { 
          ...formData, 
          employee_id: currentUser.id, 
          manager_id: currentUser.manager_id,
          department_head_id: currentUser.department_head_id
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      alert('Leave application submitted successfully');
      setShowApplyForm(false);
      fetchApplications();
      setFormData({
        leave_type_id: '',
        start_date: '',
        end_date: '',
        number_of_days: '',
        reason: ''
      });
    } catch (error) {
      alert('Error submitting leave application');
    }
  };

  const getStatusColor = (status) => {
    const colors = {
      pending: '#fef3c7',
      approved: '#dcfce7',
      rejected: '#fee2e2',
      cancelled: '#f3f4f6'
    };
    return colors[status] || '#f3f4f6';
  };

  return (
    <div className="leads-page">
      <div className="leads-header">
        <h1>Leave Management</h1>
        <button className="primary-btn" onClick={() => setShowApplyForm(true)}>Apply Leave</button>
      </div>

      <div style={{ marginBottom: '25px' }}>
        <h2 style={{ fontSize: '24px', marginBottom: '15px' }}>Leave Balance</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '15px' }}>
          {balance.map(bal => (
            <div key={bal.id} style={{ background: 'white', padding: '20px', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
              <h3 style={{ fontSize: '18px', margin: '0 0 10px 0' }}>{bal.leave_name}</h3>
              <p style={{ fontSize: '16px', color: '#6b7280', margin: '5px 0' }}>
                Allocated: {bal.allocated_days}
              </p>
              <p style={{ fontSize: '16px', color: '#6b7280', margin: '5px 0' }}>
                Used: {bal.used_days}
              </p>
              <p style={{ fontSize: '20px', fontWeight: '700', color: '#0284c7', margin: '10px 0 0 0' }}>
                Remaining: {bal.remaining_days}
              </p>
            </div>
          ))}
        </div>
      </div>

      {showApplyForm && (
        <div className="form-modal">
          <div className="form-card">
            <h2>Apply for Leave</h2>
            <form onSubmit={handleApplyLeave}>
              <div className="form-group">
                <label>Leave Type *</label>
                <select
                  value={formData.leave_type_id}
                  onChange={(e) => setFormData({ ...formData, leave_type_id: e.target.value })}
                  required
                >
                  <option value="">Select Leave Type</option>
                  {leaveTypes.map(type => (
                    <option key={type.id} value={type.id}>{type.leave_name}</option>
                  ))}
                </select>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Start Date *</label>
                  <input
                    type="date"
                    value={formData.start_date}
                    onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>End Date *</label>
                  <input
                    type="date"
                    value={formData.end_date}
                    onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Number of Days *</label>
                <input
                  type="number"
                  step="0.5"
                  value={formData.number_of_days}
                  onChange={(e) => setFormData({ ...formData, number_of_days: e.target.value })}
                  required
                />
              </div>

              <div className="form-group">
                <label>Reason *</label>
                <textarea
                  value={formData.reason}
                  onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                  rows="3"
                  required
                />
              </div>

              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => setShowApplyForm(false)}>Cancel</button>
                <button type="submit" className="submit-btn">Submit Application</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div style={{ marginTop: '30px' }}>
        <h2 style={{ fontSize: '24px', marginBottom: '15px' }}>My Leave Applications</h2>
        <div className="leads-table-container">
          <table className="leads-table">
            <thead>
              <tr>
                <th>Leave Type</th>
                <th>Start Date</th>
                <th>End Date</th>
                <th>Days</th>
                <th>Manager Status</th>
                <th>Dept Head Status</th>
                <th>Final Status</th>
              </tr>
            </thead>
            <tbody>
              {applications.map(app => (
                <tr key={app.id}>
                  <td>{app.leave_name}</td>
                  <td>{new Date(app.start_date).toLocaleDateString()}</td>
                  <td>{new Date(app.end_date).toLocaleDateString()}</td>
                  <td>{app.number_of_days}</td>
                  <td>
                    <span className="badge" style={{ background: getStatusColor(app.manager_status) }}>
                      {app.manager_status || 'pending'}
                    </span>
                  </td>
                  <td>
                    <span className="badge" style={{ background: getStatusColor(app.department_head_status) }}>
                      {app.department_head_status || 'pending'}
                    </span>
                  </td>
                  <td>
                    <span className="badge" style={{ background: getStatusColor(app.status) }}>
                      {app.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default LeaveManagement;
