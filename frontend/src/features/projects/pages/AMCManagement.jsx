import { useState, useEffect, useCallback, useRef } from 'react';
import { Shield, Plus, X, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react';
import api from '@/services/api/client';
import { getProjects } from '../services/projectsService';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const STATUS_META = {
  active:    { bg: '#dcfce7', color: '#15803d', label: 'Active' },
  expired:   { bg: '#fee2e2', color: '#dc2626', label: 'Expired' },
  cancelled: { bg: '#f3f4f6', color: '#6b7280', label: 'Cancelled' },
};

const empty = () => ({
  project_id: '', sales_order_id: '', product_name: '', serial_number: '',
  start_date: '', end_date: '', annual_cost: 0, sla_response_hours: 4,
  preventive_visits_per_year: 2, scope_of_work: '', exclusions: '',
  auto_renew: false, renewal_amount: 0, status: 'active',
});

export default function AMCManagement({ setPage }) {
  const [contracts,   setContracts]   = useState([]);
  const [projects,    setProjects]    = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [drawer,      setDrawer]      = useState(false);
  const [editItem,    setEditItem]    = useState(null);
  const [form,        setForm]        = useState(empty());
  const [toast,       setToast]       = useState(null);
  const [genVisitId,  setGenVisitId]  = useState(null);
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);
  const isMounted = useRef(true);

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);
  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [amcRes, prjRes] = await Promise.allSettled([
        api.get('/lifecycle/amc-contracts'),
        getProjects(),
      ]);
      if (!isMounted.current) return;
      setContracts(amcRes.status === 'fulfilled' ? (amcRes.value.data?.contracts || amcRes.value.data || []) : []);
      setProjects(prjRes.status === 'fulfilled' ? prjRes.value : []);
    } catch { /* */ }
    if (isMounted.current) setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditItem(null); setForm(empty()); setDrawer(true); };
  const openEdit   = (c) => { setEditItem(c); setForm({ ...c }); setDrawer(true); };

  const handleSave = async () => {
    try {
      if (editItem) {
        await api.put(`/lifecycle/amc-contracts/${editItem.id}`, form);
        showToast('AMC contract updated');
      } else {
        await api.post('/lifecycle/amc-contracts', form);
        showToast('AMC contract created');
      }
      setDrawer(false);
      load();
    } catch (e) { showToast(e.response?.data?.error || 'Failed to save', 'error'); }
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/lifecycle/amc-contracts/${id}`);
      showToast('Contract deleted');
      load();
    } catch { showToast('Delete failed', 'error'); }
  };

  const handleGenerateVisits = async (id) => {
    setGenVisitId(id);
    try {
      const res = await api.post(`/lifecycle/amc-contracts/${id}/generate-visits`);
      showToast(`Generated ${res.data?.visits?.length || 0} preventive visit(s)`);
    } catch (e) { showToast(e.response?.data?.error || 'Failed to generate visits', 'error'); }
    finally { setGenVisitId(null); }
  };

  const fmt = (n) => {
    const v = parseFloat(n || 0);
    if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
    return `₹${v.toLocaleString('en-IN')}`;
  };

  const active  = contracts.filter(c => c.status === 'active').length;
  const expired = contracts.filter(c => c.status === 'expired').length;
  const totalARR = contracts.filter(c => c.status === 'active').reduce((s, c) => s + parseFloat(c.annual_cost || 0), 0);

  return (
    <div style={{ padding: '20px 24px' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete AMC Contract"
        message="Delete this AMC contract?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      {toast && <div style={{ position: 'fixed', top: 16, right: 16, padding: '10px 16px', borderRadius: 8, zIndex: 9999, background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4', color: toast.type === 'error' ? '#dc2626' : '#15803d', border: `1px solid ${toast.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{toast.msg}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>AMC Management</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Annual Maintenance Contracts — manage, renew, and schedule preventive visits</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}><RefreshCw size={14} /></button>
          <button onClick={openCreate} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            <Plus size={14} /> New AMC
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Contracts', value: contracts.length, color: '#6366f1', bg: '#eef2ff' },
          { label: 'Active', value: active, color: '#15803d', bg: '#f0fdf4' },
          { label: 'Expired', value: expired, color: '#dc2626', bg: '#fef2f2' },
          { label: 'Annual Revenue', value: fmt(totalARR), color: '#0369a1', bg: '#e0f2fe' },
        ].map(k => (
          <div key={k.label} style={{ background: k.bg, borderRadius: 8, padding: '14px 16px', border: `1px solid ${k.color}22` }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: k.color }}>{k.value}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{k.label}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#6b7280' }}>Loading AMC contracts…</div>
      ) : contracts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Shield size={36} style={{ color: '#9ca3af', marginBottom: 8 }} />
          <p style={{ color: '#6b7280', margin: 0 }}>No AMC contracts found</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {contracts.map(c => {
            const sm = STATUS_META[c.status] || STATUS_META.active;
            const daysLeft = c.end_date ? Math.ceil((new Date(c.end_date) - new Date()) / 86400000) : null;
            const expiringSoon = daysLeft !== null && daysLeft > 0 && daysLeft <= 60;
            return (
              <div key={c.id} style={{ background: 'var(--color-background-secondary)', border: `1px solid ${expiringSoon ? '#fed7aa' : 'var(--color-border-tertiary)'}`, borderRadius: 10, padding: '16px 18px', borderLeft: `4px solid ${sm.color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#9ca3af' }}>{c.amc_number}</span>
                      <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: sm.bg, color: sm.color }}>{sm.label}</span>
                      {expiringSoon && <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: '#fff7ed', color: '#ea580c' }}>⚠ Expires in {daysLeft}d</span>}
                      {c.auto_renew && <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, background: '#e0e7ff', color: '#4338ca' }}>Auto-Renew</span>}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
                      {c.product_name || 'AMC Contract'} {c.serial_number ? `(S/N: ${c.serial_number})` : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 20, fontSize: 12, color: '#9ca3af', flexWrap: 'wrap' }}>
                      {c.start_date && <span>Start: <b style={{ color: 'var(--color-text-secondary)' }}>{new Date(c.start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</b></span>}
                      {c.end_date && <span>End: <b style={{ color: daysLeft <= 30 && daysLeft > 0 ? '#dc2626' : 'var(--color-text-secondary)' }}>{new Date(c.end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</b></span>}
                      <span>Annual Value: <b style={{ color: '#0369a1' }}>{fmt(c.annual_cost)}</b></span>
                      <span>SLA: <b style={{ color: 'var(--color-text-secondary)' }}>{c.sla_response_hours}h response</b></span>
                      <span>Visits/yr: <b style={{ color: 'var(--color-text-secondary)' }}>{c.preventive_visits_per_year}</b></span>
                    </div>
                    {c.scope_of_work && <p style={{ fontSize: 12, color: '#6b7280', margin: '6px 0 0', lineHeight: 1.4 }}>{c.scope_of_work}</p>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-start', marginLeft: 12 }}>
                    <button onClick={() => handleGenerateVisits(c.id)} disabled={genVisitId === c.id} style={{ padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer', fontSize: 11 }}>
                      {genVisitId === c.id ? 'Generating…' : 'Gen Visits'}
                    </button>
                    <button onClick={() => openEdit(c)} style={{ padding: '6px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer', fontSize: 12 }}>Edit</button>
                    <button onClick={() => setPendingHandleDelete(c.id)} style={{ padding: '6px 12px', border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* AMC Form Drawer */}
      {drawer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }} onClick={() => setDrawer(false)}>
          <div style={{ width: 520, background: 'var(--color-background)', height: '100%', overflowY: 'auto', padding: 24 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0 }}>{editItem ? 'Edit AMC Contract' : 'New AMC Contract'}</h3>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
            </div>

            {[
              { label: 'Product Name', key: 'product_name' },
              { label: 'Serial Number', key: 'serial_number' },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>{f.label}</label>
                <input value={form[f.key] || ''} onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
            ))}

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Link to Project</label>
              <select value={form.project_id || ''} onChange={e => setForm(prev => ({ ...prev, project_id: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
                <option value="">— No Project —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.project_code} — {p.project_name}</option>)}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              {['start_date', 'end_date'].map(k => (
                <div key={k}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>{k === 'start_date' ? 'Start Date' : 'End Date'}</label>
                  <input type="date" value={form[k] || ''} onChange={e => setForm(prev => ({ ...prev, [k]: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
                </div>
              ))}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Annual Cost (₹)</label>
                <input type="number" value={form.annual_cost || 0} onChange={e => setForm(prev => ({ ...prev, annual_cost: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>SLA Response (hours)</label>
                <input type="number" value={form.sla_response_hours || 4} onChange={e => setForm(prev => ({ ...prev, sla_response_hours: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Preventive Visits/Year</label>
                <input type="number" value={form.preventive_visits_per_year || 2} onChange={e => setForm(prev => ({ ...prev, preventive_visits_per_year: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Status</label>
                <select value={form.status || 'active'} onChange={e => setForm(prev => ({ ...prev, status: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
                  <option value="active">Active</option>
                  <option value="expired">Expired</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Scope of Work</label>
              <textarea rows={3} value={form.scope_of_work || ''} onChange={e => setForm(prev => ({ ...prev, scope_of_work: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, resize: 'vertical', background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Exclusions</label>
              <textarea rows={2} value={form.exclusions || ''} onChange={e => setForm(prev => ({ ...prev, exclusions: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, resize: 'vertical', background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.auto_renew || false} onChange={e => setForm(prev => ({ ...prev, auto_renew: e.target.checked }))} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>Enable Auto-Renewal</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDrawer(false)} style={{ padding: '10px 20px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSave} style={{ padding: '10px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}>
                {editItem ? 'Update AMC' : 'Create AMC'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
