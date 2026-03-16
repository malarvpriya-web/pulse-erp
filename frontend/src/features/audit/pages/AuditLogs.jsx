import React, { useState, useEffect } from 'react';
import axios from 'axios';
import '../../crm/pages/Leads.css';

const AuditLogs = () => {
  const [logs, setLogs] = useState([]);
  const [filters, setFilters] = useState({
    module_name: '',
    action_type: '',
    start_date: '',
    end_date: ''
  });

  useEffect(() => {
    fetchLogs();
  }, []);

  const fetchLogs = async () => {
    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams();
      Object.keys(filters).forEach(key => {
        if (filters[key]) params.append(key, filters[key]);
      });
      
      let url = 'http://localhost:5000/api/audit';
      if (params.toString()) url += `?${params.toString()}`;
      
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setLogs(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const getActionColor = (action) => {
    const colors = {
      create: '#dcfce7',
      update: '#dbeafe',
      delete: '#fee2e2',
      approve: '#d1fae5',
      reject: '#fed7aa',
      login: '#f3f4f6',
      logout: '#f3f4f6',
      export: '#fef3c7'
    };
    return colors[action] || '#f3f4f6';
  };

  return (
    <div className="leads-page">
      <div className="leads-header">
        <h1>Audit Logs</h1>
      </div>

      <div style={{ background: 'white', padding: '20px', borderRadius: '12px', marginBottom: '20px' }}>
        <div className="form-row">
          <div className="form-group">
            <label>Module</label>
            <select
              value={filters.module_name}
              onChange={(e) => setFilters({ ...filters, module_name: e.target.value })}
            >
              <option value="">All Modules</option>
              <option value="employees">Employees</option>
              <option value="finance">Finance</option>
              <option value="crm">CRM</option>
              <option value="sales">Sales</option>
              <option value="projects">Projects</option>
            </select>
          </div>

          <div className="form-group">
            <label>Action Type</label>
            <select
              value={filters.action_type}
              onChange={(e) => setFilters({ ...filters, action_type: e.target.value })}
            >
              <option value="">All Actions</option>
              <option value="create">Create</option>
              <option value="update">Update</option>
              <option value="delete">Delete</option>
              <option value="approve">Approve</option>
              <option value="login">Login</option>
            </select>
          </div>

          <div className="form-group">
            <label>Start Date</label>
            <input
              type="date"
              value={filters.start_date}
              onChange={(e) => setFilters({ ...filters, start_date: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label>End Date</label>
            <input
              type="date"
              value={filters.end_date}
              onChange={(e) => setFilters({ ...filters, end_date: e.target.value })}
            />
          </div>

          <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="primary-btn" onClick={fetchLogs}>Search</button>
          </div>
        </div>
      </div>

      <div className="leads-table-container">
        <table className="leads-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>User</th>
              <th>Module</th>
              <th>Action</th>
              <th>Reference Type</th>
              <th>IP Address</th>
            </tr>
          </thead>
          <tbody>
            {logs.map(log => (
              <tr key={log.id}>
                <td>{new Date(log.created_at).toLocaleString()}</td>
                <td>{log.user_name || 'System'}</td>
                <td>{log.module_name}</td>
                <td>
                  <span className="badge" style={{ background: getActionColor(log.action_type) }}>
                    {log.action_type}
                  </span>
                </td>
                <td>{log.reference_type || '-'}</td>
                <td>{log.ip_address || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AuditLogs;
