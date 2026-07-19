import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Plus, RefreshCw, X, ChevronLeft, ChevronRight,
  Clock, User, AlertCircle
} from 'lucide-react';
import api from '@/services/api/client';
import { getProjects, getTasks, createTask, updateTask } from '../services/projectsService';
import './KanbanBoard.css';

const DEFAULT_COLUMNS = [
  { key: 'todo',        title: 'To Do',       color: '#f3f4f6', text: '#374151' },
  { key: 'in_progress', title: 'In Progress',  color: '#ede9fe', text: '#4f46e5' },
  { key: 'review',      title: 'In Review',    color: '#fef3c7', text: '#92400e' },
  { key: 'done',        title: 'Done',         color: '#dcfce7', text: '#15803d' },
  { key: 'blocked',     title: 'Blocked',      color: '#fee2e2', text: '#dc2626' },
];

const STATUS_STYLE = {
  todo:        { color: '#f3f4f6', text: '#374151' },
  in_progress: { color: '#ede9fe', text: '#4f46e5' },
  review:      { color: '#fef3c7', text: '#92400e' },
  done:        { color: '#dcfce7', text: '#15803d' },
  blocked:     { color: '#fee2e2', text: '#dc2626' },
};

function buildColumns(csv) {
  return csv
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(key => {
      const st = STATUS_STYLE[key] || { color: '#f3f4f6', text: '#374151' };
      const title = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return { key, title, color: st.color, text: st.text };
    });
}

const PRIORITY_META = {
  low:      { bg: '#f3f4f6', color: '#6b7280', label: 'Low'      },
  medium:   { bg: '#fef3c7', color: '#92400e', label: 'Medium'   },
  high:     { bg: '#fed7aa', color: '#c2410c', label: 'High'     },
  critical: { bg: '#fee2e2', color: '#dc2626', label: 'Critical' },
};
const pm = p => PRIORITY_META[(p || '').toLowerCase()] || PRIORITY_META.medium;


const emptyForm = (projectId) => ({
  task_title: '', task_description: '',
  assignment_type: 'all_employees', assigned_to: '',
  priority: 'medium', status: 'todo',
  due_date: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })(),
  estimated_hours: '',
  project_id: projectId || '',
});

const isOverdue = t => t.due_date && new Date(t.due_date) < new Date() && t.status !== 'done';

