import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { fmtL } from '@/utils/format';
import { Plus, X, Search, Wrench, Pencil, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const PRESET_CATEGORIES = ['Installation', 'Maintenance', 'Repair', 'Inspection', 'Calibration', 'Consulting', 'Other'];
const EMPTY = { name: '', category: 'Maintenance', description: '', price: '', is_active: true };

export default function ServiceMaster() {
  const [services,   setServices]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState('');
  const [catFilter,  setCatFilter]  = useState('All');
  const [showForm,   setShowForm]   = useState(false);
  const [editId,     setEditId]     = useState(null);
  const [form,       setForm]       = useState(EMPTY);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');
  const [toast,      setToast]      = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = () => {
    setLoading(true);
    api.get('/servicedesk/service-master')
      .then(r => setServices(Array.isArray(r.data) ? r.data : []))
      .catch(() => setServices([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const cats = ['All', ...Array.from(new Set(services?.map(s => s?.category).filter(Boolean)))];
  const allCategoryOptions = Array.from(new Set([...PRESET_CATEGORIES, ...cats.filter(c => c !== 'All')]));

  const filtered = (services ?? []).filter(s => {
    const matchCat    = catFilter === 'All' || s?.category === catFilter;
    const matchSearch = !search || [s?.name, s?.category, s?.description].some(v => (v || '').toLowerCase().includes(search.toLowerCase()));
    return matchCat && matchSearch;
  });

  const openAdd = () => {
    setEditId(null);
    setForm(EMPTY);
    setError('');
    setShowForm(true);
  };

  const openEdit = (s) => {
    setEditId(s.id);
    setForm({
      name:        s?.name        ?? '',
      category:    s?.category    ?? 'Maintenance',
      description: s?.description ?? '',
      price:       s?.price       ?? '',
      is_active:   s?.is_active   ?? true,
    });
    setError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name) { setError('Service name is required.'); return; }
    setSaving(true); setError('');
    try {
      const payload = { ...form, price: Number(form.price) || 0 };
      if (editId) {
        await api.put(`/servicedesk/service-master/${editId}`, payload);
        showToast('Service updated');
      } else {
        await api.post('/servicedesk/service-master', payload);
        showToast('Service added');
      }
      setShowForm(false);
      setForm(EMPTY);
      setEditId(null);
      load();
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to save.');
    } finally { setSaving(false); }
  };

  const handleDelete = (s) => setConfirmTarget(s);

  const confirmDelete = async () => {
    const s = confirmTarget;
    setConfirmTarget(null);
    try {
      await api.delete(`/servicedesk/service-master/${s.id}`);
      showToast('Service deactivated');
      load();
    } catch {
      showToast('Failed to deactivate', 'error');
    }
  };

  const field = (label, key, opts = {}) => (
    <div style={{ gridColumn: opts.full ? '1/-1' : 'auto' }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</label>
      {opts.textarea ? (
        <textarea value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} rows={2}
          placeholder={opts.placeholder}
          style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }}/>
      ) : (
        <input type={opts.type || 'text'} value={form[key]} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
          placeholder={opts.placeholder} list={opts.list}
          style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
      )}
    </div>
  );

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!confirmTarget}
        title="Deactivate Service"
        message={`Deactivate "${confirmTarget?.name ?? 'this service'}"? It will no longer appear in new tickets.`}
        confirmLabel="Deactivate"
        variant="warning"
        onConfirm={confirmDelete}
        onCancel={() => setConfirmTarget(null)}
      />

      {toast && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, padding: '10px 18px', borderRadius: 8, fontWeight: 600, fontSize: 13,
          background: toast.type === 'success' ? '#d1fae5' : '#fee2e2', color: toast.type === 'success' ? '#065f46' : '#991b1b' }}>
          {toast.msg}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Service Master</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>{filtered.length} services configured</p>
        </div>
        <button onClick={openAdd}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15}/> Add Service
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search service name, category..."
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}/>
        </div>
        {cats.map(c => (
          <button key={c} onClick={() => setCatFilter(c)}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              borderColor: catFilter === c ? '#6B3FDB' : '#e5e7eb', background: catFilter === c ? '#6B3FDB' : '#fff', color: catFilter === c ? '#fff' : '#374151' }}>
            {c}
          </button>
        ))}
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            <Wrench size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }}/>
            <p style={{ margin: '0 0 4px', fontWeight: 500 }}>No services found</p>
            <p style={{ margin: 0, fontSize: 12 }}>Add services to the master list</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Service Name', 'Category', 'Description', 'Price', 'Status', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={s.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '10px 16px', fontWeight: 600, color: '#1f2937' }}>{s?.name ?? 'Unnamed service'}</td>
                  <td style={{ padding: '10px 16px' }}>
                    <span style={{ background: '#ede9fe', color: '#6B3FDB', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                      {s?.category ?? 'Uncategorized'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 16px', color: '#6b7280', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s?.description ?? '—'}
                  </td>
                  <td style={{ padding: '10px 16px', fontWeight: 600, color: '#374151' }}>{fmtL(s?.price ?? 0)}</td>
                  <td style={{ padding: '10px 16px' }}>
                    {(s?.is_active ?? true) ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#d1fae5', color: '#065f46', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                        <ToggleRight size={12}/> Active
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#f3f4f6', color: '#6b7280', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                        <ToggleLeft size={12}/> Inactive
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px 16px' }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => openEdit(s)} title="Edit"
                        style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#6B3FDB' }}>
                        <Pencil size={13}/>
                      </button>
                      <button onClick={() => handleDelete(s)} title="Deactivate"
                        style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#dc2626' }}>
                        <Trash2 size={13}/>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>{editId ? 'Edit Service' : 'Add Service'}</h2>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20}/></button>
            </div>
            {error && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>{error}</div>}
            <datalist id="cat-list">
              {allCategoryOptions.map(c => <option key={c} value={c}/>)}
            </datalist>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {field('Service Name *', 'name',  { full: true, placeholder: 'e.g. Annual Maintenance' })}
              {field('Category', 'category', { placeholder: 'e.g. Calibration', list: 'cat-list' })}
              {field('Price (₹)', 'price', { type: 'number', placeholder: '0' })}
              {field('Description', 'description', { full: true, textarea: true, placeholder: 'What does this service include?' })}
              {editId && (
                <div style={{ gridColumn: '1/-1', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Status</label>
                  <button type="button" onClick={() => setForm(p => ({ ...p, is_active: !p.is_active }))}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                      background: form.is_active ? '#d1fae5' : '#f3f4f6', color: form.is_active ? '#065f46' : '#6b7280' }}>
                    {form.is_active ? <><ToggleRight size={14}/> Active</> : <><ToggleLeft size={14}/> Inactive</>}
                  </button>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 24 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>Cancel</button>
              <button onClick={handleSave} disabled={saving}
                style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving...' : editId ? 'Save Changes' : 'Add Service'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
