// frontend/src/features/projects/pages/ResourceManagement.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { Users, Target, AlertTriangle } from 'lucide-react';
import api from '@/services/api/client';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';

function EmptyState({ icon: Icon, title, sub, action }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '48px 24px', textAlign: 'center', gap: 8,
      background: 'var(--color-background-secondary)',
      borderRadius: 'var(--border-radius-lg)',
      border: '0.5px solid var(--color-border-tertiary)',
    }}>
      {Icon && <Icon size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 4 }} />}
      <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>{title}</p>
      {sub && <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>{sub}</p>}
      {action}
    </div>
  );
}

const fmt = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const tabStyle = (a) => ({ padding: '8px 20px', border: 'none', background: a ? '#6B3FDB' : 'transparent', color: a ? '#fff' : '#6b7280', cursor: 'pointer', borderRadius: 8, fontWeight: a ? 600 : 400, fontSize: 14 });
const cardStyle = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 16 };
const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#6b7280', background: '#fafafa', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' };
const tdStyle = { padding: '10px 16px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f8f8fc' };

const ALLOC_COLOR = (pct, target = 80) => {
  if (pct > 100) return '#dc2626';
  if (pct >= target) return '#6B3FDB';
  if (pct >= 50) return '#a78bfa';
  if (pct > 0) return '#ddd6fe';
  return '#f5f3ff';
};

const RISK_PROB = { low: 1, medium: 2, high: 4 };
const RISK_IMP = { low: 1, medium: 2, high: 4 };
const RISK_COLORS = { open: '#dc2626', mitigating: '#d97706', closed: '#059669' };
const STATUS_ICON = { completed: '✅', 'in-progress': '🔄', pending: '⏳', delayed: '⚠️' };

