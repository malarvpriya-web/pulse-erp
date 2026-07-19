import { useEffect, useState, useCallback } from 'react';
import api from '@/services/api/client';
import '@/components/dashboard/dashkit.css';

const P = '#6B3FDB';
const LIGHT = '#f5f3ff';
const BORDER = '#e9e4ff';

const money = (n) =>
  `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const pct = (n) => `${parseFloat(n || 0).toFixed(1)}%`;
const cr = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return money(v);
};

const COST_COLORS = {
  MATERIAL: '#6B3FDB', ENGINEERING: '#2563eb', PRODUCTION: '#0891b2',
  PROCUREMENT: '#0d9488', SALES_TRAVEL: '#d97706', INSTALLATION: '#dc2626',
  COMMISSIONING: '#7c2d12', SERVICE: '#9f1239', AMC: '#065f46',
  QUALITY: '#6d28d9', FAT: '#4f46e5', TRANSPORT: '#0369a1',
  LABOUR: '#1d4ed8', INVENTORY: '#047857', APPLICATION_ENGINEERING: '#b45309',
  OTHER: '#6b7280',
};

function KPICard({ label, value, sub, color = P, warn, index = 0 }) {
  return (
    <div className="dk-anim" style={{
      background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 11,
      padding: '12px 14px', borderLeft: `4px solid ${warn ? '#dc2626' : color}`, '--dk-i': index,
    }}>
      <div style={{ fontSize: 11.5, color: '#6b7280', fontWeight: 500, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: warn ? '#dc2626' : '#111', letterSpacing: '-0.5px' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function MiniBar({ value, max, color }) {
  const pctVal = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ background: '#f3f4f6', borderRadius: 4, height: 6, width: '100%', marginTop: 4 }}>
      <div style={{ width: `${pctVal}%`, background: color || P, height: '100%', borderRadius: 4, transition: 'width .4s' }} />
    </div>
  );
}

const TABS = ['Overview', 'Projects', 'Cost Breakdown', 'Revenue vs Cost', 'Over Budget', 'Loss Projects'];

export default function ProjectProfitabilityDashboard({ setPage }) {
  const [tab, setTab]         = useState('Overview');
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [sortBy, setSortBy]   = useState('profit');
  const [sortDir, setSortDir] = useState('desc');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/project-cost-engine/dashboard');
      setData(res.data);
    } catch {
      try {
        const res = await api.get('/project-profitability/dashboard-kpis');
        setData({ kpis: { ...res.data, total_contract_value: res.data.total_revenue }, projects: [] });
      } catch { setData(null); }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading profitability data…</div>;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: '#dc2626' }}>Failed to load data.</div>;

  const kpis     = data.kpis || {};
  const projects = (data.projects || []).filter(p =>
    !search ||
    p.project_name?.toLowerCase().includes(search.toLowerCase()) ||
    p.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
    p.project_code?.toLowerCase().includes(search.toLowerCase())
  );

  const sorted = [...projects].sort((a, b) => {
    const va = parseFloat(a[sortBy] || 0);
    const vb = parseFloat(b[sortBy] || 0);
    return sortDir === 'asc' ? va - vb : vb - va;
  });

  const costTypes = data.cost_type_breakdown || [];
  const maxCost   = costTypes[0]?.total || 1;

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };
  const sortIcon = (col) => sortBy === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div style={{ padding: '16px 18px 20px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111' }}>Project Profitability Dashboard</h2>
          <p style={{ margin: '3px 0 0', color: '#6b7280', fontSize: 12.5 }}>Real-time cost &amp; revenue across all projects</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setPage?.('CostTransactions')} style={{ padding: '8px 14px', background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 8, color: P, fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
            Cost Transactions
          </button>
          <button onClick={() => setPage?.('CostCentreTracking')} style={{ padding: '8px 14px', background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 8, color: P, fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
            Cost Centres
          </button>
          <button onClick={() => setPage?.('CEOCommandCenter')} style={{ padding: '8px 14px', background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 8, color: P, fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
            CEO View
          </button>
          <button onClick={load} style={{ padding: '8px 14px', background: P, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10, marginBottom: 14 }}>
        <KPICard index={0} label="Total Contract Value"  value={cr(kpis.total_contract_value)} sub={`${kpis.total_projects || 0} projects`} />
        <KPICard index={1} label="Total Project Cost"    value={cr(kpis.total_cost)}           sub="All modules combined" />
        <KPICard index={2} label="Total Invoiced"        value={cr(kpis.total_invoiced)}        sub="Revenue billed" />
        <KPICard index={3} label="Total Profit"          value={cr(kpis.total_profit)} warn={parseFloat(kpis.total_profit || 0) < 0} sub="Revenue − Cost" />
        <KPICard index={4} label="Avg Margin"            value={pct(kpis.avg_margin_pct)} warn={parseFloat(kpis.avg_margin_pct || 0) < 10} color="#059669" />
        <KPICard index={5} label="Over Budget"           value={kpis.over_budget_count || 0}  warn={(kpis.over_budget_count || 0) > 0} sub="exceeded budget" color="#dc2626" />
        <KPICard index={6} label="Loss Projects"         value={kpis.loss_projects || 0}       warn={(kpis.loss_projects || 0) > 0} sub="negative margin" color="#dc2626" />
        <KPICard index={7} label="Active Projects"       value={kpis.active_projects || 0}     sub={`of ${kpis.total_projects || 0} total`} />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `2px solid ${BORDER}`, marginBottom: 12, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', border: 'none', background: 'none', whiteSpace: 'nowrap',
            borderBottom: tab === t ? `2px solid ${P}` : '2px solid transparent',
            color: tab === t ? P : '#6b7280', fontWeight: tab === t ? 600 : 400,
            cursor: 'pointer', fontSize: 13, marginBottom: -2,
          }}>{t}</button>
        ))}
      </div>

      {/* ── Overview ── */}
      {tab === 'Overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
          {/* Top Profitable */}
          <div className="dk-anim" style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 11, padding: 13, '--dk-i': 8 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8, color: '#111' }}>Top 5 Profitable Projects</div>
            {(data.top_profitable || sorted.slice(0, 5)).slice(0, 5).map((p, i) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < 4 ? '1px solid #f3f4f6' : 'none' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.project_code} — {p.project_name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{p.customer_name}</div>
                </div>
                <div style={{ textAlign: 'right', marginLeft: 12, flexShrink: 0 }}>
                  <div style={{ color: '#059669', fontWeight: 700, fontSize: 13 }}>{cr(p.profit)}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{pct(p.margin_pct)} margin</div>
                </div>
              </div>
            ))}
            {!sorted.length && <div style={{ color: '#9ca3af', fontSize: 13 }}>No data yet — run Recalculate on projects first.</div>}
          </div>

          {/* Top Loss */}
          <div className="dk-anim" style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 11, padding: 13, '--dk-i': 9 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8, color: '#111' }}>Top 5 Loss Projects</div>
            {(data.top_loss || [...sorted].sort((a, b) => parseFloat(a.profit || 0) - parseFloat(b.profit || 0)).slice(0, 5)).slice(0, 5).map((p, i) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < 4 ? '1px solid #f3f4f6' : 'none' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.project_code} — {p.project_name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{p.customer_name}</div>
                </div>
                <div style={{ textAlign: 'right', marginLeft: 12, flexShrink: 0 }}>
                  <div style={{ color: '#dc2626', fontWeight: 700, fontSize: 13 }}>{cr(p.profit)}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{pct(p.margin_pct)}</div>
                </div>
              </div>
            ))}
            {!sorted.length && <div style={{ color: '#9ca3af', fontSize: 13 }}>No data yet.</div>}
          </div>

          {/* Over Budget */}
          <div className="dk-anim" style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 11, padding: 13, '--dk-i': 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13.5, color: '#111' }}>Projects Over Budget</span>
              {(data.over_budget_projects || []).length > 0 && (
                <span style={{ background: '#fef2f2', color: '#dc2626', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>
                  {(data.over_budget_projects || []).length}
                </span>
              )}
            </div>
            {(data.over_budget_projects || []).slice(0, 5).map((p, i) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < 4 ? '1px solid #f3f4f6' : 'none' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.project_name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>Budget: {cr(p.budget)}</div>
                </div>
                <div style={{ textAlign: 'right', marginLeft: 12, flexShrink: 0 }}>
                  <div style={{ color: '#dc2626', fontWeight: 700, fontSize: 13 }}>+{cr(p.overrun)}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>Actual: {cr(p.actual_cost)}</div>
                </div>
              </div>
            ))}
            {!(data.over_budget_projects || []).length && (
              <div style={{ color: '#059669', fontSize: 13 }}>✓ All projects within budget</div>
            )}
          </div>

          {/* Cost Breakdown chart */}
          <div className="dk-anim" style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 11, padding: 13, '--dk-i': 11 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 8, color: '#111' }}>Cost Breakdown by Type</div>
            {costTypes.slice(0, 8).map(ct => (
              <div key={ct.cost_type} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#374151' }}>
                  <span>{ct.cost_type.replace(/_/g, ' ')}</span>
                  <span style={{ fontWeight: 600 }}>{cr(ct.total)}</span>
                </div>
                <MiniBar value={ct.total} max={maxCost} color={COST_COLORS[ct.cost_type] || P} />
              </div>
            ))}
            {!costTypes.length && (
              <div style={{ color: '#9ca3af', fontSize: 13 }}>No cost transactions yet. Add entries via Cost Transactions.</div>
            )}
          </div>
        </div>
      )}

      {/* ── Projects Table ── */}
      {tab === 'Projects' && (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>All Projects — Profitability ({sorted.length})</div>
            <input
              placeholder="Search project / customer…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ padding: '6px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, width: 260 }}
            />
          </div>
          <div style={{ overflowX: 'auto', maxHeight: '52vh', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {[
                    ['project_code','Code'],['project_name','Project'],['customer_name','Customer'],
                    ['contract_value','Contract'],['total_cost','Actual Cost'],['invoiced','Invoiced'],
                    ['profit','Profit'],['margin_pct','Margin %'],['status','Status'],
                  ].map(([col, label]) => (
                    <th key={col} onClick={() => handleSort(col)}
                      style={{ padding: '9px 12px', textAlign: 'left', color: '#374151', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none', position: 'sticky', top: 0, background: '#fafafa', borderBottom: `1px solid ${BORDER}`, zIndex: 1 }}>
                      {label}{sortIcon(col)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((p, i) => {
                  const isLoss = parseFloat(p.profit || 0) < 0;
                  const isOB   = parseFloat(p.total_cost || 0) > parseFloat(p.contract_value || 0) * 1.05;
                  return (
                    <tr key={p.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa', borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '9px 12px', fontWeight: 600, color: P }}>{p.project_code}</td>
                      <td style={{ padding: '9px 12px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.project_name}</td>
                      <td style={{ padding: '9px 12px', color: '#374151' }}>{p.customer_name}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' }}>{cr(p.contract_value)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: isOB ? '#dc2626' : '#374151', fontWeight: isOB ? 600 : 400 }}>{cr(p.total_cost)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' }}>{cr(p.invoiced)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: isLoss ? '#dc2626' : '#059669', fontWeight: 600 }}>{cr(p.profit)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: isLoss ? '#dc2626' : '#059669', fontWeight: 600 }}>{pct(p.margin_pct)}</td>
                      <td style={{ padding: '9px 12px' }}>
                        <span style={{
                          background: p.status === 'active' ? '#f0fdf4' : p.status === 'completed' ? LIGHT : '#fef9c3',
                          color: p.status === 'active' ? '#059669' : p.status === 'completed' ? P : '#92400e',
                          borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 500,
                        }}>{p.status}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!sorted.length && (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
                {search ? 'No projects match search.' : 'No project cost data. Run Recalculate on a project to populate this view.'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Cost Breakdown ── */}
      {tab === 'Cost Breakdown' && (
        <div>
          {costTypes.length === 0 ? (
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              No cost transactions recorded yet. Add entries via Cost Transactions or capture from modules.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {costTypes.map(ct => {
                const sharePct = parseFloat(kpis.total_cost || 0) > 0
                  ? ((ct.total / parseFloat(kpis.total_cost)) * 100).toFixed(1)
                  : 0;
                return (
                  <div key={ct.cost_type} style={{
                    background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
                    padding: 14, borderLeft: `4px solid ${COST_COLORS[ct.cost_type] || P}`,
                  }}>
                    <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>{ct.cost_type.replace(/_/g, ' ')}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#111', marginTop: 4 }}>{cr(ct.total)}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sharePct}% of total cost</div>
                    <MiniBar value={ct.total} max={maxCost} color={COST_COLORS[ct.cost_type] || P} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Revenue vs Cost ── */}
      {tab === 'Revenue vs Cost' && (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, maxHeight: '62vh', overflowY: 'auto' }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 12 }}>Revenue vs Cost — Per Project (Top 20)</div>
          {sorted.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No data to display.</div>
          ) : sorted.slice(0, 20).map(p => {
            const rev  = parseFloat(p.contract_value || 0);
            const cost = parseFloat(p.total_cost || 0);
            const maxV = Math.max(rev, cost, 1);
            const isLoss = cost > rev;
            return (
              <div key={p.id} style={{ marginBottom: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ fontWeight: 500 }}>{p.project_code} — {p.project_name}</span>
                  <span style={{ color: isLoss ? '#dc2626' : '#059669', fontWeight: 600 }}>
                    {isLoss ? '▼' : '▲'} {pct(p.margin_pct)}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11 }}>
                  <span style={{ width: 60, color: '#6b7280', textAlign: 'right', flexShrink: 0 }}>Revenue</span>
                  <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 4, height: 14, overflow: 'hidden' }}>
                    <div style={{ width: `${(rev / maxV) * 100}%`, background: P, height: '100%', borderRadius: 4 }} />
                  </div>
                  <span style={{ width: 80, textAlign: 'right', fontWeight: 600, flexShrink: 0 }}>{cr(rev)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, marginTop: 3 }}>
                  <span style={{ width: 60, color: '#6b7280', textAlign: 'right', flexShrink: 0 }}>Cost</span>
                  <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 4, height: 14, overflow: 'hidden' }}>
                    <div style={{ width: `${(cost / maxV) * 100}%`, background: isLoss ? '#dc2626' : '#2563eb', height: '100%', borderRadius: 4 }} />
                  </div>
                  <span style={{ width: 80, textAlign: 'right', color: isLoss ? '#dc2626' : '#111', fontWeight: 600, flexShrink: 0 }}>{cr(cost)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Over Budget ── */}
      {tab === 'Over Budget' && (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, fontWeight: 600, fontSize: 14, color: '#dc2626' }}>
            Projects Over Budget ({(data.over_budget_projects || []).length})
          </div>
          <div style={{ overflowX: 'auto', maxHeight: '58vh', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Project', 'Customer', 'Budget', 'Actual Cost', 'Overrun', '% Over'].map(h => (
                    <th key={h} style={{ padding: '9px 12px', textAlign: h === 'Project' || h === 'Customer' ? 'left' : 'right', fontWeight: 600, color: '#374151', position: 'sticky', top: 0, background: '#fafafa', borderBottom: `1px solid ${BORDER}`, zIndex: 1 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.over_budget_projects || sorted.filter(p => parseFloat(p.total_cost || 0) > parseFloat(p.contract_value || 0) * 1.05)).map((p, i) => {
                  const budget = parseFloat(p.budget || p.contract_value || 0);
                  const actual = parseFloat(p.actual_cost || p.total_cost || 0);
                  const overrun = parseFloat(p.overrun || Math.max(0, actual - budget));
                  const overPct = budget > 0 ? ((overrun / budget) * 100).toFixed(1) : 0;
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ padding: '9px 12px', fontWeight: 500 }}>{p.project_name || p.project_code}</td>
                      <td style={{ padding: '9px 12px', color: '#374151' }}>{p.customer_name}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' }}>{cr(budget)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: '#dc2626' }}>{cr(actual)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: '#dc2626', fontWeight: 600 }}>+{cr(overrun)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: '#dc2626', fontWeight: 600 }}>+{overPct}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!(data.over_budget_projects?.length) && !(sorted.filter(p => parseFloat(p.total_cost || 0) > parseFloat(p.contract_value || 0) * 1.05).length) && (
              <div style={{ padding: 40, textAlign: 'center', color: '#059669' }}>✓ All projects are within budget</div>
            )}
          </div>
        </div>
      )}

      {/* ── Loss Projects ── */}
      {tab === 'Loss Projects' && (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, fontWeight: 600, fontSize: 14, color: '#dc2626' }}>
            Projects with Negative Margin
          </div>
          <div style={{ overflowX: 'auto', maxHeight: '58vh', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Project', 'Customer', 'Revenue', 'Total Cost', 'Loss', 'Margin %'].map(h => (
                    <th key={h} style={{ padding: '9px 12px', textAlign: h === 'Project' || h === 'Customer' ? 'left' : 'right', fontWeight: 600, color: '#374151', position: 'sticky', top: 0, background: '#fafafa', borderBottom: `1px solid ${BORDER}`, zIndex: 1 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.negative_margin || sorted.filter(p => parseFloat(p.margin_pct || 0) < 0))
                  .sort((a, b) => parseFloat(a.margin_pct || 0) - parseFloat(b.margin_pct || 0))
                  .map((p, i) => (
                    <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ padding: '9px 12px', fontWeight: 500 }}>{p.project_name || p.project_code}</td>
                      <td style={{ padding: '9px 12px' }}>{p.customer_name}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' }}>{cr(p.contract_value || p.revenue)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' }}>{cr(p.total_cost)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: '#dc2626', fontWeight: 700 }}>{cr(p.profit)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: '#dc2626', fontWeight: 700 }}>{pct(p.margin_pct)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!(data.negative_margin?.length) && !(sorted.filter(p => parseFloat(p.margin_pct || 0) < 0).length) && (
              <div style={{ padding: 40, textAlign: 'center', color: '#059669' }}>✓ No loss projects</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
