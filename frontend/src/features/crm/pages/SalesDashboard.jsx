import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, FunnelChart, Funnel, LabelList, Cell
} from 'recharts';
import {
  Users, TrendingUp, CheckCircle, Target,
  RefreshCw, ArrowUpRight, Plus, ChevronRight
} from 'lucide-react';
import api from '@/services/api/client';
import './SalesDashboard.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const STAGE_COLORS = {
  Prospecting:   '#6366f1',
  Qualification: '#3b82f6',
  Proposal:      '#f59e0b',
  Negotiation:   '#ef4444',
  Won:           '#10b981',
};

const SAMPLE_STATS = {
  total_leads: 84,
  pipeline_value: 12400000,
  won_deals: 18,
  conversion_rate: 21,
  leads_this_month: 14,
  pipeline_change: 8,
};

const SAMPLE_FUNNEL = [
  { stage: 'Prospecting',   count: 32, value: 4800000 },
  { stage: 'Qualification', count: 24, value: 3600000 },
  { stage: 'Proposal',      count: 16, value: 2400000 },
  { stage: 'Negotiation',   count: 8,  value: 1600000 },
  { stage: 'Won',           count: 4,  value: 850000  },
];

const SAMPLE_OPPS = [
  { id: 1, opportunity_name: 'ERP Implementation - TechCorp',   company_name: 'TechCorp Solutions', expected_value: 850000,  probability_percentage: 75, stage: 'Negotiation', expected_closing_date: '2024-12-15' },
  { id: 2, opportunity_name: 'Cloud Migration - Alpha Mfg',     company_name: 'Alpha Manufacturing', expected_value: 620000, probability_percentage: 60, stage: 'Proposal',     expected_closing_date: '2024-12-30' },
  { id: 3, opportunity_name: 'Security Suite - Global Trade',   company_name: 'Global Trade Partners', expected_value: 410000, probability_percentage: 45, stage: 'Qualification', expected_closing_date: '2025-01-15' },
  { id: 4, opportunity_name: 'Analytics Platform - BrightFin',  company_name: 'BrightFin Ltd',      expected_value: 380000,  probability_percentage: 85, stage: 'Negotiation', expected_closing_date: '2024-12-10' },
  { id: 5, opportunity_name: 'CRM Rollout - MediTech',          company_name: 'MediTech Services',  expected_value: 290000,  probability_percentage: 30, stage: 'Proposal',     expected_closing_date: '2025-01-31' },
];

const KPI = ({ icon: Icon, label, value, sub, color, alert }) => (
  <div className={`csd-kpi${alert ? ' csd-kpi-alert' : ''}`} style={{ '--c': color }}>
    <div className="csd-kpi-icon"><Icon size={19} /></div>
    <div>
      <p className="csd-kpi-label">{label}</p>
      <h3 className="csd-kpi-val">{value}</h3>
      {sub && <p className="csd-kpi-sub">{sub}</p>}
    </div>
  </div>
);

