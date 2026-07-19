// ProjectWorkflowTracker.jsx
import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { CheckCircle, Clock, AlertTriangle, Circle, FolderKanban, RefreshCw, Search, User, Calendar, TrendingUp } from 'lucide-react';
import './ProjectWorkflowTracker.css';

const STATUS_CONFIG = {
  'On Track':  { color: '#15803d', bg: '#dcfce7', icon: CheckCircle },
  'At Risk':   { color: '#92400e', bg: '#fef3c7', icon: AlertTriangle },
  'Delayed':   { color: '#b91c1c', bg: '#fee2e2', icon: AlertTriangle },
  'Completed': { color: '#4338ca', bg: '#e0e7ff', icon: CheckCircle },
  'Planning':  { color: '#6b7280', bg: '#f3f4f6', icon: Circle },
};

const PROGRESS_COLOR = (pct) => {
  if (pct >= 80) return '#15803d';
  if (pct >= 50) return '#4f46e5';
  if (pct >= 25) return '#f59e0b';
  return '#ef4444';
};

const fmtDate = (d) => {
  if (!d) return '—';
  try { return new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }); } catch { return d; }
};

export default function ProjectWorkflowTracker() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    Promise.allSettled([
      api.get('/operations/project-tracker'),
      api.get('/projects/projects', { params: { limit: 50 } }),
    ]).then(([opRes, prRes]) => {
      const opData = opRes.status === 'fulfilled' ? (Array.isArray(opRes.value?.data) ? opRes.value.data : []) : [];
      const prData = prRes.status === 'fulfilled' ? (Array.isArray(prRes.value?.data) ? prRes.value.data : []) : [];
      setProjects(opData.length > 0 ? opData : prData);
    }).finally(() => { setLoading(false); setRefreshing(false); });
  };

  useEffect(() => { fetchData(); }, []);

  const filtered = projects.filter(p => {
    const name = (p.name || p.project_name || '').toLowerCase();
    const manager = (p.project_manager || p.manager_name || '').toLowerCase();
    const q = search.toLowerCase();
    const matchSearch = !q || name.includes(q) || manager.includes(q);
    const matchStatus = !filterStatus || (p.status || 'Planning') === filterStatus;
    return matchSearch && matchStatus;
  });

  const kpis = {
    total: projects.length,
    onTrack: projects.filter(p => p.status === 'On Track').length,
    atRisk: projects.filter(p => p.status === 'At Risk' || p.status === 'Delayed').length,
    completed: projects.filter(p => p.status === 'Completed').length,
    avgProgress: projects.length ? Math.round(projects.reduce((s, p) => s + Number(p.progress || p.completion_percentage || 0), 0) / projects.length) : 0,
  };

  return (
    <div className="pwt-root">

      {/* ── Header ── */}
      <div className="pwt-header">
        <div className="pwt-header-l">
          <div className="pwt-header-icon"><FolderKanban size={18} /></div>
          <div>
            <h1 className="pwt-title">Project Workflow Tracker</h1>
            <p className="pwt-sub">Track all projects across workflow stages</p>
          </div>
        </div>
        <button className="pwt-refresh-btn" onClick={() => fetchData(true)} disabled={refreshing}>
          <RefreshCw size={13} className={refreshing ? 'pwt-spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* ── KPI cards ── */}
      <div className="pwt-kpis">
        <div className="pwt-kpi-card">
          <div className="pwt-kpi-icon" style={{ background: '#ede9fe' }}><FolderKanban size={16} color="#6d28d9" /></div>
          <div><div className="pwt-kpi-val">{kpis.total}</div><div className="pwt-kpi-label">Total Projects</div></div>
        </div>
        <div className="pwt-kpi-card">
          <div className="pwt-kpi-icon" style={{ background: '#dcfce7' }}><CheckCircle size={16} color="#15803d" /></div>
          <div><div className="pwt-kpi-val pwt-val-green">{kpis.onTrack}</div><div className="pwt-kpi-label">On Track</div></div>
        </div>
        <div className="pwt-kpi-card">
          <div className="pwt-kpi-icon" style={{ background: '#fee2e2' }}><AlertTriangle size={16} color="#b91c1c" /></div>
          <div><div className="pwt-kpi-val pwt-val-red">{kpis.atRisk}</div><div className="pwt-kpi-label">At Risk / Delayed</div></div>
        </div>
        <div className="pwt-kpi-card">
          <div className="pwt-kpi-icon" style={{ background: '#e0e7ff' }}><CheckCircle size={16} color="#4338ca" /></div>
          <div><div className="pwt-kpi-val pwt-val-indigo">{kpis.completed}</div><div className="pwt-kpi-label">Completed</div></div>
        </div>
        <div className="pwt-kpi-card">
          <div className="pwt-kpi-icon" style={{ background: '#f0fdf4' }}><TrendingUp size={16} color="#15803d" /></div>
          <div><div className="pwt-kpi-val pwt-val-green">{kpis.avgProgress}%</div><div className="pwt-kpi-label">Avg Progress</div></div>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="pwt-filters">
        <div className="pwt-search-wrap">
          <Search size={13} color="#9ca3af" />
          <input className="pwt-search" placeholder="Search project or manager…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="pwt-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">All statuses</option>
          {Object.keys(STATUS_CONFIG).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* ── Content ── */}
      {loading ? (
        <div className="pwt-skeleton-list">
          {[1,2,3,4].map(i => <div key={i} className="pwt-skeleton-row" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="pwt-empty">
          <FolderKanban size={36} color="#c4b5fd" />
          <p>{projects.length === 0 ? 'No projects to track. Create projects in the Projects module.' : 'No projects match your search.'}</p>
        </div>
      ) : (
        <div className="pwt-cards">
          {filtered.map((p, i) => {
            const sc = STATUS_CONFIG[p.status] || STATUS_CONFIG['Planning'];
            const Icon = sc.icon;
            const pct = Math.min(100, Math.max(0, Number(p.progress || p.completion_percentage || 0)));
            const progColor = PROGRESS_COLOR(pct);
            const name = p.name || p.project_name || '—';
            const manager = p.project_manager || p.manager_name || '—';
            const stage = p.current_stage || p.stage || p.status || '—';
            const due = fmtDate((p.end_date || p.due_date || '').toString().slice(0, 10));

            return (
              <div key={p.id || i} className="pwt-card">
                <div className="pwt-card-top">
                  <div className="pwt-card-l">
                    <div className="pwt-card-avatar">{name.charAt(0).toUpperCase()}</div>
                    <div>
                      <div className="pwt-card-name">{name}</div>
                      {p.description && <div className="pwt-card-desc">{p.description}</div>}
                    </div>
                  </div>
                  <div className="pwt-card-r">
                    <span className="pwt-status-badge" style={{ background: sc.bg, color: sc.color }}>
                      <Icon size={10} /> {p.status || 'Planning'}
                    </span>
                    <span className="pwt-stage-badge">{stage}</span>
                  </div>
                </div>

                <div className="pwt-card-meta">
                  <span className="pwt-meta-item"><User size={11} /> {manager}</span>
                  <span className="pwt-meta-item"><Calendar size={11} /> Due {due}</span>
                </div>

                <div className="pwt-progress-row">
                  <div className="pwt-progress-track">
                    <div className="pwt-progress-fill" style={{ width: `${pct}%`, background: progColor }} />
                  </div>
                  <span className="pwt-progress-pct" style={{ color: progColor }}>{pct}%</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

