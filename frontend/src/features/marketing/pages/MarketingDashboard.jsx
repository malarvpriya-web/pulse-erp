import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { RefreshCw, TrendingUp, Users, Target, BarChart2, Plus } from 'lucide-react';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

const fmtL = (n) => {
  const v = parseFloat(n) || 0;
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
};

const STATUS_COLORS = {
  active:    { bg: '#d1fae5', color: '#16a34a' },
  draft:     { bg: '#f3f4f6', color: '#6b7280' },
  paused:    { bg: '#fef3c7', color: '#d97706' },
  completed: { bg: '#dbeafe', color: '#2563eb' },
  cancelled: { bg: '#fee2e2', color: '#dc2626' },
};

function KpiCard({ icon: Icon, label, value, color, loading, index = 0 }) {
  return (
    <div className="dk-anim" style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '12px 14px', '--dk-i': index }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5 }}>
        <Icon size={17} style={{ color }} />
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-text-primary)' }}>
        {loading ? <div style={{ height: 24, width: 80, background: 'var(--color-border-tertiary)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} /> : value}
      </div>
    </div>
  );
}

export default function MarketingDashboard() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate              = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/marketing/dashboard');
      setData(res.data || null);
    } catch { setData(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stats    = data?.stats || {};
  const recent   = Array.isArray(data?.recent_campaigns) ? data.recent_campaigns : [];
  const monthly  = Array.isArray(data?.monthly_leads)    ? data.monthly_leads    : [];

  const leadsChart = (h) => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={monthly} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" />
        <XAxis dataKey="month" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Bar dataKey="leads" fill="#6B3FDB" radius={[4, 4, 0, 0]} name="Leads" />
      </BarChart>
    </ResponsiveContainer>
  );

  return (
    <div style={{ padding: '16px 18px 20px', background: 'var(--color-background-primary)' }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>Marketing Dashboard</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Campaign performance and marketing metrics</p>
        </div>
        <button onClick={load} style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, background: 'var(--color-background-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
        <button onClick={() => navigate('/Campaigns')} style={{ padding: '7px 16px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> New Campaign
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10, marginBottom: 12 }}>
        <KpiCard index={0} icon={Target}    label="Active Campaigns"    color="#6B3FDB" loading={loading} value={stats.active_campaigns  ?? '—'} />
        <KpiCard index={1} icon={BarChart2} label="Total Budget"        color="#2563eb" loading={loading} value={fmtL(stats.total_budget)} />
        <KpiCard index={2} icon={Users}     label="Leads Generated"     color="#16a34a" loading={loading} value={stats.total_leads_generated ?? '—'} />
        <KpiCard index={3} icon={TrendingUp} label="Avg ROI %"          color="#d97706" loading={loading} value={stats.avg_roi != null ? `${stats.avg_roi}%` : '—'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div className="dk-anim" style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 14, '--dk-i': 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 10px' }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Monthly Leads (12 mo)</h3>
            {!loading && monthly.length > 0 && (
              <ChartExpandButton title="Monthly Leads (12 mo)">{leadsChart(430)}</ChartExpandButton>
            )}
          </div>
          {loading ? (
            <div style={{ height: 185, background: 'var(--color-border-tertiary)', borderRadius: 6, animation: 'pulse 1.5s ease-in-out infinite' }} />
          ) : monthly.length === 0 ? (
            <div style={{ height: 185, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>No data yet</div>
          ) : leadsChart(185)}
        </div>

        <div className="dk-anim" style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 14, maxHeight: 260, overflowY: 'auto', '--dk-i': 5 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Recent Campaigns</h3>
          {loading ? (
            [1,2,3].map(i => <div key={i} style={{ height: 36, background: 'var(--color-border-tertiary)', borderRadius: 6, marginBottom: 8, animation: 'pulse 1.5s ease-in-out infinite' }} />)
          ) : recent.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
              <Target size={28} style={{ marginBottom: 8, opacity: 0.4 }} />
              <div>No campaigns yet</div>
              <button onClick={() => navigate('/Campaigns')} style={{ marginTop: 10, padding: '7px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                Create Campaign
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {recent.map(c => {
                const sc = STATUS_COLORS[c.status] || {};
                const pct = c.budget > 0 ? Math.min(100, Math.round((c.spent || 0) / c.budget * 100)) : 0;
                return (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                        Budget: {fmtL(c.budget)} · Leads: {c.actual_leads || 0}/{c.target_leads || 0}
                      </div>
                      <div style={{ height: 4, background: 'var(--color-border-tertiary)', borderRadius: 2, marginTop: 4 }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: '#6B3FDB', borderRadius: 2 }} />
                      </div>
                    </div>
                    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color, whiteSpace: 'nowrap' }}>{c.status}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
