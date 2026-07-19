import { useState, useEffect, useCallback, useRef } from 'react';
import { FileText, Download, RefreshCw, TrendingUp, IndianRupee, CheckSquare } from 'lucide-react';
import api from '@/services/api/client';
import { getProjects } from '../services/projectsService';

const fmt = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)}L`;
  return `₹${v.toLocaleString('en-IN')}`;
};

const pct = (n) => `${parseFloat(n || 0).toFixed(1)}%`;

const STATUS_COLOR = { active: '#2563eb', completed: '#15803d', on_hold: '#ca8a04', cancelled: '#dc2626' };

export default function ProjectReports({ setPage }) {
  const [projects,   setProjects]   = useState([]);
  const [selId,      setSelId]      = useState('');
  const [reportType, setReportType] = useState('status');
  const [data,       setData]       = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [toast,      setToast]      = useState(null);
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);
  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  useEffect(() => {
    getProjects().then(p => { if (isMounted.current) setProjects(p); }).catch(() => {});
  }, []);

  const loadReport = useCallback(async () => {
    if (!selId) return;
    setLoading(true);
    setData(null);
    try {
      const endpoints = {
        status:    `/projects/projects/${selId}/status-report`,
        pl:        `/projects/projects/${selId}/costing`,
        milestone: `/projects/projects/${selId}/milestones`,
        risk:      `/projects/projects/${selId}/risks`,
      };
      const res = await api.get(endpoints[reportType]);
      if (isMounted.current) setData(res.data);
    } catch (e) {
      if (isMounted.current) showToast(e.response?.data?.error || 'Failed to load report', 'error');
    }
    if (isMounted.current) setLoading(false);
  }, [selId, reportType]);

  useEffect(() => { if (selId) loadReport(); }, [selId, reportType, loadReport]);

  const exportCSV = () => {
    if (!data) return;
    let rows = [];
    if (reportType === 'milestone') {
      rows = [['Name', 'Due Date', 'Status', 'Amount', 'Billing', 'Invoice Created']];
      (data.milestones || data || []).forEach(m => {
        rows.push([m.name, m.due_date ? new Date(m.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '', m.status, m.amount || 0, m.billing_milestone ? 'Yes' : 'No', m.invoice_id ? 'Yes' : 'No']);
      });
    } else if (reportType === 'pl') {
      const c = data.costing || data;
      rows = [['Metric', 'Value'], ['Contract Value', c.contract_value || 0], ['Total Budget', c.total_budget || 0], ['Actual Cost', c.actual_cost || 0], ['Labour Cost', c.labour_cost || 0], ['Material Cost', c.material_cost || 0], ['Overhead', c.overhead || 0], ['Revenue', c.revenue || 0], ['Profit', c.profit || 0], ['Margin %', c.margin_pct || 0]];
    } else if (reportType === 'risk') {
      rows = [['Code', 'Description', 'Category', 'Probability', 'Impact', 'Score', 'Status']];
      (data.risks || data || []).forEach(r => rows.push([r.risk_code, r.description, r.category, r.probability, r.impact, r.risk_score, r.status]));
    }
    if (!rows.length) { showToast('No data to export', 'error'); return; }
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${reportType}_report_${selId}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const selProject = projects.find(p => String(p.id) === String(selId));

  return (
    <div style={{ padding: '20px 24px' }}>
      {toast && <div style={{ position: 'fixed', top: 16, right: 16, padding: '10px 16px', borderRadius: 8, zIndex: 9999, background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4', color: toast.type === 'error' ? '#dc2626' : '#15803d', border: `1px solid ${toast.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{toast.msg}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Project Reports</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Status reports, P&L, milestone schedule, risk register</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={loadReport} disabled={!selId || loading} style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}><RefreshCw size={14} /></button>
          <button onClick={exportCSV} disabled={!data} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <select value={selId} onChange={e => setSelId(e.target.value)} style={{ flex: 1, padding: '9px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)', fontSize: 14 }}>
          <option value="">— Select Project —</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.project_code} — {p.project_name}</option>)}
        </select>
        <div style={{ display: 'flex', border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden' }}>
          {[
            { id: 'status', label: 'Status Report', icon: <FileText size={13} /> },
            { id: 'pl', label: 'P&L', icon: <IndianRupee size={13} /> },
            { id: 'milestone', label: 'Milestones', icon: <CheckSquare size={13} /> },
            { id: 'risk', label: 'Risk Register', icon: <TrendingUp size={13} /> },
          ].map(r => (
            <button key={r.id} onClick={() => setReportType(r.id)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '9px 14px', border: 'none', background: reportType === r.id ? '#6B3FDB' : 'var(--color-background)', color: reportType === r.id ? '#fff' : 'var(--color-text-primary)', cursor: 'pointer', fontSize: 12, fontWeight: reportType === r.id ? 600 : 400 }}>
              {r.icon} {r.label}
            </button>
          ))}
        </div>
      </div>

      {!selId && (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <FileText size={40} style={{ marginBottom: 10 }} />
          <p>Select a project to generate a report</p>
        </div>
      )}

      {selId && loading && <div style={{ textAlign: 'center', padding: 60, color: '#6b7280' }}>Generating report…</div>}

      {selId && !loading && data && (
        <div>
          {/* STATUS REPORT */}
          {reportType === 'status' && (() => {
            const r = data.report || data;
            const project = selProject || {};
            return (
              <div>
                <div style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 10, padding: 20, marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                    <div>
                      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{project.project_name || selProject?.project_name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{project.project_code} | {project.client_name || project.customer_name || 'Client'}</div>
                    </div>
                    <span style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700, background: STATUS_COLOR[project.status] + '22', color: STATUS_COLOR[project.status] || '#6b7280' }}>
                      {(project.status || 'active').toUpperCase()}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                    {[
                      { label: 'Contract Value', value: fmt(project.contract_value || project.budget_amount), color: '#0369a1' },
                      { label: 'Budget Spent', value: pct(project.budget_spent || r?.budget_utilization), color: '#6B3FDB' },
                      { label: 'Progress', value: pct(project.progress_percentage || r?.progress_percentage), color: '#15803d' },
                      { label: 'Lifecycle Stage', value: (r?.current_stage || project.current_stage || '—').replace(/_/g, ' '), color: '#ca8a04' },
                    ].map(k => (
                      <div key={k.label} style={{ textAlign: 'center', padding: '12px 8px', background: 'var(--color-background)', borderRadius: 8 }}>
                        <div style={{ fontSize: 18, fontWeight: 700, color: k.color }}>{k.value}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{k.label}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {r?.recent_milestones?.length > 0 && (
                  <div style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                    <div style={{ fontWeight: 600, marginBottom: 10 }}>Recent Milestones</div>
                    {r.recent_milestones.map((m, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--color-border-tertiary)', fontSize: 13 }}>
                        <span>{m.name}</span>
                        <span style={{ color: m.status === 'completed' ? '#15803d' : '#ca8a04', fontWeight: 600 }}>{m.status}</span>
                      </div>
                    ))}
                  </div>
                )}

                {r?.risks?.length > 0 && (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: 16 }}>
                    <div style={{ fontWeight: 600, marginBottom: 10, color: '#dc2626' }}>Open Risks</div>
                    {r.risks.slice(0, 3).map((r2, i) => (
                      <div key={i} style={{ fontSize: 13, padding: '4px 0', color: '#6b7280' }}>• [{r2.risk_code}] {r2.description}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* P&L REPORT */}
          {reportType === 'pl' && (() => {
            const c = data.costing || data;
            return (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 10, padding: 20 }}>
                  <div style={{ fontWeight: 700, marginBottom: 14, fontSize: 15 }}>Revenue & Cost</div>
                  {[
                    { label: 'Contract Value', value: c.contract_value, color: '#0369a1' },
                    { label: 'Total Budget', value: c.total_budget, color: '#6366f1' },
                    { label: 'Actual Cost', value: c.actual_cost, color: '#dc2626' },
                    { label: 'Labour Cost', value: c.labour_cost, color: '#ca8a04' },
                    { label: 'Material Cost', value: c.material_cost, color: '#6B3FDB' },
                    { label: 'Overhead', value: c.overhead, color: '#9ca3af' },
                  ].map(k => (
                    <div key={k.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--color-border-tertiary)', fontSize: 13 }}>
                      <span style={{ color: '#6b7280' }}>{k.label}</span>
                      <span style={{ fontWeight: 600, color: k.color }}>{fmt(k.value)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: 20, marginBottom: 16 }}>
                    <div style={{ fontWeight: 700, marginBottom: 14, fontSize: 15, color: '#15803d' }}>Profitability</div>
                    {[
                      { label: 'Revenue Recognised', value: fmt(c.revenue) },
                      { label: 'Gross Profit', value: fmt(c.profit), bold: true },
                      { label: 'Margin %', value: pct(c.margin_pct), bold: true },
                    ].map(k => (
                      <div key={k.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #bbf7d0', fontSize: 13 }}>
                        <span style={{ color: '#166534' }}>{k.label}</span>
                        <span style={{ fontWeight: k.bold ? 700 : 600, color: '#15803d' }}>{k.value}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ background: '#e0f2fe', border: '1px solid #bae6fd', borderRadius: 10, padding: 20 }}>
                    <div style={{ fontWeight: 700, marginBottom: 14, fontSize: 15, color: '#0369a1' }}>EVM Metrics</div>
                    {[
                      { label: 'Planned Value (PV)', value: fmt(c.planned_value) },
                      { label: 'Earned Value (EV)', value: fmt(c.earned_value) },
                      { label: 'CPI', value: parseFloat(c.cost_performance_index || 0).toFixed(2) },
                      { label: 'SPI', value: parseFloat(c.schedule_performance_index || 0).toFixed(2) },
                    ].map(k => (
                      <div key={k.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #bae6fd', fontSize: 13 }}>
                        <span style={{ color: '#0c4a6e' }}>{k.label}</span>
                        <span style={{ fontWeight: 600, color: '#0369a1' }}>{k.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* MILESTONE PAYMENT SCHEDULE */}
          {reportType === 'milestone' && (() => {
            const milestones = data.milestones || data || [];
            const total = milestones.reduce((s, m) => s + parseFloat(m.amount || 0), 0);
            const collected = milestones.filter(m => m.invoice_id).reduce((s, m) => s + parseFloat(m.amount || 0), 0);
            return (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
                  {[
                    { label: 'Total Value', value: fmt(total), color: '#0369a1', bg: '#e0f2fe' },
                    { label: 'Invoiced', value: fmt(collected), color: '#15803d', bg: '#f0fdf4' },
                    { label: 'Outstanding', value: fmt(total - collected), color: '#dc2626', bg: '#fef2f2' },
                  ].map(k => (
                    <div key={k.label} style={{ background: k.bg, borderRadius: 8, padding: '14px 16px', border: `1px solid ${k.color}22` }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: k.color }}>{k.value}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{k.label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 10, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f8fafc', borderBottom: '2px solid var(--color-border-tertiary)' }}>
                        {['#', 'Milestone', 'Due Date', 'Amount', 'Billing', 'Status', 'Invoice'].map(h => (
                          <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {milestones.map((m, i) => (
                        <tr key={m.id} style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                          <td style={{ padding: '10px 12px', fontSize: 12, color: '#9ca3af' }}>{i + 1}</td>
                          <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 500 }}>{m.name}</td>
                          <td style={{ padding: '10px 12px', fontSize: 12, color: '#6b7280' }}>{m.due_date ? new Date(m.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                          <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 600, color: '#0369a1' }}>{fmt(m.amount)}</td>
                          <td style={{ padding: '10px 12px' }}>{m.billing_milestone ? <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#fef9c3', color: '#ca8a04', fontWeight: 600 }}>Billing</span> : <span style={{ fontSize: 11, color: '#9ca3af' }}>—</span>}</td>
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: m.status === 'completed' ? '#dcfce7' : m.status === 'in_progress' ? '#e0f2fe' : '#f3f4f6', color: m.status === 'completed' ? '#15803d' : m.status === 'in_progress' ? '#0369a1' : '#6b7280' }}>
                              {(m.status || 'pending').replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td style={{ padding: '10px 12px', fontSize: 12 }}>{m.invoice_id ? <span style={{ color: '#15803d', fontWeight: 600 }}>✓ Created</span> : <span style={{ color: '#9ca3af' }}>—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* RISK REGISTER */}
          {reportType === 'risk' && (() => {
            const risks = data.risks || data || [];
            const high = risks.filter(r => r.risk_score >= 15).length;
            const med  = risks.filter(r => r.risk_score >= 8 && r.risk_score < 15).length;
            const low  = risks.filter(r => r.risk_score < 8).length;
            return (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
                  {[
                    { label: 'Total Risks', value: risks.length, color: '#6366f1', bg: '#eef2ff' },
                    { label: 'High', value: high, color: '#dc2626', bg: '#fef2f2' },
                    { label: 'Medium', value: med, color: '#ea580c', bg: '#fff7ed' },
                    { label: 'Low', value: low, color: '#15803d', bg: '#f0fdf4' },
                  ].map(k => (
                    <div key={k.label} style={{ background: k.bg, borderRadius: 8, padding: '14px 16px', border: `1px solid ${k.color}22` }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: k.color }}>{k.value}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{k.label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {risks.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No risks registered for this project</div>
                  ) : risks.map(r => {
                    const score = r.risk_score || (r.probability * r.impact);
                    const riskColor = score >= 15 ? '#dc2626' : score >= 8 ? '#ea580c' : '#15803d';
                    return (
                      <div key={r.id} style={{ background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '14px 16px', borderLeft: `4px solid ${riskColor}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                              <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#9ca3af' }}>{r.risk_code}</span>
                              <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 700, background: riskColor + '22', color: riskColor }}>Score: {score}</span>
                              <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: '#f3f4f6', color: '#6b7280' }}>{r.category}</span>
                            </div>
                            <div style={{ fontWeight: 600, fontSize: 14 }}>{r.description}</div>
                            {r.contingency_plan && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Mitigation: {r.contingency_plan}</div>}
                          </div>
                          <div style={{ textAlign: 'right', fontSize: 12, color: '#9ca3af', flexShrink: 0, marginLeft: 16 }}>
                            <div>P: {r.probability} × I: {r.impact}</div>
                            <div style={{ color: r.status === 'closed' ? '#15803d' : '#ca8a04', fontWeight: 600 }}>{r.status}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
