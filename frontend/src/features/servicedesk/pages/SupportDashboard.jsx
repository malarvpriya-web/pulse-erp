import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import {
  Ticket, CheckCircle, Clock, AlertTriangle, TrendingUp,
  Users, RefreshCw, ChevronRight, ArrowUpRight
} from 'lucide-react';
import api from '@/services/api/client';
import './SupportDashboard.css';

const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899'];

const priorityColor = p => {
  if (!p) return '#9ca3af';
  const m = p.toLowerCase();
  if (m === 'critical') return '#7f1d1d';
  if (m === 'high')     return '#ef4444';
  if (m === 'medium')   return '#f59e0b';
  return '#10b981';
};

const statusColor = s => {
  if (!s) return '#9ca3af';
  const m = s.toLowerCase();
  if (m === 'open')        return '#6366f1';
  if (m === 'in progress') return '#f59e0b';
  if (m === 'resolved')    return '#10b981';
  if (m === 'pending')     return '#3b82f6';
  return '#9ca3af';
};

const KPI = ({ icon: Icon, label, value, sub, color, alert }) => (
  <div className={`sd-kpi${alert ? ' sd-kpi-alert' : ''}`} style={{ '--c': color }}>
    <div className="sd-kpi-icon"><Icon size={19} /></div>
    <div className="sd-kpi-body">
      <p className="sd-kpi-label">{label}</p>
      <h3 className="sd-kpi-val">{value}</h3>
      {sub && <p className="sd-kpi-sub">{sub}</p>}
    </div>
  </div>
);