export default function ResourceManagement({ setPage } = {}) {
  const toast = useToast();
  const [utilizationTarget, setUtilizationTarget] = useState(80);
  const [tab, setTab] = useState(0);
  const [capacity, setCapacity] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [risks, setRisks] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [selectedMs, setSelectedMs] = useState(null);
  const [selectedProject, setSelectedProject] = useState(1);
  const [showAssign, setShowAssign] = useState(false);
  const [showAddMs, setShowAddMs] = useState(false);
  const [showAddRisk, setShowAddRisk] = useState(false);
  const [assignForm, setAssignForm] = useState({ project_id: 1, employee_id: '', role: '', allocation_pct: 100, start_date: '', end_date: '', hourly_rate: 0 });
  const [msForm, setMsForm] = useState({ name: '', due_date: '', billing_milestone: false, amount: 0, owner_id: '' });
  const [riskForm, setRiskForm] = useState({ title: '', category: 'technical', probability: 'medium', impact: 'medium', mitigation_plan: '', owner_id: '' });
  const [pendingInvoiceNav, setPendingInvoiceNav] = useState(null);

  useEffect(() => {
    api.get('/projects/employees').then(r => setEmployees(r.data || [])).catch(() => {});
    api.get('/settings/projects')
      .then(r => { if (r.data?.utilization_target_pct) setUtilizationTarget(Number(r.data.utilization_target_pct)); })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const [r1, r2, r3] = await Promise.allSettled([
      api.get('/projects/capacity/overview'),
      api.get(`/projects/projects/${selectedProject}/milestones`),
      api.get(`/projects/projects/${selectedProject}/risks`)
    ]);
    setCapacity(r1.status === 'fulfilled' ? (r1.value.data || []) : []);
    setMilestones(r2.status === 'fulfilled' ? (r2.value.data || []) : []);
    setRisks(r3.status === 'fulfilled' ? (r3.value.data || []) : []);
  }, [selectedProject]);

  useEffect(() => { load(); }, [load]);

  const completeMilestone = async (id) => {
    try {
      const res = await api.put(`/projects/projects/milestones/${id}/complete`);
      load();
      if (res.data.invoice) {
        const num = res.data.invoice.invoice_number;
        if (typeof setPage === 'function') {
          setPendingInvoiceNav(num);
        } else {
          toast.success(`Draft invoice created: ${num}`);
        }
      }
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to complete milestone'); }
  };

  const addMilestone = async () => {
    try { await api.post(`/projects/projects/${selectedProject}/milestones`, msForm); setShowAddMs(false); load(); } catch (_) { setShowAddMs(false); load(); }
  };

  const addRisk = async () => {
    try { await api.post(`/projects/projects/${selectedProject}/risks`, riskForm); setShowAddRisk(false); load(); } catch (_) { setShowAddRisk(false); load(); }
  };

  const addResource = async () => {
    try { await api.post(`/projects/projects/${assignForm.project_id}/resources`, assignForm); setShowAssign(false); load(); } catch (_) { setShowAssign(false); }
  };

  const weeks = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + (i - 2) * 7);
    return d.toISOString().split('T')[0].slice(0, 7);
  });

  const _riskMatrix = Array.from({ length: 4 }, (_, y) => Array.from({ length: 4 }, (_, x) => ({ x: x + 1, y: y + 1, risks: risks.filter(r => RISK_PROB[r.probability] === (y + 1) && RISK_IMP[r.impact] === (x + 1)) })));

  const overdue = milestones.filter(m => m.status !== 'completed' && new Date(m.due_date) < new Date());

  return (
    <div style={{ padding: '24px', background: '#f5f3ff', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!pendingInvoiceNav}
        title="Invoice Created"
        message={pendingInvoiceNav ? `Draft invoice ${pendingInvoiceNav} created. Open Invoices now?` : ''}
        confirmLabel="Open Invoices"
        variant="info"
        onConfirm={() => { setPendingInvoiceNav(null); setPage('InvoicesNew'); }}
        onCancel={() => setPendingInvoiceNav(null)}
      />
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#111827', margin: 0 }}>Resource Management</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Resource allocation, milestones, risk register</p>
      </div>

      <div style={{ display: 'flex', gap: 4, background: '#f0ebff', padding: 4, borderRadius: 10, marginBottom: 24, width: 'fit-content' }}>
        {['Resource Allocation', 'Milestones', 'Risk Register'].map((t, i) => (
          <button key={i} style={tabStyle(tab === i)} onClick={() => setTab(i)}>{t}</button>
        ))}
      </div>

      {tab === 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
              {[['Over-allocated', '#dc2626', (capacity ?? []).filter(c => c.status === 'over').length], ['Fully booked', '#6B3FDB', (capacity ?? []).filter(c => c.status === 'full').length], ['Partial', '#a78bfa', (capacity ?? []).filter(c => c.status === 'partial').length], ['Available', '#059669', (capacity ?? []).filter(c => c.status === 'available').length]].map(([l, c, n]) => (
                <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 2, background: c }} />
                  <span style={{ color: '#6b7280' }}>{l}: <strong style={{ color: c }}>{n}</strong></span>
                </div>
              ))}
            </div>
            <button onClick={() => setShowAssign(true)} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              + Assign Resource
            </button>
          </div>

          {showAssign && (
            <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>Assign Resource to Project</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Project ID</label>
                  <input type="number" value={assignForm.project_id} onChange={e => setAssignForm(p => ({ ...p, project_id: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Employee</label>
                  <select value={assignForm.employee_id} onChange={e => setAssignForm(p => ({ ...p, employee_id: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}>
                    <option value="">— select —</option>
                    {(employees ?? []).map(emp => (
                      <option key={emp.id} value={emp.id}>
                        {emp.first_name} {emp.last_name}{emp.designation ? ` · ${emp.designation}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                {[{ label: 'Role', key: 'role', type: 'text' }, { label: 'Allocation %', key: 'allocation_pct', type: 'number' }, { label: 'Start Date', key: 'start_date', type: 'date' }, { label: 'End Date', key: 'end_date', type: 'date' }, { label: 'Hourly Rate', key: 'hourly_rate', type: 'number' }].map(f => (
                  <div key={f.key}>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{f.label}</label>
                    <input type={f.type} value={assignForm[f.key]} onChange={e => setAssignForm(p => ({ ...p, [f.key]: e.target.value }))}
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button onClick={addResource} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Assign</button>
                <button onClick={() => setShowAssign(false)} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          {capacity.length === 0 ? (
            <EmptyState icon={Users} title="No resource data" sub="Resource allocation will appear here" />
          ) : null}
          <div style={{ ...cardStyle, overflowX: 'auto', display: capacity.length === 0 ? 'none' : undefined }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 800 }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, minWidth: 200 }}>Employee</th>
                  <th style={{ ...thStyle, minWidth: 100 }}>Total %</th>
                  {weeks.map(w => <th key={w} style={{ ...thStyle, textAlign: 'center', minWidth: 90 }}>{w}</th>)}
                </tr>
              </thead>
              <tbody>
                {(capacity ?? []).map((emp, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600 }}>{emp?.employee_name ?? '—'}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{emp?.designation ?? ''}{emp?.department ? ` · ${emp.department}` : ''}</div>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                      <span style={{ padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, background: `${ALLOC_COLOR(emp?.total_allocation ?? 0, utilizationTarget)}30`, color: ALLOC_COLOR(emp?.total_allocation ?? 0, utilizationTarget) }}>
                        {emp?.total_allocation ?? 0}%
                      </span>
                    </td>
                    {weeks.map(w => {
                      const allocForWeek = emp?.total_allocation ?? 0;
                      const bg = ALLOC_COLOR(allocForWeek, utilizationTarget);
                      const textColor = allocForWeek > 50 ? '#fff' : '#374151';
                      return (
                        <td key={w} style={{ ...tdStyle, textAlign: 'center', padding: 4 }}>
                          <div style={{ background: bg, color: textColor, borderRadius: 6, padding: '6px 4px', fontSize: 11, fontWeight: 500, cursor: 'pointer' }}
                            title={(emp?.projects ?? []).map(p => `${p?.project_name ?? ''}: ${p?.allocation_pct ?? 0}%`).join('\n')}>
                            {allocForWeek > 0 ? `${allocForWeek}%` : '-'}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 1 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, color: '#6b7280', marginRight: 8 }}>Project ID:</label>
              <input type="number" value={selectedProject} onChange={e => setSelectedProject(e.target.value)}
                style={{ padding: '6px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, width: 80 }} />
            </div>
            <button onClick={() => setShowAddMs(true)} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>+ Add Milestone</button>
          </div>

          {showAddMs && (
            <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>New Milestone</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {[{ label: 'Name', key: 'name', type: 'text' }, { label: 'Due Date', key: 'due_date', type: 'date' }, { label: 'Owner ID', key: 'owner_id', type: 'number' }, { label: 'Amount (if billing)', key: 'amount', type: 'number' }].map(f => (
                  <div key={f.key}>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{f.label}</label>
                    <input type={f.type} value={msForm[f.key]} onChange={e => setMsForm(p => ({ ...p, [f.key]: e.target.value }))}
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
                  <input type="checkbox" checked={msForm.billing_milestone} onChange={e => setMsForm(p => ({ ...p, billing_milestone: e.target.checked }))}
                    style={{ width: 16, height: 16, accentColor: '#6B3FDB' }} />
                  <label style={{ fontSize: 13, color: '#374151' }}>Billing Milestone</label>
                </div>
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button onClick={addMilestone} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Add</button>
                <button onClick={() => setShowAddMs(false)} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          {overdue.length > 0 && (
            <div style={{ ...cardStyle, padding: 16, marginBottom: 16, background: '#fef2f2', border: '1px solid #fecaca' }}>
              <div style={{ fontWeight: 600, color: '#dc2626', marginBottom: 8 }}>⚠️ Overdue Milestones</div>
              {overdue.map(m => (
                <div key={m.id} style={{ fontSize: 13, color: '#7f1d1d', marginBottom: 4 }}>
                  {m.name} — due {new Date(m.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })} · Owner: {m.owner_name}
                </div>
              ))}
            </div>
          )}

          {milestones.length === 0 ? (
            <EmptyState icon={Target} title="No milestones" sub="Add milestones to track project timeline" />
          ) : null}
          <div style={{ ...cardStyle, overflowX: 'auto', padding: 20, display: milestones.length === 0 ? 'none' : undefined }}>
            <div style={{ minWidth: 900, position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #f0f0f4' }}>
                {['Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026'].map((q, _i) => (
                  <div key={q} style={{ flex: 1, textAlign: 'center', fontSize: 12, color: '#6b7280', fontWeight: 600 }}>{q}</div>
                ))}
              </div>
              <div style={{ height: 4, background: '#e9e4ff', borderRadius: 2, marginBottom: 24, position: 'relative' }}>
                <div style={{ position: 'absolute', left: `${((new Date() - new Date('2026-01-01')) / (new Date('2026-12-31') - new Date('2026-01-01'))) * 100}%`, top: -8, width: 2, height: 20, background: '#6B3FDB' }} />
              </div>
              {milestones.map((m, i) => {
                const start = new Date('2026-01-01');
                const end = new Date('2026-12-31');
                const total = end - start;
                const pos = Math.max(0, Math.min(95, ((new Date(m.due_date) - start) / total) * 100));
                const colors = { completed: '#059669', 'in-progress': '#6B3FDB', pending: '#9ca3af', delayed: '#dc2626' };
                return (
                  <div key={i} style={{ marginBottom: 20, position: 'relative', height: 36 }}>
                    <div style={{ position: 'absolute', left: `${pos}%`, top: 0, transform: 'translateX(-50%)', cursor: 'pointer' }}
                      onClick={() => setSelectedMs(selectedMs?.id === m.id ? null : m)}>
                      <div style={{ width: 24, height: 24, background: colors[m.status] || '#9ca3af', transform: 'rotate(45deg)', borderRadius: 3 }} />
                      <div style={{ position: 'absolute', top: 28, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: 11, color: '#374151', textAlign: 'center' }}>
                        {STATUS_ICON[m.status]} {m.name}
                        {m.billing_milestone && <span style={{ marginLeft: 4, color: '#6B3FDB', fontWeight: 600 }}>₹</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {selectedMs && (
            <div style={{ ...cardStyle, padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>{selectedMs.name}</h3>
                  <div style={{ fontSize: 13, color: '#6b7280' }}>Due: {new Date(selectedMs.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })} · Owner: {selectedMs.owner_name}</div>
                  {selectedMs.billing_milestone && <div style={{ fontSize: 13, color: '#6B3FDB', fontWeight: 600, marginTop: 4 }}>Billing Milestone: {fmt(selectedMs.amount)}</div>}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {selectedMs.status !== 'completed' && (
                    <button onClick={() => completeMilestone(selectedMs.id)} style={{ padding: '8px 16px', background: '#059669', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                      Mark Complete {selectedMs.billing_milestone ? '+ Create Invoice' : ''}
                    </button>
                  )}
                  <button onClick={() => setSelectedMs(null)} style={{ padding: '8px 12px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>✕</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 2 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
              {[['open', '#dc2626'], ['mitigating', '#d97706'], ['closed', '#059669']].map(([s, c]) => (
                <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: c }} />
                  <span>{s}: {risks.filter(r => r.status === s).length}</span>
                </div>
              ))}
            </div>
            <button onClick={() => setShowAddRisk(true)} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>+ Add Risk</button>
          </div>

          {showAddRisk && (
            <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>New Risk</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Title</label>
                  <input value={riskForm.title} onChange={e => setRiskForm(p => ({ ...p, title: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                {[{ label: 'Category', key: 'category', options: ['technical', 'resource', 'schedule', 'budget', 'external'] },
                  { label: 'Probability', key: 'probability', options: ['low', 'medium', 'high'] },
                  { label: 'Impact', key: 'impact', options: ['low', 'medium', 'high'] }].map(f => (
                  <div key={f.key}>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{f.label}</label>
                    <select value={riskForm[f.key]} onChange={e => setRiskForm(p => ({ ...p, [f.key]: e.target.value }))}
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                      {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                ))}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Mitigation Plan</label>
                  <textarea value={riskForm.mitigation_plan} onChange={e => setRiskForm(p => ({ ...p, mitigation_plan: e.target.value }))}
                    rows={2} style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
                </div>
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button onClick={addRisk} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Add Risk</button>
                <button onClick={() => setShowAddRisk(false)} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          {risks.length === 0 ? (
            <EmptyState icon={AlertTriangle} title="No risks logged" sub="Log risks to track project health" />
          ) : null}
          <div style={{ display: risks.length === 0 ? 'none' : 'grid', gridTemplateColumns: '280px 1fr', gap: 16, marginBottom: 16 }}>
            <div style={{ ...cardStyle, padding: 16, marginBottom: 0 }}>
              <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Risk Matrix</h4>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>Probability ↑ / Impact →</div>
              {[3, 2, 1, 0].map(yIdx => (
                <div key={yIdx} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <div style={{ width: 60, fontSize: 10, color: '#6b7280', display: 'flex', alignItems: 'center' }}>{['Low', 'Med', 'High', 'Critical'][yIdx]}</div>
                  {[0, 1, 2, 3].map(xIdx => {
                    const cellRisks = risks.filter(r => {
                      const py = { low: 0, medium: 1, high: 2 }[r.probability] ?? 1;
                      const ix = { low: 0, medium: 1, high: 2 }[r.impact] ?? 1;
                      return py === yIdx && ix === xIdx;
                    });
                    const cellScore = (yIdx + 1) * (xIdx + 1);
                    const bg = cellScore >= 9 ? '#fee2e2' : cellScore >= 4 ? '#fef3c7' : '#f0fdf4';
                    return (
                      <div key={xIdx} style={{ width: 44, height: 44, background: bg, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 2 }}>
                        {cellRisks.map((r, ri) => (
                          <div key={ri} style={{ width: 12, height: 12, borderRadius: '50%', background: RISK_COLORS[r.status] || '#374151' }} title={r.title} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 4, marginTop: 4, paddingLeft: 64 }}>
                {['Low', 'Med', 'High', 'Crit'].map(l => <div key={l} style={{ width: 44, fontSize: 10, color: '#6b7280', textAlign: 'center' }}>{l}</div>)}
              </div>
            </div>

            <div style={cardStyle}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Risk', 'Category', 'Probability', 'Impact', 'Score', 'Owner', 'Status', 'Mitigation'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                <tbody>
                  {risks.sort((a, b) => b.risk_score - a.risk_score).map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...tdStyle, fontWeight: 600, maxWidth: 160 }}>{r.title}</td>
                      <td style={tdStyle}><span style={{ padding: '2px 6px', background: '#f0ebff', color: '#6B3FDB', borderRadius: 4, fontSize: 11 }}>{r.category}</span></td>
                      <td style={tdStyle}><span style={{ padding: '2px 6px', background: r.probability === 'high' ? '#fee2e2' : r.probability === 'medium' ? '#fef3c7' : '#f0fdf4', color: r.probability === 'high' ? '#dc2626' : r.probability === 'medium' ? '#92400e' : '#059669', borderRadius: 4, fontSize: 11 }}>{r.probability}</span></td>
                      <td style={tdStyle}><span style={{ padding: '2px 6px', background: r.impact === 'high' ? '#fee2e2' : r.impact === 'medium' ? '#fef3c7' : '#f0fdf4', color: r.impact === 'high' ? '#dc2626' : r.impact === 'medium' ? '#92400e' : '#059669', borderRadius: 4, fontSize: 11 }}>{r.impact}</span></td>
                      <td style={{ ...tdStyle, fontWeight: 700, color: r.risk_score >= 9 ? '#dc2626' : r.risk_score >= 4 ? '#d97706' : '#059669' }}>{r.risk_score}</td>
                      <td style={tdStyle}>{r.owner_name || '-'}</td>
                      <td style={tdStyle}><span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: `${RISK_COLORS[r.status] || '#6b7280'}20`, color: RISK_COLORS[r.status] || '#6b7280' }}>{r.status}</span></td>
                      <td style={{ ...tdStyle, maxWidth: 200, fontSize: 12, color: '#6b7280' }}>{r.mitigation_plan}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
