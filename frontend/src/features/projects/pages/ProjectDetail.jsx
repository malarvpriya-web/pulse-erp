import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft, Calendar, Users, IndianRupee, Clock,
  Plus, X, CheckSquare, RefreshCw, AlertTriangle, FileText,
  Shield, Target, Trash2, Edit3, Check, Flag
} from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
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
  high:     { bg: '#fee2e2', color: '#dc2626' },
  medium:   { bg: '#fef3c7', color: '#92400e' },
  low:      { bg: '#f3f4f6', color: '#6b7280' },
  critical: { bg: '#ffd4d4', color: '#b91c1c' },
};

const AVATAR_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6'];

const RISK_COLORS = { high: '#dc2626', medium: '#ea580c', low: '#15803d' };
const riskLevel = (score) => score >= 15 ? 'high' : score >= 6 ? 'medium' : 'low';

const emptyTask = () => ({ task_title: '', description: '', priority: 'medium', status: 'todo', due_date: '', assignee_name: '' });
const emptyMile = () => ({ name: '', description: '', due_date: '', amount: 0, billing_milestone: false });
const emptyRisk = () => ({ description: '', category: 'technical', probability: 2, impact: 2, contingency_plan: '', status: 'open' });

// Document classification — persisted to project_documents.document_type.
const DOCUMENT_TYPES = ['drawing', 'specification', 'report', 'certificate', 'contract', 'manual', 'test_record', 'other'];
const emptyDoc = () => ({ document_name: '', document_type: 'drawing', revision: '', file_url: '', description: '' });

function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 24px', textAlign: 'center', gap: 8, background: 'var(--color-background-secondary)', borderRadius: 10, border: '1px solid var(--color-border-tertiary)' }}>
      {Icon && <Icon size={32} style={{ color: '#9ca3af', marginBottom: 4 }} />}
      <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>{title}</p>
      {sub && <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>{sub}</p>}
    </div>
  );
}

const TABS = [
  { id: 'tasks',      label: 'Tasks' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'risks',      label: 'Risks' },
  { id: 'issues',     label: 'Issues' },
  { id: 'fat_sat',    label: 'FAT / SAT' },
  { id: 'documents',  label: 'Documents' },
  { id: 'team',       label: 'Team' },
];

