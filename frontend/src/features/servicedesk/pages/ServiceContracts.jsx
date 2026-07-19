import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, FileText, Search, Pencil, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const STATUS_COLOR = {
  Active:  { bg: '#d1fae5', color: '#065f46' },
  Expired: { bg: '#fee2e2', color: '#991b1b' },
  Pending: { bg: '#fef3c7', color: '#92400e' },
};
const EMPTY = {
  customer_name: '', contract_type: 'AMC', start_date: '', end_date: '',
  value: '', sla_response_hrs: 4, sla_resolution_hrs: 24, notes: '',
};

const inputStyle = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };

export default function ServiceContracts() {
  const [contracts, setContracts] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [showForm,  setShowForm]  = useState(false);
  const [form,      setForm]      = useState(EMPTY);
  const [editId,    setEditId]    = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [search,    setSearch]    = useState('');
  const [pendingDeleteContract, setPendingDeleteContract] = useState(null);
  const toast = useToast();

  const load = () => {
    setLoading(true);
    api.get('/servicedesk/contracts', { params: { limit: 200 } })
      .then(r => setContracts(Array.isArray(r.data) ? r.data : []))
      .catch(err => { setContracts([]); toast.error(err.response?.data?.error || 'Failed to load contracts'); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditId(null); setForm(EMPTY); setShowForm(true); };
  const openEdit   = c  => { setEditId(c.id); setForm({ customer_name: c.customer_name || '', contract_type: c.contract_type || 'AMC', start_date: (c.start_date || '').slice(0, 10), end_date: (c.end_date || '').slice(0, 10), value: c.value || '', sla_response_hrs: c.sla_response_hrs || 4, sla_resolution_hrs: c.sla_resolution_hrs || 24, notes: c.notes || '' }); setShowForm(true); };

  const handleSave = async () => {
    if (!form.customer_name || !form.start_date || !form.end_date) {
      toast.error('Customer name, start date and end date are required'); return;
    }
    setSaving(true);
    try {
      const payload = { ...form, value: Number(form.value) || 0 };
      if (editId) {
        await api.put(`/servicedesk/contracts/${editId}`, payload);
        toast.success('Contract updated');
      } else {
        await api.post('/servicedesk/contracts', payload);
        toast.success('Contract created');
      }
      setShowForm(false); setForm(EMPTY); setEditId(null); load();
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!pendingDeleteContract) return;
    const { id, name } = pendingDeleteContract;
    setPendingDeleteContract(null);
    try {
      await api.delete(`/servicedesk/contracts/${id}`);
      toast.success('Contract deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed');
    }
  };

  const today    = new Date().toISOString().slice(0, 10);
  const enriched = contracts.map(c => ({
    ...c,
    status: c?.status || (c?.end_date ? (c.end_date < today ? 'Expired' : 'Active') : 'Active'),
  }));
  const filtered = enriched.filter(c =>
    !search || [c?.customer_name, c?.contract_type].some(v => (v ?? '').toLowerCase().includes(search.toLowerCase()))
  );
  const fmt = n => `₹${Number(n || 0).toLocaleString('en-IN')}`;

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!pendingDeleteContract}
        title="Delete Contract"
        message={pendingDeleteContract ? `Delete contract for "${pendingDeleteContract.name}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDeleteContract(null)}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Service Contracts</h1>
          <p style={{ color: '#6b7280', margin: '2px 0 0', fontSize: 12 }}>
            SLA &amp; support coverage agreements · separate from Operations → AMC Contracts (equipment lifecycle)
          </p>
          <p style={{ color: '#6b7280', margin: '2px 0 0', fontSize: 13 }}>
            {contracts.length} contracts · {enriched.filter(c => c.status === 'Active').length} active
          </p>
        </div>
        <button onClick={openCreate}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15} /> New Contract
        </button>
      </div>

      <div style={{ position: 'relative', marginBottom: 16, maxWidth: 340 }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer, type..."
          style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <FileText size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
            <p style={{ margin: '0 0 16px' }}>No contracts yet</p>
            <button onClick={openCreate} style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Add First Contract</button>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Customer', 'Type', 'Start Date', 'End Date', 'Value', 'SLA Response', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', fontSize: 12 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => {
                const sc = STATUS_COLOR[c.status] || STATUS_COLOR.Active;
                return (
                  <tr key={c.id || i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 500, color: '#1f2937' }}>{c?.customer_name ?? '—'}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ background: '#ede9fe', color: '#6B3FDB', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{c?.contract_type ?? 'AMC'}</span>
                    </td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>{(c?.start_date ?? '').slice(0, 10)}</td>
                    <td style={{ padding: '10px 14px', color: c.status === 'Expired' ? '#ef4444' : '#374151', fontWeight: c.status === 'Expired' ? 600 : 400 }}>
                      {(c?.end_date ?? '').slice(0, 10)}
                    </td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: '#1f2937' }}>{fmt(c?.value)}</td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>{c?.sla_response_hrs ?? 4}h</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{c.status}</span>
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => openEdit(c)} title="Edit contract"
                          style={{ padding: '4px 8px', background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, fontSize: 11 }}>
                          <Pencil size={11} /> Edit
                        </button>
                        <button onClick={() => setPendingDeleteContract({ id: c.id, name: c?.customer_name ?? 'this contract' })} title="Delete contract"
                          style={{ padding: '4px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, fontSize: 11 }}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                {editId ? 'Edit Service Contract' : 'New Service Contract'}
              </h2>
              <button onClick={() => { setShowForm(false); setEditId(null); setForm(EMPTY); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Customer Name *</label>
                <input value={form.customer_name} onChange={e => setForm(p => ({ ...p, customer_name: e.target.value }))} placeholder="Company name" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Contract Type</label>
                <select value={form.contract_type} onChange={e => setForm(p => ({ ...p, contract_type: e.target.value }))} style={inputStyle}>
                  {['AMC', 'Warranty', 'Support', 'Comprehensive', 'Other'].map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Contract Value (₹)</label>
                <input type="number" value={form.value} onChange={e => setForm(p => ({ ...p, value: e.target.value }))} placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Start Date *</label>
                <input type="date" value={form.start_date} onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>End Date *</label>
                <input type="date" value={form.end_date} onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>SLA Response (hrs)</label>
                <input type="number" value={form.sla_response_hrs} onChange={e => setForm(p => ({ ...p, sla_response_hrs: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>SLA Resolution (hrs)</label>
                <input type="number" value={form.sla_resolution_hrs} onChange={e => setForm(p => ({ ...p, sla_resolution_hrs: e.target.value }))} style={inputStyle} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2}
                  placeholder="Coverage details, exclusions..."
                  style={{ ...inputStyle, resize: 'none' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => { setShowForm(false); setEditId(null); setForm(EMPTY); }}
                style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.customer_name || !form.start_date || !form.end_date}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (saving || !form.customer_name || !form.start_date || !form.end_date) ? 0.6 : 1 }}>
                {saving ? 'Saving...' : editId ? 'Update Contract' : 'Save Contract'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
