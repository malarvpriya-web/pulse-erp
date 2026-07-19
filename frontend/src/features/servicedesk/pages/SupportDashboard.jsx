import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  Ticket, CheckCircle, Clock, AlertTriangle, TrendingUp,
  Users, RefreshCw, ChevronRight, ArrowUpRight, X,
} from 'lucide-react';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
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

const EMPTY_TICKET = { title: '', category: '', priority: 'Medium', requester_name: '', description: '' };

export default function SupportDashboard({ setPage }) {
  const [stats,       setStats]       = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [newTicket,   setNewTicket]   = useState(false);
  const [ticketForm,  setTicketForm]  = useState(EMPTY_TICKET);
  const [submitting,  setSubmitting]  = useState(false);
  const [toast,       setToast]       = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/servicedesk/stats');
      setStats(res.data);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || 'Failed to load dashboard');
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submitTicket = async (e) => {
    e.preventDefault();
    if (!ticketForm.title.trim()) return showToast('Title is required', 'error');
    setSubmitting(true);
    try {
      await api.post('/servicedesk/tickets', ticketForm);
      showToast('Ticket created');
      setNewTicket(false);
      setTicketForm(EMPTY_TICKET);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || 'Failed to create ticket', 'error');
    } finally {
      setSubmitting(false);
    }
  };


  const s = stats || {};
  const catData  = (s.byCategory || []).map(r => ({ name: r.category, value: parseInt(r.count) }));
  const prioData = (s.byPriority || []).map(r => ({ name: r.priority, count: parseInt(r.count) }));
  const sla = s.slaSummary || {};

  const catChart = (h, inner, outer) => (
    <ResponsiveContainer width="100%" height={h}>
      <PieChart>
        <Pie data={catData} cx="50%" cy="50%" innerRadius={inner} outerRadius={outer}
          dataKey="value" paddingAngle={3}>
          {catData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={(v, n) => [v, n]} />
      </PieChart>
    </ResponsiveContainer>
  );

  const prioChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
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
  );

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
          <button className="sd-btn-primary" onClick={() => setNewTicket(true)}>
            + New Ticket
          </button>
          <button className="sd-icon-btn" onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
          <button
            onClick={() => setPage && setPage('ServiceDeskSettings')}
            style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', color: '#6b7280', fontSize: 13, fontWeight: 500 }}
            title="Service Desk Settings"
          >
            ⚙ Settings
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div style={{ margin: '16px 0', padding: '16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
          <AlertTriangle size={18} color="#ef4444" />
          <span style={{ color: '#b91c1c', fontSize: 14 }}>{error}</span>
          <button onClick={load} style={{ marginLeft: 'auto', padding: '6px 14px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
            Retry
          </button>
        </div>
      )}

      {loading && !stats && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#9ca3af' }}>Loading dashboard…</div>
      )}

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
            {catData.length > 0 && (
              <ChartExpandButton title="Tickets by Category">{catChart(430, 105, 165)}</ChartExpandButton>
            )}
          </div>
          <div className="sd-card-body">
            <div className="sd-pie-wrap">
              <div style={{ width: '50%' }}>{catChart(185, 46, 74)}</div>
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
            {prioData.length > 0 && (
              <ChartExpandButton title="Tickets by Priority">{prioChart(430)}</ChartExpandButton>
            )}
          </div>
          <div className="sd-card-body">
            {prioChart(185)}
          </div>
        </div>

        {/* team workload */}
        <div className="sd-card fc6">
          <div className="sd-card-hd">
            <span className="sd-card-title">Team Workload</span>
          </div>
          <div className="sd-card-body sd-card-scroll">
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
              { label: 'Within SLA',     value: sla.within_sla     || 0, color: '#10b981' },
              { label: 'SLA Breached',   value: sla.breached       || 0, color: '#ef4444' },
              { label: 'At Risk',        value: sla.at_risk        || 0, color: '#f59e0b' },
              { label: 'Not Applicable', value: sla.not_applicable || 0, color: '#9ca3af' },
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
          <div className="sd-card-body sd-table-wrap">
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
                    <td className="sd-td-mono">{t?.ticket_number ?? '—'}</td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t?.title ?? 'Untitled'}</td>
                    <td>{t?.category ?? '—'}</td>
                    <td>{t?.requester_name ?? 'Unknown'}</td>
                    <td>
                      <span className="sd-badge" style={{ background: priorityColor(t?.priority) + '20', color: priorityColor(t?.priority) }}>
                        {t?.priority ?? 'medium'}
                      </span>
                    </td>
                    <td>
                      <span className="sd-badge" style={{ background: statusColor(t?.status) + '20', color: statusColor(t?.status) }}>
                        {t?.status ?? 'open'}
                      </span>
                    </td>
                    <td>{t?.created_at ? new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* New Ticket modal */}
      {newTicket && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 480, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>New Ticket</h3>
              <button onClick={() => { setNewTicket(false); setTicketForm(EMPTY_TICKET); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
            </div>
            <form onSubmit={submitTicket} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Title *</label>
                <input value={ticketForm.title} onChange={e => setTicketForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="Brief description of the issue"
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Category</label>
                  <select value={ticketForm.category} onChange={e => setTicketForm(f => ({ ...f, category: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' }}>
                    <option value="">-- Select Category --</option>
                    {['Hardware','Software','Network','IT Support','HR','Finance','Facilities','Security','Other'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Priority</label>
                  <select value={ticketForm.priority} onChange={e => setTicketForm(f => ({ ...f, priority: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' }}>
                    <option>Low</option><option>Medium</option><option>High</option><option>Critical</option>
                  </select>
                </div>
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Requester Name</label>
                <input value={ticketForm.requester_name} onChange={e => setTicketForm(f => ({ ...f, requester_name: e.target.value }))}
                  placeholder="Who is raising this ticket?"
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Description</label>
                <textarea value={ticketForm.description} onChange={e => setTicketForm(f => ({ ...f, description: e.target.value }))}
                  rows={3} placeholder="Detailed description…"
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
                <button type="button" onClick={() => { setNewTicket(false); setTicketForm(EMPTY_TICKET); }}
                  style={{ padding: '8px 18px', border: '1px solid #d1d5db', borderRadius: 7, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                  Cancel
                </button>
                <button type="submit" disabled={submitting}
                  style={{ padding: '8px 20px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  {submitting ? 'Creating…' : 'Create Ticket'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 2000, padding: '12px 20px', borderRadius: 8, background: toast.type === 'error' ? '#ef4444' : '#10b981', color: '#fff', fontSize: 13, fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,.2)' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
