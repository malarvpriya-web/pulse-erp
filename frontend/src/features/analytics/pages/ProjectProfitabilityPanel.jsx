// frontend/src/features/analytics/pages/ProjectProfitabilityPanel.jsx
// Phase 49H — Project Intelligence (Section 9) + Profitability Center (Section 10)
import { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from 'recharts';
import { Briefcase, TrendingDown, AlertTriangle, CheckCircle, IndianRupee } from 'lucide-react';

const fmtL = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};
const fmtPct = n => `${parseFloat(n || 0).toFixed(1)}%`;
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const C = {
  primary: '#6B3FDB', green: '#16a34a', red: '#dc2626',
  amber: '#d97706', blue: '#2563eb', border: '#e9e4ff', cyan: '#0891b2',
};

const HEALTH_CFG = {
  'On Track':     { bg: '#dcfce7', color: C.green,   border: '#86efac' },
  'At Risk':      { bg: '#fef3c7', color: '#92400e', border: '#fcd34d' },
  'Margin Watch': { bg: '#fef9c3', color: '#78350f', border: '#fde68a' },
  'Critical':     { bg: '#fee2e2', color: C.red,     border: '#fca5a5' },
};

function KpiCard({ label, value, sub, color, icon: Icon, warn }) {
  const ac = warn ? C.red : (color || C.primary);
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '16px 18px', borderLeft: `4px solid ${ac}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        {Icon && <div style={{ width: 30, height: 30, borderRadius: 8, background: `${ac}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={15} color={ac} /></div>}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: ac, marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function ProjectTable({ projects, title, emptyMsg }) {
  if (!projects || projects.length === 0) {
    return (
      <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: 32, textAlign: 'center', color: '#9ca3af' }}>
        <CheckCircle size={24} color={C.green} style={{ marginBottom: 8 }} />
        <div style={{ fontSize: 13 }}>{emptyMsg || 'No projects in this category'}</div>
      </div>
    );
  }
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid #f3f4f6', fontSize: 13, fontWeight: 700, color: '#374151' }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['Project', 'Customer', 'Contract', 'Cost', 'Profit', 'Margin', 'Status', 'Health'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: '#6b7280', fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map((p, i) => {
              const hCfg = HEALTH_CFG[p.health_label] || HEALTH_CFG['On Track'];
              return (
                <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6', background: p.is_loss_making ? '#fff5f5' : i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '8px 12px' }}>
                    <div style={{ fontWeight: 700, color: '#111827', fontSize: 12 }}>{p.name}</div>
                    {p.code && <div style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'monospace' }}>{p.code}</div>}
                  </td>
                  <td style={{ padding: '8px 12px', color: '#374151', fontSize: 11 }}>{p.customer_name || '—'}</td>
                  <td style={{ padding: '8px 12px', fontWeight: 700, color: C.primary }}>{fmtL(p.contract_value)}</td>
                  <td style={{ padding: '8px 12px', color: '#374151' }}>{fmtL(p.actual_cost)}</td>
                  <td style={{ padding: '8px 12px', fontWeight: 700, color: p.profit >= 0 ? C.green : C.red }}>{fmtL(p.profit)}</td>
                  <td style={{ padding: '8px 12px', fontWeight: 700, color: p.margin_pct >= 20 ? C.green : p.margin_pct >= 10 ? C.blue : p.margin_pct >= 0 ? C.amber : C.red }}>
                    {fmtPct(p.margin_pct)}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <span style={{ fontSize: 11, color: '#374151', textTransform: 'capitalize' }}>{p.status}</span>
                    {p.is_delayed && <span style={{ marginLeft: 4, fontSize: 10, color: C.red, fontWeight: 700 }}>DELAYED</span>}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: hCfg.bg, color: hCfg.color }}>
                      {p.health_label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ProjectProfitabilityPanel({ data }) {
  const [view, setView] = useState('overview');
  const summary     = data?.summary      || {};
  const projects    = data?.projects     || [];
  const topProfit   = data?.top_profitable || [];
  const lossMaking  = data?.loss_making   || [];
  const overBudget  = data?.over_budget   || [];
  const delayed     = data?.delayed       || [];
  const costBreak   = data?.cost_breakdown || [];

  // Health distribution for pie
  const healthDist = ['On Track', 'At Risk', 'Margin Watch', 'Critical'].map(label => ({
    label,
    count: projects.filter(p => p.health_label === label).length,
    fill: Object.values(HEALTH_CFG).find((_, i) => ['On Track','At Risk','Margin Watch','Critical'][i] === label)?.color || '#9ca3af',
  })).filter(d => d.count > 0);

  // Budget vs Actual for top projects
  const budgetChart = projects.slice(0, 8).map(p => ({
    name: p.name?.slice(0, 20) + (p.name?.length > 20 ? '…' : ''),
    budget: p.budget,
    actual: p.actual_cost,
    contract: p.contract_value,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* KPI Cards */}
      <div>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginBottom: 16 }}>Project Intelligence & Profitability Center</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
          <KpiCard label="Active Projects" value={summary.active_projects || 0} color={C.primary} icon={Briefcase} />
          <KpiCard label="Delayed Projects" value={summary.delayed_count || 0} color={C.red} icon={AlertTriangle} warn={summary.delayed_count > 0} />
          <KpiCard label="Over Budget" value={summary.over_budget_count || 0} color={C.amber} icon={TrendingDown} warn={summary.over_budget_count > 0} />
          <KpiCard label="Loss-Making" value={summary.loss_making_count || 0} color={C.red} icon={IndianRupee} warn={summary.loss_making_count > 0} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <KpiCard label="Total Contract Value" value={fmtL(summary.total_contract_value)} color={C.primary} />
          <KpiCard label="Total Cost" value={fmtL(summary.total_actual_cost)} color={C.blue} />
          <KpiCard label="Total Profit" value={fmtL(summary.total_profit)} color={summary.total_profit >= 0 ? C.green : C.red} warn={summary.total_profit < 0} />
          <KpiCard label="Portfolio Margin" value={fmtPct(summary.portfolio_margin_pct)} color={summary.portfolio_margin_pct >= 15 ? C.green : summary.portfolio_margin_pct >= 5 ? C.amber : C.red} />
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 8 }}>
        {[['overview','Overview'], ['profitable','Top Profitable'], ['loss','Loss-Making'], ['overbudget','Over Budget'], ['delayed','Delayed']].map(([id, lbl]) => (
          <button key={id} onClick={() => setView(id)} style={{
            padding: '7px 16px', borderRadius: 8, border: `1px solid ${view === id ? C.primary : C.border}`,
            background: view === id ? C.primary : '#fff', color: view === id ? '#fff' : '#374151',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>{lbl}</button>
        ))}
      </div>

      {view === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 16 }}>
            {/* Budget vs Actual Chart */}
            <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 20px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Budget vs Actual Cost — Top Projects</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={budgetChart} layout="vertical" barSize={12} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
                  <XAxis type="number" tickFormatter={v => fmtL(v)} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={120} />
                  <Tooltip formatter={v => fmtL(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="contract" fill={C.primary} name="Contract" radius={[0,4,4,0]} />
                  <Bar dataKey="actual" fill={C.amber} name="Actual Cost" radius={[0,4,4,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Health pie */}
            <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: '18px 20px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Project Health</div>
              <PieChart width={220} height={180}>
                <Pie data={healthDist} dataKey="count" nameKey="label" cx="50%" cy="50%" outerRadius={70} innerRadius={40}>
                  {healthDist.map(d => <Cell key={d.label} fill={d.fill} />)}
                </Pie>
                <Tooltip />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              </PieChart>

              {/* Cost breakdown mini */}
              {costBreak.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase' }}>Cost Breakdown</div>
                  {costBreak.slice(0, 5).map(cb => (
                    <div key={cb.cost_type} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: '#374151' }}>{cb.cost_type}</span>
                      <span style={{ fontWeight: 700, color: C.primary }}>{fmtL(cb.total)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <ProjectTable projects={projects.slice(0, 10)} title="All Projects Overview" />
        </div>
      )}

      {view === 'profitable' && (
        <ProjectTable projects={topProfit} title="Top Profitable Projects" emptyMsg="No project profit data available" />
      )}

      {view === 'loss' && (
        <div>
          {lossMaking.length > 0 && (
            <div style={{ background: '#fff5f5', border: `1px solid #fca5a5`, borderRadius: 12, padding: '12px 16px', marginBottom: 14, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <AlertTriangle size={15} color={C.red} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12, color: '#991b1b' }}>
                <strong>{lossMaking.length} loss-making projects detected.</strong> Total loss: {fmtL(lossMaking.reduce((s, p) => s + p.profit, 0))}.
                Immediate project director review required for each. Consider change order or scope renegotiation.
              </div>
            </div>
          )}
          <ProjectTable projects={lossMaking} title="Loss-Making Projects" emptyMsg="No loss-making projects — portfolio is profitable" />
        </div>
      )}

      {view === 'overbudget' && (
        <ProjectTable projects={overBudget} title="Over Budget Projects" emptyMsg="All projects are within budget" />
      )}

      {view === 'delayed' && (
        <ProjectTable projects={delayed} title="Delayed Projects" emptyMsg="All projects are on schedule" />
      )}
    </div>
  );
}
