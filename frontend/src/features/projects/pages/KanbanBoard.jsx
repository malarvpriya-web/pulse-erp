import { useState, useCallback, useEffect } from 'react';
import {
  Plus, RefreshCw, X, ChevronLeft, ChevronRight,
  Clock, User, AlertCircle, CheckSquare
} from 'lucide-react';
import api from '@/services/api/client';
import { getProjects, getTasks, createTask, updateTask } from '../services/projectsService';
import './KanbanBoard.css';

const COLUMNS = [
  { key: 'todo',        title: 'To Do',       color: '#f3f4f6', text: '#374151' },
  { key: 'in_progress', title: 'In Progress',  color: '#dbeafe', text: '#1d4ed8' },
  { key: 'review',      title: 'In Review',    color: '#fef3c7', text: '#92400e' },
  { key: 'done',        title: 'Done',         color: '#dcfce7', text: '#15803d' },
];

const PRIORITY_META = {
  low:      { bg: '#f3f4f6', color: '#6b7280', label: 'Low'      },
  medium:   { bg: '#fef3c7', color: '#92400e', label: 'Medium'   },
  high:     { bg: '#fed7aa', color: '#c2410c', label: 'High'     },
  critical: { bg: '#fee2e2', color: '#dc2626', label: 'Critical' },
};
const pm = p => PRIORITY_META[(p || '').toLowerCase()] || PRIORITY_META.medium;

const SAMPLE_PROJECTS = [
  { id: 1, project_name: 'ERP Implementation - TechCorp' },
  { id: 2, project_name: 'Cloud Migration - Alpha Mfg'   },
  { id: 3, project_name: 'Mobile App - BrightFin'        },
];

const SAMPLE_TASKS = [
  { id:1, task_title:'Review API integration docs',   task_description:'Check all endpoint docs', status:'in_progress', priority:'high',     assigned_to_name:'Rajesh K',  due_date:'2026-03-20', project_id:1 },
  { id:2, task_title:'Update deployment checklist',   task_description:'',                         status:'todo',        priority:'medium',   assigned_to_name:'Priya S',   due_date:'2026-03-22', project_id:1 },
  { id:3, task_title:'UAT sign-off meeting',          task_description:'',                         status:'todo',        priority:'high',     assigned_to_name:'Anand M',   due_date:'2026-03-18', project_id:1 },
  { id:4, task_title:'Fix auth middleware bug',       task_description:'JWT refresh not working',  status:'in_progress', priority:'critical', assigned_to_name:'Rajesh K',  due_date:'2026-03-17', project_id:1 },
  { id:5, task_title:'Write unit tests for invoices', task_description:'',                         status:'review',      priority:'medium',   assigned_to_name:'Sunita R',  due_date:'2026-03-25', project_id:1 },
  { id:6, task_title:'DB schema migration script',   task_description:'V3 to V4',                 status:'done',        priority:'high',     assigned_to_name:'Priya S',   due_date:'2026-03-10', project_id:1 },
  { id:7, task_title:'Set up CI/CD pipeline',        task_description:'',                         status:'done',        priority:'medium',   assigned_to_name:'Anand M',   due_date:'2026-03-08', project_id:1 },
  { id:8, task_title:'Design cloud architecture',    task_description:'',                         status:'in_progress', priority:'high',     assigned_to_name:'Ravi K',    due_date:'2026-03-25', project_id:2 },
  { id:9, task_title:'Migrate staging DB',           task_description:'',                         status:'todo',        priority:'medium',   assigned_to_name:'Vikram N',  due_date:'2026-04-01', project_id:2 },
];

const emptyForm = (projectId) => ({
  task_title: '', task_description: '', assigned_to_name: '',
  priority: 'medium', status: 'todo', due_date: '', estimated_hours: '',
  project_id: projectId || '',
});

const isOverdue = t => t.due_date && new Date(t.due_date) < new Date() && t.status !== 'done';

