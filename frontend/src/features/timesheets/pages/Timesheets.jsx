import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './Timesheets.css';

const Timesheets = () => {
  const [timesheets, setTimesheets] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [formData, setFormData] = useState({
    project_id: '',
    task_id: '',
    work_date: new Date().toISOString().split('T')[0],
    hours_worked: '',
    description: '',
    is_billable: true,
    status: 'draft'
  });

  const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

  useEffect(() => {
    fetchTimesheets();
    fetchProjects();
  }, []);

  const fetchTimesheets = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`http://localhost:5000/api/timesheets/timesheets?employee_id=${currentUser.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setTimesheets(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchProjects = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/projects/projects?status=active', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setProjects(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchTasks = async (projectId) => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`http://localhost:5000/api/projects/tasks?project_id=${projectId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setTasks(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleProjectChange = (projectId) => {
    setFormData({ ...formData, project_id: projectId, task_id: '' });
    if (projectId) {
      fetchTasks(projectId);
    } else {
      setTasks([]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      await axios.post('http://localhost:5000/api/timesheets/timesheets',
        { ...formData, employee_id: currentUser.id },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      alert('Timesheet entry created');
      setShowForm(false);
      fetchTimesheets();
      setFormData({
        project_id: '',
        task_id: '',
        work_date: new Date().toISOString().split('T')[0],
        hours_worked: '',
        description: '',
        is_billable: true,
        status: 'draft'
      });
    } catch (error) {
      alert('Error creating timesheet entry');
    }
  };

  const submitWeek = async () => {
    const today = new Date();
    const weekStart = new Date(today.setDate(today.getDate() - today.getDay()));
    const weekEnd = new Date(today.setDate(today.getDate() - today.getDay() + 6));

    try {
      const token = localStorage.getItem('token');
      await axios.post('http://localhost:5000/api/timesheets/timesheets/submit-week',
        {
          employee_id: currentUser.id,
          week_start: weekStart.toISOString().split('T')[0],
          week_end: weekEnd.toISOString().split('T')[0]
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      alert('Week submitted for approval');
      fetchTimesheets();
    } catch (error) {
      alert('Error submitting week');
    }
  };

  const getStatusColor = (status) => {
    const colors = {
      draft: '#f3f4f6',
      submitted: '#fef3c7',
      approved: '#dcfce7',
      rejected: '#fee2e2'
    };
    return colors[status] || '#f3f4f6';
  };

  const getTotalHours = () => {
    return timesheets.reduce((sum, t) => sum + parseFloat(t.hours_worked || 0), 0).toFixed(2);
  };

  return (
    <div className="timesheets-page">
      <div className="timesheets-header">
        <h1>My Timesheets</h1>
        <div className="header-actions">
          <span className="total-hours">Total Hours: {getTotalHours()}</span>
          <button className="submit-week-btn" onClick={submitWeek}>Submit Week</button>
          <button className="primary-btn" onClick={() => setShowForm(true)}>+ Add Entry</button>
        </div>
      </div>

      {showForm && (
        <div className="form-modal">
          <div className="form-card">
            <h2>Add Timesheet Entry</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>Work Date *</label>
                  <input
                    type="date"
                    value={formData.work_date}
                    onChange={(e) => setFormData({ ...formData, work_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Hours Worked *</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    max="24"
                    value={formData.hours_worked}
                    onChange={(e) => setFormData({ ...formData, hours_worked: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Project *</label>
                  <select
                    value={formData.project_id}
                    onChange={(e) => handleProjectChange(e.target.value)}
                    required
                  >
                    <option value="">Select Project</option>
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.project_name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Task</label>
                  <select
                    value={formData.task_id}
                    onChange={(e) => setFormData({ ...formData, task_id: e.target.value })}
                  >
                    <option value="">Select Task</option>
                    {tasks.map(t => (
                      <option key={t.id} value={t.id}>{t.task_title}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows="3"
                />
              </div>

              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formData.is_billable}
                    onChange={(e) => setFormData({ ...formData, is_billable: e.target.checked })}
                  />
                  Billable
                </label>
              </div>

              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="submit-btn">Add Entry</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="timesheets-table-container">
        <table className="timesheets-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Project</th>
              <th>Task</th>
              <th>Hours</th>
              <th>Billable</th>
              <th>Description</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {timesheets.map(ts => (
              <tr key={ts.id}>
                <td>{new Date(ts.work_date).toLocaleDateString()}</td>
                <td>{ts.project_name}</td>
                <td>{ts.task_title || '-'}</td>
                <td>{ts.hours_worked}h</td>
                <td>{ts.is_billable ? '✓' : '✗'}</td>
                <td>{ts.description || '-'}</td>
                <td>
                  <span className="status-badge" style={{ background: getStatusColor(ts.status) }}>
                    {ts.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Timesheets;
