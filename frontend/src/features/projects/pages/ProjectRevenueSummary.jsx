import { useEffect, useState, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

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

function ProgressBar({ value, max, color = P }) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ background: '#f3f4f6', borderRadius: 4, height: 8, width: '100%', marginTop: 4 }}>
      <div style={{ width: `${w}%`, background: color, height: '100%', borderRadius: 4, transition: 'width .4s' }} />
    </div>
  );
}

export default function ProjectRevenueSummary({ setPage }) {
  const toast = useToast();
  const [projects, setProjects]       = useState([]);
  const [selectedId, setSelectedId]   = useState('');
  const [revenue, setRevenue]         = useState(null);
  const [profitability, setProfitability] = useState(null);
  const [form, setForm]               = useState(null);
  const [saving, setSaving]           = useState(false);
  const [loading, setLoading]         = useState(true);
  const [allSummaries, setAllSummaries] = useState([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [tab, setTab] = useState('Portfolio');

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const [projRes, summRes] = await Promise.allSettled([
        api.get('/project-cost-engine/reference/projects'),
        api.get('/project-cost-engine/dashboard'),
      ]);
      if (projRes.status === 'fulfilled') {
        setProjects(projRes.value.data);
        if (!selectedId && projRes.value.data.length) setSelectedId(String(projRes.value.data[0].id));
      }
      if (summRes.status === 'fulfilled') setAllSummaries(summRes.value.data.projects || []);
    } catch {}
    finally { setLoading(false); }
  }, []);

  const loadDetail = useCallback(async (id) => {
    if (!id) return;
    setLoadingDetail(true);
    try {
      const [revRes, profRes] = await Promise.allSettled([
        api.get(`/project-cost-engine/revenue/${id}`),
        api.get(`/project-cost-engine/profitability/${id}`),
      ]);
      const rev  = revRes.status === 'fulfilled'  ? revRes.value.data  : null;
      const prof = profRes.status === 'fulfilled' ? profRes.value.data : null;
      setRevenue(rev);
      setProfitability(prof);
      if (rev) {
        setForm({
          quotation_value:   rev.quotation_value || '',
          order_value:       rev.order_value     || '',
          invoice_value:     rev.invoice_value   || '',
          collection_value:  rev.collection_value || '',
          retention_value:   rev.retention_value || '',
          advance_received:  rev.advance_received || '',
        });
      }
    } catch {}
    finally { setLoadingDetail(false); }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); }, [selectedId, loadDetail]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put(`/project-cost-engine/revenue/${selectedId}`, form);
      loadDetail(selectedId);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const totalPortfolioRevenue    = allSummaries.reduce((s, p) => s + parseFloat(p.contract_value || 0), 0);
  const totalPortfolioInvoiced   = allSummaries.reduce((s, p) => s + parseFloat(p.invoiced || 0), 0);
  const totalPortfolioProfit     = allSummaries.reduce((s, p) => s + parseFloat(p.profit || 0), 0);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading revenue data…</div>;

  return (
    <div style={{ padding: 24, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111' }}>Project Revenue Summary</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Quotation → Order → Invoice → Collection → Retention tracking per project
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setPage?.('ProjectProfitabilityDashboard')}
            style={{ padding: '8px 14px', background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 8, color: P, fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
            ← Dashboard
          </button>
        </div>
      </div>

      {/* Portfolio KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Portfolio Order Value', value: cr(totalPortfolioRevenue), color: P },
          { label: 'Total Invoiced', value: cr(totalPortfolioInvoiced), color: '#2563eb' },
          { label: 'Billing %', value: pct(totalPortfolioRevenue > 0 ? (totalPortfolioInvoiced / totalPortfolioRevenue) * 100 : 0), color: '#0891b2' },
          { label: 'Total Profit', value: cr(totalPortfolioProfit), color: totalPortfolioProfit < 0 ? '#dc2626' : '#059669', warn: totalPortfolioProfit < 0 },
          { label: 'Total Projects', value: allSummaries.length, color: '#374151' },
        ].map(c => (
          <div key={c.label} style={{
            background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12,
            padding: '14px 16px', borderLeft: `4px solid ${c.warn ? '#dc2626' : c.color}`,
          }}>
            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: c.warn ? '#dc2626' : '#111', marginTop: 4 }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `2px solid ${BORDER}`, marginBottom: 20 }}>
        {['Portfolio', 'Project Detail'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', border: 'none', background: 'none',
            borderBottom: tab === t ? `2px solid ${P}` : '2px solid transparent',
            color: tab === t ? P : '#6b7280', fontWeight: tab === t ? 600 : 400,
            cursor: 'pointer', fontSize: 13, marginBottom: -2,
          }}>{t}</button>
        ))}
      </div>

      {/* ── Portfolio View ── */}
      {tab === 'Portfolio' && (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#fafafa', borderBottom: `1px solid ${BORDER}` }}>
                  {['Project','Customer','Contract Value','Invoiced','Billing %','Profit','Margin','Status'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: h === 'Project' || h === 'Customer' || h === 'Status' ? 'left' : 'right', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allSummaries.map((p, i) => {
                  const billingPct = parseFloat(p.contract_value || 0) > 0
                    ? (parseFloat(p.invoiced || 0) / parseFloat(p.contract_value || 0)) * 100
                    : 0;
                  const isLoss = parseFloat(p.profit || 0) < 0;
                  return (
                    <tr key={p.id}
                      onClick={() => { setSelectedId(String(p.id)); setTab('Project Detail'); }}
                      style={{ background: i % 2 === 0 ? '#fff' : '#fafafa', borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = LIGHT}
                      onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? '#fff' : '#fafafa'}>
                      <td style={{ padding: '9px 12px', fontWeight: 600, color: P }}>{p.project_code} — {p.project_name}</td>
                      <td style={{ padding: '9px 12px', color: '#374151' }}>{p.customer_name}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' }}>{cr(p.contract_value)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' }}>{cr(p.invoiced)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                          <span>{pct(billingPct)}</span>
                          <div style={{ width: 50, background: '#f3f4f6', borderRadius: 3, height: 6 }}>
                            <div style={{ width: `${Math.min(100, billingPct)}%`, background: billingPct >= 80 ? '#059669' : billingPct >= 50 ? '#d97706' : '#6b7280', height: '100%', borderRadius: 3 }} />
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: isLoss ? '#dc2626' : '#059669', fontWeight: 600 }}>{cr(p.profit)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: isLoss ? '#dc2626' : '#059669', fontWeight: 600 }}>{pct(p.margin_pct)}</td>
                      <td style={{ padding: '9px 12px' }}>
                        <span style={{ background: p.status === 'active' ? '#f0fdf4' : p.status === 'completed' ? LIGHT : '#fef9c3', color: p.status === 'active' ? '#059669' : p.status === 'completed' ? P : '#92400e', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>
                          {p.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!allSummaries.length && (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No project cost data yet. Run Recalculate on projects to populate.</div>
            )}
          </div>
        </div>
      )}

      {/* ── Project Detail ── */}
      {tab === 'Project Detail' && (
        <div>
          {/* Project selector */}
          <div style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
            <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
              style={{ padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, fontWeight: 500, color: '#111', minWidth: 300 }}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.project_code} — {p.project_name}</option>)}
            </select>
            {loadingDetail && <span style={{ color: '#6b7280', fontSize: 13 }}>Loading…</span>}
          </div>

          {revenue && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {/* Revenue Waterfall */}
              <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16, color: '#111' }}>Revenue Waterfall</div>
                {[
                  { label: 'Quotation Value',    value: revenue.quotation_value,  color: '#9ca3af' },
                  { label: 'Order Value (PO)',   value: revenue.order_value,      color: P },
                  { label: 'Invoice Value',      value: revenue.invoice_value,    color: '#2563eb' },
                  { label: 'Collection Value',   value: revenue.collection_value, color: '#059669' },
                  { label: 'Retention',          value: revenue.retention_value,  color: '#d97706' },
                  { label: 'Pending Collection', value: revenue.pending_collection, color: '#dc2626' },
                ].map(item => (
                  <div key={item.label} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                      <span style={{ color: '#374151' }}>{item.label}</span>
                      <span style={{ fontWeight: 700, color: item.color }}>{cr(item.value)}</span>
                    </div>
                    <ProgressBar value={parseFloat(item.value || 0)} max={parseFloat(revenue.order_value || 1)} color={item.color} />
                  </div>
                ))}
                <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: '#6b7280' }}>Billing %</span>
                  <span style={{ fontWeight: 700, color: P, fontSize: 16 }}>{pct(revenue.billing_pct)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 6 }}>
                  <span style={{ color: '#6b7280' }}>Collection %</span>
                  <span style={{ fontWeight: 700, color: '#059669', fontSize: 16 }}>{pct(revenue.collection_pct)}</span>
                </div>
              </div>

              {/* Update Revenue Form */}
              {form && (
                <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16, color: '#111' }}>Update Revenue Data</div>
                  <form onSubmit={handleSave}>
                    {[
                      { field: 'quotation_value', label: 'Quotation Value (₹)' },
                      { field: 'order_value',     label: 'PO / Order Value (₹)' },
                      { field: 'invoice_value',   label: 'Invoice Value (₹)' },
                      { field: 'collection_value',label: 'Collection Value (₹)' },
                      { field: 'retention_value', label: 'Retention Amount (₹)' },
                      { field: 'advance_received',label: 'Advance Received (₹)' },
                    ].map(({ field, label }) => (
                      <div key={field} style={{ marginBottom: 10 }}>
                        <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>{label}</label>
                        <input type="number" min="0" step="0.01"
                          value={form[field]}
                          onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
                          style={{ display: 'block', width: '100%', marginTop: 3, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                      </div>
                    ))}
                    <button type="submit" disabled={saving}
                      style={{ marginTop: 4, padding: '9px 20px', background: P, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>
                      {saving ? 'Saving…' : 'Update Revenue'}
                    </button>
                  </form>
                </div>
              )}

              {/* Profitability Summary */}
              {profitability && (
                <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, gridColumn: '1 / -1' }}>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16, color: '#111' }}>
                    Full Profitability — {profitability.project_name}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                    {[
                      { label: 'Order Value',     value: cr(profitability.revenue), color: P },
                      { label: 'Total Cost',      value: cr(profitability.total_cost), color: '#374151' },
                      { label: 'Gross Profit',    value: cr(profitability.gross_profit), color: profitability.gross_profit < 0 ? '#dc2626' : '#059669', warn: profitability.gross_profit < 0 },
                      { label: 'Gross Margin',    value: pct(profitability.gross_margin_pct), color: profitability.gross_margin_pct < 0 ? '#dc2626' : '#059669', warn: profitability.gross_margin_pct < 0 },
                      { label: 'Collection %',    value: pct(profitability.collection_pct), color: '#2563eb' },
                      { label: 'CPI',             value: parseFloat(profitability.cpi || 1).toFixed(2), color: profitability.cpi < 0.9 ? '#dc2626' : '#059669' },
                    ].map(card => (
                      <div key={card.label} style={{
                        background: '#fafafa', border: `1px solid ${BORDER}`, borderRadius: 10,
                        padding: '12px 14px', borderLeft: `3px solid ${card.warn ? '#dc2626' : card.color}`,
                      }}>
                        <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{card.label}</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: card.warn ? '#dc2626' : card.color, marginTop: 3 }}>{card.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Cost breakdown */}
                  {profitability.cost_breakdown && (
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${BORDER}` }}>
                      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 12, color: '#374151' }}>Cost Breakdown</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                        {Object.entries(profitability.cost_breakdown)
                          .filter(([, v]) => parseFloat(v) > 0)
                          .sort(([, a], [, b]) => b - a)
                          .map(([k, v]) => (
                            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '6px 10px', background: '#f9fafb', borderRadius: 6 }}>
                              <span style={{ color: '#374151' }}>{k.replace(/_/g, ' ')}</span>
                              <span style={{ fontWeight: 600 }}>{cr(v)}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!revenue && !loadingDetail && (
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              Select a project to view revenue details.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