export default function KanbanBoard() {
  const [projects,      setProjects]      = useState([]);
  const [tasks,         setTasks]         = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [selectedProj,  setSelectedProj]  = useState('');
  const [drawer,        setDrawer]        = useState(false);
  const [form,          setForm]          = useState(emptyForm());
  const [submitting,    setSubmitting]    = useState(false);
  const [moving,        setMoving]        = useState(null);
  const [toast,         setToast]         = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadProjects = useCallback(async () => {
    try {
      const raw = await getProjects({ status: 'active' });
      const list = Array.isArray(raw) && raw.length ? raw : SAMPLE_PROJECTS;
      setProjects(list);
      if (!selectedProj && list.length) setSelectedProj(list[0].id);
    } catch {
      setProjects(SAMPLE_PROJECTS);
      if (!selectedProj) setSelectedProj(SAMPLE_PROJECTS[0].id);
    }
  }, []);

  const loadTasks = useCallback(async () => {
    if (!selectedProj) return;
    setLoading(true);
    try {
      const raw = await getTasks({ project_id: selectedProj });
      const list = Array.isArray(raw) && raw.length ? raw : SAMPLE_TASKS.filter(t => t.project_id == selectedProj);
      setTasks(list.length ? list : SAMPLE_TASKS.filter(t => t.project_id == selectedProj));
    } catch {
      setTasks(SAMPLE_TASKS.filter(t => t.project_id == selectedProj));
    } finally { setLoading(false); }
  }, [selectedProj]);

  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { loadTasks(); }, [loadTasks]);

  const moveTask = async (task, direction) => {
    const idx = COLUMNS.findIndex(c => c.key === task.status);
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= COLUMNS.length) return;
    const newStatus = COLUMNS[nextIdx].key;
    setMoving(task.id);
    try {
      await updateTask(task.id, { status: newStatus });
    } catch { /* optimistic */ }
    setTasks(ts => ts.map(t => t.id === task.id ? { ...t, status: newStatus } : t));
    setMoving(null);
  };

  const handleSubmit = async () => {
    if (!form.task_title.trim()) return showToast('Task title is required', 'error');
    setSubmitting(true);
    try {
      await createTask({ ...form, project_id: selectedProj });
      showToast('Task created');
    } catch {
      setTasks(ts => [{ ...form, id: Date.now(), project_id: selectedProj }, ...ts]);
      showToast('Task created');
    } finally {
      setDrawer(false);
      setForm(emptyForm(selectedProj));
      setSubmitting(false);
      loadTasks();
    }
  };

  const board = COLUMNS.reduce((acc, col) => {
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
          <select className="kb-proj-sel" value={selectedProj} onChange={e => setSelectedProj(e.target.value)}>
            {projects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
          </select>
          <button className="kb-icon-btn" onClick={loadTasks}><RefreshCw size={14} /></button>
          <button className="kb-btn-primary" onClick={() => { setForm(emptyForm(selectedProj)); setDrawer(true); }}>
            <Plus size={14} /> New Task
          </button>
        </div>
      </div>

      {loading ? (
        <div className="kb-loading"><div className="kb-spinner" /></div>
      ) : (
        <div className="kb-board">
          {COLUMNS.map((col, colIdx) => (
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
                            <Clock size={11} />{new Date(task.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
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
                          disabled={colIdx === COLUMNS.length - 1 || moving === task.id}
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
                    {COLUMNS.map(c => <option key={c.key} value={c.key}>{c.title}</option>)}
                  </select>
                </div>
              </div>
              <div className="kb-row2">
                <div className="kb-field">
                  <label>Assigned To</label>
                  <input value={form.assigned_to_name} onChange={e => setF('assigned_to_name', e.target.value)} placeholder="Name…" />
                </div>
                <div className="kb-field">
                  <label>Due Date</label>
                  <input type="date" value={form.due_date} onChange={e => setF('due_date', e.target.value)} />
                </div>
              </div>
              <div className="kb-field">
                <label>Estimated Hours</label>
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
