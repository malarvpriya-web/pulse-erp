// PATH: frontend/src/features/projects/pages/CEOCommandCenter.jsx
// Single-viewport CEO Command Center — fixed-height (fit-the-window) layout:
// compact header + 8-KPI strip + tabs, with the active tab filling the
// remaining space. Cards scroll internally (sticky table headers) and every
// section is expandable to a full-size modal, so the page itself never scrolls.
import { useEffect, useState, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import '@/components/dashboard/dashkit.css';

const P = '#6B3FDB';
const LIGHT = '#f5f3ff';
const BORDER = '#e9e4ff';

const cr = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};
const pct = (n) => `${parseFloat(n || 0).toFixed(1)}%`;

const TABS = ['Overview', 'Top 10 Projects', 'Most Expensive', 'Most Profitable', 'Collections', 'Cost Breakdown', 'Top Customers', 'Top Vendors'];

const fmtINR = n => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN')}`;
};

/* ── compact KPI tile ── */
function Kpi({ label, value, sub, color = '#374151', warn, i = 0 }) {
  return (
    <div className="dk-anim" style={{
      '--dk-i': i, background: '#fff', border: `1px solid ${BORDER}`,
      borderLeft: `3px solid ${warn ? '#dc2626' : color}`, borderRadius: 10,
      padding: '7px 10px', minWidth: 0,
    }}>
      <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: warn ? '#dc2626' : color, letterSpacing: '-0.3px', whiteSpace: 'nowrap', lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
  );
}

function AlertBadge({ count, label, color = '#dc2626' }) {
  if (!count) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', background: `${color}14`, border: `1px solid ${color}44`, borderRadius: 8, fontSize: 11.5, color, fontWeight: 600, whiteSpace: 'nowrap' }}>
      ⚠ {count} {label}
    </span>
  );
}

