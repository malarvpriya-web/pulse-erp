import { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { TrendingUp, Users, IndianRupee, Target, ChevronDown } from 'lucide-react';
import api from '@/services/api/client';

const fmtL = (n) => {
  const v = parseFloat(n) || 0;
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
};

const DELIVERABLE_COLORS = {
  pending:     '#9ca3af',
  in_progress: '#3b82f6',
  delivered:   '#10b981',
  overdue:     '#ef4444',
};
const PIE_COLORS = ['#10b981','#3b82f6','#f59e0b','#ef4444','#8b5cf6'];

function KpiCard({ icon: Icon, label, value, color, loading }) {
  return (
    <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ background: color + '18', borderRadius: 8, padding: 8 }}>
          <Icon size={16} style={{ color }} />
        </div>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-text-primary)' }}>
        {loading
          ? <div style={{ height: 22, width: 80, background: 'var(--color-border-tertiary)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
          : value}
      </div>
    </div>
  );
}

export default function CampaignAnalytics() {
  const [campaigns,    setCampaigns]    = useState([]);
  const [selected,     setSelected]     = useState('');
  const [analytics,    setAnalytics]    = useState(null);
  const [summary,      setSummary]      = useState({});
  const [loadingCamps, setLoadingCamps] = useState(true);
  const [loadingData,  setLoadingData]  = useState(false);

  useEffect(() => {
    Promise.allSettled([
      api.get('/marketing/campaigns'),
      api.get('/marketing/analytics/summary'),
    ]).then(([campsRes, summaryRes]) => {
      const camps = campsRes.status === 'fulfilled' && Array.isArray(campsRes.value?.data)
        ? campsRes.value.data : [];
      setCampaigns(camps);
      setSummary(summaryRes.status === 'fulfilled' ? (summaryRes.value?.data || {}) : {});
      if (camps.length > 0) setSelected(camps[0].id);
    }).finally(() => setLoadingCamps(false));
  }, []);

  const loadAnalytics = useCallback(async (id) => {
    if (!id) return;
    setLoadingData(true);
    try {
      const res = await api.get(`/marketing/campaigns/${id}/analytics`);
      setAnalytics(res.data || null);
    } catch { setAnalytics(null); }
    finally { setLoadingData(false); }
  }, []);

  useEffect(() => { if (selected) loadAnalytics(selected); }, [selected, loadAnalytics]);

  const taskTotal     = parseInt(analytics?.task_completion?.total     || 0);
  const taskCompleted = parseInt(analytics?.task_completion?.completed || 0);
  const taskPct       = taskTotal > 0 ? Math.round(taskCompleted / taskTotal * 100) : 0;

  const delivPie = (analytics?.deliverable_status || []).map((d, i) => ({
    name:  d.status,
    value: parseInt(d.cnt),
    fill:  DELIVERABLE_COLORS[d.status] || PIE_COLORS[i % PIE_COLORS.length],
  }));

  const budgetBar = analytics
    ? [{ name: 'Campaign', budget: parseFloat(analytics.budget || 0), spent: parseFloat(analytics.spent || 0) }]
    : [];

  return (
    <div style={{ padding: 24, background: 'var(--color-background-primary)' }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>Campaign Analytics</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Performance and ROI breakdown per campaign</p>
        </div>
        <div style={{ position: 'relative' }}>
          <select
            value={selected}
            onChange={e => setSelected(e.target.value)}
            disabled={loadingCamps || campaigns.length === 0}
            style={{ appearance: 'none', padding: '8px 36px 8px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', cursor: 'pointer', minWidth: 220 }}
          >
            {loadingCamps
              ? <option>Loading…</option>
              : campaigns.length === 0
                ? <option>No campaigns</option>
                : campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <ChevronDown size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--color-text-secondary)' }} />
        </div>
      </div>

      {/* Overall summary row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 14, marginBottom: 24 }}>
        <KpiCard icon={Target}     label="Total Campaigns"     color="#6B3FDB" loading={loadingCamps} value={summary.total_campaigns ?? '—'} />
        <KpiCard icon={Users}      label="Total Leads"         color="#2563eb" loading={loadingCamps} value={summary.total_leads ?? '—'} />
        <KpiCard icon={TrendingUp} label="Cost per Lead Rate"  color="#16a34a" loading={loadingCamps} value={summary.cost_per_lead_rate != null ? `${summary.cost_per_lead_rate}%` : '—'} />
        <KpiCard icon={IndianRupee} label="Best Campaign"       color="#d97706" loading={loadingCamps} value={summary.best_campaign || '—'} />
      </div>

      {campaigns.length === 0 && !loadingCamps ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 14 }}>
          No campaigns found. Create a campaign to see analytics.
        </div>
      ) : (
        <>
          {/* Per-campaign KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 24 }}>
            <KpiCard icon={IndianRupee} label="Budget"      color="#2563eb" loading={loadingData} value={fmtL(analytics?.budget)} />
            <KpiCard icon={IndianRupee} label="Spent"       color="#ef4444" loading={loadingData} value={fmtL(analytics?.spent)} />
            <KpiCard icon={Users}      label="Leads"       color="#16a34a" loading={loadingData} value={analytics?.actual_leads ?? '—'} />
            <KpiCard icon={TrendingUp} label="ROI %"       color="#6B3FDB" loading={loadingData} value={analytics?.roi != null ? `${analytics.roi}%` : '—'} />
            <KpiCard icon={Target}     label="Cost / Lead" color="#d97706" loading={loadingData} value={parseFloat(analytics?.cost_per_lead) > 0 ? fmtL(analytics.cost_per_lead) : '—'} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
            {/* Budget vs Spent bar */}
            <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 20 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Budget vs Spent</h3>
              {loadingData ? (
                <div style={{ height: 200, background: 'var(--color-border-tertiary)', borderRadius: 6, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={budgetBar}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={v => fmtL(v)} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={v => [fmtL(v)]} />
                    <Legend />
                    <Bar dataKey="budget" fill="#2563eb" radius={[4,4,0,0]} name="Budget" />
                    <Bar dataKey="spent"  fill="#ef4444" radius={[4,4,0,0]} name="Spent" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Deliverable status donut */}
            <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 20 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Deliverable Status</h3>
              {loadingData ? (
                <div style={{ height: 200, background: 'var(--color-border-tertiary)', borderRadius: 6, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ) : delivPie.length === 0 ? (
                <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>No deliverables yet</div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={delivPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75}
                      label={({ name, percent }) => `${name} ${Math.round(percent * 100)}%`} labelLine={false}>
                      {delivPie.map((d, i) => <Cell key={i} fill={d.fill} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Task completion bar */}
          <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 20 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Task Completion</h3>
            {loadingData ? (
              <div style={{ height: 28, background: 'var(--color-border-tertiary)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                  <span>{taskCompleted} of {taskTotal} tasks completed</span>
                  <span style={{ fontWeight: 700, color: taskPct >= 80 ? '#16a34a' : 'var(--color-text-primary)' }}>{taskPct}%</span>
                </div>
                <div style={{ height: 10, background: 'var(--color-border-tertiary)', borderRadius: 5 }}>
                  <div style={{ height: '100%', width: `${taskPct}%`, background: taskPct >= 80 ? '#16a34a' : '#6B3FDB', borderRadius: 5, transition: 'width 0.4s ease' }} />
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
