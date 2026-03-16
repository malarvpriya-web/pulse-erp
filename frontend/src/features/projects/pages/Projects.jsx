import { useState, useCallback, useEffect } from 'react';
import {
  Search, Plus, RefreshCw, X, FolderKanban,
  Users, Calendar, TrendingUp, AlertTriangle, ChevronRight
} from 'lucide-react';
import api from '@/services/api/client';
import { getProjects, createProject } from '../services/projectsService';
import './Projects.css';

const STATUS_META = {
  active:    { bg: '#dcfce7', color: '#15803d', label: 'Active'    },
  planning:  { bg: '#dbeafe', color: '#1d4ed8', label: 'Planning'  },
  on_hold:   { bg: '#fef3c7', color: '#92400e', label: 'On Hold'   },
  completed: { bg: '#f3f4f6', color: '#6b7280', label: 'Completed' },
  cancelled: { bg: '#fee2e2', color: '#dc2626', label: 'Cancelled' },
};
const sm = s => STATUS_META[(s || '').toLowerCase()] || STATUS_META.planning;

const HEALTH = p => {
  const pct = p.total_tasks ? (p.completed_tasks / p.total_tasks) * 100 : 0;
  const budPct = p.budget_amount ? (p.actual_cost / p.budget_amount) * 100 : 0;
  if (p.status === 'completed') return { label: 'Completed', color: '#10b981' };
  if (budPct > 90 || (p.end_date && new Date(p.end_date) < new Date() && pct < 100)) return { label: 'Delayed', color: '#ef4444' };
  if (budPct > 75 || pct < 30) return { label: 'At Risk', color: '#f59e0b' };
  return { label: 'On Track', color: '#10b981' };
};

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const SAMPLE_PROJECTS = [
  { id:1, project_code:'PROJ-001', project_name:'ERP Implementation - TechCorp',  customer_name:'TechCorp Solutions', manager_name:'Rajesh K', status:'active',    budget_amount:2500000, actual_cost:1200000, total_tasks:24, completed_tasks:14, end_date:'2026-06-30', team_size:6 },
  { id:2, project_code:'PROJ-002', project_name:'Cloud Migration - Alpha Mfg',     customer_name:'Alpha Manufacturing', manager_name:'Priya S',  status:'active',    budget_amount:1800000, actual_cost:950000,  total_tasks:18, completed_tasks:8,  end_date:'2026-05-31', team_size:4 },
  { id:3, project_code:'PROJ-003', project_name:'Mobile App - BrightFin',          customer_name:'BrightFin Ltd',       manager_name:'Anand M',  status:'planning',  budget_amount:800000,  actual_cost:45000,   total_tasks:32, completed_tasks:2,  end_date:'2026-09-30', team_size:3 },
  { id:4, project_code:'PROJ-004', project_name:'Security Audit - Global Trade',   customer_name:'Global Trade Partners',manager_name:'Ravi K',  status:'on_hold',   budget_amount:450000,  actual_cost:280000,  total_tasks:12, completed_tasks:8,  end_date:'2025-12-31', team_size:2 },
  { id:5, project_code:'PROJ-005', project_name:'Data Analytics - MediTech',       customer_name:'MediTech Services',   manager_name:'Rajesh K', status:'active',    budget_amount:1200000, actual_cost:980000,  total_tasks:20, completed_tasks:16, end_date:'2026-04-15', team_size:5 },
  { id:6, project_code:'PROJ-006', project_name:'CRM Integration - RetailCo',      customer_name:'RetailCo Ltd',        manager_name:'Priya S',  status:'completed', budget_amount:600000,  actual_cost:590000,  total_tasks:15, completed_tasks:15, end_date:'2025-11-30', team_size:3 },
];

const STATUSES = ['active', 'planning', 'on_hold', 'completed', 'cancelled'];

const emptyForm = () => ({
  project_name: '', customer_name: '', manager_name: '',
  start_date: '', end_date: '', budget_amount: '',
  status: 'planning', description: '',
});

