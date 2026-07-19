import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import {
  FolderKanban, CheckSquare, AlertTriangle, TrendingUp,
  RefreshCw, Plus, Calendar, Users, ChevronRight, Clock
} from 'lucide-react';
import api from '@/services/api/client';
import { getProjects } from '../services/projectsService';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import './ProjectsDashboard.css';

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
const sm = s => STATUS_META[(s || '').toLowerCase()] || STATUS_META.planning;

const HEALTH_COLORS = {
  'On Track': '#10b981',
  'At Risk':  '#f59e0b',
  'Delayed':  '#ef4444',
};

function EmptyState({ icon: Icon, title, sub, action }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '48px 24px', textAlign: 'center', gap: 8,
      background: 'var(--color-background-secondary)',
      borderRadius: 'var(--border-radius-lg)',
      border: '0.5px solid var(--color-border-tertiary)',
    }}>
      {Icon && <Icon size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 4 }} />}
      <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>{title}</p>
      {sub && <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>{sub}</p>}
      {action}
    </div>
  );
}

const healthOf = p => {
  const today = new Date();
  const end = p.end_date ? new Date(p.end_date) : null;
  const pct = p.total_tasks ? Math.round((p.completed_tasks / p.total_tasks) * 100) : 0;
  const budgetPct = p.budget_amount ? Math.round((p.actual_cost / p.budget_amount) * 100) : 0;
  if (p.status === 'completed') return 'On Track';
  if (end && end < today && pct < 100) return 'Delayed';
  if (budgetPct > 85 || pct < 30) return 'At Risk';
  return 'On Track';
};

const KPI = ({ icon: Icon, label, value, sub, color, alert }) => (
  <div className={`pd-kpi${alert ? ' pd-kpi-alert' : ''}`} style={{ '--c': color }}>
    <div className="pd-kpi-icon"><Icon size={19} /></div>
    <div>
      <p className="pd-kpi-label">{label}</p>
      <h3 className="pd-kpi-val">{value}</h3>
      {sub && <p className="pd-kpi-sub">{sub}</p>}
    </div>
  </div>
);