export default function KanbanBoard() {
  const [columns,        setColumns]        = useState(DEFAULT_COLUMNS);
  const [projects,       setProjects]       = useState([]);
  const [tasks,          setTasks]          = useState([]);
  const [employees,      setEmployees]      = useState([]);
  const [loading,        setLoading]        = useState(false);
  const [projectsError,  setProjectsError]  = useState(false);
  const [tasksError,     setTasksError]     = useState(false);
  const [selectedProj,   setSelectedProj]   = useState('');
  const [drawer,         setDrawer]         = useState(false);
  const [form,           setForm]           = useState(emptyForm());
  const [submitting,     setSubmitting]     = useState(false);
  const [moving,         setMoving]         = useState(null);
  const [toast,          setToast]          = useState(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    api.get('/settings/projects')
      .then(res => {
        const csv = res.data?.default_task_statuses;
        if (csv && isMounted.current) setColumns(buildColumns(csv));
      })
      .catch(() => {}); // fall back to DEFAULT_COLUMNS
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadProjects = useCallback(async () => {
    setProjectsError(false);
    try {
      const raw = await getProjects();
      if (!isMounted.current) return;
      setProjects(Array.isArray(raw) ? raw : []);
    } catch {
      if (!isMounted.current) return;
      setProjectsError(true);
      setProjects([]);
    }
  }, []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setTasksError(false);
    try {
      const params = selectedProj ? { project_id: selectedProj } : {};
      const raw = await getTasks(params);
      if (!isMounted.current) return;
      setTasks(Array.isArray(raw) ? raw : []);
    } catch {
      if (!isMounted.current) return;
      setTasksError(true);
      setTasks([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [selectedProj]);

  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { loadTasks(); }, [loadTasks]);

  useEffect(() => {
    api.get('/projects/employees')
      .then(res => { if (isMounted.current) setEmployees(Array.isArray(res.data) ? res.data : []); })
      .catch(() => { if (isMounted.current) setEmployees([]); });
  }, []);

  const moveTask = async (task, direction) => {
    const idx = columns.findIndex(c => c.key === task.status);
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= columns.length) return;
    const newStatus = columns[nextIdx].key;
    setMoving(task.id);
    try {
      await updateTask(task.id, { status: newStatus });
      setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: newStatus } : t));
    } catch {
      showToast('Failed to move task — please try again', 'error');
    } finally {
      setMoving(null);
    }
  };

  const handleSubmit = async () => {
    if (!form.task_title.trim()) return showToast('Task title is required', 'error');
    if (!form.project_id) return showToast('Select a project for this task', 'error');
    setSubmitting(true);
    try {
      await createTask({ ...form });
      showToast('Task created');
      setDrawer(false);
      setForm(emptyForm(selectedProj));
      loadTasks();
      window.dispatchEvent(new CustomEvent('pulse:tasks-updated'));
    } catch {
      showToast('Failed to create task — please try again', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const board = columns.reduce((acc, col) => {
    acc[col.key] = tasks.filter(t => t.status === col.key);
    return acc;
  }, {});

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="kb-root">
      {toast && <div className={`kb-toast kb-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="kb-header">
        <div>
          <h2 className="kb-title">Task Board</h2>
          <p className="kb-sub">{tasks.length} task{tasks.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="kb-header-r">
          {projectsError ? (
            <span className="kb-error-inline">Could not load projects</span>
          ) : (
            <select className="kb-proj-sel" value={selectedProj} onChange={e => setSelectedProj(e.target.value)}>
              <option value="">All Projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
            </select>
          )}
          <button className="kb-icon-btn" onClick={loadTasks}><RefreshCw size={14} /></button>
          <button className="kb-btn-primary" onClick={() => { setForm(emptyForm(selectedProj || '')); setDrawer(true); }}>
            <Plus size={14} /> New Task
          </button>
        </div>
      </div>

      {loading ? (
        <div className="kb-loading"><div className="kb-spinner" /></div>
      ) : tasksError ? (
        <div className="kb-loading">
          <p className="kb-error-state">Could not load tasks — check your connection and try again.</p>
        </div>
      ) : (
        <div className="kb-board">
          {columns.map((col, colIdx) => (
            <div key={col.key} className="kb-col">
              <div className="kb-col-hd" style={{ background: col.color }}>
                <span className="kb-col-title" style={{ color: col.text }}>{col.title}</span>
                <span className="kb-col-count" style={{ background: col.color, color: col.text }}>{board[col.key].length}</span>
              </div>
              <div className="kb-col-body">
                {board[col.key].length === 0 && (
                  <div className="kb-col-empty">No tasks</div>
                )}
                {board[col.key].map(task => {
                  const p = pm(task.priority);
                  const over = isOverdue(task);
                  return (
                    <div key={task.id} className={`kb-card${over ? ' kb-card-overdue' : ''}`}>
                      <div className="kb-card-hd">
                        <span className="kb-priority" style={{ background: p.bg, color: p.color }}>{p.label}</span>
                        {over && <AlertCircle size={12} color="#ef4444" />}
                      </div>
                      <p className="kb-task-title">{task.task_title}</p>
                      {task.task_description && <p className="kb-task-desc">{task.task_description}</p>}
                      <div className="kb-card-ft">
                        {task.assigned_to_name && (
                          <span className="kb-assignee"><User size={11} />{task.assigned_to_name}</span>
                        )}
                        {task.due_date && (
                          <span className={`kb-due${over ? ' kb-due-over' : ''}`}>
                            <Clock size={11} />{new Date(task.due_date.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                          </span>
                        )}
                      </div>
                      <div className="kb-card-moves">
                        <button
                          className="kb-move-btn"
                          disabled={colIdx === 0 || moving === task.id}
                          onClick={() => moveTask(task, -1)}
                          title="Move left"
                        ><ChevronLeft size={13} /></button>
                        <button
                          className="kb-move-btn"
                          disabled={colIdx === columns.length - 1 || moving === task.id}
                          onClick={() => moveTask(task, 1)}
                          title="Move right"
                        ><ChevronRight size={13} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {drawer && (
        <div className="kb-overlay" onClick={() => setDrawer(false)}>
          <div className="kb-drawer" onClick={e => e.stopPropagation()}>
            <div className="kb-drawer-hd">
              <h3>New Task</h3>
              <button className="kb-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
            </div>
            <div className="kb-drawer-body">
              <div className="kb-field">
                <label>Project <span className="kb-req">*</span></label>
                <select
                  value={form.project_id}
                  onChange={e => setF('project_id', e.target.value)}
                >
                  <option value="">— Select project —</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.project_name}</option>
                  ))}
                </select>
              </div>
              <div className="kb-field">
                <label>Task Title <span className="kb-req">*</span></label>
                <input value={form.task_title} onChange={e => setF('task_title', e.target.value)} placeholder="Task title…" />
              </div>
              <div className="kb-field">
                <label>Description</label>
                <textarea rows={3} value={form.task_description} onChange={e => setF('task_description', e.target.value)} placeholder="Details…" />
              </div>
              <div className="kb-row2">
                <div className="kb-field">
                  <label>Priority</label>
                  <select value={form.priority} onChange={e => setF('priority', e.target.value)}>
                    {['low','medium','high','critical'].map(p => <option key={p} value={p}>{pm(p).label}</option>)}
                  </select>
                </div>
                <div className="kb-field">
                  <label>Start In Column</label>
                  <select value={form.status} onChange={e => setF('status', e.target.value)}>
                    {columns.map(c => <option key={c.key} value={c.key}>{c.title}</option>)}
                  </select>
                </div>
              </div>
              <div className="kb-row2">
                <div className="kb-field">
                  <label>Assigned To</label>
                  <select
                    value={form.assignment_type}
                    onChange={e => setForm(f => ({ ...f, assignment_type: e.target.value, assigned_to: '' }))}
                  >
                    <option value="all_employees">All Employees</option>
                    <option value="managers">Managers</option>
                    <option value="individual">Individual Employee</option>
                  </select>
                  {form.assignment_type === 'individual' && (
                    <select
                      value={form.assigned_to}
                      onChange={e => setF('assigned_to', e.target.value)}
                      style={{ marginTop: 6 }}
                    >
                      <option value="">Select employee…</option>
                      {employees.map(emp => (
                        <option key={emp.id} value={emp.id}>{`${emp.first_name || ''} ${emp.last_name || ''}`.trim()}</option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="kb-field">
                  <label>Due Date</label>
                  <input type="date" value={form.due_date} onChange={e => setF('due_date', e.target.value)} />
                </div>
              </div>
              <div className="kb-field">
                <label>Time Required</label>
                <input type="number" value={form.estimated_hours} onChange={e => setF('estimated_hours', e.target.value)} placeholder="0" />
              </div>
            </div>
            <div className="kb-drawer-ft">
              <button className="kb-btn-outline" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="kb-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create Task'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}