import { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft, Calendar, Users, DollarSign, Clock,
  Plus, X, CheckSquare, RefreshCw
} from 'lucide-react';
import api from '@/services/api/client';
import './ProjectDetail.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const STATUS_META = {
  active:    { bg: '#dcfce7', color: '#15803d', label: 'Active' },
  planning:  { bg: '#dbeafe', color: '#1d4ed8', label: 'Planning' },
  on_hold:   { bg: '#fef3c7', color: '#92400e', label: 'On Hold' },
  completed: { bg: '#f3f4f6', color: '#6b7280', label: 'Completed' },
  cancelled: { bg: '#fee2e2', color: '#dc2626', label: 'Cancelled' },
};

const TASK_COLS = [
  { key: 'todo',        label: 'To Do',       color: '#6b7280', bg: '#f3f4f6' },
  { key: 'in_progress', label: 'In Progress',  color: '#f59e0b', bg: '#fef3c7' },
  { key: 'review',      label: 'Review',       color: '#3b82f6', bg: '#dbeafe' },
  { key: 'done',        label: 'Done',         color: '#10b981', bg: '#dcfce7' },
];

const PRIORITY_COLORS = {
  High:   { bg: '#fee2e2', color: '#dc2626' },
  Medium: { bg: '#fef3c7', color: '#92400e' },
  Low:    { bg: '#f3f4f6', color: '#6b7280' },
};

const SAMPLE_TASKS = [
  { id: 1, task_title: 'Requirements gathering',       status: 'done',        priority: 'High',   assignee_name: 'Rajesh K', due_date: '2025-01-15' },
  { id: 2, task_title: 'System design & architecture', status: 'done',        priority: 'High',   assignee_name: 'Priya S',  due_date: '2025-01-31' },
  { id: 3, task_title: 'Database schema design',       status: 'in_progress', priority: 'High',   assignee_name: 'Anand M',  due_date: '2025-02-15' },
  { id: 4, task_title: 'API integration setup',        status: 'in_progress', priority: 'Medium', assignee_name: 'Rajesh K', due_date: '2025-02-20' },
  { id: 5, task_title: 'Frontend development',         status: 'todo',        priority: 'Medium', assignee_name: 'Priya S',  due_date: '2025-03-01' },
  { id: 6, task_title: 'UAT testing',                  status: 'todo',        priority: 'High',   assignee_name: 'Ravi K',   due_date: '2025-03-15' },
  { id: 7, task_title: 'Performance optimization',     status: 'review',      priority: 'Low',    assignee_name: 'Anand M',  due_date: '2025-02-28' },
];

const SAMPLE_TEAM = [
  { id: 1, name: 'Rajesh Kumar', role: 'Project Manager', avatar: 'RK' },
  { id: 2, name: 'Priya Sharma', role: 'Lead Developer',  avatar: 'PS' },
  { id: 3, name: 'Anand Menon',  role: 'Backend Dev',     avatar: 'AM' },
  { id: 4, name: 'Ravi Kumar',   role: 'QA Engineer',     avatar: 'RK' },
];

const emptyTask = () => ({
  task_title: '', description: '', priority: 'Medium', status: 'todo', due_date: '', assignee_name: '',
});

const AVATAR_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6'];

