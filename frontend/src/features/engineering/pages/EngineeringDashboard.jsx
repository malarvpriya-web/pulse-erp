import { useState, useEffect, useCallback } from 'react';
import { FlaskConical, Layers, TestTube2, CheckCircle, AlertCircle, Clock, TrendingUp, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import './EngineeringDashboard.css';

const STATUS_COLOR = {
  concept:    '#6366f1',
  design:     '#3b82f6',
  prototype:  '#f59e0b',
  testing:    '#8b5cf6',
  approved:   '#10b981',
  cancelled:  '#6b7280',
};

const STATUS_LABEL = {
  concept:   'Concept',
  design:    'Design',
  prototype: 'Prototype',
  testing:   'Testing',
  approved:  'Approved',
  cancelled: 'Cancelled',
};

const PRIORITY_COLOR = { high: '#ef4444', medium: '#f59e0b', low: '#10b981' };

function KpiCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div className="eng-kpi" style={{ '--kc': color }}>
      <div className="eng-kpi-icon"><Icon size={20} /></div>
      <div className="eng-kpi-body">
        <p className="eng-kpi-label">{label}</p>
        <h3 className="eng-kpi-val">{value}</h3>
        {sub && <p className="eng-kpi-sub">{sub}</p>}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  return (
    <span className="eng-pill" style={{ background: STATUS_COLOR[status] + '22', color: STATUS_COLOR[status] }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function PriorityDot({ priority }) {
  return <span className="eng-dot" style={{ background: PRIORITY_COLOR[priority] || '#9ca3af' }} title={priority} />;
}

function PhaseBar({ phases }) {
  if (!phases?.length) return null;
  return (
    <div className="eng-phasebar">
      {phases.map(ph => {
        const pct = ph.total > 0 ? Math.round((ph.completed / ph.total) * 100) : 0;
        return (
          <div key={ph.phase_name} className="eng-phasebar-item">
            <div className="eng-phasebar-label">
              <span>{ph.phase_name}</span>
              <span className="eng-phasebar-count">{ph.completed}/{ph.total}</span>
            </div>
            <div className="eng-phasebar-track">
              <div className="eng-phasebar-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function EngineeringDashboard({ setPage }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/engineering/dashboard');
      setData(r.data.data);
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return (
    <div className="eng-center">
      <div className="eng-loading">
        <RefreshCw size={28} className="eng-spin" />
        <p>Loading dashboard…</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="eng-center">
      <div className="eng-error">
        <AlertCircle size={32} />
        <p>{error}</p>
        <button onClick={load}>Retry</button>
      </div>
    </div>
  );

  const p  = data?.projects || {};
  const pr = data?.prototypes || {};
  const t  = data?.tests || {};
  const testPassRate = t.total > 0 ? Math.round((t.passed / t.total) * 100) : 0;
  const budgetUsed   = p.total_budget > 0 ? Math.round((p.total_spent / p.total_budget) * 100) : 0;

  const pipeline = [
    { key: 'concept',   label: 'Concept',   count: p.concept   || 0 },
    { key: 'design',    label: 'Design',     count: p.design    || 0 },
    { key: 'prototype', label: 'Prototype',  count: p.prototype || 0 },
    { key: 'testing',   label: 'Testing',    count: p.testing   || 0 },
    { key: 'approved',  label: 'Approved',   count: p.approved  || 0 },
  ];
  const maxPipe = Math.max(...pipeline.map(s => s.count), 1);

  return (
    <div className="eng-dash">
      <div className="eng-dash-header">
        <div>
          <h1 className="eng-dash-title">Engineering</h1>
          <p className="eng-dash-sub">R&amp;D Projects · Design Phases · Prototypes · Test Plans</p>
        </div>
        <button className="eng-btn-refresh" onClick={load}><RefreshCw size={15} /></button>
      </div>

      {/* KPIs */}
      <div className="eng-kpi-grid">
        <KpiCard icon={FlaskConical}  label="R&D Projects"   value={p.total || 0}          sub={`${p.approved || 0} approved`}          color="#6366f1" />
        <KpiCard icon={Layers}        label="Design Phases"  value={data?.phases?.length || 0} sub="phase categories tracked"             color="#3b82f6" />
        <KpiCard icon={TestTube2}     label="Prototypes"     value={pr.total || 0}          sub={`${pr.passed || 0} passed testing`}      color="#f59e0b" />
        <KpiCard icon={CheckCircle}   label="Test Pass Rate" value={`${testPassRate}%`}     sub={`${t.passed || 0}/${t.total || 0} tests`} color="#10b981" />
        <KpiCard icon={TrendingUp}    label="Budget Used"    value={`${budgetUsed}%`}       sub={`₹${Number(p.total_spent||0).toLocaleString('en-IN')} spent`} color="#8b5cf6" />
        <KpiCard icon={Clock}         label="In Progress"    value={(p.design||0)+(p.prototype||0)+(p.testing||0)} sub="active phases" color="#ef4444" />
      </div>

      <div className="eng-dash-body">
        {/* Pipeline Funnel */}
        <div className="eng-card">
          <h2 className="eng-card-title">R&amp;D Pipeline</h2>
          <div className="eng-pipeline">
            {pipeline.map(stage => (
              <div key={stage.key} className="eng-pipeline-row">
                <span className="eng-pipeline-label">{stage.label}</span>
                <div className="eng-pipeline-bar-wrap">
                  <div
                    className="eng-pipeline-bar"
                    style={{
                      width:      `${Math.round((stage.count / maxPipe) * 100)}%`,
                      background: STATUS_COLOR[stage.key],
                    }}
                  />
                </div>
                <span className="eng-pipeline-count">{stage.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Phase Progress */}
        <div className="eng-card">
          <h2 className="eng-card-title">Design Phase Progress</h2>
          <PhaseBar phases={data?.phases} />
          {(!data?.phases || data.phases.length === 0) && (
            <p className="eng-empty-sub">No phases yet — create an R&amp;D project to seed phases.</p>
          )}
        </div>
      </div>

      {/* Recent Projects */}
      <div className="eng-card eng-card-full">
        <div className="eng-card-head">
          <h2 className="eng-card-title">Recent Projects</h2>
          {setPage && (
            <button className="eng-link-btn" onClick={() => setPage('RDProjects')}>View all →</button>
          )}
        </div>
        {data?.recentProjects?.length === 0 ? (
          <div className="eng-empty">
            <FlaskConical size={36} className="eng-empty-icon" />
            <p>No R&amp;D projects yet.</p>
            {setPage && <button className="eng-btn-primary" onClick={() => setPage('RDProjects')}>Create First Project</button>}
          </div>
        ) : (
          <div className="eng-table-wrap">
            <table className="eng-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Manager</th>
                  <th>Target Date</th>
                  <th>Budget (₹)</th>
                </tr>
              </thead>
              <tbody>
                {data?.recentProjects?.map(proj => (
                  <tr key={proj.id}>
                    <td>
                      <div className="eng-proj-name">{proj.name}</div>
                      {proj.code && <div className="eng-proj-code">{proj.code}</div>}
                    </td>
                    <td><StatusPill status={proj.status} /></td>
                    <td><PriorityDot priority={proj.priority} /> {proj.priority}</td>
                    <td>{proj.manager_name || '—'}</td>
                    <td>{proj.target_date ? new Date(proj.target_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    <td>{proj.budget ? `₹${Number(proj.budget).toLocaleString('en-IN')}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