export default function SalesDashboard({ setPage }) {
  const [stats,   setStats]   = useState(null);
  const [funnel,  setFunnel]  = useState([]);
  const [topOpps, setTopOpps] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [statsRes, oppsRes] = await Promise.allSettled([
      api.get('/crm/stats'),
      api.get('/crm/opportunities'),
    ]);

    const rawStats = statsRes.status === 'fulfilled' ? statsRes.value.data : null;
    setStats(rawStats || SAMPLE_STATS);

    const rawOpps = oppsRes.status === 'fulfilled'
      ? (oppsRes.value.data.opportunities || oppsRes.value.data || [])
      : [];

    if (Array.isArray(rawOpps) && rawOpps.length > 0) {
      setTopOpps([...rawOpps].sort((a, b) => parseFloat(b.expected_value) - parseFloat(a.expected_value)).slice(0, 5));
      // build funnel from opps
      const stageMap = {};
      rawOpps.forEach(o => {
        const s = o.stage || 'Qualification';
        if (!stageMap[s]) stageMap[s] = { stage: s, count: 0, value: 0 };
        stageMap[s].count++;
        stageMap[s].value += parseFloat(o.expected_value || 0);
      });
      const order = ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Won'];
      setFunnel(order.map(s => stageMap[s] || { stage: s, count: 0, value: 0 }));
    } else {
      setTopOpps(SAMPLE_OPPS);
      setFunnel(SAMPLE_FUNNEL);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="csd-loading"><div className="csd-spinner" /><p>Loading dashboard…</p></div>;

  const s = stats || SAMPLE_STATS;

  return (
    <div className="csd-root">

      {/* header */}
      <div className="csd-header">
        <div>
          <h2 className="csd-title">CRM Dashboard</h2>
          <p className="csd-sub">Sales pipeline overview &amp; lead performance</p>
        </div>
        <div className="csd-header-r">
          <button className="csd-btn-outline" onClick={() => setPage && setPage('Leads')}>
            All Leads <ChevronRight size={13} />
          </button>
          <button className="csd-btn-primary" onClick={() => setPage && setPage('Leads')}>
            <Plus size={14} /> New Lead
          </button>
          <button className="csd-icon-btn" onClick={load}><RefreshCw size={14} /></button>
        </div>
      </div>

      {/* KPIs */}
      <div className="csd-kpis">
        <KPI icon={Users}       label="Total Leads"      value={s.total_leads || 0}       color="#6366f1" sub={`${s.leads_this_month || 0} this month`} />
        <KPI icon={TrendingUp}  label="Pipeline Value"   value={fmt(s.pipeline_value)}    color="#3b82f6" sub={`${s.pipeline_change > 0 ? '+' : ''}${s.pipeline_change || 0}% vs last month`} />
        <KPI icon={CheckCircle} label="Won Deals"        value={s.won_deals || 0}         color="#10b981" sub="Closed won" />
        <KPI icon={Target}      label="Conversion Rate"  value={`${s.conversion_rate || 0}%`} color="#f59e0b" sub="Lead to deal" />
      </div>

      {/* charts + top opps */}
      <div className="csd-grid">

        {/* pipeline funnel */}
        <div className="csd-card csd-fc7">
          <div className="csd-card-hd">
            <span className="csd-card-title">Pipeline Funnel</span>
          </div>
          <div className="csd-card-body">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={funnel} layout="vertical" margin={{ top: 5, right: 60, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="stage" tick={{ fontSize: 12 }} width={100} />
                <Tooltip formatter={(v, n) => [n === 'count' ? v + ' deals' : fmt(v), n === 'count' ? 'Count' : 'Value']} />
                <Bar dataKey="count" name="count" radius={[0, 4, 4, 0]}>
                  {funnel.map((f, i) => <Cell key={i} fill={STAGE_COLORS[f.stage] || '#6366f1'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {/* stage value legend */}
            <div className="csd-funnel-legend">
              {funnel.map((f, i) => (
                <div key={i} className="csd-funnel-row">
                  <span className="csd-funnel-dot" style={{ background: STAGE_COLORS[f.stage] || '#6366f1' }} />
                  <span className="csd-funnel-stage">{f.stage}</span>
                  <span className="csd-funnel-count">{f.count} deals</span>
                  <span className="csd-funnel-val">{fmt(f.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* top opportunities */}
        <div className="csd-card csd-fc5">
          <div className="csd-card-hd">
            <span className="csd-card-title">Top Opportunities</span>
            <button className="csd-text-btn" onClick={() => setPage && setPage('OpportunitiesKanban')}>
              View All <ArrowUpRight size={12} />
            </button>
          </div>
          <div className="csd-card-body csd-top-opps">
            {topOpps.map((o, i) => {
              const color = STAGE_COLORS[o.stage] || '#6b7280';
              return (
                <div key={o.id || i} className="csd-opp-row">
                  <div className="csd-opp-rank">{i + 1}</div>
                  <div className="csd-opp-info">
                    <span className="csd-opp-name">{o.opportunity_name}</span>
                    <span className="csd-opp-company">{o.company_name}</span>
                  </div>
                  <div className="csd-opp-right">
                    <span className="csd-opp-val">{fmt(o.expected_value)}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="csd-badge" style={{ background: color + '20', color }}>{o.stage}</span>
                      <span className="csd-opp-pct">{o.probability_percentage}%</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* quick nav cards */}
        <div className="csd-fc12 csd-nav-cards">
          {[
            { label: 'Leads',         sub: `${s.total_leads || 0} total`,  page: 'Leads',               color: '#6366f1', Icon: Users },
            { label: 'Pipeline',      sub: fmt(s.pipeline_value),          page: 'OpportunitiesKanban', color: '#3b82f6', Icon: TrendingUp },
            { label: 'Accounts',      sub: 'All companies',                page: 'Accounts',            color: '#10b981', Icon: CheckCircle },
            { label: 'Contacts',      sub: 'All contacts',                 page: 'Contacts',            color: '#f59e0b', Icon: Target },
          ].map(({ label, sub, page, color, Icon }) => (
            <div key={label} className="csd-nav-card" onClick={() => setPage && setPage(page)} style={{ '--c': color }}>
              <div className="csd-nav-icon"><Icon size={20} /></div>
              <span className="csd-nav-label">{label}</span>
              <span className="csd-nav-sub">{sub}</span>
              <ChevronRight size={14} className="csd-nav-arrow" />
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}