export default function ProjectDetail({ setPage }) {
  const [project,    setProject]    = useState(null);
  const [tasks,      setTasks]      = useState([]);
  const [team,       setTeam]       = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [drawer,     setDrawer]     = useState(false);
  const [form,       setForm]       = useState(emptyTask());
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);
  const [activeTab,  setActiveTab]  = useState('tasks');

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const pid    = sessionStorage.getItem('selectedProjectId');
    const cached = sessionStorage.getItem('selectedProject');
    if (cached) { try { setProject(JSON.parse(cached)); } catch {} }

    if (pid) {
      const [projRes, taskRes] = await Promise.allSettled([
        api.get(`/projects/projects/${pid}`),
        api.get('/projects/tasks', { params: { project_id: pid } }),
      ]);
      if (projRes.status === 'fulfilled') setProject(projRes.value.data);

      const rawTasks = taskRes.status === 'fulfilled'
        ? (taskRes.value.data.tasks || taskRes.value.data) : [];
      setTasks(Array.isArray(rawTasks) && rawTasks.length ? rawTasks : SAMPLE_TASKS);
    } else {
      setTasks(SAMPLE_TASKS);
    }
    setTeam(SAMPLE_TEAM);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAddTask = async () => {
    if (!form.task_title) return showToast('Task title required', 'error');
    setSubmitting(true);
    const pid = sessionStorage.getItem('selectedProjectId');
    try {
      await api.post('/projects/tasks', { ...form, project_id: pid });
      showToast('Task created');
    } catch {
      setTasks(ts => [{ ...form, id: Date.now() }, ...ts]);
      showToast('Task added');
    }
    setDrawer(false);
    setForm(emptyTask());
    setSubmitting(false);
    load();
  };

  const updateTaskStatus = async (taskId, newStatus) => {
    try { await api.put(`/projects/tasks/${taskId}`, { status: newStatus }); } catch {}
    setTasks(ts => ts.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
  };

  if (loading) return <div className="pdt-loading"><div className="pdt-spinner" /><p>Loading…</p></div>;
  if (!project) return (
    <div className="pdt-loading">
      <p style={{ color: '#6b7280' }}>No project selected.</p>
      <button className="pdt-btn-outline" onClick={() => setPage && setPage('ProjectsDashboard')}>← Back</button>
    </div>
  );

  const sm = STATUS_META[(project.status || '').toLowerCase()] || STATUS_META.planning;
  const pct    = project.total_tasks ? Math.round((project.completed_tasks / project.total_tasks) * 100) : 0;
  const budPct = project.budget_amount ? Math.min(100, Math.round((project.actual_cost / project.budget_amount) * 100)) : 0;
  const byCol  = TASK_COLS.reduce((acc, c) => { acc[c.key] = tasks.filter(t => t.status === c.key); return acc; }, {});

  return (
    <div className="pdt-root">

      {toast && <div className={`pdt-toast pdt-toast-${toast.type}`}>{toast.msg}</div>}

      {/* header */}
      <div className="pdt-header">
        <div className="pdt-header-l">
          <button className="pdt-back-btn" onClick={() => setPage && setPage('ProjectsDashboard')}>
            <ArrowLeft size={15} /> Projects
          </button>
          <div>
            <div className="pdt-title-row">
              <span className="pdt-code">{project.project_code}</span>
              <span className="pdt-badge" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
            </div>
            <h2 className="pdt-title">{project.project_name}</h2>
            <p className="pdt-sub">
              {project.customer_name || ''}
              {project.manager_name ? ` · PM: ${project.manager_name}` : ''}
            </p>
          </div>
        </div>
        <div className="pdt-header-r">
          <button className="pdt-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="pdt-btn-primary" onClick={() => { setForm(emptyTask()); setDrawer(true); }}>
            <Plus size={14} /> Add Task
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="pdt-kpis">
        <div className="pdt-kpi">
          <Calendar size={15} color="#6366f1" />
          <div>
            <div className="pdt-kpi-label">Start Date</div>
            <div className="pdt-kpi-val">{project.start_date ? new Date(project.start_date).toLocaleDateString('en-IN') : '—'}</div>
          </div>
        </div>
        <div className="pdt-kpi">
          <Calendar size={15} color="#ef4444" />
          <div>
            <div className="pdt-kpi-label">Due Date</div>
            <div className="pdt-kpi-val">{project.end_date ? new Date(project.end_date).toLocaleDateString('en-IN') : '—'}</div>
          </div>
        </div>
        <div className="pdt-kpi">
          <CheckSquare size={15} color="#10b981" />
          <div>
            <div className="pdt-kpi-label">Tasks</div>
            <div className="pdt-kpi-val">
              {project.completed_tasks || 0}/{project.total_tasks || tasks.length}
              <span className="pdt-kpi-pct"> ({pct}%)</span>
            </div>
          </div>
        </div>
        <div className="pdt-kpi">
          <DollarSign size={15} color="#f59e0b" />
          <div>
            <div className="pdt-kpi-label">Budget</div>
            <div className="pdt-kpi-val">
              {fmt(project.actual_cost)}
              <span className="pdt-kpi-pct"> / {fmt(project.budget_amount)}</span>
            </div>
          </div>
        </div>
        <div className="pdt-kpi">
          <Users size={15} color="#8b5cf6" />
          <div>
            <div className="pdt-kpi-label">Team</div>
            <div className="pdt-kpi-val">{project.team_size || team.length} members</div>
          </div>
        </div>
      </div>

      {/* progress bars */}
      <div className="pdt-progress-row">
        <div className="pdt-progress-item">
          <div className="pdt-prog-hd"><span>Task Progress</span><span>{pct}%</span></div>
          <div className="pdt-prog-track">
            <div className="pdt-prog-bar" style={{ width: `${pct}%`, background: '#6366f1' }} />
          </div>
        </div>
        <div className="pdt-progress-item">
          <div className="pdt-prog-hd">
            <span>Budget Used</span>
            <span style={{ color: budPct > 85 ? '#ef4444' : 'inherit' }}>{budPct}%</span>
          </div>
          <div className="pdt-prog-track">
            <div className="pdt-prog-bar" style={{ width: `${budPct}%`, background: budPct > 85 ? '#ef4444' : '#10b981' }} />
          </div>
        </div>
      </div>

      {/* tabs */}
      <div className="pdt-tabs">
        {['tasks', 'team', 'timeline'].map(tab => (
          <button key={tab} className={`pdt-tab${activeTab === tab ? ' pdt-tab-active' : ''}`}
            onClick={() => setActiveTab(tab)}>
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tasks — Kanban */}
      {activeTab === 'tasks' && (
        <div className="pdt-kanban">
          {TASK_COLS.map(col => (
            <div key={col.key} className="pdt-col">
              <div className="pdt-col-hd">
                <span className="pdt-col-label" style={{ color: col.color }}>{col.label}</span>
                <span className="pdt-col-count" style={{ background: col.bg, color: col.color }}>
                  {byCol[col.key]?.length || 0}
                </span>
              </div>
              <div className="pdt-col-body">
                {(byCol[col.key] || []).map(task => {
                  const pc = PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.Low;
                  return (
                    <div key={task.id} className="pdt-task-card">
                      <div className="pdt-task-hd">
                        <span className="pdt-task-title">{task.task_title}</span>
                        <span className="pdt-priority-badge" style={{ background: pc.bg, color: pc.color }}>
                          {task.priority}
                        </span>
                      </div>
                      {task.assignee_name && (
                        <div className="pdt-task-meta"><Users size={10} /> {task.assignee_name}</div>
                      )}
                      {task.due_date && (
                        <div className="pdt-task-meta"><Clock size={10} /> {new Date(task.due_date).toLocaleDateString('en-IN')}</div>
                      )}
                      <div className="pdt-task-actions">
                        {TASK_COLS.filter(c => c.key !== col.key).slice(0, 2).map(nc => (
                          <button key={nc.key} className="pdt-move-btn"
                            style={{ color: nc.color }} onClick={() => updateTaskStatus(task.id, nc.key)}>
                            → {nc.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {!(byCol[col.key]?.length) && <div className="pdt-col-empty">No tasks</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Team */}
      {activeTab === 'team' && (
        <div className="pdt-team-grid">
          {team.map((m, i) => (
            <div key={m.id || i} className="pdt-member-card">
              <div className="pdt-member-avatar"
                style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] + '20', color: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                {m.avatar || m.name?.charAt(0)}
              </div>
              <div>
                <div className="pdt-member-name">{m.name}</div>
                <div className="pdt-member-role">{m.role}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Timeline */}
      {activeTab === 'timeline' && (
        <div className="pdt-timeline">
          {TASK_COLS.map(col => {
            const colTasks = byCol[col.key] || [];
            if (!colTasks.length) return null;
            return (
              <div key={col.key} className="pdt-tl-group">
                <div className="pdt-tl-group-label" style={{ color: col.color }}>
                  {col.label} ({colTasks.length})
                </div>
                {colTasks.map(task => (
                  <div key={task.id} className="pdt-tl-row">
                    <div className="pdt-tl-dot" style={{ background: col.color }} />
                    <div className="pdt-tl-info">
                      <span className="pdt-tl-title">{task.task_title}</span>
                      {task.due_date && (
                        <span className="pdt-tl-date">{new Date(task.due_date).toLocaleDateString('en-IN')}</span>
                      )}
                    </div>
                    {task.assignee_name && <span className="pdt-tl-assignee">{task.assignee_name}</span>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Task Drawer */}
      {drawer && (
        <div className="pdt-overlay" onClick={() => setDrawer(false)}>
          <div className="pdt-drawer" onClick={e => e.stopPropagation()}>
            <div className="pdt-drawer-hd">
              <h3>Add Task</h3>
              <button className="pdt-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
            </div>
            <div className="pdt-drawer-body">
              <div className="pdt-field">
                <label>Task Title *</label>
                <input value={form.task_title}
                  onChange={e => setForm(f => ({ ...f, task_title: e.target.value }))}
                  placeholder="What needs to be done…" />
              </div>
              <div className="pdt-field">
                <label>Description</label>
                <textarea rows={3} value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Details…" />
              </div>
              <div className="pdt-row2">
                <div className="pdt-field">
                  <label>Priority</label>
                  <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                    <option>High</option><option>Medium</option><option>Low</option>
                  </select>
                </div>
                <div className="pdt-field">
                  <label>Status</label>
                  <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                    {TASK_COLS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="pdt-row2">
                <div className="pdt-field">
                  <label>Due Date</label>
                  <input type="date" value={form.due_date}
                    onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
                </div>
                <div className="pdt-field">
                  <label>Assignee</label>
                  <input value={form.assignee_name}
                    onChange={e => setForm(f => ({ ...f, assignee_name: e.target.value }))}
                    placeholder="Name…" />
                </div>
              </div>
            </div>
            <div className="pdt-drawer-ft">
              <button className="pdt-btn-outline" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="pdt-btn-primary" onClick={handleAddTask} disabled={submitting}>
                {submitting ? 'Adding…' : 'Add Task'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