export default function ProjectsDashboard({ setPage }) {
  const [projects,   setProjects]   = useState([]);
  const [tasksToday, setTasksToday] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [toast,      setToast]      = useState(null);

  const _showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [projRes, tasksRes] = await Promise.allSettled([
        getProjects(),
        api.get('/tasks/today'),
      ]);
      const rawProj  = projRes.status === 'fulfilled'  ? projRes.value  : null;
      const rawTasks = tasksRes.status === 'fulfilled' ? (tasksRes.value.data?.data || tasksRes.value.data || []) : [];
      setProjects(Array.isArray(rawProj) ? rawProj : []);
      setTasksToday(Array.isArray(rawTasks) ? rawTasks : []);
    } catch {
      setProjects([]);
      setTasksToday([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openProject = p => {
    sessionStorage.setItem('selectedProjectId', p.id);
    sessionStorage.setItem('selectedProject', JSON.stringify(p));
    if (setPage) setPage('ProjectDetail');
  };


  const active     = projects.filter(p => p.status === 'active');
  const totalTasks = projects.reduce((s, p) => s + (parseInt(p.total_tasks) || 0), 0);
  const overdue    = projects.filter(p => {
    const end = p.end_date ? new Date(p.end_date) : null;
    const pct = p.total_tasks ? (p.completed_tasks / p.total_tasks) : 1;
    return end && end < new Date() && pct < 1 && p.status !== 'completed';
  }).length;
  const totalBudget = projects.reduce((s, p) => s + parseFloat(p.budget_amount || 0), 0);
  const totalActual = projects.reduce((s, p) => s + parseFloat(p.actual_cost || 0), 0);
  const budgetUtil  = totalBudget ? Math.round((totalActual / totalBudget) * 100) : 0;

  const healthCounts = { 'On Track': 0, 'At Risk': 0, 'Delayed': 0 };
  projects.filter(p => p.status === 'active').forEach(p => { healthCounts[healthOf(p)]++; });
  const healthData = Object.entries(healthCounts).map(([name, count]) => ({ name, count }));

  const healthChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={healthData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="count" name="Projects" radius={[4, 4, 0, 0]}>
          {healthData.map((d, i) => <Cell key={i} fill={HEALTH_COLORS[d.name]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  return (
    <div className="pd-root">

      {toast && <div className={`pd-toast pd-toast-${toast.type}`}>{toast.msg}</div>}

      {/* header */}
      <div className="pd-header">
        <div>
          <h2 className="pd-title">Projects Dashboard</h2>
          <p className="pd-sub">{active.length} active · {projects.length} total projects</p>
        </div>
        <div className="pd-header-r">
          <button className="pd-btn-outline" onClick={() => setPage && setPage('Projects')}>
            All Projects <ChevronRight size={13} />
          </button>
          <button className="pd-btn-primary" onClick={() => setPage && setPage('Projects')}>
            <Plus size={14} /> New Project
          </button>
          <button className="pd-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button
            onClick={() => setPage && setPage('ProjectSettings')}
            style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', color: '#6b7280', fontSize: 13, fontWeight: 500 }}
            title="Project Settings"
          >
            ⚙ Settings
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="pd-kpis">
        <KPI icon={FolderKanban} label="Active Projects"    value={active.length}      color="#6366f1" sub="Currently running" />
        <KPI icon={CheckSquare}  label="Total Tasks"        value={totalTasks}         color="#3b82f6" sub="Across all projects" />
        <KPI icon={AlertTriangle}label="Overdue Projects"   value={overdue}            color="#ef4444" alert={overdue > 0} sub="Past due date" />
        <KPI icon={TrendingUp}   label="Budget Utilization" value={`${budgetUtil}%`}   color={budgetUtil > 85 ? '#ef4444' : '#10b981'} alert={budgetUtil > 85} sub={`${fmt(totalActual)} of ${fmt(totalBudget)}`} />
      </div>

      {/* main grid */}
      <div className="pd-grid">

        {/* project cards */}
        <div className="pd-section pd-fc8">
          <div className="pd-section-hd">
            <span className="pd-section-title">Projects</span>
            <button className="pd-text-btn" onClick={() => setPage && setPage('Projects')}>
              View All <ChevronRight size={12} />
            </button>
          </div>
          <div className="pd-cards-grid">
            {projects.filter(p => p.status !== 'completed' && p.status !== 'cancelled').length === 0 && !loading ? (
              <EmptyState icon={FolderKanban} title="No projects yet" sub="Create your first project to get started" />
            ) : null}
            {projects.filter(p => p.status !== 'completed' && p.status !== 'cancelled').map(p => {
              const s = sm(p.status);
              const pct = p.total_tasks ? Math.round((p.completed_tasks / p.total_tasks) * 100) : 0;
              const budPct = p.budget_amount ? Math.min(100, Math.round((p.actual_cost / p.budget_amount) * 100)) : 0;
              const h = healthOf(p);
              return (
                <div key={p.id} className="pd-card" onClick={() => openProject(p)}>
                  <div className="pd-card-hd">
                    <div>
                      <span className="pd-card-code">{p.project_code}</span>
                      <h4 className="pd-card-name">{p.project_name}</h4>
                    </div>
                    <span className="pd-badge" style={{ background: s.bg, color: s.color }}>{s.label}</span>
                  </div>
                  <div className="pd-card-meta">
                    {p.customer_name && <span><FolderKanban size={11} />{p.customer_name}</span>}
                    {p.manager_name  && <span><Users size={11} />{p.manager_name}</span>}
                    {p.end_date      && <span><Calendar size={11} />{new Date(p.end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>}
                  </div>
                  {/* task progress */}
                  <div className="pd-card-progress">
                    <div className="pd-prog-hd">
                      <span>Tasks</span>
                      <span>{p.completed_tasks || 0}/{p.total_tasks || 0} · {pct}%</span>
                    </div>
                    <div className="pd-prog-track">
                      <div className="pd-prog-bar" style={{ width: `${pct}%`, background: '#6366f1' }} />
                    </div>
                  </div>
                  {/* budget progress */}
                  <div className="pd-card-progress" style={{ marginTop: 6 }}>
                    <div className="pd-prog-hd">
                      <span>Budget</span>
                      <span>{fmt(p.actual_cost)} / {fmt(p.budget_amount)} · {budPct}%</span>
                    </div>
                    <div className="pd-prog-track">
                      <div className="pd-prog-bar" style={{ width: `${budPct}%`, background: budPct > 85 ? '#ef4444' : '#10b981' }} />
                    </div>
                  </div>
                  <div className="pd-card-footer">
                    <span className="pd-health-dot" style={{ background: HEALTH_COLORS[h] }} />
                    <span className="pd-health-label" style={{ color: HEALTH_COLORS[h] }}>{h}</span>
                    {p.team_size && <span className="pd-team-size"><Users size={11} />{p.team_size}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* right column */}
        <div className="pd-fc4 pd-right-col">

          {/* project health */}
          <div className="pd-card-box">
            <div className="pd-box-hd">
              <span className="pd-section-title">Project Health</span>
              <ChartExpandButton title="Project Health" subtitle="Active projects by health status">
                {healthChart(420)}
              </ChartExpandButton>
            </div>
            <div className="pd-box-body">
              {healthChart(130)}
              <div className="pd-health-legend">
                {healthData.map(d => (
                  <div key={d.name} className="pd-health-row">
                    <span className="pd-health-dot" style={{ background: HEALTH_COLORS[d.name] }} />
                    <span className="pd-health-name">{d.name}</span>
                    <span className="pd-health-count">{d.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* my tasks today */}
          <div className="pd-card-box">
            <div className="pd-box-hd">
              <span className="pd-section-title"><Clock size={13} style={{ marginRight: 5, verticalAlign: 'middle' }} />My Tasks Today</span>
              <button className="pd-text-btn" onClick={() => setPage && setPage('KanbanBoard')}>
                Board <ChevronRight size={12} />
              </button>
            </div>
            <div className="pd-box-body pd-tasks-list">
              {tasksToday.length === 0 ? (
                <p className="pd-empty-msg">No tasks due today 🎉</p>
              ) : tasksToday.map((t, i) => (
                <div key={t.id || i} className="pd-task-row">
                  <div className={`pd-task-dot ${t.status}`} />
                  <div className="pd-task-info">
                    <span className="pd-task-title">{t.task_title}</span>
                    <span className="pd-task-proj">{t.project_name}</span>
                  </div>
                  <span className="pd-priority-badge" style={{
                    background: t.priority === 'High' ? '#fee2e2' : t.priority === 'Medium' ? '#fef3c7' : '#f3f4f6',
                    color:      t.priority === 'High' ? '#dc2626' : t.priority === 'Medium' ? '#92400e' : '#6b7280',
                  }}>{t.priority}</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
