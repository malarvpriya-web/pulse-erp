import React, { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './Timesheets.css';
import { useToast } from '@/context/ToastContext';
import { Clock } from 'lucide-react';

// Role CODES, as stored in roles.code — snake_case, never display names. The
// last three used to read 'HR Manager' / 'Finance Manager' / 'Project Manager',
// which match no code and so never granted anything: a finance_manager or
// project_manager silently got the self-service view. Role matching lowercases
// but does NOT map spaces to underscores.
const PRIVILEGED_ROLES = ['admin', 'super_admin', 'manager', 'hr', 'hr_manager',
                          'finance_manager', 'project_manager'];

const isoDate = d => d.toISOString().split('T')[0];

const getWeekBounds = () => {
  const today = new Date();
  const dow = today.getDay();
  const mon = new Date(today);
  mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { weekStart: isoDate(mon), weekEnd: isoDate(sun) };
};

const statusColor = status => ({
  draft:     '#f3f4f6',
  submitted: '#fef3c7',
  approved:  '#dcfce7',
  rejected:  '#fee2e2',
}[status] || '#f3f4f6');

const Timesheets = () => {
  const toast    = useToast();
  const { user, hasAnyRole } = useAuth();
  const [timesheets, setTimesheets] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [showForm,   setShowForm]   = useState(false);
  const [projects,   setProjects]   = useState([]);
  const [tasks,      setTasks]      = useState([]);
  const [formData,   setFormData]   = useState({
    project_id: '', task_id: '',
    work_date: isoDate(new Date()),
    hours_worked: '', description: '',
    is_billable: true, status: 'draft',
  });

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set. This flag decides whether the list is scoped to your own timesheets, so
  // gating on it alone self-scoped a secondary-role manager. See AuthContext.
  const isPrivileged = hasAnyRole(...PRIVILEGED_ROLES);

  const fetchTimesheets = async () => {
    setLoading(true);
    try {
      const params = {};
      if (!isPrivileged && user?.employee_id) {
        params.employee_id = user.employee_id;
      }
      const res = await api.get('/timesheets/all', { params });
      if (!isMounted.current) return;
      const data = Array.isArray(res.data) ? res.data
                 : Array.isArray(res.data?.data) ? res.data.data
                 : [];
      setTimesheets(data);
    } catch {
      if (isMounted.current) setTimesheets([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  const fetchProjects = async () => {
    try {
      const res = await api.get('/projects/projects', { params: { status: 'active' } });
      if (!isMounted.current) return;
      const raw = res.data?.projects ?? res.data;
      setProjects(Array.isArray(raw) ? raw : []);
    } catch {
      if (isMounted.current) setProjects([]);
    }
  };

  useEffect(() => {
    fetchTimesheets();
    fetchProjects();
  }, []);

  const fetchTasks = async projectId => {
    if (!projectId) return setTasks([]);
    try {
      const res = await api.get('/projects/tasks', { params: { project_id: projectId } });
      if (!isMounted.current) return;
      const raw = res.data?.tasks ?? res.data;
      setTasks(Array.isArray(raw) ? raw : []);
    } catch {
      if (isMounted.current) setTasks([]);
    }
  };

  const handleProjectChange = projectId => {
    setFormData(f => ({ ...f, project_id: projectId, task_id: '' }));
    fetchTasks(projectId);
  };

  const resetForm = () => setFormData({
    project_id: '', task_id: '',
    work_date: isoDate(new Date()),
    hours_worked: '', description: '',
    is_billable: true, status: 'draft',
  });

  const handleSubmit = async e => {
    e.preventDefault();
    try {
      await api.post('/timesheets/timesheets', {
        ...formData,
        employee_id: user?.employee_id,
        hours_worked: parseFloat(formData.hours_worked),
      });
      if (!isMounted.current) return;
      toast.success('Timesheet entry created');
      setShowForm(false);
      resetForm();
      fetchTimesheets();
    } catch {
      if (isMounted.current) toast.error('Error creating timesheet entry');
    }
  };

  const submitWeek = async () => {
    const { weekStart, weekEnd } = getWeekBounds();
    try {
      await api.post('/timesheets/timesheets/submit-week', {
        employee_id: user?.employee_id,
        week_start: weekStart,
        week_end: weekEnd,
      });
      if (!isMounted.current) return;
      toast.success('Week submitted for approval');
      fetchTimesheets();
    } catch {
      if (isMounted.current) toast.error('Error submitting week');
    }
  };

  const getTotalHours = () =>
    timesheets.reduce((sum, t) => sum + parseFloat(t?.hours_worked ?? 0), 0).toFixed(1);

  const colSpan = isPrivileged ? 8 : 7;

  return (
    <div className="timesheets-page">
      <div className="timesheets-header">
        <h1>All Timesheets</h1>
        <div className="header-actions">
          <span className="total-hours">Total Hours: {getTotalHours()}h</span>
          {!isPrivileged && (
            <button className="submit-week-btn" onClick={submitWeek}>Submit Week</button>
          )}
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
                  <input type="date" value={formData.work_date}
                    onChange={e => setFormData(f => ({ ...f, work_date: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>Hours Worked *</label>
                  <input type="number" step="0.5" min="0" max="24" value={formData.hours_worked}
                    onChange={e => setFormData(f => ({ ...f, hours_worked: e.target.value }))} required />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Project *</label>
                  <select value={formData.project_id}
                    onChange={e => handleProjectChange(e.target.value)} required>
                    <option value="">Select Project</option>
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.project_name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Task</label>
                  <select value={formData.task_id}
                    onChange={e => setFormData(f => ({ ...f, task_id: e.target.value }))}>
                    <option value="">Select Task</option>
                    {tasks.map(t => (
                      <option key={t.id} value={t.id}>{t.task_title ?? t.title}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea value={formData.description} rows="3"
                  onChange={e => setFormData(f => ({ ...f, description: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="checkbox-label">
                  <input type="checkbox" checked={formData.is_billable}
                    onChange={e => setFormData(f => ({ ...f, is_billable: e.target.checked }))} />
                  Billable
                </label>
              </div>
              <div className="form-actions">
                <button type="button" className="cancel-btn"
                  onClick={() => { setShowForm(false); resetForm(); }}>Cancel</button>
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
              {isPrivileged && <th>Employee</th>}
              <th>Project</th>
              <th>Task</th>
              <th>Hours</th>
              <th>Billable</th>
              <th>Description</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={colSpan} style={{ textAlign: 'center', padding: '3rem', color: '#9ca3af' }}>
                  Loading…
                </td>
              </tr>
            ) : timesheets.length === 0 ? (
              <tr>
                <td colSpan={colSpan}
                  style={{ textAlign: 'center', padding: '3rem', color: 'var(--color-text-tertiary, #9ca3af)' }}>
                  <Clock size={32} style={{ opacity: 0.4, marginBottom: '0.5rem', display: 'block', margin: '0 auto 0.5rem' }} />
                  <p style={{ margin: 0 }}>No timesheet entries found for this period</p>
                </td>
              </tr>
            ) : timesheets.map(ts => (
              <tr key={ts.id}>
                <td>{ts.work_date ? new Date(ts.work_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                {isPrivileged && <td>{ts.employee_name ?? '—'}</td>}
                <td>{ts.project_name ?? '—'}</td>
                <td>{ts.task_title ?? '—'}</td>
                <td>{parseFloat(ts.hours_worked ?? 0).toFixed(1)}h</td>
                <td>{ts.is_billable ? '✓' : '✗'}</td>
                <td>{ts.description ?? '—'}</td>
                <td>
                  <span className="status-badge" style={{ background: statusColor(ts.status) }}>
                    {ts.status ?? 'draft'}
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