/* ── fill-height card: header w/ expand, body scrolls internally ── */
function Panel({ title, sub, titleColor = '#111', children, i = 0, style, expandable = true }) {
  return (
    <div className="dk-anim" style={{
      '--dk-i': i, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12,
      display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', ...style,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 14px 7px', flexShrink: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: titleColor }}>{title}</span>
        {expandable && <ChartExpandButton title={title} subtitle={sub}>{children}</ChartExpandButton>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 14px 12px' }}>{children}</div>
    </div>
  );
}

/* ── fill-height table card with sticky header + expand ── */
function TableCard({ title, titleColor = '#111', children, i = 0, style }) {
  return (
    <div className="dk-anim" style={{
      '--dk-i': i, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12,
      display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', height: '100%', ...style,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 14px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: titleColor }}>{title}</span>
        <ChartExpandButton title={title}>{children}</ChartExpandButton>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
    </div>
  );
}

const th = (align = 'left') => ({
  padding: '8px 12px', textAlign: align, fontWeight: 600, color: '#374151',
  whiteSpace: 'nowrap', fontSize: 11.5, position: 'sticky', top: 0,
  background: '#fafafa', zIndex: 1, borderBottom: `1px solid ${BORDER}`,
});
const td = { padding: '6px 12px', fontSize: 12 };

function HealthBars({ rows, total }) {
  return (
    <div>
      {rows.map(({ label, count, color }) => {
        const w = total > 0 ? Math.round((count / total) * 100) : 0;
        return (
          <div key={label} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{label}</span>
              <span style={{ fontSize: 11.5, fontWeight: 700, color }}>{count} ({w}%)</span>
            </div>
            <div style={{ background: '#f3f4f6', borderRadius: 5, height: 10, overflow: 'hidden' }}>
              <div style={{ width: `${w}%`, background: color, height: '100%', borderRadius: 5, transition: 'width .4s' }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function CEOCommandCenter({ setPage }) {
  const toast = useToast();
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]       = useState('Overview');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [customerData, setCustomerData] = useState(null);
  const [vendorData, setVendorData]     = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/project-cost-engine/ceo-command-center');
      setData(res.data);
      setLastUpdated(new Date());
    } catch {
      // Fallback to dashboard data
      try {
        const res = await api.get('/project-cost-engine/dashboard');
        const d = res.data;
        setData({
          revenue_this_month:    0,
          total_invoiced:        d.kpis?.total_invoiced || 0,
          total_order_value:     d.kpis?.total_contract_value || 0,
          total_actual_cost:     d.kpis?.total_cost || 0,
          total_profit:          d.kpis?.total_profit || 0,
          portfolio_margin_pct:  d.kpis?.avg_margin_pct || 0,
          loss_projects:         d.kpis?.loss_projects || 0,
          over_budget_projects:  d.kpis?.over_budget_count || 0,
          outstanding_collection: 0,
          total_projects:        d.kpis?.total_projects || 0,
          active_projects:       d.kpis?.active_projects || 0,
          top_10_projects:       (d.projects || []).slice(0, 10),
          most_expensive:        (d.projects || []).sort((a, b) => parseFloat(b.total_cost || 0) - parseFloat(a.total_cost || 0)).slice(0, 10),
          most_profitable:       d.top_profitable || (d.projects || []).slice(0, 10),
          cost_breakdown:        d.cost_type_breakdown || [],
          status_breakdown:      [],
          overdue_invoices:      0,
          billed_projects:       0,
        });
        setLastUpdated(new Date());
      } catch { setData(null); }
    } finally { setLoading(false); }

    // Load customer + vendor 360 intelligence
    try { const r = await api.get('/crm/ceo360/customers'); setCustomerData(r.data); } catch (err) { toast.error(err?.response?.data?.error || 'Could not load customer intelligence'); }
    try { const r = await api.get('/crm/ceo360/vendors');   setVendorData(r.data);   } catch (err) { toast.error(err?.response?.data?.error || 'Could not load vendor intelligence'); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading CEO Command Center…</div>;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: '#dc2626' }}>Failed to load command center data.</div>;

  const margin = parseFloat(data.portfolio_margin_pct || 0);
  const maxCostType = (data.cost_breakdown || [])[0]?.total || 1;

  return (
    /* fixed viewport shell: 64px topbar + 2×20px .page-content padding */
    <div style={{ height: 'calc(100vh - 104px)', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>

      {/* Header — title + alerts + actions in one row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap', flexShrink: 0 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#111', letterSpacing: '-0.4px', lineHeight: 1.2 }}>CEO Command Center</h2>
          <p style={{ margin: '2px 0 0', color: '#6b7280', fontSize: 11.5 }}>
            Revenue · Cost · Profitability · Collections
            {lastUpdated && ` · Updated ${lastUpdated.toLocaleTimeString()}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <AlertBadge count={data.loss_projects} label="loss-making" />
          <AlertBadge count={data.over_budget_projects} label="over budget" color="#d97706" />
          <AlertBadge count={data.overdue_invoices} label="overdue invoices" />
          <button className="dk-btn" onClick={() => setPage?.('ProjectProfitabilityDashboard')}>Profitability</button>
          <button className="dk-btn" onClick={() => setPage?.('ProjectRevenueSummary')}>Revenue Summary</button>
          <button className="dk-btn primary" onClick={load}>↻ Refresh</button>
        </div>
      </div>

      {/* Primary KPI strip — single compact row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 8, marginBottom: 10, flexShrink: 0 }}>
        <Kpi i={0} label="Revenue (Month)"  value={cr(data.revenue_this_month)} color={P} />
        <Kpi i={1} label="Order Value"      value={cr(data.total_order_value)} />
        <Kpi i={2} label="Invoiced"         value={cr(data.total_invoiced)} color="#2563eb" />
        <Kpi i={3} label="Actual Cost"      value={cr(data.total_actual_cost)} />
        <Kpi i={4} label="Profit"           value={cr(data.total_profit)} warn={parseFloat(data.total_profit || 0) < 0} color="#059669" />
        <Kpi i={5} label="Margin"           value={pct(margin)} warn={margin < 10} color={margin >= 20 ? '#059669' : margin >= 10 ? '#d97706' : '#dc2626'} />
        <Kpi i={6} label="Outstanding"      value={cr(data.outstanding_collection)} warn={(data.outstanding_collection || 0) > 0} color="#dc2626" />
        <Kpi i={7} label="Active Projects"  value={data.active_projects || 0} sub={`of ${data.total_projects || 0} total`} />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, borderBottom: `2px solid ${BORDER}`, marginBottom: 10, overflowX: 'auto', flexShrink: 0 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '6px 13px', border: 'none', background: 'none', whiteSpace: 'nowrap',
            borderBottom: tab === t ? `2px solid ${P}` : '2px solid transparent',
            color: tab === t ? P : '#6b7280', fontWeight: tab === t ? 600 : 400,
            cursor: 'pointer', fontSize: 12.5, marginBottom: -2,
          }}>{t}</button>
        ))}
      </div>

      {/* Tab content — fills the remaining viewport, never scrolls the page */}
      <div style={{ flex: 1, minHeight: 0 }}>

        {/* ── Overview ── */}
        {tab === 'Overview' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 10, height: '100%', minHeight: 0 }}>
            {/* Project Status Breakdown */}
            <Panel title="Project Status Breakdown" i={0}>
              {(data.status_breakdown || []).map(s => {
                const colors = { active: '#059669', completed: P, planning: '#d97706', 'on-hold': '#6b7280', cancelled: '#dc2626' };
                return (
                  <div key={s.status} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                      <span style={{ fontWeight: 500, color: '#111', textTransform: 'capitalize' }}>{s.status}</span>
                      <span style={{ color: '#374151' }}>{s.count} projects · {cr(s.value)}</span>
                    </div>
                    <div style={{ background: '#f3f4f6', borderRadius: 4, height: 7, overflow: 'hidden' }}>
                      <div style={{ width: `${(s.count / (data.total_projects || 1)) * 100}%`, background: colors[s.status] || '#9ca3af', height: '100%', borderRadius: 4 }} />
                    </div>
                  </div>
                );
              })}
              {!(data.status_breakdown || []).length && (
                <div style={{ color: '#9ca3af', fontSize: 13 }}>No status data.</div>
              )}
            </Panel>

            {/* Revenue vs Cost vs Profit */}
            <Panel title="Portfolio Financials" i={1}>
              {[
                { label: 'Total Order Value',   value: parseFloat(data.total_order_value || 0),  color: P },
                { label: 'Total Actual Cost',   value: parseFloat(data.total_actual_cost || 0),  color: '#2563eb' },
                { label: 'Total Invoiced',      value: parseFloat(data.total_invoiced || 0),      color: '#0891b2' },
                { label: 'Total Profit',        value: parseFloat(data.total_profit || 0),        color: parseFloat(data.total_profit || 0) < 0 ? '#dc2626' : '#059669' },
              ].map(item => {
                const maxV = parseFloat(data.total_order_value || 1);
                const w = maxV > 0 ? Math.min(100, Math.abs(item.value) / maxV * 100) : 0;
                return (
                  <div key={item.label} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                      <span style={{ color: '#374151' }}>{item.label}</span>
                      <span style={{ fontWeight: 700, color: item.color }}>{cr(item.value)}</span>
                    </div>
                    <div style={{ background: '#f3f4f6', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                      <div style={{ width: `${w}%`, background: item.color, height: '100%', borderRadius: 4 }} />
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${BORDER}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                  <span style={{ color: '#6b7280' }}>Portfolio Margin</span>
                  <span style={{ fontSize: 18, fontWeight: 800, color: margin < 10 ? '#dc2626' : '#059669' }}>{pct(margin)}</span>
                </div>
              </div>
            </Panel>

            {/* Collections */}
            <Panel title="Collections" i={2}>
              {[
                { label: 'Total Invoiced',        value: data.total_invoiced,        color: '#2563eb' },
                { label: 'Outstanding',           value: data.outstanding_collection, color: data.outstanding_collection > 0 ? '#dc2626' : '#059669', warn: data.outstanding_collection > 0 },
                { label: 'Overdue Invoices',      value: `${data.overdue_invoices || 0} invoices`, color: (data.overdue_invoices || 0) > 0 ? '#dc2626' : '#059669', raw: true },
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <span style={{ fontSize: 12, color: '#374151' }}>{item.label}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: item.warn ? '#dc2626' : item.color }}>
                    {item.raw ? item.value : cr(item.value)}
                  </span>
                </div>
              ))}
              <div style={{ marginTop: 8, padding: '7px 11px', background: (data.outstanding_collection || 0) > 1000000 ? '#fef2f2' : '#f0fdf4', borderRadius: 8, fontSize: 11.5, color: (data.outstanding_collection || 0) > 1000000 ? '#dc2626' : '#059669' }}>
                {(data.outstanding_collection || 0) > 1000000
                  ? `⚠ Outstanding collections exceed ₹10L — follow up required`
                  : '✓ Collections are within normal range'}
              </div>
            </Panel>

            {/* Loss / Over Budget Alerts */}
            <Panel title="Risk Indicators" i={3}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { label: 'Loss Projects',       value: data.loss_projects || 0,       warn: (data.loss_projects || 0) > 0, sub: 'negative margin' },
                  { label: 'Over Budget',         value: data.over_budget_projects || 0, warn: (data.over_budget_projects || 0) > 0, sub: 'exceeded budget' },
                  { label: 'Overdue Invoices',    value: data.overdue_invoices || 0,     warn: (data.overdue_invoices || 0) > 0, sub: 'past due date' },
                  { label: 'Portfolio Margin',    value: pct(margin),                    warn: margin < 10, sub: margin < 10 ? 'below target' : 'healthy' },
                ].map(item => (
                  <div key={item.label} style={{ padding: '8px 6px', background: item.warn ? '#fef2f2' : '#f0fdf4', borderRadius: 8, textAlign: 'center' }}>
                    <div style={{ fontSize: 10.5, color: '#6b7280', fontWeight: 600, marginBottom: 2 }}>{item.label}</div>
                    <div style={{ fontSize: 17, fontWeight: 800, color: item.warn ? '#dc2626' : '#059669' }}>{item.value}</div>
                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>{item.sub}</div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        )}

        {/* ── Top 10 Projects ── */}
        {tab === 'Top 10 Projects' && (
          <TableCard title="Top 10 Projects by Contract Value">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['#','Project','Customer','Contract Value','Actual Cost','Profit','Margin %','Progress','Status'].map((h, i) => (
                    <th key={h} style={th(i < 3 ? 'left' : 'right')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.top_10_projects || []).map((p, i) => {
                  const isLoss = parseFloat(p.profit || 0) < 0;
                  const isOB   = parseFloat(p.actual_cost || 0) > parseFloat(p.contract_value || 0) * 1.05;
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...td, fontWeight: 700, color: '#9ca3af' }}>#{i+1}</td>
                      <td style={{ ...td, fontWeight: 600, color: P }}>
                        <div>{p.project_code}</div>
                        <div style={{ fontSize: 11, color: '#374151', fontWeight: 400 }}>{p.project_name}</div>
                      </td>
                      <td style={{ ...td, color: '#374151' }}>{p.customer_name}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{cr(p.contract_value)}</td>
                      <td style={{ ...td, textAlign: 'right', color: isOB ? '#dc2626' : '#374151' }}>{cr(p.actual_cost)}</td>
                      <td style={{ ...td, textAlign: 'right', color: isLoss ? '#dc2626' : '#059669', fontWeight: 600 }}>{cr(p.profit)}</td>
                      <td style={{ ...td, textAlign: 'right', color: isLoss ? '#dc2626' : '#059669', fontWeight: 600 }}>{pct(p.margin_pct)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                          <span>{parseFloat(p.progress || 0).toFixed(0)}%</span>
                          <div style={{ width: 40, background: '#f3f4f6', borderRadius: 3, height: 6 }}>
                            <div style={{ width: `${parseFloat(p.progress || 0)}%`, background: P, height: '100%', borderRadius: 3 }} />
                          </div>
                        </div>
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <span style={{ background: p.status === 'active' ? '#f0fdf4' : LIGHT, color: p.status === 'active' ? '#059669' : P, borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>{p.status}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!(data.top_10_projects || []).length && (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No project data yet.</div>
            )}
          </TableCard>
        )}

        {/* ── Most Expensive ── */}
        {tab === 'Most Expensive' && (
          <TableCard title="Most Expensive Projects — Highest Actual Cost" titleColor="#dc2626">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['#','Project','Customer','Budget','Actual Cost','Overrun'].map((h, i) => (
                    <th key={h} style={th(i < 3 ? 'left' : 'right')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.most_expensive || []).map((p, i) => {
                  const over = parseFloat(p.overrun || Math.max(0, parseFloat(p.actual_cost||0) - parseFloat(p.budget||0)));
                  const isOver = over > 0;
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...td, fontWeight: 700, color: '#9ca3af' }}>#{i+1}</td>
                      <td style={{ ...td, fontWeight: 600, color: P }}>
                        <div>{p.project_code || p.project_name}</div>
                        {p.project_code && <div style={{ fontSize: 11, color: '#374151', fontWeight: 400 }}>{p.project_name}</div>}
                      </td>
                      <td style={{ ...td, color: '#374151' }}>{p.customer_name}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{cr(p.budget)}</td>
                      <td style={{ ...td, textAlign: 'right', color: isOver ? '#dc2626' : '#374151', fontWeight: 600 }}>{cr(p.actual_cost)}</td>
                      <td style={{ ...td, textAlign: 'right', color: isOver ? '#dc2626' : '#059669', fontWeight: 700 }}>{isOver ? `+${cr(over)}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!(data.most_expensive || []).length && <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No cost data yet.</div>}
          </TableCard>
        )}

        {/* ── Most Profitable ── */}
        {tab === 'Most Profitable' && (
          <TableCard title="Most Profitable Projects" titleColor="#059669">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['#','Project','Customer','Revenue','Profit','Margin %'].map((h, i) => (
                    <th key={h} style={th(i < 3 ? 'left' : 'right')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.most_profitable || []).map((p, i) => (
                  <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ ...td, fontWeight: 700, color: '#9ca3af' }}>#{i+1}</td>
                    <td style={{ ...td, fontWeight: 600, color: P }}>
                      <div>{p.project_code || p.project_name}</div>
                      {p.project_code && <div style={{ fontSize: 11, color: '#374151', fontWeight: 400 }}>{p.project_name}</div>}
                    </td>
                    <td style={{ ...td, color: '#374151' }}>{p.customer_name}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{cr(p.revenue || p.contract_value)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#059669' }}>{cr(p.profit)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#059669', fontSize: 13.5 }}>{pct(p.margin_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!(data.most_profitable || []).length && <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No profitable project data yet.</div>}
          </TableCard>
        )}

        {/* ── Collections ── */}
        {tab === 'Collections' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, height: '100%', minHeight: 0 }}>
            <Panel title="Collections Summary" i={0}>
              {[
                { label: 'Total Portfolio Value',    value: cr(data.total_order_value), color: '#374151' },
                { label: 'Total Invoiced',           value: cr(data.total_invoiced),    color: '#2563eb' },
                { label: 'Outstanding',              value: cr(data.outstanding_collection), color: '#dc2626' },
                { label: 'Overdue Invoices',         value: `${data.overdue_invoices || 0} invoices`, color: '#dc2626' },
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid #f3f4f6', alignItems: 'center' }}>
                  <span style={{ fontSize: 12.5, color: '#374151' }}>{item.label}</span>
                  <span style={{ fontWeight: 700, color: item.color, fontSize: 14 }}>{item.value}</span>
                </div>
              ))}
            </Panel>
            <Panel title="Collection Health" i={1}>
              {parseFloat(data.outstanding_collection || 0) > 0 ? (
                <div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#dc2626', marginBottom: 6 }}>{cr(data.outstanding_collection)}</div>
                  <div style={{ fontSize: 12.5, color: '#6b7280' }}>outstanding from clients</div>
                  {(data.overdue_invoices || 0) > 0 && (
                    <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, fontSize: 12, color: '#dc2626' }}>
                      ⚠ {data.overdue_invoices} invoices are past due date — immediate follow-up required
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ padding: 20, textAlign: 'center', color: '#059669', fontSize: 14 }}>✓ No outstanding collections</div>
              )}
            </Panel>
          </div>
        )}

        {/* ── Cost Breakdown ── */}
        {tab === 'Cost Breakdown' && (
          <Panel title={`Portfolio Cost Breakdown by Type — ${cr(data.total_actual_cost)} total`} style={{ height: '100%' }}>
            {(data.cost_breakdown || []).length === 0 ? (
              <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No cost transaction data. Add entries via Cost Transactions.</div>
            ) : (
              <div>
                {(data.cost_breakdown || []).map((ct, i) => {
                  const sharePct = parseFloat(data.total_actual_cost || 0) > 0
                    ? ((ct.total / parseFloat(data.total_actual_cost)) * 100)
                    : 0;
                  const pctW = maxCostType > 0 ? Math.min(100, (ct.total / maxCostType) * 100) : 0;
                  const colors = ['#6B3FDB','#2563eb','#0891b2','#d97706','#dc2626','#059669','#6d28d9','#0d9488','#9f1239','#065f46'];
                  const barColor = colors[i % colors.length];
                  return (
                    <div key={ct.cost_type} style={{ marginBottom: 9 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 3 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <div style={{ width: 9, height: 9, borderRadius: '50%', background: barColor, flexShrink: 0 }} />
                          <span style={{ fontWeight: 500 }}>{ct.cost_type.replace(/_/g, ' ')}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                          <span style={{ color: '#6b7280', fontSize: 11.5 }}>{sharePct.toFixed(1)}%</span>
                          <span style={{ fontWeight: 700 }}>{cr(ct.total)}</span>
                        </div>
                      </div>
                      <div style={{ background: '#f3f4f6', borderRadius: 6, height: 13, overflow: 'hidden' }}>
                        <div style={{ width: `${pctW}%`, background: barColor, height: '100%', borderRadius: 6, display: 'flex', alignItems: 'center', paddingLeft: 6 }}>
                          {pctW > 12 && <span style={{ fontSize: 10, color: '#fff', fontWeight: 600 }}>{cr(ct.total)}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        )}

        {/* ── TOP CUSTOMERS ── */}
        {tab === 'Top Customers' && (
          customerData ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 8, flexShrink: 0 }}>
                {[
                  { label: 'Active Customers',  value: customerData.summary.total_customers,             color: P },
                  { label: 'Total Revenue',      value: fmtINR(customerData.summary.total_revenue),      color: '#16a34a' },
                  { label: 'Outstanding',        value: fmtINR(customerData.summary.total_outstanding),  color: customerData.summary.total_outstanding > 0 ? '#dc2626' : '#16a34a' },
                  { label: 'AMC Revenue',        value: fmtINR(customerData.summary.total_amc_revenue),  color: P },
                  { label: 'Excellent Health',   value: customerData.summary.excellent_count,            color: '#16a34a' },
                  { label: 'Critical / At Risk', value: customerData.summary.critical_count,             color: customerData.summary.critical_count > 0 ? '#dc2626' : '#16a34a' },
                ].map((k, i) => <Kpi key={k.label} i={i} label={k.label} value={k.value} color={k.color} />)}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, flex: 1, minHeight: 0 }}>
                <TableCard title="Top Customers by Revenue" i={1}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>{['#', 'Customer', 'Revenue', 'Outstanding', 'Margin', 'AMC Revenue', 'Open Tickets', 'Health'].map(h => (
                        <th key={h} style={{ ...th('left'), textTransform: 'uppercase', fontSize: 10.5, background: LIGHT }}>{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {(customerData.customers || []).map((c, i) => (
                        <tr key={c.id} style={{ borderBottom: '1px solid #f8f8fc' }}>
                          <td style={{ ...td, color: '#9ca3af', fontSize: 11.5 }}>{i + 1}</td>
                          <td style={td}>
                            <div style={{ fontWeight: 700, fontSize: 12.5, color: '#111827' }}>{c.name}</div>
                            <div style={{ fontSize: 10.5, color: '#9ca3af' }}>{[c.city, c.state].filter(Boolean).join(', ')}</div>
                          </td>
                          <td style={{ ...td, fontWeight: 700, color: '#16a34a' }}>{fmtINR(c.revenue)}</td>
                          <td style={{ ...td, fontWeight: 700, color: c.outstanding > 0 ? '#dc2626' : '#16a34a' }}>{fmtINR(c.outstanding)}</td>
                          <td style={td}>{c.margin_pct != null ? `${c.margin_pct}%` : '—'}</td>
                          <td style={{ ...td, color: P, fontWeight: 600 }}>{fmtINR(c.amc_revenue)}</td>
                          <td style={{ ...td, color: c.critical_tickets > 0 ? '#dc2626' : '#374151', fontWeight: c.critical_tickets > 0 ? 700 : 400 }}>
                            {c.open_tickets}{c.critical_tickets > 0 ? ` (${c.critical_tickets} crit)` : ''}
                          </td>
                          <td style={td}>
                            <span style={{ padding: '2px 9px', borderRadius: 20, fontSize: 10.5, fontWeight: 700, color: c.health_color, background: `${c.health_color}18`, border: `1px solid ${c.health_color}44`, whiteSpace: 'nowrap' }}>
                              {c.health_label} · {c.health_score}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableCard>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
                  <Panel title="Customer Health Distribution" i={2} style={{ flex: 1 }}>
                    <HealthBars
                      total={customerData.summary.total_customers || 1}
                      rows={(customerData.health_distribution || []).map(d => ({
                        label: d.label, count: d.count,
                        color: d.label === 'Excellent' ? '#16a34a' : d.label === 'Good' ? '#2563eb' : d.label === 'Watchlist' ? '#d97706' : '#dc2626',
                      }))}
                    />
                  </Panel>
                  <Panel title="Highest Outstanding" titleColor="#dc2626" i={3} style={{ flex: 1 }}>
                    {(customerData.top_outstanding || []).slice(0, 8).map((c, i) => (
                      <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #f8f8fc' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={{ fontSize: 11, color: '#9ca3af', width: 16, flexShrink: 0 }}>{i + 1}</span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#dc2626', flexShrink: 0 }}>{fmtINR(c.outstanding)}</span>
                      </div>
                    ))}
                  </Panel>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading customer intelligence…</div>
          )
        )}

        {/* ── TOP VENDORS ── */}
        {tab === 'Top Vendors' && (
          vendorData ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 8, flexShrink: 0 }}>
                {[
                  { label: 'Active Vendors',    value: vendorData.summary.total_vendors,    color: P },
                  { label: 'Total Spend',        value: fmtINR(vendorData.summary.total_spend), color: '#d97706' },
                  { label: 'Preferred Vendors',  value: vendorData.summary.preferred_count,  color: '#16a34a' },
                  { label: 'Blocked Vendors',    value: vendorData.summary.blocked_count,    color: vendorData.summary.blocked_count > 0 ? '#dc2626' : '#16a34a' },
                  { label: 'Open NCRs',          value: vendorData.summary.total_open_ncrs,  color: vendorData.summary.total_open_ncrs > 0 ? '#dc2626' : '#16a34a' },
                ].map((k, i) => <Kpi key={k.label} i={i} label={k.label} value={k.value} color={k.color} />)}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, flex: 1, minHeight: 0 }}>
                <TableCard title="Top Vendors by Spend" i={1}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>{['#', 'Vendor', 'Total Spend', 'PO Count', 'Open POs', 'Score', 'Open NCRs', 'OTD %', 'Health'].map(h => (
                        <th key={h} style={{ ...th('left'), textTransform: 'uppercase', fontSize: 10.5, background: LIGHT }}>{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {(vendorData.vendors || []).map((v, i) => (
                        <tr key={v.id} style={{ borderBottom: '1px solid #f8f8fc' }}>
                          <td style={{ ...td, color: '#9ca3af', fontSize: 11.5 }}>{i + 1}</td>
                          <td style={td}>
                            <div style={{ fontWeight: 700, fontSize: 12.5, color: '#111827' }}>{v.name}</div>
                            <div style={{ fontSize: 10.5, color: '#9ca3af' }}>{v.vendor_code} · {v.vendor_type || 'Vendor'}</div>
                          </td>
                          <td style={{ ...td, fontWeight: 700, color: P }}>{fmtINR(v.po_value)}</td>
                          <td style={td}>{v.po_count}</td>
                          <td style={{ ...td, color: v.open_pos > 0 ? '#d97706' : '#374151', fontWeight: v.open_pos > 0 ? 700 : 400 }}>{v.open_pos}</td>
                          <td style={{ ...td, fontWeight: 700, color: v.overall_score >= 4 ? '#16a34a' : v.overall_score >= 3 ? '#d97706' : '#dc2626' }}>
                            {v.overall_score > 0 ? `${v.overall_score.toFixed(1)}/5` : '—'}
                          </td>
                          <td style={{ ...td, color: v.open_ncrs > 0 ? '#dc2626' : '#374151', fontWeight: v.open_ncrs > 0 ? 700 : 400 }}>{v.open_ncrs}</td>
                          <td style={td}>{v.on_time_delivery_pct != null ? `${v.on_time_delivery_pct}%` : '—'}</td>
                          <td style={td}>
                            <span style={{ padding: '2px 9px', borderRadius: 20, fontSize: 10.5, fontWeight: 700, color: v.health_color, background: `${v.health_color}18`, border: `1px solid ${v.health_color}44`, whiteSpace: 'nowrap' }}>
                              {v.health_label}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableCard>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
                  <Panel title="Vendor Health Distribution" i={2} style={{ flex: 1 }}>
                    <HealthBars
                      total={vendorData.summary.total_vendors || 1}
                      rows={(vendorData.health_distribution || []).map(d => ({
                        label: d.label, count: d.count,
                        color: d.label === 'Preferred' ? '#16a34a' : d.label === 'Approved' ? '#2563eb' : d.label === 'Watchlist' ? '#d97706' : '#dc2626',
                      }))}
                    />
                  </Panel>
                  <Panel title="High-Risk Vendors" titleColor="#dc2626" i={3} style={{ flex: 1 }}>
                    {vendorData.top_risk_vendors?.length > 0 ? vendorData.top_risk_vendors.map(v => (
                      <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #f8f8fc' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</div>
                          <div style={{ fontSize: 10.5, color: '#9ca3af' }}>{v.open_ncrs} open NCR{v.open_ncrs !== 1 ? 's' : ''}</div>
                        </div>
                        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: '#fee2e2', color: '#dc2626', flexShrink: 0 }}>{v.health_label}</span>
                      </div>
                    )) : <div style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', padding: '20px 0' }}>No high-risk vendors</div>}
                  </Panel>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading vendor intelligence…</div>
          )
        )}
      </div>
    </div>
  );
}