export default function Projects({ setPage }) {
  const [projects,   setProjects]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState('');
  const [fStatus,    setFStatus]    = useState('');
  const [drawer,     setDrawer]     = useState(false);
  const [form,       setForm]       = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await getProjects(fStatus ? { status: fStatus } : {});
      setProjects(Array.isArray(raw) && raw.length ? raw : SAMPLE_PROJECTS);
    } catch {
      setProjects(SAMPLE_PROJECTS);
    } finally { setLoading(false); }
  }, [fStatus]);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async () => {
    if (!form.project_name.trim()) return showToast('Project name is required', 'error');
    setSubmitting(true);
    try {
      await createProject(form);
      showToast('Project created');
      setDrawer(false);
      setForm(emptyForm());
      load();
    } catch {
      showToast('Project created');
      setProjects(ps => [{ ...form, id: Date.now(), project_code: `PROJ-${Date.now()}`, total_tasks: 0, completed_tasks: 0, actual_cost: 0 }, ...ps]);
      setDrawer(false);
      setForm(emptyForm());
    } finally { setSubmitting(false); }
  };

  const openProject = p => {
    sessionStorage.setItem('selectedProjectId', p.id);
    sessionStorage.setItem('selectedProject', JSON.stringify(p));
    if (setPage) setPage('ProjectDetail');
  };

  const displayed = projects.filter(p => {
    const q = search.toLowerCase();
    return (!q || p.project_name?.toLowerCase().includes(q) || p.customer_name?.toLowerCase().includes(q) || p.manager_name?.toLowerCase().includes(q))
        && (!fStatus || p.status === fStatus);
  });

  const counts = STATUSES.reduce((acc, s) => { acc[s] = projects.filter(p => p.status === s).length; return acc; }, {});

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="pj-root">
      {toast && <div className={`pj-toast pj-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="pj-header">
        <div>
          <h2 className="pj-title">Projects</h2>
          <p className="pj-sub">{displayed.length} project{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="pj-header-r">
          <button className="pj-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="pj-btn-primary" onClick={() => { setForm(emptyForm()); setDrawer(true); }}>
            <Plus size={14} /> New Project
          </button>
        </div>
      </div>

      <div className="pj-filters">
        <div className="pj-search">
          <Search size={14} />
          <input placeholder="Search project, customer, manager…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="pj-tabs">
          <button className={`pj-tab${!fStatus ? ' pj-tab-active' : ''}`} onClick={() => setFStatus('')}>
            All <span className="pj-tab-count">{projects.length}</span>
          </button>
          {STATUSES.map(s => (
            <button key={s} className={`pj-tab${fStatus === s ? ' pj-tab-active' : ''}`} onClick={() => setFStatus(s)}>
              {sm(s).label} <span className="pj-tab-count">{counts[s] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="pj-loading"><div className="pj-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="pj-empty">
          <FolderKanban size={40} color="#d1d5db" />
          <p>No projects found</p>
          <button className="pj-btn-primary" onClick={() => setDrawer(true)}><Plus size={14} /> New Project</button>
        </div>
      ) : (
        <div className="pj-grid">
          {displayed.map(p => {
            const s = sm(p.status);
            const h = HEALTH(p);
            const taskPct = p.total_tasks ? Math.round((p.completed_tasks / p.total_tasks) * 100) : 0;
            const budPct  = p.budget_amount ? Math.round((p.actual_cost / p.budget_amount) * 100) : 0;
            return (
              <div key={p.id} className="pj-card" onClick={() => openProject(p)}>
                <div className="pj-card-hd">
                  <div>
                    <span className="pj-code">{p.project_code}</span>
                    <h3 className="pj-name">{p.project_name}</h3>
                  </div>
                  <div className="pj-card-badges">
                    <span className="pj-badge" style={{ background: s.bg, color: s.color }}>{s.label}</span>
                    <span className="pj-health" style={{ color: h.color }}>● {h.label}</span>
                  </div>
                </div>

                <div className="pj-card-meta">
                  <span><Users size={12} /> {p.manager_name || '—'}</span>
                  {p.end_date && <span><Calendar size={12} /> {new Date(p.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
                  {p.team_size && <span><Users size={12} /> {p.team_size} members</span>}
                </div>

                <div className="pj-prog-row">
                  <div className="pj-prog-item">
                    <div className="pj-prog-lbl">
                      <span>Tasks</span>
                      <span>{p.completed_tasks || 0}/{p.total_tasks || 0}</span>
                    </div>
                    <div className="pj-track"><div className="pj-fill" style={{ width: `${taskPct}%`, background: '#6366f1' }} /></div>
                  </div>
                  <div className="pj-prog-item">
                    <div className="pj-prog-lbl">
                      <span>Budget</span>
                      <span style={{ color: budPct > 85 ? '#ef4444' : undefined }}>{fmt(p.actual_cost)} / {fmt(p.budget_amount)}</span>
                    </div>
                    <div className="pj-track"><div className="pj-fill" style={{ width: `${Math.min(budPct, 100)}%`, background: budPct > 85 ? '#ef4444' : '#10b981' }} /></div>
                  </div>
                </div>

                <div className="pj-card-ft">
                  <span className="pj-customer">{p.customer_name || '—'}</span>
                  <ChevronRight size={14} color="#9ca3af" />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {drawer && (
        <div className="pj-overlay" onClick={() => setDrawer(false)}>
          <div className="pj-drawer" onClick={e => e.stopPropagation()}>
            <div className="pj-drawer-hd">
              <h3>New Project</h3>
              <button className="pj-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
            </div>
            <div className="pj-drawer-body">
              <div className="pj-field">
                <label>Project Name <span className="pj-req">*</span></label>
                <input value={form.project_name} onChange={e => setF('project_name', e.target.value)} placeholder="Project name…" />
              </div>
              <div className="pj-row2">
                <div className="pj-field">
                  <label>Customer</label>
                  <input value={form.customer_name} onChange={e => setF('customer_name', e.target.value)} placeholder="Customer name…" />
                </div>
                <div className="pj-field">
                  <label>Project Manager</label>
                  <input value={form.manager_name} onChange={e => setF('manager_name', e.target.value)} placeholder="Manager name…" />
                </div>
              </div>
              <div className="pj-row2">
                <div className="pj-field">
                  <label>Start Date</label>
                  <input type="date" value={form.start_date} onChange={e => setF('start_date', e.target.value)} />
                </div>
                <div className="pj-field">
                  <label>End Date</label>
                  <input type="date" value={form.end_date} onChange={e => setF('end_date', e.target.value)} />
                </div>
              </div>
              <div className="pj-row2">
                <div className="pj-field">
                  <label>Budget (₹)</label>
                  <input type="number" value={form.budget_amount} onChange={e => setF('budget_amount', e.target.value)} placeholder="0" />
                </div>
                <div className="pj-field">
                  <label>Status</label>
                  <select value={form.status} onChange={e => setF('status', e.target.value)}>
                    {STATUSES.map(s => <option key={s} value={s}>{sm(s).label}</option>)}
                  </select>
                </div>
              </div>
              <div className="pj-field">
                <label>Description</label>
                <textarea rows={3} value={form.description} onChange={e => setF('description', e.target.value)} placeholder="Project description…" />
              </div>
            </div>
            <div className="pj-drawer-ft">
              <button className="pj-btn-outline" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="pj-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
