import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { Plus, X, Search, Truck, CheckCircle, XCircle } from 'lucide-react';

const STATUS_STYLE = {
  Pending:   { bg: '#fef3c7', color: '#92400e' },
  Delivered: { bg: '#d1fae5', color: '#065f46' },
  Cancelled: { bg: '#fee2e2', color: '#991b1b' },
};
const STATUSES = ['All', 'Pending', 'Delivered', 'Cancelled'];
const EMPTY = { customer_name: '', delivery_date: '', delivered_by: '', items_delivered: '', ticket_id: '', notes: '' };

export default function DeliveryNote() {
  const [notes,    setNotes]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState('');
  const [status,   setStatus]   = useState('All');
  const [showForm, setShowForm] = useState(false);
  const [form,     setForm]     = useState(EMPTY);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');
  const [toast,    setToast]    = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = () => {
    setLoading(true);
    api.get('/servicedesk/delivery-notes', { params: { status: status !== 'All' ? status : undefined, limit: 200 } })
      .then(r => setNotes(Array.isArray(r?.data) ? r.data : []))
      .catch(() => setNotes([]))
      .finally(() => setLoading(false));
  };

  const updateStatus = async (id, newStatus) => {
    try {
      const { data } = await api.put(`/servicedesk/delivery-notes/${id}`, { status: newStatus });
      setNotes(prev => prev.map(n => n.id === id ? data : n));
      showToast(`Marked as ${newStatus}`);
    } catch (e) {
      showToast(e?.response?.data?.error || 'Update failed', 'error');
    }
  };

  useEffect(() => { load(); }, [status]);

  const filtered = notes?.filter(n =>
    !search || [n?.dn_number, n?.customer_name, n?.delivered_by].some(v => (v ?? '').toLowerCase().includes(search.toLowerCase()))
  ) ?? [];

  const handleSave = async () => {
    if (!form.customer_name || !form.delivery_date) { setError('Customer name and delivery date are required.'); return; }
    setSaving(true); setError('');
    try {
      await api.post('/servicedesk/delivery-notes', { ...form, ticket_id: form.ticket_id ? Number(form.ticket_id) : null });
      setShowForm(false); setForm(EMPTY); load();
      showToast('Delivery note created');
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to save.');
    } finally { setSaving(false); }
  };

  const inp = (label, key, opts = {}) => (
    <div key={key} style={{ gridColumn: opts.full ? '1/-1' : 'auto' }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</label>
      {opts.textarea ? (
        <textarea value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} rows={3}
          placeholder={opts.placeholder}
          style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }}/>
      ) : (
        <input type={opts.type || 'text'} value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
          placeholder={opts.placeholder}
          style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
      )}
    </div>
  );

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, padding: '10px 18px', borderRadius: 8, fontWeight: 600, fontSize: 13,
          background: toast.type === 'success' ? '#d1fae5' : '#fee2e2',
          color:      toast.type === 'success' ? '#065f46' : '#991b1b' }}>
          {toast.msg}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Delivery Notes</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>{filtered.length} records</p>
        </div>
        <button onClick={() => { setShowForm(true); setError(''); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15}/> New Delivery Note
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search DN#, customer, delivered by..."
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
        </div>
        {STATUSES.map(s => (
          <button key={s} onClick={() => setStatus(s)}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              borderColor: status === s ? '#6B3FDB' : '#e5e7eb',
              background:  status === s ? '#6B3FDB' : '#fff',
              color:       status === s ? '#fff'    : '#374151' }}>
            {s}
          </button>
        ))}
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <Truck size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }}/>
            <p style={{ margin: '0 0 4px', fontWeight: 500 }}>No delivery notes found</p>
            <p style={{ margin: 0, fontSize: 12 }}>Create one to get started</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['DN #', 'Customer', 'Delivery Date', 'Delivered By', 'Items', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((n, i) => {
                const st = STATUS_STYLE[n?.status] ?? STATUS_STYLE.Pending;
                return (
                  <tr key={n.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: '#6B3FDB' }}>{n?.dn_number ?? `DN-${String(n.id).padStart(4, '0')}`}</td>
                    <td style={{ padding: '10px 16px', color: '#1f2937', fontWeight: 500 }}>{n?.customer_name ?? 'Unknown'}</td>
                    <td style={{ padding: '10px 16px', color: '#374151' }}>{n?.delivery_date ? String(n.delivery_date).slice(0, 10) : '—'}</td>
                    <td style={{ padding: '10px 16px', color: '#374151' }}>{n?.delivered_by ?? 'Unassigned'}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n?.items_delivered ?? '—'}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ background: st.bg, color: st.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{n?.status ?? 'Pending'}</span>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {n?.status === 'Pending' && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button title="Mark Delivered" onClick={() => updateStatus(n.id, 'Delivered')}
                            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#059669', padding: 2 }}>
                            <CheckCircle size={16}/>
                          </button>
                          <button title="Cancel" onClick={() => updateStatus(n.id, 'Cancelled')}
                            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#dc2626', padding: 2 }}>
                            <XCircle size={16}/>
                          </button>
                        </div>
                      )}
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
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>New Delivery Note</h2>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20}/></button>
            </div>
            {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {inp('Customer Name *', 'customer_name', { full: true, placeholder: 'Customer name' })}
              {inp('Delivery Date *', 'delivery_date', { type: 'date' })}
              {inp('Delivered By',    'delivered_by',  { placeholder: 'Technician / driver name' })}
              {inp('Ticket ID',       'ticket_id',     { type: 'number', placeholder: 'Linked ticket #' })}
              {inp('Items Delivered', 'items_delivered', { full: true, placeholder: 'List of items delivered' })}
              {inp('Notes',           'notes',           { full: true, textarea: true, placeholder: 'Any additional notes...' })}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 24 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>Cancel</button>
              <button onClick={handleSave} disabled={saving}
                style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving...' : 'Create Note'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
