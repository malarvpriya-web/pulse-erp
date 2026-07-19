import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { Plus, X, Search, MapPin, Pencil, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const STATUS_STYLE = {
  Active:   { bg: '#d1fae5', color: '#065f46' },
  Inactive: { bg: '#f3f4f6', color: '#6b7280' },
};
const SITE_TYPES = ['Office', 'Warehouse', 'Factory', 'Retail', 'Data Centre', 'Other'];
const STATUSES   = ['All', 'Active', 'Inactive'];
const EMPTY = { name: '', customer_id: null, customer_name: '', address: '', city: '', state: '', pincode: '', contact_name: '', contact_phone: '', site_type: 'Office', status: 'Active' };

export default function ReviewSites() {
  const [sites,     setSites]     = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [status,    setStatus]    = useState('All');
  const [showForm,  setShowForm]  = useState(false);
  const [editing,   setEditing]   = useState(null);
  const [form,      setForm]      = useState(EMPTY);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');
  const [toast,     setToast]     = useState(null);
  const [confirm,   setConfirm]   = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = () => {
    setLoading(true);
    api.get('/servicedesk/sites', { params: { status: status !== 'All' ? status : undefined, limit: 200 } })
      .then(r => setSites(Array.isArray(r.data) ? r.data : []))
      .catch(() => setSites([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [status]);

  useEffect(() => {
    api.get('/servicedesk/customers', { params: { limit: 500 } })
      .then(r => setCustomers(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
  }, []);

  const filtered = sites?.filter(s =>
    !search || [s?.name, s?.customer_name, s?.city, s?.address].some(v => (v ?? '').toLowerCase().includes(search.toLowerCase()))
  ) ?? [];

  const openAdd = () => { setEditing(null); setForm(EMPTY); setError(''); setShowForm(true); };
  const openEdit = (s) => {
    setEditing(s);
    setForm({
      name: s?.name ?? '', customer_id: s?.customer_id ?? null, customer_name: s?.customer_name ?? '',
      address: s?.address ?? '', city: s?.city ?? '', state: s?.state ?? '', pincode: s?.pincode ?? '',
      contact_name: s?.contact_name ?? '', contact_phone: s?.contact_phone ?? '',
      site_type: s?.site_type ?? 'Office', status: s?.status ?? 'Active',
    });
    setError(''); setShowForm(true);
  };

  const handleCustomerChange = (e) => {
    const id = e.target.value;
    if (!id) { setForm(p => ({ ...p, customer_id: null, customer_name: '' })); return; }
    const c = customers.find(c => String(c.id) === String(id));
    setForm(p => ({ ...p, customer_id: Number(id), customer_name: c?.name ?? '' }));
  };

  const handleSave = async () => {
    if (!form.name || !form.address) { setError('Site name and address are required.'); return; }
    setSaving(true); setError('');
    try {
      if (editing) {
        await api.put(`/servicedesk/sites/${editing.id}`, form);
        showToast('Site updated');
      } else {
        await api.post('/servicedesk/sites', form);
        showToast('Site added');
      }
      setShowForm(false); setForm(EMPTY); setEditing(null); load();
    } catch (e) {
      setError(e?.response?.data?.error ?? 'Failed to save.');
    } finally { setSaving(false); }
  };

  const handleDelete = (s) => {
    setConfirm({
      title: 'Delete Site',
      message: `Delete "${s?.name ?? 'this site'}"? This cannot be undone.`,
      onConfirm: async () => {
        setConfirm(null);
        try {
          await api.delete(`/servicedesk/sites/${s.id}`);
          showToast('Site deleted');
          load();
        } catch (e) {
          showToast(e?.response?.data?.error ?? 'Delete failed', 'error');
        }
      },
    });
  };

  const inp = (label, key, opts = {}) => (
    <div style={{ gridColumn: opts.full ? '1/-1' : 'auto' }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</label>
      <input type={opts.type || 'text'} value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
        placeholder={opts.placeholder}
        style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
    </div>
  );

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, padding: '10px 18px', borderRadius: 8, fontWeight: 600, fontSize: 13,
          background: toast.type === 'success' ? '#d1fae5' : '#fee2e2', color: toast.type === 'success' ? '#065f46' : '#991b1b' }}>
          {toast.msg}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        variant="danger"
        onConfirm={confirm?.onConfirm}
        onCancel={() => setConfirm(null)}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Service Sites</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>{filtered.length} sites</p>
        </div>
        <button onClick={openAdd}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15}/> Add Site
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, customer, city..."
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
        </div>
        {STATUSES.map(s => (
          <button key={s} onClick={() => setStatus(s)}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              borderColor: status === s ? '#6B3FDB' : '#e5e7eb', background: status === s ? '#6B3FDB' : '#fff', color: status === s ? '#fff' : '#374151' }}>
            {s}
          </button>
        ))}
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <MapPin size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }}/>
            <p style={{ margin: '0 0 4px', fontWeight: 500 }}>No sites found</p>
            <p style={{ margin: 0, fontSize: 12 }}>Add your first service site</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Site Name', 'Customer', 'City', 'Type', 'Contact', 'Status', ''].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => {
                const st = STATUS_STYLE[s?.status] ?? STATUS_STYLE.Active;
                return (
                  <tr key={s?.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: '#1f2937' }}>{s?.name ?? 'Unnamed site'}</td>
                    <td style={{ padding: '10px 16px', color: '#374151' }}>{s?.customer_name ?? '—'}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>{[s?.city, s?.state].filter(Boolean).join(', ') || '—'}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ background: '#ede9fe', color: '#6B3FDB', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{s?.site_type ?? 'Office'}</span>
                    </td>
                    <td style={{ padding: '10px 16px', color: '#374151' }}>
                      {s?.contact_name ? `${s.contact_name}${s?.contact_phone ? ` · ${s.contact_phone}` : ''}` : '—'}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ background: st.bg, color: st.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{s?.status ?? 'inactive'}</span>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => openEdit(s)} title="Edit"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}>
                          <Pencil size={14}/>
                        </button>
                        <button onClick={() => handleDelete(s)} title="Delete"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}>
                          <Trash2 size={14}/>
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
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 580, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>{editing ? 'Edit Site' : 'Add Site'}</h2>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20}/></button>
            </div>
            {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {inp('Site Name *', 'name', { full: true, placeholder: 'e.g. Chennai Plant' })}
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Customer</label>
                <select value={form.customer_id ?? ''} onChange={handleCustomerChange}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
                  <option value=''>— Select customer —</option>
                  {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              {inp('Address *',     'address',       { full: true, placeholder: 'Street address' })}
              {inp('City',          'city',          { placeholder: 'City' })}
              {inp('State',         'state',         { placeholder: 'State' })}
              {inp('Pincode',       'pincode',       { placeholder: '600001' })}
              {inp('Contact Name',  'contact_name',  { placeholder: 'Site contact person' })}
              {inp('Contact Phone', 'contact_phone', { placeholder: '+91 ...' })}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Site Type</label>
                <select value={form.site_type} onChange={e => setForm(p => ({ ...p, site_type: e.target.value }))}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
                  {SITE_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              {editing && (
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Status</label>
                  <select value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
                    <option>Active</option>
                    <option>Inactive</option>
                  </select>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 24 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>Cancel</button>
              <button onClick={handleSave} disabled={saving}
                style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving...' : editing ? 'Update Site' : 'Add Site'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