export default function ProjectDetail({ setPage, urlParams }) {
  const [project,     setProject]     = useState(null);
  const [tasks,       setTasks]       = useState([]);
  const [team,        setTeam]        = useState([]);
  const [milestones,  setMilestones]  = useState([]);
  const [risks,       setRisks]       = useState([]);
  const [issues,      setIssues]      = useState([]);
  const [fats,        setFats]        = useState([]);
  const [sats,        setSats]        = useState([]);
  const [documents,   setDocuments]   = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [activeTab,   setActiveTab]   = useState('tasks');

  const [taskDrawer,  setTaskDrawer]  = useState(false);
  const [taskForm,    setTaskForm]    = useState(emptyTask());
  const [editTaskId,  setEditTaskId]  = useState(null);

  const [mileDrawer,  setMileDrawer]  = useState(false);
  const [mileForm,    setMileForm]    = useState(emptyMile());
  const [editMileId,  setEditMileId]  = useState(null);
  const [completing,  setCompleting]  = useState(null);

  const [riskDrawer,  setRiskDrawer]  = useState(false);
  const [riskForm,    setRiskForm]    = useState(emptyRisk());
  const [editRiskId,  setEditRiskId]  = useState(null);

  const [docDrawer,   setDocDrawer]   = useState(false);
  const [docForm,     setDocForm]     = useState(emptyDoc());

  const [toast,              setToast]              = useState(null);
  const [submitting,         setSubmitting]         = useState(false);
  const [pendingDeleteTask,  setPendingDeleteTask]  = useState(null);
  const [pendingCompleteMile, setPendingCompleteMile] = useState(null);
  const [pendingDeleteMile,  setPendingDeleteMile]  = useState(null);
  const [pendingDeleteRisk,  setPendingDeleteRisk]  = useState(null);

  const isMounted = useRef(true);
  const pid = urlParams?.id || sessionStorage.getItem('selectedProjectId');

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const cached = sessionStorage.getItem('selectedProject');
    if (cached) { try { if (isMounted.current) setProject(JSON.parse(cached)); } catch { /* */ } }
    if (!pid) { if (isMounted.current) setLoading(false); return; }

    const [projRes, taskRes, teamRes, mileRes, riskRes, issueRes, fatRes, satRes, docRes] = await Promise.allSettled([
      api.get(`/projects/projects/${pid}`),
      api.get('/projects/tasks', { params: { project_id: pid } }),
      api.get(`/projects/projects/${pid}/members`),
      api.get(`/projects/projects/${pid}/milestones`),
      api.get(`/projects/projects/${pid}/risks`),
      api.get(`/projects/projects/${pid}/issues`),
      api.get(`/projects/projects/${pid}/fat`),
      api.get(`/projects/projects/${pid}/sat`),
      api.get(`/projects/projects/${pid}/documents`),
    ]);
    if (!isMounted.current) return;

    if (projRes.status === 'fulfilled') {
      const d = projRes.value.data?.project || projRes.value.data;
      setProject(d);
    }
    const raw = (r, keys) => {
      if (r.status !== 'fulfilled') return [];
      const d = r.value.data;
      for (const k of keys) if (Array.isArray(d?.[k])) return d[k];
      return Array.isArray(d) ? d : [];
    };
    setTasks(raw(taskRes, ['tasks']));
    setTeam(raw(teamRes, ['members']));
    setMilestones(raw(mileRes, ['milestones']));
    setRisks(raw(riskRes, ['risks']));
    setIssues(raw(issueRes, ['issues']));
    setFats(raw(fatRes, ['fat_records', 'fats']));
    setSats(raw(satRes, ['sat_records', 'sats']));
    setDocuments(raw(docRes, ['documents']));
    if (isMounted.current) setLoading(false);
  }, [pid]);

  useEffect(() => { load(); }, [load]);

  /* ── TASK CRUD ── */
  const handleSaveTask = async () => {
    if (!taskForm.task_title) return showToast('Task title required', 'error');
    setSubmitting(true);
    try {
      if (editTaskId) {
        await api.put(`/projects/tasks/${editTaskId}`, { ...taskForm, project_id: pid });
      } else {
        await api.post('/projects/tasks', { ...taskForm, project_id: pid });
      }
      showToast(editTaskId ? 'Task updated' : 'Task created');
      setTaskDrawer(false); setTaskForm(emptyTask()); setEditTaskId(null);
      load();
    } catch { showToast('Failed to save task', 'error'); }
    finally { setSubmitting(false); }
  };

  const deleteTask = async () => {
    if (!pendingDeleteTask) return;
    const id = pendingDeleteTask;
    setPendingDeleteTask(null);
    try {
      await api.delete(`/projects/tasks/${id}`);
      setTasks(ts => ts.filter(t => t.id !== id));
      showToast('Task deleted');
    } catch { showToast('Delete failed', 'error'); }
  };

  const updateTaskStatus = async (taskId, newStatus) => {
    try {
      await api.put(`/projects/tasks/${taskId}`, { status: newStatus });
      setTasks(ts => ts.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
    } catch { showToast('Failed to update status', 'error'); }
  };

  /* ── MILESTONE CRUD ── */
  const handleSaveMilestone = async () => {
    if (!mileForm.name) return showToast('Milestone name required', 'error');
    setSubmitting(true);
    try {
      if (editMileId) {
        await api.put(`/projects/milestones/${editMileId}`, { ...mileForm, project_id: pid });
      } else {
        await api.post(`/projects/projects/${pid}/milestones`, { ...mileForm, project_id: pid });
      }
      showToast(editMileId ? 'Milestone updated' : 'Milestone created');
      setMileDrawer(false); setMileForm(emptyMile()); setEditMileId(null);
      load();
    } catch { showToast('Failed to save milestone', 'error'); }
    finally { setSubmitting(false); }
  };

  const completeMilestone = async () => {
    if (!pendingCompleteMile) return;
    const m = pendingCompleteMile;
    setPendingCompleteMile(null);
    setCompleting(m.id);
    try {
      const res = await api.put(`/projects/milestones/${m.id}/complete`);
      const { invoice_created } = res.data || {};
      showToast(invoice_created ? 'Milestone completed + invoice created!' : 'Milestone completed');
      load();
    } catch (e) { showToast(e.response?.data?.error || 'Failed to complete milestone', 'error'); }
    finally { setCompleting(null); }
  };

  const deleteMilestone = async () => {
    if (!pendingDeleteMile) return;
    const id = pendingDeleteMile;
    setPendingDeleteMile(null);
    try {
      await api.delete(`/projects/milestones/${id}`);
      showToast('Milestone deleted');
      load();
    } catch { showToast('Delete failed', 'error'); }
  };

  /* ── RISK CRUD ── */
  const handleSaveRisk = async () => {
    if (!riskForm.description) return showToast('Risk description required', 'error');
    setSubmitting(true);
    try {
      if (editRiskId) {
        await api.put(`/projects/risks/${editRiskId}`, { ...riskForm, project_id: pid });
      } else {
        await api.post(`/projects/projects/${pid}/risks`, { ...riskForm, project_id: pid });
      }
      showToast(editRiskId ? 'Risk updated' : 'Risk registered');
      setRiskDrawer(false); setRiskForm(emptyRisk()); setEditRiskId(null);
      load();
    } catch { showToast('Failed to save risk', 'error'); }
    finally { setSubmitting(false); }
  };

  const deleteRisk = async () => {
    if (!pendingDeleteRisk) return;
    const id = pendingDeleteRisk;
    setPendingDeleteRisk(null);
    try { await api.delete(`/projects/risks/${id}`); showToast('Risk deleted'); load(); }
    catch { showToast('Delete failed', 'error'); }
  };

  const handleSaveDoc = async () => {
    if (!docForm.document_name.trim()) return showToast('Document name required', 'error');
    setSubmitting(true);
    try {
      await api.post(`/projects/projects/${pid}/documents`, docForm);
      showToast('Document added');
      setDocDrawer(false); setDocForm(emptyDoc());
      load();
    } catch { showToast('Failed to add document', 'error'); }
    finally { setSubmitting(false); }
  };

  if (!project) return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <p style={{ color: '#6b7280', marginBottom: 12 }}>No project selected.</p>
      <button style={{ padding: '8px 16px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }} onClick={() => setPage?.('ProjectsDashboard')}>← Back to Projects</button>
    </div>
  );

  const sm      = STATUS_META[(project.status || '').toLowerCase()] || STATUS_META.planning;
  const taskPct = project.total_tasks ? Math.round((project.completed_tasks / project.total_tasks) * 100) : 0;
  const budPct  = project.budget_amount ? Math.min(100, Math.round(((project.actual_cost || 0) / project.budget_amount) * 100)) : 0;
  const byCol   = TASK_COLS.reduce((acc, c) => { acc[c.key] = tasks.filter(t => t.status === c.key); return acc; }, {});

  return (
    <div className="pdt-root">
      <ConfirmDialog
        open={!!pendingDeleteTask}
        title="Delete Task"
        message="Delete this task?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteTask}
        onCancel={() => setPendingDeleteTask(null)}
      />
      <ConfirmDialog
        open={!!pendingCompleteMile}
        title="Complete Milestone"
        message={pendingCompleteMile ? `Mark "${pendingCompleteMile.name}" as complete?${pendingCompleteMile.billing_milestone ? ' This will auto-create an invoice.' : ''}` : ''}
        confirmLabel="Complete"
        variant="info"
        onConfirm={completeMilestone}
        onCancel={() => setPendingCompleteMile(null)}
      />
      <ConfirmDialog
        open={!!pendingDeleteMile}
        title="Delete Milestone"
        message="Delete this milestone?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteMilestone}
        onCancel={() => setPendingDeleteMile(null)}
      />
      <ConfirmDialog
        open={!!pendingDeleteRisk}
        title="Delete Risk"
        message="Delete this risk?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteRisk}
        onCancel={() => setPendingDeleteRisk(null)}
      />
      {toast && <div className={`pdt-toast pdt-toast-${toast.type}`}>{toast.msg}</div>}

      {/* HEADER */}
      <div className="pdt-header">
        <div className="pdt-header-l">
          <button className="pdt-back-btn" onClick={() => setPage?.('ProjectsDashboard')}>
            <ArrowLeft size={15} /> Projects
          </button>
          <div>
            <div className="pdt-title-row">
              <span className="pdt-code">{project.project_code}</span>
              <span className="pdt-badge" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
              {project.current_stage && <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, background: '#e0f2fe', color: '#0369a1', fontWeight: 600 }}>{project.current_stage.toUpperCase()}</span>}
            </div>
            <h2 className="pdt-title">{project.project_name}</h2>
            <p className="pdt-sub">
              {project.customer_name || project.client_name || ''}
              {project.manager_name ? ` · PM: ${project.manager_name}` : ''}
            </p>
          </div>
        </div>
        <div className="pdt-header-r">
          <button className="pdt-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="pdt-btn-primary" onClick={() => { setTaskForm(emptyTask()); setEditTaskId(null); setTaskDrawer(true); }}>
            <Plus size={14} /> Add Task
          </button>
        </div>
      </div>

      {/* KPI STRIP */}
      <div className="pdt-kpis">
        <div className="pdt-kpi"><Calendar size={15} color="#6366f1" /><div><div className="pdt-kpi-label">Start</div><div className="pdt-kpi-val">{project.start_date ? new Date(project.start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</div></div></div>
        <div className="pdt-kpi"><Calendar size={15} color="#ef4444" /><div><div className="pdt-kpi-label">Due</div><div className="pdt-kpi-val">{project.end_date ? new Date(project.end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</div></div></div>
        <div className="pdt-kpi"><CheckSquare size={15} color="#10b981" /><div><div className="pdt-kpi-label">Tasks</div><div className="pdt-kpi-val">{project.completed_tasks || 0}/{project.total_tasks || tasks.length}<span className="pdt-kpi-pct"> ({taskPct}%)</span></div></div></div>
        <div className="pdt-kpi"><IndianRupee size={15} color="#f59e0b" /><div><div className="pdt-kpi-label">Budget</div><div className="pdt-kpi-val">{fmt(project.actual_cost)}<span className="pdt-kpi-pct"> / {fmt(project.budget_amount)}</span></div></div></div>
        <div className="pdt-kpi"><Flag size={15} color="#6B3FDB" /><div><div className="pdt-kpi-label">Milestones</div><div className="pdt-kpi-val">{milestones.filter(m => m.status === 'completed').length}/{milestones.length}</div></div></div>
        <div className="pdt-kpi"><AlertTriangle size={15} color="#dc2626" /><div><div className="pdt-kpi-label">Open Risks</div><div className="pdt-kpi-val">{risks.filter(r => r.status === 'open').length}</div></div></div>
        <div className="pdt-kpi"><Users size={15} color="#8b5cf6" /><div><div className="pdt-kpi-label">Team</div><div className="pdt-kpi-val">{project.team_size || team.length}</div></div></div>
      </div>

      {/* PROGRESS BARS */}
      <div className="pdt-progress-row">
        <div className="pdt-progress-item">
          <div className="pdt-prog-hd"><span>Task Progress</span><span>{taskPct}%</span></div>
          <div className="pdt-prog-track"><div className="pdt-prog-bar" style={{ width: `${taskPct}%`, background: '#6366f1' }} /></div>
        </div>
        <div className="pdt-progress-item">
          <div className="pdt-prog-hd"><span>Budget Used</span><span style={{ color: budPct > 85 ? '#ef4444' : 'inherit' }}>{budPct}%</span></div>
          <div className="pdt-prog-track"><div className="pdt-prog-bar" style={{ width: `${budPct}%`, background: budPct > 85 ? '#ef4444' : '#10b981' }} /></div>
        </div>
      </div>

      {/* TABS */}
      <div className="pdt-tabs">
        {TABS.map(tab => (
          <button key={tab.id} className={`pdt-tab${activeTab === tab.id ? ' pdt-tab-active' : ''}`} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
            {tab.id === 'issues' && issues.filter(i => i.status !== 'resolved' && i.status !== 'closed').length > 0 && (
              <span style={{ marginLeft: 4, padding: '0 5px', borderRadius: 8, fontSize: 10, fontWeight: 700, background: '#fee2e2', color: '#dc2626' }}>
                {issues.filter(i => i.status !== 'resolved' && i.status !== 'closed').length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ══ TASKS TAB ══ */}
      {activeTab === 'tasks' && (
        <div className="pdt-kanban">
          {TASK_COLS.map(col => (
            <div key={col.key} className="pdt-col">
              <div className="pdt-col-hd">
                <span className="pdt-col-label" style={{ color: col.color }}>{col.label}</span>
                <span className="pdt-col-count" style={{ background: col.bg, color: col.color }}>{byCol[col.key]?.length || 0}</span>
              </div>
              <div className="pdt-col-body">
                {(byCol[col.key] || []).map(task => {
                  const pc = PRIORITY_COLORS[(task.priority || '').toLowerCase()] || PRIORITY_COLORS.low;
                  return (
                    <div key={task.id} className="pdt-task-card">
                      <div className="pdt-task-hd">
                        <span className="pdt-task-title">{task.task_title}</span>
                        <span className="pdt-priority-badge" style={{ background: pc.bg, color: pc.color }}>{task.priority || 'low'}</span>
                      </div>
                      {task.assignee_name && <div className="pdt-task-meta"><Users size={10} /> {task.assignee_name}</div>}
                      {task.due_date && <div className="pdt-task-meta"><Clock size={10} /> {new Date(task.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</div>}
                      <div className="pdt-task-actions">
                        {TASK_COLS.filter(c => c.key !== col.key).slice(0, 2).map(nc => (
                          <button key={nc.key} className="pdt-move-btn" style={{ color: nc.color }} onClick={() => updateTaskStatus(task.id, nc.key)}>→ {nc.label}</button>
                        ))}
                        <button onClick={() => { setTaskForm({ task_title: task.task_title, description: task.description || '', priority: task.priority || 'medium', status: task.status, due_date: task.due_date ? task.due_date.split('T')[0] : '', assignee_name: task.assignee_name || '' }); setEditTaskId(task.id); setTaskDrawer(true); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#9ca3af' }}><Edit3 size={11} /></button>
                        <button onClick={() => setPendingDeleteTask(task.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#fca5a5' }}><Trash2 size={11} /></button>
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

      {/* ══ MILESTONES TAB ══ */}
      {activeTab === 'milestones' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button onClick={() => { setMileForm(emptyMile()); setEditMileId(null); setMileDrawer(true); }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
              <Plus size={13} /> Add Milestone
            </button>
          </div>
          {milestones.length === 0 ? <EmptyState icon={Flag} title="No milestones" sub="Add payment milestones to track project billing" /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {milestones.map(m => {
                const done = m.status === 'completed';
                return (
                  <div key={m.id} style={{ background: 'var(--color-background-secondary)', border: `1px solid ${done ? '#bbf7d0' : 'var(--color-border-tertiary)'}`, borderRadius: 10, padding: '14px 16px', borderLeft: `4px solid ${done ? '#15803d' : m.billing_milestone ? '#6B3FDB' : '#6b7280'}`, opacity: done ? 0.85 : 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</span>
                          {done && <span style={{ padding: '2px 7px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: '#dcfce7', color: '#15803d' }}>✓ Completed</span>}
                          {m.billing_milestone && !done && <span style={{ padding: '2px 7px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: '#f5f3ff', color: '#6B3FDB' }}>Billing</span>}
                          {m.invoice_id && <span style={{ padding: '2px 7px', borderRadius: 12, fontSize: 11, background: '#f0fdf4', color: '#15803d', fontWeight: 600 }}>Invoice ✓</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#9ca3af' }}>
                          {m.due_date && <span>Due: <b style={{ color: 'var(--color-text-secondary)' }}>{new Date(m.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</b></span>}
                          {m.amount > 0 && <span>Amount: <b style={{ color: '#0369a1' }}>{fmt(m.amount)}</b></span>}
                        </div>
                        {m.description && <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0' }}>{m.description}</p>}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 12 }}>
                        {!done && (
                          <button onClick={() => setPendingCompleteMile(m)} disabled={completing === m.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#15803d', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                            <Check size={12} /> {completing === m.id ? 'Completing…' : 'Complete'}
                          </button>
                        )}
                        <button onClick={() => { setMileForm({ name: m.name, description: m.description || '', due_date: m.due_date ? m.due_date.split('T')[0] : '', amount: m.amount || 0, billing_milestone: m.billing_milestone || false }); setEditMileId(m.id); setMileDrawer(true); }} style={{ padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}><Edit3 size={12} /></button>
                        <button onClick={() => setPendingDeleteMile(m.id)} style={{ padding: '6px 10px', border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', borderRadius: 6, cursor: 'pointer' }}><Trash2 size={12} /></button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ══ RISKS TAB ══ */}
      {activeTab === 'risks' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button onClick={() => { setRiskForm(emptyRisk()); setEditRiskId(null); setRiskDrawer(true); }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
              <Plus size={13} /> Register Risk
            </button>
          </div>
          {risks.length === 0 ? <EmptyState icon={AlertTriangle} title="No risks registered" sub="Register project risks and mitigation plans" /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {risks.map(r => {
                const score = r.risk_score || (r.probability * r.impact);
                const level = riskLevel(score);
                const rc = RISK_COLORS[level];
                return (
                  <div key={r.id} style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 10, padding: '14px 16px', borderLeft: `4px solid ${rc}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                          <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#9ca3af' }}>{r.risk_code}</span>
                          <span style={{ padding: '2px 7px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: rc + '22', color: rc }}>{level.toUpperCase()} — Score: {score}</span>
                          <span style={{ padding: '2px 7px', borderRadius: 12, fontSize: 11, background: '#f3f4f6', color: '#6b7280' }}>{r.category}</span>
                          <span style={{ padding: '2px 7px', borderRadius: 12, fontSize: 11, background: r.status === 'open' ? '#fef3c7' : '#f0fdf4', color: r.status === 'open' ? '#92400e' : '#15803d', fontWeight: 600 }}>{r.status}</span>
                        </div>
                        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{r.description}</div>
                        {r.contingency_plan && <div style={{ fontSize: 12, color: '#6b7280' }}>Mitigation: {r.contingency_plan}</div>}
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>P: {r.probability} × I: {r.impact} = {score}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 12 }}>
                        <button onClick={() => { setRiskForm({ description: r.description, category: r.category || 'technical', probability: r.probability || 2, impact: r.impact || 2, contingency_plan: r.contingency_plan || '', status: r.status || 'open' }); setEditRiskId(r.id); setRiskDrawer(true); }} style={{ padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}><Edit3 size={12} /></button>
                        <button onClick={() => setPendingDeleteRisk(r.id)} style={{ padding: '6px 10px', border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', borderRadius: 6, cursor: 'pointer' }}><Trash2 size={12} /></button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ══ ISSUES TAB ══ */}
      {activeTab === 'issues' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              {[
                { label: 'Total', val: issues.length, color: '#6366f1' },
                { label: 'Open', val: issues.filter(i => i.status === 'open').length, color: '#dc2626' },
                { label: 'Blockers', val: issues.filter(i => i.is_blocker).length, color: '#6B3FDB' },
              ].map(k => (
                <div key={k.label} style={{ padding: '6px 12px', borderRadius: 6, background: k.color + '14', color: k.color, fontSize: 12, fontWeight: 600 }}>
                  {k.val} {k.label}
                </div>
              ))}
            </div>
            <button onClick={() => { sessionStorage.setItem('selectedProjectId', pid); setPage?.('IssueManagement', { id: pid }); }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              <Plus size={13} /> Manage Issues
            </button>
          </div>
          {issues.length === 0 ? <EmptyState icon={AlertTriangle} title="No issues logged" sub="Log issues, NCRs, and blockers" /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {issues.slice(0, 10).map(i => {
                const svrColor = i.severity === 'critical' ? '#dc2626' : i.severity === 'high' ? '#ea580c' : i.severity === 'medium' ? '#ca8a04' : '#6b7280';
                return (
                  <div key={i.id} style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '12px 16px', borderLeft: `4px solid ${svrColor}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                        <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#9ca3af' }}>{i.issue_code}</span>
                        <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 700, background: svrColor + '20', color: svrColor }}>{i.severity}</span>
                        {i.is_blocker && <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 700, background: '#ffd4d4', color: '#b91c1c' }}>BLOCKER</span>}
                        <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#f3f4f6', color: '#6b7280' }}>{i.status}</span>
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{i.title}</div>
                    </div>
                  </div>
                );
              })}
              {issues.length > 10 && <div style={{ textAlign: 'center', fontSize: 12, color: '#6b7280', padding: 8 }}>+{issues.length - 10} more — open Issue Management for full view</div>}
            </div>
          )}
        </div>
      )}

      {/* ══ FAT/SAT TAB ══ */}
      {activeTab === 'fat_sat' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* FAT */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Factory Acceptance Tests (FAT)</div>
              <button onClick={() => { sessionStorage.setItem('selectedProjectId', pid); setPage?.('FATTracker', { id: pid }); }} style={{ padding: '6px 12px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Manage FATs</button>
            </div>
            {fats.length === 0 ? <EmptyState icon={Shield} title="No FAT records" sub="Factory acceptance tests not yet conducted" /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {fats.map(f => (
                  <div key={f.id} style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '12px 14px', borderLeft: `4px solid ${f.status === 'passed' ? '#15803d' : f.status === 'failed' ? '#dc2626' : '#6b7280'}` }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 3 }}>{f.fat_number} — {f.product_name || 'FAT'}</div>
                    <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#6b7280' }}>
                      {f.fat_date && <span>{new Date(f.fat_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>}
                      <span style={{ color: f.status === 'passed' ? '#15803d' : f.status === 'failed' ? '#dc2626' : '#6b7280', fontWeight: 600 }}>{f.status?.toUpperCase()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* SAT */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Site Acceptance Tests (SAT)</div>
              <button onClick={() => { sessionStorage.setItem('selectedProjectId', pid); setPage?.('SATTracker', { id: pid }); }} style={{ padding: '6px 12px', background: '#0d9488', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Manage SATs</button>
            </div>
            {sats.length === 0 ? <EmptyState icon={Target} title="No SAT records" sub="Site acceptance tests not yet conducted" /> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sats.map(s => (
                  <div key={s.id} style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '12px 14px', borderLeft: `4px solid ${s.status === 'passed' ? '#15803d' : s.status === 'failed' ? '#dc2626' : '#6b7280'}` }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 3 }}>{s.sat_number} — {s.site_name || 'SAT'}</div>
                    <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#6b7280' }}>
                      {s.sat_date && <span>{new Date(s.sat_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>}
                      <span style={{ color: s.status === 'passed' ? '#15803d' : s.status === 'failed' ? '#dc2626' : '#6b7280', fontWeight: 600 }}>{s.status?.toUpperCase()}</span>
                      {s.client_signed_off && <span style={{ color: '#15803d', fontWeight: 600 }}>Client Signed ✓</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ DOCUMENTS TAB ══ */}
      {activeTab === 'documents' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="pdt-btn-primary" onClick={() => { setDocForm(emptyDoc()); setDocDrawer(true); }}>
              <Plus size={14} /> Add Document
            </button>
          </div>
          {documents.length === 0 ? <EmptyState icon={FileText} title="No documents" sub="Upload project documents, drawings, and certificates" /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {documents.map(d => (
                <div key={d.id} style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{d.document_name || d.file_url?.split('/').pop()}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{d.document_type} {d.revision ? `Rev: ${d.revision}` : ''}</div>
                  </div>
                  {d.file_url && <a href={d.file_url} target="_blank" rel="noreferrer" style={{ padding: '6px 12px', border: '1px solid var(--color-border)', borderRadius: 6, textDecoration: 'none', color: 'var(--color-text-primary)', fontSize: 12 }}>Download</a>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══ TEAM TAB ══ */}
      {activeTab === 'team' && (
        <div className="pdt-team-grid">
          {team.length === 0 && <EmptyState icon={Users} title="No team members" sub="Assign team members via Resource Management" />}
          {team.map((m, i) => (
            <div key={m.id || i} className="pdt-member-card">
              <div className="pdt-member-avatar" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] + '20', color: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                {m.avatar || (m.name || m.employee_name || 'U').charAt(0)}
              </div>
              <div>
                <div className="pdt-member-name">{m.name || m.employee_name}</div>
                <div className="pdt-member-role">{m.role}</div>
                {m.billing_rate > 0 && <div style={{ fontSize: 11, color: '#9ca3af' }}>₹{m.billing_rate}/hr</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ══ TASK DRAWER ══ */}
      {taskDrawer && (
        <div className="pdt-overlay" onClick={() => setTaskDrawer(false)}>
          <div className="pdt-drawer" onClick={e => e.stopPropagation()}>
            <div className="pdt-drawer-hd">
              <h3>{editTaskId ? 'Edit Task' : 'Add Task'}</h3>
              <button className="pdt-icon-btn" onClick={() => setTaskDrawer(false)}><X size={16} /></button>
            </div>
            <div className="pdt-drawer-body">
              <div className="pdt-field"><label>Task Title *</label><input value={taskForm.task_title} onChange={e => setTaskForm(f => ({ ...f, task_title: e.target.value }))} placeholder="What needs to be done…" /></div>
              <div className="pdt-field"><label>Description</label><textarea rows={3} value={taskForm.description} onChange={e => setTaskForm(f => ({ ...f, description: e.target.value }))} /></div>
              <div className="pdt-row2">
                <div className="pdt-field"><label>Priority</label><select value={taskForm.priority} onChange={e => setTaskForm(f => ({ ...f, priority: e.target.value }))}><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div>
                <div className="pdt-field"><label>Status</label><select value={taskForm.status} onChange={e => setTaskForm(f => ({ ...f, status: e.target.value }))}>{TASK_COLS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</select></div>
              </div>
              <div className="pdt-row2">
                <div className="pdt-field"><label>Due Date</label><input type="date" value={taskForm.due_date} onChange={e => setTaskForm(f => ({ ...f, due_date: e.target.value }))} /></div>
                <div className="pdt-field"><label>Assignee</label><input value={taskForm.assignee_name} onChange={e => setTaskForm(f => ({ ...f, assignee_name: e.target.value }))} placeholder="Name…" /></div>
              </div>
            </div>
            <div className="pdt-drawer-ft">
              <button className="pdt-btn-outline" onClick={() => setTaskDrawer(false)}>Cancel</button>
              <button className="pdt-btn-primary" onClick={handleSaveTask} disabled={submitting}>{submitting ? 'Saving…' : editTaskId ? 'Update Task' : 'Add Task'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ══ MILESTONE DRAWER ══ */}
      {mileDrawer && (
        <div className="pdt-overlay" onClick={() => setMileDrawer(false)}>
          <div className="pdt-drawer" onClick={e => e.stopPropagation()}>
            <div className="pdt-drawer-hd">
              <h3>{editMileId ? 'Edit Milestone' : 'Add Milestone'}</h3>
              <button className="pdt-icon-btn" onClick={() => setMileDrawer(false)}><X size={16} /></button>
            </div>
            <div className="pdt-drawer-body">
              <div className="pdt-field"><label>Milestone Name *</label><input value={mileForm.name} onChange={e => setMileForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Design Approval, FAT Completion…" /></div>
              <div className="pdt-field"><label>Description</label><textarea rows={2} value={mileForm.description} onChange={e => setMileForm(f => ({ ...f, description: e.target.value }))} /></div>
              <div className="pdt-row2">
                <div className="pdt-field"><label>Due Date</label><input type="date" value={mileForm.due_date} onChange={e => setMileForm(f => ({ ...f, due_date: e.target.value }))} /></div>
                <div className="pdt-field"><label>Amount (₹)</label><input type="number" value={mileForm.amount} onChange={e => setMileForm(f => ({ ...f, amount: e.target.value }))} /></div>
              </div>
              <div className="pdt-field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={mileForm.billing_milestone} onChange={e => setMileForm(f => ({ ...f, billing_milestone: e.target.checked }))} />
                  <span>Billing Milestone (auto-create invoice on completion)</span>
                </label>
              </div>
            </div>
            <div className="pdt-drawer-ft">
              <button className="pdt-btn-outline" onClick={() => setMileDrawer(false)}>Cancel</button>
              <button className="pdt-btn-primary" onClick={handleSaveMilestone} disabled={submitting}>{submitting ? 'Saving…' : editMileId ? 'Update' : 'Add Milestone'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ══ RISK DRAWER ══ */}
      {riskDrawer && (
        <div className="pdt-overlay" onClick={() => setRiskDrawer(false)}>
          <div className="pdt-drawer" onClick={e => e.stopPropagation()}>
            <div className="pdt-drawer-hd">
              <h3>{editRiskId ? 'Edit Risk' : 'Register Risk'}</h3>
              <button className="pdt-icon-btn" onClick={() => setRiskDrawer(false)}><X size={16} /></button>
            </div>
            <div className="pdt-drawer-body">
              <div className="pdt-field"><label>Risk Description *</label><textarea rows={2} value={riskForm.description} onChange={e => setRiskForm(f => ({ ...f, description: e.target.value }))} placeholder="Describe the risk…" /></div>
              <div className="pdt-row2">
                <div className="pdt-field"><label>Category</label><select value={riskForm.category} onChange={e => setRiskForm(f => ({ ...f, category: e.target.value }))}><option value="technical">Technical</option><option value="financial">Financial</option><option value="schedule">Schedule</option><option value="resource">Resource</option><option value="regulatory">Regulatory</option><option value="safety">Safety</option></select></div>
                <div className="pdt-field"><label>Status</label><select value={riskForm.status} onChange={e => setRiskForm(f => ({ ...f, status: e.target.value }))}><option value="open">Open</option><option value="mitigated">Mitigated</option><option value="closed">Closed</option></select></div>
              </div>
              <div className="pdt-row2">
                <div className="pdt-field"><label>Probability (1-5)</label><input type="number" min={1} max={5} value={riskForm.probability} onChange={e => setRiskForm(f => ({ ...f, probability: e.target.value }))} /></div>
                <div className="pdt-field"><label>Impact (1-5)</label><input type="number" min={1} max={5} value={riskForm.impact} onChange={e => setRiskForm(f => ({ ...f, impact: e.target.value }))} /></div>
              </div>
              <div style={{ padding: '8px 12px', background: '#fef9c3', borderRadius: 6, fontSize: 13, color: '#92400e', marginBottom: 12 }}>
                Risk Score: <b>{(riskForm.probability || 0) * (riskForm.impact || 0)}</b> — Level: <b>{riskLevel((riskForm.probability || 0) * (riskForm.impact || 0)).toUpperCase()}</b>
              </div>
              <div className="pdt-field"><label>Contingency / Mitigation Plan</label><textarea rows={3} value={riskForm.contingency_plan} onChange={e => setRiskForm(f => ({ ...f, contingency_plan: e.target.value }))} placeholder="How will this risk be mitigated…" /></div>
            </div>
            <div className="pdt-drawer-ft">
              <button className="pdt-btn-outline" onClick={() => setRiskDrawer(false)}>Cancel</button>
              <button className="pdt-btn-primary" onClick={handleSaveRisk} disabled={submitting}>{submitting ? 'Saving…' : editRiskId ? 'Update Risk' : 'Register Risk'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ══ DOCUMENT DRAWER ══ */}
      {docDrawer && (
        <div className="pdt-overlay" onClick={() => setDocDrawer(false)}>
          <div className="pdt-drawer" onClick={e => e.stopPropagation()}>
            <div className="pdt-drawer-hd">
              <h3>Add Document</h3>
              <button className="pdt-icon-btn" onClick={() => setDocDrawer(false)}><X size={16} /></button>
            </div>
            <div className="pdt-drawer-body">
              <div className="pdt-field"><label>Document Name *</label><input value={docForm.document_name} onChange={e => setDocForm(f => ({ ...f, document_name: e.target.value }))} placeholder="e.g. GA Drawing Rev A…" /></div>
              <div className="pdt-row2">
                <div className="pdt-field"><label>Document Type</label><select value={docForm.document_type} onChange={e => setDocForm(f => ({ ...f, document_type: e.target.value }))}>{DOCUMENT_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1).replace('_', ' ')}</option>)}</select></div>
                <div className="pdt-field"><label>Revision</label><input value={docForm.revision} onChange={e => setDocForm(f => ({ ...f, revision: e.target.value }))} placeholder="e.g. A, 01…" /></div>
              </div>
              <div className="pdt-field"><label>File URL / Link</label><input value={docForm.file_url} onChange={e => setDocForm(f => ({ ...f, file_url: e.target.value }))} placeholder="https://… (link to the stored file)" /></div>
              <div className="pdt-field"><label>Description</label><textarea rows={2} value={docForm.description} onChange={e => setDocForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional notes…" /></div>
            </div>
            <div className="pdt-drawer-ft">
              <button className="pdt-btn-outline" onClick={() => setDocDrawer(false)}>Cancel</button>
              <button className="pdt-btn-primary" onClick={handleSaveDoc} disabled={submitting}>{submitting ? 'Saving…' : 'Add Document'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
