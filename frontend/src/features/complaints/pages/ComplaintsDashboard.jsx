import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import {
  MessageSquare, AlertTriangle, CheckCircle, Clock,
  RefreshCw, Plus, ChevronRight, TrendingUp, XCircle
} from 'lucide-react';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';
import { sm, pm } from './complaintsConstants';

const CAT_COLORS = ['#6366f1','#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6'];

const KPI = ({ icon: Icon, label, value, sub, color, alert, index = 0 }) => (
  <div className="dk-anim" style={{
    background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11,
    padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 11,
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    borderLeft: alert ? `4px solid ${color}` : undefined,
    '--dk-i': index,
  }}>
    <div style={{
      width: 34, height: 34, borderRadius: 10,
      background: color + '15', color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <Icon size={17} />
    </div>
    <div>
      <p style={{ fontSize: 11, color: '#9ca3af', margin: 0, fontWeight: 500 }}>{label}</p>
      <h3 style={{ fontSize: 20, fontWeight: 800, margin: '1px 0', color: '#111827' }}>{value}</h3>
      {sub && <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>{sub}</p>}
    </div>
  </div>
);

/**
 * @param {Function} setPage - navigate to another page key
 */
export default function ComplaintsDashboard({ setPage }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/complaints/dashboard');
      setData(res.data || null);
    } catch (err) {
      setData(null);
      setError(err.message || 'Failed to load dashboard');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);


  const d = data || {};

  const catChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={d.by_category || []} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="category" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false}
          domain={[0, Math.max(1, ...(d.by_category || []).map(r => parseInt(r.count) || 0)) + 1]} />
        <Tooltip />
        <Bar dataKey="count" name="Complaints" radius={[4,4,0,0]}>
          {(d.by_category || []).map((_, i) => <Cell key={i} fill={CAT_COLORS[i % CAT_COLORS.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  return (
    <div style={{ padding: '16px 18px 20px' }}>

      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', borderRadius: '8px', padding: '10px 14px', marginBottom: '12px', fontSize: '13px' }}>{error}</div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: 0 }}>Complaints Dashboard</h2>
          <p style={{ fontSize: 12.5, color: '#6b7280', margin: '3px 0 0' }}>{d.this_month} new this month · {d.resolution_rate}% resolution rate</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setPage && setPage('CustomerComplaintsIPCS')}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, color: '#374151' }}>
            All Complaints <ChevronRight size={13} />
          </button>
          {/* NewComplaint was retired 2026-07-17; creating is a drawer on the
              IPCS register, so this now lands on the grid rather than a form. */}
          <button
            onClick={() => setPage && setPage('CustomerComplaintsIPCS')}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> New Complaint
          </button>
          <button onClick={load} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', gap: 10, marginBottom: 12 }}>
        <KPI index={0} icon={MessageSquare} label="Total Complaints"  value={d.total}          color="#6366f1" sub="All time" />
        <KPI index={1} icon={AlertTriangle}  label="Open"             value={d.open}           color="#ef4444" alert={d.open > 0} sub="Needs attention" />
        <KPI index={2} icon={Clock}          label="In Progress"      value={d.in_progress}    color="#f59e0b" sub="Being handled" />
        <KPI index={3} icon={CheckCircle}    label="Resolved"         value={d.resolved}       color="#10b981" sub="Completed" />
        <KPI index={4} icon={XCircle}        label="Closed"           value={d.closed}         color="#6b7280" sub="Finalized" />
        <KPI index={5} icon={TrendingUp}     label="Resolution Rate"  value={`${d.resolution_rate}%`} color="#3b82f6" sub="Resolved + Closed" />
      </div>

      {/* Charts + Recent */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12 }}>

        {/* By Category */}
        <div className="dk-anim" style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', '--dk-i': 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 10px' }}>
            <h4 style={{ fontSize: 13.5, fontWeight: 700, color: '#111827', margin: 0 }}>By Category</h4>
            {(d.by_category || []).length > 0 && (
              <ChartExpandButton title="Complaints by Category">{catChart(430)}</ChartExpandButton>
            )}
          </div>
          {catChart(185)}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px 14px', marginTop: 10 }}>
            {(d.by_category || []).map((c, i) => (
              <span key={c.category} style={{ fontSize: 11, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: CAT_COLORS[i % CAT_COLORS.length], display: 'inline-block' }} />
                {c.category} ({c.count})
              </span>
            ))}
          </div>
        </div>

        {/* Recent Complaints */}
        <div className="dk-anim" style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', '--dk-i': 7 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h4 style={{ fontSize: 13.5, fontWeight: 700, color: '#111827', margin: 0 }}>Recent Complaints</h4>
            <button onClick={() => setPage && setPage('CustomerComplaintsIPCS')}
              style={{ fontSize: 12, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              View All <ChevronRight size={12} />
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 290, overflowY: 'auto' }}>
            {(d.recent || []).map(c => {
              const s = sm(c.status);
              const p = pm(c.priority);
              return (
                <div key={c.id} style={{ padding: '10px 12px', border: '1px solid #f3f4f6', borderRadius: 8, cursor: 'pointer' }}
                  onClick={() => {
                    sessionStorage.setItem('selectedComplaintId', c.id);
                    sessionStorage.setItem('selectedComplaint', JSON.stringify(c));
                    if (setPage) setPage('ComplaintDetail');
                  }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'monospace' }}>{c.complaint_number}</span>
                      <p style={{ fontSize: 13, fontWeight: 600, color: '#111827', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</p>
                      <p style={{ fontSize: 11, color: '#6b7280', margin: '2px 0 0' }}>{c.customer_name}</p>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                      <span style={{ background: s.bg, color: s.color, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>{s.label}</span>
                      <span style={{ background: p.bg, color: p.color, fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4 }}>{c.priority}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