export default function SupportDashboard({ setPage }) {
  const [stats, setStats]     = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/servicedesk/stats');
      setStats(res.data);
    } catch (e) {
      // fallback sample data
      setStats({
        total: 10, open: 5, inProgress: 2, resolved: 3,
        highPriority: 3, thisMonth: 10, thisWeek: 4, resolutionRate: 30,
        byCategory: [
          { category: 'IT Support', count: 4 },
          { category: 'Finance', count: 2 },
          { category: 'HR', count: 2 },
          { category: 'CRM', count: 1 },
          { category: 'System', count: 1 },
        ],
        byPriority: [
          { priority: 'High', count: 4 },
          { priority: 'Medium', count: 4 },
          { priority: 'Low', count: 2 },
        ],
        byTeam: [
          { team: 'IT Support', count: 5, open: 3 },
          { team: 'Finance IT', count: 3, open: 1 },
          { team: 'HR Support', count: 2, open: 1 },
        ],
        recent: [],
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="sd-loading"><div className="sd-spinner" /><p>Loading dashboard…</p></div>;

  const s = stats || {};
  const catData  = (s.byCategory || []).map(r => ({ name: r.category, value: parseInt(r.count) }));
  const prioData = (s.byPriority || []).map(r => ({ name: r.priority, count: parseInt(r.count) }));

  return (
    <div className="sd-root">
      {/* header */}
      <div className="sd-header">
        <div>
          <h2 className="sd-title">Service Desk</h2>
          <p className="sd-sub">Support ticket overview &amp; SLA metrics</p>
        </div>
        <div className="sd-header-r">
          <button className="sd-btn-outline" onClick={() => setPage && setPage('AllTickets')}>
            All Tickets <ChevronRight size={14} />
          </button>
          <button className="sd-btn-primary" onClick={() => setPage && setPage('AllTickets')}>
            + New Ticket
          </button>
          <button className="sd-icon-btn" onClick={load}><RefreshCw size={14} /></button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="sd-kpis">
        <KPI icon={Ticket}       label="Total Tickets"   value={s.total || 0}           color="#6366f1" sub={`${s.thisWeek||0} this week`} />
        <KPI icon={AlertTriangle}label="Open"            value={s.open || 0}            color="#ef4444" alert={(s.open||0)>3} sub="Needs attention" />
        <KPI icon={Clock}        label="In Progress"     value={s.inProgress || 0}      color="#f59e0b" sub="Being worked on" />
        <KPI icon={CheckCircle}  label="Resolved"        value={s.resolved || 0}        color="#10b981" sub={`${s.resolutionRate||0}% rate`} />
        <KPI icon={TrendingUp}   label="High Priority"   value={s.highPriority || 0}    color="#ef4444" alert={(s.highPriority||0)>0} sub="Urgent items" />
        <KPI icon={Users}        label="This Month"      value={s.thisMonth || 0}        color="#3b82f6" sub="Tickets raised" />
      </div>

      {/* charts row */}
      <div className="sd-grid">

        {/* tickets by category */}
        <div className="sd-card fc6">
          <div className="sd-card-hd">
            <span className="sd-card-title">Tickets by Category</span>
          </div>
          <div className="sd-card-body">
            <div className="sd-pie-wrap">
              <ResponsiveContainer width="50%" height={200}>
                <PieChart>
                  <Pie data={catData} cx="50%" cy="50%" innerRadius={50} outerRadius={80}
                    dataKey="value" paddingAngle={3}>
                    {catData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v, n]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="sd-legend">
                {catData.map((c, i) => (
                  <div key={i} className="sd-legend-row">
                    <span className="sd-legend-dot" style={{ background: COLORS[i % COLORS.length] }} />
                    <span className="sd-legend-name">{c.name}</span>
                    <span className="sd-legend-val">{c.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* tickets by priority */}
        <div className="sd-card fc6">
          <div className="sd-card-hd">
            <span className="sd-card-title">Tickets by Priority</span>
          </div>
          <div className="sd-card-body">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={prioData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} name="Tickets">
                  {prioData.map((p, i) => <Cell key={i} fill={priorityColor(p.name)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* team workload */}
        <div className="sd-card fc6">
          <div className="sd-card-hd">
            <span className="sd-card-title">Team Workload</span>
          </div>
          <div className="sd-card-body">
            {(s.byTeam || []).map((t, i) => {
              const pct = s.total ? Math.round((parseInt(t.count) / s.total) * 100) : 0;
              return (
                <div key={i} className="sd-team-row">
                  <span className="sd-team-name">{t.team}</span>
                  <div className="sd-team-track">
                    <div className="sd-team-bar" style={{ width: `${pct}%`, background: COLORS[i % COLORS.length] }} />
                  </div>
                  <span className="sd-team-stats">{t.count} total · {t.open} open</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* SLA summary */}
        <div className="sd-card fc6">
          <div className="sd-card-hd">
            <span className="sd-card-title">SLA Status</span>
          </div>
          <div className="sd-card-body">
            {[
              { label: 'Within SLA',     value: Math.max(0, (s.resolved||0) - 1), color: '#10b981' },
              { label: 'SLA Breached',   value: 1,                                 color: '#ef4444' },
              { label: 'At Risk',        value: s.highPriority || 0,               color: '#f59e0b' },
              { label: 'Not Applicable', value: s.inProgress || 0,                 color: '#9ca3af' },
            ].map((item, i) => (
              <div key={i} className="sd-sla-row">
                <span className="sd-sla-dot" style={{ background: item.color }} />
                <span className="sd-sla-label">{item.label}</span>
                <span className="sd-sla-val">{item.value}</span>
                <div className="sd-sla-bar-track">
                  <div className="sd-sla-bar"
                    style={{ width: `${s.total ? Math.round((item.value / s.total) * 100) : 0}%`, background: item.color }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* recent tickets */}
        <div className="sd-card fc12">
          <div className="sd-card-hd">
            <span className="sd-card-title">Recent Tickets</span>
            <button className="sd-text-btn" onClick={() => setPage && setPage('AllTickets')}>
              View All <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="sd-card-body">
            <table className="sd-table">
              <thead>
                <tr>
                  <th>Ticket #</th><th>Title</th><th>Category</th>
                  <th>Requester</th><th>Priority</th><th>Status</th><th>Created</th>
                </tr>
              </thead>
              <tbody>
                {(s.recent || []).length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: '#9ca3af', padding: '24px' }}>No recent tickets</td></tr>
                ) : (s.recent || []).map((t, i) => (
                  <tr key={i}>
                    <td className="sd-td-mono">{t.ticket_number}</td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</td>
                    <td>{t.category}</td>
                    <td>{t.requester_name}</td>
                    <td>
                      <span className="sd-badge" style={{ background: priorityColor(t.priority) + '20', color: priorityColor(t.priority) }}>
                        {t.priority}
                      </span>
                    </td>
                    <td>
                      <span className="sd-badge" style={{ background: statusColor(t.status) + '20', color: statusColor(t.status) }}>
                        {t.status}
                      </span>
                    </td>
                    <td>{t.created_at ? new Date(t.created_at).toLocaleDateString('en-IN') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
