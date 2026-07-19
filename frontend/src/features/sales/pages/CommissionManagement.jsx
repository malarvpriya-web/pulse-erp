// frontend/src/features/sales/pages/CommissionManagement.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { formatINR, Badge } from './salesUtils';

const PURPLE = '#6B3FDB';
const LIGHT = '#f5f3ff';
const BORDER = '#e9e4ff';
const GOLD = '#f59e0b';

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function Avatar({ name, size = 36, bg = PURPLE }) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: size * 0.36, flexShrink: 0 }}>
      {getInitials(name)}
    </div>
  );
}

function Modal({ open, onClose, title, children, width = 520 }) {
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, width, maxWidth: '96vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#1a1a2e' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>×</button>
        </div>
        <div style={{ padding: 24 }}>{children}</div>
      </div>
    </div>
  );
}

function Drawer({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ background: '#fff', width: 480, maxWidth: '96vw', height: '100%', overflow: 'auto', boxShadow: '-8px 0 32px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e' }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#6b7280' }}>×</button>
        </div>
        <div style={{ padding: 24, flex: 1, overflow: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

function FormField({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}

function Input(props) {
  return <input {...props} style={{ width: '100%', padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box', ...props.style }} />;
}

function Select({ children, ...props }) {
  return <select {...props} style={{ width: '100%', padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, outline: 'none', background: '#fff', boxSizing: 'border-box', ...props.style }}>{children}</select>;
}

function Btn({ children, onClick, variant = 'primary', size = 'md', disabled = false, style: extra = {} }) {
  const styles = { primary: { background: PURPLE, color: '#fff', border: 'none' }, outline: { background: '#fff', color: PURPLE, border: `1px solid ${PURPLE}` }, success: { background: '#16a34a', color: '#fff', border: 'none' }, danger: { background: '#dc2626', color: '#fff', border: 'none' }, ghost: { background: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb' } };
  const sizes = { sm: { padding: '4px 10px', fontSize: 12 }, md: { padding: '8px 16px', fontSize: 14 }, lg: { padding: '10px 24px', fontSize: 15 } };
  return (
    <button onClick={onClick} disabled={disabled} style={{ borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: disabled ? 0.6 : 1, ...styles[variant], ...sizes[size], ...extra }}>
      {children}
    </button>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <div onClick={onChange} style={{ width: 40, height: 22, borderRadius: 11, background: checked ? PURPLE : '#d1d5db', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
      <div style={{ width: 18, height: 18, borderRadius: 9, background: '#fff', position: 'absolute', top: 2, left: checked ? 20 : 2, transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }} />
    </div>
  );
}

// ─── KPI Stats Bar ────────────────────────────────────────────────────────────

function StatsBar() {
  const [stats, setStats] = useState(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    (async () => {
      const [r] = await Promise.allSettled([api.get('/commissions/stats')]);
      if (isMounted.current && r.status === 'fulfilled') setStats(r.value.data);
    })();
  }, []);

  const cards = [
    { label: 'Total Earned (FY)',  value: formatINR(stats?.total_earned   ?? 0), color: PURPLE,    bg: '#f5f3ff' },
    { label: 'Pending Payout',     value: formatINR(stats?.pending_payout ?? 0), color: '#d97706', bg: '#fffbeb' },
    { label: 'Paid YTD',           value: formatINR(stats?.paid_ytd       ?? 0), color: '#16a34a', bg: '#f0fdf4' },
    { label: 'Active Plans',       value: String(stats?.active_plans ?? '—'),    color: '#2563eb', bg: '#eff6ff' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 28 }}>
      {cards.map(c => (
        <div key={c.label} style={{ background: c.bg, borderRadius: 12, padding: '18px 20px', border: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{c.label}</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: c.color }}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Tab 1: Plans ─────────────────────────────────────────────────────────────

function PlansTab() {
  const toast = useToast();
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [editPlan, setEditPlan] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [form, setForm] = useState({
    name: '', rep_name: '', rep_id: '', plan_type: 'percentage', base_rate_pct: '',
    tiered_slabs: [{ min_revenue: 0, max_revenue: 500000, rate_pct: 3 }],
    applies_to: 'all_products', product_ids: '', effective_from: '', effective_to: '', clawback_period_days: 30
  });

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [r] = await Promise.allSettled([api.get('/commissions/plans')]);
    if (!isMounted.current) return;
    setPlans(r.status === 'fulfilled' ? (r.value.data || []) : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (plan) => {
    try {
      await api.put(`/commissions/plans/${plan.id}`, { is_active: !plan.is_active });
      toast.success(plan.is_active ? 'Plan deactivated.' : 'Plan activated.');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to update plan status.');
    }
  };

  const deletePlan = async () => {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      await api.delete(`/commissions/plans/${id}`);
      toast.success('Plan deactivated.');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to delete plan.');
    }
  };

  const openNew = () => {
    setEditPlan(null);
    setForm({ name: '', rep_name: '', rep_id: '', plan_type: 'percentage', base_rate_pct: '', tiered_slabs: [{ min_revenue: 0, max_revenue: 500000, rate_pct: 3 }], applies_to: 'all_products', product_ids: '', effective_from: '', effective_to: '', clawback_period_days: 30 });
    setShowDrawer(true);
  };

  const openEdit = (p) => {
    setEditPlan(p);
    setForm({ name: p.name, rep_name: p.rep_name || '', rep_id: p.rep_id || '', plan_type: p.plan_type, base_rate_pct: p.base_rate_pct || '', tiered_slabs: p.tiered_slabs && p.tiered_slabs.length > 0 ? p.tiered_slabs : [{ min_revenue: 0, max_revenue: 500000, rate_pct: 3 }], applies_to: p.applies_to, product_ids: (p.product_ids || []).join(', '), effective_from: p.effective_from || '', effective_to: p.effective_to || '', clawback_period_days: p.clawback_period_days || 30 });
    setShowDrawer(true);
  };

  const save = async () => {
    if (saving) return;
    if (!form.name) { toast.error('Plan name is required.'); return; }
    setSaving(true);
    try {
      const payload = { ...form, rep_id: parseInt(form.rep_id) || null, product_ids: form.product_ids ? form.product_ids.split(',').map(s => s.trim()) : [] };
      if (editPlan) await api.put(`/commissions/plans/${editPlan.id}`, payload);
      else await api.post('/commissions/plans', payload);
      if (!isMounted.current) return;
      toast.success(editPlan ? 'Plan updated.' : 'Plan created.');
      setSaving(false);
      setShowDrawer(false);
      load();
    } catch (e) {
      if (!isMounted.current) return;
      toast.error(e?.response?.data?.error || 'Failed to save plan.');
      setSaving(false);
    }
  };

  const addSlab = () => setForm(p => ({ ...p, tiered_slabs: [...p.tiered_slabs, { min_revenue: '', max_revenue: '', rate_pct: 0 }] }));
  const removeSlab = (i) => setForm(p => ({ ...p, tiered_slabs: p.tiered_slabs.filter((_, j) => j !== i) }));
  const updateSlab = (i, field, val) => setForm(p => ({ ...p, tiered_slabs: p.tiered_slabs.map((s, j) => j === i ? { ...s, [field]: val } : s) }));

  const typeColors = { percentage: 'green', tiered: 'purple', flat: 'blue' };

  const rateDisplay = (plan) => {
    if (plan.plan_type === 'percentage') return `${plan.base_rate_pct}%`;
    if (plan.plan_type === 'tiered') return `Tiered (${(plan.tiered_slabs || []).length} slabs)`;
    return `${formatINR(plan.base_rate_pct)} flat`;
  };

  return (
    <div>
      <ConfirmDialog
        open={!!pendingDeleteId}
        title="Deactivate Plan"
        message="This plan will be deactivated. Existing commission entries will not be affected."
        confirmLabel="Deactivate"
        variant="danger"
        onConfirm={deletePlan}
        onCancel={() => setPendingDeleteId(null)}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Commission Plans</h2>
        <Btn onClick={openNew}>+ New Plan</Btn>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
      ) : plans.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af', background: LIGHT, borderRadius: 12 }}>
          No commission plans yet. Create the first one.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 20 }}>
          {plans.map(plan => (
            <div key={plan.id} style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 14, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <Avatar name={plan.rep_name || plan.name} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: '#1a1a2e' }}>{plan.rep_name || 'Unassigned'}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>{plan.name}</div>
                </div>
              </div>
              <div style={{ marginBottom: 10 }}><Badge color={typeColors[plan.plan_type] || 'grey'}>{plan.plan_type}</Badge></div>
              <div style={{ fontSize: 20, fontWeight: 800, color: PURPLE, marginBottom: 8 }}>{rateDisplay(plan)}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                {plan.effective_from || '—'} → {plan.effective_to || 'Ongoing'}
              </div>
              <div style={{ marginBottom: 14 }}>
                <span style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                  Clawback {plan.clawback_period_days}d
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Toggle checked={plan.is_active} onChange={() => toggleActive(plan)} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn size="sm" variant="outline" onClick={() => openEdit(plan)}>Edit</Btn>
                  <Btn size="sm" variant="danger" onClick={() => setPendingDeleteId(plan.id)}>Del</Btn>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Drawer open={showDrawer} onClose={() => setShowDrawer(false)} title={editPlan ? 'Edit Plan' : 'New Commission Plan'}>
        <FormField label="Plan Name"><Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Standard Sales Commission" /></FormField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FormField label="Rep Name"><Input value={form.rep_name} onChange={e => setForm(p => ({ ...p, rep_name: e.target.value }))} placeholder="e.g. Ravi Kumar" /></FormField>
          <FormField label="Rep ID"><Input type="number" value={form.rep_id} onChange={e => setForm(p => ({ ...p, rep_id: e.target.value }))} placeholder="e.g. 101" /></FormField>
        </div>
        <FormField label="Plan Type">
          <Select value={form.plan_type} onChange={e => setForm(p => ({ ...p, plan_type: e.target.value }))}>
            <option value="percentage">Percentage</option>
            <option value="tiered">Tiered</option>
            <option value="flat">Flat Amount</option>
          </Select>
        </FormField>
        {form.plan_type === 'percentage' && (
          <FormField label="Commission Rate (%)"><Input type="number" value={form.base_rate_pct} onChange={e => setForm(p => ({ ...p, base_rate_pct: e.target.value }))} placeholder="e.g. 4.5" step="0.1" /></FormField>
        )}
        {form.plan_type === 'flat' && (
          <FormField label="Fixed Amount (₹)"><Input type="number" value={form.base_rate_pct} onChange={e => setForm(p => ({ ...p, base_rate_pct: e.target.value }))} placeholder="e.g. 15000" /></FormField>
        )}
        {form.plan_type === 'tiered' && (
          <FormField label="Tiered Slabs">
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: LIGHT }}>{['Min Rev ₹', 'Max Rev ₹', 'Rate %', ''].map(h => <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280' }}>{h}</th>)}</tr></thead>
                <tbody>
                  {form.tiered_slabs.map((slab, i) => (
                    <tr key={i} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}>
                      <td style={{ padding: '6px 8px' }}><Input type="number" value={slab.min_revenue} onChange={e => updateSlab(i, 'min_revenue', e.target.value)} style={{ fontSize: 12, padding: '4px 6px' }} /></td>
                      <td style={{ padding: '6px 8px' }}><Input type="number" value={slab.max_revenue} onChange={e => updateSlab(i, 'max_revenue', e.target.value)} placeholder="∞" style={{ fontSize: 12, padding: '4px 6px' }} /></td>
                      <td style={{ padding: '6px 8px' }}><Input type="number" value={slab.rate_pct} onChange={e => updateSlab(i, 'rate_pct', e.target.value)} style={{ fontSize: 12, padding: '4px 6px' }} /></td>
                      <td style={{ padding: '6px 8px' }}><Btn size="sm" variant="danger" onClick={() => removeSlab(i)}>×</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Btn size="sm" variant="ghost" onClick={addSlab}>+ Add Slab</Btn>
          </FormField>
        )}
        <FormField label="Applies To">
          <Select value={form.applies_to} onChange={e => setForm(p => ({ ...p, applies_to: e.target.value }))}>
            <option value="all_products">All Products</option>
            <option value="specific">Specific Products</option>
          </Select>
        </FormField>
        {form.applies_to === 'specific' && (
          <FormField label="Product IDs (comma separated)"><Input value={form.product_ids} onChange={e => setForm(p => ({ ...p, product_ids: e.target.value }))} placeholder="P001, P002, P003" /></FormField>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FormField label="Effective From"><Input type="date" value={form.effective_from} onChange={e => setForm(p => ({ ...p, effective_from: e.target.value }))} /></FormField>
          <FormField label="Effective To"><Input type="date" value={form.effective_to} onChange={e => setForm(p => ({ ...p, effective_to: e.target.value }))} /></FormField>
        </div>
        <FormField label="Clawback Period (days)"><Input type="number" value={form.clawback_period_days} onChange={e => setForm(p => ({ ...p, clawback_period_days: parseInt(e.target.value) || 30 }))} /></FormField>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Btn variant="ghost" onClick={() => setShowDrawer(false)}>Cancel</Btn>
          <Btn onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Plan'}</Btn>
        </div>
      </Drawer>
    </div>
  );
}

// ─── Tab 2: Statements ────────────────────────────────────────────────────────

function StatementsTab() {
  const [plans, setPlans] = useState([]);
  const [selectedRepId, setSelectedRepId] = useState('');
  const [statement, setStatement] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stmtError, setStmtError] = useState('');

  useEffect(() => {
    (async () => {
      const [r] = await Promise.allSettled([api.get('/commissions/plans')]);
      setPlans(r.status === 'fulfilled' ? (r.value.data || []) : []);
    })();
  }, []);

  const loadStatement = useCallback(async (repId) => {
    if (!repId) return;
    setStmtError('');
    setStatement(null);
    setLoading(true);
    const [r] = await Promise.allSettled([api.get(`/commissions/statements/${repId}`)]);
    if (r.status === 'fulfilled') {
      setStatement(r.value.data);
    } else {
      setStmtError(r.reason?.response?.data?.error || r.reason?.message || 'Failed to load statement.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (selectedRepId) loadStatement(selectedRepId); }, [selectedRepId, loadStatement]);

  const statusColor = { pending: 'amber', approved: 'green', paid: 'blue', clawback: 'red' };

  const totalCommission = statement ? statement.entries.filter(e => e.status !== 'clawback').reduce((s, e) => s + parseFloat(e.commission_amount), 0) : 0;
  const totalClawbacks = statement ? statement.clawbacks.reduce((s, e) => s + parseFloat(e.commission_amount), 0) : 0;
  const netAmount = totalCommission - totalClawbacks;

  const achievedPct = statement?.ytd_total && statement?.plan?.target
    ? Math.min(100, (statement.ytd_total / statement.plan.target) * 100)
    : 0;
  const pieData = [
    { name: 'Achieved', value: Math.round(achievedPct) },
    { name: 'Remaining', value: Math.max(0, 100 - Math.round(achievedPct)) }
  ];
  const PIE_COLORS = [PURPLE, '#e9e4ff'];

  const assignedReps = plans.filter(p => p.rep_id && p.rep_name);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginRight: 12 }}>Select Sales Rep:</label>
        <select value={selectedRepId} onChange={e => setSelectedRepId(e.target.value)} style={{ padding: '8px 16px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, background: '#fff', outline: 'none', minWidth: 220 }}>
          <option value="">-- Choose Rep --</option>
          {assignedReps.map(p => <option key={p.rep_id} value={p.rep_id}>{p.rep_name}</option>)}
        </select>
      </div>

      {!selectedRepId && (
        <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af', background: LIGHT, borderRadius: 12 }}>
          Select a sales representative to view their commission statement
        </div>
      )}

      {selectedRepId && loading && (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading statement...</div>
      )}

      {selectedRepId && !loading && stmtError && (
        <div style={{ padding: 24, textAlign: 'center', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, color: '#dc2626' }}>
          {stmtError}
        </div>
      )}

      {selectedRepId && !loading && statement && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20, marginBottom: 28 }}>
            <div style={{ background: LIGHT, borderRadius: 14, padding: '20px 24px', border: `1px solid ${BORDER}` }}>
              <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 6 }}>{statement.rep_name} — YTD Earnings</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: PURPLE }}>{formatINR(statement.ytd_total)}</div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>earned this year</div>
              <div style={{ marginTop: 8, fontSize: 13, color: '#d97706' }}>Pending: {formatINR(statement.pending_amount)}</div>
            </div>
            <div style={{ background: '#fff', borderRadius: 14, padding: 16, border: '1px solid #f0f0f4', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>YTD Achievement</div>
              <ResponsiveContainer width="100%" height={120}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={35} outerRadius={55} dataKey="value" startAngle={90} endAngle={-270}>
                    {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i]} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div style={{ fontSize: 18, fontWeight: 800, color: PURPLE, marginTop: -8 }}>{Math.round(achievedPct)}%</div>
            </div>
            <div style={{ background: '#fff', borderRadius: 14, padding: 16, border: '1px solid #f0f0f4' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Plan Details</div>
              <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.8 }}>
                <div>Type: <strong style={{ color: '#374151' }}>{statement.plan.plan_type}</strong></div>
                <div>Rate: <strong style={{ color: PURPLE }}>{statement.plan.plan_type === 'tiered' ? `${(statement.plan.tiered_slabs || []).length} slabs` : `${statement.plan.base_rate_pct}%`}</strong></div>
                <div>Clawback: <strong style={{ color: '#374151' }}>{statement.plan.clawback_period_days} days</strong></div>
              </div>
            </div>
          </div>

          <div style={{ background: '#fff', borderRadius: 14, padding: 20, border: '1px solid #f0f0f4', marginBottom: 24 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 14 }}>Monthly Earnings</div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={statement.monthly_earnings} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => `₹${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => [formatINR(v), 'Commission']} />
                <Bar dataKey="amount" fill={PURPLE} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: LIGHT }}>
                  {['Order Ref', 'Customer', 'Sale Amount', 'Rate %', 'Commission', 'Status', 'Earned Date'].map(h => (
                    <th key={h} style={{ padding: '12px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {statement.entries.length === 0 ? (
                  <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No commission entries yet.</td></tr>
                ) : statement.entries.map((e, i) => (
                  <tr key={e.id} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}>
                    <td style={{ padding: '12px 14px', fontWeight: 600, color: PURPLE }}>{e.order_ref}</td>
                    <td style={{ padding: '12px 14px', color: '#374151' }}>{e.customer_name}</td>
                    <td style={{ padding: '12px 14px' }}>{formatINR(e.sale_amount)}</td>
                    <td style={{ padding: '12px 14px', color: '#6b7280' }}>{e.commission_rate}%</td>
                    <td style={{ padding: '12px 14px', fontWeight: 700, color: '#1a1a2e' }}>{formatINR(e.commission_amount)}</td>
                    <td style={{ padding: '12px 14px' }}><Badge color={statusColor[e.status] || 'grey'}>{e.status}</Badge></td>
                    <td style={{ padding: '12px 14px', fontSize: 13, color: '#9ca3af' }}>{e.earned_date ? new Date(e.earned_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  </tr>
                ))}
                {statement.entries.length > 0 && (
                  <tr style={{ borderTop: '2px solid #e9e4ff', background: LIGHT }}>
                    <td colSpan={4} style={{ padding: '12px 14px', fontWeight: 700, color: '#374151' }}>Totals ({statement.entries.length} entries)</td>
                    <td style={{ padding: '12px 14px', fontWeight: 800, color: PURPLE }}>{formatINR(totalCommission)}</td>
                    <td style={{ padding: '12px 14px', fontSize: 12, color: '#dc2626' }}>Clawback: {formatINR(totalClawbacks)}</td>
                    <td style={{ padding: '12px 14px', fontWeight: 800, color: '#16a34a' }}>Net: {formatINR(netAmount)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tab 3: Payouts ───────────────────────────────────────────────────────────

function PayoutsTab() {
  const toast = useToast();
  const [payouts, setPayouts] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [genForm, setGenForm] = useState({ rep_id: '', period_from: '', period_to: '' });
  const [preview, setPreview] = useState(null);
  const [computing, setComputing] = useState(false);

  const load = useCallback(async () => {
    const [payR, planR] = await Promise.allSettled([api.get('/commissions/payouts'), api.get('/commissions/plans')]);
    setPayouts(payR.status === 'fulfilled' ? (payR.value.data || []) : []);
    setPlans(planR.status === 'fulfilled' ? (planR.value.data || []) : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const computePreview = async () => {
    setComputing(true);
    const [r] = await Promise.allSettled([api.get(`/commissions/statements/${genForm.rep_id}`)]);
    const entries = r.status === 'fulfilled' ? (r.value.data?.entries || []) : [];
    const filtered = entries.filter(e => e.status !== 'clawback');
    const total = filtered.reduce((s, e) => s + parseFloat(e.commission_amount || 0), 0);
    setPreview({ entries: filtered, total, net: total });
    setComputing(false);
  };

  const createPayout = async () => {
    try {
      await api.post('/commissions/payouts', genForm);
      toast.success('Payout created.');
      setShowModal(false);
      setPreview(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to create payout.');
    }
  };

  const approvePayout = async (id) => {
    try {
      await api.post(`/commissions/payouts/${id}/approve`);
      toast.success('Payout approved.');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to approve payout.');
    }
  };

  const markPaid = async (id) => {
    try {
      await api.put(`/commissions/payouts/${id}`, { status: 'paid', payment_date: new Date().toISOString().split('T')[0] });
      toast.success('Payout marked as paid.');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to mark payout as paid.');
    }
  };

  const statusColor = { draft: 'grey', approved: 'green', paid: 'blue' };

  const fmtPeriod = (from) => {
    if (!from) return '—';
    const f = new Date(from);
    return `${f.toLocaleString('default', { month: 'short' })} ${f.getFullYear()}`;
  };

  const assignedReps = plans.filter(p => p.rep_id && p.rep_name);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Commission Payouts</h2>
        <Btn onClick={() => setShowModal(true)}>Generate Payout</Btn>
      </div>

      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: LIGHT }}>
              {['Rep Name', 'Period', 'Total Commission', 'Deductions', 'Net Payout', 'Status', 'Payment Date', 'Actions'].map(h => (
                <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Loading...</td></tr>
            ) : payouts.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No payouts generated yet.</td></tr>
            ) : payouts.map((p, i) => (
              <tr key={p.id} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}>
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Avatar name={p.rep_name} size={30} />
                    <span style={{ fontWeight: 600, color: '#1a1a2e' }}>{p.rep_name}</span>
                  </div>
                </td>
                <td style={{ padding: '12px 16px', color: '#6b7280' }}>{fmtPeriod(p.period_from)}</td>
                <td style={{ padding: '12px 16px', fontWeight: 600 }}>{formatINR(p.total_commission)}</td>
                <td style={{ padding: '12px 16px', color: '#dc2626' }}>-{formatINR(p.deductions)}</td>
                <td style={{ padding: '12px 16px', fontWeight: 700, color: PURPLE }}>{formatINR(p.net_payout)}</td>
                <td style={{ padding: '12px 16px' }}><Badge color={statusColor[p.status] || 'grey'}>{p.status}</Badge></td>
                <td style={{ padding: '12px 16px', fontSize: 13, color: '#9ca3af' }}>{p.payment_date || '—'}</td>
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {p.status === 'draft' && <Btn size="sm" variant="success" onClick={() => approvePayout(p.id)}>Approve</Btn>}
                    {p.status === 'approved' && <Btn size="sm" variant="primary" onClick={() => markPaid(p.id)}>Mark Paid</Btn>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={showModal} onClose={() => { setShowModal(false); setPreview(null); }} title="Generate Payout">
        <FormField label="Sales Rep">
          <Select value={genForm.rep_id} onChange={e => setGenForm(p => ({ ...p, rep_id: e.target.value }))}>
            <option value="">Select Rep</option>
            {assignedReps.map(p => <option key={p.rep_id} value={p.rep_id}>{p.rep_name}</option>)}
          </Select>
        </FormField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <FormField label="Period From"><Input type="date" value={genForm.period_from} onChange={e => setGenForm(p => ({ ...p, period_from: e.target.value }))} /></FormField>
          <FormField label="Period To"><Input type="date" value={genForm.period_to} onChange={e => setGenForm(p => ({ ...p, period_to: e.target.value }))} /></FormField>
        </div>
        <Btn variant="outline" onClick={computePreview} disabled={computing || !genForm.rep_id}>{computing ? 'Computing...' : 'Compute Preview'}</Btn>

        {preview && (
          <div style={{ marginTop: 16, background: LIGHT, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>Preview ({preview.entries.length} entries)</div>
            {preview.entries.length === 0 ? (
              <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: 8 }}>No approved entries found for this rep.</div>
            ) : (
              <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 8, overflow: 'hidden', fontSize: 12, marginBottom: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr style={{ background: LIGHT }}>{['Order Ref', 'Customer', 'Commission'].map(h => <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280' }}>{h}</th>)}</tr></thead>
                  <tbody>{preview.entries.map((e, i) => <tr key={i} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}><td style={{ padding: '6px 10px' }}>{e.order_ref}</td><td style={{ padding: '6px 10px' }}>{e.customer_name}</td><td style={{ padding: '6px 10px', fontWeight: 600, color: PURPLE }}>{formatINR(e.commission_amount)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: '#374151' }}>
              <span>Net Payout:</span>
              <span style={{ color: PURPLE, fontSize: 16 }}>{formatINR(preview.net)}</span>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 20 }}>
          <Btn variant="ghost" onClick={() => { setShowModal(false); setPreview(null); }}>Cancel</Btn>
          {preview && preview.entries.length > 0 && <Btn onClick={createPayout}>Create Payout</Btn>}
        </div>
      </Modal>
    </div>
  );
}

// ─── Tab 4: Leaderboard ───────────────────────────────────────────────────────

function LeaderboardTab() {
  const [leaders, setLeaders] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const [r] = await Promise.allSettled([api.get('/commissions/leaderboard')]);
    setLeaders(r.status === 'fulfilled' ? (r.value.data || []) : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const top3 = leaders.slice(0, 3);
  const rest = leaders.slice(3);
  const podiumOrder = top3.length >= 3 ? [top3[1], top3[0], top3[2]] : top3;
  const podiumHeights = [100, 130, 85];
  const podiumColors = ['#c0c0c0', GOLD, '#cd7f32'];
  const topCommission = leaders[0]?.commission_earned || 1;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#1a1a2e' }}>Sales Leaderboard</h2>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
      ) : leaders.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af', background: LIGHT, borderRadius: 12 }}>
          No commission data yet. Record commissions via the Plans tab.
        </div>
      ) : (
        <>
          {top3.length >= 3 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', gap: 24, marginBottom: 40, padding: '20px 0' }}>
              {podiumOrder.map((rep, i) => {
                if (!rep) return null;
                const isFirst = rep.rank === 1;
                return (
                  <div key={rep.rep_id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                    {isFirst && <div style={{ fontSize: 24, marginBottom: 4 }}>👑</div>}
                    <Avatar name={rep.rep_name} size={isFirst ? 56 : 44} bg={podiumColors[i]} />
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#1a1a2e', maxWidth: 100 }}>{rep.rep_name}</div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: isFirst ? GOLD : '#6b7280' }}>{formatINR(rep.commission_earned)}</div>
                    </div>
                    <div style={{ background: podiumColors[i], borderRadius: '6px 6px 0 0', width: 80, height: podiumHeights[i], display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 10 }}>
                      <span style={{ color: '#fff', fontWeight: 800, fontSize: 22 }}>{rep.rank}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: LIGHT }}>
                  {['Rank', 'Sales Rep', 'Total Sales', 'Commission Earned', 'Progress', 'Deals'].map(h => (
                    <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(rest.length > 0 ? rest : leaders).map((rep, i) => {
                  const pct = Math.min(100, (rep.commission_earned / topCommission) * 100);
                  const medals = ['🥇', '🥈', '🥉'];
                  const rankDisplay = rep.rank <= 3 ? medals[rep.rank - 1] : `#${rep.rank}`;
                  return (
                    <tr key={rep.rep_id} style={{ borderTop: i > 0 ? '1px solid #f0f0f4' : 'none' }}>
                      <td style={{ padding: '14px 16px', fontWeight: 800, fontSize: rep.rank <= 3 ? 20 : 16, color: '#9ca3af' }}>{rankDisplay}</td>
                      <td style={{ padding: '14px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <Avatar name={rep.rep_name} size={32} />
                          <span style={{ fontWeight: 600, color: '#1a1a2e' }}>{rep.rep_name}</span>
                        </div>
                      </td>
                      <td style={{ padding: '14px 16px', color: '#6b7280' }}>{formatINR(rep.achieved_amount)}</td>
                      <td style={{ padding: '14px 16px', fontWeight: 700, color: PURPLE, fontSize: 15 }}>{formatINR(rep.commission_earned)}</td>
                      <td style={{ padding: '14px 16px', minWidth: 120 }}>
                        <div style={{ background: '#f0f0f4', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                          <div style={{ background: PURPLE, width: `${pct}%`, height: '100%', borderRadius: 4, transition: 'width 0.4s' }} />
                        </div>
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{Math.round(pct)}%</div>
                      </td>
                      <td style={{ padding: '14px 16px', color: '#374151' }}>{rep.deal_count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CommissionManagement() {
  const [activeTab, setActiveTab] = useState(0);
  const tabs = ['Plans', 'Statements', 'Payouts', 'Leaderboard'];

  return (
    <div style={{ padding: 32, background: '#fafafa', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: '#1a1a2e' }}>Commission Management</div>
        <div style={{ fontSize: 14, color: '#9ca3af', marginTop: 4 }}>Manage commission plans, statements, payouts and track rep performance</div>
      </div>

      <div style={{ marginTop: 24, marginBottom: 0 }}>
        <StatsBar />
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: `2px solid ${BORDER}`, marginBottom: 28 }}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setActiveTab(i)} style={{
            padding: '10px 24px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: activeTab === i ? 700 : 500,
            color: activeTab === i ? PURPLE : '#6b7280',
            borderBottom: activeTab === i ? `2px solid ${PURPLE}` : '2px solid transparent',
            marginBottom: -2, transition: 'all 0.15s'
          }}>{t}</button>
        ))}
      </div>

      {activeTab === 0 && <PlansTab />}
      {activeTab === 1 && <StatementsTab />}
      {activeTab === 2 && <PayoutsTab />}
      {activeTab === 3 && <LeaderboardTab />}
    </div>
  );
}
