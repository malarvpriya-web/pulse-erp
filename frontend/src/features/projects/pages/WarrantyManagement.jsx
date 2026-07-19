import { useState, useEffect, useCallback, useRef } from 'react';
import { ShieldCheck, Plus, X, RefreshCw, AlertTriangle } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import api from '@/services/api/client';
import { getProjects } from '../services/projectsService';

const STATUS_META = {
  active:  { bg: '#dcfce7', color: '#15803d', label: 'Under Warranty' },
  expired: { bg: '#fee2e2', color: '#dc2626', label: 'Expired' },
  claimed: { bg: '#fef9c3', color: '#ca8a04', label: 'Claimed' },
};

const empty = () => ({
  project_id: '', product_name: '', serial_number: '', commissioning_date: '',
  warranty_start_date: '', warranty_end_date: '', warranty_type: 'comprehensive',
  coverage_description: '', exclusions: '', manufacturer_warranty_months: 12,
  extended_warranty_months: 0, status: 'active',
});

export default function WarrantyManagement({ setPage }) {
  const [warranties, setWarranties] = useState([]);
  const [projects,   setProjects]   = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [drawer,     setDrawer]     = useState(false);
  const [editItem,   setEditItem]   = useState(null);
  const [form,       setForm]       = useState(empty());
  const [toast,      setToast]      = useState(null);
  const [pendingConvertAMC, setPendingConvertAMC] = useState(null);
  const isMounted = useRef(true);

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);
  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [wRes, pRes] = await Promise.allSettled([
        api.get('/projects/warranties'),
        getProjects(),
      ]);
      if (!isMounted.current) return;
      setWarranties(wRes.status === 'fulfilled' ? (wRes.value.data?.warranties || wRes.value.data || []) : []);
      setProjects(pRes.status === 'fulfilled' ? pRes.value : []);
    } catch { /* */ }
    if (isMounted.current) setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditItem(null); setForm(empty()); setDrawer(true); };
  const openEdit   = (w) => { setEditItem(w); setForm({ ...w }); setDrawer(true); };

  const handleSave = async () => {
    try {
      if (!form.project_id) { showToast('Please select a project', 'error'); return; }
      if (editItem) {
        await api.put(`/projects/warranties/${editItem.id}`, form);

        showToast('Warranty updated');
      } else {
        await api.post(`/projects/projects/${form.project_id}/warranties`, form);
        showToast('Warranty record created');
      }
      setDrawer(false);
      load();
    } catch (e) { showToast(e.response?.data?.error || 'Save failed', 'error'); }
  };

  const handleConvertAMC = async () => {
    if (!pendingConvertAMC) return;
    const w = pendingConvertAMC;
    setPendingConvertAMC(null);
    try {
      await api.post('/lifecycle/amc-contracts', {
        project_id: w.project_id,
        product_name: w.product_name,
        serial_number: w.serial_number,
        start_date: w.warranty_end_date,
        annual_cost: 0,
        status: 'active',
        scope_of_work: `Post-warranty AMC for ${w.product_name}`,
      });
      showToast('AMC contract created — set cost in AMC Management');
      if (setPage) setPage('amc-management');
    } catch (e) { showToast('Conversion failed', 'error'); }
  };

  const active   = warranties.filter(w => w.status === 'active').length;
  const expired  = warranties.filter(w => w.status === 'expired').length;
  const expiringSoon = warranties.filter(w => {
    if (!w.warranty_end_date) return false;
    const d = Math.ceil((new Date(w.warranty_end_date) - new Date()) / 86400000);
    return d > 0 && d <= 90 && w.status === 'active';
  }).length;

  return (
    <div style={{ padding: '20px 24px' }}>
      <ConfirmDialog
        open={!!pendingConvertAMC}
        title="Convert to AMC"
        message="Convert this warranty to an AMC contract?"
        confirmLabel="Convert"
        variant="info"
        onConfirm={handleConvertAMC}
        onCancel={() => setPendingConvertAMC(null)}
      />
      {toast && <div style={{ position: 'fixed', top: 16, right: 16, padding: '10px 16px', borderRadius: 8, zIndex: 9999, background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4', color: toast.type === 'error' ? '#dc2626' : '#15803d', border: `1px solid ${toast.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{toast.msg}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Warranty Management</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Track product warranties, expiry dates, and convert to AMC contracts</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}><RefreshCw size={14} /></button>
          <button onClick={openCreate} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#0d9488', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            <Plus size={14} /> Add Warranty
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total', value: warranties.length, color: '#6366f1', bg: '#eef2ff' },
          { label: 'Under Warranty', value: active, color: '#15803d', bg: '#f0fdf4' },
          { label: 'Expiring (90d)', value: expiringSoon, color: '#ea580c', bg: '#fff7ed' },
          { label: 'Expired', value: expired, color: '#dc2626', bg: '#fef2f2' },
        ].map(k => (
          <div key={k.label} style={{ background: k.bg, borderRadius: 8, padding: '14px 16px', border: `1px solid ${k.color}22` }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: k.color }}>{k.value}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{k.label}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#6b7280' }}>Loading warranties…</div>
      ) : warranties.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <ShieldCheck size={36} style={{ color: '#9ca3af', marginBottom: 8 }} />
          <p style={{ color: '#6b7280', margin: 0 }}>No warranty records found</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {warranties.map(w => {
            const sm = STATUS_META[w.status] || STATUS_META.active;
            const daysLeft = w.warranty_end_date ? Math.ceil((new Date(w.warranty_end_date) - new Date()) / 86400000) : null;
            const expSoon = daysLeft !== null && daysLeft > 0 && daysLeft <= 90;
            return (
              <div key={w.id} style={{ background: 'var(--color-background-secondary)', border: `1px solid ${expSoon ? '#fed7aa' : 'var(--color-border-tertiary)'}`, borderRadius: 10, padding: '16px 18px', borderLeft: `4px solid ${sm.color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: sm.bg, color: sm.color }}>{sm.label}</span>
                      {expSoon && <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: '#fff7ed', color: '#ea580c' }}><AlertTriangle size={10} /> Expiring in {daysLeft}d</span>}
                      <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, background: '#f0fdf4', color: '#15803d' }}>{(w.warranty_type || 'comprehensive').replace(/_/g, ' ')}</span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
                      {w.product_name} {w.serial_number ? `(S/N: ${w.serial_number})` : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 20, fontSize: 12, color: '#9ca3af', flexWrap: 'wrap' }}>
                      {w.commissioning_date && <span>Commissioned: <b style={{ color: 'var(--color-text-secondary)' }}>{new Date(w.commissioning_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</b></span>}
                      {w.warranty_start_date && <span>From: <b style={{ color: 'var(--color-text-secondary)' }}>{new Date(w.warranty_start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</b></span>}
                      {w.warranty_end_date && <span>To: <b style={{ color: daysLeft <= 30 && daysLeft > 0 ? '#dc2626' : 'var(--color-text-secondary)' }}>{new Date(w.warranty_end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</b></span>}
                      {w.project_code && <span>Project: <b style={{ color: 'var(--color-text-secondary)' }}>{w.project_code}</b></span>}
                    </div>
                    {w.coverage_description && <p style={{ fontSize: 12, color: '#6b7280', margin: '6px 0 0' }}>{w.coverage_description}</p>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-start', marginLeft: 12 }}>
                    {w.status === 'active' && expSoon && (
                      <button onClick={() => setPendingConvertAMC(w)} style={{ padding: '6px 10px', border: '1px solid #6B3FDB', background: '#f5f3ff', color: '#6B3FDB', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>→ AMC</button>
                    )}
                    <button onClick={() => openEdit(w)} style={{ padding: '6px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer', fontSize: 12 }}>Edit</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {drawer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }} onClick={() => setDrawer(false)}>
          <div style={{ width: 480, background: 'var(--color-background)', height: '100%', overflowY: 'auto', padding: 24 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0 }}>{editItem ? 'Edit Warranty' : 'Add Warranty Record'}</h3>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Project <span style={{ color: '#dc2626' }}>*</span></label>
              <select value={form.project_id || ''} onChange={e => setForm(p => ({ ...p, project_id: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
                <option value="">— Select Project —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.project_code} — {p.project_name}</option>)}
              </select>
            </div>

            {[{ label: 'Product Name', key: 'product_name' }, { label: 'Serial Number', key: 'serial_number' }].map(f => (
              <div key={f.key} style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>{f.label}</label>
                <input value={form[f.key] || ''} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
            ))}

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Warranty Type</label>
              <select value={form.warranty_type || 'comprehensive'} onChange={e => setForm(p => ({ ...p, warranty_type: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
                <option value="comprehensive">Comprehensive</option>
                <option value="parts_only">Parts Only</option>
                <option value="labour_only">Labour Only</option>
                <option value="limited">Limited</option>
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              {['commissioning_date', 'warranty_start_date', 'warranty_end_date'].map(k => (
                <div key={k} style={{ gridColumn: k === 'commissioning_date' ? 'span 2' : '1' }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>
                    {k === 'commissioning_date' ? 'Commissioning Date' : k === 'warranty_start_date' ? 'Warranty Start' : 'Warranty End'}
                  </label>
                  <input type="date" value={form[k] || ''} onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
                </div>
              ))}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Status</label>
                <select value={form.status || 'active'} onChange={e => setForm(p => ({ ...p, status: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
                  <option value="active">Active</option>
                  <option value="expired">Expired</option>
                  <option value="claimed">Claimed</option>
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Coverage Description</label>
              <textarea rows={3} value={form.coverage_description || ''} onChange={e => setForm(p => ({ ...p, coverage_description: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, resize: 'vertical', background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Exclusions</label>
              <textarea rows={2} value={form.exclusions || ''} onChange={e => setForm(p => ({ ...p, exclusions: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, resize: 'vertical', background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDrawer(false)} style={{ padding: '10px 20px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSave} style={{ padding: '10px 20px', background: '#0d9488', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}>
                {editItem ? 'Update' : 'Create Warranty'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
